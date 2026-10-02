
import CalcNoiseResult from './CalcNoiseResult.js';
import CalcNoiseData from './CalcNoiseData.js';
import Encoder from './Encoder.js';
import GrInfo from './GrInfo.js';
import L3Side from './L3Side.js';
import LameInternalFlags from './LameInternalFlags.js';
import QuantizePVT from './QuantizePVT.js';
import Reservoir from './Reservoir.js';
import Takehiro from './Takehiro.js';

/*
 * MP3 quantization
 *
 *      Copyright (c) 1999-2000 Mark Taylor
 *      Copyright (c) 1999-2003 Takehiro Tominaga
 *      Copyright (c) 2000-2007 Robert Hegemann
 *      Copyright (c) 2001-2005 Gabriel Bouvigne
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.     See the GNU
 * Library General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the
 * Free Software Foundation, Inc., 59 Temple Place - Suite 330,
 * Boston, MA 02111-1307, USA.
 */

/* $Id: Quantize.java,v 1.24 2011/05/24 20:48:06 kenchis Exp $ */

class BinSearchDirection {
    static readonly BINSEARCH_NONE = new BinSearchDirection(0);
    static readonly BINSEARCH_UP = new BinSearchDirection(1);
    static readonly BINSEARCH_DOWN = new BinSearchDirection(2);
    constructor(public ordinal: number) {}
}

export default class Quantize {
    constructor(readonly rv: Reservoir, readonly qupvt: QuantizePVT, private readonly tk: Takehiro) {}

    /* outer_loop work buffers */
    private readonly cod_info_w = new GrInfo();
    private readonly save_xrpow = new Float32Array(576);
    private readonly distort = new Float32Array(L3Side.SFBMAX);
    private readonly prev_noise = new CalcNoiseData();
    private readonly ixwork = new Float32Array(576);

    /**
     * mt 6/99
     *
     * initializes cod_info, scalefac and xrpow
     *
     * returns 0 if all energies in xr are zero, else 1
     */
    private init_xrpow_core(cod_info: GrInfo, xrpow: Float32Array, upper: number, sum: number): number {
        sum = 0;
        for (let i = 0; i <= upper; ++i) {
            const tmp = Math.abs(cod_info.xr[i]);
            sum += tmp;
            xrpow[i] = Math.sqrt(tmp * Math.sqrt(tmp));

            if (xrpow[i] > cod_info.xrpow_max)
                cod_info.xrpow_max = xrpow[i];
        }
        return sum;
    }

    init_xrpow(cod_info: GrInfo, xrpow: Float32Array): boolean {
        let sum = 0;
        const upper = 0 | cod_info.max_nonzero_coeff;

        cod_info.xrpow_max = 0;

        /*
         * check if there is some energy we have to quantize and calculate xrpow
         * matching our fresh scalefactors
         */

        xrpow.fill(0, upper, 576);

        sum = this.init_xrpow_core(cod_info, xrpow, upper, sum);

        /*
         * return 1 if we have something to quantize, else 0
         */
        if (sum > 1E-20)
            return true;

        cod_info.l3_enc.fill(0, 0, 576);
        return false;
    }

    /**
     * Gabriel Bouvigne feb/apr 2003<BR>
     * Analog silence detection in partitionned sfb21 or sfb12 for short blocks
     *
     * From top to bottom of sfb, changes to 0 coeffs which are below ath. It
     * stops on the first coeff higher than ath.
     */
    private psfb21_analogsilence(gfc: LameInternalFlags, cod_info: GrInfo): void {
        const ath = gfc.ATH!;
        const xr = cod_info.xr;

        if (cod_info.block_type != Encoder.SHORT_TYPE) {
            /* NORM, START or STOP type, but not SHORT blocks */
            let stop = false;
            for (let gsfb = Encoder.PSFB21 - 1; gsfb >= 0 && !stop; gsfb--) {
                const start = gfc.scalefac_band.psfb21[gsfb];
                const end = gfc.scalefac_band.psfb21[gsfb + 1];
                const ath21 = this.qupvt.athAdjust(ath.adjust, ath.psfb21[gsfb],
                    ath.floor);

                for (let j = end - 1; j >= start; j--) {
                    if (Math.abs(xr[j]) < ath21)
                        xr[j] = 0;
                    else {
                        stop = true;
                        break;
                    }
                }
            }
        } else {
            /* note: short blocks coeffs are reordered */
            for (let block = 0; block < 3; block++) {
                let stop = false;
                for (let gsfb = Encoder.PSFB12 - 1; gsfb >= 0 && !stop; gsfb--) {
                    const start = gfc.scalefac_band.s[12]
                        * 3
                        + (gfc.scalefac_band.s[13] - gfc.scalefac_band.s[12])
                        * block
                        + (gfc.scalefac_band.psfb12[gsfb] - gfc.scalefac_band.psfb12[0]);
                    const end = start
                        + (gfc.scalefac_band.psfb12[gsfb + 1] - gfc.scalefac_band.psfb12[gsfb]);
                    const ath12 = this.qupvt.athAdjust(ath.adjust, ath.psfb12[gsfb],
                        ath.floor);

                    for (let j = end - 1; j >= start; j--) {
                        if (Math.abs(xr[j]) < ath12)
                            xr[j] = 0;
                        else {
                            stop = true;
                            break;
                        }
                    }
                }
            }
        }

    }

    init_outer_loop(gfc: LameInternalFlags, cod_info: GrInfo): void {
        /*
         * initialize fresh cod_info
         */
        cod_info.part2_3_length = 0;
        cod_info.big_values = 0;
        cod_info.count1 = 0;
        cod_info.global_gain = 210;
        cod_info.scalefac_compress = 0;
        /* mixed_block_flag, block_type was set in psymodel.c */
        cod_info.table_select[0] = 0;
        cod_info.table_select[1] = 0;
        cod_info.table_select[2] = 0;
        cod_info.subblock_gain[0] = 0;
        cod_info.subblock_gain[1] = 0;
        cod_info.subblock_gain[2] = 0;
        cod_info.subblock_gain[3] = 0;
        /* this one is always 0 */
        cod_info.region0_count = 0;
        cod_info.region1_count = 0;
        cod_info.preflag = 0;
        cod_info.scalefac_scale = 0;
        cod_info.count1table_select = 0;
        cod_info.part2_length = 0;
        cod_info.sfb_lmax = Encoder.SBPSY_l;
        cod_info.sfb_smin = Encoder.SBPSY_s;
        cod_info.psy_lmax = Encoder.SBPSY_l;
        cod_info.psymax = cod_info.psy_lmax;
        cod_info.sfbmax = cod_info.sfb_lmax;
        cod_info.sfbdivide = 11;
        for (let sfb = 0; sfb < Encoder.SBMAX_l; sfb++) {
            cod_info.width[sfb] = gfc.scalefac_band.l[sfb + 1]
                - gfc.scalefac_band.l[sfb];
            /* which is always 0. */
            cod_info.window[sfb] = 3;
        }
        if (cod_info.block_type == Encoder.SHORT_TYPE) {
            const ixwork = this.ixwork;

            cod_info.sfb_smin = 0;
            cod_info.sfb_lmax = 0;
            cod_info.psymax = cod_info.sfb_lmax
                + 3
                * (Encoder.SBPSY_s - cod_info.sfb_smin);
            cod_info.sfbmax = cod_info.sfb_lmax + 3
                * (Encoder.SBPSY_s - cod_info.sfb_smin);
            cod_info.sfbdivide = cod_info.sfbmax - 18;
            cod_info.psy_lmax = cod_info.sfb_lmax;
            /* re-order the short blocks, for more efficient encoding below */
            /* By Takehiro TOMINAGA */
            /*
             * Within each scalefactor band, data is given for successive time
             * windows, beginning with window 0 and ending with window 2. Within
             * each window, the quantized values are then arranged in order of
             * increasing frequency...
             */
            let ix = gfc.scalefac_band.l[cod_info.sfb_lmax];
            ixwork.set(cod_info.xr.subarray(0, 576), 0);
            for (let sfb = cod_info.sfb_smin; sfb < Encoder.SBMAX_s; sfb++) {
                const start = gfc.scalefac_band.s[sfb];
                const end = gfc.scalefac_band.s[sfb + 1];
                for (let window = 0; window < 3; window++) {
                    for (let l = start; l < end; l++) {
                        cod_info.xr[ix++] = ixwork[3 * l + window];
                    }
                }
            }

            let j = cod_info.sfb_lmax;
            for (let sfb = cod_info.sfb_smin; sfb < Encoder.SBMAX_s; sfb++) {
                cod_info.width[j] = cod_info.width[j + 1] = cod_info.width[j + 2] = gfc.scalefac_band.s[sfb + 1]
                    - gfc.scalefac_band.s[sfb];
                cod_info.window[j] = 0;
                cod_info.window[j + 1] = 1;
                cod_info.window[j + 2] = 2;
                j += 3;
            }
        }

        cod_info.count1bits = 0;
        cod_info.sfb_partition_table = this.qupvt.nr_of_sfb_block[0][0];
        cod_info.slen[0] = 0;
        cod_info.slen[1] = 0;
        cod_info.slen[2] = 0;
        cod_info.slen[3] = 0;

        cod_info.max_nonzero_coeff = 575;

        /*
         * fresh scalefactors are all zero
         */
        cod_info.scalefac.fill(0);

        this.psfb21_analogsilence(gfc, cod_info);
    };

    /**
     * author/date??
     *
     * binary step size search used by outer_loop to get a quantizer step size
     * to start with
     */
    private bin_search_StepSize(gfc: LameInternalFlags, cod_info: GrInfo, desired_rate: number, ch: number, xrpow: Float32Array): number {
        let nBits;
        let CurrentStep = gfc.CurrentStep[ch];
        let flagGoneOver = false;
        const start = gfc.OldValue[ch];
        let Direction = BinSearchDirection.BINSEARCH_NONE;
        cod_info.global_gain = start;
        desired_rate -= cod_info.part2_length;

        for (; ;) {
            let step;
            nBits = this.tk.count_bits(gfc, xrpow, cod_info, null);

            if (CurrentStep == 1 || nBits == desired_rate)
                break;
            /* nothing to adjust anymore */

            if (nBits > desired_rate) {
                /* increase Quantize_StepSize */
                if (Direction == BinSearchDirection.BINSEARCH_DOWN)
                    flagGoneOver = true;

                if (flagGoneOver)
                    CurrentStep /= 2;
                Direction = BinSearchDirection.BINSEARCH_UP;
                step = CurrentStep;
            } else {
                /* decrease Quantize_StepSize */
                if (Direction == BinSearchDirection.BINSEARCH_UP)
                    flagGoneOver = true;

                if (flagGoneOver)
                    CurrentStep /= 2;
                Direction = BinSearchDirection.BINSEARCH_DOWN;
                step = -CurrentStep;
            }
            cod_info.global_gain += step;
            if (cod_info.global_gain < 0) {
                cod_info.global_gain = 0;
                flagGoneOver = true;
            }
            if (cod_info.global_gain > 255) {
                cod_info.global_gain = 255;
                flagGoneOver = true;
            }
        }

        while (nBits > desired_rate && cod_info.global_gain < 255) {
            cod_info.global_gain++;
            nBits = this.tk.count_bits(gfc, xrpow, cod_info, null);
        }
        gfc.CurrentStep[ch] = (start - cod_info.global_gain >= 4) ? 4 : 2;
        gfc.OldValue[ch] = cod_info.global_gain;
        cod_info.part2_3_length = nBits;
        return nBits;
    }

    /**
     * author/date??
     *
     * Function: Returns zero if there is a scalefac which has not been
     * amplified. Otherwise it returns one.
     */
    private loop_break(cod_info: GrInfo): boolean {
        for (let sfb = 0; sfb < cod_info.sfbmax; sfb++)
            if (cod_info.scalefac[sfb]
                + cod_info.subblock_gain[cod_info.window[sfb]] == 0)
                return false;

        return true;
    }

    /** LAME's quant_comp 9 comparison (the CBR presets use it for long and short blocks). */
    private quant_compare(best: CalcNoiseResult, calc: CalcNoiseResult): boolean {
        /*
         * noise is given in decibels (dB) relative to masking thesholds.
         * max_noise: max quantization noise
         */
        if (best.over_count > 0) {
            /* there are distorted sfb */
            if (calc.over_SSD == best.over_SSD)
                return calc.bits < best.bits;
            return calc.over_SSD <= best.over_SSD;
        }
        /*
         * no distorted sfb: only use this quantization if it is better, and if it
         * uses less bits. Unfortunately, part2_3_length is sometimes a poor
         * estimator of the final size at low bitrates.
         */
        return calc.max_noise < 0 && (calc.max_noise * 10 + calc.bits) <= (best.max_noise * 10 + best.bits)
            && calc.bits < best.bits;
    }

    /**
     * author/date??
     *
     * <PRE>
     *  Amplify the scalefactor bands that violate the masking threshold.
     *  See ISO 11172-3 Section C.1.5.4.3.5
     *
     *  distort[] = noise/masking
     *  distort[] > 1   ==> noise is not masked
     *  distort[] < 1   ==> noise is masked
     *  max_dist = maximum value of distort[]
     *
     *  Three algorithms:
     *  noise_shaping_amp
     *        0             Amplify all bands with distort[]>1.
     *
     *        1             Amplify all bands with distort[] >= max_dist^(.5);
     *                     ( 50% in the db scale)
     *
     *        2             Amplify first band with distort[] >= max_dist;
     *
     *
     *  For algorithms 0 and 1, if max_dist < 1, then amplify all bands
     *  with distort[] >= .95*max_dist.  This is to make sure we always
     *  amplify at least one band.
     * </PRE>
     */
    private amp_scalefac_bands(cod_info: GrInfo, distort: Float32Array, xrpow: Float32Array): void {
        let ifqstep34;

        if (cod_info.scalefac_scale == 0) {
            ifqstep34 = 1.29683955465100964055;
            /* 2**(.75*.5) */
        } else {
            ifqstep34 = 1.68179283050742922612;
            /* 2**(.75*1) */
        }

        /* compute maximum value of distort[] */
        let trigger = 0;
        for (let sfb = 0; sfb < cod_info.sfbmax; sfb++) {
            if (trigger < distort[sfb])
                trigger = distort[sfb];
        }

        /* noise_shaping_amp 1: amplify bands within 50% of max (on db scale) */
        if (trigger > 1.0)
            trigger = Math.pow(trigger, .5);
        else
            trigger *= .95;

        let j = 0;
        for (let sfb = 0; sfb < cod_info.sfbmax; sfb++) {
            const width = cod_info.width[sfb];
            let l;
            j += width;
            if (distort[sfb] < trigger)
                continue;

            cod_info.scalefac[sfb]++;
            for (l = -width; l < 0; l++) {
                xrpow[j + l] *= ifqstep34;
                if (xrpow[j + l] > cod_info.xrpow_max)
                    cod_info.xrpow_max = xrpow[j + l];
            }

        }
    }

    /**
     * Takehiro Tominaga 2000-xx-xx
     *
     * turns on scalefac scale and adjusts scalefactors
     */
    private inc_scalefac_scale(cod_info: GrInfo, xrpow: Float32Array): void {
        const ifqstep34 = 1.29683955465100964055;

        let j = 0;
        for (let sfb = 0; sfb < cod_info.sfbmax; sfb++) {
            const width = cod_info.width[sfb];
            let s = cod_info.scalefac[sfb];
            if (cod_info.preflag != 0)
                s += this.qupvt.pretab[sfb];
            j += width;
            if ((s & 1) != 0) {
                s++;
                for (let l = -width; l < 0; l++) {
                    xrpow[j + l] *= ifqstep34;
                    if (xrpow[j + l] > cod_info.xrpow_max)
                        cod_info.xrpow_max = xrpow[j + l];
                }
            }
            cod_info.scalefac[sfb] = s >> 1;
        }
        cod_info.preflag = 0;
        cod_info.scalefac_scale = 1;
    }

    /**
     * Takehiro Tominaga 2000-xx-xx
     *
     * increases the subblock gain and adjusts scalefactors
     */
    private inc_subblock_gain(gfc: LameInternalFlags, cod_info: GrInfo, xrpow: Float32Array): boolean {
        let sfb;
        const scalefac = cod_info.scalefac;

        /* subbloc_gain can't do anything in the long block region */
        for (sfb = 0; sfb < cod_info.sfb_lmax; sfb++) {
            if (scalefac[sfb] >= 16)
                return true;
        }

        for (let window = 0; window < 3; window++) {
            let s1 = 0;
            let s2 = 0;

            for (sfb = cod_info.sfb_lmax + window; sfb < cod_info.sfbdivide; sfb += 3) {
                if (s1 < scalefac[sfb])
                    s1 = scalefac[sfb];
            }
            for (; sfb < cod_info.sfbmax; sfb += 3) {
                if (s2 < scalefac[sfb])
                    s2 = scalefac[sfb];
            }

            if (s1 < 16 && s2 < 8)
                continue;

            if (cod_info.subblock_gain[window] >= 7)
                return true;

            /*
             * even though there is no scalefactor for sfb12 subblock gain
             * affects upper frequencies too, that's why we have to go up to
             * SBMAX_s
             */
            cod_info.subblock_gain[window]++;
            let j = gfc.scalefac_band.l[cod_info.sfb_lmax];
            for (sfb = cod_info.sfb_lmax + window; sfb < cod_info.sfbmax; sfb += 3) {
                let amp: number;
                const width = cod_info.width[sfb];
                let s = scalefac[sfb];
                s = s - (4 >> cod_info.scalefac_scale);
                if (s >= 0) {
                    scalefac[sfb] = s;
                    j += width * 3;
                    continue;
                }

                scalefac[sfb] = 0;
                {
                    const gain = 210 + (s << (cod_info.scalefac_scale + 1));
                    amp = this.qupvt.IPOW20(gain);
                }
                j += width * (window + 1);
                for (let l = -width; l < 0; l++) {
                    xrpow[j + l] *= amp;
                    if (xrpow[j + l] > cod_info.xrpow_max)
                        cod_info.xrpow_max = xrpow[j + l];
                }
                j += width * (3 - window - 1);
            }

            {
                const amp = this.qupvt.IPOW20(202);
                j += cod_info.width[sfb] * (window + 1);
                for (let l = -cod_info.width[sfb]; l < 0; l++) {
                    xrpow[j + l] *= amp;
                    if (xrpow[j + l] > cod_info.xrpow_max)
                        cod_info.xrpow_max = xrpow[j + l];
                }
            }
        }
        return false;
    }

    /**
     * <PRE>
     *  Takehiro Tominaga /date??
     *  Robert Hegemann 2000-09-06: made a function of it
     *
     *  amplifies scalefactor bands,
     *   - if all are already amplified returns 0
     *   - if some bands are amplified too much:
     *      * try to increase scalefac_scale
     *      * if already scalefac_scale was set
     *          try on short blocks to increase subblock gain
     * </PRE>
     */
    private balance_noise(gfc: LameInternalFlags, cod_info: GrInfo, distort: Float32Array, xrpow: Float32Array): boolean {
        this.amp_scalefac_bands(cod_info, distort, xrpow);

        /*
         * check to make sure we have not amplified too much loop_break returns
         * 0 if there is an unamplified scalefac scale_bitcount returns 0 if no
         * scalefactors are too large
         */

        let status = this.loop_break(cod_info);

        if (status)
            return false;
        /* all bands amplified */

        /*
         * not all scalefactors have been amplified. so these scalefacs are
         * possibly valid. encode them:
         */
        if (gfc.mode_gr == 2)
            status = this.tk.scale_bitcount(cod_info);
        else
            status = this.tk.scale_bitcount_lsf(cod_info);

        if (!status)
            return true;
        /* amplified some bands not exceeding limits */

        /*
         * some scalefactors are too large. lets try setting scalefac_scale=1
         */
        if (gfc.noise_shaping > 1) {
            if (0 == cod_info.scalefac_scale) {
                this.inc_scalefac_scale(cod_info, xrpow);
                status = false;
            } else {
                if (cod_info.block_type == Encoder.SHORT_TYPE) {
                    status = (this.inc_subblock_gain(gfc, cod_info, xrpow) || this.loop_break(cod_info));
                }
            }
        }

        if (!status) {
            if (gfc.mode_gr == 2)
                status = this.tk.scale_bitcount(cod_info);
            else
                status = this.tk.scale_bitcount_lsf(cod_info);
        }
        return !status;
    }

    /**
     * <PRE>
     *  Function: The outer iteration loop controls the masking conditions
     *  of all scalefactorbands. It computes the best scalefac and
     *  global gain. This module calls the inner iteration loop
     *
     *  mt 5/99 completely rewritten to allow for bit reservoir control,
     *  mid/side channels with L/R or mid/side masking thresholds,
     *  and chooses best quantization instead of last quantization when
     *  no distortion free quantization can be found.
     *
     *  added VBR support mt 5/99
     *
     *  some code shuffle rh 9/00
     * </PRE>
     *
     * @param l3_xmin
     *            allowed distortion
     * @param xrpow
     *            coloured magnitudes of spectral
     * @param targ_bits
     *            maximum allowed bits
     */
    outer_loop(gfc: LameInternalFlags, cod_info: GrInfo, l3_xmin: Float32Array, xrpow: Float32Array, ch: number, targ_bits: number): number {
        const cod_info_w = this.cod_info_w;
        const save_xrpow = this.save_xrpow;
        const distort = this.distort;
        const prev_noise = this.prev_noise;
        let best_noise_info = new CalcNoiseResult();
        let best_part2_3_length = 9999999;

        this.bin_search_StepSize(gfc, cod_info, targ_bits, ch, xrpow);

        /* compute the distortion in this quantization */
        /* coefficients and thresholds both l/r (or both mid/side) */
        prev_noise.reset();
        distort.fill(0);
        this.qupvt.calc_noise(cod_info, l3_xmin, distort, best_noise_info, prev_noise);
        best_noise_info.bits = cod_info.part2_3_length;

        cod_info_w.assign(cod_info);
        let age = 0;
        save_xrpow.set(xrpow);

        do {
            const noise_info = new CalcNoiseResult();
            /*
             * When quantization with no distorted bands is found, allow up to
             * 3 new unsuccesful tries in serial.
             */
            const search_limit = 3;
            let maxggain = 255;

            /* try a new scalefactor conbination on cod_info_w */
            if (!this.balance_noise(gfc, cod_info_w, distort, xrpow))
                break;
            if (cod_info_w.scalefac_scale != 0)
                maxggain = 254;

            /*
             * inner_loop starts with the initial quantization step computed
             * above and slowly increases until the bits < huff_bits. Thus it is
             * important not to start with too large of an inital quantization
             * step. Too small is ok, but inner_loop will take longer
             */
            const huff_bits = targ_bits - cod_info_w.part2_length;
            if (huff_bits <= 0)
                break;

            /* increase quantizer stepsize until needed bits are below maximum */
            while ((cod_info_w.part2_3_length = this.tk.count_bits(gfc, xrpow, cod_info_w, prev_noise)) > huff_bits
                && cod_info_w.global_gain <= maxggain)
                cod_info_w.global_gain++;

            if (cod_info_w.global_gain > maxggain)
                break;

            if (best_noise_info.over_count == 0) {
                while ((cod_info_w.part2_3_length = this.tk.count_bits(gfc, xrpow, cod_info_w, prev_noise)) > best_part2_3_length
                    && cod_info_w.global_gain <= maxggain)
                    cod_info_w.global_gain++;

                if (cod_info_w.global_gain > maxggain)
                    break;
            }

            /* compute the distortion in this quantization */
            this.qupvt.calc_noise(cod_info_w, l3_xmin, distort, noise_info, prev_noise);
            noise_info.bits = cod_info_w.part2_3_length;

            /* check if this quantization is better than our saved quantization */
            if (this.quant_compare(best_noise_info, noise_info)) {
                /* save data so we can restore this quantization later */
                best_part2_3_length = cod_info.part2_3_length;
                best_noise_info = noise_info;
                cod_info.assign(cod_info_w);
                age = 0;
                save_xrpow.set(xrpow);
            } else {
                /* early stop? */
                if (++age > search_limit && best_noise_info.over_count == 0)
                    break;
            }
        } while ((cod_info_w.global_gain + cod_info_w.scalefac_scale) < 255);

        return best_noise_info.over_count;
    }

    /**
     * Robert Hegemann 2000-09-06
     *
     * update reservoir status after FINAL quantization/bitrate
     */
    iteration_finish_one(gfc: LameInternalFlags, gr: number, ch: number): void {
        const l3_side = gfc.l3_side;
        const cod_info = l3_side.tt[gr][ch];

        /*
         * try some better scalefac storage
         */
        this.tk.best_scalefac_store(gfc, gr, ch, l3_side);

        /*
         * best huffman_divide may save some bits too
         */
        this.tk.best_huffman_divide(gfc, cod_info);

        /*
         * update reservoir status after FINAL quantization/bitrate
         */
        this.rv.ResvAdjust(gfc, cod_info);
    };

}
