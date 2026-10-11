import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CloseCode, PROTOCOL_VERSION } from '@voxonow/voice-protocol';
import type { VoiceServer } from '../src/server.js';
import { makeKeys, mintTicket, startTestServer, TestClient, type Keys } from './helpers.js';

// The client's application ping next to the server's own WebSocket ping/pong
// (here every 200 ms instead of 15 s, so a few seconds cover many rounds).

let keys: Keys;
let server: VoiceServer;

beforeAll(async () => {
  keys = await makeKeys();
  server = await startTestServer(keys, { heartbeatMs: 200 });
});
afterAll(async () => {
  await server.close();
});

describe('application ping', () => {
  it('is answered once joined', async () => {
    const client = await TestClient.connect(server);
    await client.join(await mintTicket(keys));
    expect(await client.request('ping', {})).toMatchObject({ ok: true, data: {} });
    client.close();
  });

  it('is not a way in: before join it closes like any other first message', async () => {
    const client = await TestClient.connect(server);
    client.ws.send(JSON.stringify({ id: 1, method: 'ping', data: {} }));
    expect((await client.closed).code).toBe(CloseCode.AuthRequired);
  });

  it('rejects data it does not expect', async () => {
    const client = await TestClient.connect(server);
    await client.join(await mintTicket(keys));
    expect(await client.request('ping', { extra: 1 })).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    client.close();
  });
});

describe('alongside the server WebSocket ping/pong', () => {
  it('both run for many rounds without dropping a healthy connection', async () => {
    const client = await TestClient.connect(server);
    await client.join(await mintTicket(keys));
    let closed = false;
    void client.closed.then(() => (closed = true));
    for (let i = 0; i < 20; i++) {
      expect(await client.request('ping', {})).toMatchObject({ ok: true });
      await new Promise((r) => setTimeout(r, 100));
    }
    // ~2 s = ~10 server ping rounds, answered automatically by the socket.
    expect(closed).toBe(false);
    client.close();
  });

  it('the server still drops a client that stops answering its WebSocket pings, app pings or not', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { autoPong: false });
    await new Promise((resolve) => ws.once('open', resolve));
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    ws.send(JSON.stringify({ id: 1, method: 'join', data: { ticket: await mintTicket(keys), protocol: PROTOCOL_VERSION } }));
    const timer = setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ id: Date.now(), method: 'ping', data: {} })), 100);
    const started = Date.now();
    const code = await closed;
    clearInterval(timer);
    // Missed pong → terminate (1006 on our side) within two intervals.
    expect(code).toBe(1006);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
