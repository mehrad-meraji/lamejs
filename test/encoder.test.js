import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Mp3Encoder, WavHeader } from '../dist/index.js';
import { cases, encodeWith } from './signal.js';

// golden.json was produced by the original lamejs 1.2.1 JS (src/js at 5e147ff) on the same signal.
const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url)));

for (const c of cases) {
  const key = `${c.channels}ch-${c.rate}-${c.kbps}`;
  test(`byte-identical to upstream: ${key}`, () => {
    const mp3 = encodeWith(Mp3Encoder, c);
    assert.deepEqual({ length: mp3.length, sha1: createHash('sha1').update(mp3).digest('hex') }, golden[key]);
  });
}

test('WavHeader reads a PCM header', () => {
  const buf = new ArrayBuffer(48);
  const v = new DataView(buf);
  [[0, 0x52494646, false], [4, 40, true], [8, 0x57415645, false], [12, 0x666d7420, false], [16, 16, true],
   [24, 22050, true], [36, 0x64617461, false], [40, 4, true]].forEach(([o, x, le]) => v.setUint32(o, x, le));
  v.setUint16(22, 2, true);
  assert.deepEqual({ ...WavHeader.readHeader(v) }, { dataOffset: 44, dataLen: 4, channels: 2, sampleRate: 22050 });
});

test('rejects bad arguments', () => {
  assert.throws(() => new Mp3Encoder(3, 44100, 128), RangeError);
  assert.throws(() => new Mp3Encoder(1, 0, 128), RangeError);
  assert.throws(() => new Mp3Encoder(2, 44100, 128).encodeBuffer(new Int16Array(4)), RangeError);
});

test('flush twice returns nothing the second time', () => {
  const enc = new Mp3Encoder(1, 44100, 128);
  enc.encodeBuffer(new Int16Array(5000));
  assert.ok(enc.flush().length > 0);
  assert.equal(enc.flush().length, 0);
});
