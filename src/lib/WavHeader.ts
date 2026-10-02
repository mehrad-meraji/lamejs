const RIFF = 0x52494646; // "RIFF"
const WAVE = 0x57415645; // "WAVE"
const FMT_ = 0x666d7420; // "fmt "
const DATA = 0x64617461; // "data"

/** Minimal RIFF/WAVE (PCM) header reader. */
export class WavHeader {
    dataOffset = 0;
    dataLen = 0;
    channels = 0;
    sampleRate = 0;

    /** Returns undefined if the buffer is not a RIFF/WAVE file. */
    static readHeader(dataView: DataView): WavHeader | undefined {
        if (dataView.getUint32(0, false) != RIFF || dataView.getUint32(8, false) != WAVE || dataView.getUint32(12, false) != FMT_)
            return undefined;
        const w = new WavHeader();
        const fmtLen = dataView.getUint32(16, true);
        if (fmtLen != 16 && fmtLen != 18)
            throw new Error('extended fmt chunk not implemented');
        w.channels = dataView.getUint16(22, true);
        w.sampleRate = dataView.getUint32(24, true);

        /* skip chunks until "data" */
        let pos = 20 + fmtLen;
        let len = 0;
        while (pos + 8 <= dataView.byteLength) {
            const id = dataView.getUint32(pos, false);
            len = dataView.getUint32(pos + 4, true);
            if (id == DATA) {
                w.dataLen = len;
                w.dataOffset = pos + 8;
                return w;
            }
            pos += len + 8;
        }
        return undefined;
    }
}
