# lamejs

CBR MP3 encoder for 16-bit PCM, written in TypeScript. It started as a port of LAME (via jump3r and [zhuker/lamejs](https://github.com/zhuker/lamejs)).

- ESM only, with no dependencies and no side effects at import time (`"sideEffects": false`).
- Tree-shakeable. Importing only `WavHeader` costs about 0.5 kB, and the encoder is about 97 kB minified (31 kB gzip).
- Load it lazily with `await import(...)`. Nothing runs until you construct an encoder.
- Its output is byte-for-byte identical to lamejs 1.2.1 for the same input (see [Tests](#tests)).

## Install

```bash
npm install @_mehrad/lamejs
```

## Use

```ts
import { Mp3Encoder } from '@_mehrad/lamejs';

const encoder = new Mp3Encoder(2, 44100, 128); // channels, sample rate, kbps
const chunks: Int8Array[] = [];
for (let i = 0; i < left.length; i += 1152)
  chunks.push(encoder.encodeBuffer(left.subarray(i, i + 1152), right.subarray(i, i + 1152)));
chunks.push(encoder.flush());

const mp3 = new Blob(chunks, { type: 'audio/mpeg' });
```

To load the encoder lazily, so it ends up in its own chunk and is fetched only when someone records:

```ts
const { Mp3Encoder } = await import('@_mehrad/lamejs');
```

Encoding is synchronous CPU work, at roughly 35× real time for 44.1 kHz stereo on a laptop. For long recordings, run it in a module worker:

```ts
// mp3.worker.ts
import { Mp3Encoder } from '@_mehrad/lamejs';
onmessage = ({ data: { left, right, sampleRate } }) => {
  const enc = new Mp3Encoder(right ? 2 : 1, sampleRate, 128);
  const out = [enc.encodeBuffer(left, right), enc.flush()];
  postMessage(new Blob(out, { type: 'audio/mpeg' }));
};

// app
const worker = new Worker(new URL('./mp3.worker.ts', import.meta.url), { type: 'module' });
```

### API

`new Mp3Encoder(channels: 1 | 2, sampleRate: number, kbps: number)`
- Sample rates other than the MPEG rates (8–48 kHz) are resampled.
- The bitrate is rounded to the nearest legal value for the output rate.
- Throws `RangeError` for invalid arguments.

`encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array`
- Any chunk size works. `right` is required for stereo.
- Returns the MP3 bytes ready so far, which may be empty.
- The returned array is a copy you can keep.

`flush(): Int8Array`
- Encodes what is still buffered and returns the final bytes.

`WavHeader.readHeader(view: DataView): WavHeader | undefined`
- Reads `channels`, `sampleRate`, `dataOffset` and `dataLen` from a PCM WAV file.

### What it does not do

The encoder runs the same fixed configuration lamejs 1.x used: CBR, plain stereo or mono, LAME quality 3, no bit reservoir, no ID3 or Xing/VBR tag. The VBR/ABR, joint stereo, ID3, ReplayGain and decoder code was unreachable through that API and has been removed. If you need any of it, port it from the Java reference in `src/main/java` or from git history.

## Migrating from 1.x

- ESM only: `require('@_mehrad/lamejs')` and the `lame.all.js` / `lame.min.js` globals are gone. Use `import`.
- The constructor arguments are required and validated (1.x logged a warning and fell back to mono 44.1 kHz).
- Stereo `encodeBuffer` throws if `right` is missing or a different length. 1.x silently encoded garbage.
- `WavHeader.readHeader` returns `undefined` when there is no `data` chunk instead of reading past the end. An unsupported `fmt` chunk throws an `Error` instead of a string.

## Tests

```bash
npm test     # build + node --test
npm run bench
npm run size # gzip size of the bundled encoder
```

The tests compare SHA-1 hashes of the encoded output with hashes from the original lamejs 1.2.1 JavaScript. That covers 54 synthetic cases (mono/stereo, 8–96 kHz, 7–320 kbps, odd chunk sizes, resampling) and the real recordings in `testdata/` at 64 and 128 kbps.

## License

LGPL-3.0, as LAME.
