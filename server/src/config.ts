import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

export interface Config {
  /** HTTP + WebSocket port (signaling and health). */
  port: number;
  host: string;
  /** Address media sockets bind to. */
  rtcListenIp: string;
  /** Public address announced to clients in ICE candidates. */
  rtcAnnouncedAddress: string;
  /**
   * First media port. Worker `i` listens on `rtcPortBase + i`, UDP and TCP —
   * one port per worker, so the firewall opening is as small as it can be.
   */
  rtcPortBase: number;
  numWorkers: number;
  ticket: {
    /** Ed25519 public key, PEM (SPKI). */
    publicKeyPem: string;
    issuer: string;
    audience: string;
  };
  /**
   * Browser origins allowed to open the signaling socket. Connections that
   * send no Origin (native clients) are allowed; they still need a ticket.
   */
  allowedOrigins: string[];
  logLevel: string;
}

class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return value;
}

function publicKeyPem(env: NodeJS.ProcessEnv): string {
  const inline = env.TICKET_PUBLIC_KEY;
  const file = env.TICKET_PUBLIC_KEY_FILE;
  if (inline && file) throw new ConfigError('Set TICKET_PUBLIC_KEY or TICKET_PUBLIC_KEY_FILE, not both');
  const pem = inline ?? (file ? readFileSync(file, 'utf8') : undefined);
  if (!pem) throw new ConfigError('TICKET_PUBLIC_KEY or TICKET_PUBLIC_KEY_FILE is required');
  if (pem.includes('PRIVATE KEY')) {
    // The voice server must never hold the signing key: a leaked server
    // config would otherwise let anyone mint tickets.
    throw new ConfigError('Ticket key must be the PUBLIC key; a private key was given');
  }
  return pem;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const numWorkers = int(env, 'NUM_WORKERS', availableParallelism(), 1, 64);
  const rtcPortBase = int(env, 'RTC_PORT_BASE', 40000, 1024, 65535 - numWorkers + 1);
  return {
    port: int(env, 'PORT', 7800, 0, 65535),
    host: env.HOST || '0.0.0.0',
    rtcListenIp: env.RTC_LISTEN_IP || '0.0.0.0',
    rtcAnnouncedAddress: required(env, 'RTC_ANNOUNCED_ADDRESS'),
    rtcPortBase,
    numWorkers,
    ticket: {
      publicKeyPem: publicKeyPem(env),
      issuer: env.TICKET_ISSUER || 'voxonow-api',
      audience: env.TICKET_AUDIENCE || 'voxonow-voice',
    },
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
