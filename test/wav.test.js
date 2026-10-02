import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Mp3Encoder, WavHeader } from '../dist/index.js';

// golden-wav.json was produced by the original lamejs 1.2.1 JS (src/js at 5e147ff) from testdata/.
const golden = JSON.parse(readFileSync(new URL('./golden-wav.json', import.meta.url)));

for (const [key, want] of Object.entries(golden)) {
  test(`real audio byte-identical to upstream: ${key}`, () => {
    const [file, kbps] = key.split('@');
    const b = readFileSync(new URL(`../testdata/${file}`, import.meta.url));
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    const h = WavHeader.readHeader(new DataView(ab));
    const s = new Int16Array(ab, h.dataOffset, h.dataLen / 2);
    const ch = h.channels, n = s.length / ch;
    const L = new Int16Array(n), R = new Int16Array(n);
    for (let i = 0; i < n; i++) { L[i] = s[i * ch]; R[i] = s[i * ch + ch - 1]; }

    const enc = new Mp3Encoder(ch, h.sampleRate, +kbps);
    const hash = createHash('sha1');
    let length = 0;
    const add = (p) => { hash.update(new Uint8Array(p.buffer, p.byteOffset, p.length)); length += p.length; };
    for (let i = 0; i < n; i += 1152)
      add(ch == 2 ? enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152)) : enc.encodeBuffer(L.subarray(i, i + 1152)));
    add(enc.flush());
    assert.deepEqual({ channels: ch, sampleRate: h.sampleRate, length, sha1: hash.digest('hex') }, want);
  });
}
