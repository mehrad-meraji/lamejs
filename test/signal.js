// Deterministic test signal: tones, noise and clicks (the clicks force short blocks).
export function signal(n, seed) {
  const out = new Int16Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const noise = (s / 0x100000000 - 0.5) * 3000;
    const click = i % 9000 < 40 ? 20000 * Math.sin(i * 1.3) : 0;
    const silent = i % 30000 > 26000;
    out[i] = silent ? 0 : Math.max(-32768, Math.min(32767, Math.sin(i * 0.05 * (1 + seed)) * 9000 + Math.sin(i * 0.31) * 3000 + noise + click));
  }
  return out;
}

export const cases = [];
for (const [rate, kbpsList] of [
  [8000, [8, 32, 64]], [11025, [16, 48]], [12000, [24, 64]],
  [16000, [32, 64, 160]], [22050, [48, 96]], [24000, [64, 128]],
  [32000, [64, 160]], [44100, [32, 128, 192, 320]], [48000, [96, 128, 256]],
  [44000, [128]], [96000, [128]], [44100, [7]], [8000, [320]],
]) for (const kbps of kbpsList) for (const channels of [1, 2]) cases.push({ rate, kbps, channels });

// Feeds the encoder in a few chunk sizes so buffering edge cases are covered.
export function encodeWith(Mp3Encoder, { rate, kbps, channels }) {
  const n = Math.round(rate * 1.5) + 123;
  const left = signal(n, 1), right = signal(n, 2);
  const enc = new Mp3Encoder(channels, rate, kbps);
  const chunks = [];
  const sizes = [1152, 1000, 4097, 1];
  for (let i = 0, k = 0; i < n; k++) {
    const end = Math.min(n, i + sizes[k % sizes.length]);
    const l = left.subarray(i, end);
    chunks.push(channels === 2 ? enc.encodeBuffer(l, right.subarray(i, end)) : enc.encodeBuffer(l));
    i = end;
  }
  chunks.push(enc.flush());
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const mp3 = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { mp3.set(new Uint8Array(c.buffer, c.byteOffset, c.length), o); o += c.length; }
  return mp3;
}
