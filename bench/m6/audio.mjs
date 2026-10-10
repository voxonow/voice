// WAV I/O and the few DSP pieces the M6 benchmark needs (FFT, convolution,
// cross-correlation, metrics). Mono, 48 kHz, Float32 throughout.
import { readFileSync, writeFileSync } from 'node:fs';

export const RATE = 48000;

export function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not WAV`);
  let off = 12;
  let fmt;
  while (off < b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data before fmt');
      const frames = size / (fmt.bits / 8) / fmt.channels;
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const p = body + i * fmt.channels * (fmt.bits / 8);
        out[i] = fmt.format === 3 ? b.readFloatLE(p) : fmt.bits === 16 ? b.readInt16LE(p) / 32768 : b.readInt32LE(p) / 2147483648;
      }
      if (fmt.rate !== RATE) throw new Error(`${path}: ${fmt.rate} Hz, expected ${RATE}`);
      return out;
    }
    off = body + size + (size & 1);
  }
  throw new Error(`${path}: no data chunk`);
}

/** 16-bit PCM: what every player opens. Clips to [-1, 1]. */
export function writeWav(path, samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  writeFileSync(path, b);
}

/** Deterministic PRNG, so the corpus is identical on every run. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- FFT (iterative radix-2, in place) ---------------------------------------
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n);
}

const pow2 = (n) => 2 ** Math.ceil(Math.log2(n));

/** Linear convolution via one big FFT. */
export function convolve(x, h) {
  const n = pow2(x.length + h.length - 1);
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(x);
  br.set(h);
  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    ai[i] = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r;
  }
  fft(ar, ai, true);
  return Float32Array.from(ar.subarray(0, x.length));
}

/**
 * Lag (samples) at which `y` best matches `x`, i.e. y[t + lag] ≈ x[t], searched
 * in [minLag, maxLag].
 */
export function bestLag(x, y, minLag, maxLag) {
  const n = pow2(x.length + y.length);
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(x);
  br.set(y);
  fft(ar, ai);
  fft(br, bi);
  // corr[k] = sum x[t] y[t + k]  →  conj(X) · Y
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    ai[i] = ar[i] * bi[i] - ai[i] * br[i];
    ar[i] = r;
  }
  fft(ar, ai, true);
  let best = minLag;
  let bestValue = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = ar[(lag + n) % n];
    if (v > bestValue) (bestValue = v), (best = lag);
  }
  return best;
}

/** y shifted so that out[t] = y[t + lag], zero-padded, same length as `length`. */
export function shift(y, lag, length) {
  const out = new Float32Array(length);
  for (let t = 0; t < length; t++) {
    const i = t + lag;
    if (i >= 0 && i < y.length) out[t] = y[i];
  }
  return out;
}

const energy = (x, from = 0, to = x.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return e;
};

/** 20 ms frames where the clean reference is speech (within 40 dB of its loudest frame). */
export function speechMask(clean, frame = 960) {
  const frames = Math.floor(clean.length / frame);
  const e = Array.from({ length: frames }, (_, f) => energy(clean, f * frame, (f + 1) * frame) / frame);
  const peak = Math.max(...e);
  return e.map((v) => v > peak * 1e-4);
}

/** Scale-invariant SDR (dB) of `est` against `ref`. */
export function siSdr(ref, est) {
  let dot = 0;
  let rr = 0;
  for (let i = 0; i < ref.length; i++) (dot += ref[i] * est[i]), (rr += ref[i] * ref[i]);
  const a = dot / rr;
  let target = 0;
  let error = 0;
  for (let i = 0; i < ref.length; i++) {
    const t = a * ref[i];
    target += t * t;
    error += (est[i] - t) ** 2;
  }
  return 10 * Math.log10(target / error);
}

/** Energy over the frames selected by `mask` (true = include). */
export function maskedEnergy(x, mask, select, frame = 960) {
  let e = 0;
  mask.forEach((isSpeech, f) => {
    if (isSpeech === select) e += energy(x, f * frame, (f + 1) * frame);
  });
  return e;
}

export const db = (ratio) => 10 * Math.log10(ratio);
export const rms = (x) => Math.sqrt(energy(x) / x.length);
