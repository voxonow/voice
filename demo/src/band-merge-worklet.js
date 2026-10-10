// AudioWorklet for ?ns=gtcrn-split: GTCRN denoises below 8 kHz (its model runs
// at 16 kHz), and the original's 8–20 kHz band is added back, attenuated by
// the gain GTCRN applied to the low band at that moment.
//
//   input 0: the original signal (48 kHz)
//   input 1: GTCRN's output (48 kHz path; content stops near 8 kHz)
//
// No voice-activity threshold: the high band follows GTCRN's own low-band
// decision through a smoothed energy ratio, so speech the model keeps keeps
// its high band, and what it removes takes its high band with it.
//
// processorOptions.delay: GTCRN's latency in samples on this path (measured
// 1530 at 48 kHz). The original is delayed by it so both bands line up.

const CROSSOVER_HZ = 8000;

/** Second-order Butterworth section (RBJ cookbook). */
function biquad(type, freq, rate) {
  const w = (2 * Math.PI * freq) / rate;
  const cos = Math.cos(w), alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b = type === 'low' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}
function run(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
  return y;
}

class BandMerge extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const delay = options?.processorOptions?.delay ?? 1530;
    this.buffer = new Float32Array(delay + 128);
    this.write = 0;
    this.delay = delay;
    // Linkwitz–Riley 4th order = two cascaded Butterworth sections each side.
    this.low = [biquad('low', CROSSOVER_HZ, sampleRate), biquad('low', CROSSOVER_HZ, sampleRate)];
    this.high = [biquad('high', CROSSOVER_HZ, sampleRate), biquad('high', CROSSOVER_HZ, sampleRate)];
    this.eModel = 0;
    this.eOrig = 0;
    this.gain = 1;
    // Energy averaging ~10 ms; gain rises in ~5 ms (onsets) and falls in ~30 ms.
    const block = 128 / sampleRate;
    this.energyCoef = Math.exp(-block / 0.01);
    this.riseCoef = Math.exp(-block / 0.005);
    this.fallCoef = Math.exp(-block / 0.03);
  }

  process(inputs, outputs) {
    const original = inputs[0]?.[0];
    const model = inputs[1]?.[0];
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    let eModel = 0, eOrig = 0;
    const highBand = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Delay line: what the original was `delay` samples ago.
      const x = original ? original[i] : 0;
      this.buffer[this.write] = x;
      let read = this.write - this.delay;
      if (read < 0) read += this.buffer.length;
      const delayed = this.buffer[read];
      this.write = (this.write + 1) % this.buffer.length;

      const lowOrig = run(this.low[1], run(this.low[0], delayed));
      highBand[i] = run(this.high[1], run(this.high[0], delayed));
      const m = model ? model[i] : 0;
      eModel += m * m;
      eOrig += lowOrig * lowOrig;
    }
    this.eModel = this.energyCoef * this.eModel + (1 - this.energyCoef) * eModel;
    this.eOrig = this.energyCoef * this.eOrig + (1 - this.energyCoef) * eOrig;
    const target = Math.min(1, Math.sqrt((this.eModel + 1e-12) / (this.eOrig + 1e-12)));
    const coef = target > this.gain ? this.riseCoef : this.fallCoef;
    const start = this.gain;
    this.gain = coef * this.gain + (1 - coef) * target;
    for (let i = 0; i < n; i++) {
      // Ramp within the block to avoid zipper noise.
      const g = start + ((this.gain - start) * (i + 1)) / n;
      out[i] = (model ? model[i] : 0) + g * highBand[i];
    }
    return true;
  }
}

registerProcessor('voxonow-band-merge', BandMerge);
