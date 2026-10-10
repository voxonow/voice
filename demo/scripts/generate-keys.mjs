// Generates a local Ed25519 key pair for development tickets.
//
// The private key plays the part of Voxonow's API (it signs tickets); the
// voice server only ever gets the public key. Both live in .dev-keys/, which
// is gitignored. Never use these keys anywhere but a developer machine.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, '.dev-keys');
const privatePath = join(dir, 'ticket-private.pem');
const publicPath = join(dir, 'ticket-public.pem');

if (existsSync(privatePath) && !process.argv.includes('--force')) {
  console.log(`Keys already exist in ${dir} (use --force to replace).`);
} else {
  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  writeFileSync(privatePath, await exportPKCS8(privateKey), { mode: 0o600 });
  writeFileSync(publicPath, await exportSPKI(publicKey));
  console.log(`Wrote ${privatePath} and ${publicPath}`);
}
