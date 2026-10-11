/**
 * Capture-chain evaluation page (bench/capture-eval.mjs).
 *
 * Unlike ns-page.ts, the microphone here is a real getUserMedia track: the
 * browser is launched with a file as its fake capture device, so the file goes
 * through the browser's own capture processing (echo cancellation, noise
 * suppression, gain control) exactly as a real microphone's samples would.
 * What it cannot reproduce: the microphone itself, the room, the loudspeaker.
 *
 * One recorder, three channels read in the same render quanta:
 *   0 tap       the getUserMedia track (after browser processing, before any
 *               suppressor of ours or Krisp)
 *   1 sent      the track actually published (after the suppressor, if any)
 *   2 received  the remote track at a second participant in the same page
 * Their offsets split the latency exactly into suppressor and network/engine
 * shares.
 */
import { VoiceClient } from '@voxonow/voice-client';
import { Room, RoomEvent, Track, createLocalAudioTrack, type LocalAudioTrack, type RemoteTrack } from 'livekit-client';
import { openContext, processTrack, type NsKind } from '../../demo/src/noise.js';

export interface RunOptions {
  engine: 'ours' | 'livekit';
  /** getUserMedia audio constraints, as the app under test would pass them. */
  constraints: MediaTrackConstraints & { voiceIsolation?: boolean };
  /** Our engine only: the demo's suppressor after browser processing. */
  method?: NsKind;
  /** LiveKit only: attach Krisp the way team-comms does (after publishing). */
  krisp?: boolean;
  /** Where the separately built Krisp bundle is served (bench/src/capture-krisp.ts); required with `krisp`. */
  krispModule?: string;
  url: string;
  /** Ours: [publisher, subscriber] tickets. LiveKit: [publisher, subscriber] tokens. */
  credentials: [string, string];
  /** How long to record from the moment the capture opens (the file starts playing then). */
  recordS: number;
}

function toBase64(x: Float32Array): string {
  const bytes = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The two exports capture-krisp.ts re-exports (typed here: the package is not a dependency of this repo). */
interface KrispModule {
  KrispNoiseFilter(): Parameters<LocalAudioTrack['setProcessor']>[0] & { isEnabled(): boolean };
  isKrispNoiseFilterSupported(): boolean;
}

const recorder = `
class Rec3 extends AudioWorkletProcessor {
  process(inputs) { const i = inputs[0]; if (i && i.length >= 3) this.port.postMessage([i[0].slice(), i[1].slice(), i[2].slice()]); return true; }
}
registerProcessor('rec3', Rec3);`;

/** Receiver-side counters that tell gaps apart from steady loss. */
function inboundAudio(report: RTCStatsReport | undefined) {
  let found: Record<string, number> | undefined;
  report?.forEach((r) => {
    if (r.type !== 'inbound-rtp' || r.kind !== 'audio') return;
    found = {
      packetsReceived: r.packetsReceived ?? 0,
      packetsLost: r.packetsLost ?? 0,
      totalSamplesReceived: r.totalSamplesReceived ?? 0,
      concealedSamples: r.concealedSamples ?? 0,
      silentConcealedSamples: r.silentConcealedSamples ?? 0,
      concealmentEvents: r.concealmentEvents ?? 0,
      insertedSamplesForDeceleration: r.insertedSamplesForDeceleration ?? 0,
      removedSamplesForAcceleration: r.removedSamplesForAcceleration ?? 0,
      jitterBufferDelay: r.jitterBufferDelay ?? 0,
      jitterBufferEmittedCount: r.jitterBufferEmittedCount ?? 0,
      fecPacketsReceived: r.fecPacketsReceived ?? 0,
    };
  });
  return found;
}

export async function run(o: RunOptions) {
  const startedAt = performance.now();
  const notes: string[] = [];
  let tap: MediaStreamTrack;
  let sent: MediaStreamTrack;
  let received: MediaStreamTrack;
  let stats: () => Promise<{ inbound?: Record<string, number>; targetBitrate?: number }>;
  let cleanup: () => Promise<void>;
  let nsCtx: AudioContext | undefined;
  let krispEnabled: boolean | undefined;
  let krispProcessor: { isEnabled(): boolean } | undefined;

  if (o.engine === 'ours') {
    // Opened before any await, as the demo does from the click.
    nsCtx = o.method ? openContext(o.method) : undefined;
    tap = (await navigator.mediaDevices.getUserMedia({ audio: o.constraints })).getAudioTracks()[0]!;
    sent = o.method && nsCtx ? await processTrack(nsCtx, tap, o.method) : tap;
    const publisher = new VoiceClient({ url: o.url });
    const subscriber = new VoiceClient({ url: o.url });
    const remote = new Promise<MediaStreamTrack>((resolve) => subscriber.on('trackSubscribed', (t) => t.kind === 'audio' && resolve(t.track)));
    await subscriber.join(o.credentials[1]);
    await publisher.join(o.credentials[0]);
    await publisher.publish(sent, 'microphone');
    received = await remote;
    stats = async () => {
      const [pub, sub] = [await publisher.getStats(), await subscriber.getStats()];
      let targetBitrate: number | undefined;
      pub.send?.forEach((r) => r.type === 'outbound-rtp' && r.kind === 'audio' && (targetBitrate = r.targetBitrate));
      return { inbound: inboundAudio(sub.recv), targetBitrate };
    };
    cleanup = async () => {
      await publisher.leave();
      await subscriber.leave();
      await nsCtx?.close();
    };
  } else {
    // LiveKit's own capture: its defaults are merged into these constraints
    // (adds voiceIsolation: true), as in team-comms.
    const local: LocalAudioTrack = await createLocalAudioTrack(o.constraints);
    tap = local.mediaStreamTrack;
    const pubRoom = new Room();
    const subRoom = new Room();
    const remote = new Promise<MediaStreamTrack>((resolve) =>
      subRoom.on(RoomEvent.TrackSubscribed, (t: RemoteTrack) => t.kind === Track.Kind.Audio && resolve(t.mediaStreamTrack)),
    );
    await subRoom.connect(o.url, o.credentials[1]);
    await pubRoom.connect(o.url, o.credentials[0]);
    await pubRoom.localParticipant.publishTrack(local, { source: Track.Source.Microphone });
    if (o.krisp) {
      // Same call as team-comms' apply-ai-noise-cancellation.tsx, from the
      // separately built bundle. Missing or unsupported Krisp fails the run:
      // it must never quietly become a run without Krisp.
      if (!o.krispModule) throw new Error('krisp chain without a Krisp bundle');
      const { KrispNoiseFilter, isKrispNoiseFilterSupported }: KrispModule = await import(o.krispModule);
      if (!isKrispNoiseFilterSupported()) throw new Error('krisp: not supported in this browser');
      const processor = KrispNoiseFilter();
      await local.setProcessor(processor);
      // Enablement is decided after publishing; give it a moment. On LiveKit
      // Cloud this early reading was false in some runs whose audio was
      // clearly processed, so it is read again when the recording ends.
      await new Promise((r) => setTimeout(r, 2000));
      krispEnabled = processor.isEnabled();
      krispProcessor = processor;
    }
    sent = local.mediaStreamTrack; // the processed track once a processor is attached
    received = await remote;
    stats = async () => {
      let inbound: Record<string, number> | undefined;
      for (const p of subRoom.remoteParticipants.values()) {
        for (const pub of p.audioTrackPublications.values()) inbound ??= inboundAudio(await pub.track?.getRTCStatsReport());
      }
      let targetBitrate: number | undefined;
      (await local.getRTCStatsReport())?.forEach((r) => r.type === 'outbound-rtp' && r.kind === 'audio' && (targetBitrate = r.targetBitrate));
      return { inbound, targetBitrate };
    };
    cleanup = async () => {
      await pubRoom.disconnect();
      await subRoom.disconnect();
    };
  }
  const settings = tap.getSettings();

  // Chrome only pulls remote WebRTC audio that an element is playing.
  const sink = new Audio();
  sink.muted = true;
  sink.srcObject = new MediaStream([received]);
  await sink.play().catch(() => notes.push('sink: play() rejected'));

  const ac = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await ac.resume();
  await ac.audioWorklet.addModule(URL.createObjectURL(new Blob([recorder], { type: 'text/javascript' })));
  const rec = new AudioWorkletNode(ac, 'rec3', { channelCount: 3, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
  const chunks: [Float32Array, Float32Array, Float32Array][] = [];
  rec.port.onmessage = (e) => chunks.push(e.data);
  const merger = new ChannelMergerNode(ac, { numberOfInputs: 3 });
  [tap, sent, received].forEach((t, i) => ac.createMediaStreamSource(new MediaStream([t])).connect(merger, 0, i));
  merger.connect(rec);
  const setupMs = performance.now() - startedAt;
  await new Promise((r) => setTimeout(r, Math.max(1000, o.recordS * 1000 - setupMs)));

  const s = await stats();
  const krispEnabledAtEnd = krispProcessor?.isEnabled();
  rec.port.onmessage = null;
  await cleanup();
  tap.stop();
  await ac.close();
  const n = chunks.length * 128;
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  chunks.forEach((c, i) => c.forEach((x, k) => ch[k]!.set(x, i * 128)));
  return {
    tap: toBase64(ch[0]!),
    sent: toBase64(ch[1]!),
    received: toBase64(ch[2]!),
    setupMs,
    settings: {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      voiceIsolation: (settings as { voiceIsolation?: boolean }).voiceIsolation,
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount,
    },
    krispEnabled,
    krispEnabledAtEnd,
    notes,
    ...s,
  };
}

Object.assign(window, { captureEval: { run } });
