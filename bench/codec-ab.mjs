// Opus bitrate A/B through our engine (32 vs 48 kbps), same speech, same
// browser, same encoder — only the bitrate differs.
//
//   npm run bench:codec              (headless Chromium, TTS sample)
//   npm run bench:codec -- --chrome  (installed Google Chrome)
//   npm run bench:codec -- --input /path/to/speech.m4a
//                                    (a real recording instead of TTS; any
//                                    format afconvert reads; macOS only)
//
// Writes to bench-results/codec-ab/<timestamp>/ (kept between test runs,
// unlike test-results/ which Playwright clears):
//   original.wav, 32kbps.wav, 48kbps.wav   aligned, for listening
//   report.md / results.json                 measured bitrate and spectra
//
// What it isolates: the codec bitrate. The source is Web Audio, so noise
// suppression / echo cancellation / gain control are not involved; it says
// nothing about live-call noise suppression (that is M6).
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { SignJWT, importPKCS8 } from 'jose';
import { chromium } from '@playwright/test';
import { buildCorpus } from './m6/corpus.mjs';
import { RATE, bestLag, powerSpectrum, readWav, shift, speechMask, writeWav } from './m6/audio.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'bench-results/codec-ab', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(out, { recursive: true });
const { values: args } = parseArgs({ options: { input: { type: 'string' }, chrome: { type: 'boolean' } } });
const corpusDir = join(out, 'corpus');
let sourceLabel;
if (args.input) {
  // A real recording: convert to 48 kHz mono 16-bit, keep its level.
  mkdirSync(corpusDir, { recursive: true });
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', resolve(args.input), join(corpusDir, 'clean.wav')]);
  sourceLabel = `recording "${basename(args.input)}"`;
} else {
  buildCorpus(corpusDir);
  sourceLabel = 'Turkish TTS sample';
}
const original = readWav(join(corpusDir, 'clean.wav'));
const corpus = { durationS: original.length / RATE };
const voicePort = 7834;
const pagePort = 5196;

await build({
  entryPoints: [join(here, 'src/codec-ab.ts')],
  outfile: join(out, 'page.js'),
  bundle: true,
  format: 'esm',
  target: 'chrome110',
  logLevel: 'warning',
});
const page = createServer((req, res) => {
  if (req.url === '/page.js') return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(out, 'page.js')));
  if (req.url === '/clean.wav') return void res.writeHead(200, { 'content-type': 'audio/wav' }).end(readFileSync(join(corpusDir, 'clean.wav')));
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><script type="module" src="/page.js"></script>');
}).listen(pagePort, '127.0.0.1');

const voice = spawn(process.execPath, [join(root, 'server/dist/index.js')], {
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(voicePort),
    NUM_WORKERS: '1',
    RTC_PORT_BASE: '40340',
    RTC_ANNOUNCED_ADDRESS: '127.0.0.1',
    TICKET_PUBLIC_KEY_FILE: join(root, '.dev-keys/ticket-public.pem'),
    ALLOWED_ORIGINS: `http://localhost:${pagePort}`,
    LOG_LEVEL: 'warn',
  },
});
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://localhost:${voicePort}/healthz`)).ok) break;
  } catch {}
  if (i > 50) throw new Error('voice server did not start');
  await new Promise((r) => setTimeout(r, 200));
}
const key = await importPKCS8(readFileSync(join(root, '.dev-keys/ticket-private.pem'), 'utf8'), 'EdDSA');
const ticket = (room) =>
  new SignJWT({ room, name: 'codec-ab', publish: ['microphone'] })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('voxonow-api')
    .setAudience('voxonow-voice')
    .setSubject(`ab-${randomUUID()}`)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(key);

const decode = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
};
const useChrome = Boolean(args.chrome);
const browser = await chromium.launch({ ...(useChrome ? { channel: 'chrome' } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
// Explicit both ways: the client default became 48 kbps on 2026-10-10.
const variants = [
  { name: '32kbps', bitrate: 32_000 },
  { name: '48kbps', bitrate: 48_000 },
];
const results = [];
try {
  const tab = await browser.newPage();
  await tab.goto(`http://localhost:${pagePort}/`);
  await tab.waitForFunction(() => 'codecAB' in window);
  writeWav(join(out, 'original.wav'), original);
  for (const v of variants) {
    const room = `ab-${v.name}-${Date.now()}`;
    const r = await tab.evaluate(
      ([u, t, b]) => window.codecAB.sendAndRecord(u, t, '/clean.wav', b ?? undefined),
      [`ws://localhost:${voicePort}/ws`, [await ticket(room), await ticket(room)], v.bitrate ?? null],
    );
    const recorded = decode(r.samples);
    const lag = bestLag(original, recorded, 0, 3 * RATE);
    const aligned = shift(recorded, lag, original.length);
    writeWav(join(out, `${v.name}.wav`), aligned);
    results.push({ ...v, ...r.stats, sendKbps: (r.stats.bytesSent * 8) / Math.max(1, r.durationS + 1.5) / 1000, aligned });
    process.stdout.write('.');
  }
} finally {
  await browser.close();
  voice.kill();
  page.close();
}
process.stdout.write('\n');

// ---- analysis ------------------------------------------------------------
const mask = speechMask(original);
const inSpeech = (start) => mask[Math.floor(start / 960)] === true;
const ref = powerSpectrum(original, { include: inSpeech });
const hz = (k) => (k * RATE) / ref.size;
const bandDb = (spec, lo, hi) => {
  let e = 0, r = 0;
  for (let k = 1; k < spec.power.length; k++) if (hz(k) >= lo && hz(k) < hi) (e += spec.power[k]), (r += ref.power[k]);
  return 10 * Math.log10(e / r);
};
// The comparison only makes sense where the original has content. macOS TTS
// renders at 22.05 kHz, so the sample stops near 11 kHz; above it the
// original is silent and "relative to original" is meaningless.
const refPeak = Math.max(...ref.power);
let sourceTopHz = 0;
for (let k = 1; k < ref.power.length; k++) if (ref.power[k] > refPeak * 1e-6) sourceTopHz = hz(k);
const topHz = Math.min(20000, Math.floor(sourceTopHz / 500) * 500);
/** Energy the codec put above the source's band, relative to the received in-band energy. */
const addedAboveDb = (spec) => {
  let above = 0, inBand = 0;
  for (let k = 1; k < spec.power.length; k++) (hz(k) > sourceTopHz + 500 ? (above += spec.power[k]) : hz(k) >= 50 && (inBand += spec.power[k]));
  return 10 * Math.log10((above + 1e-20) / inBand);
};
/** Log-spectral distance (dB) over speech frames, 50 Hz up to the source's top. */
function lsd(x) {
  const size = 2048, step = 1024;
  let sum = 0, n = 0;
  for (let start = 0; start + size <= x.length; start += step) {
    if (!inSpeech(start)) continue;
    const a = powerSpectrum(original.subarray(start, start + size), { size });
    const b = powerSpectrum(x.subarray(start, start + size), { size });
    let d = 0, m = 0;
    for (let k = 1; k < size / 2; k++) {
      if (hz(k) < 50 || hz(k) > topHz) continue;
      d += (10 * Math.log10((b.power[k] + 1e-12) / (a.power[k] + 1e-12))) ** 2;
      m++;
    }
    sum += Math.sqrt(d / m);
    n++;
  }
  return sum / n;
}
const lines = [];
lines.push(`# Opus bitrate A/B — ${new Date().toISOString().slice(0, 16)}`);
lines.push('');
lines.push(`${useChrome ? 'Google Chrome' : 'Headless Chromium'}, our engine, same ${sourceLabel} (${corpus.durationS.toFixed(1)} s), Web Audio source (no AEC/NS/AGC). Differences vs the original, speech frames only.`);
lines.push('');
lines.push(`**Source bandwidth: ${(sourceTopHz / 1000).toFixed(1)} kHz.** Comparisons are limited to 50 Hz – ${(topHz / 1000).toFixed(1)} kHz. ${sourceTopHz < 15000 ? 'This sample cannot show differences above that — where Opus bitrate matters most; a full-band (48 kHz) speech recording is needed for that.' : ''}`);
lines.push('');
lines.push(`| Variant | Encoder target | Sent (avg incl. silence) | Energy 0.05–4 kHz | 4–8 kHz | 8–${(topHz / 1000).toFixed(1)} kHz | Log-spectral distance | Added above source band | Jitter-buffer stretch | Lost |`);
lines.push('|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const spec = powerSpectrum(r.aligned, { include: inSpeech });
  r.metrics = {
    band0_4: bandDb(spec, 50, 4000),
    band4_8: bandDb(spec, 4000, 8000),
    band8_top: bandDb(spec, 8000, topHz),
    lsdDb: lsd(r.aligned),
    addedAboveDb: addedAboveDb(spec),
    sourceTopHz,
  };
  const m = r.metrics;
  lines.push(
    `| ${r.name} | ${r.targetBitrate ? r.targetBitrate / 1000 + ' kbps' : '–'} | ${r.sendKbps.toFixed(1)} kbps | ${m.band0_4.toFixed(1)} dB | ${m.band4_8.toFixed(1)} dB | ${m.band8_top.toFixed(1)} dB | ${m.lsdDb.toFixed(2)} dB | ${m.addedAboveDb.toFixed(1)} dB | +${((r.inserted / RATE) * 1000).toFixed(0)} / −${((r.removed / RATE) * 1000).toFixed(0)} ms | ${r.lost} |`,
  );
}
lines.push('');
lines.push('Band energies are relative to the original (0 dB = unchanged; negative = removed by the codec). Listen to original.wav, 32kbps.wav and 48kbps.wav in this folder — objective numbers do not replace listening.');
writeFileSync(join(out, 'report.md'), lines.join('\n') + '\n');
writeFileSync(join(out, 'results.json'), JSON.stringify(results.map(({ aligned, ...r }) => r), null, 2));
console.log(lines.join('\n'));
console.log(`\nfiles: ${out}`);
