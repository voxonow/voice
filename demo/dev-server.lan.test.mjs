// LAN (HTTPS) mode of the demo server, end to end over TLS: tickets only for a
// Host naming this machine, no upgrades but /ws, the CA download, and — the
// regression this exists for — refused requests never take the process down.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { ensureLanCerts } from '../scripts/lan-cert.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const port = 5600 + Math.floor(Math.random() * 300);
let dir;
let ca;
let server;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'demo-lan-test-'));
  const certs = ensureLanCerts({ dir: join(dir, 'lan'), name: 'test-mac' });
  ca = readFileSync(join(certs.dir, 'ca.crt'));
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(dir, 'ticket.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  server = spawn(process.execPath, [join(here, 'dev-server.mjs')], {
    env: {
      ...process.env,
      DEMO_PORT: String(port),
      DEMO_HOST: '127.0.0.1',
      DEMO_TLS_CERT_FILE: join(certs.dir, 'server.crt'),
      DEMO_TLS_KEY_FILE: join(certs.dir, 'server.key'),
      DEMO_CA_FILE: join(certs.dir, 'ca.cer'),
      DEMO_LOCAL_NAME: 'test-mac',
      TICKET_PRIVATE_KEY_FILE: join(dir, 'ticket.pem'),
      DEV_LOG_DIR: join(dir, 'logs'),
    },
    stdio: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    if ((await call('GET', '/healthz').catch(() => ({}))).status === 200) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('demo server did not start');
});

after(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

function call(method, path, { host = `localhost:${port}`, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', servername: 'localhost', port, path, method, ca, headers: { host, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const ticket = (host) =>
  call('POST', '/api/ticket', { host, body: JSON.stringify({ room: 'r', name: 'n' }), headers: { 'content-type': 'application/json' } });

test('issues a ticket and a same-origin wss URL for a Host naming this machine', async () => {
  const res = await ticket(`localhost:${port}`);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).voiceUrl, `wss://localhost:${port}/ws`);
  assert.equal((await ticket(`test-mac.local:${port}`)).status, 200);
});

test('refuses a foreign Host or port — and keeps running afterwards', async () => {
  assert.equal((await ticket(`evil.example:${port}`)).status, 400);
  assert.equal((await ticket(`localhost:${port + 1}`)).status, 400);
  assert.equal((await ticket('localhost')).status, 400);
  assert.equal((await call('GET', '/healthz')).status, 200);
});

test('refuses WebSocket upgrades on any path but /ws — and keeps running', async () => {
  const res = await call('GET', '/other', {
    headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
  }).catch((e) => ({ status: e.code }));
  assert.notEqual(res.status, 101);
  assert.equal((await call('GET', '/healthz')).status, 200);
});

test('offers only the public CA certificate for download', async () => {
  const res = await call('GET', '/ca.cer');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/x-x509-ca-cert');
  assert.ok(!res.body.includes('PRIVATE KEY'));
});
