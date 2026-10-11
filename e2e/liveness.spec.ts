import { CloseCode } from '@voxonow/voice-protocol';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { SignalingProxy, Stack } from './stack.js';

// Connection liveness with real WebRTC (Chromium, real mediasoup): signaling
// goes through a proxy (e2e/stack.ts) that can silently cut or delay it while
// both sockets stay open; media flows directly, as in production.

const PORTS = { voice: 7822, demo: 5192, rtcBase: 40420, extraDemos: [5193] };
const PROXY_PORT = 7832;

interface DemoEvent {
  type: 'reconnecting' | 'reconnected' | 'disconnected';
  code?: number;
  at: number;
}

let stack: Stack;
let proxy: SignalingProxy;
const contexts: BrowserContext[] = [];
const extraStacks: Stack[] = [];

test.beforeEach(async () => {
  stack = new Stack(PORTS, `ws://localhost:${PROXY_PORT}/ws`);
  await stack.startVoice();
  proxy = new SignalingProxy(PROXY_PORT, `ws://localhost:${PORTS.voice}/ws`);
  await stack.startDemo();
});
test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  for (const extra of extraStacks.splice(0)) extra.demo?.kill('SIGTERM');
  await proxy.close();
  await stack.stop();
});

async function participant(browser: Browser, room: string, name: string, demoUrl = stack.demoUrl): Promise<Page> {
  const context = await browser.newContext({ permissions: ['microphone'] });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${demoUrl}/`);
  await page.evaluate(([r, n]) => (window as any).voiceDemo.join(r, n), [room, name] as const);
  return page;
}
const events = (page: Page): Promise<DemoEvent[]> => page.evaluate(() => (window as any).voiceDemo.events);
const stats = (page: Page): Promise<any> => page.evaluate(() => (window as any).voiceDemo.stats());
const now = (page: Page): Promise<number> => page.evaluate(() => performance.now());
const receivedFrom = async (page: Page, from: string): Promise<number> =>
  ((await stats(page)).perTrack as { from: string; packetsReceived: number }[]).find((t) => t.from === from)?.packetsReceived ?? 0;
const eventTypes = async (page: Page) => (await events(page)).map((e) => `${e.type}${e.code !== undefined ? `:${e.code}` : ''}`);
const has = async (page: Page, type: string) => (await eventTypes(page)).includes(type);

async function expectAudioBothWays(a: Page, aName: string, b: Page, bName: string): Promise<void> {
  await expect.poll(() => receivedFrom(b, aName), { timeout: 10_000 }).toBeGreaterThan(25);
  await expect.poll(() => receivedFrom(a, bName), { timeout: 10_000 }).toBeGreaterThan(25);
}

/** Time from `since` (page clock) to the first `reconnecting` event, in seconds. */
async function detectionSeconds(page: Page, since: number): Promise<number> {
  const lost = (await events(page)).find((e) => e.type === 'reconnecting')!;
  return (lost.at - since) / 1000;
}

test('silent cut both ways (sockets stay open): lost in 10–15 s, rejoins when the path is back', async ({ browser }) => {
  const room = `lv-both-${Date.now()}`;
  const alice = await participant(browser, room, 'Alice');
  const bob = await participant(browser, room, 'Bob');
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');

  const cutAt = await now(alice);
  proxy.mode.dropUp = proxy.mode.dropDown = true;
  await expect.poll(() => has(alice, 'reconnecting:4902'), { timeout: 20_000 }).toBe(true);
  const seconds = await detectionSeconds(alice, cutAt);
  expect(seconds).toBeGreaterThanOrEqual(9.5);
  expect(seconds).toBeLessThanOrEqual(15.5);
  // What the user sees matches the state.
  expect((await stats(alice)).state).toBe('reconnecting');
  await expect(alice.locator('#room-status')).toHaveText('Yeniden bağlanılıyor…');

  proxy.mode.dropUp = proxy.mode.dropDown = false;
  await expect.poll(() => has(alice, 'reconnected'), { timeout: 20_000 }).toBe(true);
  expect((await stats(alice)).state).toBe('connected');
  await expect(alice.locator('#room-status')).toContainText(`Oda: "${room}"`);
  await expect.poll(() => has(bob, 'reconnected'), { timeout: 20_000 }).toBe(true);
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');
});

test('server→client silence only: detected', async ({ browser }) => {
  const alice = await participant(browser, `lv-down-${Date.now()}`, 'Alice');
  const cutAt = await now(alice);
  proxy.mode.dropDown = true;
  await expect.poll(() => has(alice, 'reconnecting:4902'), { timeout: 20_000 }).toBe(true);
  expect(await detectionSeconds(alice, cutAt)).toBeLessThanOrEqual(15.5);
});

test('client→server silence only: detected', async ({ browser }) => {
  const alice = await participant(browser, `lv-up-${Date.now()}`, 'Alice');
  const cutAt = await now(alice);
  proxy.mode.dropUp = true;
  await expect.poll(() => has(alice, 'reconnecting:4902'), { timeout: 20_000 }).toBe(true);
  expect(await detectionSeconds(alice, cutAt)).toBeLessThanOrEqual(15.5);
});

test('slow answers (7 s late) are not a disconnect, and audio keeps flowing', async ({ browser }) => {
  test.setTimeout(90_000);
  const room = `lv-slow-${Date.now()}`;
  const alice = await participant(browser, room, 'Alice');
  const bob = await participant(browser, room, 'Bob');
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');
  proxy.mode.delayDownMs = 7_000;
  const before = await receivedFrom(bob, 'Alice');
  await alice.waitForTimeout(40_000);
  expect(await eventTypes(alice)).toEqual([]);
  expect(await eventTypes(bob)).toEqual([]);
  expect(await receivedFrom(bob, 'Alice')).toBeGreaterThan(before + 1_000); // ~50 packets/s for 40 s
});

test('older server without ping: one ping per client, no loop, the call stays', async ({ browser }) => {
  test.setTimeout(90_000);
  proxy.mode.olderServer = true;
  const alice = await participant(browser, `lv-old-${Date.now()}`, 'Alice');
  await alice.waitForTimeout(40_000);
  expect(proxy.pings).toBe(1);
  expect(await eventTypes(alice)).toEqual([]);
  expect((await stats(alice)).state).toBe('connected');
});

test('rate limited (4008): nothing for 15 s, exactly one retry, then stops', async ({ browser }) => {
  test.setTimeout(60_000);
  const alice = await participant(browser, `lv-4008-${Date.now()}`, 'Alice');
  const connections = proxy.connections;
  proxy.mode.refuseWith = CloseCode.RateLimited;
  proxy.closeClients(CloseCode.RateLimited, 'rate limit exceeded');
  await expect.poll(() => has(alice, 'reconnecting:4008')).toBe(true);
  await alice.waitForTimeout(14_500);
  expect(proxy.connections).toBe(connections); // no attempt in the first 15 s
  await expect.poll(() => has(alice, 'disconnected:4008'), { timeout: 15_000 }).toBe(true);
  expect(proxy.connections).toBe(connections + 1); // exactly one retry
  await alice.waitForTimeout(5_000);
  expect(proxy.connections).toBe(connections + 1);
  expect(await eventTypes(alice)).toEqual(['reconnecting:4008', 'disconnected:4008']);
  // Final state on screen: back to "not joined".
  await expect(alice.locator('#join')).toBeEnabled();
  await expect(alice.locator('#leave')).toBeDisabled();
});

test('offline: no attempts while offline, controlled rejoin when back', async ({ browser }) => {
  const room = `lv-offline-${Date.now()}`;
  const alice = await participant(browser, room, 'Alice');
  proxy.mode.dropUp = proxy.mode.dropDown = true;
  await alice.context().setOffline(true);
  await expect.poll(() => has(alice, 'reconnecting:4902'), { timeout: 20_000 }).toBe(true);
  const connections = proxy.connections;
  await alice.waitForTimeout(10_000);
  expect(proxy.connections).toBe(connections); // offline: not a single attempt
  proxy.mode.dropUp = proxy.mode.dropDown = false;
  const backAt = await now(alice);
  await alice.context().setOffline(false);
  await expect.poll(() => has(alice, 'reconnected'), { timeout: 15_000 }).toBe(true);
  const back = (await events(alice)).find((e) => e.type === 'reconnected')!;
  expect((back.at - backAt) / 1000).toBeLessThan(5);
  expect(await eventTypes(alice)).toEqual(['reconnecting:4902', 'reconnected']);
});

test('alongside the server WebSocket ping/pong (direct, no proxy): 40 s without a false disconnect', async ({ browser }) => {
  test.setTimeout(90_000);
  // A second demo server pointing straight at the voice server: the browser
  // itself answers the server's 15 s WebSocket pings while sending app pings.
  const direct = new Stack({ ...PORTS, demo: 5193 });
  extraStacks.push(direct);
  await direct.startDemo();
  const room = `lv-direct-${Date.now()}`;
  const alice = await participant(browser, room, 'Alice', direct.demoUrl);
  const bob = await participant(browser, room, 'Bob', direct.demoUrl);
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');
  await alice.waitForTimeout(40_000);
  expect(await eventTypes(alice)).toEqual([]);
  expect(await eventTypes(bob)).toEqual([]);
  expect((await stats(alice)).state).toBe('connected');
});

test.describe('join problems during a rejoin', () => {
  /** Alice in a room, then her signaling drops abruptly (1006) with `plan` applied to the next joins. */
  async function dropWithJoinPlan(browser: Browser, plan: SignalingProxy['joinPlan']) {
    const alice = await participant(browser, `lv-join-${Date.now()}`, 'Alice');
    const joins = proxy.joins;
    proxy.joinPlan = plan;
    proxy.terminateClients();
    await expect.poll(() => has(alice, 'reconnecting:1006')).toBe(true);
    return { alice, joins };
  }
  const durationOf = async (page: Page, from: string, to: string) => {
    const list = await events(page);
    return (list.find((e) => `${e.type}${e.code !== undefined ? `:${e.code}` : ''}` === to)!.at - list.find((e) => `${e.type}:${e.code}` === from)!.at) / 1000;
  };

  test('join lost on the way: the server closes 4012, the client retries and gets back in', async ({ browser }) => {
    const { alice, joins } = await dropWithJoinPlan(browser, ['drop']);
    await expect.poll(() => has(alice, 'reconnected'), { timeout: 20_000 }).toBe(true);
    expect(proxy.serverCloses).toContain(4012);
    expect(proxy.joins).toBe(joins + 2);
    expect(await durationOf(alice, 'reconnecting:1006', 'reconnected')).toBeGreaterThanOrEqual(5);
  });

  test('join delayed past the limit (6 s): 4012, retried, back in', async ({ browser }) => {
    const { alice, joins } = await dropWithJoinPlan(browser, [6_000]);
    await expect.poll(() => has(alice, 'reconnected'), { timeout: 25_000 }).toBe(true);
    expect(proxy.serverCloses).toContain(4012);
    expect(proxy.joins).toBe(joins + 2);
  });

  test('older server (4001 "join timeout" instead of 4012): retried through the compatibility path', async ({ browser }) => {
    proxy.mode.legacyJoinTimeout = true;
    const { alice } = await dropWithJoinPlan(browser, ['drop']);
    await expect.poll(() => has(alice, 'reconnected'), { timeout: 20_000 }).toBe(true);
    expect(proxy.serverCloses).toContain(4012); // what the real server sent, rewritten to 4001 by the proxy
  });

  test('malformed join (4001): not retried, the call ends', async ({ browser }) => {
    const { alice, joins } = await dropWithJoinPlan(browser, ['corrupt']);
    await expect.poll(() => has(alice, 'disconnected:4001'), { timeout: 15_000 }).toBe(true);
    await alice.waitForTimeout(5_000);
    expect(proxy.joins).toBe(joins + 1);
    expect(await eventTypes(alice)).toEqual(['reconnecting:1006', 'disconnected:4001']);
  });

  test('ticket rejected every time (4003): a few fresh tickets, then it stops', async ({ browser }) => {
    const { alice, joins } = await dropWithJoinPlan(browser, ['badticket', 'badticket', 'badticket', 'badticket']);
    await expect.poll(() => has(alice, 'disconnected:4003'), { timeout: 20_000 }).toBe(true);
    await alice.waitForTimeout(3_000);
    expect(proxy.joins).toBe(joins + 3);
    expect(await eventTypes(alice)).toEqual(['reconnecting:1006', 'disconnected:4003']);
  });
});
