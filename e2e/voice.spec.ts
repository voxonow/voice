import { expect, test, type Page } from '@playwright/test';

// Every test opens its own contexts (each with a fake microphone); close them
// so they do not pile up in the shared browser (Chromium then fails with
// "NotReadableError: Could not start audio source").
test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
});

// The demo page exposes window.voiceDemo (demo/src/app.ts) so tests drive the
// real client library against the real server, with real WebRTC media.
interface DemoStats {
  audioPacketsReceived: number;
  audioPacketsSent: number;
  subscribedTracks: number;
  participants: string[];
  perTrack: { from: string; packetsReceived: number }[];
  audioTargetBitrate?: number;
}

async function joinRoom(page: Page, room: string, name: string): Promise<void> {
  await page.goto('/');
  await page.evaluate(([r, n]) => (window as any).voiceDemo.join(r, n), [room, name] as const);
}

function stats(page: Page): Promise<DemoStats> {
  return page.evaluate(() => (window as any).voiceDemo.stats());
}

/** Polls until the page has received at least `min` audio packets. */
async function expectAudioPackets(page: Page, min: number, timeoutMs: number): Promise<number> {
  let received = 0;
  await expect
    .poll(
      async () => {
        received = (await stats(page)).audioPacketsReceived;
        return received;
      },
      { timeout: timeoutMs, intervals: [250] },
    )
    .toBeGreaterThanOrEqual(min);
  return received;
}

test('two participants in one room exchange audio within 5 seconds', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();

  await joinRoom(alice, 'e2e-pair', 'Alice');
  await joinRoom(bob, 'e2e-pair', 'Bob');
  const joinedAt = Date.now();

  // Acceptance (M0): each side receives ≥ 50 audio packets from the other
  // within 5 s. Opus sends 50 packets/s, so this is about one second of audio.
  await Promise.all([expectAudioPackets(alice, 50, 5_000), expectAudioPackets(bob, 50, 5_000)]);
  expect(Date.now() - joinedAt).toBeLessThan(5_000);

  expect((await stats(alice)).participants).toEqual(['Bob']);
  expect((await stats(bob)).participants).toEqual(['Alice']);
});

test('rooms are isolated: nothing crosses between rooms', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  const carol = await (await browser.newContext()).newPage();

  await joinRoom(alice, 'e2e-room-a', 'Alice');
  await joinRoom(bob, 'e2e-room-a', 'Bob');
  await joinRoom(carol, 'e2e-room-b', 'Carol');

  // Alice and Bob are clearly exchanging audio…
  await expectAudioPackets(alice, 100, 10_000);
  await expectAudioPackets(bob, 100, 10_000);

  // …while Carol, alone in another room, sees no one and receives nothing.
  const carolStats = await stats(carol);
  expect(carolStats.participants).toEqual([]);
  expect(carolStats.subscribedTracks).toBe(0);
  expect(carolStats.audioPacketsReceived).toBe(0);
  // Carol is publishing; neither Alice nor Bob may know about her.
  expect(carolStats.audioPacketsSent).toBeGreaterThan(0);
  expect((await stats(alice)).participants).toEqual(['Bob']);
  expect((await stats(alice)).subscribedTracks).toBe(1);
});

test('a participant leaving is seen by the others and their audio stops', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();

  await joinRoom(alice, 'e2e-leave', 'Alice');
  await joinRoom(bob, 'e2e-leave', 'Bob');
  await expectAudioPackets(alice, 50, 5_000);

  await bob.evaluate(() => (window as any).voiceDemo.leave());
  await expect.poll(async () => (await stats(alice)).participants, { timeout: 5_000 }).toEqual([]);
  await expect.poll(async () => (await stats(alice)).subscribedTracks, { timeout: 5_000 }).toBe(0);
});

test('muting stops audio at the source, and unmuting brings it back', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await joinRoom(alice, 'e2e-mute', 'Alice');
  await joinRoom(bob, 'e2e-mute', 'Bob');
  await expectAudioPackets(bob, 50, 5_000);

  /** Packets Alice sends, and Bob receives from Alice, over `ms`. */
  async function flow(ms: number): Promise<{ sent: number; received: number }> {
    const before = [await stats(alice), await stats(bob)] as const;
    await bob.waitForTimeout(ms);
    const after = [await stats(alice), await stats(bob)] as const;
    const fromAlice = (s: DemoStats) => s.perTrack.find((t) => t.from === 'Alice')?.packetsReceived ?? 0;
    return {
      sent: after[0].audioPacketsSent - before[0].audioPacketsSent,
      received: fromAlice(after[1]) - fromAlice(before[1]),
    };
  }

  await alice.click('#mute');
  await alice.waitForTimeout(500); // let in-flight packets land
  const muted = await flow(2_000);
  // Acceptance (M1): nothing reaches the other side while muted — and nothing
  // leaves the device either.
  expect(muted).toEqual({ sent: 0, received: 0 });

  await alice.click('#mute');
  await alice.waitForTimeout(500);
  const unmuted = await flow(2_000);
  expect(unmuted.sent).toBeGreaterThan(30);
  expect(unmuted.received).toBeGreaterThan(30);
});

test('the encoder targets 48 kbps by default, and the demo switch can change it', async ({ browser }) => {
  async function target(query: string): Promise<number | undefined> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`/${query}`);
    await page.evaluate((r) => (window as any).voiceDemo.join(r, 'X'), `e2e-bitrate-${Date.now()}`);
    await expect.poll(async () => (await stats(page)).audioTargetBitrate, { timeout: 5_000 }).toBeGreaterThan(0);
    return (await stats(page)).audioTargetBitrate;
  }
  // The client's default (decision 2026-10-10, docs/ROADMAP.md M1), and the
  // demo-only switch still applied.
  expect(await target('')).toBe(48_000);
  expect(await target('?audioBitrate=32000')).toBe(32_000);
});
