import { importSPKI, jwtVerify, type CryptoKey } from 'jose';
import type { TicketClaims } from '@voxonow/voice-protocol';
import { TicketClaimsSchema } from '@voxonow/voice-protocol/schemas';

/**
 * A ticket older than this is refused even if its `exp` says otherwise. The
 * API issues tickets moments before a join; a long-lived one is either a
 * misconfiguration or a stolen token being replayed later.
 */
export const MAX_TICKET_AGE_SECONDS = 10 * 60;

/** Clock skew tolerated between the API and this server. */
export const CLOCK_TOLERANCE_SECONDS = 5;

export class TicketError extends Error {}

export interface VerifiedTicket extends TicketClaims {
  exp: number;
}

/**
 * Verifies join tickets: Ed25519 signature, issuer, audience, time window,
 * claim shape, and single use of `jti`.
 */
export class TicketVerifier {
  /** jti → expiry (epoch seconds). Entries outlive their ticket by nothing. */
  private readonly used = new Map<string, number>();

  private constructor(
    private readonly key: CryptoKey,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly now: () => number,
  ) {}

  static async create(options: {
    publicKeyPem: string;
    issuer: string;
    audience: string;
    /** Epoch seconds; injectable for tests. */
    now?: () => number;
  }): Promise<TicketVerifier> {
    const key = await importSPKI(options.publicKeyPem, 'EdDSA');
    return new TicketVerifier(
      key,
      options.issuer,
      options.audience,
      options.now ?? (() => Math.floor(Date.now() / 1000)),
    );
  }

  async verify(token: string): Promise<VerifiedTicket> {
    const now = this.now();
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        algorithms: ['EdDSA'],
        issuer: this.issuer,
        audience: this.audience,
        requiredClaims: ['exp', 'iat', 'jti', 'sub'],
        maxTokenAge: MAX_TICKET_AGE_SECONDS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(now * 1000),
      }));
    } catch (error) {
      throw new TicketError(`invalid ticket: ${(error as Error).message}`);
    }

    const claims = TicketClaimsSchema.safeParse(payload);
    if (!claims.success) throw new TicketError('invalid ticket claims');
    const exp = payload.exp as number;

    this.prune(now);
    if (this.used.has(claims.data.jti)) throw new TicketError('ticket already used');
    this.used.set(claims.data.jti, exp + CLOCK_TOLERANCE_SECONDS);

    return { ...claims.data, exp };
  }

  /** Number of remembered ticket ids; exposed for tests. */
  get rememberedCount(): number {
    return this.used.size;
  }

  private prune(now: number): void {
    for (const [jti, expiry] of this.used) {
      if (expiry < now) this.used.delete(jti);
    }
  }
}
