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
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
