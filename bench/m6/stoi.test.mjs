// Sanity checks for the STOI implementation and the resampler it relies on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resample, rng } from './audio.mjs';
import { stoi } from './stoi.mjs';

// Speech-like test signal: noise bursts with syllable-rate amplitude modulation
// (strong envelope structure in every band), 4 s at 16 kHz.
const RATE = 16000;
const random = rng(7);
const speech = Float32Array.from({ length: 4 * RATE }, (_, i) => {
  const t = i / RATE;
  const env = Math.max(0, Math.sin(2 * Math.PI * 3.3 * t)) ** 2 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * t));
  return env * (random() * 2 - 1) * 0.5;
});
const white = (gain) => Float32Array.from({ length: speech.length }, () => (random() * 2 - 1) * gain);
const mix = (a, b) => Float32Array.from(a, (v, i) => v + b[i]);

test('identical signals score 1', () => {
  assert.ok(Math.abs(stoi(speech, speech, RATE) - 1) < 1e-6);
});

test('a scaled copy still scores 1 (STOI is level-independent)', () => {
  assert.ok(Math.abs(stoi(speech, Float32Array.from(speech, (v) => v * 0.1), RATE) - 1) < 1e-6);
});

// STOI's clipping step pulls even unrelated noise towards the reference's
// envelope, so noise alone scores clearly above 0 (here ~0.3), not near it.
test('more noise means lower STOI, and noise alone scores lowest', () => {
  const light = stoi(speech, mix(speech, white(0.02)), RATE);
  const heavy = stoi(speech, mix(speech, white(0.3)), RATE);
  const onlyNoise = stoi(speech, white(0.2), RATE);
  assert.ok(light > heavy, `light ${light} > heavy ${heavy}`);
  assert.ok(heavy > onlyNoise, `heavy ${heavy} > noise ${onlyNoise}`);
  assert.ok(onlyNoise < 0.5, `noise alone ${onlyNoise}`);
});

test('resampling round trip keeps a tone', () => {
  const tone = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 48000));
  const back = resample(resample(tone, 48000, 16000), 16000, 48000);
  let err = 0, ref = 0;
  for (let i = 1000; i < 3800; i++) (err += (back[i] - tone[i]) ** 2), (ref += tone[i] ** 2);
  assert.ok(err / ref < 1e-3, `relative error ${err / ref}`);
});

test('downsampling removes content above the new Nyquist', () => {
  const tone = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 7000 * i) / 48000));
  const down = resample(tone, 48000, 10000); // 7 kHz is above 5 kHz Nyquist
  const rms = Math.sqrt(down.slice(500, -500).reduce((a, v) => a + v * v, 0) / (down.length - 1000));
  assert.ok(rms < 0.01, `aliased residue rms ${rms}`);
});
