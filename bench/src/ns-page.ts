/**
 * Noise-suppression evaluation page (bench/ns-eval.mjs). Uses the demo's own
 * graph builder (demo/src/noise.ts), so the benchmark measures the code the
 * demo runs.
 *
 * - offline: one file through one method in an OfflineAudioContext at the
 *   method's own rate — exact alignment, CPU timing.
 * - live: the file played through Web Audio as a microphone, through the
 *   method (live AudioContext), published through our engine at the client's
 *   default bitrate, and recorded at a second participant.
 */
import { VoiceClient } from '@voxonow/voice-client';
import { buildGraph, contextRate, openContext, processTrack, type NsKind } from '../../demo/src/noise.js';

type Method = NsKind | 'none';

function toBase64(x: Float32Array): string {
  const bytes = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function offline(url: string, method: Method) {
  const rate = method === 'none' ? 48000 : contextRate(method);
  const data = await (await fetch(url)).arrayBuffer();
  const input = (await new OfflineAudioContext(1, 1, rate).decodeAudioData(data)).getChannelData(0);
  const ctx = new OfflineAudioContext(1, input.length, rate);
  const buffer = ctx.createBuffer(1, input.length, rate);
  buffer.copyToChannel(input, 0);
  const source = new AudioBufferSourceNode(ctx, { buffer });
  const out = method === 'none' ? source : await buildGraph(ctx, source, method);
  out.connect(ctx.destination);
  source.start();
  // The suppressors instantiate wasm asynchronously; an offline render never
  // yields, so pause after the first quantum and let them get ready.
  let start = 0;
  void ctx.suspend(128 / rate).then(async () => {
    await new Promise((r) => setTimeout(r, 500));
    start = performance.now();
    await ctx.resume();
  });
  const rendered = await ctx.startRendering();
  return { samples: toBase64(rendered.getChannelData(0)), rate, renderMs: performance.now() - start };
}

// Three channels in one recorder, read in the same render quanta: what was
// received, what was played into the "microphone", and the processed signal
// before it left (what was published). Their offsets split the end-to-end
// latency exactly into the method's share and the network/WebRTC share.
const recorder = `
class Rec3 extends AudioWorkletProcessor {
  process(inputs) { const i = inputs[0]; if (i && i.length >= 3) this.port.postMessage([i[0].slice(), i[1].slice(), i[2].slice()]); return true; }
}
registerProcessor('rec3', Rec3);`;

export async function live(voiceUrl: string, tickets: [string, string], url: string, method: Method) {
  const ac = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await ac.resume();
  const buffer = await ac.decodeAudioData(await (await fetch(url)).arrayBuffer());
  const mic = new MediaStreamAudioDestinationNode(ac, { channelCount: 1 });
  let track = mic.stream.getAudioTracks()[0]!;
  let nsCtx: AudioContext | undefined;
  if (method !== 'none') {
    nsCtx = openContext(method);
    track = await processTrack(nsCtx, track, method);
  }

  const publisher = new VoiceClient({ url: voiceUrl }); // default bitrate (48 kbps)
  const subscriber = new VoiceClient({ url: voiceUrl });
  const received = new Promise<MediaStreamTrack>((resolve) =>
    subscriber.on('trackSubscribed', (t) => t.kind === 'audio' && resolve(t.track)),
  );
  await subscriber.join(tickets[1]);
  await publisher.join(tickets[0]);
  await publisher.publish(track, 'microphone');
  const remote = await received;
  const sink = new Audio();
  sink.muted = true;
  sink.srcObject = new MediaStream([remote]);
  await sink.play().catch(() => {});
  await ac.audioWorklet.addModule(URL.createObjectURL(new Blob([recorder], { type: 'text/javascript' })));
  const rec = new AudioWorkletNode(ac, 'rec3', { channelCount: 3, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
  const chunks: [Float32Array, Float32Array, Float32Array][] = [];
  rec.port.onmessage = (e) => chunks.push(e.data);
  const merger = new ChannelMergerNode(ac, { numberOfInputs: 3 });
  ac.createMediaStreamSource(new MediaStream([remote])).connect(merger, 0, 0);
  const source = new AudioBufferSourceNode(ac, { buffer });
  source.connect(merger, 0, 1);
  ac.createMediaStreamSource(new MediaStream([track])).connect(merger, 0, 2);
  merger.connect(rec);

  await new Promise((r) => setTimeout(r, 1500));
  source.connect(mic);
  source.start();
  await new Promise((r) => setTimeout(r, (buffer.duration + 1.5) * 1000));

  let targetBitrate: number | undefined;
  (await publisher.getStats()).send?.forEach((r) => {
    if (r.type === 'outbound-rtp' && r.kind === 'audio') targetBitrate = r.targetBitrate;
  });
  await publisher.leave();
  await subscriber.leave();
  await nsCtx?.close();
  await ac.close();
  const receivedAudio = new Float32Array(chunks.length * 128), played = new Float32Array(chunks.length * 128), sent = new Float32Array(chunks.length * 128);
  chunks.forEach(([r, p, s], i) => (receivedAudio.set(r, i * 128), played.set(p, i * 128), sent.set(s, i * 128)));
  return { samples: toBase64(receivedAudio), played: toBase64(played), sent: toBase64(sent), targetBitrate };
}

Object.assign(window, { nsEval: { offline, live } });
