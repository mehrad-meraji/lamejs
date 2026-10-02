import { ShortBlock, new_float_n } from './common.js';
import FFT from './FFT.js';
import Encoder from './Encoder.js';
import III_psy_ratio from './III_psy_ratio.js';
import type LameGlobalFlags from './LameGlobalFlags.js';
import type LameInternalFlags from './LameInternalFlags.js';

/*
 *      psymodel.c
 *
 *      Copyright (c) 1999-2000 Mark Taylor
 *      Copyright (c) 2001-2002 Naoki Shibata
 *      Copyright (c) 2000-2003 Takehiro Tominaga
 *      Copyright (c) 2000-2008 Robert Hegemann
 *      Copyright (c) 2000-2005 Gabriel Bouvigne
 *      Copyright (c) 2000-2005 Alexander Leidinger
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

/* $Id: PsyModel.java,v 1.27 2011/05/24 20:48:06 kenchis Exp $ */

/*
 PSYCHO ACOUSTICS

 This routine computes the psycho acoustics, delayed by one granule.

 Input: buffer of PCM data (1024 samples).

 This window should be centered over the 576 sample granule window.
 The routine will compute the psycho acoustics for
 this granule, but return the psycho acoustics computed
 for the *previous* granule.  This is because the block
 type of the previous granule can only be determined
 after we have computed the psycho acoustics for the following
 granule.

 Output:  maskings and energies for each scalefactor band.
 block type, PE, and some correlation measures.
 The PE is used by CBR modes to determine if extra bits
 from the bit reservoir should be used.  The correlation
 measures are used to determine mid/side or regular stereo.
 */
/*
 Notation:

 barks:  a non-linear frequency scale.  Mapping from frequency to
 barks is given by this.freq2bark()

 scalefactor bands: The spectrum (frequencies) are broken into
 SBMAX "scalefactor bands".  Thes bands
 are determined by the MPEG ISO spec.  In
 the noise shaping/quantization code, we allocate
 bits among the partition bands to achieve the
 best possible quality

 partition bands:   The spectrum is also broken into about
 64 "partition bands".  Each partition
 band is about .34 barks wide.  There are about 2-5
 partition bands for each scalefactor band.

 LAME computes all psycho acoustic information for each partition
 band.  Then at the end of the computations, this information
 is mapped to scalefactor bands.  The energy in each scalefactor
 band is taken as the sum of the energy in all partition bands
 which overlap the scalefactor band.  The maskings can be computed
 in the same way (and thus represent the average masking in that band)
 or by taking the minmum value multiplied by the number of
 partition bands used (which represents a minimum masking in that band).
 */
/*
 The general outline is as follows:

 1. compute the energy in each partition band
 2. compute the tonality in each partition band
 3. compute the strength of each partion band "masker"
 4. compute the masking (via the spreading function applied to each masker)
 5. Modifications for mid/side masking.

 Each partition band is considiered a "masker".  The strength
 of the i'th masker in band j is given by:

 s3(bark(i)-bark(j))*strength(i)

 The strength of the masker is a function of the energy and tonality.
 The more tonal, the less masking.  LAME uses a simple linear formula
 (controlled by NMT and TMN) which says the strength is given by the
 energy divided by a linear function of the tonality.
 */
/*
 s3() is the "spreading function".  It is given by a formula
 determined via listening tests.

 The total masking in the j'th partition band is the sum over
 all maskings i.  It is thus given by the convolution of
 the strength with s3(), the "spreading function."

 masking(j) = sum_over_i  s3(i-j)*strength(i)  = s3 o strength

 where "o" = convolution operator.  s3 is given by a formula determined
 via listening tests.  It is normalized so that s3 o 1 = 1.

 Note: instead of a simple convolution, LAME also has the
 option of using "additive masking"

 The most critical part is step 2, computing the tonality of each
 partition band.  LAME has two tonality estimators.  The first
 is based on the ISO spec, and measures how predictiable the
 signal is over time.  The more predictable, the more tonal.
 The second measure is based on looking at the spectrum of
 a single granule.  The more peaky the spectrum, the more
 tonal.  By most indications, the latter approach is better.

 Finally, in step 5, the maskings for the mid and side
 channel are possibly increased.  Under certain circumstances,
 noise in the mid & side channels is assumed to also
 be masked by strong maskers in the L or R channels.

 Other data computed by the psy-model:

 ms_ratio        side-channel / mid-channel masking ratio (for previous granule)
 ms_ratio_next   side-channel / mid-channel masking ratio for this granule

 percep_entropy[2]     L and R values (prev granule) of PE - A measure of how
 much pre-echo is in the previous granule
 percep_entropy_MS[2]  mid and side channel values (prev granule) of percep_entropy
 energy[4]             L,R,M,S energy in each channel, prev granule
 blocktype_d[2]        block type to use for previous granule
 */

export default class PsyModel {
    private fft = new FFT();

    /** Work buffers for L3psycho_anal_ns, reused across granules; every slot read is written first. */
    private readonly scratch = {
        wsamp_L: new_float_n([2, Encoder.BLKSIZE]),
        wsamp_S: new_float_n<Float32Array[][]>([2, 3, Encoder.BLKSIZE_s]),
        eb_l: new Float32Array(Encoder.CBANDS + 1),
        eb_s: new Float32Array(Encoder.CBANDS + 1),
        thr: new Float32Array(Encoder.CBANDS + 2),
        blocktype: new Int32Array(2),
        uselongblock: new Int32Array(2),
        ns_hpfsmpl: new_float_n([2, 576]),
        mask_idx_l: new Int32Array(Encoder.CBANDS + 2),
        en_subshort: new Float32Array(12),
        attack_intensity: new Float32Array(12),
        max: new Float32Array(Encoder.CBANDS),
        avg: new Float32Array(Encoder.CBANDS),
        fftenergy: new Float32Array(Encoder.HBLKSIZE),
        fftenergy_s: new_float_n([3, Encoder.HBLKSIZE_s]),
    };

    private static readonly LOG10 = 2.30258509299404568402;

    private static readonly rpelev_s = 2;
    private static readonly rpelev2_s = 16;

    /* size of each partition band, in barks: */
    private static readonly DELBARK = .34;

    /* tuned for output level (sensitive to energy scale) */
    private static readonly VO_SCALE = (1. / (14752 * 14752) / (Encoder.BLKSIZE / 2));

    private static readonly temporalmask_sustain_sec = 0.01;

    private static readonly NS_PREECHO_ATT0 = 0.8;

    private static readonly NSFIRLEN = 21;

    /* size of each partition band, in barks: */
    private static readonly LN_TO_LOG10 = 0.2302585093;

    /**
     * <PRE>
     *       L3psycho_anal.  Compute psycho acoustics.
     *
     *       Data returned to the calling program must be delayed by one
     *       granule.
     *
     *       This is done in two places.
     *       If we do not need to know the blocktype, the copying
     *       can be done here at the top of the program: we copy the data for
     *       the last granule (computed during the last call) before it is
     *       overwritten with the new data.  It looks like this:
     *
     *       0. static psymodel_data
     *       1. calling_program_data = psymodel_data
     *       2. compute psymodel_data
     *
     *       For data which needs to know the blocktype, the copying must be
     *       done at the end of this loop, and the old values must be saved:
     *
     *       0. static psymodel_data_old
     *       1. compute psymodel_data
     *       2. compute possible block type of this granule
     *       3. compute final block type of previous granule based on #2.
     *       4. calling_program_data = psymodel_data_old
     *       5. psymodel_data_old = psymodel_data
     *     psycho_loudness_approx
     *       jd - 2001 mar 12
     *    in:  energy   - BLKSIZE/2 elements of frequency magnitudes ^ 2
     *         gfp      - uses out_samplerate, ATHtype (also needed for ATHformula)
     *    returns: loudness^2 approximation, a positive value roughly tuned for a value
     *             of 1.0 for signals near clipping.
     *    notes:   When calibrated, feeding this function binary white noise at sample
     *             values +32767 or -32768 should return values that approach 3.
     *             ATHformula is used to approximate an equal loudness curve.
     *    future:  Data indicates that the shape of the equal loudness curve varies
     *             with intensity.  This function might be improved by using an equal
     *             loudness curve shaped for typical playback levels (instead of the
     *             ATH, that is shaped for the threshold).  A flexible realization might
     *             simply bend the existing ATH curve to achieve the desired shape.
     *             However, the potential gain may not be enough to justify an effort.
     * </PRE>
     */
    private psycho_loudness_approx(energy: Float32Array, gfc: LameInternalFlags): number {
        let loudness_power = 0.0;
        /* apply weights to power in freq. bands */
        for (let i = 0; i < Encoder.BLKSIZE / 2; ++i)
            loudness_power += energy[i] * gfc.ATH!.eql_w[i];
        loudness_power *= PsyModel.VO_SCALE;

        return loudness_power;
    }

    private compute_ffts(gfc: LameInternalFlags, fftenergy: Float32Array, fftenergy_s: Float32Array[], wsamp_l: Float32Array, wsamp_s: Float32Array[], gr_out: number, chn: number, buffer: ArrayLike<number>[], bufPos: number): void {
        this.fft.fft_long(gfc, wsamp_l, chn, buffer, bufPos);
        this.fft.fft_short(gfc, wsamp_s, chn, buffer, bufPos);

        /*********************************************************************
         * compute energies
         *********************************************************************/
        fftenergy[0] = wsamp_l[0];
        fftenergy[0] *= fftenergy[0];

        for (let j = Encoder.BLKSIZE / 2 - 1; j >= 0; --j) {
            const re = wsamp_l[Encoder.BLKSIZE / 2 - j];
            const im = wsamp_l[Encoder.BLKSIZE / 2 + j];
            fftenergy[Encoder.BLKSIZE / 2 - j] = (re * re + im * im) * 0.5;
        }
        for (let b = 2; b >= 0; --b) {
            const ws = wsamp_s[b], fe = fftenergy_s[b];
            fe[0] = ws[0];
            fe[0] *= fe[0];
            for (let j = Encoder.BLKSIZE_s / 2 - 1; j >= 0; --j) {
                const re = ws[Encoder.BLKSIZE_s / 2 - j];
                const im = ws[Encoder.BLKSIZE_s / 2 + j];
                fe[Encoder.BLKSIZE_s / 2 - j] = (re * re + im * im) * 0.5;
            }
        }
        /* total energy */
        let totalenergy = 0.0;
        for (let j = 11; j < Encoder.HBLKSIZE; j++)
            totalenergy += fftenergy[j];
        gfc.tot_ener[chn] = totalenergy;

        /*********************************************************************
         * compute loudness approximation (used for ATH auto-level adjustment)
         *********************************************************************/
        gfc.loudness_sq[gr_out][chn] = gfc.loudness_sq_save[chn];
        gfc.loudness_sq_save[chn] = this.psycho_loudness_approx(fftenergy, gfc);
    }

    /* mask_add optimization */
    /* init the limit values used to avoid computing log in mask_add when it is not necessary */

    /**
     * <PRE>
     *  For example, with i = 10*log10(m2/m1)/10*16         (= log10(m2/m1)*16)
     *
     * abs(i)>8 is equivalent (as i is an integer) to
     * abs(i)>=9
     * i>=9 || i<=-9
     * equivalent to (as i is the biggest integer smaller than log10(m2/m1)*16
     * or the smallest integer bigger than log10(m2/m1)*16 depending on the sign of log10(m2/m1)*16)
     * log10(m2/m1)>=9/16 || log10(m2/m1)<=-9/16
     * exp10 is strictly increasing thus this is equivalent to
     * m2/m1 >= 10^(9/16) || m2/m1<=10^(-9/16) which are comparisons to constants
     * </PRE>
     */

    /**
     * as in if(i>8)
     */
    private static readonly I1LIMIT = 8;
    /**
     * as in if(i>24) . changed 23
     */
    private static readonly I2LIMIT = 23;
    /**
     * as in if(m<15)
     */
    private static readonly MLIMIT = 15;

    private ma_max_i1!: number;
    private ma_max_i2!: number;
    private ma_max_m!: number;

    /**
     * This is the masking table:<BR>
     * According to tonality, values are going from 0dB (TMN) to 9.3dB (NMT).<BR>
     * After additive masking computation, 8dB are added, so final values are
     * going from 8dB to 17.3dB
     *
     * pow(10, -0.0..-0.6)
     */
    private static readonly tab = [1.0, 0.79433, 0.63096, 0.63096,
        0.63096, 0.63096, 0.63096, 0.25119, 0.11749];

    private init_mask_add_max_values(): void {
        this.ma_max_i1 = Math.pow(10, (PsyModel.I1LIMIT + 1) / 16.0);
        this.ma_max_i2 = Math.pow(10, (PsyModel.I2LIMIT + 1) / 16.0);
        this.ma_max_m = Math.pow(10, (PsyModel.MLIMIT) / 10.0);
    }

    private static readonly table1 = [3.3246 * 3.3246,
        3.23837 * 3.23837, 3.15437 * 3.15437, 3.00412 * 3.00412,
        2.86103 * 2.86103, 2.65407 * 2.65407, 2.46209 * 2.46209,
        2.284 * 2.284, 2.11879 * 2.11879, 1.96552 * 1.96552,
        1.82335 * 1.82335, 1.69146 * 1.69146, 1.56911 * 1.56911,
        1.46658 * 1.46658, 1.37074 * 1.37074, 1.31036 * 1.31036,
        1.25264 * 1.25264, 1.20648 * 1.20648, 1.16203 * 1.16203,
        1.12765 * 1.12765, 1.09428 * 1.09428, 1.0659 * 1.0659,
        1.03826 * 1.03826, 1.01895 * 1.01895, 1];

    private static readonly table2 = [1.33352 * 1.33352,
        1.35879 * 1.35879, 1.38454 * 1.38454, 1.39497 * 1.39497,
        1.40548 * 1.40548, 1.3537 * 1.3537, 1.30382 * 1.30382,
        1.22321 * 1.22321, 1.14758 * 1.14758, 1];

    private static readonly table3 = [2.35364 * 2.35364,
        2.29259 * 2.29259, 2.23313 * 2.23313, 2.12675 * 2.12675,
        2.02545 * 2.02545, 1.87894 * 1.87894, 1.74303 * 1.74303,
        1.61695 * 1.61695, 1.49999 * 1.49999, 1.39148 * 1.39148,
        1.29083 * 1.29083, 1.19746 * 1.19746, 1.11084 * 1.11084,
        1.03826 * 1.03826];

    /**
     * addition of simultaneous masking Naoki Shibata 2000/7
     */
    private mask_add(m1: number, m2: number, kk: number, b: number, gfc: LameInternalFlags, shortblock: number): number {
        let ratio;

        if (m2 > m1) {
            if (m2 < (m1 * this.ma_max_i2))
                ratio = m2 / m1;
            else
                return (m1 + m2);
        } else {
            if (m1 >= (m2 * this.ma_max_i2))
                return (m1 + m2);
            ratio = m1 / m2;
        }

        /* Should always be true, just checking */

        m1 += m2;
        //if (((long)(b + 3) & 0xffffffff) <= 3 + 3) {
        if ((b + 3) <= 3 + 3) {
            /* approximately, 1 bark = 3 partitions */
            /* 65% of the cases */
            /* originally 'if(i > 8)' */
            if (ratio >= this.ma_max_i1) {
                /* 43% of the total */
                return m1;
            }

            /* 22% of the total */
            const i = 0 | ((Math.log10(ratio) * 16.0));
            return m1 * PsyModel.table2[i];
        }

        /**
         * <PRE>
         * m<15 equ log10((m1+m2)/gfc.ATH!.cb[k])<1.5
         * equ (m1+m2)/gfc.ATH!.cb[k]<10^1.5
         * equ (m1+m2)<10^1.5 * gfc.ATH!.cb[k]
         * </PRE>
         */
        const i = 0 | (Math.log10(ratio) * 16.0);
        if (shortblock != 0) {
            m2 = gfc.ATH!.cb_s[kk] * gfc.ATH!.adjust;
        } else {
            m2 = gfc.ATH!.cb_l[kk] * gfc.ATH!.adjust;
        }
        if (m1 < this.ma_max_m * m2) {
            /* 3% of the total */
            /* Originally if (m > 0) { */
            if (m1 > m2) {
                let f, r;

                f = 1.0;
                if (i <= 13)
                    f = PsyModel.table3[i];

                r = Math.log10(m1 / m2) * (10.0 / 15.0);
                return m1 * ((PsyModel.table1[i] - f) * r + f);
            }

            if (i > 13)
                return m1;

            return m1 * PsyModel.table3[i];
        }

        /* 10% of total */
        return m1 * PsyModel.table1[i];
    }

    /**
     * addition of simultaneous masking Naoki Shibata 2000/7
     */

    /**
     * compute interchannel masking effects
     */
    private calc_interchannel_masking(gfp: LameGlobalFlags, ratio: number): void {
        const gfc = gfp.internal_flags!;
        if (gfc.channels_out > 1) {
            for (let sb = 0; sb < Encoder.SBMAX_l; sb++) {
                const l = gfc.thm[0].l[sb];
                const r = gfc.thm[1].l[sb];
                gfc.thm[0].l[sb] += r * ratio;
                gfc.thm[1].l[sb] += l * ratio;
            }
            for (let sb = 0; sb < Encoder.SBMAX_s; sb++) {
                for (let sblock = 0; sblock < 3; sblock++) {
                    const l = gfc.thm[0].s[sb][sblock];
                    const r = gfc.thm[1].s[sb][sblock];
                    gfc.thm[0].s[sb][sblock] += r * ratio;
                    gfc.thm[1].s[sb][sblock] += l * ratio;
                }
            }
        }
    }

    /**
     * compute M/S thresholds from Johnston & Ferreira 1992 ICASSP paper
     */

    /**
     * Adjust M/S maskings if user set "msfix"
     *
     * Naoki Shibata 2000
     */

    /**
     * short block threshold calculation (part 2)
     *
     * partition band bo_s[sfb] is at the transition from scalefactor band sfb
     * to the next one sfb+1; enn and thmm have to be split between them
     */
    private convert_partition2scalefac_s(gfc: LameInternalFlags, eb: Float32Array, thr: Float32Array, chn: number, sblock: number): void {
        let sb, b;
        let enn = 0.0;
        let thmm = 0.0;
        for (sb = b = 0; sb < Encoder.SBMAX_s; ++b, ++sb) {
            const bo_s_sb = gfc.bo_s[sb];
            const npart_s = gfc.npart_s;
            const b_lim = bo_s_sb < npart_s ? bo_s_sb : npart_s;
            while (b < b_lim) {
                // iff failed, it may indicate some index error elsewhere
                enn += eb[b];
                thmm += thr[b];
                b++;
            }
            gfc.en[chn].s[sb][sblock] = enn;
            gfc.thm[chn].s[sb][sblock] = thmm;

            if (b >= npart_s) {
                ++sb;
                break;
            }
            // iff failed, it may indicate some index error elsewhere
            {
                /* at transition sfb . sfb+1 */
                const w_curr = gfc.PSY!.bo_s_weight[sb];
                const w_next = 1.0 - w_curr;
                enn = w_curr * eb[b];
                thmm = w_curr * thr[b];
                gfc.en[chn].s[sb][sblock] += enn;
                gfc.thm[chn].s[sb][sblock] += thmm;
                enn = w_next * eb[b];
                thmm = w_next * thr[b];
            }
        }
        /* zero initialize the rest */
        for (; sb < Encoder.SBMAX_s; ++sb) {
            gfc.en[chn].s[sb][sblock] = 0;
            gfc.thm[chn].s[sb][sblock] = 0;
        }
    }

    /**
     * longblock threshold calculation (part 2)
     */
    private convert_partition2scalefac_l(gfc: LameInternalFlags, eb: Float32Array, thr: Float32Array, chn: number): void {
        let sb, b;
        let enn = 0.0;
        let thmm = 0.0;
        for (sb = b = 0; sb < Encoder.SBMAX_l; ++b, ++sb) {
            const bo_l_sb = gfc.bo_l[sb];
            const npart_l = gfc.npart_l;
            const b_lim = bo_l_sb < npart_l ? bo_l_sb : npart_l;
            while (b < b_lim) {
                // iff failed, it may indicate some index error elsewhere
                enn += eb[b];
                thmm += thr[b];
                b++;
            }
            gfc.en[chn].l[sb] = enn;
            gfc.thm[chn].l[sb] = thmm;

            if (b >= npart_l) {
                ++sb;
                break;
            }
            {
                /* at transition sfb . sfb+1 */
                const w_curr = gfc.PSY!.bo_l_weight[sb];
                const w_next = 1.0 - w_curr;
                enn = w_curr * eb[b];
                thmm = w_curr * thr[b];
                gfc.en[chn].l[sb] += enn;
                gfc.thm[chn].l[sb] += thmm;
                enn = w_next * eb[b];
                thmm = w_next * thr[b];
            }
        }
        /* zero initialize the rest */
        for (; sb < Encoder.SBMAX_l; ++sb) {
            gfc.en[chn].l[sb] = 0;
            gfc.thm[chn].l[sb] = 0;
        }
    }

    private compute_masking_s(gfc: LameInternalFlags, fftenergy_s: Float32Array[], eb: Float32Array, thr: Float32Array, chn: number, sblock: number): void {
        let j, b;

        for (b = j = 0; b < gfc.npart_s; ++b) {
            let ebb = 0, m = 0;
            const n = gfc.numlines_s[b];
            for (let i = 0; i < n; ++i, ++j) {
                const el = fftenergy_s[sblock][j];
                ebb += el;
                if (m < el)
                    m = el;
            }
            eb[b] = ebb;
        }
        for (j = b = 0; b < gfc.npart_s; b++) {
            let kk = gfc.s3ind_s[b][0];
            let ecb = gfc.s3_ss![j++] * eb[kk];
            ++kk;
            while (kk <= gfc.s3ind_s[b][1]) {
                ecb += gfc.s3_ss![j] * eb[kk];
                ++j;
                ++kk;
            }

            { /* limit calculated threshold by previous granule */
                const x = PsyModel.rpelev_s * gfc.nb_s1[chn][b];
                thr[b] = Math.min(ecb, x);
            }
            if (gfc.blocktype_old[chn & 1] == Encoder.SHORT_TYPE) {
                /* limit calculated threshold by even older granule */
                const x = PsyModel.rpelev2_s * gfc.nb_s2[chn][b];
                const y = thr[b];
                thr[b] = Math.min(x, y);
            }

            gfc.nb_s2[chn][b] = gfc.nb_s1[chn][b];
            gfc.nb_s1[chn][b] = ecb;
        }
        for (; b <= Encoder.CBANDS; ++b) {
            eb[b] = 0;
            thr[b] = 0;
        }
    }

    private block_type_set(gfp: LameGlobalFlags, uselongblock: Int32Array, blocktype_d: Int32Array, blocktype: Int32Array): void {
        const gfc = gfp.internal_flags!;

        if (gfp.short_blocks == ShortBlock.short_block_coupled
                /* force both channels to use the same block type */
                /* this is necessary if the frame is to be encoded in ms_stereo. */
                /* But even without ms_stereo, FhG does this */
            && !(uselongblock[0] != 0 && uselongblock[1] != 0))
            uselongblock[0] = uselongblock[1] = 0;

        /*
         * update the blocktype of the previous granule, since it depends on
         * what happend in this granule
         */
        for (let chn = 0; chn < gfc.channels_out; chn++) {
            blocktype[chn] = Encoder.NORM_TYPE;
            if (uselongblock[chn] != 0) {
                /* no attack : use long blocks */
                if (gfc.blocktype_old[chn] == Encoder.SHORT_TYPE)
                    blocktype[chn] = Encoder.STOP_TYPE;
            } else {
                /* attack : use short blocks */
                blocktype[chn] = Encoder.SHORT_TYPE;
                if (gfc.blocktype_old[chn] == Encoder.NORM_TYPE) {
                    gfc.blocktype_old[chn] = Encoder.START_TYPE;
                }
                if (gfc.blocktype_old[chn] == Encoder.STOP_TYPE)
                    gfc.blocktype_old[chn] = Encoder.SHORT_TYPE;
            }

            blocktype_d[chn] = gfc.blocktype_old[chn];
            // value returned to calling program
            gfc.blocktype_old[chn] = blocktype[chn];
            // save for next call to l3psy_anal
        }
    }

    /**
     * these values are tuned only for 44.1kHz...
     */
    private static readonly regcoef_s = [11.8, 13.6, 17.2, 32, 46.5,
        51.3, 57.5, 67.1, 71.5, 84.6, 97.6, 130,
        /* 255.8 */
    ];

    private pecalc_s(mr: III_psy_ratio, masking_lower: number): number {
        let pe_s = 1236.28 / 4;
        for (let sb = 0; sb < Encoder.SBMAX_s - 1; sb++) {
            for (let sblock = 0; sblock < 3; sblock++) {
                const thm = mr.thm.s[sb][sblock];
                if (thm > 0.0) {
                    const x = thm * masking_lower;
                    const en = mr.en.s[sb][sblock];
                    if (en > x) {
                        if (en > x * 1e10) {
                            pe_s += PsyModel.regcoef_s[sb] * (10.0 * PsyModel.LOG10);
                        } else {
                            pe_s += PsyModel.regcoef_s[sb] * Math.log10(en / x);
                        }
                    }
                }
            }
        }

        return pe_s;
    }

    /**
     * these values are tuned only for 44.1kHz...
     */
    private static readonly regcoef_l = [6.8, 5.8, 5.8, 6.4, 6.5, 9.9,
        12.1, 14.4, 15, 18.9, 21.6, 26.9, 34.2, 40.2, 46.8, 56.5,
        60.7, 73.9, 85.7, 93.4, 126.1,
        /* 241.3 */
    ];

    private pecalc_l(mr: III_psy_ratio, masking_lower: number): number {
        let pe_l = 1124.23 / 4;
        for (let sb = 0; sb < Encoder.SBMAX_l - 1; sb++) {
            const thm = mr.thm.l[sb];
            if (thm > 0.0) {
                const x = thm * masking_lower;
                const en = mr.en.l[sb];
                if (en > x) {
                    if (en > x * 1e10) {
                        pe_l += PsyModel.regcoef_l[sb] * (10.0 * PsyModel.LOG10);
                    } else {
                        pe_l += PsyModel.regcoef_l[sb] * Math.log10(en / x);
                    }
                }
            }
        }
        return pe_l;
    }

    private calc_energy(gfc: LameInternalFlags, fftenergy: Float32Array, eb: Float32Array, max: Float32Array, avg: Float32Array): void {
        let b, j;

        for (b = j = 0; b < gfc.npart_l; ++b) {
            let ebb = 0, m = 0;
            let i;
            for (i = 0; i < gfc.numlines_l[b]; ++i, ++j) {
                const el = fftenergy[j];
                ebb += el;
                if (m < el)
                    m = el;
            }
            eb[b] = ebb;
            max[b] = m;
            avg[b] = ebb * gfc.rnumlines_l[b];
        }
    }

    private calc_mask_index_l(gfc: LameInternalFlags, max: Float32Array, avg: Float32Array, mask_idx: Int32Array): void {
        const last_tab_entry = PsyModel.tab.length - 1;
        let b = 0;
        let a = avg[b] + avg[b + 1];
        if (a > 0.0) {
            let m = max[b];
            if (m < max[b + 1])
                m = max[b + 1];
            a = 20.0 * (m * 2.0 - a)
                / (a * (gfc.numlines_l[b] + gfc.numlines_l[b + 1] - 1));
            let k = 0 | a;
            if (k > last_tab_entry)
                k = last_tab_entry;
            mask_idx[b] = k;
        } else {
            mask_idx[b] = 0;
        }

        for (b = 1; b < gfc.npart_l - 1; b++) {
            a = avg[b - 1] + avg[b] + avg[b + 1];
            if (a > 0.0) {
                let m = max[b - 1];
                if (m < max[b])
                    m = max[b];
                if (m < max[b + 1])
                    m = max[b + 1];
                a = 20.0
                    * (m * 3.0 - a)
                    / (a * (gfc.numlines_l[b - 1] + gfc.numlines_l[b]
                    + gfc.numlines_l[b + 1] - 1));
                let k = 0 | a;
                if (k > last_tab_entry)
                    k = last_tab_entry;
                mask_idx[b] = k;
            } else {
                mask_idx[b] = 0;
            }
        }

        a = avg[b - 1] + avg[b];
        if (a > 0.0) {
            let m = max[b - 1];
            if (m < max[b])
                m = max[b];
            a = 20.0 * (m * 2.0 - a)
                / (a * (gfc.numlines_l[b - 1] + gfc.numlines_l[b] - 1));
            let k = 0 | a;
            if (k > last_tab_entry)
                k = last_tab_entry;
            mask_idx[b] = k;
        } else {
            mask_idx[b] = 0;
        }
    }

    private static readonly fircoef = [
        -8.65163e-18 * 2, -0.00851586 * 2, -6.74764e-18 * 2, 0.0209036 * 2,
        -3.36639e-17 * 2, -0.0438162 * 2, -1.54175e-17 * 2, 0.0931738 * 2,
        -5.52212e-17 * 2, -0.313819 * 2
    ];

    L3psycho_anal_ns(gfp: LameGlobalFlags, buffer: ArrayLike<number>[], bufPos: number, gr_out: number, masking_ratio: III_psy_ratio[][], percep_entropy: number[], energy: Float32Array, blocktype_d: Int32Array): void {
        const gfc = gfp.internal_flags!;
        const numchn = gfc.channels_out;
        const s = this.scratch;

        /* block type */
        const blocktype = s.blocktype, uselongblock = s.uselongblock;
        const ns_hpfsmpl = s.ns_hpfsmpl;
        const eb_l = s.eb_l, eb_s = s.eb_s, thr = s.thr, mask_idx_l = s.mask_idx_l;

        /*
         * LAME scales the pre-echo control by pcfact = ResvSize / ResvMax / 2.
         * The bit reservoir is disabled (ResvMax is 0), so pcfact is 0 and
         * NS_INTERP(x, y, 0) is y: that control is a no-op and is left out.
         */

        /**********************************************************************
         * Apply HPF of fs/4 to the input signal. This is used for attack
         * detection / handling.
         **********************************************************************/
        const fircoef = PsyModel.fircoef;
        for (let chn = 0; chn < numchn; chn++) {
            /* apply high pass filter of fs/4 */
            const firbuf = buffer[chn];
            const firbufPos = bufPos + 576 - 350 - PsyModel.NSFIRLEN + 192;
            const out = ns_hpfsmpl[chn];
            for (let i = 0; i < 576; i++) {
                const p = firbufPos + i;
                let sum1 = firbuf[p + 10];
                let sum2 = 0.0;
                for (let j = 0; j < ((PsyModel.NSFIRLEN - 1) / 2) - 1; j += 2) {
                    sum1 += fircoef[j] * (firbuf[p + j] + firbuf[p + PsyModel.NSFIRLEN - j]);
                    sum2 += fircoef[j + 1] * (firbuf[p + j + 1] + firbuf[p + PsyModel.NSFIRLEN - j - 1]);
                }
                out[i] = sum1 + sum2;
            }
            masking_ratio[gr_out][chn].en.assign(gfc.en[chn]);
            masking_ratio[gr_out][chn].thm.assign(gfc.thm[chn]);
        }

        for (let chn = 0; chn < numchn; chn++) {
            const en_subshort = s.en_subshort;
            const en_short = [0, 0, 0, 0];
            const attack_intensity = s.attack_intensity;
            let ns_uselongblock = 1;
            const ns_attacks = [0, 0, 0, 0];
            const fftenergy = s.fftenergy, fftenergy_s = s.fftenergy_s;
            const last_en_subshort = gfc.nsPsy.last_en_subshort[chn];

            /***************************************************************
             * determine the block type (window type)
             ***************************************************************/
            /* calculate energies of each sub-shortblocks */
            for (let i = 0; i < 3; i++) {
                en_subshort[i] = last_en_subshort[i + 6];
                attack_intensity[i] = en_subshort[i] / last_en_subshort[i + 4];
                en_short[0] += en_subshort[i];
            }

            {
                const pf = ns_hpfsmpl[chn];
                let pfPos = 0;
                for (let i = 0; i < 9; i++) {
                    const pfe = pfPos + 576 / 9;
                    let p = 1.;
                    for (; pfPos < pfe; pfPos++)
                        if (p < Math.abs(pf[pfPos]))
                            p = Math.abs(pf[pfPos]);

                    last_en_subshort[i] = en_subshort[i + 3] = p;
                    // Upstream wrote en_short[1 + i / 3] without integer division; only whole
                    // indices land in the array, so only every third sub-block counts.
                    if (i % 3 == 0)
                        en_short[1 + i / 3] += p;
                    if (p > en_subshort[i + 3 - 2]) {
                        p = p / en_subshort[i + 3 - 2];
                    } else if (en_subshort[i + 3 - 2] > p * 10.0) {
                        p = en_subshort[i + 3 - 2] / (p * 10.0);
                    } else
                        p = 0.0;
                    attack_intensity[i + 3] = p;
                }
            }

            /* compare energies between sub-shortblocks */
            // Same upstream division bug as above: ns_attacks[i / 3] was only ever set for i % 3 == 0.
            for (let i = 0; i < 12; i += 3)
                if (attack_intensity[i] > gfc.nsPsy.attackthre)
                    ns_attacks[i / 3] = 1;

            /*
             * should have energy change between short blocks, in order to avoid
             * periodic signals
             */
            for (let i = 1; i < 4; i++) {
                const ratio = en_short[i - 1] > en_short[i]
                    ? en_short[i - 1] / en_short[i]
                    : en_short[i] / en_short[i - 1];
                if (ratio < 1.7) {
                    ns_attacks[i] = 0;
                    if (i == 1)
                        ns_attacks[0] = 0;
                }
            }

            if (ns_attacks[0] != 0 && gfc.nsPsy.lastAttacks[chn] != 0)
                ns_attacks[0] = 0;

            if (gfc.nsPsy.lastAttacks[chn] == 3
                || (ns_attacks[0] + ns_attacks[1] + ns_attacks[2] + ns_attacks[3]) != 0) {
                ns_uselongblock = 0;

                if (ns_attacks[1] != 0 && ns_attacks[0] != 0)
                    ns_attacks[1] = 0;
                if (ns_attacks[2] != 0 && ns_attacks[1] != 0)
                    ns_attacks[2] = 0;
                if (ns_attacks[3] != 0 && ns_attacks[2] != 0)
                    ns_attacks[3] = 0;
            }

            uselongblock[chn] = ns_uselongblock;

            /*
             * there is a one granule delay. Copy maskings computed last call
             * into masking_ratio to return to calling program.
             */
            energy[chn] = gfc.tot_ener[chn];

            /*********************************************************************
             * compute FFTs
             *********************************************************************/
            this.compute_ffts(gfc, fftenergy, fftenergy_s, s.wsamp_L[chn], s.wsamp_S[chn], gr_out, chn, buffer, bufPos);

            /*********************************************************************
             * Calculate the energy and the tonality of each partition.
             *********************************************************************/
            this.calc_energy(gfc, fftenergy, eb_l, s.max, s.avg);
            this.calc_mask_index_l(gfc, s.max, s.avg, mask_idx_l);
            /* compute masking thresholds for short blocks */
            const thm_s = gfc.thm[chn].s;
            for (let sblock = 0; sblock < 3; sblock++) {
                this.compute_masking_s(gfc, fftenergy_s, eb_s, thr, chn, sblock);
                this.convert_partition2scalefac_s(gfc, eb_s, thr, chn, sblock);
                /**** short block pre-echo control ****/
                for (let sb = 0; sb < Encoder.SBMAX_s; sb++) {
                    let thmm = thm_s[sb][sblock];

                    thmm *= PsyModel.NS_PREECHO_ATT0;

                    /* pulse like signal detection for fatboy.wav and so on */
                    const enn = en_subshort[sblock * 3 + 3] + en_subshort[sblock * 3 + 4] + en_subshort[sblock * 3 + 5];
                    if (en_subshort[sblock * 3 + 5] * 6 < enn) {
                        thmm *= 0.5;
                        if (en_subshort[sblock * 3 + 4] * 6 < enn)
                            thmm *= 0.5;
                    }

                    thm_s[sb][sblock] = thmm;
                }
            }
            gfc.nsPsy.lastAttacks[chn] = ns_attacks[2];

            /*********************************************************************
             * convolve the partitioned energy and unpredictability with the
             * spreading function, s3_l[b][k]
             ********************************************************************/
            const s3_ll = gfc.s3_ll!, tab = PsyModel.tab;
            let k = 0, b;
            for (b = 0; b < gfc.npart_l; b++) {
                /* convolve the partitioned energy with the spreading function */
                let kk = gfc.s3ind[b][0];
                const last = gfc.s3ind[b][1];
                let ecb = s3_ll[k++] * (eb_l[kk] * tab[mask_idx_l[kk]]);
                while (++kk <= last)
                    ecb = this.mask_add(ecb, s3_ll[k++] * (eb_l[kk] * tab[mask_idx_l[kk]]), kk, kk - b, gfc, 0);
                /* pow(10,-0.8); long block pre-echo control is off (pcfact is 0) */
                thr[b] = ecb * 0.158489319246111;
            }
            eb_l.fill(0, b);
            thr.fill(0, b, Encoder.CBANDS + 1);
            /* compute masking thresholds for long blocks */
            this.convert_partition2scalefac_l(gfc, eb_l, thr, chn);
        }
        /* end loop over chn */

        if (numchn == 2 && gfp.interChRatio > 0.0)
            this.calc_interchannel_masking(gfp, gfp.interChRatio);

        /***************************************************************
         * determine final block type
         ***************************************************************/
        this.block_type_set(gfp, uselongblock, blocktype_d, blocktype);

        /*********************************************************************
         * compute the value of PE to return ... no delay and advance
         *********************************************************************/
        for (let chn = 0; chn < numchn; chn++) {
            const mr = masking_ratio[gr_out][chn];
            percep_entropy[chn] = blocktype_d[chn] == Encoder.SHORT_TYPE
                ? this.pecalc_s(mr, gfc.masking_lower)
                : this.pecalc_l(mr, gfc.masking_lower);
        }
    }

    /**
     * Apply HPF of fs/4 to the input signal. This is used for attack detection
     * / handling.
     */

    /**
     * compute M/S thresholds from Johnston & Ferreira 1992 ICASSP paper
     */

    /**
     *   The spreading function.  Values returned in units of energy
     */
    private s3_func(bark: number): number {
        let tempx, x, tempy, temp;
        tempx = bark;
        if (tempx >= 0)
            tempx *= 3;
        else
            tempx *= 1.5;

        if (tempx >= 0.5 && tempx <= 2.5) {
            temp = tempx - 0.5;
            x = 8.0 * (temp * temp - 2.0 * temp);
        } else
            x = 0.0;
        tempx += 0.474;
        tempy = 15.811389 + 7.5 * tempx - 17.5
            * Math.sqrt(1.0 + tempx * tempx);

        if (tempy <= -60.0)
            return 0.0;

        tempx = Math.exp((x + tempy) * PsyModel.LN_TO_LOG10);

        /**
         * <PRE>
         * Normalization.  The spreading function should be normalized so that:
         * +inf
         * /
         * |  s3 [ bark ]  d(bark)   =  1
         * /
         * -inf
         * </PRE>
         */
        tempx /= .6609193;
        return tempx;
    }

    /**
     * see for example "Zwicker: Psychoakustik, 1982; ISBN 3-540-11401-7
     */
    private freq2bark(freq: number): number {
        /* input: freq in hz output: barks */
        if (freq < 0)
            freq = 0;
        freq = freq * 0.001;
        return 13.0 * Math.atan(.76 * freq) + 3.5
            * Math.atan(freq * freq / (7.5 * 7.5));
    }

    private init_numline(numlines: Int32Array, bo: Int32Array, bval: Float32Array, bval_width: Float32Array, bo_w: Float32Array, sfreq: number, blksize: number, scalepos: Int32Array, deltafreq: number, sbmax: number): number {
        const b_frq = new Float32Array(Encoder.CBANDS + 1);
        const sample_freq_frac = sfreq / (sbmax > 15 ? 2 * 576 : 2 * 192);
        const partition = new Int32Array(Encoder.HBLKSIZE);
        let i;
        sfreq /= blksize;
        let j = 0;
        let ni = 0;
        /* compute numlines, the number of spectral lines in each partition band */
        /* each partition band should be about DELBARK wide. */
        for (i = 0; i < Encoder.CBANDS; i++) {
            let bark1;
            let j2;
            bark1 = this.freq2bark(sfreq * j);

            b_frq[i] = sfreq * j;

            for (j2 = j; this.freq2bark(sfreq * j2) - bark1 < PsyModel.DELBARK
            && j2 <= blksize / 2; j2++)
                ;

            numlines[i] = j2 - j;
            ni = i + 1;

            while (j < j2) {
                partition[j++] = i;
            }
            if (j > blksize / 2) {
                j = blksize / 2;
                ++i;
                break;
            }
        }
        b_frq[i] = sfreq * j;

        for (let sfb = 0; sfb < sbmax; sfb++) {
            let i2, end;
            end = scalepos[sfb + 1];

            i2 = 0 | Math.floor(.5 + deltafreq * (end - .5));

            if (i2 > blksize / 2)
                i2 = blksize / 2;

            bo[sfb] = partition[i2];
            const f_tmp = sample_freq_frac * end;
            /*
             * calculate how much of this band belongs to current scalefactor
             * band
             */
            bo_w[sfb] = (f_tmp - b_frq[bo[sfb]])
                / (b_frq[bo[sfb] + 1] - b_frq[bo[sfb]]);
            if (bo_w[sfb] < 0) {
                bo_w[sfb] = 0;
            } else {
                if (bo_w[sfb] > 1) {
                    bo_w[sfb] = 1;
                }
            }
        }

        /* compute bark values of each critical band */
        j = 0;
        for (let k = 0; k < ni; k++) {
            const w = numlines[k];
            let bark1, bark2;

            bark1 = this.freq2bark(sfreq * (j));
            bark2 = this.freq2bark(sfreq * (j + w - 1));
            bval[k] = .5 * (bark1 + bark2);

            bark1 = this.freq2bark(sfreq * (j - .5));
            bark2 = this.freq2bark(sfreq * (j + w - .5));
            bval_width[k] = bark2 - bark1;
            j += w;
        }

        return ni;
    }

    private init_s3_values(s3ind: Int32Array[], npart: number, bval: Float32Array, bval_width: Float32Array, norm: Float32Array): Float32Array {
        const s3 = new_float_n([Encoder.CBANDS, Encoder.CBANDS]);
        /*
         * The s3 array is not linear in the bark scale.
         *
         * bval[x] should be used to get the bark value.
         */
        let j;
        let numberOfNoneZero = 0;

        /**
         * <PRE>
         * s[i][j], the value of the spreading function,
         * centered at band j (masker), for band i (maskee)
         *
         * i.e.: sum over j to spread into signal barkval=i
         * NOTE: i and j are used opposite as in the ISO docs
         * </PRE>
         */
        for (let i = 0; i < npart; i++) {
            for (j = 0; j < npart; j++) {
                const v = this.s3_func(bval[i] - bval[j]) * bval_width[j];
                s3[i][j] = v * norm[i];
            }
        }
        for (let i = 0; i < npart; i++) {
            for (j = 0; j < npart; j++) {
                if (s3[i][j] > 0.0)
                    break;
            }
            s3ind[i][0] = j;

            for (j = npart - 1; j > 0; j--) {
                if (s3[i][j] > 0.0)
                    break;
            }
            s3ind[i][1] = j;
            numberOfNoneZero += (s3ind[i][1] - s3ind[i][0] + 1);
        }

        const p = new Float32Array(numberOfNoneZero);
        let k = 0;
        for (let i = 0; i < npart; i++)
            for (j = s3ind[i][0]; j <= s3ind[i][1]; j++)
                p[k++] = s3[i][j];

        return p;
    }

    /**
     * NOTE: the bitrate reduction from the inter-channel masking effect is low
     * compared to the chance of getting annyoing artefacts. L3psycho_anal_vbr
     * does not use this feature. (Robert 071216)
     */
    psymodel_init(gfp: LameGlobalFlags): number {
        const gfc = gfp.internal_flags!;
        let i;
        const bvl_a = 13, bvl_b = 24;
        const snr_l_a = 0, snr_l_b = 0;
        const snr_s_a = -8.25, snr_s_b = -4.5;
        const bval = new Float32Array(Encoder.CBANDS);
        const bval_width = new Float32Array(Encoder.CBANDS);
        const norm = new Float32Array(Encoder.CBANDS);
        const sfreq = gfp.out_samplerate;

        gfc.blocktype_old[0] = gfc.blocktype_old[1] = Encoder.NORM_TYPE;
        // the vbr header is long blocks

        for (i = 0; i < 4; ++i) {
            for (let j = 0; j < Encoder.CBANDS; ++j) {
                gfc.nb_s1[i][j] = gfc.nb_s2[i][j] = 1.0;
            }
            for (let sb = 0; sb < Encoder.SBMAX_l; sb++) {
                gfc.en[i].l[sb] = 1e20;
                gfc.thm[i].l[sb] = 1e20;
            }
            for (let j = 0; j < 3; ++j) {
                for (let sb = 0; sb < Encoder.SBMAX_s; sb++) {
                    gfc.en[i].s[sb][j] = 1e20;
                    gfc.thm[i].s[sb][j] = 1e20;
                }
                gfc.nsPsy.lastAttacks[i] = 0;
            }
            for (let j = 0; j < 9; j++)
                gfc.nsPsy.last_en_subshort[i][j] = 10.;
        }

        /* init. for loudness approx. -jd 2001 mar 27 */
        gfc.loudness_sq_save[0] = gfc.loudness_sq_save[1] = 0.0;

        /*************************************************************************
         * now compute the psychoacoustic model specific constants
         ************************************************************************/
        /* compute numlines, bo, bm, bval, bval_width, mld */

        gfc.npart_l = this.init_numline(gfc.numlines_l, gfc.bo_l, bval,
            bval_width, gfc.PSY!.bo_l_weight, sfreq,
            Encoder.BLKSIZE, gfc.scalefac_band.l, Encoder.BLKSIZE
            / (2.0 * 576), Encoder.SBMAX_l);
        /* compute the spreading function */
        for (i = 0; i < gfc.npart_l; i++) {
            let snr = snr_l_a;
            if (bval[i] >= bvl_a) {
                snr = snr_l_b * (bval[i] - bvl_a) / (bvl_b - bvl_a) + snr_l_a
                    * (bvl_b - bval[i]) / (bvl_b - bvl_a);
            }
            norm[i] = Math.pow(10.0, snr / 10.0);
            if (gfc.numlines_l[i] > 0) {
                gfc.rnumlines_l[i] = 1.0 / gfc.numlines_l[i];
            } else {
                gfc.rnumlines_l[i] = 0;
            }
        }
        gfc.s3_ll = this.init_s3_values(gfc.s3ind, gfc.npart_l, bval, bval_width,
            norm);

        /* compute long block specific values, ATH and MINVAL */
        let j = 0;
        for (i = 0; i < gfc.npart_l; i++) {
            let x;

            /* ATH */
            x = 3.4028235e+38;
            for (let k = 0; k < gfc.numlines_l[i]; k++, j++) {
                const freq = sfreq * j / (1000.0 * Encoder.BLKSIZE);
                let level;
                /*
                 * ATH below 100 Hz constant, not further climbing
                 */
                level = this.ATHformula(freq * 1000, gfp) - 20;
                // scale to FFT units; returned value is in dB
                level = Math.pow(10., 0.1 * level);
                // convert from dB . energy
                level *= gfc.numlines_l[i];
                if (x > level)
                    x = level;
            }
            gfc.ATH!.cb_l[i] = x;
        }

        /************************************************************************
         * do the same things for short blocks
         ************************************************************************/
        gfc.npart_s = this.init_numline(gfc.numlines_s, gfc.bo_s, bval,
            bval_width, gfc.PSY!.bo_s_weight, sfreq,
            Encoder.BLKSIZE_s, gfc.scalefac_band.s, Encoder.BLKSIZE_s
            / (2.0 * 192), Encoder.SBMAX_s);

        /* SNR formula. short block is normalized by SNR. is it still right ? */
        j = 0;
        for (i = 0; i < gfc.npart_s; i++) {
            let x;
            let snr = snr_s_a;
            if (bval[i] >= bvl_a) {
                snr = snr_s_b * (bval[i] - bvl_a) / (bvl_b - bvl_a) + snr_s_a
                    * (bvl_b - bval[i]) / (bvl_b - bvl_a);
            }
            norm[i] = Math.pow(10.0, snr / 10.0);

            /* ATH */
            x = 3.4028235e+38;
            for (let k = 0; k < gfc.numlines_s[i]; k++, j++) {
                const freq = sfreq * j / (1000.0 * Encoder.BLKSIZE_s);
                let level;
                /* freq = Min(.1,freq); */
                /*
                 * ATH below 100 Hz constant, not
                 * further climbing
                 */
                level = this.ATHformula(freq * 1000, gfp) - 20;
                // scale to FFT units; returned value is in dB
                level = Math.pow(10., 0.1 * level);
                // convert from dB . energy
                level *= gfc.numlines_s[i];
                if (x > level)
                    x = level;
            }
            gfc.ATH!.cb_s[i] = x;
        }

        gfc.s3_ss = this.init_s3_values(gfc.s3ind_s, gfc.npart_s, bval, bval_width,
            norm);

        this.init_mask_add_max_values();
        this.fft.init_fft(gfc);

        /* setup temporal masking */
        gfc.decay = Math.exp(-1.0 * PsyModel.LOG10
            / (PsyModel.temporalmask_sustain_sec * sfreq / 192.0));

        {
            /*
             * spread only from npart_l bands. Normally, we use the spreading
             * function to convolve from npart_l down to npart_l bands
             */
            for (let b = 0; b < gfc.npart_l; b++)
                if (gfc.s3ind[b][1] > gfc.npart_l - 1)
                    gfc.s3ind[b][1] = gfc.npart_l - 1;
        }

        /*
         * prepare for ATH auto adjustment: we want to decrease the ATH by 12 dB
         * per second
         */
        const frame_duration = (576. * gfc.mode_gr / sfreq);
        gfc.ATH!.decay = Math.pow(10., -12. / 10. * frame_duration);
        gfc.ATH!.adjust = 0.01;
        /* minimum, for leading low loudness */
        gfc.ATH!.adjustLimit = 1.0;
        /* on lead, allow adjust up to maximum */

        {
            /* compute equal loudness weights (eql_w) */
            let freq;
            const freq_inc = gfp.out_samplerate
                / (Encoder.BLKSIZE);
            let eql_balance = 0.0;
            freq = 0.0;
            for (i = 0; i < Encoder.BLKSIZE / 2; ++i) {
                /* convert ATH dB to relative power (not dB) */
                /* to determine eql_w */
                freq += freq_inc;
                gfc.ATH!.eql_w[i] = 1. / Math.pow(10, this.ATHformula(freq, gfp) / 10);
                eql_balance += gfc.ATH!.eql_w[i];
            }
            eql_balance = 1.0 / eql_balance;
            for (i = Encoder.BLKSIZE / 2; --i >= 0;) { /* scale weights */
                gfc.ATH!.eql_w[i] *= eql_balance;
            }
        }
        {
            for (let b = j = 0; b < gfc.npart_s; ++b) {
                for (i = 0; i < gfc.numlines_s[b]; ++i) {
                    ++j;
                }
            }
            for (let b = j = 0; b < gfc.npart_l; ++b) {
                for (i = 0; i < gfc.numlines_l[b]; ++i) {
                    ++j;
                }
            }
        }
        return 0;
    }

    /**
     * Those ATH formulas are returning their minimum value for input = -1
     */
    private ATHformula_GB(f: number, value: number): number {
        /**
         * <PRE>
         *  from Painter & Spanias
         *           modified by Gabriel Bouvigne to better fit the reality
         *           ath =    3.640 * pow(f,-0.8)
         *           - 6.800 * exp(-0.6*pow(f-3.4,2.0))
         *           + 6.000 * exp(-0.15*pow(f-8.7,2.0))
         *           + 0.6* 0.001 * pow(f,4.0);
         *
         *
         *           In the past LAME was using the Painter &Spanias formula.
         *           But we had some recurrent problems with HF content.
         *           We measured real ATH values, and found the older formula
         *           to be inaccurate in the higher part. So we made this new
         *           formula and this solved most of HF problematic test cases.
         *           The tradeoff is that in VBR mode it increases a lot the
         *           bitrate.
         * </PRE>
         */

        /*
         * This curve can be adjusted according to the VBR scale: it adjusts
         * from something close to Painter & Spanias on V9 up to Bouvigne's
         * formula for V0. This way the VBR bitrate is more balanced according
         * to the -V value.
         */

        // the following Hack allows to ask for the lowest value
        if (f < -.3)
            f = 3410;

        // convert to khz
        f /= 1000;
        f = Math.max(0.1, f);
        const ath = 3.640 * Math.pow(f, -0.8) - 6.800
            * Math.exp(-0.6 * Math.pow(f - 3.4, 2.0)) + 6.000
            * Math.exp(-0.15 * Math.pow(f - 8.7, 2.0))
            + (0.6 + 0.04 * value) * 0.001 * Math.pow(f, 4.0);
        return ath;
    }

    ATHformula(f: number, gfp: LameGlobalFlags): number {
        return this.ATHformula_GB(f, gfp.ATHcurve);
    }

}
