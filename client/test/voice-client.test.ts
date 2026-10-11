// VoiceClient rejoin behaviour against a fake signaling server and a fake
// mediasoup-client (no WebRTC in Node). Real-media behaviour is covered by
// e2e/reconnect.spec.ts.
import { CloseCode } from '@voxonow/voice-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => {
  const state = { producers: [] as any[], transports: [] as any[] };
  class FakeProducer {
    paused = false;
    closed = false;
    constructor(
      readonly id: string,
      public track: any,
    ) {}
    pause() {
      this.paused = true;
    }
    resume() {
      this.paused = false;
    }
    async replaceTrack({ track }: { track: any }) {
      this.track = track;
    }
    close() {
      this.closed = true;
    }
  }
  class FakeTransport {
    closed = false;
    private connected = false;
    private handlers: Record<string, ((...args: any[]) => void)[]> = {};
    constructor(
      readonly id: string,
      readonly direction: 'send' | 'recv',
    ) {
      state.transports.push(this);
    }
    on(event: string, fn: (...args: any[]) => void) {
      (this.handlers[event] ??= []).push(fn);
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this.handlers[event] ?? []) fn(...args);
    }
    async produce({ track, appData }: { track: any; appData: any }) {
      if (!this.connected) {
        await new Promise((resolve, reject) => this.emit('connect', { dtlsParameters: {} }, resolve, reject));
        this.connected = true;
      }
      const id = await new Promise<string>((resolve, reject) =>
        this.emit('produce', { kind: track.kind, rtpParameters: {}, appData }, ({ id }: { id: string }) => resolve(id), reject),
      );
      const producer = new FakeProducer(id, track);
      state.producers.push(producer);
      return producer;
    }
    async consume({ id, kind }: { id: string; kind: string }) {
      return { id, track: { kind }, close() {} };
    }
    close() {
      this.closed = true;
    }
    async getStats() {
      return new Map();
    }
  }
  class Device {
    rtpCapabilities = {};
    static async factory() {
      return new Device();
    }
    async load() {}
    createSendTransport(o: { id: string }) {
      return new FakeTransport(o.id, 'send');
    }
    createRecvTransport(o: { id: string }) {
      return new FakeTransport(o.id, 'recv');
    }
  }
  return { state, Device };
});
vi.mock('mediasoup-client', () => ({ Device: media.Device, types: {} }));

const { VoiceClient, VoiceError } = await import('../src/voice-client.js');
const { RECONNECT_TIMEOUT_CODE } = await import('../src/reconnect.js');

// ---- fake signaling server ----------------------------------------------------
interface ServerPeer {
  ws: FakeWebSocket;
  user: string;
  room: string;
  peerId: string;
}
const server = {
  down: false,
  /** Silently drop client→server messages (socket stays open). */
  dropUp: false,
  /** Silently drop server→client messages (socket stays open). */
  dropDown: false,
  /** How `ping` is handled: answered, ignored, or unknown (a server that predates it). */
  pingMode: 'answer' as 'answer' | 'ignore' | 'unknown',
  pings: 0,
  replyDelayMs: 0,
  /** Close every join with this code (e.g. 4008), and this reason. */
  closeJoinWith: undefined as number | undefined,
  closeJoinReason: 'closed by test',
  /** Ticket check: 'ok' or 'reject' (ticket strings are "user:room:tag"). */
  check: (_ticket: string): 'ok' | 'reject' => 'ok',
  peers: new Map<string, ServerPeer>(),
  joins: [] as string[],
  calls: [] as { user: string; method: string; data: any }[],
  sockets: [] as FakeWebSocket[],
  nextId: 1,
  reset() {
    this.down = false;
    this.dropUp = false;
    this.dropDown = false;
    this.pingMode = 'answer';
    this.pings = 0;
    this.replyDelayMs = 0;
    this.closeJoinWith = undefined;
    this.closeJoinReason = 'closed by test';
    this.check = () => 'ok';
    this.peers.clear();
    this.joins = [];
    this.calls = [];
    this.sockets = [];
    this.nextId = 1;
  },
  accept(ws: FakeWebSocket) {
    if (this.down) {
      ws.readyState = 3;
      ws.onerror?.({});
      ws.onclose?.({ code: 1006, reason: '' });
      return;
    }
    ws.readyState = 1;
    ws.onopen?.({});
  },
  receive(ws: FakeWebSocket, { id, method, data }: { id: number; method: string; data: any }) {
    if (this.dropUp) return;
    const reply = (ok: boolean, payload: any) => {
      const send = () => ws.deliver(JSON.stringify(ok ? { id, ok, data: payload } : { id, ok, error: payload }));
      if (this.replyDelayMs) setTimeout(send, this.replyDelayMs);
      else queueMicrotask(send);
    };
    if (method === 'ping') {
      this.pings++;
      if (this.pingMode === 'ignore') return;
      if (this.pingMode === 'unknown') return reply(false, { code: 'bad_request', message: 'unknown method ping' });
      return reply(true, {});
    }
    const peer = [...this.peers.values()].find((p) => p.ws === ws);
    if (method === 'join') {
      const [user, room] = (data.ticket as string).split(':');
      this.joins.push(data.ticket);
      if (this.closeJoinWith !== undefined) {
        const code = this.closeJoinWith;
        const reason = this.closeJoinReason;
        queueMicrotask(() => ws.serverClose(code, reason));
        return;
      }
      if (this.check(data.ticket) === 'reject') {
        reply(false, { code: 'unauthorized', message: 'invalid ticket' });
        queueMicrotask(() => queueMicrotask(() => ws.serverClose(CloseCode.Unauthorized, 'invalid ticket')));
        return;
      }
      for (const other of [...this.peers.values()]) {
        if (other.user === user && other.room === room) {
          this.peers.delete(other.peerId);
          other.ws.serverClose(CloseCode.Replaced, 'joined from another connection');
        }
      }
      const others = [...this.peers.values()].filter((p) => p.room === room);
      const peerId = `peer-${this.nextId++}`;
      this.peers.set(peerId, { ws, user: user!, room: room!, peerId });
      return reply(true, { peerId, roomId: room, routerRtpCapabilities: {}, participants: others.map((p) => ({ peerId: p.peerId, userId: p.user, name: p.user })) });
    }
    if (peer) this.calls.push({ user: peer.user, method, data });
    switch (method) {
      case 'createTransport':
        return reply(true, { id: `t-${this.nextId++}`, iceParameters: {}, iceCandidates: [], dtlsParameters: {} });
      case 'produce':
        return reply(true, { producerId: `p-${this.nextId++}` });
      case 'leave':
        reply(true, {});
        queueMicrotask(() => queueMicrotask(() => ws.serverClose(CloseCode.Left, 'left')));
        return;
      default:
        return reply(true, {});
    }
  },
  /** Server-side close of a user's connection (e.g. network drop seen as 1006). */
  drop(user: string, code: number, reason = '') {
    for (const p of [...this.peers.values()]) {
      if (p.user !== user) continue;
      this.peers.delete(p.peerId);
      p.ws.serverClose(code, reason);
    }
  },
};

class FakeWebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  onopen: ((e: any) => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  onclose: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  constructor(readonly url: string) {
    server.sockets.push(this);
    queueMicrotask(() => server.accept(this));
  }
  send(raw: string) {
    if (this.readyState !== 1) throw new Error('not open');
    server.receive(this, JSON.parse(raw));
  }
  deliver(raw: string) {
    if (server.dropDown) return;
    if (this.readyState === 1) this.onmessage?.({ data: raw });
  }
  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    for (const p of [...server.peers.values()]) if (p.ws === this) server.peers.delete(p.peerId);
    this.onclose?.({ code, reason });
  }
  serverClose(code: number, reason: string) {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

class FakeNetwork {
  online = true;
  private onlineListeners = new Set<() => void>();
  private offlineListeners = new Set<() => void>();
  isOnline = () => this.online;
  onOnline(l: () => void) {
    this.onlineListeners.add(l);
    return () => void this.onlineListeners.delete(l);
  }
  onOffline(l: () => void) {
    this.offlineListeners.add(l);
    return () => void this.offlineListeners.delete(l);
  }
  /** Changes state and fires the matching browser event. */
  set(online: boolean) {
    this.online = online;
    for (const l of [...(online ? this.onlineListeners : this.offlineListeners)]) l();
  }
}

function fakeTrack(): any {
  const track: any = { kind: 'audio', enabled: true, readyState: 'live', id: `track-${Math.random()}` };
  track.clone = () => ({ ...fakeTrack(), clonedFrom: track });
  track.stop = () => (track.readyState = 'ended');
  return track;
}

/** A client of `user` in `room` with a recording of its events. */
async function connect(user: string, room = 'r1', extra: Record<string, unknown> = {}) {
  let tag = 0;
  const getTicket = vi.fn(async () => `${user}:${room}:${++tag}`);
  const network = new FakeNetwork();
  const client = new VoiceClient({ url: 'ws://fake/ws', WebSocket: FakeWebSocket as any, getTicket, network, ...extra });
  const events: string[] = [];
  const times: Record<string, number> = {};
  for (const e of ['reconnecting', 'reconnected', 'disconnected', 'participantJoined', 'participantLeft'] as const) {
    client.on(e, (data: any) => {
      times[e] = Date.now();
      events.push(`${e}${data?.code !== undefined ? `:${data.code}` : ''}${data?.name ? `:${data.name}` : ''}`);
    });
  }
  const mic = fakeTrack();
  await client.join(`${user}:${room}:0`);
  await client.publish(mic, 'microphone');
  return { client, events, times, getTicket, network, mic };
}

/** Lets time pass (the heartbeat always has a timer pending, so runAllTimers never ends). */
const settle = (ms = 45_000) => vi.advanceTimersByTimeAsync(ms);
const producesBy = (user: string) => server.calls.filter((c) => c.user === user && c.method === 'produce');
const callsBy = (user: string, method: string) => server.calls.filter((c) => c.user === user && c.method === method);
const lastProducer = () => media.state.producers.at(-1);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  server.reset();
  media.state.producers.length = 0;
  media.state.transports.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('rejoin after a lost connection', () => {
  it('network drop (1006): reconnecting → reconnected, microphone back and unmuted, no participant churn', async () => {
    const bob = await connect('bob');
    const alice = await connect('alice');
    await vi.advanceTimersByTimeAsync(0);
    alice.events.length = 0;
    server.drop('alice', 1006);
    expect(alice.client.state).toBe('reconnecting');
    await settle();
    expect(alice.client.state).toBe('connected');
    expect(alice.events).toEqual(['reconnecting:1006', 'reconnected']);
    expect(alice.getTicket).toHaveBeenCalledTimes(1);
    expect(producesBy('alice')).toHaveLength(2);
    expect(callsBy('alice', 'pauseProducer')).toHaveLength(0);
    expect(lastProducer().track).toBe(alice.mic);
    expect(lastProducer().paused).toBe(false);
    expect(bob.client.state).toBe('connected');
  });

  it('worker failure (4010): first attempt at once', async () => {
    const alice = await connect('alice');
    server.drop('alice', CloseCode.RoomClosed, 'media server error');
    await vi.advanceTimersByTimeAsync(0);
    expect(alice.getTicket).toHaveBeenCalledTimes(1);
    await settle();
    expect(alice.events).toEqual(['reconnecting:4010', 'reconnected']);
  });

  it('planned shutdown (4011): first attempt spread over 0–5 s', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.6);
    const alice = await connect('alice');
    server.drop('alice', CloseCode.ServerShutdown, 'server shutting down');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(alice.getTicket).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(alice.getTicket).toHaveBeenCalledTimes(1);
    await settle();
    expect(alice.client.state).toBe('connected');
  });

  it('media path failure (send transport failed) also rejoins', async () => {
    const alice = await connect('alice');
    const send = media.state.transports.find((t: any) => t.direction === 'send');
    send.emit('connectionstatechange', 'failed');
    expect(alice.client.state).toBe('reconnecting');
    await settle();
    expect(alice.events).toEqual(['reconnecting:4901', 'reconnected']);
  });

  it('without getTicket a lost connection ends the call, as before', async () => {
    const alice = await connect('alice', 'r1', { getTicket: undefined });
    server.drop('alice', 1006);
    expect(alice.client.state).toBe('disconnected');
    expect(alice.events).toEqual(['disconnected:1006']);
  });
});

describe('no rejoin loop', () => {
  it('manual leave (4000): disconnected, no reconnect', async () => {
    const alice = await connect('alice');
    await alice.client.leave();
    await settle();
    expect(alice.events).toEqual(['disconnected:4000']);
    expect(alice.getTicket).not.toHaveBeenCalled();
  });

  it('leave during reconnecting stops recovery', async () => {
    const alice = await connect('alice');
    server.down = true;
    server.drop('alice', 1006);
    await vi.advanceTimersByTimeAsync(2_000);
    await alice.client.leave();
    const tickets = alice.getTicket.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(alice.getTicket.mock.calls.length).toBe(tickets);
    expect(alice.events).toEqual(['reconnecting:1006', 'disconnected:4000']);
  });

  it('two tabs of one user: the replaced one stops for good, the other stays', async () => {
    const tab1 = await connect('alice');
    const tab2 = await connect('alice');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tab1.events).toEqual(['disconnected:4009']);
    expect(tab1.getTicket).not.toHaveBeenCalled();
    expect(tab2.client.state).toBe('connected');
    expect(server.joins).toHaveLength(2);
  });
});

describe('tickets', () => {
  it('ticket fetch fails (API unreachable): retried, then recovers', async () => {
    const alice = await connect('alice');
    alice.getTicket.mockRejectedValueOnce(new Error('fetch failed')).mockRejectedValueOnce(new Error('fetch failed'));
    server.drop('alice', 1006);
    await settle();
    expect(alice.getTicket).toHaveBeenCalledTimes(3);
    expect(alice.client.state).toBe('connected');
  });

  it('expired ticket rejected once (4003): a new one is fetched and works', async () => {
    const alice = await connect('alice');
    let rejected = 0;
    server.check = () => (rejected++ === 0 ? 'reject' : 'ok');
    server.drop('alice', 1006);
    await settle();
    expect(alice.getTicket).toHaveBeenCalledTimes(2);
    expect(alice.client.state).toBe('connected');
  });

  it('access revoked (every ticket rejected): stops after 3 tries, long before the budget', async () => {
    const alice = await connect('alice');
    server.check = () => 'reject';
    server.drop('alice', 1006);
    await settle();
    expect(alice.getTicket).toHaveBeenCalledTimes(3);
    expect(alice.events.at(-1)).toBe('disconnected:4003');
    expect(alice.times.disconnected! - alice.times.reconnecting!).toBeLessThan(10_000);
  });

  it('the app refuses a ticket (forbidden): stops at once', async () => {
    const alice = await connect('alice');
    alice.getTicket.mockRejectedValue(new VoiceError('forbidden', 'no longer a member'));
    server.drop('alice', 1006);
    await settle();
    expect(alice.getTicket).toHaveBeenCalledTimes(1);
    expect(alice.events).toEqual(['reconnecting:1006', 'disconnected:4003']);
  });

  it('a ticket for another room is not followed', async () => {
    const alice = await connect('alice');
    alice.getTicket.mockResolvedValue('alice:other-room:9');
    server.drop('alice', 1006);
    await settle();
    expect(alice.client.state).toBe('disconnected');
    expect(alice.events.at(-1)).toBe('disconnected:4003');
    expect([...server.peers.values()].some((p) => p.room === 'other-room')).toBe(false);
  });
});

describe('budget and network', () => {
  it('server unreachable: gives up after 30 s', async () => {
    const alice = await connect('alice');
    server.down = true;
    server.drop('alice', 1006);
    await settle();
    expect(alice.times.disconnected! - alice.times.reconnecting!).toBe(30_000);
    expect(alice.events).toEqual(['reconnecting:1006', `disconnected:${RECONNECT_TIMEOUT_CODE}`]);
    expect(alice.getTicket.mock.calls.length).toBeGreaterThan(3);
  });

  it('offline: no attempts while offline, rejoins as soon as online', async () => {
    const alice = await connect('alice');
    alice.network.online = false;
    server.drop('alice', 1006);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(alice.getTicket).not.toHaveBeenCalled();
    expect(alice.client.state).toBe('reconnecting');
    alice.network.set(true);
    await settle();
    expect(alice.getTicket).toHaveBeenCalledTimes(1);
    expect(alice.client.state).toBe('connected');
  });
});

describe('mute state', () => {
  it('a muted user is still muted after the rejoin, and the real track only returns on unmute', async () => {
    const alice = await connect('alice');
    await alice.client.setMuted('microphone', true);
    server.drop('alice', 1006);
    await settle();
    expect(alice.client.state).toBe('connected');
    const producer = lastProducer();
    expect(producer.paused).toBe(true);
    expect(producer.track).not.toBe(alice.mic);
    expect(producer.track.enabled).toBe(false);
    expect(producer.track.clonedFrom).toBe(alice.mic);
    // The rejoined producer was paused on the server too.
    const pauses = callsBy('alice', 'pauseProducer');
    expect(pauses.at(-1)!.data.producerId).toBe(producer.id);
    expect(alice.client.isMuted('microphone')).toBe(true);

    await alice.client.setMuted('microphone', false);
    expect(producer.track).toBe(alice.mic);
    expect(producer.paused).toBe(false);
    expect(callsBy('alice', 'resumeProducer').at(-1)!.data.producerId).toBe(producer.id);
  });

  it('muting during the outage is applied when the rejoin completes', async () => {
    const alice = await connect('alice');
    server.down = true;
    server.drop('alice', 1006);
    await vi.advanceTimersByTimeAsync(1_000);
    await alice.client.setMuted('microphone', true);
    server.down = false;
    await settle();
    expect(alice.client.state).toBe('connected');
    expect(lastProducer().paused).toBe(true);
    expect(lastProducer().track).not.toBe(alice.mic);
  });
});

/** Events must tell one consistent story: at most one final `disconnected`, last; `reconnected` only after `reconnecting`. */
function expectConsistent(events: string[], state: string) {
  const lifecycle = events.filter((e) => /^(reconnecting|reconnected|disconnected)/.test(e));
  let reconnecting = false;
  lifecycle.forEach((e, i) => {
    if (e.startsWith('reconnecting')) {
      expect(reconnecting).toBe(false);
      reconnecting = true;
    } else if (e === 'reconnected') {
      expect(reconnecting).toBe(true);
      reconnecting = false;
    } else expect(i).toBe(lifecycle.length - 1);
  });
  const last = lifecycle.at(-1);
  expect(state).toBe(!last || last === 'reconnected' ? 'connected' : last.startsWith('reconnecting') ? 'reconnecting' : 'disconnected');
}

describe('heartbeat', () => {
  it('silent cut both ways (socket stays open): lost within 10–15 s, rejoins when the path is back', async () => {
    const alice = await connect('alice');
    await settle(7_000);
    server.dropUp = server.dropDown = true;
    const cutAt = Date.now();
    await settle(9_900);
    expect(alice.client.state).toBe('connected');
    await settle(5_200);
    expect(alice.events).toContain('reconnecting:4902');
    expect(alice.times.reconnecting! - cutAt).toBeGreaterThanOrEqual(10_000);
    expect(alice.times.reconnecting! - cutAt).toBeLessThanOrEqual(15_000);
    server.dropUp = server.dropDown = false;
    await settle();
    expect(alice.client.state).toBe('connected');
    expectConsistent(alice.events, alice.client.state);
  });

  it('server→client silence only: detected', async () => {
    const alice = await connect('alice');
    server.dropDown = true;
    await settle(16_000);
    expect(alice.events[0]).toBe('reconnecting:4902');
  });

  it('client→server silence only: detected even while the server keeps talking', async () => {
    const alice = await connect('alice');
    await connect('bob');
    server.dropUp = true;
    // Notifications keep arriving (bob mutes and unmutes); they do not count as an answer.
    for (let t = 0; t < 16_000; t += 2_000) {
      for (const p of server.peers.values()) if (p.user === 'alice') p.ws.deliver(JSON.stringify({ notification: 'consumerPaused', data: { consumerId: 'x' } }));
      await settle(2_000);
    }
    expect(alice.events).toContain('reconnecting:4902');
  });

  it('slow answers (7 s) are not a disconnect', async () => {
    const alice = await connect('alice');
    server.replyDelayMs = 7_000;
    await settle(120_000);
    expect(alice.events).toEqual([]);
    expect(alice.client.state).toBe('connected');
    expect(server.pings).toBeGreaterThan(5);
  });

  it('a late answer resets the count: one miss is not enough', async () => {
    const alice = await connect('alice');
    server.pingMode = 'ignore';
    await settle(9_900); // the ping at 5 s is never answered → one miss at the 10 s check
    server.pingMode = 'answer'; // the ping at 10 s is answered → count resets at 15 s
    await settle(60_000);
    expect(alice.events).toEqual([]);
  });

  it('two unanswered pings in a row (signaling otherwise fine): lost', async () => {
    const alice = await connect('alice');
    server.pingMode = 'ignore';
    await settle(15_100);
    expect(alice.events[0]).toBe('reconnecting:4902');
  });

  it('older server without ping: asks once, keeps the call, no loop', async () => {
    const alice = await connect('alice');
    server.pingMode = 'unknown';
    await settle(300_000);
    expect(server.pings).toBe(1);
    expect(alice.events).toEqual([]);
    expect(alice.client.state).toBe('connected');
  });

  it('coming back online while connected checks at once', async () => {
    const alice = await connect('alice');
    await settle(1_000);
    const before = server.pings;
    alice.network.set(true);
    await settle(0);
    expect(server.pings).toBe(before + 1);
  });
});

describe('rate limit (4008)', () => {
  it('waits 15–20 s, retries once, then gives up', async () => {
    const alice = await connect('alice');
    const joins = server.joins.length;
    server.closeJoinWith = CloseCode.RateLimited;
    server.drop('alice', CloseCode.RateLimited, 'rate limit exceeded');
    await settle(14_900);
    expect(server.joins.length).toBe(joins); // nothing for 15 s
    await settle(30_000);
    expect(server.joins.length).toBe(joins + 1); // exactly one retry
    expect(alice.events).toEqual(['reconnecting:4008', 'disconnected:4008']);
    expectConsistent(alice.events, alice.client.state);
  });

  it('a rate-limited loss recovers when the retry is accepted', async () => {
    const alice = await connect('alice');
    server.drop('alice', CloseCode.RateLimited, 'rate limit exceeded');
    await settle();
    expect(alice.events).toEqual(['reconnecting:4008', 'reconnected']);
    expect(alice.times.reconnected! - alice.times.reconnecting!).toBeGreaterThanOrEqual(15_000);
  });
});

describe('close codes during a rejoin keep their meaning', () => {
  it('replaced (4009) while rejoining: stop', async () => {
    const alice = await connect('alice');
    server.closeJoinWith = CloseCode.Replaced;
    server.drop('alice', 1006);
    await settle();
    expect(alice.events).toEqual(['reconnecting:1006', 'disconnected:4009']);
    expect(server.joins.length).toBe(2);
  });

  it('join lost or late on the way (4012 JoinTimeout): retried', async () => {
    const alice = await connect('alice');
    server.closeJoinWith = CloseCode.JoinTimeout;
    server.closeJoinReason = 'join timeout';
    server.drop('alice', 1006);
    await settle(3_000);
    server.closeJoinWith = undefined;
    await settle();
    expect(alice.events).toEqual(['reconnecting:1006', 'reconnected']);
  });

  it('older server (4001 with the reason "join timeout"): still retried, by the compatibility path', async () => {
    const alice = await connect('alice');
    server.closeJoinWith = CloseCode.AuthRequired;
    server.closeJoinReason = 'join timeout';
    server.drop('alice', 1006);
    await settle(3_000);
    server.closeJoinWith = undefined;
    await settle();
    expect(alice.events).toEqual(['reconnecting:1006', 'reconnected']);
  });

  for (const reason of ['malformed join', 'join first', '']) {
    it(`any other 4001 while rejoining (${reason || 'no reason'}) stays final`, async () => {
      const alice = await connect('alice');
      server.closeJoinWith = CloseCode.AuthRequired;
      server.closeJoinReason = reason;
      server.drop('alice', 1006);
      await settle();
      expect(alice.events).toEqual(['reconnecting:1006', 'disconnected:4001']);
      expect(server.joins.length).toBe(2);
    });
  }

  it('a 4012 on the very first join is not retried (no rejoin before a call exists)', async () => {
    server.closeJoinWith = CloseCode.JoinTimeout;
    const client = new VoiceClient({ url: 'ws://fake/ws', WebSocket: FakeWebSocket as any, getTicket: async () => 'alice:r1:1', network: new FakeNetwork() });
    await expect(client.join('alice:r1:0')).rejects.toThrow();
    await settle();
    expect(client.state).toBe('disconnected');
    expect(server.joins.length).toBe(1);
  });

  it('room closed (4010) / shutdown (4011) while rejoining: keep trying within the budget', async () => {
    for (const code of [CloseCode.RoomClosed, CloseCode.ServerShutdown]) {
      server.reset();
      const alice = await connect('alice');
      server.closeJoinWith = code;
      server.drop('alice', 1006);
      await settle(8_000);
      server.closeJoinWith = undefined;
      await settle();
      expect(alice.events).toEqual(['reconnecting:1006', 'reconnected']);
      expectConsistent(alice.events, alice.client.state);
    }
  });

  it('every scenario above keeps a consistent event story', async () => {
    const alice = await connect('alice');
    server.down = true;
    server.drop('alice', 1006);
    await settle();
    expectConsistent(alice.events, alice.client.state);
    expect(alice.client.state).toBe('disconnected');
  });
});
