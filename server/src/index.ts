import { loadConfig } from './config.js';
import { startVoiceServer } from './server.js';

const config = loadConfig();
const server = await startVoiceServer(config);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`received ${signal}, shutting down`);
  await server.close();
  process.exit(0);
}
// Prepended: mediasoup adds its own SIGTERM/SIGINT listeners when it starts a
// worker, and those close the worker at once. Running after them, every room
// saw its worker die and told clients 4010 (media server error) instead of
// 4011 (planned shutdown). Our listener runs first and closes the signaling
// sockets with 4011 synchronously, before any worker goes away.
process.prependListener('SIGTERM', () => void shutdown('SIGTERM'));
process.prependListener('SIGINT', () => void shutdown('SIGINT'));
