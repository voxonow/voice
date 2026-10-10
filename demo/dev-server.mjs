// Demo page server. Also stands in for Voxonow's API: POST /api/ticket signs
// a short-lived join ticket with the development private key.
//
// Development only. It hands a ticket to anyone who asks, which is exactly
// what Voxonow's real API must never do — there, the ticket comes after the
// user's session and channel permissions have been checked.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
const privateKeyPath = process.env.TICKET_PRIVATE_KEY_FILE || join(here, '..', '.dev-keys', 'ticket-private.pem');
const privateKey = await importPKCS8(readFileSync(privateKeyPath, 'utf8'), 'EdDSA');

const SOURCES = ['microphone', 'camera', 'screen_share', 'screen_share_audio'];
const files = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['dist/app.js', 'text/javascript; charset=utf-8'],
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
    if (body.length > 4096) throw new Error('body too large');
  }
  return JSON.parse(body || '{}');
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/api/ticket') {
      const { room, name, publish } = await readJson(request);
      if (typeof room !== 'string' || typeof name !== 'string') {
        response.writeHead(400).end();
        return;
      }
      const ticket = await mintTicket({ room, name, publish: Array.isArray(publish) ? publish : SOURCES });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ticket, voiceUrl }));
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
    response.writeHead(500).end();
  }
});

server.listen(port, () => console.log(`demo on http://localhost:${port} (voice: ${voiceUrl})`));
