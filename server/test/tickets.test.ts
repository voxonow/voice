import { generateKeyPair, SignJWT, exportPKCS8 } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MAX_TICKET_AGE_SECONDS, TicketVerifier } from '../src/tickets.js';
import { makeKeys, mintTicket, type Keys } from './helpers.js';

let keys: Keys;
let verifier: TicketVerifier;

beforeAll(async () => {
  keys = await makeKeys();
});

async function freshVerifier(now?: () => number): Promise<TicketVerifier> {
  return TicketVerifier.create({ publicKeyPem: keys.publicKeyPem, issuer: 'voxonow-api', audience: 'voxonow-voice', now });
}

describe('TicketVerifier', () => {
  beforeAll(async () => {
    verifier = await freshVerifier();
  });

  it('accepts a valid ticket and returns its claims', async () => {
    const ticket = await mintTicket(keys, { sub: 'u1', room: 'ch:42', name: 'Ada', publish: ['microphone', 'camera'] });
    const claims = await verifier.verify(ticket);
    expect(claims).toMatchObject({ sub: 'u1', room: 'ch:42', name: 'Ada', publish: ['microphone', 'camera'] });
  });

  const now = () => Math.floor(Date.now() / 1000);
  const rejected: [string, () => Promise<string>][] = [
    ['signed by another key', async () => mintTicket(keys, { key: (await makeKeys()).privateKey })],
    ['expired', async () => mintTicket(keys, { iat: now() - 120, exp: now() - 60 })],
    ['not yet valid', async () => mintTicket(keys, { nbf: now() + 60 })],
    ['wrong audience', async () => mintTicket(keys, { aud: 'someone-else' })],
    ['wrong issuer', async () => mintTicket(keys, { iss: 'attacker' })],
    ['without jti', async () => mintTicket(keys, { jti: null })],
    ['with a too-short jti', async () => mintTicket(keys, { jti: 'abc' })],
    [
      'older than the maximum ticket age, even with a valid exp',
      async () => mintTicket(keys, { iat: now() - MAX_TICKET_AGE_SECONDS - 60, exp: now() + 60 }),
    ],
    ['publishing an unknown source', async () => mintTicket(keys, { publish: ['microphone', 'everything'] })],
    ['with a malformed room id', async () => mintTicket(keys, { room: '../other room' })],
    ['without a name', async () => mintTicket(keys, { payload: { name: undefined } })],
    [
      'signed with HS256 instead of EdDSA',
      async () =>
        new SignJWT({ room: 'room-1', name: 'x', publish: [] })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuer('voxonow-api')
          .setAudience('voxonow-voice')
          .setSubject('u')
          .setJti('0123456789abcdef0123')
          .setIssuedAt()
          .setExpirationTime('1m')
          .sign(new TextEncoder().encode('a-shared-secret-of-sufficient-length')),
    ],
    [
      'with alg none',
      async () => {
        const body = Buffer.from(
          JSON.stringify({
            iss: 'voxonow-api',
            aud: 'voxonow-voice',
            sub: 'u',
            jti: '0123456789abcdef0123',
            room: 'room-1',
            name: 'x',
            publish: [],
            iat: now(),
            exp: now() + 60,
          }),
        ).toString('base64url');
        return `${Buffer.from('{"alg":"none"}').toString('base64url')}.${body}.`;
      },
    ],
    ['that is not a JWT at all', async () => 'not-a-ticket'],
  ];

  it.each(rejected)('rejects a ticket %s', async (_label, make) => {
    await expect(verifier.verify(await make())).rejects.toThrow(/invalid ticket/);
  });

  it('accepts a ticket only once', async () => {
    const ticket = await mintTicket(keys);
    await verifier.verify(ticket);
    await expect(verifier.verify(ticket)).rejects.toThrow('ticket already used');
  });

  it('forgets used ticket ids once they have expired', async () => {
    let clock = now();
    const local = await freshVerifier(() => clock);
    await local.verify(await mintTicket(keys, { iat: clock, exp: clock + 30 }));
    expect(local.rememberedCount).toBe(1);
    clock += 60;
    await local.verify(await mintTicket(keys, { iat: clock, exp: clock + 30 }));
    expect(local.rememberedCount).toBe(1);
  });
});

describe('loadConfig', () => {
  const base = { RTC_ANNOUNCED_ADDRESS: '203.0.113.7' };

  it('refuses a private key where the public ticket key belongs', async () => {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const pem = await exportPKCS8(privateKey);
    expect(() => loadConfig({ ...base, TICKET_PUBLIC_KEY: pem })).toThrow(/PUBLIC key/);
  });

  it('requires a ticket key and an announced address', () => {
    expect(() => loadConfig({ RTC_ANNOUNCED_ADDRESS: '203.0.113.7' })).toThrow(/TICKET_PUBLIC_KEY/);
    expect(() => loadConfig({ TICKET_PUBLIC_KEY: keys.publicKeyPem })).toThrow(/RTC_ANNOUNCED_ADDRESS/);
  });

  it('rejects out-of-range numbers instead of guessing', () => {
    expect(() => loadConfig({ ...base, TICKET_PUBLIC_KEY: keys.publicKeyPem, NUM_WORKERS: '0' })).toThrow(/NUM_WORKERS/);
    expect(() => loadConfig({ ...base, TICKET_PUBLIC_KEY: keys.publicKeyPem, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('parses the origin allow-list', () => {
    const config = loadConfig({
      ...base,
      TICKET_PUBLIC_KEY: keys.publicKeyPem,
      ALLOWED_ORIGINS: ' https://app.voxonow.com , https://staging.voxonow.com ,',
    });
    expect(config.allowedOrigins).toEqual(['https://app.voxonow.com', 'https://staging.voxonow.com']);
  });
});
