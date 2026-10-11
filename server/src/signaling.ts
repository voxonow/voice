import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Logger } from 'pino';
import {
  CloseCode,
  SIGNALING_PATH,
  type Method,
  type Notification,
  type RequestData,
  type Response,
} from '@voxonow/voice-protocol';
import { RequestEnvelope, RequestSchemas } from '@voxonow/voice-protocol/schemas';
import { TokenBucket } from './rate-limit.js';
import { Peer, RequestError, type PeerConnection, type Room, type RoomManager } from './room.js';
import { TicketError, type TicketVerifier } from './tickets.js';

export const SIGNALING_LIMITS = {
  /** A connection that has not sent a valid `join` by then is closed. */
  authTimeoutMs: 5_000,
  /** Largest accepted message. Browser RTP capabilities are ~10 KB. */
  maxPayloadBytes: 64 * 1024,
  messagesPerSecond: 20,
  messageBurst: 60,
  /** Ping interval; a connection that misses one pong is dropped. */
  heartbeatMs: 15_000,
};

export type SignalingLimits = typeof SIGNALING_LIMITS;

interface SignalingOptions {
  rooms: RoomManager;
  tickets: TicketVerifier;
  allowedOrigins: string[];
  logger: Logger;
  limits?: Partial<SignalingLimits>;
}

/**
 * The signaling endpoint: authenticates each socket with a join ticket, then
 * routes its requests to the room it joined.
 */
export class Signaling {
  private readonly wss: WebSocketServer;
  private readonly limits: SignalingLimits;
  private readonly connections = new Set<Connection>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly options: SignalingOptions) {
    this.limits = { ...SIGNALING_LIMITS, ...options.limits };
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.limits.maxPayloadBytes });
    this.heartbeat = setInterval(() => {
      for (const connection of this.connections) connection.checkAlive();
    }, this.limits.heartbeatMs);
    this.heartbeat.unref();
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Handles an HTTP upgrade; rejects wrong paths and disallowed browser origins. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== SIGNALING_PATH) return reject(socket, 404, 'Not Found');
    const origin = request.headers.origin;
    if (origin !== undefined && !this.options.allowedOrigins.includes(origin)) {
      this.options.logger.warn({ origin }, 'signaling origin rejected');
      return reject(socket, 403, 'Forbidden');
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      const connection = new Connection(ws, this.options, this.limits, () => this.connections.delete(connection));
      this.connections.add(connection);
    });
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const connection of this.connections) connection.close(CloseCode.ServerShutdown, 'server shutting down');
    this.wss.close();
  }
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

class Connection implements PeerConnection {
  private readonly bucket: TokenBucket;
  private readonly authTimer: NodeJS.Timeout;
  private readonly logger: Logger;
  private peer?: Peer;
  private room?: Room;
  /** Set while `join` is in flight, so a second message cannot race it. */
  private joining = false;
  private alive = true;
  /** Requests run one at a time, in arrival order, like the client sent them. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ws: WebSocket,
    private readonly options: SignalingOptions,
    limits: SignalingLimits,
    private readonly onClosed: () => void,
  ) {
    this.logger = options.logger.child({ conn: Math.random().toString(36).slice(2, 10) });
    this.bucket = new TokenBucket(limits.messagesPerSecond, limits.messageBurst);
    this.authTimer = setTimeout(() => this.close(CloseCode.JoinTimeout, 'join timeout'), limits.authTimeoutMs);

    ws.on('message', (raw, isBinary) => this.onMessage(raw, isBinary));
    ws.on('pong', () => {
      this.alive = true;
    });
    ws.on('close', () => this.onSocketClosed());
    ws.on('error', (error) => this.logger.debug({ err: error }, 'socket error'));
  }

  notify(notification: Notification): void {
    this.send(notification);
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === this.ws.CLOSING || this.ws.readyState === this.ws.CLOSED) return;
    this.ws.close(code, reason);
  }

  checkAlive(): void {
    if (!this.alive) {
      this.logger.info({ peer: this.peer?.id }, 'heartbeat missed, dropping connection');
      this.ws.terminate();
      return;
    }
    this.alive = false;
    this.ws.ping();
  }

  private onMessage(raw: RawData, isBinary: boolean): void {
    if (!this.bucket.take()) {
      this.logger.warn({ peer: this.peer?.id }, 'rate limit exceeded');
      return this.close(CloseCode.RateLimited, 'rate limit exceeded');
    }
    if (isBinary) return this.close(1003, 'binary messages are not accepted');

    let envelope;
    try {
      envelope = RequestEnvelope.parse(JSON.parse(raw.toString()));
    } catch {
      return this.close(1007, 'malformed message');
    }

    if (!this.peer) {
      // Until a join succeeds, the only acceptable message is that join.
      if (envelope.method !== 'join' || this.joining) return this.close(CloseCode.AuthRequired, 'join first');
      this.joining = true;
    }
    this.queue = this.queue.then(() => this.handle(envelope.id, envelope.method, envelope.data));
  }

  private async handle(id: number, method: string, data: unknown): Promise<void> {
    if (!(method in RequestSchemas)) return this.respondError(id, 'bad_request', `unknown method ${method}`);
    const schema = RequestSchemas[method as Method];
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      if (method === 'join') return this.close(CloseCode.AuthRequired, 'malformed join');
      return this.respondError(id, 'bad_request', 'invalid request data');
    }

    try {
      const result = await this.dispatch(method as Method, parsed.data);
      this.send({ id, ok: true, data: result ?? {} } satisfies Response);
    } catch (error) {
      if (error instanceof RequestError) return this.respondError(id, error.code, error.message);
      this.logger.error({ err: error, method, peer: this.peer?.id }, 'request failed');
      this.respondError(id, 'internal', 'internal error');
    }
  }

  private async dispatch(method: Method, data: unknown): Promise<unknown> {
    if (method === 'join') return this.join(data as RequestData['join']);

    const { peer, room } = this;
    if (!peer || !room) throw new RequestError('unauthorized', 'not joined');
    switch (method) {
      case 'createTransport':
        return room.createTransport(peer, data as never);
      case 'connectTransport':
        return room.connectTransport(peer, data as never);
      case 'ready':
        return room.ready(peer, data as never);
      case 'produce':
        return room.produce(peer, data as never);
      case 'closeProducer':
        return room.closeProducer(peer, data as never);
      case 'pauseProducer':
        return room.pauseProducer(peer, data as never);
      case 'resumeProducer':
        return room.resumeProducer(peer, data as never);
      case 'resumeConsumer':
        return room.resumeConsumer(peer, data as never);
      case 'ping':
        // Client liveness check; answering is the whole point.
        return {};
      case 'leave':
        // Respond first, then close: the client awaits the answer.
        setImmediate(() => this.close(CloseCode.Left, 'left'));
        return {};
    }
  }

  private async join({ ticket }: RequestData['join']): Promise<unknown> {
    let claims;
    try {
      claims = await this.options.tickets.verify(ticket);
    } catch (error) {
      if (!(error instanceof TicketError)) throw error;
      this.logger.warn({ reason: error.message }, 'ticket rejected');
      this.close(CloseCode.Unauthorized, 'invalid ticket');
      throw new RequestError('unauthorized', 'invalid ticket');
    }
    if (this.ws.readyState !== this.ws.OPEN) throw new RequestError('conflict', 'connection closed');

    const peer = new Peer(claims.sub, claims.name, new Set(claims.publish), this);
    // A room can close (last peer left) between lookup and join; one retry
    // gets a fresh room.
    for (let attempt = 0; ; attempt++) {
      const room = await this.options.rooms.getOrCreate(claims.room);
      try {
        const result = room.join(peer);
        if (this.ws.readyState !== this.ws.OPEN) {
          // The socket closed while the join was in flight; its close handler
          // already ran and found no peer, so leave here or the peer is orphaned.
          room.leave(peer);
          throw new RequestError('conflict', 'connection closed');
        }
        clearTimeout(this.authTimer);
        this.peer = peer;
        this.room = room;
        this.logger.info({ peer: peer.id, user: claims.sub, room: claims.room }, 'joined');
        return result;
      } catch (error) {
        if (!(error instanceof RequestError) || error.code !== 'conflict' || attempt > 0) throw error;
      }
    }
  }

  private respondError(id: number, code: Extract<Response, { ok: false }>['error']['code'], message: string): void {
    this.send({ id, ok: false, error: { code, message } } satisfies Response);
  }

  private send(message: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  private onSocketClosed(): void {
    clearTimeout(this.authTimer);
    if (this.peer && this.room) {
      this.room.leave(this.peer);
      this.logger.info({ peer: this.peer.id }, 'left');
    }
    this.onClosed();
  }
}
