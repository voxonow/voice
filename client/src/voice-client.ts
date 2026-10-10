import { Device, types } from 'mediasoup-client';
import {
  PROTOCOL_VERSION,
  SOURCE_KIND,
  type Method,
  type Notification,
  type Notifications,
  type ParticipantInfo,
  type RequestData,
  type Response,
  type ResponseData,
  type Source,
} from '@voxonow/voice-protocol';
import { Emitter } from './emitter.js';

export interface VoiceClientOptions {
  /** Signaling URL, e.g. `wss://voice.voxonow.com/ws`. */
  url: string;
  /** WebSocket implementation; defaults to the global one. */
  WebSocket?: typeof WebSocket;
  /** STUN/TURN servers handed to the peer connections. */
  iceServers?: RTCIceServer[];
  requestTimeoutMs?: number;
}

export interface RemoteTrack {
  /** Consumer id; unique per subscription. */
  id: string;
  peerId: string;
  source: Source;
  kind: 'audio' | 'video';
  track: MediaStreamTrack;
  /** The publisher has muted it (paused its producer). */
  muted: boolean;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

export type VoiceClientEvents = {
  participantJoined: [ParticipantInfo];
  participantLeft: [ParticipantInfo];
  trackSubscribed: [RemoteTrack];
  trackUnsubscribed: [RemoteTrack];
  trackMuted: [RemoteTrack];
  trackUnmuted: [RemoteTrack];
  disconnected: [{ code: number; reason: string }];
  /**
   * Media path state of the send or receive transport. `failed` means media
   * cannot flow (e.g. ICE found no working route) even though signaling is up.
   * Automatic recovery is M2; until then the app should tell the user.
   */
  mediaStateChanged: [{ direction: 'send' | 'recv'; state: RTCPeerConnectionState }];
};

export class VoiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One participant's connection to a Voxonow voice room.
 *
 * ```ts
 * const client = new VoiceClient({ url });
 * client.on('trackSubscribed', (t) => attach(t.track));
 * await client.join(ticket);
 * await client.publish(micTrack, 'microphone');
 * ```
 */
export class VoiceClient extends Emitter<VoiceClientEvents> {
  state: ConnectionState = 'idle';
  peerId?: string;
  roomId?: string;
  readonly participants = new Map<string, ParticipantInfo>();
  readonly tracks = new Map<string, RemoteTrack>();

  private ws?: WebSocket;
  private device?: Device;
  private sendTransport?: types.Transport;
  private recvTransport?: types.Transport;
  private readonly producers = new Map<Source, types.Producer>();
  private readonly consumers = new Map<string, types.Consumer>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** Notifications are applied one at a time so close never overtakes create. */
  private notificationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: VoiceClientOptions) {
    super();
  }

  async join(ticket: string): Promise<{ peerId: string; roomId: string }> {
    if (this.state !== 'idle') throw new VoiceError('invalid_state', `cannot join from state ${this.state}`);
    this.state = 'connecting';
    try {
      await this.openSocket();
      const joined = await this.request('join', { ticket, protocol: PROTOCOL_VERSION });
      this.peerId = joined.peerId;
      this.roomId = joined.roomId;
      for (const participant of joined.participants) this.participants.set(participant.peerId, participant);

      this.device = await Device.factory();
      await this.device.load({
        routerRtpCapabilities: joined.routerRtpCapabilities as unknown as types.RtpCapabilities,
      });

      this.recvTransport = await this.createTransport('recv');
      await this.request('ready', {
        rtpCapabilities: this.device.rtpCapabilities as unknown as Record<string, unknown>,
      });
      this.state = 'connected';
      for (const participant of joined.participants) this.emit('participantJoined', participant);
      return { peerId: joined.peerId, roomId: joined.roomId };
    } catch (error) {
      this.teardown(1000, 'join failed');
      throw error;
    }
  }

  /** Publishes a local track as the given source. Returns its producer id. */
  async publish(track: MediaStreamTrack, source: Source): Promise<string> {
    this.assertConnected();
    if (SOURCE_KIND[source] !== track.kind) throw new VoiceError('bad_request', `${source} needs a ${SOURCE_KIND[source]} track`);
    if (this.producers.has(source)) throw new VoiceError('conflict', `${source} already published`);
    if (!this.sendTransport) this.sendTransport = await this.createTransport('send');

    const producer = await this.sendTransport.produce({
      track,
      appData: { source },
      // Opus: in-band FEC and DTX keep speech intelligible on lossy links and
      // cheap when silent.
      codecOptions: track.kind === 'audio' ? { opusFec: true, opusDtx: true } : undefined,
      stopTracks: false,
    });
    this.producers.set(source, producer);
    return producer.id;
  }

  /** Mutes or unmutes a published source; the server stops forwarding it while muted. */
  async setMuted(source: Source, muted: boolean): Promise<void> {
    const producer = this.producers.get(source);
    if (!producer) throw new VoiceError('not_found', `${source} is not published`);
    if (muted) {
      producer.pause();
      await this.request('pauseProducer', { producerId: producer.id });
    } else {
      await this.request('resumeProducer', { producerId: producer.id });
      producer.resume();
    }
  }

  async unpublish(source: Source): Promise<void> {
    const producer = this.producers.get(source);
    if (!producer) return;
    this.producers.delete(source);
    producer.close();
    await this.request('closeProducer', { producerId: producer.id });
  }

  async leave(): Promise<void> {
    if (this.state === 'connected') {
      try {
        await this.request('leave', {});
      } catch {
        // Leaving anyway.
      }
    }
    this.teardown(1000, 'left');
  }

  /** Raw WebRTC stats, for quality measurement (RTT, jitter, loss, concealment). */
  async getStats(): Promise<{ send?: RTCStatsReport; recv?: RTCStatsReport }> {
    const [send, recv] = await Promise.all([this.sendTransport?.getStats(), this.recvTransport?.getStats()]);
    return { send, recv };
  }

  private assertConnected(): void {
    if (this.state !== 'connected') throw new VoiceError('invalid_state', 'not connected');
  }

  private openSocket(): Promise<void> {
    const Impl = this.options.WebSocket ?? globalThis.WebSocket;
    const ws = new Impl(this.options.url);
    this.ws = ws;
    ws.onmessage = (event) => this.onMessage(event.data);
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new VoiceError('connection_failed', 'could not reach the voice server'));
      ws.onclose = (event) => {
        reject(new VoiceError('connection_closed', event.reason || 'connection closed'));
        this.teardown(event.code, event.reason);
      };
    });
  }

  private async createTransport(direction: 'send' | 'recv'): Promise<types.Transport> {
    const device = this.device!;
    const params = await this.request('createTransport', { direction });
    const options = {
      id: params.id,
      iceParameters: params.iceParameters as unknown as types.IceParameters,
      iceCandidates: params.iceCandidates as unknown as types.IceCandidate[],
      dtlsParameters: params.dtlsParameters as unknown as types.DtlsParameters,
      iceServers: this.options.iceServers,
    };
    const transport = direction === 'send' ? device.createSendTransport(options) : device.createRecvTransport(options);

    transport.on('connectionstatechange', (state) => this.emit('mediaStateChanged', { direction, state }));
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.request('connectTransport', {
        transportId: transport.id,
        dtlsParameters: dtlsParameters as unknown as Record<string, unknown>,
      }).then(() => callback(), errback);
    });
    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        this.request('produce', {
          transportId: transport.id,
          kind,
          rtpParameters: rtpParameters as unknown as Record<string, unknown>,
          source: appData.source as Source,
        }).then(({ producerId }) => callback({ id: producerId }), errback);
      });
    }
    return transport;
  }

  private request<M extends Method>(method: M, data: RequestData[M]): Promise<ResponseData[M]> {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return Promise.reject(new VoiceError('connection_closed', 'not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VoiceError('timeout', `${method} timed out`));
      }, this.options.requestTimeoutMs ?? 10_000);
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, method, data }));
    });
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: Response | Notification;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if ('notification' in message) {
      this.notificationQueue = this.notificationQueue.then(() => this.onNotification(message as Notification));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new VoiceError(message.error.code, message.error.message));
  }

  private async onNotification(message: Notification): Promise<void> {
    try {
      switch (message.notification) {
        case 'participantJoined':
          this.participants.set(message.data.peerId, message.data);
          if (this.state === 'connected') this.emit('participantJoined', message.data);
          return;
        case 'participantLeft': {
          const participant = this.participants.get(message.data.peerId);
          this.participants.delete(message.data.peerId);
          if (participant) this.emit('participantLeft', participant);
          return;
        }
        case 'newConsumer':
          return await this.onNewConsumer(message.data);
        case 'consumerClosed':
          return this.removeConsumer(message.data.consumerId);
        case 'consumerPaused':
        case 'consumerResumed': {
          const track = this.tracks.get(message.data.consumerId);
          if (!track) return;
          track.muted = message.notification === 'consumerPaused';
          this.emit(track.muted ? 'trackMuted' : 'trackUnmuted', track);
          return;
        }
      }
    } catch (error) {
      console.error('voice-client: failed to apply notification', message.notification, error);
    }
  }

  private async onNewConsumer(data: Notifications['newConsumer']): Promise<void> {
    if (!this.recvTransport) return;
    const consumer = await this.recvTransport.consume({
      id: data.consumerId,
      producerId: data.producerId,
      kind: data.kind,
      rtpParameters: data.rtpParameters as unknown as types.RtpParameters,
    });
    this.consumers.set(consumer.id, consumer);
    const track: RemoteTrack = {
      id: consumer.id,
      peerId: data.peerId,
      source: data.source,
      kind: data.kind,
      track: consumer.track,
      muted: data.producerPaused,
    };
    this.tracks.set(consumer.id, track);
    // Server created it paused; resume once the track exists on our side.
    await this.request('resumeConsumer', { consumerId: consumer.id });
    this.emit('trackSubscribed', track);
  }

  private removeConsumer(consumerId: string): void {
    this.consumers.get(consumerId)?.close();
    this.consumers.delete(consumerId);
    const track = this.tracks.get(consumerId);
    this.tracks.delete(consumerId);
    if (track) this.emit('trackUnsubscribed', track);
  }

  private teardown(code: number, reason: string): void {
    if (this.state === 'disconnected') return;
    const wasActive = this.state !== 'idle';
    this.state = 'disconnected';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new VoiceError('connection_closed', reason || 'connection closed'));
    }
    this.pending.clear();
    for (const consumerId of [...this.consumers.keys()]) this.removeConsumer(consumerId);
    for (const producer of this.producers.values()) producer.close();
    this.producers.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) this.ws.close(1000, reason);
    }
    if (wasActive) this.emit('disconnected', { code, reason });
  }
}
