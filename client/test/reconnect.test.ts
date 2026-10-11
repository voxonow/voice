import { CloseCode } from '@voxonow/voice-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECONNECT_DEFAULTS,
  RECONNECT_TIMEOUT_CODE,
  Reconnector,
  backoffDelay,
  classifyClose,
  type AttemptResult,
  type NetworkStatus,
} from '../src/reconnect.js';

const fail = (kind: 'retry' | 'auth' | 'final' | 'now' | 'limited', code = 1006): AttemptResult => ({ ok: false, kind, code, reason: kind });

class FakeNetwork implements NetworkStatus {
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

/** A Reconnector on fake timers, recording when each attempt ran. */
function setup(outcomes: (AttemptResult | (() => AttemptResult))[], opts: { random?: () => number; network?: FakeNetwork } = {}) {
  const random = opts.random ?? (() => 0.5);
  const network = opts.network ?? new FakeNetwork();
  const attemptsAt: number[] = [];
  const result = { recovered: false, gaveUp: undefined as { code: number; reason: string } | undefined };
  const start = Date.now();
  const reconnector = new Reconnector({
    options: RECONNECT_DEFAULTS,
    network,
    random,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    attempt: async () => {
      attemptsAt.push(Date.now() - start);
      const next = outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!;
      return typeof next === 'function' ? next() : next;
    },
    onRecovered: () => (result.recovered = true),
    onGiveUp: (code, reason) => (result.gaveUp = { code, reason }),
  });
  return { reconnector, attemptsAt, result, network, elapsed: () => Date.now() - start };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('classifyClose', () => {
  it('never retries after leave, replacement or a protocol error', () => {
    expect(classifyClose(CloseCode.Left)).toBe('final');
    expect(classifyClose(CloseCode.Replaced)).toBe('final');
    expect(classifyClose(CloseCode.AuthRequired)).toBe('final');
  });
  it('retries a join timeout (4012), never a malformed or out-of-order join (4001)', () => {
    expect(classifyClose(CloseCode.JoinTimeout)).toBe('retry');
    expect(classifyClose(CloseCode.AuthRequired)).toBe('final');
  });
  it('treats ticket rejection, worker loss, shutdown and network drops differently', () => {
    expect(classifyClose(CloseCode.Unauthorized)).toBe('auth');
    expect(classifyClose(CloseCode.RoomClosed)).toBe('now');
    expect(classifyClose(CloseCode.ServerShutdown)).toBe('shutdown');
    expect(classifyClose(1006)).toBe('retry');
    expect(classifyClose(1001)).toBe('retry');
    expect(classifyClose(CloseCode.RateLimited)).toBe('limited');
  });
});

describe('backoffDelay', () => {
  it('doubles from 0.5 s, caps at 8 s, and keeps half of it random', () => {
    const at = (attempt: number, r: number) => backoffDelay(attempt, RECONNECT_DEFAULTS, () => r);
    expect([at(1, 0), at(1, 1)]).toEqual([250, 500]);
    expect([at(2, 0), at(2, 1)]).toEqual([500, 1000]);
    expect([at(5, 0), at(5, 1)]).toEqual([4000, 8000]);
    expect([at(12, 0), at(12, 1)]).toEqual([4000, 8000]);
  });
});

describe('Reconnector', () => {
  it('after a network drop: waits, retries with growing delays, stops on success', async () => {
    const { reconnector, attemptsAt, result } = setup([fail('retry'), fail('retry'), { ok: true }]);
    reconnector.start('retry');
    await vi.runAllTimersAsync();
    // random 0.5 → 375, then +750, then +1500
    expect(attemptsAt).toEqual([375, 1125, 2625]);
    expect(result.recovered).toBe(true);
    expect(result.gaveUp).toBeUndefined();
    expect(reconnector.attemptCount).toBe(3);
  });

  it('after a worker failure (4010): first attempt at once, then backs off', async () => {
    const { reconnector, attemptsAt, result } = setup([fail('now', CloseCode.RoomClosed), { ok: true }]);
    reconnector.start('now');
    await vi.runAllTimersAsync();
    expect(attemptsAt).toEqual([0, 750]);
    expect(result.recovered).toBe(true);
  });

  it('after a planned shutdown (4011): first attempt spread over 0–5 s', async () => {
    for (const r of [0, 0.37, 0.999]) {
      vi.setSystemTime(0);
      const { reconnector, attemptsAt } = setup([{ ok: true }], { random: () => r });
      reconnector.start('shutdown');
      await vi.runAllTimersAsync();
      expect(attemptsAt[0]).toBeCloseTo(r * 5000, 0);
      expect(attemptsAt[0]).toBeLessThanOrEqual(5000);
    }
  });

  it('gives up when the 30 s budget is spent, and tries nothing after', async () => {
    const { reconnector, attemptsAt, result, elapsed } = setup([fail('retry')]);
    reconnector.start('retry');
    await vi.runAllTimersAsync();
    expect(result.gaveUp).toEqual({ code: RECONNECT_TIMEOUT_CODE, reason: 'reconnect timed out' });
    expect(elapsed()).toBe(30_000);
    expect(attemptsAt.length).toBeGreaterThan(3);
    expect(Math.max(...attemptsAt)).toBeLessThan(30_000);
    const count = attemptsAt.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attemptsAt.length).toBe(count);
  });

  it('does not try while offline, does not spend budget offline, and tries soon (0–1 s) when back', async () => {
    const network = new FakeNetwork();
    network.online = false;
    const { reconnector, attemptsAt, result } = setup([{ ok: true }], { network });
    reconnector.start('retry');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attemptsAt).toEqual([]);
    expect(result.gaveUp).toBeUndefined();
    network.set(true);
    await vi.runAllTimersAsync();
    expect(attemptsAt).toEqual([120_500]); // random 0.5 × 1 s spread
    expect(result.recovered).toBe(true);
  });

  it('keeps the budget it had left across an offline stretch', async () => {
    const network = new FakeNetwork();
    const { reconnector, attemptsAt, result, elapsed } = setup([fail('retry')], { network });
    reconnector.start('retry');
    await vi.advanceTimersByTimeAsync(10_000); // 10 s of failing online
    network.online = false;
    await vi.advanceTimersByTimeAsync(100_000); // offline: nothing happens
    const offlineAttempts = attemptsAt.filter((t) => t > 18_000 && t < 110_000).length;
    expect(offlineAttempts).toBe(0);
    network.set(true);
    await vi.runAllTimersAsync();
    expect(result.gaveUp?.code).toBe(RECONNECT_TIMEOUT_CODE);
    // Offline is noticed when the next attempt is due (11.625 s); budget spent
    // until then counts, the 98 s after do not: 110 s + (30 − 11.625) s.
    expect(elapsed()).toBe(110_000 + 30_000 - 11_625);
  });

  it('going offline cancels the pending attempt at once and stops the budget clock there', async () => {
    const network = new FakeNetwork();
    const { reconnector, attemptsAt, result } = setup([fail('retry')], { network });
    reconnector.start('retry');
    await vi.advanceTimersByTimeAsync(1_000); // attempt at 375 failed, next due at 1 125
    network.set(false); // the offline event, at 1 000
    await vi.advanceTimersByTimeAsync(100_000);
    expect(attemptsAt).toEqual([375]);
    network.set(true); // at 101 000: budget left 29 s, first attempt within 1 s
    await vi.runAllTimersAsync();
    expect(attemptsAt[1]).toBe(101_500);
    expect(result.gaveUp?.code).toBe(RECONNECT_TIMEOUT_CODE);
    expect(Date.now()).toBe(101_000 + 29_000);
  });

  it('rate limited (4008): first try after 15–20 s, and only one', async () => {
    const { reconnector, attemptsAt, result } = setup([fail('limited', 4008)]);
    reconnector.start('limited');
    await vi.runAllTimersAsync();
    expect(attemptsAt).toEqual([17_500]);
    expect(result.gaveUp?.code).toBe(4008);
  });

  it('rate limited during a rejoin: one long wait, one more try, then stop', async () => {
    const { reconnector, attemptsAt, result } = setup([fail('limited', 4008), fail('limited', 4008)]);
    reconnector.start('retry');
    await vi.runAllTimersAsync();
    expect(attemptsAt).toEqual([375, 375 + 17_500]);
    expect(result.gaveUp?.code).toBe(4008);
  });

  it('rate-limit wait counts against the 30 s budget', async () => {
    const { reconnector, attemptsAt, result } = setup([fail('retry')]);
    reconnector.start('limited');
    await vi.runAllTimersAsync();
    expect(attemptsAt[0]).toBe(17_500);
    expect(result.gaveUp?.code).toBe(RECONNECT_TIMEOUT_CODE);
    expect(Date.now()).toBe(30_000);
  });

  it('allows a limited number of ticket rejections, then stops', async () => {
    const { reconnector, attemptsAt, result } = setup([fail('auth', 4003)]);
    reconnector.start('retry');
    await vi.runAllTimersAsync();
    expect(attemptsAt.length).toBe(RECONNECT_DEFAULTS.maxAuthFailures + 1);
    expect(result.gaveUp?.code).toBe(4003);
  });

  it('resets the rejection count when an attempt fails for another reason', async () => {
    const { reconnector, attemptsAt, result } = setup([fail('auth', 4003), fail('auth', 4003), fail('retry'), fail('auth', 4003), fail('auth', 4003), { ok: true }]);
    reconnector.start('retry');
    await vi.runAllTimersAsync();
    expect(attemptsAt.length).toBe(6);
    expect(result.recovered).toBe(true);
  });

  it('stops at once on a final answer (e.g. replaced by another connection)', async () => {
    const { reconnector, attemptsAt, result } = setup([fail('retry'), fail('final', CloseCode.Replaced)]);
    reconnector.start('retry');
    await vi.runAllTimersAsync();
    expect(attemptsAt.length).toBe(2);
    expect(result.gaveUp?.code).toBe(CloseCode.Replaced);
  });

  it('does nothing more once cancelled', async () => {
    const { reconnector, attemptsAt, result } = setup([fail('retry')]);
    reconnector.start('retry');
    await vi.advanceTimersByTimeAsync(1_000);
    const count = attemptsAt.length;
    reconnector.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attemptsAt.length).toBe(count);
    expect(result.gaveUp).toBeUndefined();
    expect(result.recovered).toBe(false);
  });
});
