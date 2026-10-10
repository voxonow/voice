import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
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

// Noise-suppression worklets and models, loaded only with ?ns=… (src/noise.ts).
const nsw = dirname(createRequire(import.meta.url).resolve('@sapphi-red/web-noise-suppressor'));
const out = join(root, 'dist/nsw');
mkdirSync(out, { recursive: true });
for (const [from, to] of [
  ['rnnoise/workletProcessor.js', 'rnnoise.js'],
  ['rnnoise.wasm', 'rnnoise.wasm'],
  ['rnnoise_simd.wasm', 'rnnoise_simd.wasm'],
  ['gtcrn/workletProcessor.js', 'gtcrn.js'],
  ['gtcrn.wasm', 'gtcrn.wasm'],
]) {
  copyFileSync(join(nsw, from), join(out, to));
}
copyFileSync(join(root, 'src/band-merge-worklet.js'), join(out, 'band-merge.js'));
