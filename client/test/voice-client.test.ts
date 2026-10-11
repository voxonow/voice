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
  /** Ticket check: 'ok' or 'reject' (ticket strings are "user:room:tag"). */
  check: (_ticket: string): 'ok' | 'reject' => 'ok',
  peers: new Map<string, ServerPeer>(),
  joins: [] as string[],
  calls: [] as { user: string; method: string; data: any }[],
  sockets: [] as FakeWebSocket[],
  nextId: 1,
  reset() {
    this.down = false;
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
    const reply = (ok: boolean, payload: any) =>
      queueMicrotask(() => ws.deliver(JSON.stringify(ok ? { id, ok, data: payload } : { id, ok, error: payload })));
    const peer = [...this.peers.values()].find((p) => p.ws === ws);
    if (method === 'join') {
      const [user, room] = (data.ticket as string).split(':');
      this.joins.push(data.ticket);
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
  private listeners = new Set<() => void>();
  isOnline = () => this.online;
  onOnline(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  set(online: boolean) {
    this.online = online;
    if (online) for (const l of [...this.listeners]) l();
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
  for (const e of ['reconnecting', 'reconnected', 'disconnected', 'participantJoined', 'participantLeft'] as const) {
    client.on(e, (data: any) => events.push(`${e}${data?.code !== undefined ? `:${data.code}` : ''}${data?.name ? `:${data.name}` : ''}`));
  }
  const mic = fakeTrack();
  await client.join(`${user}:${room}:0`);
  await client.publish(mic, 'microphone');
  return { client, events, getTicket, network, mic };
}

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
    await vi.runAllTimersAsync();
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
    await vi.runAllTimersAsync();
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
    await vi.runAllTimersAsync();
    expect(alice.client.state).toBe('connected');
  });

  it('media path failure (send transport failed) also rejoins', async () => {
    const alice = await connect('alice');
    const send = media.state.transports.find((t: any) => t.direction === 'send');
    send.emit('connectionstatechange', 'failed');
    expect(alice.client.state).toBe('reconnecting');
    await vi.runAllTimersAsync();
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
    await vi.runAllTimersAsync();
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
    await vi.runAllTimersAsync();
    expect(alice.getTicket).toHaveBeenCalledTimes(3);
    expect(alice.client.state).toBe('connected');
  });

  it('expired ticket rejected once (4003): a new one is fetched and works', async () => {
    const alice = await connect('alice');
    let rejected = 0;
    server.check = () => (rejected++ === 0 ? 'reject' : 'ok');
    server.drop('alice', 1006);
    await vi.runAllTimersAsync();
    expect(alice.getTicket).toHaveBeenCalledTimes(2);
    expect(alice.client.state).toBe('connected');
  });

  it('access revoked (every ticket rejected): stops after 3 tries, long before the budget', async () => {
    const alice = await connect('alice');
    server.check = () => 'reject';
    server.drop('alice', 1006);
    await vi.runAllTimersAsync();
    expect(alice.getTicket).toHaveBeenCalledTimes(3);
    expect(alice.events.at(-1)).toBe('disconnected:4003');
    expect(Date.now()).toBeLessThan(10_000);
  });

  it('the app refuses a ticket (forbidden): stops at once', async () => {
    const alice = await connect('alice');
    alice.getTicket.mockRejectedValue(new VoiceError('forbidden', 'no longer a member'));
    server.drop('alice', 1006);
    await vi.runAllTimersAsync();
    expect(alice.getTicket).toHaveBeenCalledTimes(1);
    expect(alice.events).toEqual(['reconnecting:1006', 'disconnected:4003']);
  });

  it('a ticket for another room is not followed', async () => {
    const alice = await connect('alice');
    alice.getTicket.mockResolvedValue('alice:other-room:9');
    server.drop('alice', 1006);
    await vi.runAllTimersAsync();
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
    await vi.runAllTimersAsync();
    expect(Date.now()).toBe(30_000);
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
    await vi.runAllTimersAsync();
    expect(alice.getTicket).toHaveBeenCalledTimes(1);
    expect(alice.client.state).toBe('connected');
  });
});

describe('mute state', () => {
  it('a muted user is still muted after the rejoin, and the real track only returns on unmute', async () => {
    const alice = await connect('alice');
    await alice.client.setMuted('microphone', true);
    server.drop('alice', 1006);
    await vi.runAllTimersAsync();
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
    await vi.runAllTimersAsync();
    expect(alice.client.state).toBe('connected');
    expect(lastProducer().paused).toBe(true);
    expect(lastProducer().track).not.toBe(alice.mic);
  });
});
