// Capture-chain evaluation: the product's real microphone path, minus the
// physical microphone. Google Chrome is given a WAV as its fake capture device,
// so every condition goes through getUserMedia and Chrome's own capture
// processing, then (optionally) a suppressor, Opus and the engine, and is
// recorded at a receiver in the same page (bench/src/capture-page.ts).
//
//   npm run bench:capture -- --speech /path/recording.wav [--repeats 3]
//     --tts              macOS TTS instead of a recording (smoke runs only:
//                        TTS stops near 10 kHz)
//     --chains a,b       subset of CHAINS below (Krisp and cloud chains run
//                        only when named here)
//     --conditions a,b   subset of the condition list printed at start
//     --quick            clean + fan only, for a smoke run
//     --out <dir>        output directory; must not exist yet
//     --check            run the configuration and safety checks, print the
//                        plan, start nothing
//
// Usage, the safety model for LiveKit Cloud and where the speech recording
// comes from: docs/CAPTURE-BENCH.md.
//
// Why this exists (docs/ROADMAP.md M6): bench/ns-eval.mjs feeds a Web Audio
// source straight into the encoder, so browser processing — and its
// interaction with a suppressor of ours or Krisp — was never in the measured
// path. Chrome's processing also adapts (noise estimate, gain), so a single
// run is not a result: each (chain, condition) is repeated and reported as
// median [min–max].
//
// LiveKit runs as a local server (Docker, same version as team-comms). Krisp
// cannot be enabled there: the filter asks the LiveKit server whether
// enhanced noise cancellation is allowed, and only LiveKit Cloud says yes. The
// livekit-krisp chain records that outcome instead of pretending to measure
// Krisp. Firefox and Safari have no file-fed capture device: not covered.
//
// Output: bench-results/capture/<timestamp>/ (report.md, results.json, WAVs).
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { SignJWT, importPKCS8 } from 'jose';
import { chromium } from '@playwright/test';
import { buildCorpus } from './m6/corpus.mjs';
import { RATE, bestLag, maskedEnergy, powerSpectrum, readWav, speechMask, writeWav } from './m6/audio.mjs';
import { estoi, stoi } from './m6/stoi.mjs';
import {
  BENCH_ROOM_PREFIX,
  KRISP_PACKAGE,
  Refused,
  actualSuppressor,
  describeChain,
  krispActive,
  parseEnvFile,
  redactor,
  resolveCloudTarget,
  resolveKrisp,
  selectChains,
  verifyDedicatedProject,
} from './capture-config.mjs';

// Every error leaves through here, with the cloud target's host, key and
// secret (once known) and any token removed, and with whatever was started
// stopped. Exit 2: a check refused, nothing was started.
let redact = redactor([]);
let stopAll = () => {};
process.on('uncaughtException', (error) => {
  stopAll();
  if (error instanceof Refused) {
    console.error(`capture-eval: refused — ${redact(error.message)}`);
    process.exit(2);
  }
  console.error(`capture-eval: ${redact(error?.stack ?? error)}`);
  process.exit(1);
});
process.on('SIGINT', () => (stopAll(), process.exit(130)));

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { values: args } = parseArgs({
  options: {
    speech: { type: 'string' },
    tts: { type: 'boolean' },
    repeats: { type: 'string', default: '3' },
    chains: { type: 'string' },
    conditions: { type: 'string' },
    quick: { type: 'boolean' },
    lead: { type: 'string', default: '8' },
    out: { type: 'string' },
    check: { type: 'boolean' },
  },
});
const REPEATS = Number(args.repeats);
const LEAD_S = Number(args.lead); // noise only before the corpus starts: lets adaptive processing (and a processor attach) settle
if (!(REPEATS >= 1) || !(LEAD_S >= 0)) throw new Refused('--repeats must be ≥ 1 and --lead ≥ 0');
const LIVEKIT_IMAGE = 'livekit/livekit-server:v1.13.7';

// The product's constraints (team-comms voice-bar.tsx, all three on by default)
// and the "raw" reference with browser processing off.
const PRODUCT = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const NS_OFF = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const CHAINS = {
  // Codec + engine only; the closest thing to a reference for our encoder path.
  'ours-raw': { engine: 'ours', constraints: RAW },
  // What our engine would do today with the product's settings and no suppressor.
  'ours-product': { engine: 'ours', constraints: PRODUCT },
  // The demo's ?ns=rnnoise chain: browser NS on, RNNoise on top.
  'ours-rnnoise-nson': { engine: 'ours', constraints: PRODUCT, method: 'rnnoise' },
  // RNNoise as the only suppressor (browser NS off, AEC/AGC on).
  'ours-rnnoise-nsoff': { engine: 'ours', constraints: NS_OFF, method: 'rnnoise' },
  // LiveKit with team-comms' settings, no Krisp (= Voxonow when Krisp is unsupported).
  'livekit-product': { engine: 'livekit', constraints: PRODUCT },
  // LiveKit + Krisp as team-comms attaches it — local server: see header.
  'livekit-krisp': { engine: 'livekit', constraints: PRODUCT, krisp: true, krispCheckOnly: true },
  // A separate LiveKit Cloud test project (never production): the only place
  // Krisp actually runs. Opt-in only (--chains), and only after the checks in
  // capture-config.mjs (docs/CAPTURE-BENCH.md). Its latency includes the
  // internet path to LiveKit's edge, so only quality columns compare with the
  // local chains.
  'cloud-product': { engine: 'livekit', cloud: true, constraints: PRODUCT },
  'cloud-krisp': { engine: 'livekit', cloud: true, constraints: PRODUCT, krisp: true },
};

// ---- checks (nothing is started, written or contacted before these pass) --------
const chains = selectChains(args.chains, CHAINS);
if (args.speech && args.tts) throw new Refused('--speech and --tts exclude each other');
if (!args.speech && !args.tts) throw new Refused('--speech <recording> is required (real speech; see docs/CAPTURE-BENCH.md), or --tts for a smoke run');
const speechFile = args.speech ? resolve(args.speech) : undefined;
if (speechFile && !existsSync(speechFile)) throw new Refused('--speech: file not found');
// Identifies the recording in results without its path (paths can name people).
const speech = speechFile
  ? { kind: 'recording', sha256: createHash('sha256').update(readFileSync(speechFile)).digest('hex').slice(0, 16) }
  : { kind: 'tts', note: 'macOS TTS, content ends near 10 kHz — smoke run, not comparable with recordings' };

const krispChains = chains.filter((c) => CHAINS[c].krisp);
const krisp = krispChains.length ? resolveKrisp({ chainNames: krispChains, env: process.env, root, readText: (p) => readFileSync(p, 'utf8') }) : undefined;

const cloudChains = chains.filter((c) => CHAINS[c].cloud);
let cloud;
if (cloudChains.length) {
  const benchFile = join(process.env.HOME ?? '', '.config/voxonow-bench/livekit.env');
  const teamComms = process.env.TEAM_COMMS_DIR || join(root, '../team-comms');
  // Application LiveKit settings visible from here: this process' environment
  // and team-comms' .env files. The bench target must differ from all of them.
  const appConfigs = [{ source: 'the environment', values: process.env }];
  if (existsSync(teamComms)) {
    for (const f of readdirSync(teamComms).filter((n) => /^\.env/.test(n))) appConfigs.push({ source: `team-comms ${f}`, values: parseEnvFile(readFileSync(join(teamComms, f), 'utf8')) });
  }
  cloud = resolveCloudTarget({ env: process.env, benchFileText: existsSync(benchFile) ? readFileSync(benchFile, 'utf8') : undefined, appConfigs });
  redact = redactor([cloud.host, cloud.key, cloud.secret]);
}

// Conditions: one base corpus (5 dB SNR, −26 dBFS, desk-distance room) plus a
// fan sweep over SNR and input level (built below, after the checks).
const variants = [
  { tag: '', snrDb: 5, levelDb: -26 },
  { tag: '@0dB', snrDb: 0, levelDb: -26, only: ['fan'] },
  { tag: '@15dB', snrDb: 15, levelDb: -26, only: ['fan'] },
  { tag: '@-36dBFS', snrDb: 5, levelDb: -36, only: ['fan'] },
  { tag: '@-16dBFS', snrDb: 5, levelDb: -16, only: ['fan'] },
];
const BASE_CONDITIONS = ['clean', 'fan', 'keyboard', 'street', 'babble', 'room']; // bench/m6/corpus.mjs
const conditionNames = variants.flatMap((v) => (v.only ?? BASE_CONDITIONS).map((n) => n + v.tag));
const quick = ['clean', 'fan'];
const wanted = args.conditions?.split(',').map((c) => c.trim()).filter(Boolean);
for (const c of wanted ?? []) if (!conditionNames.includes(c)) throw new Refused(`unknown condition "${c}"; known: ${conditionNames.join(', ')}`);
const selected = conditionNames.filter((c) => (wanted ? wanted.includes(c) : !args.quick || quick.includes(c)));
if (!selected.length) throw new Refused('--conditions selects no condition');

const out = resolve(args.out ?? join(root, 'bench-results/capture', new Date().toISOString().replace(/[:.]/g, '-')));
if (existsSync(out)) throw new Refused('output directory already exists; results are never overwritten');

const chainInfo = Object.fromEntries(chains.map((n) => [n, describeChain(CHAINS[n], { livekitVersion: LIVEKIT_IMAGE.split(':')[1], krisp })]));
console.log(`conditions: ${selected.join(', ')}  repeats: ${REPEATS}\nspeech: ${speech.kind}${speech.sha256 ? ` sha256:${speech.sha256}` : ''}\nchains:\n${chains.map((n) => `  ${n}: ${chainInfo[n]}`).join('\n')}`);
if (krisp) console.log(`Krisp: ${KRISP_PACKAGE} ${krisp.version} (from outside this repo)`);
if (cloud) console.log('LiveKit Cloud: explicitly configured test target, static checks passed');
if (args.check) {
  console.log('--check: configuration and safety checks passed; nothing started.');
  process.exit(0);
}

// A server already listening on one of the bench's ports would answer the
// health checks below and be measured in place of ours: refuse instead.
const pagePort = 5194, voicePort = 7837, lkPort = 7892, lkTcpPort = 7893;
const needLivekit = chains.some((c) => CHAINS[c].engine === 'livekit' && !CHAINS[c].cloud);
const answers = (port, host) => new Promise((ok) => connect(port, host).once('connect', function () { this.destroy(); ok(true); }).once('error', () => ok(false)));
for (const port of [pagePort, voicePort, ...(needLivekit ? [lkPort, lkTcpPort] : [])]) {
  if ((await answers(port, '127.0.0.1')) || (await answers(port, '::1'))) throw new Refused(`port ${port} is already in use (another capture-eval or server?) — it would be measured in place of ours`);
}

const lkToken = (room, name, c = false) => new SignJWT({ name, video: { room, roomJoin: true, canPublish: true, canSubscribe: true } }).setProtectedHeader({ alg: 'HS256' }).setIssuer(c ? cloud.key : lkKey).setSubject(`${name}-${randomUUID()}`).setNotBefore(Math.floor(Date.now() / 1000) - 5).setExpirationTime('10m').sign(new TextEncoder().encode(c ? cloud.secret : lkSecret));
if (cloud) {
  // The real target, before any room is joined: see verifyDedicatedProject().
  const listRoomsToken = await new SignJWT({ video: { roomList: true } }).setProtectedHeader({ alg: 'HS256' }).setIssuer(cloud.key).setNotBefore(Math.floor(Date.now() / 1000) - 5).setExpirationTime('2m').sign(new TextEncoder().encode(cloud.secret));
  const { benchRoomsOpen } = await verifyDedicatedProject({ target: cloud, listRoomsToken, fetch });
  console.log(`LiveKit Cloud: test target verified (bench key accepted; no foreign rooms; ${benchRoomsOpen} earlier bench room(s) open)`);
}
mkdirSync(out, { recursive: true });

// ---- corpus --------------------------------------------------------------------
// Every file gets LEAD_S of its own noise in front.
const ROOM_DRR_DB = 3; // talker ~0.5 m from a laptop microphone in an ordinary room (assumption)
const conditions = {};
for (const v of variants) {
  const dir = join(out, 'corpus', v.tag || 'base');
  const corpus = buildCorpus(dir, { snrDb: v.snrDb, levelDb: v.levelDb, speechFile, roomDrrDb: ROOM_DRR_DB });
  const all = { clean: { file: join(dir, 'clean.wav'), speech: corpus.clean }, ...corpus.conditions };
  for (const [name, c] of Object.entries(all)) {
    if (v.only && !v.only.includes(name)) continue;
    const mix = readWav(c.file);
    const noise = Float32Array.from(mix, (x, i) => x - c.speech[i]);
    const lead = Float32Array.from({ length: LEAD_S * RATE }, (_, i) => noise[i % noise.length]);
    const fed = Float32Array.from([...lead, ...mix]);
    const fedFile = join(dir, `fed-${name}.wav`);
    writeWav(fedFile, fed);
    conditions[name + v.tag] = { fedFile, fed, mix, clean: corpus.clean, speech: c.speech, snrDb: v.snrDb, levelDb: v.levelDb };
  }
}
if (Object.keys(conditions).sort().join() !== [...conditionNames].sort().join()) throw new Error('corpus conditions differ from BASE_CONDITIONS — update capture-eval.mjs');

// ---- servers -------------------------------------------------------------------
const bundle = (entry, outfile, alias) => build({ entryPoints: [join(here, entry)], outfile: join(out, outfile), bundle: true, format: 'esm', target: 'chrome110', logLevel: 'warning', alias });
await bundle('src/capture-page.ts', 'page.js');
// Krisp exactly as team-comms ships it, bundled on its own only for Krisp chains;
// read from its package directory, never written.
if (krisp) await bundle('src/capture-krisp.ts', 'krisp.js', { [KRISP_PACKAGE]: krisp.dir });
const nswDir = join(root, 'demo/dist/nsw');
const pageServer = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/page.js' || (krisp && path === '/krisp.js')) return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(out, path.slice(1))));
  if (path.startsWith('/nsw/')) {
    const name = path.slice(5);
    if (!/^[a-z_-]+\.(js|wasm)$/.test(name)) return void res.writeHead(404).end();
    return void res.writeHead(200, { 'content-type': name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }).end(readFileSync(join(nswDir, name)));
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><script type="module" src="/page.js"></script>');
}).listen(pagePort, '127.0.0.1');
await new Promise((ok, fail) => pageServer.once('listening', ok).once('error', (e) => fail(new Error(`page port ${pagePort}: ${e.code} — another capture-eval still running?`))));

const voice = spawn(process.execPath, [join(root, 'server/dist/index.js')], {
  stdio: 'ignore',
  env: { ...process.env, PORT: String(voicePort), NUM_WORKERS: '1', RTC_PORT_BASE: '40370', RTC_ANNOUNCED_ADDRESS: '127.0.0.1', TICKET_PUBLIC_KEY_FILE: join(root, '.dev-keys/ticket-public.pem'), ALLOWED_ORIGINS: `http://127.0.0.1:${pagePort}`, LOG_LEVEL: 'warn' },
});
const lkContainer = `voxonow-bench-capture-lk-${process.pid}`;
const lkKey = 'benchkey', lkSecret = 'bench-livekit-secret-local-only-not-a-real-secret';
stopAll = () => {
  voice.kill();
  pageServer.close();
  if (needLivekit) try { execFileSync('docker', ['rm', '-f', lkContainer], { stdio: 'ignore' }); } catch {}
};
if (needLivekit) {
  const config = `port: 7880\nrtc:\n  tcp_port: 7893\n  port_range_start: 50200\n  port_range_end: 50240\n  use_external_ip: false\n  node_ip: 127.0.0.1\nkeys:\n  ${lkKey}: ${lkSecret}\nlogging:\n  level: warn\n`;
  writeFileSync(join(out, 'livekit.yaml'), config);
  execFileSync('docker', ['run', '-d', '--rm', '--name', lkContainer, '-p', `${lkPort}:7880`, '-p', `${lkTcpPort}:7893`, '-p', '50200-50240:50200-50240/udp', '-v', `${join(out, 'livekit.yaml')}:/lk.yaml:ro`, LIVEKIT_IMAGE, '--config', '/lk.yaml']);
}

for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://localhost:${voicePort}/healthz`)).ok && (!needLivekit || (await fetch(`http://localhost:${lkPort}/`)).ok)) break;
  } catch {}
  if (i > 100) throw new Error('servers did not start');
  await new Promise((r) => setTimeout(r, 200));
}
const ticketKey = await importPKCS8(readFileSync(join(root, '.dev-keys/ticket-private.pem'), 'utf8'), 'EdDSA');
const ticket = (room) => new SignJWT({ room, name: 'cap', publish: ['microphone'] }).setProtectedHeader({ alg: 'EdDSA' }).setIssuer('voxonow-api').setAudience('voxonow-voice').setSubject(`cap-${randomUUID()}`).setJti(randomUUID()).setIssuedAt().setExpirationTime('5m').sign(ticketKey);

// ---- analysis ------------------------------------------------------------------
const decode = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
};
const db = (r) => 10 * Math.log10(r);
const at = (x, j) => (j >= 0 && j < x.length ? x[j] : 0);
const cut = (x, offset, n) => Float32Array.from({ length: n }, (_, i) => at(x, i + offset));

/** Speech-frame band energy relative to the clean speech, minus the overall level change (AGC-independent). */
function bandsRel(signal, clean, inSpeech) {
  const s = powerSpectrum(signal, { include: inSpeech }), r = powerSpectrum(clean, { include: inSpeech });
  const band = (lo, hi) => {
    let e = 0, t = 0;
    for (let k = 1; k < s.power.length; k++) {
      const hz = (k * RATE) / s.size;
      if (hz >= lo && hz < hi) (e += s.power[k]), (t += r.power[k]);
    }
    return { e, t };
  };
  const all = band(100, 4000);
  const rel = (lo, hi) => {
    const b = band(lo, hi);
    return db(b.e / b.t) - db(all.e / all.t);
  };
  return { b4_8: rel(4000, 8000), b8_12: rel(8000, 12000), b12_16: rel(12000, 16000) };
}

const frameDb = (x, F = 480) => {
  const out = new Float64Array(Math.floor(x.length / F));
  for (let f = 0; f < out.length; f++) {
    let e = 0;
    for (let i = f * F; i < (f + 1) * F; i++) e += x[i] * x[i];
    out[f] = db(e / F + 1e-20);
  }
  return out;
};

/**
 * Engine/network dropouts: 10 ms frames that left the sender with sound
 * (> −60 dBFS) but arrived as near-silence (< −70 dBFS). A suppressor
 * muting a pause is not a dropout: the sent signal is already quiet there.
 */
function engineDropouts(sentA, recA) {
  const s = frameDb(sentA), r = frameDb(recA);
  let longest = 0, run = 0, count = 0;
  for (let f = 0; f < Math.min(s.length, r.length); f++) {
    if (s[f] > -60 && r[f] < -70) run++;
    else (run >= 4 && count++), (run = 0);
    longest = Math.max(longest, run);
  }
  if (run >= 4) count++;
  return { longestDropoutMs: longest * 10, dropouts40ms: count };
}

/**
 * Speech the chain cut away: among strong speech frames (within 10 dB of the
 * clean recording's median speech frame), those more than 25 dB below the
 * clean frame after the chain's overall gain is taken out. Longest run and
 * share. A healthy chain keeps both near zero; a suppressor clipping words
 * does not.
 */
function speechGating(clean, y, gainDb) {
  const c = frameDb(clean), o = frameDb(y);
  const speech = [...c].filter((v) => v > -70).sort((a, b) => a - b);
  const strong = speech[Math.floor(speech.length / 2)] - 10;
  let longest = 0, run = 0, gated = 0, total = 0;
  for (let f = 0; f < Math.min(c.length, o.length); f++) {
    if (c[f] < strong) { run = 0; continue; }
    total++;
    if (o[f] < c[f] + gainDb - 25) (gated++, run++);
    else run = 0;
    longest = Math.max(longest, run);
  }
  return { gatedLongestMs: longest * 10, gatedPct: (100 * gated) / Math.max(1, total) };
}

/**
 * Places the recording on the fed file's timeline. The tap is located against
 * the file that was actually fed (the noisy/reverberant signal, not the clean
 * reference — aligning to the dry reference shifted the reverberant room
 * condition by ~11 ms in ns-eval and inflated its STOI), per 3 s segment
 * within ±100 ms of the global offset: a capture or render glitch shifts
 * everything after it, and a single offset would then compare the rest of
 * the run against the wrong samples. The largest segment shift is reported
 * (captureSlipMs); runs with a slip are kept but flagged. Sent follows the tap
 * by the suppressor's lag; received segments may move ±10 ms against the sent
 * ones (jitter-buffer drift), never against the reference.
 */
/** 2 ms RMS envelope at 1 ms steps (ENV_HOP samples). */
const ENV_HOP = 48;
function envelope(x) {
  const out = new Float64Array(Math.max(0, Math.floor((x.length - 2 * ENV_HOP) / ENV_HOP) + 1));
  for (let j = 0; j < out.length; j++) {
    let e = 0;
    for (let i = j * ENV_HOP; i < j * ENV_HOP + 2 * ENV_HOP; i++) e += x[i] * x[i];
    out[j] = Math.sqrt(e / (2 * ENV_HOP));
  }
  return out;
}

/** Normalised correlation of `ref` with `window` starting at index `k`. */
function ncc(ref, window, k) {
  let xy = 0, xx = 0, yy = 0;
  for (let i = 0; i < ref.length; i++) {
    const y = at(window, i + k);
    (xy += ref[i] * y), (xx += ref[i] * ref[i]), (yy += y * y);
  }
  return xy / (Math.sqrt(xx * yy) + 1e-20);
}

function align(c, tap, sent, received) {
  const tapAt = bestLag(c.fed, tap, -15 * RATE, 2 * RATE); // tap[t + tapAt] ≈ fed[t]
  const methodLag = bestLag(tap, sent, -480, 0.3 * RATE);
  const netLag = bestLag(sent, received, 0, RATE);
  const start = LEAD_S * RATE, n = c.clean.length;
  const tapA = new Float32Array(n), sentA = new Float32Array(n), recA = new Float32Array(n);
  const seg = 3 * RATE, slipSearch = Math.round(0.1 * RATE), search = 480;
  const recvSearch = 3 * RATE; // ±3 s: a processor attach left LiveKit's receiver ~2 s behind
  let offset = tapAt, maxSlip = 0, maxRecvSlip = 0;
  for (let s = 0; s < n; s += seg) {
    const e = Math.min(n, s + seg);
    const ref = c.fed.subarray(start + s, start + e);
    if (ref.reduce((a, v) => a + v * v, 0) / ref.length > 1e-7) {
      // Envelopes, not waveforms: after Chrome's capture processing the
      // waveform correlates with the input only ~0.3–0.5 (phase changes) and
      // its peak jumps by pitch periods; the envelope still shows a real shift.
      const window = cut(tap, start + s + tapAt - slipSearch, e - s + 2 * slipSearch);
      const er = envelope(ref), ew = envelope(window);
      const steps = (2 * slipSearch) / ENV_HOP;
      let best = steps / 2, bestV = -Infinity;
      for (let k = 0; k <= steps; k++) {
        const v = ncc(er, ew, k);
        if (v > bestV) (bestV = v), (best = k);
      }
      const shift = (best - steps / 2) * ENV_HOP;
      offset = Math.abs(shift) >= 3 * ENV_HOP && bestV > ncc(er, ew, steps / 2) + 0.05 ? tapAt + shift : tapAt;
      if (process.env.DEBUG_ALIGN) console.log(`  seg ${s / RATE}s envelope shift ${shift / 48} ms ncc ${bestV.toFixed(3)} vs ${ncc(er, ew, steps / 2).toFixed(3)}`);
    }
    maxSlip = Math.max(maxSlip, Math.abs(offset - tapAt));
    for (let i = s; i < e; i++) (tapA[i] = at(tap, start + i + offset)), (sentA[i] = at(sent, start + i + offset + methodLag));
    const base = start + s + offset + methodLag + netLag;
    // Same reason for the receiver: Opus does not keep the waveform, and a
    // waveform search of ±10 ms can land a pitch period away. Normally the
    // jitter buffer only drifts a few ms (±10 ms search); but a track switch
    // mid-call (e.g. a processor being attached) can leave the receiver
    // seconds behind until the buffer catches up, so a ±3 s search wins when
    // it is clearly better. The largest such shift is reported (receiveSlipMs).
    const er = envelope(sentA.subarray(s, e)), ew = envelope(cut(received, base - recvSearch, e - s + 2 * recvSearch));
    const mid = recvSearch / ENV_HOP, near = search / ENV_HOP;
    let best = mid, bestV = -Infinity, wide = mid, wideV = -Infinity;
    for (let j = 0; j <= 2 * mid; j++) {
      const v = ncc(er, ew, j);
      if (Math.abs(j - mid) <= near && v > bestV) (bestV = v), (best = j);
      if (v > wideV) (wideV = v), (wide = j);
    }
    if (wideV > bestV + 0.05) best = wide;
    const k = (best - mid) * ENV_HOP;
    maxRecvSlip = Math.max(maxRecvSlip, Math.abs(k));
    for (let i = s; i < e; i++) recA[i] = at(received, base + k + (i - s));
  }
  return { tapA, sentA, recA, tapAt, captureSlipMs: (maxSlip / RATE) * 1000, receiveSlipMs: (maxRecvSlip / RATE) * 1000, methodLagMs: (methodLag / RATE) * 1000, netLagMs: (netLag / RATE) * 1000 };
}

function metrics(c, y, sentA) {
  const mask = speechMask(c.clean);
  const inSpeech = (s) => mask[Math.floor(s / 960)] === true;
  const speechE = maskedEnergy(y, mask, true), pauseE = Math.max(1e-12, maskedEnergy(y, mask, false));
  const nSpeech = mask.filter(Boolean).length * 960, nPause = mask.filter((m) => !m).length * 960;
  const levelDbfs = db(speechE / nSpeech);
  const cleanLevel = db(maskedEnergy(c.clean, mask, true) / nSpeech);
  return {
    stoi: stoi(c.clean, y, RATE),
    estoi: estoi(c.clean, y, RATE),
    levelDbfs,
    // Speech-frame power over pause power: gain-independent "how much quieter are the pauses".
    speechToPauseDb: levelDbfs - db(pauseE / nPause),
    ...bandsRel(y, c.clean, inSpeech),
    ...speechGating(c.clean, y, levelDbfs - cleanLevel),
    ...(sentA ? engineDropouts(sentA, y) : {}),
  };
}
const inputMetrics = (c) => {
  const mask = speechMask(c.clean);
  const nSpeech = mask.filter(Boolean).length * 960, nPause = mask.filter((m) => !m).length * 960;
  return { stoi: stoi(c.clean, c.mix, RATE), estoi: estoi(c.clean, c.mix, RATE), speechToPauseDb: db(maskedEnergy(c.mix, mask, true) / nSpeech) - db(Math.max(1e-12, maskedEnergy(c.mix, mask, false)) / nPause) };
};

// ---- runs ----------------------------------------------------------------------
const results = [];
const inputs = Object.fromEntries(selected.map((c) => [c, inputMetrics(conditions[c])]));
let chromeVersion;
let aborted;
try {
  runs: for (const name of selected) {
    const c = conditions[name];
    const recordS = c.fed.length / RATE + 1.5;
    for (const chainName of chains) {
      const chain = CHAINS[chainName];
      // The local Krisp chain is a pass/fail check (see header): once is enough.
      // Bounded run time: the raw reference only where it answers something
      // (clean, fan); the SNR/level sweeps only for the chains being compared.
      const sweep = name.includes('@');
      const inScope = chainName === 'ours-raw' ? ['clean', 'fan'].includes(name) : !sweep || ['ours-product', 'ours-rnnoise-nsoff', 'livekit-product', 'cloud-product', 'cloud-krisp'].includes(chainName);
      const reps = !inScope ? 0 : chain.krispCheckOnly ? (name === 'fan' ? 1 : 0) : REPEATS;
      for (let r = 0; r < reps; r++) {
        if (voice.exitCode !== null || voice.signalCode !== null) {
          aborted = 'the voice server exited during the run';
          break runs;
        }
        const browser = await chromium.launch({
          channel: 'chrome',
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${c.fedFile}%noloop`, '--autoplay-policy=no-user-gesture-required'],
        });
        chromeVersion ??= browser.version();
        const requests = [];
        try {
          const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
          page.on('response', (resp) => {
            const u = resp.url();
            if (!u.startsWith(`http://127.0.0.1:${pagePort}`) && !/\/rtc|\/validate/.test(u)) requests.push(redact(`${resp.status()} ${u.replace(/\?.*/, '')}`));
          });
          await page.goto(`http://127.0.0.1:${pagePort}/`);
          await page.waitForFunction(() => 'captureEval' in window);
          // Room ids allow only [A-Za-z0-9_.:-] (protocol RoomId); condition names carry '@'.
          const room = `${BENCH_ROOM_PREFIX}${chainName}-${name}-${r}-${Date.now()}`.replace(/[^A-Za-z0-9_.:-]/g, '_');
          const credentials = chain.engine === 'ours' ? [await ticket(room), await ticket(room)] : [await lkToken(room, 'pub', chain.cloud), await lkToken(room, 'sub', chain.cloud)];
          const url = chain.engine === 'ours' ? `ws://localhost:${voicePort}/ws` : chain.cloud ? cloud.url : `ws://localhost:${lkPort}`;
          const res = await page.evaluate((o) => window.captureEval.run(o), { ...chain, krispModule: chain.krisp ? '/krisp.js' : undefined, url, credentials, recordS });
          // A Krisp chain without Krisp enabled is not a Krisp measurement;
          // only the local enablement check is expected to see that.
          if (chain.krisp && !chain.krispCheckOnly && !krispActive(res)) throw new Error(`Krisp never reported enabled (2 s after attach: ${res.krispEnabled}, at end: ${res.krispEnabledAtEnd}); run not counted as ${chainName}`);
          const [tap, sent, received] = [decode(res.tap), decode(res.sent), decode(res.received)];
          const a = align(c, tap, sent, received);
          const dir = join(out, 'wav', name, chainName);
          mkdirSync(dir, { recursive: true });
          writeWav(join(dir, `received-${r}.wav`), a.recA);
          // Every repeat: the pre-network signals are what a listening test uses.
          writeWav(join(dir, `tap-${r}.wav`), a.tapA), writeWav(join(dir, `sent-${r}.wav`), a.sentA);
          const inb = res.inbound ?? {};
          results.push({
            condition: name, chain: chainName, rep: r,
            // What this measurement went through: the chain as defined, what
            // Chrome reported for the capture, and the suppressor actually active.
            processing: { chain: chainInfo[chainName], suppressor: actualSuppressor(chain, res) },
            settings: res.settings, krispEnabled: res.krispEnabled, krispEnabledAtEnd: res.krispEnabledAtEnd, notes: res.notes.map(redact), setupMs: res.setupMs,
            targetBitrate: res.targetBitrate,
            krispRequests: chain.krisp ? requests : undefined,
            methodLagMs: a.methodLagMs, netLagMs: a.netLagMs,
            captureSlipMs: a.captureSlipMs, receiveSlipMs: a.receiveSlipMs,
            tap: metrics(c, a.tapA), sent: metrics(c, a.sentA), received: metrics(c, a.recA, a.sentA),
            packetsLost: inb.packetsLost, concealmentEvents: inb.concealmentEvents,
            concealedPct: inb.totalSamplesReceived ? (100 * (inb.concealedSamples - inb.silentConcealedSamples)) / inb.totalSamplesReceived : undefined,
            silentConcealedPct: inb.totalSamplesReceived ? (100 * inb.silentConcealedSamples) / inb.totalSamplesReceived : undefined,
            accelDecelMs: inb.removedSamplesForAcceleration !== undefined ? ((inb.removedSamplesForAcceleration + inb.insertedSamplesForDeceleration) / RATE) * 1000 : undefined,
            playoutMs: inb.jitterBufferEmittedCount ? (1000 * inb.jitterBufferDelay) / inb.jitterBufferEmittedCount : undefined,
          });
          process.stdout.write(`${name} ${chainName} #${r}: STOI ${results.at(-1).received.stoi.toFixed(3)}, +${a.methodLagMs.toFixed(0)}/${a.netLagMs.toFixed(0)} ms, slip ${a.captureSlipMs.toFixed(0)} ms\n`);
        } catch (error) {
          const message = redact(String(error?.message ?? error)).slice(0, 300);
          results.push({ condition: name, chain: chainName, rep: r, error: message, krispRequests: requests });
          console.log(`${name} ${chainName} #${r}: FAILED ${message.slice(0, 200)}`);
        } finally {
          await browser.close();
        }
      }
    }
  }
} finally {
  stopAll();
}

// ---- report --------------------------------------------------------------------
const med = (v) => {
  const s = v.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const span = (rows, get, d = 1) => {
  const v = rows.map(get).filter(Number.isFinite);
  if (!v.length) return '–';
  return v.length === 1 ? f(v[0], d) : `${f(med(v), d)} [${f(Math.min(...v), d)}–${f(Math.max(...v), d)}]`;
};
const ok = results.filter((r) => !r.error);
const L = [`# Capture-chain evaluation — ${new Date().toISOString().slice(0, 16)}`, ''];
L.push(`Google Chrome ${chromeVersion}, file-fed fake microphone (getUserMedia + Chrome capture processing), headless, one machine. Speech: ${speech.kind === 'recording' ? `recording sha256:${speech.sha256}` : speech.note}, levelled; interference synthetic (seeded). ${LEAD_S} s of noise before speech. Room condition DRR ${ROOM_DRR_DB} dB. Local chains: loopback, no network impairment.${cloudChains.length ? ' Cloud chains: internet path to a LiveKit Cloud test project — their latency and received metrics include it.' : ''} Values: median [min–max] over repeats.`);
L.push('', `**Not covered:** physical microphone/room/loudspeaker, echo (no far-end playback), Firefox and Safari (no file-fed capture), network loss/jitter${krispChains.some((c) => !CHAINS[c].krispCheckOnly) ? '' : ', Krisp (only a cloud-krisp run with Krisp enabled measures it)'}.`);
L.push('', '## Chains', '', 'Each row below was measured through exactly this chain; "actual suppressor" is what the runs reported.', '');
for (const ch of chains) {
  const seen = [...new Set(ok.filter((r) => r.chain === ch).map((r) => r.processing.suppressor))];
  L.push(`- **${ch}**: ${chainInfo[ch]} — actual suppressor: ${seen.join(', ') || '– (no successful run)'}`);
}
L.push('', '## Input (fed file, before any processing)', '', '| Condition | STOI | ESTOI | Speech/pause dB |', '|---|---|---|---|');
for (const [c, m] of Object.entries(inputs)) L.push(`| ${c} | ${f(m.stoi, 3)} | ${f(m.estoi, 3)} | ${f(m.speechToPauseDb)} |`);
L.push('', '## Received (end of chain)', '', '| Condition | Chain | n | STOI | ESTOI | Speech/pause dB | Level dBFS | 4–8 kHz | 8–12 kHz | 12–16 kHz | Suppressor ms | Engine+net ms | Speech gated % | Longest gated ms | Longest dropout ms | Concealed % | Concealment events | Capture slip ms | Receive slip ms |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const c of selected) for (const ch of chains) {
  const rows = ok.filter((r) => r.condition === c && r.chain === ch);
  if (!rows.length) continue;
  L.push(`| ${c} | ${ch} | ${rows.length} | ${span(rows, (r) => r.received.stoi, 3)} | ${span(rows, (r) => r.received.estoi, 3)} | ${span(rows, (r) => r.received.speechToPauseDb)} | ${span(rows, (r) => r.received.levelDbfs)} | ${span(rows, (r) => r.received.b4_8)} | ${span(rows, (r) => r.received.b8_12)} | ${span(rows, (r) => r.received.b12_16)} | ${span(rows, (r) => r.methodLagMs, 0)} | ${span(rows, (r) => r.netLagMs, 0)} | ${span(rows, (r) => r.received.gatedPct)} | ${span(rows, (r) => r.received.gatedLongestMs, 0)} | ${span(rows, (r) => r.received.longestDropoutMs, 0)} | ${span(rows, (r) => r.concealedPct, 2)} | ${span(rows, (r) => r.concealmentEvents, 0)} | ${span(rows, (r) => r.captureSlipMs, 0)} | ${span(rows, (r) => r.receiveSlipMs, 0)} |`);
}
L.push('', '## After browser processing only (tap, before suppressor/codec)', '', '| Condition | Chain | STOI | ESTOI | Speech/pause dB | Level dBFS | 8–12 kHz |', '|---|---|---|---|---|---|---|');
for (const c of selected) for (const ch of chains) {
  const rows = ok.filter((r) => r.condition === c && r.chain === ch);
  if (rows.length) L.push(`| ${c} | ${ch} | ${span(rows, (r) => r.tap.stoi, 3)} | ${span(rows, (r) => r.tap.estoi, 3)} | ${span(rows, (r) => r.tap.speechToPauseDb)} | ${span(rows, (r) => r.tap.levelDbfs)} | ${span(rows, (r) => r.tap.b8_12)} |`);
}
L.push('', '## Capture settings as reported (getSettings) and Krisp', '');
for (const ch of chains) {
  const r = ok.find((x) => x.chain === ch) ?? results.find((x) => x.chain === ch);
  if (!r) continue;
  L.push(`- **${ch}**: ${JSON.stringify(r.settings ?? {})}${r.krispEnabled !== undefined ? ` · krispEnabled=${r.krispEnabled} (at end: ${r.krispEnabledAtEnd})` : ''}${r.notes?.length ? ` · ${r.notes.join('; ')}` : ''}${r.error ? ` · ERROR ${r.error}` : ''}`);
  if (r.krispRequests) for (const q of r.krispRequests.slice(0, 12)) L.push(`  - ${q}`);
}
if (aborted) L.push('', `**Run aborted: ${aborted}.** Only the runs above were measured.`);
const failed = results.filter((r) => r.error);
if (failed.length) L.push('', `**Failed runs: ${failed.length}** — ${failed.map((r) => `${r.condition}/${r.chain}#${r.rep}`).join(', ')}`);
L.push('', 'Speech/pause: speech-frame power over pause power (higher = quieter pauses relative to speech; independent of gain). Bands: speech-frame band energy vs the clean speech, minus the 100 Hz–4 kHz level change (0 = spectral balance kept). STOI/ESTOI against the clean recording; they ignore content above ~4.3 kHz. Speech gated: strong speech frames (within 10 dB of the median speech frame) more than 25 dB below the clean frame after the overall gain change — words cut by the chain. Longest dropout: longest run of 10 ms frames that left the sender above −60 dBFS and arrived below −70 dBFS (engine/network, not suppression). Capture slip: largest per-segment shift of the capture against the fed file — non-zero means a capture/render glitch in that run (headless load); its other numbers are then suspect. Receive slip: largest per-segment shift of the received signal beyond ±10 ms of the steady network lag — the receiver fell behind and caught up (e.g. a track switch); those segments are re-aligned, the event itself is reported. Concealed %: non-silent concealed samples ÷ received samples (receiver stats).');
writeFileSync(join(out, 'report.md'), L.join('\n') + '\n');
writeFileSync(join(out, 'results.json'), JSON.stringify({ chromeVersion, aborted, speech, chains: chainInfo, krispVersion: krisp?.version, livekitImage: needLivekit ? LIVEKIT_IMAGE : undefined, inputs, results }, null, 2));
console.log(L.join('\n'));
console.log(`\nfiles: ${out}`);
process.exit(aborted ? 1 : 0);
