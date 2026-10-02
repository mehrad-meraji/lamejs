// node test/bench.js [module path] — encodes 60 s of 44.1 kHz stereo at 128 kbps, best of 5.
import { encodeWith } from './signal.js';
const { Mp3Encoder } = await import(process.argv[2] ?? '../dist/index.js');
const c = { rate: 44100, kbps: 128, channels: 2 };
const best = [];
for (let r = 0; r < 5; r++) {
  const t = performance.now();
  for (let i = 0; i < 40; i++) encodeWith(Mp3Encoder, c); // 40 × 1.5 s = 60 s of audio
  best.push(performance.now() - t);
}
console.log(`${Math.min(...best).toFixed(0)} ms for 60 s of audio`);
