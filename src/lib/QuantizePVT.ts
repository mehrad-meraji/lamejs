
import ScaleFac from './ScaleFac.js';
import Encoder from './Encoder.js';
import MeanBits from './MeanBits.js';
import LameInternalFlags from './LameInternalFlags.js';
import BitStream from './BitStream.js';
import CalcNoiseData from './CalcNoiseData.js';
import CalcNoiseResult from './CalcNoiseResult.js';
import GrInfo from './GrInfo.js';
import LameGlobalFlags from './LameGlobalFlags.js';
import III_psy_ratio from './III_psy_ratio.js';
import Takehiro from './Takehiro.js';
import Reservoir from './Reservoir.js';
import PsyModel from './PsyModel.js';

/*
 *      quantize_pvt source file
 *
 *      Copyright (c) 1999-2002 Takehiro Tominaga
 *      Copyright (c) 2000-2002 Robert Hegemann
 *      Copyright (c) 2001 Naoki Shibata
 *      Copyright (c) 2002-2005 Gabriel Bouvigne
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Library General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the
 * Free Software Foundation, Inc., 59 Temple Place - Suite 330,
 * Boston, MA 02111-1307, USA.
 */

/* $Id: QuantizePVT.java,v 1.24 2011/05/24 20:48:06 kenchis Exp $ */

const Q_MAX = (256 + 1);

/**
 * minimum possible number of
 * -cod_info.global_gain + ((scalefac[] + (cod_info.preflag ? pretab[sfb] : 0))
 * << (cod_info.scalefac_scale + 1)) + cod_info.subblock_gain[cod_info.window[sfb]] * 8;
 *
 * for long block, 0+((15+3)<<2) = 18*4 = 72
 * for short block, 0+(15<<2)+7*8 = 15*4+56 = 116
 */
const Q_MAX2 = 116;
const LARGE_BITS = 100000;

/**
 * ix always <= 8191+15. see count_bits()
 */
const IXMAX_VAL = 8206;

const PRECALC_SIZE = (IXMAX_VAL + 2);

/**
 * Assuming dynamic range=96dB, this value should be 92
 */
const NSATHSCALE = 100;

export default class QuantizePVT {
    static Q_MAX = Q_MAX;
    static Q_MAX2 = Q_MAX2;
    static LARGE_BITS = LARGE_BITS;
    static IXMAX_VAL = IXMAX_VAL;

    private readonly ix01 = new Float32Array(2);

    constructor(private readonly tak: Takehiro, private readonly rv: Reservoir, private readonly psy: PsyModel) {}

    private POW20(x: number): number {
        return this.pow20[x + QuantizePVT.Q_MAX2];
    }

    IPOW20(x: number): number {
        return this.ipow20[x];
    }

    /**
     * <CODE>
     * minimum possible number of
     * -cod_info.global_gain + ((scalefac[] + (cod_info.preflag ? pretab[sfb] : 0))
     * << (cod_info.scalefac_scale + 1)) + cod_info.subblock_gain[cod_info.window[sfb]] * 8;
     *
     * for long block, 0+((15+3)<<2) = 18*4 = 72
     * for short block, 0+(15<<2)+7*8 = 15*4+56 = 116
     * </CODE>
     */
    /**
     * The following table is used to implement the scalefactor partitioning for
     * MPEG2 as described in section 2.4.3.2 of the IS. The indexing corresponds
     * to the way the tables are presented in the IS:
     *
     * [table_number][row_in_table][column of nr_of_sfb]
     */
    nr_of_sfb_block: number[][][] = [
        [[6, 5, 5, 5], [9, 9, 9, 9], [6, 9, 9, 9]],
        [[6, 5, 7, 3], [9, 9, 12, 6], [6, 9, 12, 6]],
        [[11, 10, 0, 0], [18, 18, 0, 0], [15, 18, 0, 0]],
        [[7, 7, 7, 0], [12, 12, 12, 0], [6, 15, 12, 0]],
        [[6, 6, 6, 3], [12, 9, 9, 6], [6, 12, 9, 6]],
        [[8, 8, 5, 0], [15, 12, 9, 0], [6, 18, 9, 0]]];

    /**
     * Table B.6: layer3 preemphasis
     */
    pretab: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
        2, 2, 3, 3, 3, 2, 0];

    /**
     * Here are MPEG1 Table B.8 and MPEG2 Table B.1 -- Layer III scalefactor
     * bands. <BR>
     * Index into this using a method such as:<BR>
     * idx = fr_ps.header.sampling_frequency + (fr_ps.header.version * 3)
     */
    sfBandIndex: ScaleFac[] = [
        // Table B.2.b: 22.05 kHz
        new ScaleFac([0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 116, 140, 168, 200, 238, 284, 336, 396, 464,
                522, 576],
            [0, 4, 8, 12, 18, 24, 32, 42, 56, 74, 100, 132, 174, 192]
            , [0, 0, 0, 0, 0, 0, 0] //  sfb21 pseudo sub bands
            , [0, 0, 0, 0, 0, 0, 0] //  sfb12 pseudo sub bands
        ),
        /* Table B.2.c: 24 kHz */ /* docs: 332. mpg123(broken): 330 */
        new ScaleFac([0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 114, 136, 162, 194, 232, 278, 332, 394, 464,
                540, 576],
            [0, 4, 8, 12, 18, 26, 36, 48, 62, 80, 104, 136, 180, 192]
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb21 pseudo sub bands */
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb12 pseudo sub bands */
        ),
        /* Table B.2.a: 16 kHz */
        new ScaleFac([0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 116, 140, 168, 200, 238, 284, 336, 396, 464,
                522, 576],
            [0, 4, 8, 12, 18, 26, 36, 48, 62, 80, 104, 134, 174, 192]
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb21 pseudo sub bands */
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb12 pseudo sub bands */
        ),
        /* Table B.8.b: 44.1 kHz */
        new ScaleFac([0, 4, 8, 12, 16, 20, 24, 30, 36, 44, 52, 62, 74, 90, 110, 134, 162, 196, 238, 288, 342, 418,
                576],
            [0, 4, 8, 12, 16, 22, 30, 40, 52, 66, 84, 106, 136, 192]
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb21 pseudo sub bands */
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb12 pseudo sub bands */
        ),
        /* Table B.8.c: 48 kHz */
        new ScaleFac([0, 4, 8, 12, 16, 20, 24, 30, 36, 42, 50, 60, 72, 88, 106, 128, 156, 190, 230, 276, 330, 384,
                576],
            [0, 4, 8, 12, 16, 22, 28, 38, 50, 64, 80, 100, 126, 192]
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb21 pseudo sub bands */
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb12 pseudo sub bands */
        ),
        /* Table B.8.a: 32 kHz */
        new ScaleFac([0, 4, 8, 12, 16, 20, 24, 30, 36, 44, 54, 66, 82, 102, 126, 156, 194, 240, 296, 364, 448, 550,
                576],
            [0, 4, 8, 12, 16, 22, 30, 42, 58, 78, 104, 138, 180, 192]
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb21 pseudo sub bands */
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb12 pseudo sub bands */
        ),
        /* MPEG-2.5 11.025 kHz */
        new ScaleFac([0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 116, 140, 168, 200, 238, 284, 336, 396, 464,
                522, 576],
            [0 / 3, 12 / 3, 24 / 3, 36 / 3, 54 / 3, 78 / 3, 108 / 3, 144 / 3, 186 / 3, 240 / 3, 312 / 3,
                402 / 3, 522 / 3, 576 / 3]
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb21 pseudo sub bands */
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb12 pseudo sub bands */
        ),
        /* MPEG-2.5 12 kHz */
        new ScaleFac([0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 116, 140, 168, 200, 238, 284, 336, 396, 464,
                522, 576],
            [0 / 3, 12 / 3, 24 / 3, 36 / 3, 54 / 3, 78 / 3, 108 / 3, 144 / 3, 186 / 3, 240 / 3, 312 / 3,
                402 / 3, 522 / 3, 576 / 3]
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb21 pseudo sub bands */
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb12 pseudo sub bands */
        ),
        /* MPEG-2.5 8 kHz */
        new ScaleFac([0, 12, 24, 36, 48, 60, 72, 88, 108, 132, 160, 192, 232, 280, 336, 400, 476, 566, 568, 570,
                572, 574, 576],
            [0 / 3, 24 / 3, 48 / 3, 72 / 3, 108 / 3, 156 / 3, 216 / 3, 288 / 3, 372 / 3, 480 / 3, 486 / 3,
                492 / 3, 498 / 3, 576 / 3]
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb21 pseudo sub bands */
            , [0, 0, 0, 0, 0, 0, 0] /*  sfb12 pseudo sub bands */
        )
    ];

    private pow20: Float32Array = new Float32Array(Q_MAX + Q_MAX2 + 1);
    private ipow20: Float32Array = new Float32Array(Q_MAX);
    private pow43: Float32Array = new Float32Array(PRECALC_SIZE);

    adj43: Float32Array = new Float32Array(PRECALC_SIZE);

    /**
     * <PRE>
     * compute the ATH for each scalefactor band cd range: 0..96db
     *
     * Input: 3.3kHz signal 32767 amplitude (3.3kHz is where ATH is smallest =
     * -5db) longblocks: sfb=12 en0/bw=-11db max_en0 = 1.3db shortblocks: sfb=5
     * -9db 0db
     *
     * Input: 1 1 1 1 1 1 1 -1 -1 -1 -1 -1 -1 -1 (repeated) longblocks: amp=1
     * sfb=12 en0/bw=-103 db max_en0 = -92db amp=32767 sfb=12 -12 db -1.4db
     *
     * Input: 1 1 1 1 1 1 1 -1 -1 -1 -1 -1 -1 -1 (repeated) shortblocks: amp=1
     * sfb=5 en0/bw= -99 -86 amp=32767 sfb=5 -9 db 4db
     *
     *
     * MAX energy of largest wave at 3.3kHz = 1db AVE energy of largest wave at
     * 3.3kHz = -11db Let's take AVE: -11db = maximum signal in sfb=12. Dynamic
     * range of CD: 96db. Therefor energy of smallest audible wave in sfb=12 =
     * -11 - 96 = -107db = ATH at 3.3kHz.
     *
     * ATH formula for this wave: -5db. To adjust to LAME scaling, we need ATH =
     * ATH_formula - 103 (db) ATH = ATH * 2.5e-10 (ener)
     * </PRE>
     */
    private ATHmdct(gfp: LameGlobalFlags, f: number): number {
        let ath = this.psy.ATHformula(f, gfp);

        ath -= NSATHSCALE;

        /* modify the MDCT scaling for the ATH and convert to energy */
        ath = Math.pow(10.0, ath / 10.0 + gfp.ATHlower);
        return ath;
    }

    private compute_ath(gfp: LameGlobalFlags): void {
        const ATH_l = gfp.internal_flags!.ATH!.l;
        const ATH_psfb21 = gfp.internal_flags!.ATH!.psfb21;
        const ATH_s = gfp.internal_flags!.ATH!.s;
        const ATH_psfb12 = gfp.internal_flags!.ATH!.psfb12;
        const gfc = gfp.internal_flags!;
        const samp_freq = gfp.out_samplerate;

        for (let sfb = 0; sfb < Encoder.SBMAX_l; sfb++) {
            const start = gfc.scalefac_band.l[sfb];
            const end = gfc.scalefac_band.l[sfb + 1];
            ATH_l[sfb] = 3.4028235e+38;
            for (let i = start; i < end; i++) {
                const freq = i * samp_freq / (2 * 576);
                const ATH_f = this.ATHmdct(gfp, freq);
                /* freq in kHz */
                ATH_l[sfb] = Math.min(ATH_l[sfb], ATH_f);
            }
        }

        for (let sfb = 0; sfb < Encoder.PSFB21; sfb++) {
            const start = gfc.scalefac_band.psfb21[sfb];
            const end = gfc.scalefac_band.psfb21[sfb + 1];
            ATH_psfb21[sfb] = 3.4028235e+38;
            for (let i = start; i < end; i++) {
                const freq = i * samp_freq / (2 * 576);
                const ATH_f = this.ATHmdct(gfp, freq);
                /* freq in kHz */
                ATH_psfb21[sfb] = Math.min(ATH_psfb21[sfb], ATH_f);
            }
        }

        for (let sfb = 0; sfb < Encoder.SBMAX_s; sfb++) {
            const start = gfc.scalefac_band.s[sfb];
            const end = gfc.scalefac_band.s[sfb + 1];
            ATH_s[sfb] = 3.4028235e+38;
            for (let i = start; i < end; i++) {
                const freq = i * samp_freq / (2 * 192);
                const ATH_f = this.ATHmdct(gfp, freq);
                /* freq in kHz */
                ATH_s[sfb] = Math.min(ATH_s[sfb], ATH_f);
            }
            ATH_s[sfb] *= (gfc.scalefac_band.s[sfb + 1] - gfc.scalefac_band.s[sfb]);
        }

        for (let sfb = 0; sfb < Encoder.PSFB12; sfb++) {
            const start = gfc.scalefac_band.psfb12[sfb];
            const end = gfc.scalefac_band.psfb12[sfb + 1];
            ATH_psfb12[sfb] = 3.4028235e+38;
            for (let i = start; i < end; i++) {
                const freq = i * samp_freq / (2 * 192);
                const ATH_f = this.ATHmdct(gfp, freq);
                /* freq in kHz */
                ATH_psfb12[sfb] = Math.min(ATH_psfb12[sfb], ATH_f);
            }
            /* not sure about the following */
            ATH_psfb12[sfb] *= (gfc.scalefac_band.s[13] - gfc.scalefac_band.s[12]);
        }

        /*
         * work in progress, don't rely on it too much
         */
        gfc.ATH!.floor = 10. * Math.log10(this.ATHmdct(gfp, -1.));
    }

    /**
     * initialization for iteration_loop
     */
    iteration_init(gfp: LameGlobalFlags): void {
        const gfc = gfp.internal_flags!;
        const l3_side = gfc.l3_side;
        let i;

        if (gfc.iteration_init_init == 0) {
            gfc.iteration_init_init = 1;

            l3_side.main_data_begin = 0;
            this.compute_ath(gfp);

            this.pow43[0] = 0.0;
            for (i = 1; i < PRECALC_SIZE; i++)
                this.pow43[i] = Math.pow(i, 4.0 / 3.0);

            for (i = 0; i < PRECALC_SIZE - 1; i++)
                this.adj43[i] = ((i + 1) - Math.pow(
                    0.5 * (this.pow43[i] + this.pow43[i + 1]), 0.75));
            this.adj43[i] = 0.5;

            for (i = 0; i < Q_MAX; i++)
                this.ipow20[i] = Math.pow(2.0, (i - 210) * -0.1875);
            for (i = 0; i <= Q_MAX + Q_MAX2; i++)
                this.pow20[i] = Math.pow(2.0, (i - 210 - Q_MAX2) * 0.25);

            this.tak.huffman_init(gfc);

        }
    }

    /**
     * allocate bits among 2 channels based on PE<BR>
     * mt 6/99<BR>
     * bugfixes rh 8/01: often allocated more than the allowed 4095 bits
     */
    on_pe(gfp: LameGlobalFlags, pe: Float32Array[] | Float64Array[] | number[][], targ_bits: Int32Array | number[], mean_bits: number, gr: number, cbr: number): number {
        const gfc = gfp.internal_flags!;
        let tbits = 0, bits;
        const add_bits = new Int32Array(2);
        let ch;

        /* allocate targ_bits for granule */
        const mb = new MeanBits(tbits);
        let extra_bits = this.rv.ResvMaxBits(gfp, mean_bits, mb, cbr);
        tbits = mb.bits;
        /* maximum allowed bits for this granule */
        let max_bits = tbits + extra_bits;
        if (max_bits > LameInternalFlags.MAX_BITS_PER_GRANULE) {
            // hard limit per granule
            max_bits = LameInternalFlags.MAX_BITS_PER_GRANULE;
        }
        for (bits = 0, ch = 0; ch < gfc.channels_out; ++ch) {
            /******************************************************************
             * allocate bits for each channel
             ******************************************************************/
            targ_bits[ch] = Math.min(LameInternalFlags.MAX_BITS_PER_CHANNEL,
                tbits / gfc.channels_out);

            add_bits[ch] = 0 | (targ_bits[ch] * pe[gr][ch] / 700.0 - targ_bits[ch]);

            /* at most increase bits by 1.5*average */
            if (add_bits[ch] > mean_bits * 3 / 4)
                add_bits[ch] = mean_bits * 3 / 4;
            if (add_bits[ch] < 0)
                add_bits[ch] = 0;

            if (add_bits[ch] + targ_bits[ch] > LameInternalFlags.MAX_BITS_PER_CHANNEL)
                add_bits[ch] = Math.max(0,
                    LameInternalFlags.MAX_BITS_PER_CHANNEL - targ_bits[ch]);

            bits += add_bits[ch];
        }
        if (bits > extra_bits) {
            for (ch = 0; ch < gfc.channels_out; ++ch) {
                add_bits[ch] = extra_bits * add_bits[ch] / bits;
            }
        }

        for (ch = 0; ch < gfc.channels_out; ++ch) {
            targ_bits[ch] += add_bits[ch];
            extra_bits -= add_bits[ch];
        }

        for (bits = 0, ch = 0; ch < gfc.channels_out; ++ch) {
            bits += targ_bits[ch];
        }
        if (bits > LameInternalFlags.MAX_BITS_PER_GRANULE) {
            let sum = 0;
            for (ch = 0; ch < gfc.channels_out; ++ch) {
                targ_bits[ch] *= LameInternalFlags.MAX_BITS_PER_GRANULE;
                targ_bits[ch] /= bits;
                sum += targ_bits[ch];
            }
        }

        return max_bits;
    }

    /**
     *  Robert Hegemann 2001-04-27:
     *  this adjusts the ATH, keeping the original noise floor
     *  affects the higher frequencies more than the lower ones
     */
    athAdjust(a: number, x: number, athFloor: number): number {
        /*
         * work in progress
         */
        const o = 90.30873362;
        const p = 94.82444863;
        let u = (Math.log10(x) * 10.0);
        const v = a * a;
        let w = 0.0;
        u -= athFloor;
        /* undo scaling */
        if (v > 1E-20)
            w = 1. + Math.log10(v) * (10.0 / o);
        if (w < 0)
            w = 0.;
        u *= w;
        u += athFloor + o - p;
        /* redo scaling */

        return Math.pow(10., 0.1 * u);
    }

    /**
     * Calculate the allowed distortion for each scalefactor band, as determined
     * by the psychoacoustic model. xmin(sb) = ratio(sb) * en(sb) / bw(sb)
     *
     * returns number of sfb's with energy > ATH
     */
    calc_xmin(gfc: LameInternalFlags, ratio: III_psy_ratio, cod_info: GrInfo, pxmin: Float32Array): number {
        let pxminPos = 0;
        let gsfb, j = 0, ath_over = 0;
        const ATH = gfc.ATH!;
        const xr = cod_info.xr;
        const masking_lower = gfc.masking_lower;

        for (gsfb = 0; gsfb < cod_info.psy_lmax; gsfb++) {
            let xmin = ATH.adjust * ATH.l[gsfb];
            let en0 = 0.0;
            for (let l = cod_info.width[gsfb]; l > 0; l--, j++)
                en0 += xr[j] * xr[j];
            if (en0 > xmin)
                ath_over++;

            const e = ratio.en.l[gsfb];
            if (e > 0.0) {
                const x = en0 * ratio.thm.l[gsfb] * masking_lower / e;
                if (xmin < x)
                    xmin = x;
            }
            pxmin[pxminPos++] = xmin;
        }
        /* end of long block loop */

        /* use this function to determine the highest non-zero coeff */
        let max_nonzero = 575;
        if (cod_info.block_type != Encoder.SHORT_TYPE) {
            // NORM, START or STOP type, but not SHORT
            let k = 576;
            while (k-- != 0 && BitStream.EQ(xr[k], 0)) {
                max_nonzero = k;
            }
        }
        cod_info.max_nonzero_coeff = max_nonzero;

        for (let sfb = cod_info.sfb_smin; gsfb < cod_info.psymax; sfb++, gsfb += 3) {
            const tmpATH = ATH.adjust * ATH.s[sfb];
            const width = cod_info.width[gsfb];
            for (let b = 0; b < 3; b++) {
                let en0 = 0.0;
                for (let l = width; l > 0; l--, j++)
                    en0 += xr[j] * xr[j];
                if (en0 > tmpATH)
                    ath_over++;

                let xmin = tmpATH;
                const e = ratio.en.s[sfb][b];
                if (e > 0.0) {
                    const x = en0 * ratio.thm.s[sfb][b] * masking_lower / e;
                    if (xmin < x)
                        xmin = x;
                }
                pxmin[pxminPos++] = xmin;
            }
            /* temporal masking */
            if (pxmin[pxminPos - 3] > pxmin[pxminPos - 3 + 1])
                pxmin[pxminPos - 3 + 1] += (pxmin[pxminPos - 3] - pxmin[pxminPos - 3 + 1]) * gfc.decay;
            if (pxmin[pxminPos - 3 + 1] > pxmin[pxminPos - 3 + 2])
                pxmin[pxminPos - 3 + 2] += (pxmin[pxminPos - 3 + 1] - pxmin[pxminPos - 3 + 2]) * gfc.decay;
        }
        /* end of short block sfb loop */

        return ath_over;
    }

    /** Squared quantization error over 2*l lines starting at j. */
    private calc_noise_core(cod_info: GrInfo, j: number, l: number, step: number): number {
        let noise = 0;
        const ix = cod_info.l3_enc, xr = cod_info.xr;
        const end = j + 2 * l;

        if (j > cod_info.count1) {
            for (; j < end; j++)
                noise += xr[j] * xr[j];
        } else if (j > cod_info.big_values) {
            /* count1 region: |ix| <= 1; upstream kept the step in a Float32Array */
            const ix01 = this.ix01;
            ix01[1] = step;
            for (; j < end; j++) {
                const temp = Math.abs(xr[j]) - ix01[ix[j]];
                noise += temp * temp;
            }
        } else {
            const pow43 = this.pow43;
            for (; j < end; j++) {
                const temp = Math.abs(xr[j]) - pow43[ix[j]] * step;
                noise += temp * temp;
            }
        }
        return noise;
    }

    /**
     * <PRE>
     * -oo dB  =>  -1.00
     * - 6 dB  =>  -0.97
     * - 3 dB  =>  -0.80
     * - 2 dB  =>  -0.64
     * - 1 dB  =>  -0.38
     *   0 dB  =>   0.00
     * + 1 dB  =>  +0.49
     * + 2 dB  =>  +1.06
     * + 3 dB  =>  +1.68
     * + 6 dB  =>  +3.69
     * +10 dB  =>  +6.45
     * </PRE>
     */
    calc_noise(cod_info: GrInfo, l3_xmin: Float32Array, distort: Float32Array, res: CalcNoiseResult, prev_noise: CalcNoiseData | null): number {
        let over = 0;
        let max_noise = -20.0;
        let over_SSD = 0;
        let j = 0;
        const scalefac = cod_info.scalefac, width = cod_info.width, window = cod_info.window;
        const pretab = cod_info.preflag != 0 ? this.pretab : null;
        const shift = cod_info.scalefac_scale + 1;

        for (let sfb = 0; sfb < cod_info.psymax; sfb++) {
            const s = cod_info.global_gain
                - ((scalefac[sfb] + (pretab ? pretab[sfb] : 0)) << shift)
                - cod_info.subblock_gain[window[sfb]] * 8;
            let noise;

            if (prev_noise != null && prev_noise.step[sfb] == s) {
                /* use previously computed values */
                j += width[sfb];
                distort[sfb] = prev_noise.noise[sfb] / l3_xmin[sfb];
                noise = prev_noise.noise_log[sfb];
            } else {
                const step = this.POW20(s);
                let l = width[sfb] >> 1;
                if ((j + width[sfb]) > cod_info.max_nonzero_coeff) {
                    const usefullsize = cod_info.max_nonzero_coeff - j + 1;
                    l = usefullsize > 0 ? usefullsize >> 1 : 0;
                }

                noise = this.calc_noise_core(cod_info, j, l, step);
                j += 2 * l;

                if (prev_noise != null) {
                    /* save noise values */
                    prev_noise.step[sfb] = s;
                    prev_noise.noise[sfb] = noise;
                }

                noise = distort[sfb] = noise / l3_xmin[sfb];

                /* multiplying here is adding in dB, but can overflow */
                noise = Math.log10(Math.max(noise, 1E-20));

                if (prev_noise != null)
                    prev_noise.noise_log[sfb] = noise;
            }

            if (noise > 0.0) {
                const tmp = Math.max(0 | (noise * 10 + .5), 1);
                over_SSD += tmp * tmp;
                over++;
            }
            max_noise = Math.max(max_noise, noise);
        }
        if (prev_noise != null)
            prev_noise.global_gain = cod_info.global_gain;

        res.over_count = over;
        res.over_SSD = over_SSD;
        res.max_noise = max_noise;
        return over;
    }

}
