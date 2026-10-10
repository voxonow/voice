import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'src/app.ts')],
  outfile: join(root, 'dist/app.js'),
  bundle: true,
  format: 'esm',
  target: ['chrome110', 'safari16', 'firefox115'],
  sourcemap: true,
  logLevel: 'warning',
});
