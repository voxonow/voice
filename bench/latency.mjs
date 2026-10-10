// Latency A/B: our engine vs LiveKit, same browser, same machine, same probe.
//
//   npm run bench:latency
//
// Needs the local LiveKit from team-comms running (docker compose up livekit
// in ~/team-comms; ws://localhost:7880, devkey). Set LIVEKIT_URL / LIVEKIT_KEY
// / LIVEKIT_SECRET to point elsewhere, or SKIP_LIVEKIT=1 to measure ours only.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { SignJWT, importPKCS8 } from 'jose';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const BEEPS = Number(process.env.BEEPS || 20);
const ROUNDS = Number(process.env.ROUNDS || 3);
const voicePort = 7830;
const pagePort = 5199;
const livekitUrl = process.env.LIVEKIT_URL || 'ws://localhost:7880';
const livekitKey = process.env.LIVEKIT_KEY || 'devkey';
const livekitSecret = process.env.LIVEKIT_SECRET || 'local-dev-livekit-secret-not-for-production-use';

await build({
  entryPoints: [join(here, 'src/probe.ts')],
  outfile: join(here, 'dist/probe.js'),
  bundle: true,
  format: 'esm',
  target: 'chrome110',
  logLevel: 'warning',
});

const page = createServer((request, response) => {
  if (request.url === '/probe.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(here, 'dist/probe.js')));
  } else {
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><script type="module" src="/probe.js"></script>');
  }
}).listen(pagePort);

// EXTERNAL_VOICE_URL: measure an already running voice server (e.g. in Docker)
// instead of starting one; its ALLOWED_ORIGINS must include this page.
const external = process.env.EXTERNAL_VOICE_URL;
const voiceUrl = external ?? `ws://localhost:${voicePort}/ws`;
const healthUrl = external ? external.replace(/^ws/, 'http').replace(/\/ws$/, '/healthz') : `http://localhost:${voicePort}/healthz`;
const voice = external ? undefined : spawn(process.execPath, [join(root, 'scripts/dev.mjs'), '--no-build'], {
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(voicePort),
    DEMO_PORT: '5198',
    RTC_PORT_BASE: '40300',
    NUM_WORKERS: '1',
    LOG_LEVEL: 'warn',
    ALLOWED_ORIGINS: `http://localhost:${pagePort}`,
    DEV_LOG_DIR: join(root, 'test-results/bench-logs'),
  },
});
for (let i = 0; ; i++) {
  try {
    if ((await fetch(healthUrl)).ok) break;
  } catch {}
  if (i > 50) throw new Error('voice server did not start');
  await new Promise((r) => setTimeout(r, 200));
}

const ticketKey = await importPKCS8(readFileSync(join(root, '.dev-keys/ticket-private.pem'), 'utf8'), 'EdDSA');
const ticket = (room) =>
  new SignJWT({ room, name: 'bench', publish: ['microphone'] })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('voxonow-api')
    .setAudience('voxonow-voice')
    .setSubject(`bench-${randomUUID()}`)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(ticketKey);
const livekitToken = (room) =>
  new SignJWT({ video: { room, roomJoin: true, canPublish: true, canSubscribe: true } })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(livekitKey)
    .setSubject(`bench-${randomUUID()}`)
    .setNotBefore(Math.floor(Date.now() / 1000) - 5)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(livekitSecret));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const results = { 'voxonow (mediasoup)': [], livekit: [] };
const bitrate = {};
try {
  for (let round = 0; round < ROUNDS; round++) {
    const room = `bench-${Date.now()}-${round}`;
    const tab = await browser.newPage();
    await tab.goto(`http://localhost:${pagePort}/`);
    await tab.waitForFunction(() => 'probeVoxonow' in window);

    const ours = await tab.evaluate(
      ([url, tickets, beeps]) => window.probeVoxonow(url, tickets, beeps),
      [voiceUrl, [await ticket(room), await ticket(room)], BEEPS],
    );
    results[ours.engine].push(...ours.samples);
    console.log(`round ${round + 1} ${ours.engine}: ${ours.samples.join(' ')} (missed ${ours.missed})`);

    if (!process.env.SKIP_LIVEKIT) {
      const theirs = await tab.evaluate(
        ([url, tokens, beeps]) => window.probeLiveKit(url, tokens, beeps),
        [livekitUrl, [await livekitToken(room), await livekitToken(room)], BEEPS],
      );
      results[theirs.engine].push(...theirs.samples);
      if (theirs.sendBitrateKbps) bitrate.livekit = theirs.sendBitrateKbps;
      console.log(`round ${round + 1} ${theirs.engine}: ${theirs.samples.join(' ')} (missed ${theirs.missed})`);
    }
    await tab.close();
  }
} finally {
  await browser.close();
  voice?.kill('SIGTERM');
  page.close();
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
console.log('\nengine                 n    min  median  p90   max   (ms, beep sent → beep detected)');
for (const [engine, samples] of Object.entries(results)) {
  if (!samples.length) continue;
  const s = [...samples].sort((a, b) => a - b);
  console.log(
    `${engine.padEnd(22)} ${String(s.length).padStart(3)}  ${String(s[0]).padStart(4)}  ${String(pct(s, 0.5)).padStart(6)}  ${String(pct(s, 0.9)).padStart(4)}  ${String(s.at(-1)).padStart(4)}`,
  );
}
