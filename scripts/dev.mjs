// Local development: builds everything, then runs the voice server and the
// demo page together. Ctrl+C stops both.
//
//   npm run dev              build + run
//   npm run dev -- --no-build  run what is already built (used by e2e tests)
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keys = join(root, '.dev-keys');

if (!existsSync(join(keys, 'ticket-public.pem'))) {
  spawnSync(process.execPath, [join(root, 'demo/scripts/generate-keys.mjs')], { stdio: 'inherit' });
}
if (!process.argv.includes('--no-build')) {
  const built = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

/**
 * The address media is announced on. Not 127.0.0.1: Firefox gathers ICE
 * candidates only on real interfaces and never pairs them with a loopback
 * address, so a loopback announcement silently fails there.
 */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

const voicePort = process.env.PORT || '7800';
// Everything the voice server prints also goes to .dev-logs/voice.log, and the
// demo page sends its browser-side events to .dev-logs/clients.log.
const logDir = process.env.DEV_LOG_DIR || join(root, '.dev-logs');
mkdirSync(logDir, { recursive: true });
const voiceLog = createWriteStream(join(logDir, 'voice.log'), { flags: 'a' });
const demoPort = process.env.DEMO_PORT || '5173';

const children = [
  spawn(process.execPath, [join(root, 'server/dist/index.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: voicePort,
      RTC_ANNOUNCED_ADDRESS: process.env.RTC_ANNOUNCED_ADDRESS || lanAddress(),
      NUM_WORKERS: process.env.NUM_WORKERS || '2',
      TICKET_PUBLIC_KEY_FILE: join(keys, 'ticket-public.pem'),
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || `http://localhost:${demoPort},http://127.0.0.1:${demoPort}`,
    },
  }),
  spawn(process.execPath, [join(root, 'demo/dev-server.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, DEMO_PORT: demoPort, VOICE_URL: `ws://localhost:${voicePort}/ws`, DEV_LOG_DIR: logDir },
  }),
];
for (const stream of [children[0].stdout, children[0].stderr]) {
  stream.on('data', (chunk) => {
    process.stdout.write(chunk);
    voiceLog.write(chunk);
  });
}

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}
for (const child of children) child.on('exit', (code) => stop(code ?? 1));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
