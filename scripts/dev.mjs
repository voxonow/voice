// Local development: builds everything, then runs the voice server and the
// demo page together. Ctrl+C stops both.
//
//   npm run dev              build + run
//   npm run dev -- --no-build  run what is already built (used by e2e tests)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

const voicePort = process.env.PORT || '7800';
const demoPort = process.env.DEMO_PORT || '5173';

const children = [
  spawn(process.execPath, [join(root, 'server/dist/index.js')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: voicePort,
      RTC_ANNOUNCED_ADDRESS: process.env.RTC_ANNOUNCED_ADDRESS || '127.0.0.1',
      NUM_WORKERS: process.env.NUM_WORKERS || '2',
      TICKET_PUBLIC_KEY_FILE: join(keys, 'ticket-public.pem'),
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || `http://localhost:${demoPort},http://127.0.0.1:${demoPort}`,
    },
  }),
  spawn(process.execPath, [join(root, 'demo/dev-server.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, DEMO_PORT: demoPort, VOICE_URL: `ws://localhost:${voicePort}/ws` },
  }),
];

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
