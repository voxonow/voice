import { CloseCode } from '@voxonow/voice-protocol';

/**
 * Automatic rejoin (Phase 3B: the third recovery tier of the Phase 3A audit —
 * a new session with a new ticket). No ICE restart and no session resume yet:
 * every recovery is a full rejoin.
 */
export interface ReconnectOptions {
  /** Total time to keep trying before giving up, not counting time offline. */
  budgetMs: number;
  /** First retry delay; doubles per attempt up to `maxDelayMs`. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** A planned server shutdown (4011) spreads the first attempt over 0..this. */
  shutdownSpreadMs: number;
  /** Consecutive ticket rejections (4003) tolerated before stopping. */
  maxAuthFailures: number;
  /** Longest wait for the signaling socket to open during a rejoin. */
  connectTimeoutMs: number;
}

export const RECONNECT_DEFAULTS: ReconnectOptions = {
  budgetMs: 30_000,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  shutdownSpreadMs: 5_000,
  maxAuthFailures: 2,
  connectTimeoutMs: 10_000,
};

/**
 * What a lost session or a failed attempt means for recovery:
 *  - `final`    stop: the user left, another connection took over, or the
 *               client is broken — retrying cannot help and could loop
 *  - `auth`     the ticket was refused: a new ticket may help, a few times
 *  - `now`      the server is up but the room is gone (worker failure): retry at once
 *  - `shutdown` planned server restart: retry, first attempt spread out
 *  - `retry`    anything else (network, abnormal close): retry with backoff
 */
export type LossKind = 'final' | 'auth' | 'now' | 'shutdown' | 'retry';

export function classifyClose(code: number): LossKind {
  switch (code) {
    case CloseCode.Left:
    case CloseCode.Replaced:
    case CloseCode.AuthRequired:
      return 'final';
    case CloseCode.Unauthorized:
      return 'auth';
    case CloseCode.RoomClosed:
      return 'now';
    case CloseCode.ServerShutdown:
      return 'shutdown';
    default:
      return 'retry';
  }
}

/** Delay before attempt `n` (1-based) after a failed one: half fixed, half random ("equal jitter"). */
export function backoffDelay(attempt: number, options: ReconnectOptions, random: () => number): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  return ceiling / 2 + random() * (ceiling / 2);
}

export interface NetworkStatus {
  isOnline(): boolean;
  /** Calls `listener` when the browser comes back online; returns an unsubscribe. */
  onOnline(listener: () => void): () => void;
}

/** navigator.onLine and the window `online` event; always online where they do not exist. */
export const browserNetwork: NetworkStatus = {
  isOnline: () => (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' ? true : navigator.onLine),
  onOnline(listener) {
    if (typeof globalThis.addEventListener !== 'function') return () => {};
    globalThis.addEventListener('online', listener);
    return () => globalThis.removeEventListener('online', listener);
  },
};

/** Outcome of one rejoin attempt. */
export type AttemptResult = { ok: true } | { ok: false; kind: LossKind; code: number; reason: string };

export interface ReconnectorDeps {
  options: ReconnectOptions;
  network: NetworkStatus;
  random: () => number;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** One full rejoin; must settle (resolve) on success or failure, never throw. */
  attempt: (info: { attempt: number; remainingMs: number }) => Promise<AttemptResult>;
  onRecovered: () => void;
  onGiveUp: (code: number, reason: string) => void;
}

/** Code reported when the budget runs out (no server sent it). */
export const RECONNECT_TIMEOUT_CODE = 4900;

/**
 * Runs rejoin attempts until one succeeds, a final answer arrives, or the
 * budget is spent. While the browser reports being offline it does not try
 * and the budget does not run; it tries again as soon as the browser is back.
 */
export class Reconnector {
  private attempts = 0;
  private authFailures = 0;
  /** Budget spent, in ms of online time. */
  private spent = 0;
  /** When the current online stretch started (null while offline or idle). */
  private onlineSince: number | null = null;
  private timer: unknown;
  private unsubscribeOnline?: () => void;
  private running = false;
  private stopped = false;

  constructor(private readonly deps: ReconnectorDeps) {}

  get attemptCount(): number {
    return this.attempts;
  }

  /** Starts recovery after a loss of the given kind (not `final`). */
  start(kind: Exclude<LossKind, 'final'>): void {
    const { options, random } = this.deps;
    if (kind === 'auth') this.authFailures++;
    const first =
      kind === 'now' ? 0 : kind === 'shutdown' ? random() * options.shutdownSpreadMs : backoffDelay(1, options, random);
    this.schedule(first);
  }

  cancel(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
    this.unsubscribeOnline?.();
    this.unsubscribeOnline = undefined;
  }

  private remaining(): number {
    const live = this.onlineSince === null ? 0 : this.deps.now() - this.onlineSince;
    return this.deps.options.budgetMs - this.spent - live;
  }

  private pauseBudget(): void {
    if (this.onlineSince !== null) this.spent += this.deps.now() - this.onlineSince;
    this.onlineSince = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (!this.deps.network.isOnline()) return this.waitForOnline();
    if (this.onlineSince === null) this.onlineSince = this.deps.now();
    const remaining = this.remaining();
    if (remaining <= 0 || delayMs >= remaining) {
      // Waiting would only end past the budget: give up when it runs out.
      this.timer = this.deps.setTimer(() => this.giveUp(RECONNECT_TIMEOUT_CODE, 'reconnect timed out'), Math.max(0, remaining));
      return;
    }
    this.timer = this.deps.setTimer(() => void this.run(), delayMs);
  }

  private waitForOnline(): void {
    this.pauseBudget();
    if (this.unsubscribeOnline) return;
    this.unsubscribeOnline = this.deps.network.onOnline(() => {
      this.unsubscribeOnline?.();
      this.unsubscribeOnline = undefined;
      // Back online: try at once, the network change is the event worth reacting to.
      this.schedule(0);
    });
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    if (this.stopped || this.running) return;
    if (!this.deps.network.isOnline()) return this.waitForOnline();
    this.running = true;
    this.attempts++;
    const result = await this.deps.attempt({ attempt: this.attempts, remainingMs: this.remaining() });
    this.running = false;
    if (this.stopped) return;
    if (result.ok) {
      this.stopped = true;
      this.pauseBudget();
      this.unsubscribeOnline?.();
      return this.deps.onRecovered();
    }
    if (result.kind === 'final') return this.giveUp(result.code, result.reason);
    if (result.kind === 'auth') {
      this.authFailures++;
      if (this.authFailures > this.deps.options.maxAuthFailures) return this.giveUp(result.code, result.reason);
    } else {
      this.authFailures = 0;
    }
    // Only the first attempt after a worker failure skips the wait; a repeat
    // means the server is not ready yet, so back off like any other failure.
    this.schedule(backoffDelay(this.attempts + 1, this.deps.options, this.deps.random));
  }

  private giveUp(code: number, reason: string): void {
    if (this.stopped) return;
    this.cancel();
    this.deps.onGiveUp(code, reason);
  }
}
