/**
 * Krisp for bench/capture-eval.mjs, bundled on its own and only when a Krisp
 * chain is selected: the package is not a dependency of this repo (it is the
 * build team-comms ships, resolved by capture-eval at bundle time), so the
 * capture page must build and run without it.
 */
// @ts-expect-error resolved by capture-eval's esbuild alias, not by this repo's node_modules
export { KrispNoiseFilter, isKrispNoiseFilterSupported } from '@livekit/krisp-noise-filter';
