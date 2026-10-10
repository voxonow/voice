import { EventEmitter } from 'node:events';
import * as mediasoup from 'mediasoup';
import type { types } from 'mediasoup';
import type { Logger } from 'pino';

export const MEDIA_CODECS: types.RouterRtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
];

export interface MediaWorker {
  index: number;
  worker: types.Worker;
  webRtcServer: types.WebRtcServer;
  /** Routers (rooms) currently placed on this worker. */
  routers: number;
}

interface WorkerPoolEvents {
  /** A worker died; every room on it is gone. A replacement is being started. */
  workerDied: [index: number];
}

/**
 * One mediasoup worker per configured slot, each with a WebRtcServer on its
 * own fixed port (UDP + TCP). Rooms go to the worker with the fewest routers.
 *
 * Least-routers is the M0 placement rule; M7's load tests decide the real one
 * (K9 in docs/ROADMAP.md).
 */
export class WorkerPool extends EventEmitter<WorkerPoolEvents> {
  private readonly slots: (MediaWorker | undefined)[];
  private closed = false;

  constructor(
    private readonly options: {
      numWorkers: number;
      listenIp: string;
      announcedAddress: string;
      portBase: number;
      logger: Logger;
    },
  ) {
    super();
    this.slots = new Array(options.numWorkers).fill(undefined);
  }

  async start(): Promise<void> {
    await Promise.all(this.slots.map((_, index) => this.startWorker(index)));
  }

  /** Picks the least-loaded live worker for a new room. */
  acquire(): MediaWorker {
    let best: MediaWorker | undefined;
    for (const slot of this.slots) {
      if (slot && !slot.worker.died && (!best || slot.routers < best.routers)) best = slot;
    }
    if (!best) throw new Error('no media worker available');
    return best;
  }

  get liveWorkers(): number {
    return this.slots.filter((slot) => slot && !slot.worker.died).length;
  }

  close(): void {
    this.closed = true;
    for (const slot of this.slots) slot?.worker.close();
  }

  private async startWorker(index: number): Promise<void> {
    const { logger } = this.options;
    const port = this.options.portBase + index;
    const worker = await mediasoup.createWorker({ logLevel: 'warn' });
    const webRtcServer = await worker.createWebRtcServer({
      listenInfos: [
        { protocol: 'udp', ip: this.options.listenIp, announcedAddress: this.options.announcedAddress, port },
        { protocol: 'tcp', ip: this.options.listenIp, announcedAddress: this.options.announcedAddress, port },
      ],
    });
    const slot: MediaWorker = { index, worker, webRtcServer, routers: 0 };
    this.slots[index] = slot;

    worker.on('died', (error) => {
      logger.error({ err: error, worker: index, workerPid: worker.pid }, 'media worker died');
      if (this.slots[index] === slot) this.slots[index] = undefined;
      this.emit('workerDied', index);
      if (this.closed) return;
      // The dead process released its port, so the replacement can take the
      // same slot. Retry with backoff in case it has not been released yet.
      void this.restart(index);
    });
    logger.info({ worker: index, workerPid: worker.pid, port }, 'media worker started');
  }

  private async restart(index: number, attempt = 1): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 10_000)));
    if (this.closed) return;
    try {
      await this.startWorker(index);
    } catch (error) {
      this.options.logger.error({ err: error, worker: index, attempt }, 'media worker restart failed');
      void this.restart(index, attempt + 1);
    }
  }
}
