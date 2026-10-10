import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino, type Logger } from 'pino';
import type { Config } from './config.js';
import { RoomManager } from './room.js';
import { Signaling, type SignalingLimits } from './signaling.js';
import { TicketVerifier } from './tickets.js';
import { WorkerPool } from './worker-pool.js';

export interface VoiceServer {
  http: Server;
  rooms: RoomManager;
  pool: WorkerPool;
  signaling: Signaling;
  /** Actual bound port (useful when configured with port 0). */
  port: number;
  close(): Promise<void>;
}

export async function startVoiceServer(
  config: Config,
  options: { logger?: Logger; limits?: Partial<SignalingLimits> } = {},
): Promise<VoiceServer> {
  const logger = options.logger ?? pino({ level: config.logLevel });
  const tickets = await TicketVerifier.create(config.ticket);

  const pool = new WorkerPool({
    numWorkers: config.numWorkers,
    listenIp: config.rtcListenIp,
    announcedAddress: config.rtcAnnouncedAddress,
    portBase: config.rtcPortBase,
    logger,
  });
  await pool.start();

  const rooms = new RoomManager(pool, logger);
  const signaling = new Signaling({
    rooms,
    tickets,
    allowedOrigins: config.allowedOrigins,
    logger,
    limits: options.limits,
  });

  const http = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      const healthy = pool.liveWorkers === config.numWorkers;
      response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: healthy, workers: pool.liveWorkers, rooms: rooms.size }));
      return;
    }
    response.writeHead(404).end();
  });
  http.on('upgrade', (request, socket, head) => signaling.handleUpgrade(request, socket, head));

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.host, () => resolve());
  });
  const port = (http.address() as AddressInfo).port;
  logger.info({ port, workers: config.numWorkers, rtcPortBase: config.rtcPortBase }, 'voice server listening');

  return {
    http,
    rooms,
    pool,
    signaling,
    port,
    async close() {
      signaling.close();
      rooms.closeAll();
      pool.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
