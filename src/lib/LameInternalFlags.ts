import { new_float_n, new_int_n } from './common.js';
import IIISideInfo from './IIISideInfo.js';
import ScaleFac from './ScaleFac.js';
import NsPsy from './NsPsy.js';
import III_psy_xmin from './III_psy_xmin.js';
import Encoder from './Encoder.js';
import ATH from './ATH.js';

/** Psycho-model tuning values (was a private class inside Lame.ts). */
export interface PSY {
    mask_adjust: number;
    mask_adjust_short: number;
    bo_l_weight: Float32Array;
    bo_s_weight: Float32Array;
}

const MAX_HEADER_LEN = 40;

/**
 * max size of header is 38
 */
export class Header {
    write_timing: number = 0;
    ptr: number = 0;
    buf: Int8Array = new Int8Array(MAX_HEADER_LEN);
}

export default class LameInternalFlags {
    static MFSIZE = (3 * 1152 + Encoder.ENCDELAY - Encoder.MDCTDELAY);
    static MAX_HEADER_BUF = 256;
    static MAX_BITS_PER_CHANNEL = 4095;
    static MAX_BITS_PER_GRANULE = 7680;
    static BPC = 320;

    lame_encode_frame_init: number = 0;
    iteration_init_init: number = 0;
    fill_buffer_resample_init: number = 0;

    mfbuf: Float32Array[] = new_float_n([2, LameInternalFlags.MFSIZE]);

    /**
     * granules per frame
     */
    mode_gr: number = 0;
    /**
     * number of channels in the input data stream (PCM or decoded PCM)
     */
    channels_in: number = 0;
    /**
     * number of channels in the output data stream (not used for decoding)
     */
    channels_out: number = 0;
    /**
     * input_samp_rate/output_samp_rate
     */
    resample_ratio: number = 0.;

    mf_samples_to_encode: number = 0;
    mf_size: number = 0;
    bitrate_index: number = 0;
    samplerate_index: number = 0;

    /* lowpass and highpass filter control */
    /**
     * normalized frequency bounds of passband
     */
    lowpass1: number = 0.;
    lowpass2: number = 0.;

    /**
     * 0 = none 1 = ISO AAC model 2 = allow scalefac_select=1
     */
    noise_shaping: number = 0;

    l3_side: IIISideInfo = new IIISideInfo();

    /* used for padding */
    /**
     * padding for the current frame?
     */
    padding: number = 0;
    frac_SpF: number = 0;
    slot_lag: number = 0;

    /* variables used by Quantize */
    OldValue: Int32Array = new Int32Array(2);
    CurrentStep: Int32Array = new Int32Array(2);

    masking_lower: number = 0.;
    bv_scf: Int32Array = new Int32Array(576);

    /* BPC = maximum number of filter convolution windows to precompute */
    inbuf_old: Float32Array[] = new Array(2);
    blackfilt: Float32Array[] = new Array(2 * LameInternalFlags.BPC + 1);
    itime: Float64Array = new Float64Array(2);
    sideinfo_len: number = 0;

    /* variables for newmdct.c */
    sb_sample: Float32Array[][][] = new_float_n([2, 2, 18, Encoder.SBLIMIT]);
    amp_filter: Float32Array = new Float32Array(32);

    /* variables for BitStream */

    /**
     * <PRE>
     * mpeg1: buffer=511 bytes  smallest frame: 96-38(sideinfo)=58
     * max number of frames in reservoir:  8
     * mpeg2: buffer=255 bytes.  smallest frame: 24-23bytes=1
     * with VBR, if you are encoding all silence, it is possible to
     * have 8kbs/24khz frames with 1byte of data each, which means we need
     * to buffer up to 255 headers!
     * </PRE>
     */
    /**
     * also, max_header_buf has to be a power of two
     */
    /**
     * max size of header is 38
     */

    header: Header[] = new Array(LameInternalFlags.MAX_HEADER_BUF);

    h_ptr: number = 0;
    w_ptr: number = 0;

    /* variables for Reservoir */
    /**
     * in bits
     */
    ResvSize: number = 0;
    /**
     * in bits
     */
    ResvMax: number = 0;

    scalefac_band: ScaleFac = new ScaleFac();

    nb_s1: Float32Array[] = new_float_n([4, Encoder.CBANDS]);
    nb_s2: Float32Array[] = new_float_n([4, Encoder.CBANDS]);
    s3_ss: Float32Array | null = null;
    s3_ll: Float32Array | null = null;
    decay: number = 0.;

    thm: III_psy_xmin[] = new Array(4);
    en: III_psy_xmin[] = new Array(4);

    /**
     * fft and energy calculation
     */
    tot_ener: Float32Array = new Float32Array(4);

    /* loudness calculation (for adaptive threshold of hearing) */
    /**
     * loudness^2 approx. per granule and channel
     */
    loudness_sq: Float32Array[] = new_float_n([2, 2]);
    /**
     * account for granule delay of L3psycho_anal
     */
    loudness_sq_save: Float32Array = new Float32Array(2);

    bo_l: Int32Array = new Int32Array(Encoder.SBMAX_l);
    bo_s: Int32Array = new Int32Array(Encoder.SBMAX_s);
    npart_l: number = 0;
    npart_s: number = 0;

    s3ind: Int32Array[] = new_int_n([Encoder.CBANDS, 2]);
    s3ind_s: Int32Array[] = new_int_n([Encoder.CBANDS, 2]);

    numlines_s: Int32Array = new Int32Array(Encoder.CBANDS);
    numlines_l: Int32Array = new Int32Array(Encoder.CBANDS);
    rnumlines_l: Float32Array = new Float32Array(Encoder.CBANDS);

    /**
     * block type
     */
    blocktype_old: Int32Array = new Int32Array(2);

    /**
     * variables used for --nspsytune
     */
    nsPsy: NsPsy = new NsPsy();

    /**
     * used for Xing VBR header
     */

    /**
     * all ATH related stuff
     */
    ATH: ATH | null = null;

    PSY: PSY | null = null;

    in_buffer_nsamples: number = 0;
    in_buffer_0: Float32Array | null = null;
    in_buffer_1: Float32Array | null = null;

    constructor() {
    for (let i = 0; i < this.en.length; i++) {
        this.en[i] = new III_psy_xmin();
    }
    for (let i = 0; i < this.thm.length; i++) {
        this.thm[i] = new III_psy_xmin();
    }
    for (let i = 0; i < this.header.length; i++) {
        this.header[i] = new Header();
    }

    }
}
