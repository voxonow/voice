import { expect, test, type Page } from '@playwright/test';

// Every test opens its own contexts (each with a fake microphone); close them
// so they do not pile up in the shared browser (Chromium then fails with
// "NotReadableError: Could not start audio source").
test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
});

// Demo-only M6 trial (?ns=…). These check the path, not the audio content:
// the fake microphone is a steady beep that a suppressor may legitimately
// silence, so audio quality is measured by bench/ns-eval.mjs instead.

interface Stats {
  participants: string[];
  audioPacketsSent: number;
  perTrack: { from: string; packetsReceived: number }[];
  noiseSuppressor: string;
  noiseContextState?: string;
}

const stats = (page: Page): Promise<Stats> => page.evaluate(() => (window as any).voiceDemo.stats());
const receivedFrom = async (page: Page, from: string) =>
  (await stats(page)).perTrack.find((t) => t.from === from)?.packetsReceived ?? 0;

async function participant(page: Page, room: string, name: string, query = '') {
  await page.goto(`/${query}`);
  await page.evaluate(([r, n]) => (window as any).voiceDemo.join(r, n), [room, name] as const);
}

test('without ?ns the microphone is published unprocessed', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await participant(page, `e2e-ns-none-${Date.now()}`, 'Solo');
  const s = await stats(page);
  expect(s.noiseSuppressor).toBe('none');
  expect(s.noiseContextState).toBeUndefined();
});

for (const kind of ['rnnoise', 'gtcrn', 'gtcrn-split']) {
  test(`?ns=${kind}: processed microphone reaches the other side, and mute still stops it at the source`, async ({ browser }) => {
    const room = `e2e-ns-${kind}-${Date.now()}`;
    const alice = await (await browser.newContext()).newPage();
    const bob = await (await browser.newContext()).newPage();
    await participant(alice, room, 'Alice', `?ns=${kind}`);
    await participant(bob, room, 'Bob');

    const a = await stats(alice);
    expect(a.noiseSuppressor).toBe(kind);
    expect(a.noiseContextState).toBe('running');
    expect((await stats(bob)).noiseSuppressor).toBe('none');

    // Packets flow both ways (DTX keeps a trickle even if the beep is suppressed).
    await expect.poll(() => receivedFrom(bob, 'Alice'), { timeout: 10_000 }).toBeGreaterThan(10);
    await expect.poll(() => receivedFrom(alice, 'Bob'), { timeout: 10_000 }).toBeGreaterThan(10);

    // Mute: nothing leaves Alice's device, nothing reaches Bob.
    await alice.click('#mute');
    await alice.waitForTimeout(500);
    const before = [(await stats(alice)).audioPacketsSent, await receivedFrom(bob, 'Alice')];
    await alice.waitForTimeout(2_000);
    expect((await stats(alice)).audioPacketsSent - before[0]!).toBe(0);
    expect((await receivedFrom(bob, 'Alice')) - before[1]!).toBe(0);
  });
}
