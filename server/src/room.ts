import { randomUUID } from 'node:crypto';
import type { types } from 'mediasoup';
import type { Logger } from 'pino';
import {
  CloseCode,
  SOURCE_KIND,
  type ErrorCode,
  type Notification,
  type ParticipantInfo,
  type RequestData,
  type ResponseData,
  type Source,
} from '@voxonow/voice-protocol';
import { MEDIA_CODECS, type MediaWorker, type WorkerPool } from './worker-pool.js';

/** A request the client made that cannot be honoured; becomes an error response. */
export class RequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** How a room reaches a participant's connection, without knowing it is a WebSocket. */
export interface PeerConnection {
  notify(notification: Notification): void;
  close(code: number, reason: string): void;
}

interface ProducerAppData extends types.AppData {
  peerId: string;
  source: Source;
}

export class Peer {
  readonly id = randomUUID();
  rtpCapabilities?: types.RtpCapabilities;
  sendTransport?: types.WebRtcTransport;
  recvTransport?: types.WebRtcTransport;
  readonly producers = new Map<string, types.Producer<ProducerAppData>>();
  readonly consumers = new Map<string, types.Consumer>();
  closed = false;

  constructor(
    readonly userId: string,
    readonly name: string,
    /** Sources this participant may publish, from the ticket. Enforced here, not in the client. */
    readonly publish: ReadonlySet<Source>,
    readonly connection: PeerConnection,
  ) {}

  get info(): ParticipantInfo {
    return { peerId: this.id, userId: this.userId, name: this.name };
  }

  transport(id: string): types.WebRtcTransport | undefined {
    if (this.sendTransport?.id === id) return this.sendTransport;
    if (this.recvTransport?.id === id) return this.recvTransport;
    return undefined;
  }

  ownProducer(id: string): types.Producer<ProducerAppData> {
    const producer = this.producers.get(id);
    if (!producer) throw new RequestError('not_found', 'no such producer');
    return producer;
  }
}

/**
 * One room = one mediasoup router on one worker (K9). Everything a peer can
 * reach is looked up through its own Peer object or this room's peer map, so
 * nothing in another room is addressable: that is the isolation guarantee.
 */
export class Room {
  readonly peers = new Map<string, Peer>();
  private closed = false;

  constructor(
    readonly id: string,
    private readonly router: types.Router,
    private readonly worker: MediaWorker,
    private readonly logger: Logger,
    private readonly onClose: (room: Room) => void,
  ) {
    router.observer.on('close', () => this.handleRouterClosed());
  }

  get workerIndex(): number {
    return this.worker.index;
  }

  get rtpCapabilities(): types.RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  /** Adds a participant. The same user joining again replaces their old connection. */
  join(peer: Peer): ResponseData['join'] {
    if (this.closed) throw new RequestError('conflict', 'room closed');
    for (const existing of this.peers.values()) {
      if (existing.userId === peer.userId) {
        existing.connection.close(CloseCode.Replaced, 'joined from another connection');
        this.leave(existing);
      }
    }
    const participants = [...this.peers.values()].map((other) => other.info);
    this.peers.set(peer.id, peer);
    this.broadcast(peer, { notification: 'participantJoined', data: peer.info });
    return {
      peerId: peer.id,
      roomId: this.id,
      routerRtpCapabilities: this.router.rtpCapabilities as unknown as Record<string, unknown>,
      participants,
    };
  }

  leave(peer: Peer): void {
    if (peer.closed) return;
    peer.closed = true;
    // Closing the transports closes the peer's producers and consumers; the
    // other peers' consumers of those producers fire `producerclose`.
    peer.sendTransport?.close();
    peer.recvTransport?.close();
    this.peers.delete(peer.id);
    this.broadcast(peer, { notification: 'participantLeft', data: { peerId: peer.id } });
    if (this.peers.size === 0) this.close();
  }

  async createTransport(
    peer: Peer,
    { direction }: RequestData['createTransport'],
  ): Promise<ResponseData['createTransport']> {
    const existing = direction === 'send' ? peer.sendTransport : peer.recvTransport;
    if (existing) throw new RequestError('conflict', `${direction} transport already exists`);

    const transport = await this.router.createWebRtcTransport({
      webRtcServer: this.worker.webRtcServer,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
      appData: { peerId: peer.id, direction },
    });
    if (peer.closed) {
      transport.close();
      throw new RequestError('conflict', 'participant left');
    }
    transport.on('dtlsstatechange', (state) => {
      if (state === 'failed' || state === 'closed') {
        this.logger.warn({ peer: peer.id, transport: transport.id, state }, 'transport DTLS ended');
      }
    });
    if (direction === 'send') peer.sendTransport = transport;
    else peer.recvTransport = transport;

    return {
      id: transport.id,
      iceParameters: transport.iceParameters as unknown as Record<string, unknown>,
      iceCandidates: transport.iceCandidates as unknown as Record<string, unknown>[],
      dtlsParameters: transport.dtlsParameters as unknown as Record<string, unknown>,
    };
  }

  async connectTransport(peer: Peer, { transportId, dtlsParameters }: RequestData['connectTransport']): Promise<void> {
    const transport = peer.transport(transportId);
    if (!transport) throw new RequestError('not_found', 'no such transport');
    await transport.connect({ dtlsParameters: dtlsParameters as unknown as types.DtlsParameters });
  }

  /** The client can now receive: consume every track already in the room. */
  async ready(peer: Peer, { rtpCapabilities }: RequestData['ready']): Promise<void> {
    if (!peer.recvTransport) throw new RequestError('conflict', 'create the recv transport first');
    if (peer.rtpCapabilities) throw new RequestError('conflict', 'already ready');
    peer.rtpCapabilities = rtpCapabilities as unknown as types.RtpCapabilities;
    for (const other of this.peers.values()) {
      if (other === peer) continue;
      for (const producer of other.producers.values()) await this.consume(peer, other, producer);
    }
  }

  async produce(
    peer: Peer,
    { transportId, kind, rtpParameters, source }: RequestData['produce'],
  ): Promise<ResponseData['produce']> {
    if (!peer.publish.has(source)) throw new RequestError('forbidden', `not allowed to publish ${source}`);
    if (SOURCE_KIND[source] !== kind) throw new RequestError('bad_request', `${source} must be ${SOURCE_KIND[source]}`);
    if (!peer.sendTransport || peer.sendTransport.id !== transportId) {
      throw new RequestError('not_found', 'no such send transport');
    }
    for (const existing of peer.producers.values()) {
      if (existing.appData.source === source) throw new RequestError('conflict', `${source} already published`);
    }

    const producer = await peer.sendTransport.produce<ProducerAppData>({
      kind,
      rtpParameters: rtpParameters as unknown as types.RtpParameters,
      appData: { peerId: peer.id, source },
    });
    if (peer.closed) {
      producer.close();
      throw new RequestError('conflict', 'participant left');
    }
    peer.producers.set(producer.id, producer);
    producer.observer.on('close', () => peer.producers.delete(producer.id));

    for (const other of this.peers.values()) {
      if (other !== peer) await this.consume(other, peer, producer);
    }
    return { producerId: producer.id };
  }

  closeProducer(peer: Peer, { producerId }: RequestData['closeProducer']): void {
    peer.ownProducer(producerId).close();
  }

  async pauseProducer(peer: Peer, { producerId }: RequestData['pauseProducer']): Promise<void> {
    await peer.ownProducer(producerId).pause();
  }

  async resumeProducer(peer: Peer, { producerId }: RequestData['resumeProducer']): Promise<void> {
    await peer.ownProducer(producerId).resume();
  }

  async resumeConsumer(peer: Peer, { consumerId }: RequestData['resumeConsumer']): Promise<void> {
    const consumer = peer.consumers.get(consumerId);
    if (!consumer) throw new RequestError('not_found', 'no such consumer');
    await consumer.resume();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.router.close();
    this.onClose(this);
  }

  private async consume(peer: Peer, owner: Peer, producer: types.Producer<ProducerAppData>): Promise<void> {
    const transport = peer.recvTransport;
    const rtpCapabilities = peer.rtpCapabilities;
    if (!transport || !rtpCapabilities || peer.closed || producer.closed) return;
    if (!this.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      this.logger.warn({ peer: peer.id, producer: producer.id }, 'peer cannot consume producer');
      return;
    }

    let consumer: types.Consumer;
    try {
      // Paused until the client has wired the track up, so no early packets
      // (or keyframes) are lost.
      consumer = await transport.consume({ producerId: producer.id, rtpCapabilities, paused: true });
    } catch (error) {
      // The producer or transport closed while this was in flight.
      this.logger.debug({ err: error, peer: peer.id, producer: producer.id }, 'consume skipped');
      return;
    }
    peer.consumers.set(consumer.id, consumer);
    const consumerId = consumer.id;
    consumer.observer.on('close', () => peer.consumers.delete(consumerId));
    consumer.on('producerclose', () => {
      peer.consumers.delete(consumerId);
      peer.connection.notify({ notification: 'consumerClosed', data: { consumerId } });
    });
    consumer.on('producerpause', () => peer.connection.notify({ notification: 'consumerPaused', data: { consumerId } }));
    consumer.on('producerresume', () =>
      peer.connection.notify({ notification: 'consumerResumed', data: { consumerId } }),
    );

    peer.connection.notify({
      notification: 'newConsumer',
      data: {
        consumerId,
        producerId: producer.id,
        peerId: owner.id,
        kind: consumer.kind,
        source: producer.appData.source,
        rtpParameters: consumer.rtpParameters as unknown as Record<string, unknown>,
        producerPaused: consumer.producerPaused,
      },
    });
  }

  private broadcast(except: Peer, notification: Notification): void {
    for (const peer of this.peers.values()) {
      if (peer !== except) peer.connection.notify(notification);
    }
  }

  private handleRouterClosed(): void {
    if (this.closed) return;
    // Router closed underneath us: its worker died.
    this.closed = true;
    this.logger.error({ room: this.id, worker: this.worker.index }, 'room lost its media worker');
    for (const peer of this.peers.values()) {
      peer.closed = true;
      peer.connection.close(CloseCode.RoomClosed, 'media server error');
    }
    this.peers.clear();
    this.onClose(this);
  }
}

/** Finds or creates rooms; concurrent joins to a new room share one creation. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly creating = new Map<string, Promise<Room>>();

  constructor(
    private readonly pool: WorkerPool,
    private readonly logger: Logger,
  ) {}

  get size(): number {
    return this.rooms.size;
  }

  has(id: string): boolean {
    return this.rooms.has(id);
  }

  async getOrCreate(id: string): Promise<Room> {
    const existing = this.rooms.get(id);
    if (existing) return existing;
    const pending = this.creating.get(id);
    if (pending) return pending;

    const creation = (async () => {
      const worker = this.pool.acquire();
      const router = await worker.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
      worker.routers += 1;
      router.observer.on('close', () => {
        worker.routers -= 1;
      });
      const room = new Room(id, router, worker, this.logger.child({ room: id }), (closed) => {
        if (this.rooms.get(closed.id) === closed) this.rooms.delete(closed.id);
      });
      this.rooms.set(id, room);
      this.logger.info({ room: id, worker: worker.index }, 'room opened');
      return room;
    })();
    this.creating.set(id, creation);
    try {
      return await creation;
    } finally {
      this.creating.delete(id);
    }
  }

  closeAll(): void {
    for (const room of [...this.rooms.values()]) room.close();
  }
}
