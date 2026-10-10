import { afterAll, beforeAll, expect, it } from 'vitest';
import type { VoiceServer } from '../src/server.js';
import { makeKeys, mintTicket, startTestServer, TestClient, type Keys } from './helpers.js';

let keys: Keys;
let server: VoiceServer;

beforeAll(async () => {
  keys = await makeKeys();
  server = await startTestServer(keys, {}, { numWorkers: 2 });
});
afterAll(async () => {
  await server.close();
});

async function joined(room: string): Promise<TestClient> {
  const client = await TestClient.connect(server);
  expect((await client.join(await mintTicket(keys, { room }))).ok).toBe(true);
  return client;
}

it('spreads rooms over workers and frees a worker slot when its room closes', async () => {
  const a = await joined('place-a');
  const b = await joined('place-b');
  const workerA = server.rooms.get('place-a')!.workerIndex;
  const workerB = server.rooms.get('place-b')!.workerIndex;
  expect(new Set([workerA, workerB]).size).toBe(2);

  // A second participant joins the existing room on its existing worker.
  const a2 = await joined('place-a');
  expect(server.rooms.get('place-a')!.workerIndex).toBe(workerA);

  // Room A empties and closes; the next new room takes A's now-idle worker.
  a.close();
  a2.close();
  await expect.poll(() => server.rooms.has('place-a')).toBe(false);
  const c = await joined('place-c');
  expect(server.rooms.get('place-c')!.workerIndex).toBe(workerA);

  b.close();
  c.close();
});
