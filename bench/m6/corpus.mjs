// Test corpus for M6: Turkish speech (macOS TTS, voice "Yelda") mixed with
// five kinds of interference at a fixed SNR. Deterministic: same files every
// run. Synthetic noise is a stand-in until real recordings exist (M6 asks for
// recorded keyboard/fan/street/room samples; see docs/ROADMAP.md).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RATE, convolve, readWav, rng, writeWav, rms, speechMask, maskedEnergy } from './audio.mjs';

const LEAD_IN_S = 2; // noise only, before speech starts
const TAIL_S = 1;

const SPEECH =
  'Merhaba, bugünkü toplantıya hoş geldiniz. Önce geçen haftanın sonuçlarına bakalım. ' +
  'Sonra yeni planı konuşacağız. [[slnc 600]] Lütfen sorularınızı sona saklayın. ' +
  'Herkesin mikrofonu açık mı? Sesim net geliyor mu? [[slnc 600]] Teşekkürler, başlayalım.';
const BABBLE = [
  ['Daniel', 'I think we should move the deadline to next Friday, the testing is not finished yet.'],
  ['Samantha', 'Can someone share the document again? I lost the link when my laptop restarted.'],
];

function tts(voice, text, path) {
  const aiff = `${path}.aiff`;
  execFileSync('say', ['-v', voice, '-o', aiff, text]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEF32@48000', '-c', '1', aiff, path]);
  execFileSync('rm', [aiff]);
  return readWav(path);
}

/** One-pole filters over white noise: "pink-ish" and "brown" colours. */
function colouredNoise(n, random, kind) {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = random() * 2 - 1;
    if (kind === 'brown') {
      last = (last + 0.02 * w) / 1.02;
      out[i] = last * 3.5;
    } else {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
  }
  return out;
}

const noises = {
  /** Fan / air conditioner: steady broadband hiss plus a motor hum. */
  fan(n, random) {
    const out = colouredNoise(n, random, 'pink');
    for (let i = 0; i < n; i++) out[i] += 0.15 * Math.sin((2 * Math.PI * 120 * i) / RATE) + 0.05 * Math.sin((2 * Math.PI * 240 * i) / RATE);
    return out;
  },
  /** Keyboard: irregular sharp clicks, ~8 per second, varying strength. */
  keyboard(n, random) {
    const out = new Float32Array(n);
    let t = 0;
    while (t < n) {
      t += Math.floor((0.03 + random() * 0.22) * RATE);
      const amp = 0.3 + random() * 0.7;
      const len = Math.floor((0.004 + random() * 0.01) * RATE);
      let prev = 0;
      for (let k = 0; k < len && t + k < n; k++) {
        const w = random() * 2 - 1;
        const hp = w - prev; // crude high-pass: clicks are bright
        prev = w;
        out[t + k] += amp * hp * Math.exp(-k / (len / 4));
      }
    }
    return out;
  },
  /** Street: low traffic rumble that swells as cars pass, and a car horn. */
  street(n, random) {
    const out = colouredNoise(n, random, 'brown');
    for (let i = 0; i < n; i++) {
      const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * i) / (RATE * 4.3)) * Math.sin((2 * Math.PI * i) / (RATE * 1.7));
      out[i] *= swell;
    }
    for (const at of [0.35, 0.72]) {
      const start = Math.floor(n * at);
      for (let k = 0; k < RATE * 0.45 && start + k < n; k++) {
        const env = Math.min(1, k / 400, (RATE * 0.45 - k) / 400);
        out[start + k] += 0.35 * env * (Math.sign(Math.sin((2 * Math.PI * 415 * k) / RATE)) + Math.sign(Math.sin((2 * Math.PI * 520 * k) / RATE))) * 0.5;
      }
    }
    return out;
  },
};

function fit(x, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i % x.length];
  return out;
}

/**
 * Returns the mix and the speech component exactly as it is inside the mix
 * (after any anti-clipping scale), so metrics compare against what the
 * suppressor actually received.
 */
function mixAtSnr(clean, noise, snrDb) {
  // SNR measured on speech frames only, so pauses do not flatter it.
  const mask = speechMask(clean);
  const speechPower = maskedEnergy(clean, mask, true);
  const noisePower = maskedEnergy(noise, mask, true);
  const gain = Math.sqrt(speechPower / (noisePower * 10 ** (snrDb / 10)));
  const mix = Float32Array.from(clean, (s, i) => s + gain * noise[i]);
  // Keep the whole mix below clipping (16-bit WAV); SNR is unaffected.
  let peak = 0;
  for (const v of mix) peak = Math.max(peak, Math.abs(v));
  const k = peak > 0.9 ? 0.9 / peak : 1;
  return { mix: Float32Array.from(mix, (v) => v * k), speech: Float32Array.from(clean, (v) => v * k) };
}

function normalize(x, peak = 0.8) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  return Float32Array.from(x, (v) => (v / m) * peak);
}

/** Scales `x` so its RMS over speech frames is `targetDb` dBFS. */
function levelSpeech(x, targetDb = -26) {
  const mask = speechMask(x);
  const e = maskedEnergy(x, mask, true) / Math.max(1, mask.filter(Boolean).length * 960);
  const k = 10 ** (targetDb / 20) / Math.sqrt(e);
  return Float32Array.from(x, (v) => v * k);
}

/**
 * Builds the corpus in `dir`: clean.wav (reference) and one noisy file per
 * condition. Returns { clean, conditions: { name: { file, speech } } }.
 *
 * speechFile: use this recording as the speech (any format afconvert reads)
 * instead of the TTS sentence; it is levelled to −26 dBFS over speech frames
 * so runs with different recordings stay comparable.
 */
export function buildCorpus(dir, { snrDb = 5, speechFile } = {}) {
  mkdirSync(dir, { recursive: true });
  let raw;
  if (speechFile) {
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', speechFile, join(dir, '_speech.wav')]);
    raw = levelSpeech(readWav(join(dir, '_speech.wav')));
  } else {
    raw = tts('Yelda', SPEECH, join(dir, '_speech.wav'));
  }
  const lead = new Float32Array(LEAD_IN_S * RATE);
  const tail = new Float32Array(TAIL_S * RATE);
  const clean = speechFile ? Float32Array.from([...lead, ...raw, ...tail]) : normalize(Float32Array.from([...lead, ...raw, ...tail]), 0.5);
  const n = clean.length;
  writeWav(join(dir, 'clean.wav'), clean);

  const conditions = {};
  for (const [name, make] of Object.entries(noises)) {
    const { mix, speech } = mixAtSnr(clean, make(n, rng(name.length * 7919)), snrDb);
    writeWav(join(dir, `${name}.wav`), mix);
    conditions[name] = { file: join(dir, `${name}.wav`), speech };
  }

  // Talking over each other: two other voices at the given SNR.
  let babble = new Float32Array(n);
  BABBLE.forEach(([voice, text], i) => {
    const v = fit(tts(voice, text, join(dir, `_babble${i}.wav`)), n);
    const offset = Math.floor(n * 0.13 * (i + 1));
    for (let k = 0; k < n; k++) babble[k] += v[(k + offset) % n];
  });
  const babbleMix = mixAtSnr(clean, babble, snrDb);
  writeWav(join(dir, 'babble.wav'), babbleMix.mix);
  conditions.babble = { file: join(dir, 'babble.wav'), speech: babbleMix.speech };

  // Echoey room: speech convolved with a synthetic room response (RT60 ≈ 0.6 s)
  // plus light fan noise. The reference stays the dry speech.
  const random = rng(4242);
  const ir = new Float32Array(Math.floor(0.7 * RATE));
  ir[0] = 1;
  for (let k = Math.floor(0.01 * RATE); k < ir.length; k++) ir[k] = (random() * 2 - 1) * 0.35 * Math.exp((-6.9 * k) / (0.6 * RATE));
  const wet = convolve(clean, ir);
  const scale = rms(clean) / rms(wet);
  // The "speech" here is the reverberant speech: suppressors are not asked to
  // dereverberate, so keeping it intact scores 0 dB speech change.
  const room = mixAtSnr(Float32Array.from(wet, (v) => v * scale), noises.fan(n, rng(77)), 20);
  writeWav(join(dir, 'room.wav'), room.mix);
  conditions.room = { file: join(dir, 'room.wav'), speech: room.speech };

  for (const f of ['_speech.wav', '_babble0.wav', '_babble1.wav']) if (existsSync(join(dir, f))) execFileSync('rm', [join(dir, f)]);
  return { clean, conditions, snrDb, durationS: n / RATE };
}
