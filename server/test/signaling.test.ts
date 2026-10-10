import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloseCode } from '@voxonow/voice-protocol';
import type { VoiceServer } from '../src/server.js';
import { SIGNALING_LIMITS } from '../src/signaling.js';
import { makeKeys, mintTicket, startTestServer, TestClient, type Keys } from './helpers.js';

let keys: Keys;
let server: VoiceServer;

beforeAll(async () => {
  keys = await makeKeys();
  server = await startTestServer(keys, { authTimeoutMs: 300, messagesPerSecond: 20, messageBurst: 40 });
});
afterAll(async () => {
  await server.close();
});

const connect = (options?: { origin?: string; path?: string }) => TestClient.connect(server, options);

describe('connection admission', () => {
  it('closes a connection that never joins (default limit ≤ 5 s)', async () => {
    expect(SIGNALING_LIMITS.authTimeoutMs).toBeLessThanOrEqual(5_000);
    const client = await connect();
    const started = Date.now();
    const { code } = await client.closed;
    expect(code).toBe(CloseCode.AuthRequired);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('closes a connection whose first message is not join', async () => {
    const client = await connect();
    void client.request('createTransport', { direction: 'send' });
    expect((await client.closed).code).toBe(CloseCode.AuthRequired);
  });

  it('closes a connection that sends a second message while joining', async () => {
    const client = await connect();
    void client.join(await mintTicket(keys));
    void client.request('createTransport', { direction: 'send' });
    expect((await client.closed).code).toBe(CloseCode.AuthRequired);
  });

  it('closes on an invalid ticket', async () => {
    const client = await connect();
    void client.join(await mintTicket(keys, { key: (await makeKeys()).privateKey }));
    expect((await client.closed).code).toBe(CloseCode.Unauthorized);
  });

  it('closes on a replayed ticket', async () => {
    const ticket = await mintTicket(keys);
    const first = await connect();
    expect((await first.join(ticket)).ok).toBe(true);
    const second = await connect();
    void second.join(ticket);
    expect((await second.closed).code).toBe(CloseCode.Unauthorized);
    first.close();
  });

  it('closes on a protocol version it does not speak', async () => {
    const client = await connect();
    void client.request('join', { ticket: await mintTicket(keys), protocol: 99 });
    expect((await client.closed).code).toBe(CloseCode.AuthRequired);
  });

  it('rejects browser origins that are not allowed', async () => {
    await expect(connect({ origin: 'https://evil.example' })).rejects.toThrow('HTTP 403');
    const allowed = await connect({ origin: 'https://app.example' });
    allowed.close();
  });

  it('rejects upgrades on other paths', async () => {
    await expect(connect({ path: '/other' })).rejects.toThrow('HTTP 404');
  });

  it('closes on malformed JSON', async () => {
    const client = await connect();
    client.ws.send('{not json');
    expect((await client.closed).code).toBe(1007);
  });

  it('closes on oversized messages', async () => {
    const client = await connect();
    client.ws.send('x'.repeat(SIGNALING_LIMITS.maxPayloadBytes + 1));
    expect((await client.closed).code).toBe(1009);
  });

  it('closes a connection that floods messages', async () => {
    const client = await connect();
    expect((await client.join(await mintTicket(keys))).ok).toBe(true);
    for (let i = 0; i < 200; i++) client.ws.send(JSON.stringify({ id: 1000 + i, method: 'leave_', data: {} }));
    expect((await client.closed).code).toBe(CloseCode.RateLimited);
  });
});

describe('joined connections', () => {
  it('returns router capabilities and the participants already present', async () => {
    const room = 'room-presence';
    const alice = await connect();
    const aliceJoin = await alice.join(await mintTicket(keys, { room, name: 'Alice' }));
    expect(aliceJoin.ok).toBe(true);
    expect(aliceJoin.ok && aliceJoin.data).toMatchObject({ roomId: room, participants: [] });
    expect(aliceJoin.ok && (aliceJoin.data as any).routerRtpCapabilities.codecs.length).toBeGreaterThan(0);

    const bob = await connect();
    const bobJoin = await bob.join(await mintTicket(keys, { room, name: 'Bob' }));
    expect(bobJoin.ok && (bobJoin.data as any).participants.map((p: any) => p.name)).toEqual(['Alice']);
    await alice.waitFor((n) => n.notification === 'participantJoined' && n.data.name === 'Bob');

    bob.close();
    const bobPeerId = bobJoin.ok && (bobJoin.data as any).peerId;
    await alice.waitFor((n) => n.notification === 'participantLeft' && n.data.peerId === bobPeerId);
    alice.close();
  });

  it('keeps rooms isolated: participants in other rooms are never announced', async () => {
    const a = await connect();
    await a.join(await mintTicket(keys, { room: 'iso-a', name: 'A' }));
    const b = await connect();
    const bJoin = await b.join(await mintTicket(keys, { room: 'iso-b', name: 'B' }));
    expect(bJoin.ok && (bJoin.data as any).participants).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.notifications).toEqual([]);
    expect(b.notifications).toEqual([]);
    a.close();
    b.close();
  });

  it('replaces the older connection when the same user joins the room again', async () => {
    const old = await connect();
    await old.join(await mintTicket(keys, { sub: 'same-user', room: 'room-replace' }));
    const watcher = await connect();
    await watcher.join(await mintTicket(keys, { room: 'room-replace', name: 'Watcher' }));
    const fresh = await connect();
    const freshJoin = await fresh.join(await mintTicket(keys, { sub: 'same-user', room: 'room-replace' }));

    expect((await old.closed).code).toBe(CloseCode.Replaced);
    expect(freshJoin.ok && (freshJoin.data as any).participants.map((p: any) => p.name)).toEqual(['Watcher']);
    watcher.close();
    fresh.close();
  });

  it('refuses to publish a source the ticket does not allow', async () => {
    const client = await connect();
    await client.join(await mintTicket(keys, { publish: ['microphone'] }));
    const response = await client.request('produce', {
      transportId: 'whatever',
      kind: 'video',
      rtpParameters: {},
      source: 'camera',
    });
    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    client.close();
  });

  it('refuses a source published with the wrong media kind', async () => {
    const client = await connect();
    await client.join(await mintTicket(keys, { publish: ['microphone'] }));
    const response = await client.request('produce', {
      transportId: 'whatever',
      kind: 'video',
      rtpParameters: {},
      source: 'microphone',
    });
    expect(response).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    client.close();
  });

  it("cannot touch another participant's transport", async () => {
    const owner = await connect();
    await owner.join(await mintTicket(keys, { room: 'room-steal' }));
    const created = await owner.request('createTransport', { direction: 'send' });
    expect(created.ok).toBe(true);
    const transportId = created.ok && (created.data as any).id;

    const intruder = await connect();
    await intruder.join(await mintTicket(keys, { room: 'room-steal' }));
    const response = await intruder.request('connectTransport', {
      transportId,
      dtlsParameters: { role: 'client', fingerprints: [] },
    });
    expect(response).toMatchObject({ ok: false, error: { code: 'not_found' } });
    owner.close();
    intruder.close();
  });

  it('allows one transport per direction', async () => {
    const client = await connect();
    await client.join(await mintTicket(keys));
    expect((await client.request('createTransport', { direction: 'recv' })).ok).toBe(true);
    expect(await client.request('createTransport', { direction: 'recv' })).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    client.close();
  });

  it('answers unknown methods and invalid data with bad_request, without crashing', async () => {
    const client = await connect();
    await client.join(await mintTicket(keys));
    expect(await client.request('explode', {})).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await client.request('createTransport', { direction: 'sideways' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    expect(await client.request('connectTransport', { transportId: 'x', dtlsParameters: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    client.close();
  });

  it('closes the room when its last participant leaves', async () => {
    const client = await connect();
    await client.join(await mintTicket(keys, { room: 'room-ephemeral' }));
    expect(server.rooms.has('room-ephemeral')).toBe(true);
    expect((await client.request('leave')).ok).toBe(true);
    expect((await client.closed).code).toBe(CloseCode.Left);
    await expect.poll(() => server.rooms.has('room-ephemeral')).toBe(false);
  });
});
