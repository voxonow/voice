import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Stack } from './stack.js';

// Automatic rejoin with real WebRTC (Chromium, real mediasoup). Each test runs
// its own voice server and demo server (e2e/stack.ts), because the tests stop,
// crash and restart the voice server and kill its media worker.

const PORTS = { voice: 7821, demo: 5191, rtcBase: 40400 };

interface DemoEvent {
  type: 'reconnecting' | 'reconnected' | 'disconnected';
  code?: number;
  at: number;
}

let stack: Stack;
/** Contexts opened by a test; closed after it so fake microphones do not pile up. */
const contexts: BrowserContext[] = [];
test.beforeEach(async () => {
  stack = new Stack(PORTS);
  await stack.startVoice();
  await stack.startDemo();
});
test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await stack.stop();
});

async function participant(browser: Browser, room: string, name: string, query = ''): Promise<Page> {
  const context = await browser.newContext({ permissions: ['microphone'] });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${stack.demoUrl}/${query}`);
  await page.evaluate(([r, n]) => (window as any).voiceDemo.join(r, n), [room, name] as const);
  return page;
}
const events = (page: Page): Promise<DemoEvent[]> => page.evaluate(() => (window as any).voiceDemo.events);
const stats = (page: Page): Promise<any> => page.evaluate(() => (window as any).voiceDemo.stats());
const receivedFrom = async (page: Page, from: string): Promise<number> =>
  ((await stats(page)).perTrack as { from: string; packetsReceived: number }[]).find((t) => t.from === from)?.packetsReceived ?? 0;
const eventTypes = async (page: Page) => (await events(page)).map((e) => `${e.type}${e.code !== undefined ? `:${e.code}` : ''}`);
const reconnected = async (page: Page) => (await events(page)).some((e) => e.type === 'reconnected');

/** Audio flows both ways between the two pages (new consumers count from zero). */
async function expectAudioBothWays(a: Page, aName: string, b: Page, bName: string): Promise<void> {
  await expect.poll(() => receivedFrom(b, aName), { timeout: 10_000 }).toBeGreaterThan(25);
  await expect.poll(() => receivedFrom(a, bName), { timeout: 10_000 }).toBeGreaterThan(25);
}

test('planned server restart (4011): both rejoin and talk again', async ({ browser }) => {
  const room = `rc-4011-${Date.now()}`;
  const alice = await participant(browser, room, 'Alice');
  const bob = await participant(browser, room, 'Bob');
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');

  await stack.stopVoice('SIGTERM');
  await stack.startVoice();
  await expect.poll(() => reconnected(alice), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => reconnected(bob), { timeout: 20_000 }).toBe(true);
  for (const page of [alice, bob]) {
    expect(await eventTypes(page)).toEqual(['reconnecting:4011', 'reconnected']);
    expect((await stats(page)).state).toBe('connected');
  }
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');
});

test('server crash (abnormal close): both rejoin once it is back', async ({ browser }) => {
  const room = `rc-crash-${Date.now()}`;
  const alice = await participant(browser, room, 'Alice');
  const bob = await participant(browser, room, 'Bob');
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');

  await stack.stopVoice('SIGKILL');
  await new Promise((r) => setTimeout(r, 2_000)); // down for a while: attempts fail and back off
  await stack.startVoice();
  await expect.poll(() => reconnected(alice), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => reconnected(bob), { timeout: 20_000 }).toBe(true);
  expect((await events(alice))[0]).toMatchObject({ type: 'reconnecting', code: 1006 });
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');
});

test('media worker dies (4010): the room is rebuilt and both rejoin', async ({ browser }) => {
  const room = `rc-4010-${Date.now()}`;
  const alice = await participant(browser, room, 'Alice');
  const bob = await participant(browser, room, 'Bob');
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');

  process.kill(stack.workerPid(), 'SIGKILL');
  await expect.poll(() => reconnected(alice), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => reconnected(bob), { timeout: 20_000 }).toBe(true);
  expect(await eventTypes(alice)).toEqual(['reconnecting:4010', 'reconnected']);
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');
});

test('a muted user is still muted after the rejoin, and unmuting brings audio back', async ({ browser }) => {
  const room = `rc-mute-${Date.now()}`;
  const alice = await participant(browser, room, 'Alice');
  const bob = await participant(browser, room, 'Bob');
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');
  await alice.click('#mute');
  await expect(alice.locator('#mute')).toHaveText('Sesi aç');

  await stack.stopVoice('SIGTERM');
  await stack.startVoice();
  await expect.poll(() => reconnected(alice), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => reconnected(bob), { timeout: 20_000 }).toBe(true);
  // Bob is heard by Alice again (the session works), but nothing leaves Alice.
  await expect.poll(() => receivedFrom(alice, 'Bob'), { timeout: 10_000 }).toBeGreaterThan(25);
  const sentBefore = (await stats(alice)).audioPacketsSent;
  const bobGotBefore = await receivedFrom(bob, 'Alice');
  await alice.waitForTimeout(3_000);
  expect((await stats(alice)).audioPacketsSent - sentBefore).toBe(0);
  expect((await receivedFrom(bob, 'Alice')) - bobGotBefore).toBe(0);
  await expect(alice.locator('#mute')).toHaveText('Sesi aç');

  await alice.click('#mute');
  await expect.poll(() => receivedFrom(bob, 'Alice'), { timeout: 10_000 }).toBeGreaterThan(bobGotBefore + 25);
});

test('leaving on purpose does not start a rejoin', async ({ browser }) => {
  const room = `rc-leave-${Date.now()}`;
  const alice = await participant(browser, room, 'Alice');
  await participant(browser, room, 'Bob');
  await alice.click('#leave');
  await expect.poll(() => eventTypes(alice)).toEqual(['disconnected:4000']);
  await alice.waitForTimeout(5_000);
  expect(await eventTypes(alice)).toEqual(['disconnected:4000']);
});

test('two tabs of one user: the replaced tab stops (4009), no ping-pong', async ({ browser }) => {
  const room = `rc-tabs-${Date.now()}`;
  const query = `?user=dup-${Date.now()}`;
  const tab1 = await participant(browser, room, 'Alice', query);
  const tab2 = await participant(browser, room, 'Alice', query);
  await expect.poll(() => eventTypes(tab1)).toEqual(['disconnected:4009']);
  await tab1.waitForTimeout(8_000);
  expect(await eventTypes(tab1)).toEqual(['disconnected:4009']);
  expect(await eventTypes(tab2)).toEqual([]);
  expect((await stats(tab2)).state).toBe('connected');
});

test('server gone for good: gives up after the 30 s budget', async ({ browser }) => {
  test.setTimeout(90_000);
  const room = `rc-budget-${Date.now()}`;
  const alice = await participant(browser, room, 'Alice');
  await stack.stopVoice('SIGKILL');
  await expect.poll(() => eventTypes(alice), { timeout: 60_000, intervals: [1_000] }).toEqual(['reconnecting:1006', 'disconnected:4900']);
  const [lost, gaveUp] = await events(alice);
  const seconds = (gaveUp!.at - lost!.at) / 1000;
  expect(seconds).toBeGreaterThanOrEqual(29.5);
  expect(seconds).toBeLessThan(40);
});

test('offline: no attempts while offline, rejoins when back online', async ({ browser }) => {
  const room = `rc-offline-${Date.now()}`;
  const alice = await participant(browser, room, 'Alice');
  const bob = await participant(browser, room, 'Bob');
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');

  await alice.context().setOffline(true);
  await stack.stopVoice('SIGTERM');
  await stack.startVoice();
  await expect.poll(() => reconnected(bob), { timeout: 20_000 }).toBe(true);
  await alice.waitForTimeout(8_000);
  expect(await eventTypes(alice)).toEqual(['reconnecting:4011']);

  await alice.context().setOffline(false);
  await expect.poll(() => reconnected(alice), { timeout: 15_000 }).toBe(true);
  await expectAudioBothWays(alice, 'Alice', bob, 'Bob');
});
