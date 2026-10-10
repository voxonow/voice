// Demo page server. Also stands in for Voxonow's API: POST /api/ticket signs
// a short-lived join ticket with the development private key.
//
// Development only. It hands a ticket to anyone who asks, which is exactly
// what Voxonow's real API must never do — there, the ticket comes after the
// user's session and channel permissions have been checked.
//
// LAN mode (DEMO_TLS_CERT_FILE + DEMO_TLS_KEY_FILE, set by `npm run dev:lan`):
// serves HTTPS, refuses clients outside this Mac's subnets, proxies /ws to the
// voice server (VOICE_UPSTREAM, listening on loopback only) so a device trusts
// one certificate for one origin, and offers the development CA at /ca.cer.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isLanClient } from './lan.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, importPKCS8 } from 'jose';

if (process.env.NODE_ENV === 'production') {
  console.error('dev-server mints tickets for anyone; refusing to run with NODE_ENV=production');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.DEMO_PORT || 5173);
const voiceUrl = process.env.VOICE_URL || 'ws://localhost:7800/ws';
const tls = process.env.DEMO_TLS_CERT_FILE && process.env.DEMO_TLS_KEY_FILE;
const voiceUpstream = new URL(process.env.VOICE_UPSTREAM || 'ws://127.0.0.1:7800/ws');
const caFile = process.env.DEMO_CA_FILE;

/** Host header values that name this Mac: its LAN IPs, <name>.local, localhost — on our port. */
function isOwnHost(host) {
  if (typeof host !== 'string') return false;
  const match = /^([A-Za-z0-9.-]+):(\d+)$/.exec(host);
  if (!match || Number(match[2]) !== port) return false;
  const name = match[1].toLowerCase();
  const local = (process.env.DEMO_LOCAL_NAME || '').toLowerCase();
  return (
    name === 'localhost' ||
    name === '127.0.0.1' ||
    (local !== '' && name === `${local}.local`) ||
    lanInterfaces().some((a) => a.address === name)
  );
}

function lanInterfaces() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal);
}
const privateKeyPath = process.env.TICKET_PRIVATE_KEY_FILE || join(here, '..', '.dev-keys', 'ticket-private.pem');
const privateKey = await importPKCS8(readFileSync(privateKeyPath, 'utf8'), 'EdDSA');

// Browser-side events from the demo page, so a developer (or an assistant
// reading the repo) can diagnose a manual test without copying from each window.
const clientLogDir = process.env.DEV_LOG_DIR || join(here, '..', '.dev-logs');
let clientLog;
try {
  mkdirSync(clientLogDir, { recursive: true });
  clientLog = join(clientLogDir, 'clients.log');
} catch (error) {
  // e.g. a read-only container: the demo still works, only without the log.
  console.warn(`browser log disabled: cannot create ${clientLogDir} (${error.code})`);
}

const SOURCES = ['microphone', 'camera', 'screen_share', 'screen_share_audio'];
const files = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['dist/app.js', 'text/javascript; charset=utf-8'],
  // Noise-suppression worklets and models (src/noise.ts), copied by the build.
  '/nsw/rnnoise.js': ['dist/nsw/rnnoise.js', 'text/javascript; charset=utf-8'],
  '/nsw/rnnoise.wasm': ['dist/nsw/rnnoise.wasm', 'application/wasm'],
  '/nsw/rnnoise_simd.wasm': ['dist/nsw/rnnoise_simd.wasm', 'application/wasm'],
  '/nsw/gtcrn.js': ['dist/nsw/gtcrn.js', 'text/javascript; charset=utf-8'],
  '/nsw/gtcrn.wasm': ['dist/nsw/gtcrn.wasm', 'application/wasm'],
  '/nsw/band-merge.js': ['dist/nsw/band-merge.js', 'text/javascript; charset=utf-8'],
};

async function mintTicket({ room, name, publish = SOURCES }) {
  return new SignJWT({ room, name, publish })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('voxonow-api')
    .setAudience('voxonow-voice')
    .setSubject(`demo-${randomUUID()}`)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(privateKey);
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error('body too large');
  }
  return JSON.parse(body || '{}');
}

const handler = async (request, response) => {
  if (tls && !isLanClient(request.socket.remoteAddress, lanInterfaces())) {
    response.writeHead(403).end();
    return;
  }
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/api/ticket') {
      const { room, name, publish } = await readJson(request);
      if (typeof room !== 'string' || typeof name !== 'string') {
        response.writeHead(400).end();
        return;
      }
      // In LAN mode signaling goes through this same origin (proxied below).
      // Only a Host naming this Mac is echoed back into the URL.
      if (tls && !isOwnHost(request.headers.host)) {
        response.writeHead(400).end();
        return;
      }
      const ticket = await mintTicket({ room, name, publish: Array.isArray(publish) ? publish : SOURCES });
      const url = tls ? `wss://${request.headers.host}/ws` : voiceUrl;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ticket, voiceUrl: url }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/log') {
      const { client, lines } = await readJson(request);
      if (typeof client === 'string' && Array.isArray(lines)) {
        const stamp = new Date().toISOString();
        const text = lines
          .filter((line) => typeof line === 'string')
          .slice(0, 50)
          .map((line) => `${stamp} [${client.slice(0, 40)}] ${line.slice(0, 500)}\n`)
          .join('');
        if (clientLog) appendFileSync(clientLog, text);
      }
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/ca.cer' && caFile) {
      // Public half of the development CA, for installing on test devices.
      response.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="voxonow-voice-dev-ca.cer"',
      });
      response.end(readFileSync(caFile));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200).end('ok');
      return;
    }
    const file = files[url.pathname];
    if (request.method === 'GET' && file) {
      response.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
      response.end(readFileSync(join(here, file[0])));
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    console.error(error);
    // Never let one bad request take the process down.
    if (response.headersSent) response.destroy();
    else response.writeHead(500).end();
  }
};

const server = tls
  ? createTlsServer({ cert: readFileSync(process.env.DEMO_TLS_CERT_FILE), key: readFileSync(process.env.DEMO_TLS_KEY_FILE) }, handler)
  : createServer(handler);

if (tls) {
  // WebSocket signaling: pipe the upgrade straight through to the voice
  // server. The browser's Origin header is forwarded untouched, so the voice
  // server's own origin allow-list still decides.
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'https://localhost').pathname;
    if (path !== '/ws' || !isLanClient(socket.remoteAddress, lanInterfaces())) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = connect(Number(voiceUpstream.port), voiceUpstream.hostname, () => {
      const headers = Object.entries(request.headers)
        .filter(([name]) => name !== 'host')
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      upstream.write(
        [`GET ${voiceUpstream.pathname} HTTP/1.1`, `host: ${voiceUpstream.host}`, ...headers, '', ''].join('\r\n'),
      );
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
  });
}

// Plain HTTP mode listens on every interface, as it did before LAN mode.
// Listening on loopback only made Firefox fail to establish media (ICE failed
// at once) in CI on Linux — observed and bisected 2026-10-10, mechanism not
// determined. (A subnet check here would lock out Docker Desktop's port
// forwarding, which arrives from outside the container's subnet.)
const host = process.env.DEMO_HOST || (tls ? '0.0.0.0' : undefined);
server.listen(port, host, () =>
  console.log(
    tls
      ? `demo on https://<this Mac>:${port} (LAN only; signaling proxied to ${voiceUpstream.href})`
      : `demo on http://localhost:${port} (voice: ${voiceUrl})`,
  ),
);
