// Call quality and server resource measurement (M1 acceptance).
//
//   npm run build
//   node bench/quality.mjs --browsers chromium,firefox,webkit --duration 1800
//   node bench/quality.mjs --browsers chromium*8 --duration 60
//
// Puts one participant per browser entry in one room (real WebRTC, fake
// microphones), samples every --interval seconds and reports, per
// receiver ← sender pair: packets, loss, jitter, concealed audio, playout
// delay; per participant: RTT; and the mediasoup workers' CPU and memory.
//
// An "interruption" is an interval in which a pair received fewer than
// MIN_PACKETS audio packets. Opus sends 50 packets/s while there is sound and
// still ~2.5 packets/s in DTX silence, so a healthy pair never drops below it.
//
// --external ws://host:port/ws measures an already running voice server (e.g.
// the Docker one under tc netem); CPU is then not measured here.
//
// --engine livekit runs the same participants against LiveKit instead
// (bench/src/lk-participant.ts; local LiveKit from team-comms by default), for
// an A/B with identical browsers, sources and sampling.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit } from '@playwright/test';
import { build } from 'esbuild';
import { SignJWT } from 'jose';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    browsers: { type: 'string', default: 'chromium,firefox,webkit' },
    duration: { type: 'string', default: '60' },
    interval: { type: 'string', default: '5' },
    external: { type: 'string' },
    engine: { type: 'string', default: 'voxonow' },
    'page-query': { type: 'string', default: '' },
    label: { type: 'string', default: '' },
    'voice-port': { type: 'string', default: '7850' },
    'demo-port': { type: 'string', default: '5250' },
    'rtc-port-base': { type: 'string', default: '40500' },
  },
});
const DURATION = Number(args.duration);
const INTERVAL = Number(args.interval);
const MIN_PACKETS = 5 * (INTERVAL / 5);
const voicePort = Number(args['voice-port']);
const demoPort = Number(args['demo-port']);

const participants = args.browsers.split(',').flatMap((entry) => {
  const [name, count] = entry.trim().split('*');
  return Array.from({ length: Number(count ?? 1) }, () => name);
});

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

const children = [];
const livekit = args.engine === 'livekit';
const voiceUrl = args.external ?? `ws://localhost:${voicePort}/ws`;
let serverPid;
let pageServer;
if (livekit) {
  const lkUrl = process.env.LIVEKIT_URL || 'ws://localhost:7880';
  const lkKey = process.env.LIVEKIT_KEY || 'devkey';
  const lkSecret = new TextEncoder().encode(process.env.LIVEKIT_SECRET || 'local-dev-livekit-secret-not-for-production-use');
  await build({
    entryPoints: [join(root, 'bench/src/lk-participant.ts')],
    outfile: join(root, 'bench/dist/lk.js'),
    bundle: true,
    format: 'esm',
    target: ['chrome110', 'safari16', 'firefox115'],
    logLevel: 'warning',
  });
  pageServer = createServer(async (request, response) => {
    if (request.url === '/lk.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(root, 'bench/dist/lk.js')));
    } else if (request.url === '/api/lk-token') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const { room, name } = JSON.parse(body);
      const token = await new SignJWT({ name, video: { room, roomJoin: true, canPublish: true, canSubscribe: true } })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(lkKey)
        .setSubject(`${name}-${Date.now()}`)
        .setNotBefore(Math.floor(Date.now() / 1000) - 5)
        .setExpirationTime('2h')
        .sign(lkSecret);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token, url: lkUrl }));
    } else if (request.url === '/healthz') {
      response.writeHead(200).end('ok');
    } else {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><script type="module" src="/lk.js"></script>');
    }
  }).listen(demoPort);
} else if (!args.external) {
  const server = spawn(process.execPath, [join(root, 'server/dist/index.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      PORT: String(voicePort),
      NUM_WORKERS: '1',
      RTC_PORT_BASE: args['rtc-port-base'],
      RTC_ANNOUNCED_ADDRESS: lanAddress(),
      TICKET_PUBLIC_KEY_FILE: join(root, '.dev-keys/ticket-public.pem'),
      ALLOWED_ORIGINS: `http://localhost:${demoPort}`,
      LOG_LEVEL: 'warn',
    },
  });
  children.push(server);
  serverPid = server.pid;
}
if (!livekit) children.push(
  spawn(process.execPath, [join(root, 'demo/dev-server.mjs')], {
    stdio: 'ignore',
    env: { ...process.env, DEMO_PORT: String(demoPort), VOICE_URL: voiceUrl, DEV_LOG_DIR: join(root, 'test-results/bench-logs') },
  }),
);
const cleanup = () => {
  children.forEach((c) => c.kill('SIGTERM'));
  pageServer?.close();
};
process.on('exit', cleanup);

const healthUrl = voiceUrl.replace(/^ws/, 'http').replace(/\/ws$/, '/healthz');
for (let i = 0; ; i++) {
  try {
    if ((livekit || (await fetch(healthUrl)).ok) && (await fetch(`http://localhost:${demoPort}/healthz`)).ok) break;
  } catch {}
  if (i > 100) throw new Error('servers did not start');
  await new Promise((r) => setTimeout(r, 200));
}

/** mediasoup-worker children of our server: cumulative CPU seconds and RSS. */
function workerUsage() {
  if (!serverPid) return undefined;
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,time=,rss=,comm=']).toString().trim().split('\n');
  let cpu = 0;
  let rss = 0;
  let found = 0;
  for (const row of rows) {
    const [pid, ppid, time, kb, ...comm] = row.trim().split(/\s+/);
    if (Number(ppid) !== serverPid || !comm.join(' ').includes('mediasoup-worker')) continue;
    // ps TIME: [[dd-]hh:]mm:ss[.cc]
    const parts = time.replace('-', ':').split(':').map(Number);
    cpu += parts.reduce((acc, v) => acc * 60 + v, 0);
    rss += Number(kb) * 1024;
    found++;
  }
  return found ? { cpu, rss } : undefined;
}

const launchers = {
  chromium: () => chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }),
  firefox: () =>
    firefox.launch({ firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } }),
  webkit: () => webkit.launch(),
};
const browsers = {};
const room = `quality-${Date.now()}`;
const pages = [];
for (const [i, kind] of participants.entries()) {
  browsers[kind] ??= await launchers[kind]();
  const context = await browsers[kind].newContext({ permissions: kind === 'firefox' ? [] : ['microphone'] });
  const page = await context.newPage();
  const name = `${kind}-${i + 1}`;
  await page.goto(`http://localhost:${demoPort}/${args['page-query'] ? '?' + args['page-query'] : ''}`);
  await page.evaluate(([r, n]) => window.voiceDemo.join(r, n), [room, name]);
  pages.push({ name, page });
}
console.log(`${participants.length} participants in ${room}; measuring ${DURATION}s every ${INTERVAL}s`);

// Let every pair start flowing before measuring.
await new Promise((r) => setTimeout(r, 3000));
const snapshot = () => Promise.all(pages.map(async ({ name, page }) => ({ name, stats: await page.evaluate(() => window.voiceDemo.stats()) })));

const samples = [];
let previous = await snapshot();
let usagePrev = workerUsage();
let usageWall = performance.now();
const cpuSamples = [];
const rssSamples = [];
const start = Date.now();
while (Date.now() - start < DURATION * 1000) {
  await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  const current = await snapshot();
  const t = Math.round((Date.now() - start) / 1000);
  for (const [i, { name, stats }] of current.entries()) {
    const before = previous[i].stats;
    for (const track of stats.perTrack) {
      const old = before.perTrack.find((x) => x.from === track.from) ?? {
        packetsReceived: 0,
        packetsLost: 0,
        jitterBufferDelay: 0,
        jitterBufferEmittedCount: 0,
      };
      // Playout delay over this interval only (the cumulative average hides
      // both start-up and drift).
      const emitted = track.jitterBufferEmittedCount - old.jitterBufferEmittedCount;
      samples.push({
        t,
        receiver: name,
        sender: track.from,
        packets: track.packetsReceived - old.packetsReceived,
        lost: Math.max(0, track.packetsLost - old.packetsLost),
        jitterMs: track.jitter * 1000,
        concealed: track.concealedRatio,
        playoutMs: emitted > 0 ? ((track.jitterBufferDelay - old.jitterBufferDelay) / emitted) * 1000 : undefined,
        rttMs: stats.roundTripTime !== undefined ? stats.roundTripTime * 1000 : undefined,
      });
    }
    const expectedSenders = participants.length - 1;
    if (stats.perTrack.length < expectedSenders) {
      samples.push({ t, receiver: name, sender: '(missing track)', packets: 0, lost: 0 });
    }
  }
  previous = current;
  const usage = workerUsage();
  const now = performance.now();
  if (usage && usagePrev) {
    cpuSamples.push((100 * (usage.cpu - usagePrev.cpu)) / ((now - usageWall) / 1000));
    rssSamples.push(usage.rss);
  }
  usagePrev = usage;
  usageWall = now;
  process.stdout.write(`\r${t}s / ${DURATION}s`);
}
process.stdout.write('\n');
for (const b of Object.values(browsers)) await b.close();
cleanup();

// ---- report --------------------------------------------------------------
const pct = (values, p) => {
  const s = values.filter((v) => v !== undefined && !Number.isNaN(v)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : undefined;
};
const fmt = (v, digits = 0) => (v === undefined ? '–' : v.toFixed(digits));
const interruptions = samples.filter((s) => s.packets < MIN_PACKETS);
const totalPackets = samples.reduce((a, s) => a + s.packets, 0);
const totalLost = samples.reduce((a, s) => a + s.lost, 0);
const pairs = [...new Set(samples.map((s) => `${s.receiver} ← ${s.sender}`))];

const summary = {
  label: args.label,
  engine: args.engine,
  pageQuery: args['page-query'],
  date: new Date().toISOString(),
  participants,
  durationS: DURATION,
  intervalS: INTERVAL,
  interruptions: interruptions.map((s) => ({ t: s.t, pair: `${s.receiver} ← ${s.sender}`, packets: s.packets })),
  lossPct: (100 * totalLost) / Math.max(1, totalPackets + totalLost),
  rttMs: { p50: pct(samples.map((s) => s.rttMs), 0.5), p95: pct(samples.map((s) => s.rttMs), 0.95) },
  jitterMs: { p50: pct(samples.map((s) => s.jitterMs), 0.5), p95: pct(samples.map((s) => s.jitterMs), 0.95) },
  playoutMs: { p50: pct(samples.map((s) => s.playoutMs), 0.5), p95: pct(samples.map((s) => s.playoutMs), 0.95) },
  concealedPct: { p50: pct(samples.map((s) => s.concealed * 100), 0.5), max: pct(samples.map((s) => s.concealed * 100), 1) },
  workerCpuPct: cpuSamples.length ? { avg: cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length, max: Math.max(...cpuSamples) } : undefined,
  workerRssMB: rssSamples.length ? { max: Math.max(...rssSamples) / 1048576 } : undefined,
  pairs: pairs.map((pair) => {
    const s = samples.filter((x) => `${x.receiver} ← ${x.sender}` === pair);
    const packets = s.reduce((a, x) => a + x.packets, 0);
    const lost = s.reduce((a, x) => a + x.lost, 0);
    return {
      pair,
      packetsPerS: packets / Math.max(1, s.length * INTERVAL),
      lossPct: (100 * lost) / Math.max(1, packets + lost),
      jitterP95Ms: pct(s.map((x) => x.jitterMs), 0.95),
      concealedPctFinal: s.at(-1)?.concealed !== undefined ? s.at(-1).concealed * 100 : undefined,
    };
  }),
};

const outDir = join(root, 'test-results/bench');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `quality-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify({ summary, samples }, null, 2));

console.log(`\n[${args.engine}] ${summary.label ? summary.label + ' — ' : ''}${participants.length} participants, ${DURATION}s`);
console.log(`interruptions: ${interruptions.length}${interruptions.length ? ' ' + JSON.stringify(summary.interruptions.slice(0, 5)) : ''}`);
console.log(`packet loss: ${fmt(summary.lossPct, 3)} %`);
console.log(`RTT ms p50/p95: ${fmt(summary.rttMs.p50)} / ${fmt(summary.rttMs.p95)}`);
console.log(`jitter ms p50/p95: ${fmt(summary.jitterMs.p50, 1)} / ${fmt(summary.jitterMs.p95, 1)}`);
console.log(`playout buffer ms p50/p95: ${fmt(summary.playoutMs.p50)} / ${fmt(summary.playoutMs.p95)}`);
console.log(`concealed audio % p50/max: ${fmt(summary.concealedPct.p50, 2)} / ${fmt(summary.concealedPct.max, 2)}`);
if (summary.workerCpuPct) {
  console.log(
    `worker CPU %: avg ${fmt(summary.workerCpuPct.avg, 2)}, max ${fmt(summary.workerCpuPct.max, 2)} ` +
      `(${fmt(summary.workerCpuPct.avg / participants.length, 3)} % per participant); RSS max ${fmt(summary.workerRssMB.max, 1)} MB`,
  );
}
console.log('pair                                   pkt/s   loss%   jitter p95 ms   concealed% (cumulative)');
for (const p of summary.pairs) {
  console.log(
    `${p.pair.padEnd(38)} ${fmt(p.packetsPerS, 1).padStart(6)}  ${fmt(p.lossPct, 2).padStart(6)}  ${fmt(p.jitterP95Ms, 1).padStart(12)}  ${fmt(p.concealedPctFinal, 2).padStart(10)}`,
  );
}
console.log(`\nfull data: ${outFile}`);
