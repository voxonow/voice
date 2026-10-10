import { chromium, expect, firefox, test, webkit, type Browser, type BrowserType, type Page } from '@playwright/test';

// Chrome talking to Firefox and to WebKit (Safari's engine) in one room, with
// real WebRTC media through the voice server. WebKit stands in for Safari
// here; it is not a substitute for testing real Safari by hand.

interface Stats {
  participants: string[];
  audioPacketsSent: number;
  perTrack: { from: string; packetsReceived: number; packetsLost: number }[];
}

const engines: Record<string, { type: BrowserType; launch: Parameters<BrowserType['launch']>[0]; grant: boolean }> = {
  Chrome: {
    type: chromium,
    launch: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
    grant: true,
  },
  // `args: []` explicitly: Playwright applies the config's launch args (Chrome
  // flags) to every launch in a test; Linux WebKit refuses unknown flags.
  Firefox: {
    type: firefox,
    launch: {
      args: [],
      firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true },
    },
    grant: false,
  },
  WebKit: { type: webkit, launch: { args: [] }, grant: true },
};

const open: Browser[] = [];
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
});

async function participant(name: keyof typeof engines, baseURL: string, room: string): Promise<Page> {
  const engine = engines[name]!;
  const browser = await engine.type.launch(engine.launch);
  open.push(browser);
  // Explicit either way: Playwright applies the config's `permissions` to every
  // context in a test, and Firefox rejects "microphone" (it uses a pref).
  const page = await (await browser.newContext({ permissions: engine.grant ? ['microphone'] : [] })).newPage();
  await page.goto(baseURL);
  await page.evaluate(([r, n]) => (window as any).voiceDemo.join(r, n), [room, name] as const);
  return page;
}

const stats = (page: Page): Promise<Stats> => page.evaluate(() => (window as any).voiceDemo.stats());
const received = async (page: Page, from: string) =>
  (await stats(page)).perTrack.find((t) => t.from === from)?.packetsReceived ?? 0;

async function rate(page: Page, from: string, ms = 2_000): Promise<number> {
  const before = await received(page, from);
  await page.waitForTimeout(ms);
  return ((await received(page, from)) - before) / (ms / 1000);
}

for (const other of ['Firefox', 'WebKit'] as const) {
  test(`Chrome ↔ ${other}: audio both ways, and mute works both ways`, async ({ baseURL }) => {
    const room = `e2e-x-${other}-${Date.now()}`;
    const chrome = await participant('Chrome', baseURL!, room);
    const peer = await participant(other, baseURL!, room);

    await expect.poll(() => received(chrome, other), { timeout: 10_000 }).toBeGreaterThanOrEqual(50);
    await expect.poll(() => received(peer, 'Chrome'), { timeout: 10_000 }).toBeGreaterThanOrEqual(50);
    expect((await stats(chrome)).participants).toEqual([other]);
    expect((await stats(peer)).participants).toEqual(['Chrome']);

    // Opus at 20 ms frames is 50 packets/s; DTX can only lower it in silence,
    // and the fake sources are never silent for long.
    expect(await rate(chrome, other)).toBeGreaterThan(30);
    expect(await rate(peer, 'Chrome')).toBeGreaterThan(30);

    for (const [muter, listener, muterName] of [
      [chrome, peer, 'Chrome'],
      [peer, chrome, other],
    ] as const) {
      await muter.click('#mute');
      await muter.waitForTimeout(500);
      expect(await rate(listener, muterName)).toBe(0);
      await muter.click('#mute');
      await muter.waitForTimeout(500);
      expect(await rate(listener, muterName)).toBeGreaterThan(30);
    }

    const lost = (await stats(peer)).perTrack.reduce((sum, t) => sum + t.packetsLost, 0);
    expect(lost).toBe(0);
  });
}
