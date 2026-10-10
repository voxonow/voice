// The development CA must only be able to vouch for this Mac on its LAN.
// Checked with real certificate verification (openssl verify), including the
// cases an attacker holding the CA key would try.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ensureLanCerts } from './lan-cert.mjs';

let dir;
let info;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'lan-cert-test-'));
  info = ensureLanCerts({
    dir: join(dir, 'lan'),
    interfaces: [{ address: '192.168.50.10', netmask: '255.255.255.0' }],
    name: 'test-mac',
  });
});
after(() => rmSync(dir, { recursive: true, force: true }));

const ca = (f) => join(info.dir, f);
let serial = 0;

/**
 * Signs a certificate with `issuer` (default: the dev CA). The subject CN is
 * always a permitted name: OpenSSL also checks a CN against the name
 * constraints when there is no DNS SAN, and a refusal must come from the SAN
 * under test, not from the CN.
 */
function sign({ san, isCa = false, issuer = { crt: ca('ca.crt'), key: ca('ca.key') } } = {}) {
  const subject = 'localhost';
  const id = `c${++serial}`;
  const key = join(dir, `${id}.key`);
  const cnf = join(dir, `${id}.cnf`);
  const csr = join(dir, `${id}.csr`);
  const crt = join(dir, `${id}.crt`);
  writeFileSync(
    cnf,
    ['[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', `CN=${subject}`, '[v]',
      isCa ? 'basicConstraints=critical,CA:TRUE' : 'basicConstraints=critical,CA:FALSE',
      isCa ? 'keyUsage=critical,keyCertSign' : 'extendedKeyUsage=serverAuth',
      ...(san ? [`subjectAltName=${san}`] : []), ''].join('\n'),
  );
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
  execFileSync('openssl', ['req', '-new', '-key', key, '-config', cnf, '-out', csr]);
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', issuer.crt, '-CAkey', issuer.key, '-CAcreateserial',
    '-CAserial', join(dir, `${id}.srl`), '-days', '1', '-sha256', '-extfile', cnf, '-extensions', 'v', '-out', crt], { stdio: 'pipe' });
  return { crt, key };
}

function verifies(crt, untrusted) {
  try {
    execFileSync('openssl', ['verify', '-CAfile', ca('ca.crt'), ...(untrusted ? ['-untrusted', untrusted] : []), crt], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

test('the generated server certificate verifies and keys are private', () => {
  assert.ok(verifies(ca('server.crt')));
  for (const f of ['ca.key', 'server.key']) assert.equal(statSync(ca(f)).mode & 0o777, 0o600, f);
  assert.equal(statSync(info.dir).mode & 0o777, 0o700);
});

test('names and addresses this Mac may use are accepted', () => {
  for (const san of ['IP:192.168.50.99', 'IP:127.0.0.1', 'DNS:localhost', 'DNS:test-mac.local']) {
    assert.ok(verifies(sign({ san }).crt), san);
  }
});

test('anything else is refused, even though the CA key signed it', () => {
  for (const san of [
    'IP:192.168.51.1', // neighbouring subnet
    'IP:8.8.8.8',
    'IP:10.0.0.1',
    'DNS:example.com',
    'DNS:other-mac.local',
    'DNS:test-mac.local.example.com',
    'DNS:localhost,DNS:example.com', // one bad name taints the certificate
  ]) {
    assert.equal(verifies(sign({ san }).crt), false, san);
  }
});

test('a sub-CA signed with the CA key is still bound by the name constraints', () => {
  // Whether the CA's pathlen:0 itself is enforced depends on the verifier
  // (LibreSSL does not enforce it on a trust anchor); the name constraints
  // are what actually bound the damage, through the whole chain.
  const sub = sign({ isCa: true });
  assert.equal(verifies(sign({ san: 'DNS:example.com', issuer: sub }).crt, sub.crt), false);
  assert.equal(verifies(sign({ san: 'IP:8.8.8.8', issuer: sub }).crt, sub.crt), false);
});
