/**
 * Optional noise suppression for the demo microphone (M6 live trial).
 * Off unless the page is opened with ?ns=…; without it nothing here runs and
 * the microphone track is published exactly as before.
 *
 * Runs after the browser's own capture processing (echo cancellation, noise
 * suppression, gain control from getUserMedia) and before publishing — where
 * Krisp sits in today's Voxonow.
 *
 *   rnnoise      RNNoise at 48 kHz (full band)
 *   gtcrn        GTCRN in its native 16 kHz context: output ends near 8 kHz
 *                by design (resampling cannot restore what the model drops)
 *   gtcrn-split  GTCRN below 8 kHz + the original 8–20 kHz band, attenuated by
 *                GTCRN's own low-band gain (band-merge-worklet.js) — our own
 *                composition, not an upstream feature
 *
 * The same graph builder serves the live demo and the offline benchmark, so
 * both measure the same code.
 */
import { GtcrnWorkletNode, RnnoiseWorkletNode, loadGtcrn, loadRnnoise } from '@sapphi-red/web-noise-suppressor';

export const NS_KINDS = ['rnnoise', 'gtcrn', 'gtcrn-split'] as const;
export type NsKind = (typeof NS_KINDS)[number];

/** GTCRN's latency on its 48 kHz path, in samples (measured 2026-10-10). */
export const GTCRN_48K_DELAY_SAMPLES = 1530;

export function parseNs(value: string | null): NsKind | undefined {
  return (NS_KINDS as readonly string[]).includes(value ?? '') ? (value as NsKind) : undefined;
}

/** The sample rate each method's graph runs at. */
export const contextRate = (kind: NsKind): number => (kind === 'gtcrn' ? 16000 : 48000);

/**
 * Builds the processing graph on `ctx` after `source`; returns the node whose
 * output is the processed signal. Works on AudioContext and OfflineAudioContext.
 */
export async function buildGraph(ctx: BaseAudioContext, input: AudioNode, kind: NsKind, base = '/nsw/'): Promise<AudioNode> {
  // Everything below runs on exactly one channel. A MediaStreamSource presents
  // even a mono track as two channels, and the suppressors (maxChannels: 1)
  // then leave the second one silent — the mono downmix of the result halved
  // the level (−6 dB, found by bench/ns-eval.mjs). Take channel 0 explicitly.
  const source = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
  input.connect(source);
  const mono = <T extends AudioNode>(node: T): T => {
    node.channelCount = 1;
    node.channelCountMode = 'explicit';
    node.channelInterpretation = 'discrete';
    return node;
  };
  switch (kind) {
    case 'rnnoise': {
      await ctx.audioWorklet.addModule(`${base}rnnoise.js`);
      const wasmBinary = await loadRnnoise({ url: `${base}rnnoise.wasm`, simdUrl: `${base}rnnoise_simd.wasm` });
      const node = mono(new RnnoiseWorkletNode(ctx as AudioContext, { wasmBinary, maxChannels: 1 }));
      source.connect(node);
      return node;
    }
    case 'gtcrn': {
      if (ctx.sampleRate !== 16000) throw new Error('gtcrn runs in a 16 kHz context');
      await ctx.audioWorklet.addModule(`${base}gtcrn.js`);
      const wasmBinary = await loadGtcrn({ url: `${base}gtcrn.wasm` });
      const node = mono(new GtcrnWorkletNode(ctx as AudioContext, { wasmBinary, maxChannels: 1 }));
      source.connect(node);
      return node;
    }
    case 'gtcrn-split': {
      if (ctx.sampleRate !== 48000) throw new Error('gtcrn-split runs in a 48 kHz context');
      await ctx.audioWorklet.addModule(`${base}gtcrn.js`);
      await ctx.audioWorklet.addModule(`${base}band-merge.js`);
      const wasmBinary = await loadGtcrn({ url: `${base}gtcrn.wasm` });
      const model = mono(new GtcrnWorkletNode(ctx as AudioContext, { wasmBinary, maxChannels: 1 }));
      const merge = new AudioWorkletNode(ctx, 'voxonow-band-merge', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
        processorOptions: { delay: GTCRN_48K_DELAY_SAMPLES },
      });
      source.connect(model);
      source.connect(merge, 0, 0);
      model.connect(merge, 0, 1);
      return merge;
    }
  }
}

/**
 * Opens the AudioContext for `kind`. Call it synchronously from the user's
 * click (before any await) so the browser lets it start.
 */
export function openContext(kind: NsKind): AudioContext {
  const ctx = new AudioContext({ sampleRate: contextRate(kind), latencyHint: 'interactive' });
  void ctx.resume();
  return ctx;
}

/** Live: microphone track in, processed track out. */
export async function processTrack(ctx: AudioContext, input: MediaStreamTrack, kind: NsKind, base = '/nsw/') {
  const source = ctx.createMediaStreamSource(new MediaStream([input]));
  const output = await buildGraph(ctx, source, kind, base);
  // Mono from construction: setting channelCount afterwards leaves Chrome's
  // track stereo with a silent second channel, and the mono Opus downmix then
  // halves the level (−6 dB, found by bench/ns-eval.mjs).
  const destination = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });
  output.connect(destination);
  await ctx.resume();
  return destination.stream.getAudioTracks()[0]!;
}
