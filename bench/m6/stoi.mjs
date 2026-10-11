// Short-Time Objective Intelligibility (Taal et al., 2011, IEEE TASLP 19(7)).
// Standard parameters: 10 kHz, 256-sample Hann frames with 50 % overlap,
// 512-point FFT, 15 one-third-octave bands from 150 Hz, 30-frame (384 ms)
// segments, clipping at β = −15 dB, frames more than 40 dB below the
// reference's loudest frame removed.
//
// Deviation from the reference MATLAB code: silent frames are dropped from
// the STFT frame sequence directly instead of being removed and the signal
// re-synthesised by overlap-add. Scores can differ slightly from pystoi;
// comparisons between methods measured here stay consistent.
import { fft, resample } from './audio.mjs';

const FS = 10000, N_FRAME = 256, NFFT = 512, J = 15, MN = 150, N = 30, BETA = -15, DYN = 40;

function bandMatrix() {
  const bins = NFFT / 2 + 1;
  const freqs = Array.from({ length: bins }, (_, k) => (k * FS) / NFFT);
  const bands = [];
  for (let j = 0; j < J; j++) {
    const cf = MN * 2 ** (j / 3);
    const lo = cf * 2 ** (-1 / 6), hi = cf * 2 ** (1 / 6);
    // Nearest-bin edges, as in the reference implementation.
    const fl = freqs.reduce((b, f, k) => (Math.abs(f - lo) < Math.abs(freqs[b] - lo) ? k : b), 0);
    const fh = freqs.reduce((b, f, k) => (Math.abs(f - hi) < Math.abs(freqs[b] - hi) ? k : b), 0);
    bands.push([fl, fh]);
  }
  return bands;
}
const BANDS = bandMatrix();

/** Hann-windowed frames (hop N_FRAME/2) → per-frame power spectra (NFFT/2+1 bins). */
function frames(x) {
  const hann = Float64Array.from({ length: N_FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (N_FRAME + 1)));
  const out = [];
  for (let s = 0; s + N_FRAME <= x.length; s += N_FRAME / 2) {
    const frame = Float64Array.from({ length: N_FRAME }, (_, i) => x[s + i] * hann[i]);
    out.push(frame);
  }
  return out;
}
function spectrum(frame) {
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  re.set(frame);
  fft(re, im);
  return Float64Array.from({ length: NFFT / 2 + 1 }, (_, k) => re[k] * re[k] + im[k] * im[k]);
}

/**
 * One-third-octave envelopes (Taal 2011, eq. 1) of the reference and the
 * processed signal, over the reference's non-silent frames.
 */
const resampledReference = new WeakMap();
function envelopes(reference, processed, rate) {
  let x = resampledReference.get(reference);
  if (!x) resampledReference.set(reference, (x = resample(reference, rate, FS)));
  const y = resample(processed, rate, FS);
  const len = Math.min(x.length, y.length);
  const fx = frames(x.subarray(0, len)), fy = frames(y.subarray(0, len));
  const energy = fx.map((f) => 20 * Math.log10(Math.sqrt(f.reduce((a, v) => a + v * v, 0)) + 1e-12));
  const peak = Math.max(...energy);
  const keep = energy.map((e) => e > peak - DYN);
  const X = [], Y = [];
  for (let m = 0; m < fx.length; m++) {
    if (!keep[m]) continue;
    const sx = spectrum(fx[m]), sy = spectrum(fy[m]);
    X.push(BANDS.map(([a, b]) => { let e = 0; for (let k = a; k < b; k++) e += sx[k]; return Math.sqrt(e); }));
    Y.push(BANDS.map(([a, b]) => { let e = 0; for (let k = a; k < b; k++) e += sy[k]; return Math.sqrt(e); }));
  }
  if (X.length < N) throw new Error(`STOI needs at least ${N} non-silent frames, got ${X.length}`);
  return { X, Y };
}

/**
 * STOI of `processed` against the clean `reference` (same length, time-aligned,
 * both at `rate` Hz). Returns a value in about [0, 1]; higher = more intelligible.
 */
export function stoi(reference, processed, rate) {
  const { X, Y } = envelopes(reference, processed, rate);
  const clip = 10 ** (-BETA / 20);
  let total = 0, count = 0;
  for (let m = N - 1; m < X.length; m++) {
    for (let j = 0; j < J; j++) {
      const xs = [], ys = [];
      for (let n = m - N + 1; n <= m; n++) (xs.push(X[n][j]), ys.push(Y[n][j]));
      const nx = Math.sqrt(xs.reduce((a, v) => a + v * v, 0)), ny = Math.sqrt(ys.reduce((a, v) => a + v * v, 0)) + 1e-12;
      const yn = ys.map((v, i) => Math.min((v * nx) / ny, xs[i] * (1 + clip)));
      const mx = xs.reduce((a, v) => a + v, 0) / N, my = yn.reduce((a, v) => a + v, 0) / N;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < N; i++) {
        const a = xs[i] - mx, b = yn[i] - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
      }
      total += num / (Math.sqrt(dx * dy) + 1e-12);
      count++;
    }
  }
  return total / count;
}

/** Zero mean, unit norm. */
function standardize(v) {
  const mean = v.reduce((a, x) => a + x, 0) / v.length;
  const c = v.map((x) => x - mean);
  const norm = Math.sqrt(c.reduce((a, x) => a + x * x, 0)) + 1e-12;
  return c.map((x) => x / norm);
}

/**
 * Extended STOI (Jensen & Taal 2016, IEEE/ACM TASLP 24(11)): no clipping;
 * each 384 ms segment is normalised per band over time, then per frame over
 * bands, so it also rewards keeping the spectral shape within a frame. Better
 * than STOI for fluctuating interference (keyboard, babble). Same alignment
 * and length requirements as `stoi`.
 */
export function estoi(reference, processed, rate) {
  const { X, Y } = envelopes(reference, processed, rate);
  const normalise = (S, m) => {
    // rows: band j over the segment's N frames
    const rows = Array.from({ length: J }, (_, j) => standardize(Array.from({ length: N }, (_, i) => S[m - N + 1 + i][j])));
    // columns: frame i over the J bands
    const cols = Array.from({ length: N }, (_, i) => standardize(rows.map((r) => r[i])));
    return cols;
  };
  let total = 0, count = 0;
  for (let m = N - 1; m < X.length; m++) {
    const xn = normalise(X, m), yn = normalise(Y, m);
    let d = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < J; j++) d += xn[i][j] * yn[i][j];
    total += d / N;
    count++;
  }
  return total / count;
}
