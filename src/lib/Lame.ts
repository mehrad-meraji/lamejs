import { ShortBlock } from './common.js';
import PsyModel from './PsyModel.js';
import LameGlobalFlags from './LameGlobalFlags.js';
import LameInternalFlags from './LameInternalFlags.js';
import type { PSY } from './LameInternalFlags.js';
import ATH from './ATH.js';
import CBRNewIterationLoop from './CBRNewIterationLoop.js';
import BitStream from './BitStream.js';
import Tables from './Tables.js';
import Encoder from './Encoder.js';
import MPEGMode from './MPEGMode.js';
import { applyAbrPreset, nearestBitrateFullIndex } from './Presets.js';
import QuantizePVT from './QuantizePVT.js';
import Quantize from './Quantize.js';
import Reservoir from './Reservoir.js';
import Takehiro from './Takehiro.js';

/**
 * PSY Model related stuff
 */
class PSYData implements PSY {
    /** The dbQ stuff. */
    mask_adjust = 0.;
    /** The dbQ stuff. */
    mask_adjust_short = 0.;
    /** Band weight long scalefactor bands. */
    bo_l_weight = new Float32Array(Encoder.SBMAX_l);
    /** Band weight short scalefactor bands. */
    bo_s_weight = new Float32Array(Encoder.SBMAX_s);
}

/** Lowpass frequency (Hz) for each bitrate in the full bitrate table. */
const LOWPASS_BY_BITRATE = [2000, 3700, 3900, 5500, 7000, 7500, 10000, 11000, 13500,
    15100, 15600, 17000, 17500, 18600, 19400, 19700, 20500];

/** Valid MPEG sample rates, highest first. */
const SAMPLE_RATES = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];

/** Output sample rate for a lowpass frequency (LAME's optimum_samplefreq). */
function optimumSampleFreq(lowpassfreq: number, inRate: number): number {
    let suggested = SAMPLE_RATES.find(r => inRate >= r) ?? 44100;
    if (lowpassfreq <= 15960) suggested = 44100;
    if (lowpassfreq <= 15250) suggested = 32000;
    if (lowpassfreq <= 11220) suggested = 24000;
    if (lowpassfreq <= 9970) suggested = 22050;
    if (lowpassfreq <= 7230) suggested = 16000;
    if (lowpassfreq <= 5420) suggested = 12000;
    if (lowpassfreq <= 4510) suggested = 11025;
    if (lowpassfreq <= 3970) suggested = 8000;
    if (inRate < suggested) {
        // choose a valid MPEG sample frequency above the input sample frequency
        // to avoid SFB21/12 bitrate bloat rh 061115
        for (let i = SAMPLE_RATES.length - 1; i > 0; i--)
            if (inRate <= SAMPLE_RATES[i]) return SAMPLE_RATES[i];
        return 48000;
    }
    return suggested;
}

/** Sample rate index within its MPEG version, and the version (1 = MPEG-1, 0 = MPEG-2/2.5). */
function sampleRateIndex(rate: number): { index: number; version: number } {
    const i = SAMPLE_RATES.indexOf(rate);
    // SAMPLE_RATES is ordered 48, 44.1, 32 | 24, 22.05, 16 | 12, 11.025, 8; MPEG order is 44.1, 48, 32.
    return { index: [1, 0, 2][i % 3], version: i < 3 ? 1 : 0 };
}

/** Nearest legal bitrate for the MPEG version (bRate in kbps). */
function findNearestBitrate(bRate: number, version: number, samplerate: number): number {
    const table = Tables.bitrate_table[samplerate < 16000 ? 2 : version];
    let bitrate = table[1];
    for (let i = 2; i <= 14; i++)
        if (table[i] > 0 && Math.abs(table[i] - bRate) < Math.abs(bitrate - bRate))
            bitrate = table[i];
    return bitrate;
}

function filterCoef(x: number): number {
    if (x > 1.0) return 0.0;
    if (x <= 0.0) return 1.0;
    return Math.cos(Math.PI / 2 * x);
}

/**
 * Resampling via FIR filter, blackman window.
 * This algorithm from: SIGNAL PROCESSING ALGORITHMS IN FORTRAN AND C
 * S.D. Stearns and R.A. David, Prentice-Hall, 1992
 */
function blackman(x: number, fcn: number, l: number): number {
    const wcn = Math.PI * fcn;
    x /= l;
    if (x < 0) x = 0;
    if (x > 1) x = 1;
    const x2 = x - .5;
    const bkwn = 0.42 - 0.5 * Math.cos(2 * x * Math.PI) + 0.08 * Math.cos(4 * x * Math.PI);
    if (Math.abs(x2) < 1e-9)
        return wcn / Math.PI;
    return bkwn * Math.sin(l * wcn * x2) / (Math.PI * l * x2);
}

function gcd(i: number, j: number): number {
    return j != 0 ? gcd(j, i % j) : i;
}

/**
 * One encoder instance: owns the per-stream state of every LAME module.
 * CBR only, no VBR/Xing tag, no ID3, no bit reservoir, quality 3.
 */
export default class Lame {
    private readonly bs = new BitStream();
    private readonly psy = new PsyModel();
    private readonly qupvt: QuantizePVT;
    private readonly enc: Encoder;
    readonly gfp: LameGlobalFlags;

    constructor(channels: number, inSamplerate: number, kbps: number) {
        const rv = new Reservoir(this.bs);
        const tak = new Takehiro();
        this.qupvt = new QuantizePVT(tak, rv, this.psy);
        tak.qupvt = this.qupvt;
        const qu = new Quantize(rv, this.qupvt, tak);
        this.enc = new Encoder(this.bs, this.psy, new CBRNewIterationLoop(qu));
        this.gfp = this.initParams(channels, inSamplerate, kbps);
    }

    private initParams(channels: number, inSamplerate: number, kbps: number): LameGlobalFlags {
        const gfp = new LameGlobalFlags();
        const gfc = gfp.internal_flags = new LameInternalFlags();
        gfc.ATH = new ATH();
        gfc.PSY = new PSYData();

        gfp.in_samplerate = inSamplerate;
        gfp.mode = channels == 1 ? MPEGMode.MONO : MPEGMode.STEREO;
        gfc.channels_in = channels;
        gfc.channels_out = channels;
        gfc.OldValue[0] = gfc.OldValue[1] = 180;
        gfc.CurrentStep[0] = gfc.CurrentStep[1] = 4;
        gfc.masking_lower = 1;
        gfc.mf_samples_to_encode = Encoder.ENCDELAY + Encoder.POSTDELAY;
        gfc.mf_size = Encoder.ENCDELAY - Encoder.MDCTDELAY;

        /* lowpass from the requested bitrate, then the output sample rate that suits it */
        let lowpass = LOWPASS_BY_BITRATE[nearestBitrateFullIndex(kbps)];
        if (channels == 1) lowpass *= 1.5;
        gfp.lowpassfreq = lowpass | 0;
        if (2 * gfp.lowpassfreq > inSamplerate)
            gfp.lowpassfreq = inSamplerate / 2;
        gfp.out_samplerate = optimumSampleFreq(gfp.lowpassfreq | 0, inSamplerate);
        gfp.lowpassfreq = Math.min(20500, gfp.out_samplerate / 2, gfp.lowpassfreq);

        gfc.mode_gr = gfp.out_samplerate <= 24000 ? 1 : 2;
        gfp.framesize = 576 * gfc.mode_gr;
        gfc.resample_ratio = inSamplerate / gfp.out_samplerate;

        this.initFilter(gfc, 2 * gfp.lowpassfreq / gfp.out_samplerate);

        const sr = sampleRateIndex(gfp.out_samplerate);
        gfc.samplerate_index = sr.index;
        gfp.version = sr.version;
        gfp.brate = findNearestBitrate(kbps, gfp.version, gfp.out_samplerate);
        gfc.bitrate_index = Tables.bitrate_table[gfp.out_samplerate < 16000 ? 2 : gfp.version].indexOf(gfp.brate);

        this.bs.init_bit_stream_w(gfc);

        const j = gfc.samplerate_index + (3 * gfp.version) + 6 * (gfp.out_samplerate < 16000 ? 1 : 0);
        const band = this.qupvt.sfBandIndex[j];
        gfc.scalefac_band.l.set(band.l.slice(0, Encoder.SBMAX_l + 1));
        gfc.scalefac_band.s.set(band.s.slice(0, Encoder.SBMAX_s + 1));
        for (let i = 0; i < Encoder.PSFB21; i++) {
            const size = (gfc.scalefac_band.l[22] - gfc.scalefac_band.l[21]) / Encoder.PSFB21;
            gfc.scalefac_band.psfb21[i] = gfc.scalefac_band.l[21] + i * size;
        }
        gfc.scalefac_band.psfb21[Encoder.PSFB21] = 576;
        for (let i = 0; i < Encoder.PSFB12; i++) {
            const size = (gfc.scalefac_band.s[13] - gfc.scalefac_band.s[12]) / Encoder.PSFB12;
            gfc.scalefac_band.psfb12[i] = gfc.scalefac_band.s[12] + i * size;
        }
        gfc.scalefac_band.psfb12[Encoder.PSFB12] = 192;

        if (gfp.version == 1) /* MPEG 1 */
            gfc.sideinfo_len = (gfc.channels_out == 1) ? 4 + 17 : 4 + 32;
        else /* MPEG 2 */
            gfc.sideinfo_len = (gfc.channels_out == 1) ? 4 + 9 : 4 + 17;

        gfc.nsPsy.pefirbuf.fill(700 * gfc.mode_gr * gfc.channels_out);

        applyAbrPreset(gfp, gfp.brate);
        gfc.PSY.mask_adjust = gfp.maskingadjust;
        gfc.PSY.mask_adjust_short = gfp.maskingadjust_short;

        /* quality 3 (LAME's default) */
        if (gfc.noise_shaping == 0)
            gfc.noise_shaping = 1;

        /* automatic ATH adjustment, flat sensitivity */
        gfc.ATH.aaSensitivityP = 1;

        /*
         * Many hardware decoders cannot handle uncoupled short blocks in
         * regular stereo mode; coupling makes no sense for mono.
         */
        gfp.short_blocks = channels == 2 ? ShortBlock.short_block_coupled : ShortBlock.short_block_allowed;

        /*
         * padding method as described in "MPEG-Layer3 / Bitstream Syntax and
         * Decoding" by Martin Sieler, Ralph Sperschneider. Note: there is no
         * padding for the very first frame. Robert Hegemann 2000-06-22
         */
        gfc.slot_lag = gfc.frac_SpF = (((gfp.version + 1) * 72000 * gfp.brate) % gfp.out_samplerate) | 0;

        this.qupvt.iteration_init(gfp);
        this.psy.psymodel_init(gfp);
        return gfp;
    }

    /** Polyphase lowpass filter (filter type 0); lowpass is a fraction of Nyquist. */
    private initFilter(gfc: LameInternalFlags, lowpass: number): void {
        let lowpass_band = 32;
        for (let band = 0; band <= 31; band++)
            if (band / 31.0 >= lowpass)
                lowpass_band = Math.min(lowpass_band, band);
        // the *actual* transition band implemented by the polyphase filter
        gfc.lowpass1 = (lowpass_band - .75) / 31.0;
        gfc.lowpass2 = lowpass_band / 31.0;

        for (let band = 0; band < 32; band++) {
            const freq = band / 31.0;
            gfc.amp_filter[band] = gfc.lowpass2 > gfc.lowpass1
                ? filterCoef((freq - gfc.lowpass1) / (gfc.lowpass2 - gfc.lowpass1 + 1e-20))
                : 1.0;
        }
    }

    encodeFlush(mp3buffer: Int8Array, mp3bufferPos: number, mp3buffer_size: number): number {
        const gfp = this.gfp;
        const gfc = gfp.internal_flags!;
        /* Was flush already called? */
        if (gfc.mf_samples_to_encode < 1)
            return 0;

        const silence = new Int16Array(1152);
        let imp3 = 0, mp3count = 0;

        /*
         * we always add POSTDELAY=288 padding to make sure granule with real
         * data can be complety decoded (because of 50% overlap with next
         * granule
         */
        let samples_to_encode = gfc.mf_samples_to_encode - Encoder.POSTDELAY;
        const mf_needed = this.calcNeeded();

        if (gfp.in_samplerate != gfp.out_samplerate) {
            /* delay due to resampling; needs to be fixed, if resampling code gets changed */
            samples_to_encode += 16. * gfp.out_samplerate / gfp.in_samplerate;
        }
        let end_padding = gfp.framesize - (samples_to_encode % gfp.framesize);
        if (end_padding < 576)
            end_padding += gfp.framesize;

        let frames_left = (samples_to_encode + end_padding) / gfp.framesize;

        /* send in a frame of 0 padding until all internal sample buffers are flushed */
        while (frames_left > 0 && imp3 >= 0) {
            let bunch = (mf_needed - gfc.mf_size) * gfp.in_samplerate / gfp.out_samplerate;
            const frame_num = gfp.frameNum;
            if (bunch > 1152) bunch = 1152;
            if (bunch < 1) bunch = 1;

            imp3 = this.encodeBuffer(silence, silence, bunch, mp3buffer, mp3bufferPos, mp3buffer_size - mp3count);
            mp3bufferPos += imp3;
            mp3count += imp3;
            frames_left -= (frame_num != gfp.frameNum) ? 1 : 0;
        }
        /* Set to 0 so we may detect and break loops calling it more than once in a row. */
        gfc.mf_samples_to_encode = 0;

        if (imp3 < 0)
            return imp3;

        /* bit buffer might still contain some mp3 data */
        this.bs.flush_bitstream(gfp);
        imp3 = this.bs.copy_buffer(mp3buffer, mp3bufferPos, mp3buffer_size - mp3count);
        if (imp3 < 0)
            return imp3;
        return mp3count + imp3;
    }

    encodeBuffer(buffer_l: ArrayLike<number>, buffer_r: ArrayLike<number>, nsamples: number, mp3buf: Int8Array, mp3bufPos: number, mp3buf_size: number): number {
        const gfp = this.gfp;
        const gfc = gfp.internal_flags!;
        if (nsamples == 0)
            return 0;

        if (gfc.in_buffer_0 == null || gfc.in_buffer_nsamples < nsamples) {
            gfc.in_buffer_0 = new Float32Array(nsamples);
            gfc.in_buffer_1 = new Float32Array(nsamples);
            gfc.in_buffer_nsamples = nsamples;
        }
        const in_l = gfc.in_buffer_0, in_r = gfc.in_buffer_1!;

        /* copy (sample_t) and apply the preset's re-scaling */
        const scale = gfp.scale;
        const rescale = BitStream.NEQ(scale, 0) && BitStream.NEQ(scale, 1.0);
        for (let i = 0; i < nsamples; i++) {
            in_l[i] = buffer_l[i];
            if (rescale) in_l[i] *= scale;
        }
        if (gfc.channels_in > 1)
            for (let i = 0; i < nsamples; i++) {
                in_r[i] = buffer_r[i];
                if (rescale) in_r[i] *= scale;
            }

        let mp3size = this.bs.copy_buffer(mp3buf, mp3bufPos, mp3buf_size);
        if (mp3size < 0)
            return mp3size;
        mp3bufPos += mp3size;

        const mf_needed = this.calcNeeded();
        const mfbuf = gfc.mfbuf;

        let in_bufferPos = 0;
        while (nsamples > 0) {
            /* copy in new samples into mfbuf, with resampling */
            const { n_in, n_out } = this.fillBuffer(mfbuf, in_l, in_r, in_bufferPos, nsamples);
            nsamples -= n_in;
            in_bufferPos += n_in;
            gfc.mf_size += n_out;

            /* encodeFlush may have set mf_samples_to_encode to 0 */
            if (gfc.mf_samples_to_encode < 1)
                gfc.mf_samples_to_encode = Encoder.ENCDELAY + Encoder.POSTDELAY;
            gfc.mf_samples_to_encode += n_out;

            if (gfc.mf_size >= mf_needed) {
                const ret = this.enc.lame_encode_mp3_frame(gfp, mfbuf[0], mfbuf[1], mp3buf, mp3bufPos, mp3buf_size - mp3size);
                gfp.frameNum++;
                if (ret < 0)
                    return ret;
                mp3bufPos += ret;
                mp3size += ret;

                /* shift out old samples */
                gfc.mf_size -= gfp.framesize;
                gfc.mf_samples_to_encode -= gfp.framesize;
                for (let ch = 0; ch < gfc.channels_out; ch++)
                    mfbuf[ch].copyWithin(0, gfp.framesize, gfp.framesize + gfc.mf_size);
            }
        }
        return mp3size;
    }

    private calcNeeded(): number {
        /* amount needed for FFT */
        return Math.max(Encoder.BLKSIZE + this.gfp.framesize - Encoder.FFTOFFSET, 512 + this.gfp.framesize - 32);
    }

    private fillBufferResample(outbuf: Float32Array, outbufPos: number, desired_len: number, inbuf: Float32Array, in_bufferPos: number, len: number, ch: number): { k: number; used: number } {
        const gfp = this.gfp;
        const gfc = gfp.internal_flags!;
        let i, j = 0, k;
        /* number of convolution functions to pre-compute */
        let bpc = gfp.out_samplerate / gcd(gfp.out_samplerate, gfp.in_samplerate);
        if (bpc > LameInternalFlags.BPC)
            bpc = LameInternalFlags.BPC;

        const intratio = (Math.abs(gfc.resample_ratio - Math.floor(.5 + gfc.resample_ratio)) < .0001) ? 1 : 0;
        let fcn = 1.00 / gfc.resample_ratio;
        if (fcn > 1.00)
            fcn = 1.00;
        /* must be odd, unless resample_ratio=int, then it must be even */
        const filter_l = 31 + intratio;
        /* size of data needed for FIR */
        const BLACKSIZE = filter_l + 1;

        if (gfc.fill_buffer_resample_init == 0) {
            gfc.inbuf_old[0] = new Float32Array(BLACKSIZE);
            gfc.inbuf_old[1] = new Float32Array(BLACKSIZE);
            for (i = 0; i <= 2 * bpc; ++i)
                gfc.blackfilt[i] = new Float32Array(BLACKSIZE);

            gfc.itime[0] = 0;
            gfc.itime[1] = 0;

            /* precompute blackman filter coefficients */
            for (j = 0; j <= 2 * bpc; j++) {
                let sum = 0.;
                const offset = (j - bpc) / (2. * bpc);
                for (i = 0; i <= filter_l; i++)
                    sum += gfc.blackfilt[j][i] = blackman(i - offset, fcn, filter_l);
                for (i = 0; i <= filter_l; i++)
                    gfc.blackfilt[j][i] /= sum;
            }
            gfc.fill_buffer_resample_init = 1;
        }

        const inbuf_old = gfc.inbuf_old[ch];

        /* time of j'th element in inbuf = itime + j/ifreq; */
        /* time of k'th element in outbuf = j/ofreq */
        for (k = 0; k < desired_len; k++) {
            /* time of k'th output sample */
            const time0 = k * gfc.resample_ratio;
            j = 0 | Math.floor(time0 - gfc.itime[ch]);

            /* check if we need more input data */
            if ((filter_l + j - filter_l / 2) >= len)
                break;

            /* blackman filter. by default, window centered at j+.5(filter_l%2) */
            /* but we want a window centered at time0. */
            const offset = (time0 - gfc.itime[ch] - (j + .5 * (filter_l % 2)));

            /* find the closest precomputed window for this offset: */
            const filt = gfc.blackfilt[0 | Math.floor((offset * 2 * bpc) + bpc + .5)];
            let xvalue = 0.;
            for (i = 0; i <= filter_l; ++i) {
                /* force integer index */
                const j2 = 0 | (i + j - filter_l / 2);
                const y = (j2 < 0) ? inbuf_old[BLACKSIZE + j2] : inbuf[in_bufferPos + j2];
                xvalue += y * filt[i];
            }
            outbuf[outbufPos + k] = xvalue;
        }

        /* k = number of samples added to outbuf */
        /* last k sample used data from [j-filter_l/2,j+filter_l-filter_l/2] */

        /* how many samples of input data were used: */
        const used = Math.min(len, filter_l + j - filter_l / 2);

        /*
         * adjust our input time counter. Incriment by the number of samples
         * used, then normalize so that next output sample is at time 0, next
         * input buffer is at time itime[ch]
         */
        gfc.itime[ch] += used - k * gfc.resample_ratio;

        /* save the last BLACKSIZE samples into the inbuf_old buffer */
        if (used >= BLACKSIZE) {
            for (i = 0; i < BLACKSIZE; i++)
                inbuf_old[i] = inbuf[in_bufferPos + used + i - BLACKSIZE];
        } else {
            /* shift n_shift samples by used, to make room for the used new samples */
            const n_shift = BLACKSIZE - used;
            for (i = 0; i < n_shift; ++i)
                inbuf_old[i] = inbuf_old[i + used];

            /* shift in the used samples */
            for (j = 0; i < BLACKSIZE; ++i, ++j)
                inbuf_old[i] = inbuf[in_bufferPos + j];
        }
        /* the number samples created at the new samplerate */
        return { k, used };
    }

    private fillBuffer(mfbuf: Float32Array[], in_l: Float32Array, in_r: Float32Array, in_bufferPos: number, nsamples: number): { n_in: number; n_out: number } {
        const gfp = this.gfp;
        const gfc = gfp.internal_flags!;

        /* copy in new samples into mfbuf, with resampling if necessary */
        if ((gfc.resample_ratio < .9999) || (gfc.resample_ratio > 1.0001)) {
            let n_in = 0, n_out = 0;
            for (let ch = 0; ch < gfc.channels_out; ch++) {
                const r = this.fillBufferResample(mfbuf[ch], gfc.mf_size, gfp.framesize, ch == 0 ? in_l : in_r, in_bufferPos, nsamples, ch);
                n_out = r.k;
                n_in = r.used;
            }
            return { n_in, n_out };
        }
        const n = Math.min(gfp.framesize, nsamples);
        mfbuf[0].set(in_l.subarray(in_bufferPos, in_bufferPos + n), gfc.mf_size);
        if (gfc.channels_out == 2)
            mfbuf[1].set(in_r.subarray(in_bufferPos, in_bufferPos + n), gfc.mf_size);
        return { n_in: n, n_out: n };
    }
}
