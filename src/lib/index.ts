import Lame from './Lame.js';

/**
 * CBR MP3 encoder for 16-bit PCM.
 *
 * ```ts
 * const enc = new Mp3Encoder(2, 44100, 128);
 * const chunks = [enc.encodeBuffer(left, right), enc.flush()];
 * ```
 */
export class Mp3Encoder {
    readonly #channels: 1 | 2;
    readonly #lame: Lame;
    #mp3buf = new Int8Array(0);

    /**
     * @param channels 1 (mono) or 2 (stereo)
     * @param sampleRate input sample rate in Hz; non-MPEG rates are resampled
     * @param kbps bitrate; rounded to the nearest legal MPEG bitrate
     */
    constructor(channels: 1 | 2, sampleRate: number, kbps: number) {
        if (channels !== 1 && channels !== 2)
            throw new RangeError(`channels must be 1 or 2, got ${channels}`);
        if (!(sampleRate > 0) || !(kbps > 0))
            throw new RangeError(`sampleRate and kbps must be positive, got ${sampleRate} and ${kbps}`);
        this.#channels = channels;
        this.#lame = new Lame(channels, sampleRate, kbps);
        this.#ensureBuffer(1152);
    }

    #ensureBuffer(samples: number): void {
        const size = 0 | (1.25 * samples + 7200);
        if (size > this.#mp3buf.length)
            this.#mp3buf = new Int8Array(size);
    }

    /**
     * Encodes a chunk of samples. `right` is required for stereo and ignored for mono.
     * Returns the MP3 bytes produced so far (often empty for small chunks).
     */
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array {
        if (this.#channels === 2 && right?.length !== left.length)
            throw new RangeError('stereo needs a right channel the same length as the left');
        this.#ensureBuffer(left.length);
        const n = this.#lame.encodeBuffer(left, right ?? left, left.length, this.#mp3buf, 0, this.#mp3buf.length);
        return this.#mp3buf.slice(0, n);
    }

    /** Encodes the buffered samples and returns the last MP3 bytes. */
    flush(): Int8Array {
        const n = this.#lame.encodeFlush(this.#mp3buf, 0, this.#mp3buf.length);
        return this.#mp3buf.slice(0, n);
    }
}

export { WavHeader } from './WavHeader.js';
