import { randomUUID } from 'node:crypto';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { WebSocket } from 'ws';
import { pino } from 'pino';
import { PROTOCOL_VERSION, type Notification, type Response } from '@voxonow/voice-protocol';
import type { Config } from '../src/config.js';
import { startVoiceServer, type VoiceServer } from '../src/server.js';
import type { SignalingLimits } from '../src/signaling.js';

export interface Keys {
  privateKey: CryptoKey;
  publicKeyPem: string;
}

export async function makeKeys(): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return { privateKey, publicKeyPem: await exportSPKI(publicKey) };
}

export interface TicketOverrides {
  sub?: string;
  room?: string;
  name?: string;
  publish?: unknown;
  jti?: string | null;
  iss?: string;
  aud?: string;
  /** Epoch seconds. */
  iat?: number;
  nbf?: number;
  exp?: number;
  key?: CryptoKey;
  /** Extra/replacement payload fields, applied last. */
  payload?: Record<string, unknown>;
}

export async function mintTicket(keys: Keys, overrides: TicketOverrides = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    room: overrides.room ?? 'room-1',
    name: overrides.name ?? 'Test',
    publish: overrides.publish ?? ['microphone'],
    ...overrides.payload,
  };
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(overrides.iss ?? 'voxonow-api')
    .setAudience(overrides.aud ?? 'voxonow-voice')
    .setSubject(overrides.sub ?? `user-${randomUUID()}`)
    .setIssuedAt(overrides.iat ?? now)
    .setExpirationTime(overrides.exp ?? now + 120);
  if (overrides.jti !== null) jwt.setJti(overrides.jti ?? randomUUID());
  if (overrides.nbf !== undefined) jwt.setNotBefore(overrides.nbf);
  return jwt.sign(overrides.key ?? keys.privateKey);
}

let nextPortBase = 42000 + Math.floor(Math.random() * 1000) * 10;

export async function startTestServer(
  keys: Keys,
  limits: Partial<SignalingLimits> = {},
  config: Partial<Config> = {},
): Promise<VoiceServer> {
  const rtcPortBase = nextPortBase;
  nextPortBase += 10;
  return startVoiceServer(
    {
      port: 0,
      host: '127.0.0.1',
      rtcListenIp: '127.0.0.1',
      rtcAnnouncedAddress: '127.0.0.1',
      rtcPortBase,
      numWorkers: 1,
      ticket: { publicKeyPem: keys.publicKeyPem, issuer: 'voxonow-api', audience: 'voxonow-voice' },
      allowedOrigins: ['https://app.example'],
      logLevel: 'silent',
      ...config,
    },
    { logger: pino({ level: 'silent' }), limits },
  );
}

/** A raw signaling client: speaks the wire protocol directly, no mediasoup-client. */
export class TestClient {
  readonly notifications: Notification[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly pending = new Map<number, (response: Response) => void>();
  private nextId = 1;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if ('notification' in message) this.notifications.push(message);
      else this.pending.get(message.id)?.(message);
    });
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  static connect(server: VoiceServer, options: { origin?: string; path?: string } = {}): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${options.path ?? '/ws'}`, {
      headers: options.origin ? { origin: options.origin } : {},
    });
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(new TestClient(ws)));
      ws.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
      ws.once('error', reject);
    });
  }

  request(method: string, data: unknown = {}): Promise<Response> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, data }));
    });
  }

  async join(ticket: string): Promise<Response> {
    return this.request('join', { ticket, protocol: PROTOCOL_VERSION });
  }

  /** Waits until a notification matching `predicate` has arrived. */
  async waitFor(predicate: (n: Notification) => boolean, timeoutMs = 2000): Promise<Notification> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.notifications.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('notification did not arrive');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  close(): void {
    this.ws.close();
  }
}
