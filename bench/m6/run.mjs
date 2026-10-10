// M6 noise suppression comparison (objective part).
//
//   npm run bench:m6            (after npm install; needs macOS for the TTS corpus)
//
// For every interference condition (fan, keyboard, street, babble, room) and
// every candidate (Chrome's built-in WebRTC suppression, RNNoise, Speex,
// GTCRN, DeepFilterNet3) it measures, against the clean reference:
//   - noise reduction in speech pauses (dB, higher = quieter background)
//   - speech level change in speech frames (dB, near 0 = speech kept)
//   - SI-SDR and its improvement over the noisy input (dB; distortion-aware)
//   - added latency (ms, from cross-correlation alignment)
//   - CPU as real-time factor on this machine (offline candidates)
// and writes every output as WAV for listening (naturalness, artefacts):
// objective scores do not replace the listening test.
//
// Network loss/RED is deliberately NOT part of this: lossless, offline only.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { buildCorpus } from './corpus.mjs';
import { RATE, bestLag, db, maskedEnergy, readWav, shift, siSdr, speechMask, writeWav } from './audio.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const out = join(root, 'test-results/m6');
const corpusDir = join(out, 'corpus');
const listenDir = join(out, 'listen');
const PORT = 5261;
const OFFLINE = ['rnnoise', 'speex', 'gtcrn', 'deepfilternet3'];
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const corpus = buildCorpus(corpusDir, { snrDb: 5 });
const mask = speechMask(corpus.clean);
const n = corpus.clean.length;
console.log(`corpus: ${Object.keys(corpus.conditions).length} conditions, ${corpus.durationS.toFixed(1)} s each, SNR ${corpus.snrDb} dB`);

await build({
  entryPoints: [join(here, 'page.ts')],
  outfile: join(out, 'page.js'),
  bundle: true,
  format: 'esm',
  target: 'chrome110',
  logLevel: 'error',
});
const nsw = join(root, 'node_modules/@sapphi-red/web-noise-suppressor/dist');
const routes = {
  '/': ['<!doctype html><script type="module" src="/page.js"></script>', 'text/html'],
  '/page.js': [join(out, 'page.js'), 'text/javascript'],
  '/nsw/rnnoise.js': [join(nsw, 'rnnoise/workletProcessor.js'), 'text/javascript'],
  '/nsw/speex.js': [join(nsw, 'speex/workletProcessor.js'), 'text/javascript'],
  '/nsw/gtcrn.js': [join(nsw, 'gtcrn/workletProcessor.js'), 'text/javascript'],
  '/nsw/rnnoise.wasm': [join(nsw, 'rnnoise.wasm'), 'application/wasm'],
  '/nsw/rnnoise_simd.wasm': [join(nsw, 'rnnoise_simd.wasm'), 'application/wasm'],
  '/nsw/speex.wasm': [join(nsw, 'speex.wasm'), 'application/wasm'],
  '/nsw/gtcrn.wasm': [join(nsw, 'gtcrn.wasm'), 'application/wasm'],
  '/dfn/df_bg.wasm': [join(root, 'node_modules/@lofcz/deepfilternet-web/dist/df_bg.wasm'), 'application/wasm'],
};
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/corpus/')) {
    res.writeHead(200, { 'content-type': 'audio/wav' }).end(readFileSync(join(corpusDir, path.slice(8))));
    return;
  }
  const route = routes[path];
  if (!route) return void res.writeHead(404).end();
  const [body, type] = route;
  res.writeHead(200, { 'content-type': type }).end(body.startsWith('<') ? body : readFileSync(body));
}).listen(PORT, '127.0.0.1');
const base = `http://127.0.0.1:${PORT}/`;

const decode = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
};

/**
 * @param input what the suppressor received
 * @param output what it produced (aligned)
 * @param speech the speech component inside `input` (same scale as input)
 */
function metrics(input, output, speech) {
  return {
    noiseReductionDb: db(maskedEnergy(input, mask, false) / Math.max(1e-12, maskedEnergy(output, mask, false))),
    // Output energy in speech frames vs. the speech alone: a perfect
    // suppressor scores 0 dB (noise gone, speech intact); below 0 = speech lost.
    speechChangeDb: db(Math.max(1e-12, maskedEnergy(output, mask, true)) / maskedEnergy(speech, mask, true)),
    siSdrDb: siSdr(corpus.clean, output),
    siSdrInputDb: siSdr(corpus.clean, input),
  };
}

const scaled = (x, k) => Float32Array.from(x, (v) => v * k);
const results = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(base);
  await page.waitForFunction(() => 'm6' in window);
  // Latency per candidate, measured once on clean speech (noise can mislead
  // the alignment); every condition is then aligned with this fixed lag.
  const lagOf = {};
  for (const kind of OFFLINE) {
    const r = await page.evaluate(([u, k]) => window.m6.processOffline(u, k), ['/corpus/clean.wav', kind]);
    // A suppressor cannot answer before it is spoken to: lags start at 0.
    lagOf[kind] = bestLag(corpus.clean, decode(r.samples), 0, Math.round(0.2 * RATE));
  }
  for (const [condition, { file, speech }] of Object.entries(corpus.conditions)) {
    if (only.length && !only.includes(condition)) continue;
    const input = readWav(file);
    mkdirSync(join(listenDir, condition), { recursive: true });
    writeWav(join(listenDir, condition, '0-clean.wav'), corpus.clean);
    writeWav(join(listenDir, condition, '1-noisy.wav'), input);
    const baseline = await page.evaluate((u) => window.m6.processOffline(u, 'none'), `/corpus/${condition}.wav`);
    for (const kind of OFFLINE) {
      const r = await page.evaluate(([u, k]) => window.m6.processOffline(u, k), [`/corpus/${condition}.wav`, kind]);
      const lag = lagOf[kind];
      const aligned = shift(decode(r.samples), lag, n);
      writeWav(join(listenDir, condition, `${kind}.wav`), aligned);
      const cpuMs = Math.max(0, r.renderMs - (kind === 'deepfilternet3' ? 0 : baseline.renderMs));
      results.push({ condition, kind, latencyMs: (lag / RATE) * 1000, rtf: cpuMs / (corpus.durationS * 1000), ...metrics(input, aligned, speech) });
      process.stdout.write('.');
    }
  }
} finally {
  await browser.close();
}

// Chrome's built-in suppression: the noisy file becomes the fake microphone,
// recorded with suppression off and on as two channels of one recorder.
async function chromePair(file) {
  const b = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${file}%noloop`],
  });
  try {
    const page = await (await b.newContext({ permissions: ['microphone'] })).newPage();
    await page.goto(base);
    await page.waitForFunction(() => 'm6' in window);
    const pair = await page.evaluate((s) => window.m6.captureMicPair(s), corpus.durationS + 2.5);
    if (pair[0].noiseSuppression !== false || pair[1].noiseSuppression !== true) {
      throw new Error(`Chrome did not honour the constraints: ${JSON.stringify(pair.map((p) => p.noiseSuppression))}`);
    }
    return pair.map((p) => decode(p.samples));
  } finally {
    await b.close();
  }
}
// Each getUserMedia opens the fake device anew and replays the file from its
// start, so the two tracks do not share a timeline: Chrome's added latency
// cannot be measured this way and is reported as such. Each track is aligned
// to the clean reference on its own — enough for the energy metrics, which
// work on 20 ms frames.
for (const [condition, { file, speech }] of Object.entries(corpus.conditions)) {
  if (only.length && !only.includes(condition)) continue;
  const [offRaw, onRaw] = await chromePair(file);
  const off = shift(offRaw, bestLag(corpus.clean, offRaw, 0, 4 * RATE), n);
  const on = shift(onRaw, bestLag(corpus.clean, onRaw, 0, 4 * RATE), n);
  writeWav(join(listenDir, condition, 'chrome-builtin.wav'), on);
  results.push({
    condition,
    kind: 'chrome-builtin',
    latencyMs: undefined,
    rtf: undefined,
    // Relative to the same capture path with suppression off. SI-SDR is left
    // out: Chrome's fake-capture path jitters by a few samples (±0.1 ms,
    // inaudible), which SI-SDR punishes as distortion.
    // The capture path may scale the file; scale the speech reference with it.
    ...metrics(off, on, scaled(speech, Math.sqrt(maskedEnergy(off, mask, true) / maskedEnergy(readWav(file), mask, true)))),
    siSdrDb: undefined,
    siSdrInputDb: undefined,
  });
  process.stdout.write('.');
}
server.close();
process.stdout.write('\n');

// ---- report --------------------------------------------------------------
// Chrome's row is kept out of the comparison table: its capture-path numbers
// moved between runs (noise reduction 6–12 dB over four runs of the same
// files), while the offline candidates were identical every run.
const kinds = OFFLINE;
const avg = (xs) => {
  const v = xs.filter((x) => x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
};
const sdrGain = (x) => (x.siSdrDb === undefined ? undefined : x.siSdrDb - x.siSdrInputDb);
const f = (v, d = 1) => (v === undefined || Number.isNaN(v) ? '–' : v.toFixed(d));
const lines = [];
lines.push(`# M6 objective comparison — ${new Date().toISOString().slice(0, 10)}`);
lines.push('');
lines.push(`Corpus: Turkish TTS speech ("Yelda") + synthetic interference at ${corpus.snrDb} dB SNR, ${corpus.durationS.toFixed(1)} s per condition; room = synthetic reverb (RT60 ≈ 0.6 s). Machine: this Mac, headless Chromium.`);
lines.push('');
lines.push('| Candidate | Noise reduction in pauses (dB) | Speech level change (dB) | SI-SDR improvement (dB) | Added latency (ms) | CPU (% of one core, real time) |');
lines.push('|---|---|---|---|---|---|');
for (const kind of kinds) {
  const r = results.filter((x) => x.kind === kind);
  if (!r.length) continue;
  lines.push(
    `| ${kind} | ${f(avg(r.map((x) => x.noiseReductionDb)))} | ${f(avg(r.map((x) => x.speechChangeDb)))} | ${f(avg(r.map(sdrGain)))} | ${f(avg(r.map((x) => x.latencyMs)), 0)} | ${r[0].rtf === undefined ? '–' : f(avg(r.map((x) => x.rtf * 100)))} |`,
  );
}
lines.push('');
lines.push('Per condition — SI-SDR improvement (dB) / noise reduction in pauses (dB):');
lines.push('');
lines.push(`| Condition | ${kinds.join(' | ')} |`);
lines.push(`|---|${kinds.map(() => '---').join('|')}|`);
for (const condition of Object.keys(corpus.conditions)) {
  const row = kinds.map((kind) => {
    const r = results.find((x) => x.kind === kind && x.condition === condition);
    return r ? `${f(sdrGain(r))} / ${f(r.noiseReductionDb)}` : '–';
  });
  lines.push(`| ${condition} | ${row.join(' | ')} |`);
}
lines.push('');
{
  const r = results.filter((x) => x.kind === 'chrome-builtin');
  if (r.length) {
    lines.push(
      `chrome-builtin (NOT comparable — unstable between runs): noise reduction this run ${f(avg(r.map((x) => x.noiseReductionDb)))} dB, speech change ${f(avg(r.map((x) => x.speechChangeDb)))} dB; per condition ${r.map((x) => `${x.condition} ${f(x.noiseReductionDb)}`).join(', ')}.`,
    );
    lines.push('');
  }
}
lines.push('chrome-builtin: measured through Chrome\'s real capture path (file as fake microphone, suppression off vs on). Not reported for it: SI-SDR (that path jitters by a few samples, which SI-SDR scores as distortion although inaudible), latency (each capture replays the file from its own start, so there is no shared timeline), CPU (not separable from Chrome\'s audio service).');
lines.push('');
lines.push('Offline candidates: latency measured once per candidate on clean speech, through the same AudioWorklet path a live call uses (128-sample render quanta), and used to align every condition. CPU = render time / audio duration on this Mac (Apple Silicon); phones will differ.');
lines.push('');
lines.push(`Listening files: ${listenDir}/<condition>/ (0-clean, 1-noisy, then one file per candidate).`);
writeFileSync(join(out, 'report.md'), lines.join('\n') + '\n');
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(lines.join('\n'));
