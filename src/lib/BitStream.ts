import Takehiro from './Takehiro.js';
import Tables from './Tables.js';
import Encoder from './Encoder.js';
import LameInternalFlags from './LameInternalFlags.js';

import LameGlobalFlags from './LameGlobalFlags.js';
import GrInfo from './GrInfo.js';

/** Size of the bit buffer: one call never produces more than a few frames. */
const LAME_MAXMP3BUFFER = 16384;

export default class BitStream {
    static EQ(a: number, b: number): boolean {
        return (Math.abs(a) > Math.abs(b)) ? (Math.abs((a) - (b)) <= (Math
            .abs(a) * 1e-6))
            : (Math.abs((a) - (b)) <= (Math.abs(b) * 1e-6));
    }

    static NEQ(a: number, b: number): boolean {
        return !BitStream.EQ(a, b);
    }

    /**
     * Bit stream buffer.
     */
    private buf!: Int8Array;
    /**
     * Bit counter of bit stream.
     */
    private totbit: number = 0;
    /**
     * Pointer to top byte in buffer.
     */
    private bufByteIdx: number = 0;
    /**
     * Pointer to top bit of top byte in buffer.
     */
    private bufBitIdx: number = 0;

    /**
     * compute bitsperframe and mean_bits for a layer III frame
     */
    getframebits(gfp: LameGlobalFlags): number {
        const gfc = gfp.internal_flags!;
        let bit_rate;

        /* get bitrate in kbps [?] */
        bit_rate = Tables.bitrate_table[gfp.version][gfc.bitrate_index];

        /* main encoding routine toggles padding on and off */
        /* one Layer3 Slot consists of 8 bits */
        const bytes = 0 | (gfp.version + 1) * 72000 * bit_rate / gfp.out_samplerate + gfc.padding;
        return 8 * bytes;
    }

    private putheader_bits(gfc: LameInternalFlags): void {
        this.buf.set(gfc.header[gfc.w_ptr].buf.subarray(0, gfc.sideinfo_len), this.bufByteIdx);
        this.bufByteIdx += gfc.sideinfo_len;
        this.totbit += gfc.sideinfo_len * 8;
        gfc.w_ptr = (gfc.w_ptr + 1) & (LameInternalFlags.MAX_HEADER_BUF - 1);
    }

    /**
     * write j bits into the bit stream
     */
    private putbits2(gfc: LameInternalFlags, val: number, j: number): void {

        while (j > 0) {
            let k;
            if (this.bufBitIdx == 0) {
                this.bufBitIdx = 8;
                this.bufByteIdx++;
                if (gfc.header[gfc.w_ptr].write_timing == this.totbit) {
                    this.putheader_bits(gfc);
                }
                this.buf[this.bufByteIdx] = 0;
            }

            k = Math.min(j, this.bufBitIdx);
            j -= k;

            this.bufBitIdx -= k;

            /* 32 too large on 32 bit machines */

            this.buf[this.bufByteIdx] |= ((val >> j) << this.bufBitIdx);
            this.totbit += k;
        }
    }

    /**
     * Some combinations of bitrate, Fs, and stereo make it impossible to stuff
     * out a frame using just main_data, due to the limited number of bits to
     * indicate main_data_length. In these situations, we put stuffing bits into
     * the ancillary data...
     */
    private drain_into_ancillary(gfc: LameInternalFlags, remainingBits: number): void {
        for (const c of [0x4c, 0x41, 0x4d, 0x45]) { // "LAME"
            if (remainingBits < 8)
                return this.putzeros(gfc, remainingBits);
            this.putbits2(gfc, c, 8);
            remainingBits -= 8;
        }
        // Upstream passed the characters of the version string "3.98.4" as the value, so
        // `>>` coerced them to 3, NaN (0), 9, 8, NaN (0), 4. Kept for byte-identical output.
        if (remainingBits >= 32)
            for (const c of [3, 0, 9, 8, 0, 4]) {
                if (remainingBits < 8)
                    break;
                this.putbits2(gfc, c, 8);
                remainingBits -= 8;
            }
        // The ancillary flag only toggles when the bit reservoir is enabled, so the rest is zero.
        this.putzeros(gfc, remainingBits);
    }

    private putzeros(gfc: LameInternalFlags, n: number): void {
        for (; n > 0; n -= 24)
            this.putbits2(gfc, 0, Math.min(n, 24));
    }

    /**
     * write N bits into the header
     */
    private writeheader(gfc: LameInternalFlags, val: number, j: number): void {
        let ptr = gfc.header[gfc.h_ptr].ptr;

        while (j > 0) {
            const k = Math.min(j, 8 - (ptr & 7));
            j -= k;
            /* >> 32 too large for 32 bit machines */

            gfc.header[gfc.h_ptr].buf[ptr >> 3] |= ((val >> j)) << (8 - (ptr & 7) - k);
            ptr += k;
        }
        gfc.header[gfc.h_ptr].ptr = ptr;
    }

    private encodeSideInfo2(gfp: LameGlobalFlags, bitsPerFrame: number): void {
        const gfc = gfp.internal_flags!;
        let l3_side;
        let gr, ch;

        l3_side = gfc.l3_side;
        gfc.header[gfc.h_ptr].ptr = 0;
        gfc.header[gfc.h_ptr].buf.fill(0, 0, gfc.sideinfo_len);
        if (gfp.out_samplerate < 16000)
            this.writeheader(gfc, 0xffe, 12);
        else
            this.writeheader(gfc, 0xfff, 12);
        this.writeheader(gfc, (gfp.version), 1);
        this.writeheader(gfc, 4 - 3, 2);
        this.writeheader(gfc, 1, 1); // no CRC protection
        this.writeheader(gfc, (gfc.bitrate_index), 4);
        this.writeheader(gfc, (gfc.samplerate_index), 2);
        this.writeheader(gfc, (gfc.padding), 1);
        this.writeheader(gfc, 0, 1); // private extension
        this.writeheader(gfc, gfp.mode, 2);
        this.writeheader(gfc, 0, 2); // mode extension: plain L/R
        this.writeheader(gfc, 0, 1); // copyright
        this.writeheader(gfc, 1, 1); // original
        this.writeheader(gfc, 0, 2); // emphasis
        if (gfp.version == 1) {
            /* MPEG1 */
            this.writeheader(gfc, (l3_side.main_data_begin), 9);

            if (gfc.channels_out == 2)
                this.writeheader(gfc, l3_side.private_bits, 3);
            else
                this.writeheader(gfc, l3_side.private_bits, 5);

            for (ch = 0; ch < gfc.channels_out; ch++) {
                let band;
                for (band = 0; band < 4; band++) {
                    this.writeheader(gfc, l3_side.scfsi[ch][band], 1);
                }
            }

            for (gr = 0; gr < 2; gr++) {
                for (ch = 0; ch < gfc.channels_out; ch++) {
                    const gi = l3_side.tt[gr][ch];
                    this.writeheader(gfc, gi.part2_3_length + gi.part2_length, 12);
                    this.writeheader(gfc, gi.big_values / 2, 9);
                    this.writeheader(gfc, gi.global_gain, 8);
                    this.writeheader(gfc, gi.scalefac_compress, 4);

                    if (gi.block_type != Encoder.NORM_TYPE) {
                        this.writeheader(gfc, 1, 1);
                        /* window_switching_flag */
                        this.writeheader(gfc, gi.block_type, 2);
                        this.writeheader(gfc, 0, 1); // mixed_block_flag: never used

                        if (gi.table_select[0] == 14)
                            gi.table_select[0] = 16;
                        this.writeheader(gfc, gi.table_select[0], 5);
                        if (gi.table_select[1] == 14)
                            gi.table_select[1] = 16;
                        this.writeheader(gfc, gi.table_select[1], 5);

                        this.writeheader(gfc, gi.subblock_gain[0], 3);
                        this.writeheader(gfc, gi.subblock_gain[1], 3);
                        this.writeheader(gfc, gi.subblock_gain[2], 3);
                    } else {
                        this.writeheader(gfc, 0, 1);
                        /* window_switching_flag */
                        if (gi.table_select[0] == 14)
                            gi.table_select[0] = 16;
                        this.writeheader(gfc, gi.table_select[0], 5);
                        if (gi.table_select[1] == 14)
                            gi.table_select[1] = 16;
                        this.writeheader(gfc, gi.table_select[1], 5);
                        if (gi.table_select[2] == 14)
                            gi.table_select[2] = 16;
                        this.writeheader(gfc, gi.table_select[2], 5);

                        this.writeheader(gfc, gi.region0_count, 4);
                        this.writeheader(gfc, gi.region1_count, 3);
                    }
                    this.writeheader(gfc, gi.preflag, 1);
                    this.writeheader(gfc, gi.scalefac_scale, 1);
                    this.writeheader(gfc, gi.count1table_select, 1);
                }
            }
        } else {
            /* MPEG2 */
            this.writeheader(gfc, (l3_side.main_data_begin), 8);
            this.writeheader(gfc, l3_side.private_bits, gfc.channels_out);

            gr = 0;
            for (ch = 0; ch < gfc.channels_out; ch++) {
                const gi = l3_side.tt[gr][ch];
                this.writeheader(gfc, gi.part2_3_length + gi.part2_length, 12);
                this.writeheader(gfc, gi.big_values / 2, 9);
                this.writeheader(gfc, gi.global_gain, 8);
                this.writeheader(gfc, gi.scalefac_compress, 9);

                if (gi.block_type != Encoder.NORM_TYPE) {
                    this.writeheader(gfc, 1, 1);
                    /* window_switching_flag */
                    this.writeheader(gfc, gi.block_type, 2);
                    this.writeheader(gfc, 0, 1); // mixed_block_flag: never used

                    if (gi.table_select[0] == 14)
                        gi.table_select[0] = 16;
                    this.writeheader(gfc, gi.table_select[0], 5);
                    if (gi.table_select[1] == 14)
                        gi.table_select[1] = 16;
                    this.writeheader(gfc, gi.table_select[1], 5);

                    this.writeheader(gfc, gi.subblock_gain[0], 3);
                    this.writeheader(gfc, gi.subblock_gain[1], 3);
                    this.writeheader(gfc, gi.subblock_gain[2], 3);
                } else {
                    this.writeheader(gfc, 0, 1);
                    /* window_switching_flag */
                    if (gi.table_select[0] == 14)
                        gi.table_select[0] = 16;
                    this.writeheader(gfc, gi.table_select[0], 5);
                    if (gi.table_select[1] == 14)
                        gi.table_select[1] = 16;
                    this.writeheader(gfc, gi.table_select[1], 5);
                    if (gi.table_select[2] == 14)
                        gi.table_select[2] = 16;
                    this.writeheader(gfc, gi.table_select[2], 5);

                    this.writeheader(gfc, gi.region0_count, 4);
                    this.writeheader(gfc, gi.region1_count, 3);
                }

                this.writeheader(gfc, gi.scalefac_scale, 1);
                this.writeheader(gfc, gi.count1table_select, 1);
            }
        }

        {
            const old = gfc.h_ptr;

            gfc.h_ptr = (old + 1) & (LameInternalFlags.MAX_HEADER_BUF - 1);
            gfc.header[gfc.h_ptr].write_timing = gfc.header[old].write_timing
                + bitsPerFrame;

        }
    }

    private huffman_coder_count1(gfc: LameInternalFlags, gi: GrInfo): number {
        /* Write count1 area */
        const h = Tables.ht[gi.count1table_select + 32];
        let i, bits = 0;

        let ix = gi.big_values;
        let xr = gi.big_values;

        for (i = (gi.count1 - gi.big_values) / 4; i > 0; --i) {
            let huffbits = 0;
            let p = 0, v;

            v = gi.l3_enc[ix + 0];
            if (v != 0) {
                p += 8;
                if (gi.xr[xr + 0] < 0)
                    huffbits++;
            }

            v = gi.l3_enc[ix + 1];
            if (v != 0) {
                p += 4;
                huffbits *= 2;
                if (gi.xr[xr + 1] < 0)
                    huffbits++;
            }

            v = gi.l3_enc[ix + 2];
            if (v != 0) {
                p += 2;
                huffbits *= 2;
                if (gi.xr[xr + 2] < 0)
                    huffbits++;
            }

            v = gi.l3_enc[ix + 3];
            if (v != 0) {
                p++;
                huffbits *= 2;
                if (gi.xr[xr + 3] < 0)
                    huffbits++;
            }

            ix += 4;
            xr += 4;
            this.putbits2(gfc, huffbits + h.table[p], h.hlen[p]);
            bits += h.hlen[p];
        }
        return bits;
    }

    /**
     * Implements the pseudocode of page 98 of the IS
     */
    private Huffmancode(gfc: LameInternalFlags, tableindex: number, start: number, end: number, gi: GrInfo): number {
        const h = Tables.ht[tableindex];
        let bits = 0;

        if (0 == tableindex)
            return bits;

        for (let i = start; i < end; i += 2) {
            let cbits = 0;
            let xbits = 0;
            const linbits = h.xlen;
            let xlen = h.xlen;
            let ext = 0;
            let x1 = gi.l3_enc[i];
            let x2 = gi.l3_enc[i + 1];

            if (x1 != 0) {
                if (gi.xr[i] < 0)
                    ext++;
                cbits--;
            }

            if (tableindex > 15) {
                /* use ESC-words */
                if (x1 > 14) {
                    const linbits_x1 = x1 - 15;
                    ext |= linbits_x1 << 1;
                    xbits = linbits;
                    x1 = 15;
                }

                if (x2 > 14) {
                    const linbits_x2 = x2 - 15;
                    ext <<= linbits;
                    ext |= linbits_x2;
                    xbits += linbits;
                    x2 = 15;
                }
                xlen = 16;
            }

            if (x2 != 0) {
                ext <<= 1;
                if (gi.xr[i + 1] < 0)
                    ext++;
                cbits--;
            }

            x1 = x1 * xlen + x2;
            xbits -= cbits;
            cbits += h.hlen[x1];

            this.putbits2(gfc, h.table[x1], cbits);
            this.putbits2(gfc, ext, xbits);
            bits += cbits + xbits;
        }
        return bits;
    }

    /**
     * Note the discussion of huffmancodebits() on pages 28 and 29 of the IS, as
     * well as the definitions of the side information on pages 26 and 27.
     */
    private ShortHuffmancodebits(gfc: LameInternalFlags, gi: GrInfo): number {
        let region1Start = 3 * gfc.scalefac_band.s[3];
        if (region1Start > gi.big_values)
            region1Start = gi.big_values;

        /* short blocks do not have a region2 */
        let bits = this.Huffmancode(gfc, gi.table_select[0], 0, region1Start, gi);
        bits += this.Huffmancode(gfc, gi.table_select[1], region1Start,
            gi.big_values, gi);
        return bits;
    }

    private LongHuffmancodebits(gfc: LameInternalFlags, gi: GrInfo): number {
        let bigvalues, bits;
        let region1Start, region2Start;

        bigvalues = gi.big_values;

        let i = gi.region0_count + 1;
        region1Start = gfc.scalefac_band.l[i];
        i += gi.region1_count + 1;
        region2Start = gfc.scalefac_band.l[i];

        if (region1Start > bigvalues)
            region1Start = bigvalues;

        if (region2Start > bigvalues)
            region2Start = bigvalues;

        bits = this.Huffmancode(gfc, gi.table_select[0], 0, region1Start, gi);
        bits += this.Huffmancode(gfc, gi.table_select[1], region1Start,
            region2Start, gi);
        bits += this.Huffmancode(gfc, gi.table_select[2], region2Start, bigvalues,
            gi);
        return bits;
    }

    private writeMainData(gfp: LameGlobalFlags): number {
        let gr, ch, sfb, data_bits, tot_bits = 0;
        const gfc = gfp.internal_flags!;
        const l3_side = gfc.l3_side;

        if (gfp.version == 1) {
            /* MPEG 1 */
            for (gr = 0; gr < 2; gr++) {
                for (ch = 0; ch < gfc.channels_out; ch++) {
                    const gi = l3_side.tt[gr][ch];
                    const slen1 = Takehiro.slen1_tab[gi.scalefac_compress];
                    const slen2 = Takehiro.slen2_tab[gi.scalefac_compress];
                    data_bits = 0;
                    for (sfb = 0; sfb < gi.sfbdivide; sfb++) {
                        if (gi.scalefac[sfb] == -1)
                            continue;
                        /* scfsi is used */
                        this.putbits2(gfc, gi.scalefac[sfb], slen1);
                        data_bits += slen1;
                    }
                    for (; sfb < gi.sfbmax; sfb++) {
                        if (gi.scalefac[sfb] == -1)
                            continue;
                        /* scfsi is used */
                        this.putbits2(gfc, gi.scalefac[sfb], slen2);
                        data_bits += slen2;
                    }

                    if (gi.block_type == Encoder.SHORT_TYPE) {
                        data_bits += this.ShortHuffmancodebits(gfc, gi);
                    } else {
                        data_bits += this.LongHuffmancodebits(gfc, gi);
                    }
                    data_bits += this.huffman_coder_count1(gfc, gi);
                    /* does bitcount in quantize.c agree with actual bit count? */
                    tot_bits += data_bits;
                }
                /* for ch */
            }
            /* for gr */
        } else {
            /* MPEG 2 */
            gr = 0;
            for (ch = 0; ch < gfc.channels_out; ch++) {
                const gi = l3_side.tt[gr][ch];
                let i, sfb_partition, scale_bits = 0;
                data_bits = 0;
                sfb = 0;
                sfb_partition = 0;

                if (gi.block_type == Encoder.SHORT_TYPE) {
                    for (; sfb_partition < 4; sfb_partition++) {
                        const sfbs = gi.sfb_partition_table![sfb_partition] / 3;
                        const slen = gi.slen[sfb_partition];
                        for (i = 0; i < sfbs; i++, sfb++) {
                            this.putbits2(gfc,
                                Math.max(gi.scalefac[sfb * 3 + 0], 0), slen);
                            this.putbits2(gfc,
                                Math.max(gi.scalefac[sfb * 3 + 1], 0), slen);
                            this.putbits2(gfc,
                                Math.max(gi.scalefac[sfb * 3 + 2], 0), slen);
                            scale_bits += 3 * slen;
                        }
                    }
                    data_bits += this.ShortHuffmancodebits(gfc, gi);
                } else {
                    for (; sfb_partition < 4; sfb_partition++) {
                        const sfbs = gi.sfb_partition_table![sfb_partition];
                        const slen = gi.slen[sfb_partition];
                        for (i = 0; i < sfbs; i++, sfb++) {
                            this.putbits2(gfc, Math.max(gi.scalefac[sfb], 0), slen);
                            scale_bits += slen;
                        }
                    }
                    data_bits += this.LongHuffmancodebits(gfc, gi);
                }
                data_bits += this.huffman_coder_count1(gfc, gi);
                /* does bitcount in quantize.c agree with actual bit count? */
                tot_bits += scale_bits + data_bits;
            }
            /* for ch */
        }
        /* for gf */
        return tot_bits;
    }

    /* main_data */

    /*
     * compute the number of bits required to flush all mp3 frames currently in
     * the buffer. This should be the same as the reservoir size. Only call this
     * routine between frames - i.e. only after all headers and data have been
     * added to the buffer by format_bitstream().
     *
     * Also compute total_bits_output = size of mp3 buffer (including frame
     * headers which may not have yet been send to the mp3 buffer) + number of
     * bits needed to flush all mp3 frames.
     *
     * total_bytes_output is the size of the mp3 output buffer if
     * lame_encode_flush_nogap() was called right now.
     */
    private compute_flushbits(gfp: LameGlobalFlags): number {
        const gfc = gfp.internal_flags!;
        /* first and last header to add to bitstream */
        const first_ptr = gfc.w_ptr;
        let last_ptr = gfc.h_ptr - 1;
        if (last_ptr == -1)
            last_ptr = LameInternalFlags.MAX_HEADER_BUF - 1;

        /* add this many bits to bitstream so we can flush all headers */
        let flushbits = gfc.header[last_ptr].write_timing - this.totbit;

        if (flushbits >= 0) {
            /* if flushbits >= 0, some headers have not yet been written */
            /* reduce flushbits by the size of the headers */
            let remaining_headers = 1 + last_ptr - first_ptr;
            if (last_ptr < first_ptr)
                remaining_headers += LameInternalFlags.MAX_HEADER_BUF;
            flushbits -= remaining_headers * 8 * gfc.sideinfo_len;
        }

        /*
         * finally, add some bits so that the last frame is complete these bits
         * are not necessary to decode the last frame, but some decoders will
         * ignore last frame if these bits are missing
         */
        return flushbits + this.getframebits(gfp);
    }

    flush_bitstream(gfp: LameGlobalFlags): void {
        const gfc = gfp.internal_flags!;
        let l3_side;
        let flushbits;
        let last_ptr = gfc.h_ptr - 1;
        /* last header to add to bitstream */
        if (last_ptr == -1)
            last_ptr = LameInternalFlags.MAX_HEADER_BUF - 1;
        l3_side = gfc.l3_side;

        if ((flushbits = this.compute_flushbits(gfp)) < 0)
            return;
        this.drain_into_ancillary(gfc, flushbits);

        /* check that the 100% of the last frame has been written to bitstream */

        /*
         * we have padded out all frames with ancillary data, which is the same
         * as filling the bitreservoir with ancillary data, so :
         */
        gfc.ResvSize = 0;
        l3_side.main_data_begin = 0;
    }

    /**
     * This is called after a frame of audio has been quantized and coded. It
     * will write the encoded audio to the bitstream. Note that from a layer3
     * encoder's perspective the bit stream is primarily a series of main_data()
     * blocks, with header and side information inserted at the proper locations
     * to maintain framing. (See Figure A.7 in the IS).
     */
    format_bitstream(gfp: LameGlobalFlags): number {
        const gfc = gfp.internal_flags!;
        let l3_side;
        l3_side = gfc.l3_side;

        const bitsPerFrame = this.getframebits(gfp);
        this.drain_into_ancillary(gfc, l3_side.resvDrain_pre);

        this.encodeSideInfo2(gfp, bitsPerFrame);
        let bits = 8 * gfc.sideinfo_len;
        bits += this.writeMainData(gfp);
        this.drain_into_ancillary(gfc, l3_side.resvDrain_post);
        bits += l3_side.resvDrain_post;

        l3_side.main_data_begin += (bitsPerFrame - bits) / 8;

        /*
         * compare main_data_begin for the next frame with what we think the
         * resvsize is:
         */
        gfc.ResvSize = l3_side.main_data_begin * 8;

        if (this.totbit > 1000000000) {
            /*
             * to avoid this.totbit overflow, (at 8h encoding at 128kbs) lets reset
             * bit counter
             */
            let i;
            for (i = 0; i < LameInternalFlags.MAX_HEADER_BUF; ++i)
                gfc.header[i].write_timing -= this.totbit;
            this.totbit = 0;
        }

        return 0;
    }

    /** Copies data out of the internal MP3 bit buffer; -1 if `size` is too small. */
    copy_buffer(buffer: Int8Array, bufferPos: number, size: number): number {
        const minimum = this.bufByteIdx + 1;
        if (minimum <= 0)
            return 0;
        if (minimum > size)
            return -1;
        buffer.set(this.buf.subarray(0, minimum), bufferPos);
        this.bufByteIdx = -1;
        this.bufBitIdx = 0;
        return minimum;
    }

    init_bit_stream_w(gfc: LameInternalFlags): void {
        this.buf = new Int8Array(LAME_MAXMP3BUFFER);

        gfc.h_ptr = gfc.w_ptr = 0;
        gfc.header[gfc.h_ptr].write_timing = 0;
        this.bufByteIdx = -1;
        this.bufBitIdx = 0;
        this.totbit = 0;
    }
}
