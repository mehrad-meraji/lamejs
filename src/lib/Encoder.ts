import { new_float_n } from './common.js';
import NewMDCT from './NewMDCT.js';
import III_psy_ratio from './III_psy_ratio.js';
import type BitStream from './BitStream.js';
import type PsyModel from './PsyModel.js';
import type CBRNewIterationLoop from './CBRNewIterationLoop.js';
import type LameGlobalFlags from './LameGlobalFlags.js';
import type LameInternalFlags from './LameInternalFlags.js';

export default class Encoder {
    /**
     * ENCDELAY The encoder delay.
     *
     * Minimum allowed is MDCTDELAY (see below)
     *
     * The first 96 samples will be attenuated, so using a value less than 96
     * will result in corrupt data for the first 96-ENCDELAY samples.
     *
     * suggested: 576 set to 1160 to sync with FhG.
     */
    static ENCDELAY = 576;
    /**
     * make sure there is at least one complete frame after the last frame
     * containing real data
     *
     * Using a value of 288 would be sufficient for a a very sophisticated
     * decoder that can decode granule-by-granule instead of frame by frame. But
     * lets not assume this, and assume the decoder will not decode frame N
     * unless it also has data for frame N+1
     */
    static POSTDELAY = 1152;

    /**
     * delay of the MDCT used in mdct.c original ISO routines had a delay of
     * 528! Takehiro's routines:
     */
    static MDCTDELAY = 48;
    static FFTOFFSET = (224 + Encoder.MDCTDELAY);

    /**
     * number of subbands
     */
    static SBLIMIT = 32;

    /**
     * parition bands bands
     */
    static CBANDS = 64;

    /**
     * number of critical bands/scale factor bands where masking is computed
     */
    static SBPSY_l = 21;
    static SBPSY_s = 12;

    /**
     * total number of scalefactor bands encoded
     */
    static SBMAX_l = 22;
    static SBMAX_s = 13;
    static PSFB21 = 6;
    static PSFB12 = 6;

    /**
     * FFT sizes
     */
    static BLKSIZE = 1024;
    static HBLKSIZE = (Encoder.BLKSIZE / 2 + 1);
    static BLKSIZE_s = 256;
    static HBLKSIZE_s = (Encoder.BLKSIZE_s / 2 + 1);

    static NORM_TYPE = 0;
    static START_TYPE = 1;
    static SHORT_TYPE = 2;
    static STOP_TYPE = 3;

    static fircoef = [-0.0207887 * 5, -0.0378413 * 5,
        -0.0432472 * 5, -0.031183 * 5, 7.79609e-18 * 5, 0.0467745 * 5,
        0.10091 * 5, 0.151365 * 5, 0.187098 * 5];

    constructor(private readonly bs: BitStream, private readonly psy: PsyModel, private readonly loop: CBRNewIterationLoop) {}

    private newMDCT = new NewMDCT();

    /***********************************************************************
     *
     * encoder and decoder delays
     *
     ***********************************************************************/

    /**
     * <PRE>
     * layer III enc->dec delay:  1056 (1057?)   (observed)
     * layer  II enc->dec delay:   480  (481?)   (observed)
     *
     * polyphase 256-16             (dec or enc)        = 240
     * mdct      256+32  (9*32)     (dec or enc)        = 288
     * total:    512+16
     *
     * My guess is that delay of polyphase filterbank is actualy 240.5
     * (there are technical reasons for this, see postings in mp3encoder).
     * So total Encode+Decode delay = ENCDELAY + 528 + 1
     * </PRE>
     */

    /**
     * auto-adjust of ATH, useful for low volume Gabriel Bouvigne 3 feb 2001
     *
     * modifies some values in gfp.internal_flags.ATH (gfc.ATH)
     */
    private adjust_ATH(gfc: LameInternalFlags): void {
        let gr2_max: number, max_pow: number;
        const ATH = gfc.ATH!;

        /* jd - 2001 mar 12, 27, jun 30 */
        /* loudness based on equal loudness curve; */
        /* use granule with maximum combined loudness */
        max_pow = gfc.loudness_sq[0][0];
        gr2_max = gfc.loudness_sq[1][0];
        if (gfc.channels_out == 2) {
            max_pow += gfc.loudness_sq[0][1];
            gr2_max += gfc.loudness_sq[1][1];
        } else {
            max_pow += max_pow;
            gr2_max += gr2_max;
        }
        if (gfc.mode_gr == 2) {
            max_pow = Math.max(max_pow, gr2_max);
        }
        max_pow *= 0.5;
        /* max_pow approaches 1.0 for full band noise */

        /* jd - 2001 mar 31, jun 30 */
        /* user tuning of ATH adjustment region */
        max_pow *= ATH.aaSensitivityP;

        /*
         * adjust ATH depending on range of maximum value
         */

        /* jd - 2001 feb27, mar12,20, jun30, jul22 */
        /* continuous curves based on approximation */
        /* to GB's original values. */
        /* For an increase in approximate loudness, */
        /* set ATH adjust to adjust_limit immediately */
        /* after a delay of one frame. */
        /* For a loudness decrease, reduce ATH adjust */
        /* towards adjust_limit gradually. */
        /* max_pow is a loudness squared or a power. */
        if (max_pow > 0.03125) { /* ((1 - 0.000625)/ 31.98) from curve below */
            if (ATH.adjust >= 1.0) {
                ATH.adjust = 1.0;
            } else {
                /* preceding frame has lower ATH adjust; */
                /* ascend only to the preceding adjust_limit */
                /* in case there is leading low volume */
                if (ATH.adjust < ATH.adjustLimit) {
                    ATH.adjust = ATH.adjustLimit;
                }
            }
            ATH.adjustLimit = 1.0;
        } else { /* adjustment curve */
            /* about 32 dB maximum adjust (0.000625) */
            const adj_lim_new = 31.98 * max_pow + 0.000625;
            if (ATH.adjust >= adj_lim_new) { /* descend gradually */
                ATH.adjust *= adj_lim_new * 0.075 + 0.925;
                if (ATH.adjust < adj_lim_new) { /* stop descent */
                    ATH.adjust = adj_lim_new;
                }
            } else { /* ascend */
                if (ATH.adjustLimit >= adj_lim_new) {
                    ATH.adjust = adj_lim_new;
                } else {
                    /* preceding frame has lower ATH adjust; */
                    /* ascend only to the preceding adjust_limit */
                    if (ATH.adjust < ATH.adjustLimit) {
                        ATH.adjust = ATH.adjustLimit;
                    }
                }
            }
            ATH.adjustLimit = adj_lim_new;
        }
    }

    /**
     * <PRE>
     *  some simple statistics
     *
     *  bitrate index 0: free bitrate . not allowed in VBR mode
     *  : bitrates, kbps depending on MPEG version
     *  bitrate index 15: forbidden
     *
     *  mode_ext:
     *  0:  LR
     *  1:  LR-i
     *  2:  MS
     *  3:  MS-i
     * </PRE>
     */

    private lame_encode_frame_init(gfp: LameGlobalFlags, inbuf: ArrayLike<number>[]): void {
        const gfc = gfp.internal_flags!;

        let ch: number, gr: number;

        if (gfc.lame_encode_frame_init == 0) {
            /* prime the MDCT/polyphase filterbank with a short block */
            let i: number, j: number;
            const primebuff0 = new Float32Array(286 + 1152 + 576);
            const primebuff1 = new Float32Array(286 + 1152 + 576);
            gfc.lame_encode_frame_init = 1;
            for (i = 0, j = 0; i < 286 + 576 * (1 + gfc.mode_gr); ++i) {
                if (i < 576 * gfc.mode_gr) {
                    primebuff0[i] = 0;
                    if (gfc.channels_out == 2)
                        primebuff1[i] = 0;
                } else {
                    primebuff0[i] = inbuf[0][j];
                    if (gfc.channels_out == 2)
                        primebuff1[i] = inbuf[1][j];
                    ++j;
                }
            }
            /* polyphase filtering / mdct */
            for (gr = 0; gr < gfc.mode_gr; gr++) {
                for (ch = 0; ch < gfc.channels_out; ch++) {
                    gfc.l3_side.tt[gr][ch].block_type = Encoder.SHORT_TYPE;
                }
            }
            this.newMDCT.mdct_sub48(gfc, primebuff0, primebuff1);

            /* check FFT will not use a negative starting offset */
            /* check if we have enough data for FFT */
            /* check if we have enough data for polyphase filterbank */
        }

    }

    /**
     * <PRE>
     * encodeframe()           Layer 3
     *
     * encode a single frame
     *
     *
     *    lame_encode_frame()
     *
     *
     *                           gr 0            gr 1
     *    inbuf:           |--------------|--------------|--------------|
     *
     *
     *    Polyphase (18 windows, each shifted 32)
     *    gr 0:
     *    window1          <----512---.
     *    window18                 <----512---.
     *
     *    gr 1:
     *    window1                         <----512---.
     *    window18                                <----512---.
     *
     *
     *
     *    MDCT output:  |--------------|--------------|--------------|
     *
     *    FFT's                    <---------1024---------.
     *                                             <---------1024-------.
     *
     *
     *
     *        inbuf = buffer of PCM data size=MP3 framesize
     *        encoder acts on inbuf[ch][0], but output is delayed by MDCTDELAY
     *        so the MDCT coefficints are from inbuf[ch][-MDCTDELAY]
     *
     *        psy-model FFT has a 1 granule delay, so we feed it data for the
     *        next granule.
     *        FFT is centered over granule:  224+576+224
     *        So FFT starts at:   576-224-MDCTDELAY
     *
     *        MPEG2:  FFT ends at:  BLKSIZE+576-224-MDCTDELAY      (1328)
     *        MPEG1:  FFT ends at:  BLKSIZE+2*576-224-MDCTDELAY    (1904)
     *
     *        MPEG2:  polyphase first window:  [0..511]
     *                          18th window:   [544..1055]          (1056)
     *        MPEG1:            36th window:   [1120..1631]         (1632)
     *                data needed:  512+framesize-32
     *
     *        A close look newmdct.c shows that the polyphase filterbank
     *        only uses data from [0..510] for each window.  Perhaps because the window
     *        used by the filterbank is zero for the last point, so Takehiro's
     *        code doesn't bother to compute with it.
     *
     *        FFT starts at 576-224-MDCTDELAY (304)  = 576-FFTOFFSET
     *
     * </PRE>
     */

    /* per-frame work buffers; psy writes every slot the encoder reads */
    private readonly masking: III_psy_ratio[][] = [[new III_psy_ratio(), new III_psy_ratio()], [new III_psy_ratio(), new III_psy_ratio()]];
    private readonly tot_ener = new_float_n([2, 4]);
    private readonly pe = [[0., 0.], [0., 0.]];
    private readonly blocktype = new Int32Array(2);

    lame_encode_mp3_frame(gfp: LameGlobalFlags, inbuf_l: Float32Array, inbuf_r: Float32Array, mp3buf: Int8Array, mp3bufPos: number, mp3buf_size: number): number {
        const gfc = gfp.internal_flags!;
        const inbuf = [inbuf_l, inbuf_r];
        const { masking, tot_ener, pe, blocktype } = this;

        if (gfc.lame_encode_frame_init == 0) {
            /* first run? */
            this.lame_encode_frame_init(gfp, inbuf);
        }

        /********************** padding *****************************/
        /**
         * padding method as described in "MPEG-Layer3 / Bitstream Syntax and
         * Decoding" by Martin Sieler, Ralph Sperschneider
         *
         * note: there is no padding for the very first frame
         *
         * Robert Hegemann 2000-06-22
         */
        gfc.padding = 0;
        if ((gfc.slot_lag -= gfc.frac_SpF) < 0) {
            gfc.slot_lag += gfp.out_samplerate;
            gfc.padding = 1;
        }

        /****************************************
         * Stage 1: psychoacoustic model *
         ****************************************/
        /*
         * psy model has a 1 granule (576) delay that we must compensate for
         * (mt 6/99).
         */
        for (let gr = 0; gr < gfc.mode_gr; gr++) {
            this.psy.L3psycho_anal_ns(gfp, inbuf, 576 + gr * 576 - Encoder.FFTOFFSET, gr, masking, pe[gr], tot_ener[gr], blocktype);

            /* block type flags */
            for (let ch = 0; ch < gfc.channels_out; ch++) {
                const cod_info = gfc.l3_side.tt[gr][ch];
                cod_info.block_type = blocktype[ch];
            }
        }

        /* auto-adjust of ATH, useful for low volume */
        this.adjust_ATH(gfc);

        /****************************************
         * Stage 2: MDCT *
         ****************************************/
        /* polyphase filtering / mdct */
        this.newMDCT.mdct_sub48(gfc, inbuf[0], inbuf[1]);

        /****************************************
         * Stage 4: quantization loop *
         ****************************************/
        const pefirbuf = gfc.nsPsy.pefirbuf;
        pefirbuf.copyWithin(0, 1, 19);

        let f = 0.0;
        for (let gr = 0; gr < gfc.mode_gr; gr++)
            for (let ch = 0; ch < gfc.channels_out; ch++)
                f += pe[gr][ch];
        pefirbuf[18] = f;

        f = pefirbuf[9];
        for (let i = 0; i < 9; i++)
            f += (pefirbuf[i] + pefirbuf[18 - i]) * Encoder.fircoef[i];

        f = (670 * 5 * gfc.mode_gr * gfc.channels_out) / f;
        for (let gr = 0; gr < gfc.mode_gr; gr++)
            for (let ch = 0; ch < gfc.channels_out; ch++)
                pe[gr][ch] *= f;

        this.loop.iteration_loop(gfp, pe, masking);

        /****************************************
         * Stage 5: bitstream formatting *
         ****************************************/
        this.bs.format_bitstream(gfp);
        return this.bs.copy_buffer(mp3buf, mp3bufPos, mp3buf_size);
    }
}
