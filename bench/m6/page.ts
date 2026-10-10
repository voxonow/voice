/**
 * Runs inside headless Chromium for the M6 benchmark.
 *
 * - processOffline: a noisy file through one candidate suppressor, rendered as
 *   fast as possible (OfflineAudioContext / direct frame calls); render time
 *   gives the CPU cost as a real-time factor.
 * - captureMic: records what getUserMedia delivers, so Chrome's own WebRTC
 *   noise suppression can be measured on a file fed in as a fake microphone.
 */
import {
  GtcrnWorkletNode,
  RnnoiseWorkletNode,
  SpeexWorkletNode,
  loadGtcrn,
  loadRnnoise,
  loadSpeex,
} from '@sapphi-red/web-noise-suppressor';
import { DeepFilter } from '@lofcz/deepfilternet-web';

const RATE = 48000;

function toBase64(x: Float32Array): string {
  const bytes = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function load(url: string): Promise<Float32Array> {
  const data = await (await fetch(url)).arrayBuffer();
  const buffer = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(data);
  return buffer.getChannelData(0).slice();
}

type Kind = 'none' | 'rnnoise' | 'speex' | 'gtcrn' | 'deepfilternet3';

async function makeNode(ctx: BaseAudioContext, kind: Kind): Promise<AudioNode | undefined> {
  switch (kind) {
    case 'none':
      return undefined;
    case 'rnnoise': {
      await ctx.audioWorklet.addModule('/nsw/rnnoise.js');
      const wasmBinary = await loadRnnoise({ url: '/nsw/rnnoise.wasm', simdUrl: '/nsw/rnnoise_simd.wasm' });
      return new RnnoiseWorkletNode(ctx as AudioContext, { wasmBinary, maxChannels: 1 });
    }
    case 'speex': {
      await ctx.audioWorklet.addModule('/nsw/speex.js');
      const wasmBinary = await loadSpeex({ url: '/nsw/speex.wasm' });
      return new SpeexWorkletNode(ctx as AudioContext, { wasmBinary, maxChannels: 1 });
    }
    case 'gtcrn': {
      await ctx.audioWorklet.addModule('/nsw/gtcrn.js');
      const wasmBinary = await loadGtcrn({ url: '/nsw/gtcrn.wasm' });
      return new GtcrnWorkletNode(ctx as AudioContext, { wasmBinary, maxChannels: 1 });
    }
    default:
      throw new Error(`no worklet for ${kind}`);
  }
}

export async function processOffline(url: string, kind: Kind): Promise<{ samples: string; renderMs: number }> {
  const input = await load(url);
  if (kind === 'deepfilternet3') {
    const df = await DeepFilter.create({ wasmUrl: '/dfn/df_bg.wasm' });
    const out = new Float32Array(input.length);
    const frame = new Float32Array(df.frameLength);
    const start = performance.now();
    for (let i = 0; i + df.frameLength <= input.length; i += df.frameLength) {
      frame.set(input.subarray(i, i + df.frameLength));
      out.set(df.process(frame), i);
    }
    const renderMs = performance.now() - start;
    df.destroy();
    return { samples: toBase64(out), renderMs };
  }
  const ctx = new OfflineAudioContext(1, input.length, RATE);
  const node = await makeNode(ctx, kind);
  const buffer = ctx.createBuffer(1, input.length, RATE);
  buffer.copyToChannel(input, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  if (node) source.connect(node).connect(ctx.destination);
  else source.connect(ctx.destination);
  source.start();
  // The suppressors instantiate their wasm asynchronously inside the worklet;
  // an offline render never yields, so pause after the first render quantum
  // and give them time to get ready. Only the rest is timed.
  let start = 0;
  void ctx.suspend(128 / RATE).then(async () => {
    await new Promise((r) => setTimeout(r, 500));
    start = performance.now();
    await ctx.resume();
  });
  const rendered = await ctx.startRendering();
  const renderMs = performance.now() - start;
  return { samples: toBase64(rendered.getChannelData(0)), renderMs };
}

/**
 * Records the fake microphone twice at once — suppression off and on — as the
 * two channels of ONE recorder, so both are read in the same render quanta and
 * share a timeline exactly; the latency difference is then meaningful.
 */
export async function captureMicPair(seconds: number) {
  const streams = [];
  for (const noiseSuppression of [false, true]) {
    streams.push(
      await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression, echoCancellation: false, autoGainControl: false, channelCount: 1 },
      }),
    );
  }
  const ctx = new AudioContext({ sampleRate: RATE });
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([pairRecorder], { type: 'text/javascript' })));
  const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  streams.forEach((stream, i) => ctx.createMediaStreamSource(stream).connect(merger, 0, i));
  const node = new AudioWorkletNode(ctx, 'rec2', { channelCount: 2, channelCountMode: 'explicit' });
  const chunks: [Float32Array, Float32Array][] = [];
  node.port.onmessage = (e) => chunks.push(e.data);
  merger.connect(node);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const settings = streams.map((s) => s.getAudioTracks()[0]!.getSettings().noiseSuppression);
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  await ctx.close();
  return [0, 1].map((ch) => {
    const out = new Float32Array(chunks.length * 128);
    chunks.forEach((c, i) => out.set(c[ch]!, i * 128));
    return { samples: toBase64(out), noiseSuppression: settings[ch] };
  });
}

const pairRecorder = `
class Rec2 extends AudioWorkletProcessor {
  process(inputs) {
    const i = inputs[0];
    if (i && i.length >= 2) this.port.postMessage([i[0].slice(), i[1].slice()]);
    return true;
  }
}
registerProcessor('rec2', Rec2);`;

Object.assign(window, { m6: { processOffline, captureMicPair } });
