// Certificates for testing the demo from phones and other computers on the
// local network (npm run dev:lan).
//
//   node scripts/lan-cert.mjs          create what is missing
//   node scripts/lan-cert.mjs --force  start over (new CA: re-install on devices)
//
// Creates, in .dev-keys/lan/ (gitignored):
//   ca.key / ca.crt / ca.cer   a development CA, valid 30 days, that can ONLY
//                              issue certificates for this Mac's LAN subnet,
//                              its .local name, and localhost (X.509 name
//                              constraints). Even if ca.key leaked, it could
//                              not impersonate any other site.
//   server.key / server.crt    this Mac's certificate, signed by that CA.
//
// Devices trust ca.cer once (see docs/LAN-TEST.md); nothing is installed on
// this Mac by this script.
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LAN_DIR = join(root, '.dev-keys', 'lan');
const DAYS = 30;

/** Every non-internal IPv4 interface with its subnet. */
export function lanInterfaces() {
  const out = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

export function localHostName() {
  try {
    return execFileSync('scutil', ['--get', 'LocalHostName']).toString().trim();
  } catch {
    return hostname().split('.')[0];
  }
}

function networkOf(address, netmask) {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((part, i) => part & m[i]).join('.');
}

function openssl(args, input) {
  return execFileSync('openssl', args, { input, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * @param {{ force?: boolean, dir?: string, interfaces?: {address: string, netmask: string}[], name?: string }} [options]
 *   dir / interfaces / name override the defaults (tests use a temp dir).
 */
export function ensureLanCerts({ force = false, dir = LAN_DIR, interfaces = lanInterfaces(), name = localHostName() } = {}) {
  if (!interfaces.length) throw new Error('no LAN interface found');
  const subnets = [...new Map(interfaces.map((i) => [`${networkOf(i.address, i.netmask)}/${i.netmask}`, i])).keys()];

  if (force) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = (file) => join(dir, file);

  if (!existsSync(p('ca.crt'))) {
    const constraints = [
      ...subnets.map((s) => `permitted;IP:${s}`),
      'permitted;IP:127.0.0.1/255.255.255.255',
      `permitted;DNS:${name}.local`,
      'permitted;DNS:localhost',
    ].join(',');
    writeFileSync(
      p('ca.cnf'),
      [
        '[req]',
        'distinguished_name = dn',
        'prompt = no',
        '[dn]',
        `CN = Voxonow Voice DEV CA (${name}, LAN only)`,
        '[v3_ca]',
        'basicConstraints = critical,CA:TRUE,pathlen:0',
        'keyUsage = critical,keyCertSign,cRLSign',
        'subjectKeyIdentifier = hash',
        `nameConstraints = critical,${constraints}`,
        '',
      ].join('\n'),
    );
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('ca.key')]);
    openssl(['req', '-x509', '-new', '-key', p('ca.key'), '-sha256', '-days', String(DAYS), '-config', p('ca.cnf'), '-extensions', 'v3_ca', '-out', p('ca.crt')]);
    // DER copy: what iOS / Android offer to install when downloaded.
    openssl(['x509', '-in', p('ca.crt'), '-outform', 'DER', '-out', p('ca.cer')]);
    rmSync(p('server.crt'), { force: true });
  }

  // The server certificate is reissued whenever the LAN addresses change.
  const wanted = [...interfaces.map((i) => `IP Address:${i.address}`), 'IP Address:127.0.0.1', `DNS:${name}.local`, 'DNS:localhost'];
  if (existsSync(p('server.crt'))) {
    const san = new X509Certificate(readFileSync(p('server.crt'))).subjectAltName ?? '';
    if (!wanted.every((entry) => san.includes(entry))) rmSync(p('server.crt'));
  }
  if (!existsSync(p('server.crt'))) {
    const san = [...interfaces.map((i) => `IP:${i.address}`), 'IP:127.0.0.1', `DNS:${name}.local`, 'DNS:localhost'].join(',');
    writeFileSync(
      p('server.cnf'),
      [
        '[req]',
        'distinguished_name = dn',
        'prompt = no',
        '[dn]',
        `CN = ${name}.local`,
        '[v3_server]',
        'basicConstraints = critical,CA:FALSE',
        'keyUsage = critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage = serverAuth',
        `subjectAltName = ${san}`,
        '',
      ].join('\n'),
    );
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('server.key')]);
    openssl(['req', '-new', '-key', p('server.key'), '-config', p('server.cnf'), '-out', p('server.csr')]);
    openssl([
      // Explicit serial file: LibreSSL otherwise drops a ".srl" in the cwd.
      'x509', '-req', '-in', p('server.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial', '-CAserial', p('ca.srl'),
      '-days', String(DAYS), '-sha256', '-extfile', p('server.cnf'), '-extensions', 'v3_server', '-out', p('server.crt'),
    ]);
    rmSync(p('server.csr'));
  }
  for (const file of ['ca.key', 'server.key']) execFileSync('chmod', ['600', p(file)]);

  const ca = new X509Certificate(readFileSync(p('ca.crt')));
  return {
    dir,
    name,
    interfaces,
    subnets,
    caFingerprint: ca.fingerprint256,
    caValidTo: ca.validTo,
    caSha256: createHash('sha256').update(ca.raw).digest('hex'),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const info = ensureLanCerts({ force: process.argv.includes('--force') });
  console.log(`LAN certificates in ${info.dir}`);
  console.log(`  host: ${info.name}.local, ${info.interfaces.map((i) => i.address).join(', ')}`);
  console.log(`  CA limited to: ${info.subnets.join(', ')}, 127.0.0.1, ${info.name}.local, localhost`);
  console.log(`  CA SHA-256 fingerprint: ${info.caFingerprint}`);
  console.log(`  CA valid until: ${info.caValidTo}`);
}
