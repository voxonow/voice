import { Device, types } from 'mediasoup-client';
import {
  CloseCode,
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
import {
  HEARTBEAT_TIMEOUT_CODE,
  MEDIA_FAILED_CODE,
  RECONNECT_DEFAULTS,
  Reconnector,
  browserNetwork,
  classifyClose,
  type AttemptResult,
  type LossKind,
  type NetworkStatus,
  type ReconnectOptions,
} from './reconnect.js';

export interface VoiceClientOptions {
  /** Signaling URL, e.g. `wss://voice.voxonow.com/ws`. */
  url: string;
  /** WebSocket implementation; defaults to the global one. */
  WebSocket?: typeof WebSocket;
  /** STUN/TURN servers handed to the peer connections. */
  iceServers?: RTCIceServer[];
  requestTimeoutMs?: number;
  /**
   * Cap (and, in Chrome, target) for the microphone's Opus bitrate, in bits/s.
   * Default 48 kbps — what LiveKit uses, and measured closer to the original
   * than Chrome's own 32 kbps on real speech (docs/ROADMAP.md, M1). Set
   * through the sender's encoding parameters.
   */
  audioMaxBitrate?: number;
  /**
   * Returns a fresh join ticket for the same user and room. Tickets are single
   * use and short-lived, so a rejoin needs a new one from the app's API.
   * Without it a lost connection ends the call (`disconnected`), as before.
   *
   * Reject with `VoiceError('unauthorized' | 'forbidden', …)` when the user may
   * no longer join: recovery stops instead of retrying.
   */
  getTicket?: () => Promise<string>;
  /** Rejoin tuning; see RECONNECT_DEFAULTS. */
  reconnect?: Partial<ReconnectOptions>;
  /** Where online/offline comes from; defaults to the browser's. */
  network?: NetworkStatus;
}

export const DEFAULT_AUDIO_MAX_BITRATE = 48_000;

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

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type VoiceClientEvents = {
  participantJoined: [ParticipantInfo];
  participantLeft: [ParticipantInfo];
  trackSubscribed: [RemoteTrack];
  trackUnsubscribed: [RemoteTrack];
  trackMuted: [RemoteTrack];
  trackUnmuted: [RemoteTrack];
  /**
   * The session was lost and a rejoin is under way. Remote tracks have been
   * unsubscribed; participants are kept until the rejoin settles. Mute calls
   * made now are remembered and applied when the rejoin completes.
   */
  reconnecting: [{ code: number; reason: string }];
  /** A rejoin succeeded: published sources are back, with their mute state. */
  reconnected: [{ peerId: string; attempts: number }];
  /** Final: the call is over (left, replaced, refused, or recovery gave up). */
  disconnected: [{ code: number; reason: string }];
  /**
   * Media path state of the send or receive transport. `failed` means media
   * cannot flow (e.g. ICE found no working route) even though signaling is up;
   * with `getTicket` it triggers a rejoin.
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

/** A source the app published, kept across rejoins. */
interface Publication {
  track: MediaStreamTrack;
  muted: boolean;
  /** While muted after a rejoin: a disabled clone stands in for `track`. */
  placeholder?: MediaStreamTrack;
}

/** Reason text older servers sent with 4001 for a join timeout (see rejoin()). */
const LEGACY_JOIN_TIMEOUT_REASON = 'join timeout';

/**
 * One participant's connection to a Voxonow voice room.
 *
 * ```ts
 * const client = new VoiceClient({ url, getTicket });
 * client.on('trackSubscribed', (t) => attach(t.track));
 * await client.join(await getTicket());
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
  private readonly publications = new Map<Source, Publication>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** Notifications are applied one at a time so close never overtakes create. */
  private notificationQueue: Promise<void> = Promise.resolve();
  /**
   * While a join request awaits its response: notifications that arrive first.
   * The server snapshots the participant list before it adds us to the room,
   * so everything it notifies us of is newer than the snapshot, but it may
   * send those notifications before the join response. They are applied after
   * the snapshot, in arrival order.
   */
  private earlyNotifications?: Notification[];
  private readonly reconnectOptions: ReconnectOptions;
  private reconnector?: Reconnector;
  /** Close code and reason of the socket that ended the current attempt, if the server sent one. */
  private lastCloseCode?: number;
  private lastCloseReason = '';
  // Application heartbeat (see startLiveness).
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private heartbeatSupported = true;
  private heartbeatMissed = 0;
  /** When the last ping was sent / when any ping was last answered (ms epoch). */
  private lastPingAt?: number;
  private lastPongAt = 0;
  private unsubscribeOnline?: () => void;

  constructor(private readonly options: VoiceClientOptions) {
    super();
    this.reconnectOptions = { ...RECONNECT_DEFAULTS, ...options.reconnect };
  }

  async join(ticket: string): Promise<{ peerId: string; roomId: string }> {
    if (this.state !== 'idle') throw new VoiceError('invalid_state', `cannot join from state ${this.state}`);
    this.state = 'connecting';
    try {
      const joined = await this.establish(ticket);
      this.state = 'connected';
      this.startLiveness();
      // The map, not the join snapshot: notifications may have changed it since.
      for (const participant of this.participants.values()) this.emit('participantJoined', participant);
      return { peerId: joined.peerId, roomId: joined.roomId };
    } catch (error) {
      this.dropSession('join failed');
      this.participants.clear();
      this.finish(1000, 'join failed');
      throw error;
    }
  }

  /** Publishes a local track as the given source. Returns its producer id. */
  async publish(track: MediaStreamTrack, source: Source): Promise<string> {
    this.assertConnected();
    if (SOURCE_KIND[source] !== track.kind) throw new VoiceError('bad_request', `${source} needs a ${SOURCE_KIND[source]} track`);
    if (this.producers.has(source)) throw new VoiceError('conflict', `${source} already published`);
    const id = await this.produce(track, source);
    this.publications.set(source, { track, muted: false });
    return id;
  }

  /**
   * Mutes or unmutes a published source; the server stops forwarding it while
   * muted. During a rejoin the choice is remembered and applied on recovery.
   */
  async setMuted(source: Source, muted: boolean): Promise<void> {
    const publication = this.publications.get(source);
    if (!publication) throw new VoiceError('not_found', `${source} is not published`);
    publication.muted = muted;
    const producer = this.producers.get(source);
    if (this.state !== 'connected' || !producer) return; // applied when the rejoin completes
    if (muted) {
      producer.pause();
      await this.request('pauseProducer', { producerId: producer.id });
    } else {
      // After a rejoin a muted source was published as a disabled clone: only
      // now, on the user's unmute, does the real track go back in.
      if (publication.placeholder) {
        await producer.replaceTrack({ track: publication.track });
        publication.placeholder.stop();
        publication.placeholder = undefined;
      }
      await this.request('resumeProducer', { producerId: producer.id });
      producer.resume();
    }
  }

  /** Whether a published source is muted (as last set by the app). */
  isMuted(source: Source): boolean | undefined {
    return this.publications.get(source)?.muted;
  }

  async unpublish(source: Source): Promise<void> {
    const publication = this.publications.get(source);
    this.publications.delete(source);
    publication?.placeholder?.stop();
    const producer = this.producers.get(source);
    if (!producer) return;
    this.producers.delete(source);
    producer.close();
    if (this.state === 'connected') await this.request('closeProducer', { producerId: producer.id });
  }

  async leave(): Promise<void> {
    if (this.state === 'disconnected') return;
    if (this.state === 'reconnecting') {
      this.reconnector?.cancel();
      this.dropSession('left');
      this.finish(4000, 'left');
      return;
    }
    if (this.state === 'connected') {
      try {
        await this.request('leave', {});
      } catch {
        // Leaving anyway.
      }
    }
    this.dropSession('left');
    this.finish(4000, 'left');
  }

  /** Raw WebRTC stats, for quality measurement (RTT, jitter, loss, concealment). */
  async getStats(): Promise<{ send?: RTCStatsReport; recv?: RTCStatsReport }> {
    const [send, recv] = await Promise.all([this.sendTransport?.getStats(), this.recvTransport?.getStats()]);
    return { send, recv };
  }

  private assertConnected(): void {
    if (this.state !== 'connected') throw new VoiceError('invalid_state', 'not connected');
  }

  /**
   * Opens signaling, joins with `ticket`, loads the device and sets up the
   * receive side; on a rejoin also republishes. Shared by join() and rejoin.
   */
  private async establish(ticket: string, connectTimeoutMs?: number): Promise<ResponseData['join']> {
    await this.openSocket(connectTimeoutMs);
    this.earlyNotifications = [];
    const joined = await this.request('join', { ticket, protocol: PROTOCOL_VERSION });
    this.peerId = joined.peerId;
    this.roomId = joined.roomId;
    // The snapshot first, then what changed after it, in order.
    this.participants.clear();
    for (const participant of joined.participants) this.participants.set(participant.peerId, participant);
    const early = this.earlyNotifications ?? [];
    this.earlyNotifications = undefined;
    for (const message of early) this.enqueueNotification(message);
    this.device = await Device.factory();
    await this.device.load({
      routerRtpCapabilities: joined.routerRtpCapabilities as unknown as types.RtpCapabilities,
    });
    this.recvTransport = await this.createTransport('recv');
    await this.request('ready', {
      rtpCapabilities: this.device.rtpCapabilities as unknown as Record<string, unknown>,
    });
    return joined;
  }

  private async produce(track: MediaStreamTrack, source: Source, startMuted = false): Promise<string> {
    if (!this.sendTransport) this.sendTransport = await this.createTransport('send');
    const producer = await this.sendTransport.produce({
      track,
      appData: { source },
      // Opus: in-band FEC and DTX keep speech intelligible on lossy links and
      // cheap when silent.
      codecOptions: track.kind === 'audio' ? { opusFec: true, opusDtx: true } : undefined,
      encodings:
        track.kind === 'audio'
          ? [{ maxBitrate: this.options.audioMaxBitrate ?? DEFAULT_AUDIO_MAX_BITRATE }]
          : undefined,
      stopTracks: false,
      // Muted means nothing leaves the device — not silence frames the server
      // then has to drop.
      zeroRtpOnPause: true,
    });
    if (startMuted) {
      producer.pause();
      await this.request('pauseProducer', { producerId: producer.id });
    }
    this.producers.set(source, producer);
    return producer.id;
  }

  private openSocket(timeoutMs?: number): Promise<void> {
    const Impl = this.options.WebSocket ?? globalThis.WebSocket;
    const ws = new Impl(this.options.url);
    this.ws = ws;
    this.lastCloseCode = undefined;
    this.lastCloseReason = '';
    ws.onmessage = (event) => this.onMessage(event.data);
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              ws.onclose = null;
              ws.close();
              reject(new VoiceError('timeout', 'voice server did not answer'));
            }, timeoutMs);
      ws.onopen = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (timer) clearTimeout(timer);
        reject(new VoiceError('connection_failed', 'could not reach the voice server'));
      };
      ws.onclose = (event) => {
        if (timer) clearTimeout(timer);
        reject(new VoiceError('connection_closed', event.reason || 'connection closed'));
        if (this.ws === ws) this.onSocketClosed(event.code, event.reason);
      };
    });
  }

  /** The signaling socket closed (server, network, or ourselves through leave). */
  private onSocketClosed(code: number, reason: string): void {
    this.lastCloseCode = code;
    this.lastCloseReason = reason;
    this.rejectPending(reason || 'connection closed');
    // During join() or a rejoin attempt the awaiting code handles it.
    if (this.state === 'connected') this.onSessionLost(code, reason);
  }

  /** A connected session broke: decide between giving up and rejoining. */
  private onSessionLost(code: number, reason: string): void {
    const kind = classifyClose(code);
    this.dropSession(reason);
    if (kind === 'final' || !this.options.getTicket) return this.finish(code, reason);
    this.state = 'reconnecting';
    this.emit('reconnecting', { code, reason });
    this.reconnector = new Reconnector({
      options: this.reconnectOptions,
      network: this.options.network ?? browserNetwork,
      random: Math.random,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      attempt: ({ remainingMs }) => this.rejoin(remainingMs),
      onRecovered: () => {
        this.state = 'connected';
        this.startLiveness();
        this.emit('reconnected', { peerId: this.peerId!, attempts: this.reconnector?.attemptCount ?? 0 });
      },
      onGiveUp: (giveUpCode, giveUpReason) => {
        this.dropSession(giveUpReason);
        this.finish(giveUpCode, giveUpReason);
      },
    });
    this.reconnector.start(kind);
  }

  /** One rejoin attempt; always settles with an outcome. */
  private async rejoin(remainingMs: number): Promise<AttemptResult> {
    const previousRoom = this.roomId;
    const before = new Map(this.participants);
    let ticket: string;
    try {
      ticket = await this.options.getTicket!();
    } catch (error) {
      if (error instanceof VoiceError && (error.code === 'unauthorized' || error.code === 'forbidden')) {
        return { ok: false, kind: 'final', code: 4003, reason: `ticket refused: ${error.message}` };
      }
      return { ok: false, kind: 'retry', code: 0, reason: `ticket unavailable: ${String((error as Error)?.message ?? error)}` };
    }
    if (this.state !== 'reconnecting') return { ok: false, kind: 'final', code: 4000, reason: 'left' };
    try {
      const joined = await this.establish(ticket, Math.min(this.reconnectOptions.connectTimeoutMs, Math.max(1, remainingMs)));
      if (previousRoom !== undefined && joined.roomId !== previousRoom) {
        // A ticket for another room must never move the user silently.
        this.closeSocketQuietly();
        this.dropSession('room changed');
        return { ok: false, kind: 'final', code: 4003, reason: `ticket is for room ${joined.roomId}, not ${previousRoom}` };
      }
      // Republish what the app had published, each with its mute state. A
      // muted source goes out as a disabled clone so the real track cannot
      // send audio until the user unmutes.
      for (const [source, publication] of this.publications) {
        if (publication.track.readyState === 'ended') {
          this.publications.delete(source);
          continue;
        }
        if (publication.muted) {
          publication.placeholder?.stop();
          publication.placeholder = publication.track.clone();
          publication.placeholder.enabled = false;
          await this.produce(publication.placeholder, source, true);
        } else {
          publication.placeholder = undefined;
          await this.produce(publication.track, source);
        }
      }
      // Participants were kept through the outage: report only the change
      // (notifications during the rejoin are not emitted, see onNotification).
      for (const [id, p] of before) if (!this.participants.has(id)) this.emit('participantLeft', p);
      for (const [id, p] of this.participants) if (!before.has(id)) this.emit('participantJoined', p);
      // Connected from here, in the same step as the diff: a notification
      // applied after it is announced normally instead of falling between.
      this.state = 'connected';
      return { ok: true };
    } catch (error) {
      const code = this.lastCloseCode;
      this.closeSocketQuietly();
      this.dropSession('rejoin failed');
      // Restore the participant list for the next attempt's diff.
      this.participants.clear();
      for (const [id, p] of before) this.participants.set(id, p);
      if (this.state !== 'reconnecting') return { ok: false, kind: 'final', code: 4000, reason: 'left' };
      const reason = String((error as Error)?.message ?? error);
      // Compatibility with servers before JoinTimeout (4012): they closed a
      // join that did not complete in time with 4001 and the reason "join
      // timeout". Only that exact pair is retried; every other 4001 (malformed
      // or out-of-order join) stays final. Current servers send 4012, which
      // classifyClose already retries. Remove once no such server runs.
      if (code === CloseCode.AuthRequired && this.lastCloseReason === LEGACY_JOIN_TIMEOUT_REASON) {
        return { ok: false, kind: 'retry', code, reason: 'join timeout' };
      }
      if (code !== undefined) return { ok: false, kind: classifyClose(code), code, reason };
      if (error instanceof VoiceError && error.code === 'unauthorized') return { ok: false, kind: 'auth', code: 4003, reason };
      return { ok: false, kind: 'retry' satisfies LossKind, code: 0, reason };
    }
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

    transport.on('connectionstatechange', (state) => {
      this.emit('mediaStateChanged', { direction, state });
      // No ICE restart yet (Phase 3A tier 1): a failed media path is recovered
      // by rejoining, which needs the socket closed first.
      if (state === 'failed' && this.state === 'connected' && transport === (direction === 'send' ? this.sendTransport : this.recvTransport)) {
        this.closeSocketQuietly();
        this.onSessionLost(MEDIA_FAILED_CODE, `${direction} media path failed`);
      }
    });
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
      if (this.earlyNotifications) this.earlyNotifications.push(message as Notification);
      else this.enqueueNotification(message as Notification);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new VoiceError(message.error.code, message.error.message));
  }

  private enqueueNotification(message: Notification): void {
    this.notificationQueue = this.notificationQueue.then(() => this.onNotification(message));
  }

  private async onNotification(message: Notification): Promise<void> {
    try {
      switch (message.notification) {
        case 'participantJoined': {
          // Idempotent: a repeated notification neither duplicates nor re-announces.
          const known = this.participants.has(message.data.peerId);
          this.participants.set(message.data.peerId, message.data);
          if (!known && this.state === 'connected') this.emit('participantJoined', message.data);
          return;
        }
        case 'participantLeft': {
          const participant = this.participants.get(message.data.peerId);
          this.participants.delete(message.data.peerId);
          // While joining or rejoining, the end of the join reports the net change.
          if (participant && this.state === 'connected') this.emit('participantLeft', participant);
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
    const transport = this.recvTransport;
    if (!transport) return;
    const consumer = await transport.consume({
      id: data.consumerId,
      producerId: data.producerId,
      kind: data.kind,
      rtpParameters: data.rtpParameters as unknown as types.RtpParameters,
    });
    // The session may have been dropped while consume() ran.
    if (transport !== this.recvTransport || transport.closed) {
      consumer.close();
      return;
    }
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

  private rejectPending(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new VoiceError('connection_closed', reason));
    }
    this.pending.clear();
  }

  /**
   * Application heartbeat while connected. Every `heartbeatIntervalMs` the
   * client sends a ping and checks the previous interval: if no ping at all
   * was answered since the previous one was sent, that is a miss; any answer
   * (however late, to any ping) resets the count. `heartbeatMisses` misses in
   * a row (10–15 s of silence with the defaults) mean the connection is gone
   * even though the socket has not closed (a dead network often never
   * delivers a close), and the usual rejoin takes over.
   *
   * Only the ping's answer counts, not other traffic: notifications from the
   * server prove only the server→client direction, and a dead client→server
   * direction (our audio controls and requests lost) must be detected too.
   *
   * Misses are counted per check, not by wall-clock age, so a throttled
   * background tab (timers firing late) does not look like a dead server, and
   * a slow answer still counts when it arrives. A server that predates `ping`
   * answers bad_request: the heartbeat then stops for this session, quietly.
   */
  private startLiveness(): void {
    this.stopLiveness();
    this.heartbeatSupported = true;
    this.heartbeatMissed = 0;
    this.lastPingAt = undefined;
    this.lastPongAt = 0;
    // Back online while connected: check at once, the path may have changed.
    this.unsubscribeOnline = (this.options.network ?? browserNetwork).onOnline(() => {
      if (this.state === 'connected' && this.heartbeatSupported) this.sendPing();
    });
    this.scheduleHeartbeat();
  }

  private stopLiveness(): void {
    if (this.heartbeatTimer !== undefined) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.unsubscribeOnline?.();
    this.unsubscribeOnline = undefined;
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setTimeout(() => this.heartbeatTick(), this.reconnectOptions.heartbeatIntervalMs);
  }

  private heartbeatTick(): void {
    this.heartbeatTimer = undefined;
    if (this.state !== 'connected' || !this.heartbeatSupported) return;
    const silent = this.lastPingAt !== undefined && this.lastPongAt < this.lastPingAt;
    this.heartbeatMissed = silent ? this.heartbeatMissed + 1 : 0;
    if (this.heartbeatMissed >= this.reconnectOptions.heartbeatMisses) {
      this.closeSocketQuietly();
      this.onSessionLost(HEARTBEAT_TIMEOUT_CODE, 'voice server stopped answering');
      return;
    }
    this.sendPing();
    this.scheduleHeartbeat();
  }

  private sendPing(): void {
    this.lastPingAt = Date.now();
    this.request('ping', {}).then(
      () => {
        this.lastPongAt = Date.now();
      },
      (error) => {
        if (error instanceof VoiceError && error.code === 'bad_request') {
          // Older server without `ping`: stop asking, keep the call.
          this.heartbeatSupported = false;
          this.stopLiveness();
        }
        // Timeouts and closed sockets: the checks above decide.
      },
    );
  }

  /** Closes our own socket without it counting as a loss. */
  private closeSocketQuietly(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, 'client closed');
  }

  /**
   * Releases everything tied to the current session (socket, transports,
   * producers, consumers). Publications and their mute state are kept for a
   * rejoin; participants too, so a rejoin can report only what changed.
   */
  private dropSession(reason: string): void {
    this.earlyNotifications = undefined;
    this.stopLiveness();
    this.rejectPending(reason || 'connection closed');
    for (const consumerId of [...this.consumers.keys()]) this.removeConsumer(consumerId);
    for (const producer of this.producers.values()) producer.close();
    this.producers.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = undefined;
    this.recvTransport = undefined;
    this.device = undefined;
    this.closeSocketQuietly();
    this.ws = undefined;
  }

  /** Final state: emits `disconnected` once. */
  private finish(code: number, reason: string): void {
    if (this.state === 'disconnected') return;
    const wasActive = this.state !== 'idle';
    this.state = 'disconnected';
    this.stopLiveness();
    this.reconnector?.cancel();
    for (const publication of this.publications.values()) publication.placeholder?.stop();
    if (wasActive) this.emit('disconnected', { code, reason });
  }
}
