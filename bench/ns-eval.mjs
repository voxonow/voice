// M6 noise suppression, evaluated on the demo's own code (demo/src/noise.ts).
//
//   npm run bench:ns -- --speech /path/to/recording.m4a     (macOS)
//   options: --skip-live   only the offline layer
//            --only a,b    only these conditions (clean, fan, keyboard, street, babble, room)
//            --chrome      installed Google Chrome instead of Chromium
//
// Same conditions for every method: one clean recording (levelled to −26
// dBFS), the same seeded interference (fan, keyboard, street, babble, room)
// at 5 dB SNR, plus the clean recording alone; the same browser; the same
// encoder settings (client default, 48 kbps).
//
// Layer 1 — offline, method only, exact alignment:
//   STOI (intelligibility), SI-SDR and speech-frame spectral distance
//   (distortion), speech change vs the speech alone (0 dB = kept), noise
//   reduction in pauses, band energies, algorithmic latency, CPU.
// Layer 2 — live: method + Opus + our engine, recorded at a receiver:
//   end-to-end latency (whole-signal alignment, reported as is) and the
//   method's share of it; STOI over 3 s segments aligned within ±10 ms of
//   that latency (jitter-buffer drift only — the latency itself is kept);
//   noise reduction, speech change, band energies.
//
// No single score and no winner: each metric is reported on its own.
// Outputs: bench-results/ns/<timestamp>/ (report.md, results.json, WAVs).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { SignJWT, importPKCS8 } from 'jose';
import { chromium } from '@playwright/test';
import { buildCorpus } from './m6/corpus.mjs';
import { RATE, bestLag, maskedEnergy, powerSpectrum, readWav, resample, shift, siSdr, speechMask, writeWav } from './m6/audio.mjs';
import { stoi } from './m6/stoi.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { values: args } = parseArgs({ options: { speech: { type: 'string' }, 'skip-live': { type: 'boolean' }, chrome: { type: 'boolean' }, only: { type: 'string' } } });
const out = join(root, 'bench-results/ns', new Date().toISOString().replace(/[:.]/g, '-'));
const corpusDir = join(out, 'corpus');
mkdirSync(out, { recursive: true });
const corpus = buildCorpus(corpusDir, { snrDb: 5, ...(args.speech ? { speechFile: resolve(args.speech) } : {}) });
const clean = corpus.clean;
const n = clean.length;
const allConditions = { clean: { file: join(corpusDir, 'clean.wav'), speech: clean }, ...corpus.conditions };
// --only clean,fan : a subset, for quick checks.
const conditions = args.only ? Object.fromEntries(args.only.split(',').map((c) => [c, allConditions[c]])) : allConditions;
const METHODS = ['none', 'rnnoise', 'gtcrn', 'gtcrn-split'];
const mask = speechMask(clean);
const inSpeech = (start) => mask[Math.floor(start / 960)] === true;
console.log(`corpus: ${args.speech ? 'recording' : 'TTS'}, ${corpus.durationS.toFixed(1)} s, conditions: ${Object.keys(conditions).join(', ')}`);

// ---- page + servers ----------------------------------------------------------
await build({ entryPoints: [join(here, 'src/ns-page.ts')], outfile: join(out, 'page.js'), bundle: true, format: 'esm', target: 'chrome110', logLevel: 'warning' });
const nswDir = join(root, 'demo/dist/nsw');
const pagePort = 5193, voicePort = 7836;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/page.js') return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(out, 'page.js')));
  if (path.startsWith('/nsw/')) {
    const name = path.slice(5);
    if (!/^[a-z_-]+\.(js|wasm)$/.test(name)) return void res.writeHead(404).end();
    return void res.writeHead(200, { 'content-type': name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }).end(readFileSync(join(nswDir, name)));
  }
  if (path.startsWith('/corpus/')) {
    const name = path.slice(8);
    if (!/^[a-z]+\.wav$/.test(name)) return void res.writeHead(404).end();
    return void res.writeHead(200, { 'content-type': 'audio/wav' }).end(readFileSync(join(corpusDir, name)));
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><script type="module" src="/page.js"></script>');
}).listen(pagePort, '127.0.0.1');

const decode = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
};

// ---- metrics -----------------------------------------------------------------
const db = (r) => 10 * Math.log10(r);
function bands(signal, speech) {
  const s = powerSpectrum(signal, { include: inSpeech });
  const r = powerSpectrum(speech, { include: inSpeech });
  const band = (lo, hi) => {
    let e = 0, t = 0;
    for (let k = 1; k < s.power.length; k++) {
      const hz = (k * RATE) / s.size;
      if (hz >= lo && hz < hi) (e += s.power[k]), (t += r.power[k]);
    }
    return db(e / t);
  };
  return { b4_8: band(4000, 8000), b8_12: band(8000, 12000), b12_16: band(12000, 16000) };
}
function lsd(a, b) {
  let sum = 0, cnt = 0;
  for (let start = 0; start + 2048 <= a.length; start += 1024) {
    if (!inSpeech(start)) continue;
    const pa = powerSpectrum(a.subarray(start, start + 2048)), pb = powerSpectrum(b.subarray(start, start + 2048));
    let d = 0, m = 0;
    for (let k = 2; k < 1024 && (k * RATE) / 2048 <= 15500; k++) (d += db((pb.power[k] + 1e-12) / (pa.power[k] + 1e-12)) ** 2), m++;
    sum += Math.sqrt(d / m);
    cnt++;
  }
  return sum / cnt;
}
const metrics = (input, output, speech) => ({
  stoi: stoi(clean, output, RATE),
  speechChangeDb: db(maskedEnergy(output, mask, true) / maskedEnergy(speech, mask, true)),
  noiseReductionDb: db(maskedEnergy(input, mask, false) / Math.max(1e-12, maskedEnergy(output, mask, false))),
  ...bands(output, speech),
});
/**
 * Re-aligns each 3 s segment within ±10 ms of `lag`, to undo jitter-buffer
 * drift only; `lag` itself (the real latency) stays in place.
 */
function alignSegments(recorded, lag) {
  const seg = 3 * RATE, search = Math.round(0.01 * RATE);
  const aligned = new Float32Array(n);
  const at = (j) => (j >= 0 && j < recorded.length ? recorded[j] : 0);
  for (let s = 0; s < n; s += seg) {
    const e = Math.min(n, s + seg);
    // recorded[s + lag - search + k + t] ≈ clean[s + t], k in [0, 2·search]
    const from = s + lag - search;
    const window = Float32Array.from({ length: e - s + 2 * search }, (_, i) => at(from + i));
    const k = bestLag(clean.subarray(s, e), window, 0, 2 * search);
    const offset = lag - search + k;
    for (let i = s; i < e; i++) aligned[i] = at(i + offset);
  }
  return aligned;
}

const results = { offline: [], live: [] };
const useChrome = Boolean(args.chrome);
const browser = await chromium.launch({ ...(useChrome ? { channel: 'chrome' } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
let voice;
try {
  const tab = await browser.newPage();
  await tab.goto(`http://127.0.0.1:${pagePort}/`);
  await tab.waitForFunction(() => 'nsEval' in window);

  // ---- layer 1: offline ------------------------------------------------------
  const offlineLag = {};
  for (const method of METHODS) {
    const r = await tab.evaluate(([u, m]) => window.nsEval.offline(u, m), ['/corpus/clean.wav', method]);
    const y = r.rate === RATE ? decode(r.samples) : resample(decode(r.samples), r.rate, RATE);
    offlineLag[method] = bestLag(clean, y, 0, Math.round(0.2 * RATE));
  }
  const baseMs = {};
  for (const [condition, { file, speech }] of Object.entries(conditions)) {
    const input = readWav(file);
    for (const method of METHODS) {
      const r = await tab.evaluate(([u, m]) => window.nsEval.offline(u, m), [`/corpus/${condition}.wav`, method]);
      const y = r.rate === RATE ? decode(r.samples) : resample(decode(r.samples), r.rate, RATE);
      const aligned = shift(y, offlineLag[method], n);
      if (method === 'none') baseMs[condition] = r.renderMs;
      mkdirSync(join(out, 'offline', condition), { recursive: true });
      writeWav(join(out, 'offline', condition, `${method}.wav`), aligned);
      results.offline.push({
        condition,
        method,
        latencyMs: (offlineLag[method] / RATE) * 1000,
        cpuPct: method === 'none' ? 0 : (100 * Math.max(0, r.renderMs - (r.rate === RATE ? baseMs[condition] : 0))) / (corpus.durationS * 1000),
        siSdrDb: siSdr(clean, aligned),
        siSdrInDb: siSdr(clean, input),
        lsdDb: lsd(clean, aligned),
        ...metrics(input, aligned, speech),
      });
      process.stdout.write('.');
    }
  }
  process.stdout.write(' offline done\n');

  // ---- layer 2: live -----------------------------------------------------------
  if (!args['skip-live']) {
    voice = spawn(process.execPath, [join(root, 'server/dist/index.js')], {
      stdio: 'ignore',
      env: { ...process.env, PORT: String(voicePort), NUM_WORKERS: '1', RTC_PORT_BASE: '40360', RTC_ANNOUNCED_ADDRESS: '127.0.0.1', TICKET_PUBLIC_KEY_FILE: join(root, '.dev-keys/ticket-public.pem'), ALLOWED_ORIGINS: `http://127.0.0.1:${pagePort}`, LOG_LEVEL: 'warn' },
    });
    for (let i = 0; ; i++) {
      try { if ((await fetch(`http://localhost:${voicePort}/healthz`)).ok) break; } catch {}
      if (i > 50) throw new Error('voice server did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
    const key = await importPKCS8(readFileSync(join(root, '.dev-keys/ticket-private.pem'), 'utf8'), 'EdDSA');
    const ticket = (room) => new SignJWT({ room, name: 'ns', publish: ['microphone'] }).setProtectedHeader({ alg: 'EdDSA' }).setIssuer('voxonow-api').setAudience('voxonow-voice').setSubject(`ns-${randomUUID()}`).setJti(randomUUID()).setIssuedAt().setExpirationTime('2m').sign(key);
    for (const [condition, { file, speech }] of Object.entries(conditions)) {
      const input = readWav(file);
      let noneShare = 0;
      for (const method of METHODS) {
        const room = `ns-${condition}-${method}-${Date.now()}`;
        const r = await tab.evaluate(([u, t, f, m]) => window.nsEval.live(u, t, f, m), [`ws://localhost:${voicePort}/ws`, [await ticket(room), await ticket(room)], `/corpus/${condition}.wav`, method]);
        const recorded = decode(r.samples), played = decode(r.played), sent = decode(r.sent);
        // All three channels come from one recorder, so their offsets are
        // exact: played → sent is the method's share (including the extra
        // AudioContext hop), sent → received is the network/WebRTC share.
        const playedAt = bestLag(clean, played, 0, 3 * RATE);
        const sentAt = bestLag(clean, sent, 0, 3 * RATE);
        const lag = bestLag(clean, recorded, 0, 3 * RATE);
        const e2e = lag - playedAt;
        // 'none' runs first: its played→sent offset is the cost of the
        // measurement tap itself (one MediaStream → Web Audio hop).
        if (method === 'none') noneShare = sentAt - playedAt;
        const aligned = alignSegments(recorded, lag);
        mkdirSync(join(out, 'live', condition), { recursive: true });
        writeWav(join(out, 'live', condition, `${method}.wav`), aligned);
        results.live.push({
          condition,
          method,
          targetBitrate: r.targetBitrate,
          e2eLagMs: (e2e / RATE) * 1000,
          methodShareMs: ((sentAt - playedAt) / RATE) * 1000,
          networkShareMs: ((lag - sentAt) / RATE) * 1000,
          methodAddedMs: ((sentAt - playedAt - noneShare) / RATE) * 1000,
          ...metrics(input, aligned, speech),
        });
        process.stdout.write('.');
      }
    }
    process.stdout.write(' live done\n');
  }
} finally {
  await browser.close();
  voice?.kill();
  server.close();
}

// ---- report --------------------------------------------------------------------
const f = (v, d = 1) => (v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d));
const avg = (rows, key) => rows.reduce((a, r) => a + r[key], 0) / rows.length;
const lines = [`# M6 noise suppression — ${new Date().toISOString().slice(0, 16)}`, ''];
lines.push(`Speech: ${args.speech ? 'real recording' : 'TTS'} (${corpus.durationS.toFixed(1)} s, −26 dBFS). Interference at 5 dB SNR: fan, keyboard, street, babble, room (synthetic, seeded). ${useChrome ? 'Google Chrome' : 'Headless Chromium'}. Methods use the demo's code (demo/src/noise.ts). No method is ranked; read each metric on its own.`);
const table = (title, rows, cols) => {
  lines.push('', `## ${title}`, '', `| Condition | Method | ${cols.map((c) => c[0]).join(' | ')} |`, `|---|---|${cols.map(() => '---').join('|')}|`);
  for (const r of rows) lines.push(`| ${r.condition} | ${r.method} | ${cols.map(([, k, d]) => f(r[k], d)).join(' | ')} |`);
};
table('Layer 1 — offline (method only)', results.offline, [
  ['STOI', 'stoi', 3], ['SI-SDR dB', 'siSdrDb', 1], ['Spectral dist. dB', 'lsdDb', 2], ['Speech change dB', 'speechChangeDb', 1],
  ['Noise red. dB', 'noiseReductionDb', 1], ['4–8 kHz dB', 'b4_8', 1], ['8–12 kHz dB', 'b8_12', 1], ['12–16 kHz dB', 'b12_16', 1], ['Latency ms', 'latencyMs', 1], ['CPU %', 'cpuPct', 1],
]);
if (results.live.length) table('Layer 2 — live (method + Opus 48 kbps + engine)', results.live, [
  ['STOI', 'stoi', 3], ['Speech change dB', 'speechChangeDb', 1], ['Noise red. dB', 'noiseReductionDb', 1],
  ['4–8 kHz dB', 'b4_8', 1], ['8–12 kHz dB', 'b8_12', 1], ['12–16 kHz dB', 'b12_16', 1], ['End-to-end ms', 'e2eLagMs', 1], ['Added by method vs none ms', 'methodAddedMs', 1], ['Network/WebRTC ms', 'networkShareMs', 1],
]);
lines.push('', 'Bands: speech-frame energy relative to the speech alone (0 dB = kept). "clean" = the recording without added noise: anything a method removes there is speech or the recording\'s own room tone.');
lines.push('Latency (live): "Added by method" = the method\'s played→published offset minus the same offset without a method (that baseline is the measurement tap\'s own MediaStream→Web Audio hop). It includes the demo\'s second AudioContext hop. "Network/WebRTC" varies between sessions (jitter buffer start-up), so end-to-end differences between methods are not attributable to the method alone.');
lines.push('STOI only uses bands up to ~4.3 kHz: it cannot see losses above that (e.g. GTCRN\'s 8 kHz limit) — read it together with the band columns.');
lines.push('Not measured here: Krisp (LiveKit Cloud only), listening quality, Safari/Firefox, phones.');
writeFileSync(join(out, 'report.md'), lines.join('\n') + '\n');
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(lines.join('\n'));
console.log(`\nfiles: ${out}`);
