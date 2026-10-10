/**
 * Codec A/B page (bench/codec-ab.mjs): plays one WAV through Web Audio as the
 * microphone, sends it through our engine at a given Opus bitrate, and records
 * what a second participant in the same page receives.
 *
 * The source is Web Audio, not getUserMedia, so echo cancellation, noise
 * suppression and gain control never touch it: only the codec and the
 * transport differ between runs.
 */
import { VoiceClient } from '@voxonow/voice-client';

const RATE = 48000;

const recorder = `
class Rec extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice()); return true; }
}
registerProcessor('rec', Rec);`;

function toBase64(x: Float32Array): string {
  const bytes = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function sendAndRecord(
  voiceUrl: string,
  tickets: [string, string],
  wavUrl: string,
  audioMaxBitrate?: number,
) {
  const ac = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
  await ac.resume();
  const buffer = await ac.decodeAudioData(await (await fetch(wavUrl)).arrayBuffer());
  const out = new MediaStreamAudioDestinationNode(ac, { channelCount: 1 });

  const publisher = new VoiceClient({ url: voiceUrl, audioMaxBitrate });
  const subscriber = new VoiceClient({ url: voiceUrl });
  const received = new Promise<MediaStreamTrack>((resolve) =>
    subscriber.on('trackSubscribed', (t) => t.kind === 'audio' && resolve(t.track)),
  );
  await subscriber.join(tickets[1]);
  await publisher.join(tickets[0]);
  await publisher.publish(out.stream.getAudioTracks()[0]!, 'microphone');
  const track = await received;

  // Chrome feeds a remote track into Web Audio only while a media element
  // consumes it.
  const sink = new Audio();
  sink.muted = true;
  sink.srcObject = new MediaStream([track]);
  await sink.play().catch(() => {});
  await ac.audioWorklet.addModule(URL.createObjectURL(new Blob([recorder], { type: 'text/javascript' })));
  const rec = new AudioWorkletNode(ac, 'rec');
  const chunks: Float32Array[] = [];
  rec.port.onmessage = (e) => chunks.push(e.data as Float32Array);
  ac.createMediaStreamSource(new MediaStream([track])).connect(rec);

  // Let ICE/DTLS and the jitter buffer settle, then play the file once.
  await new Promise((r) => setTimeout(r, 1500));
  const source = new AudioBufferSourceNode(ac, { buffer });
  source.connect(out);
  source.start();
  await new Promise((r) => setTimeout(r, (buffer.duration + 1.5) * 1000));

  const stats = { targetBitrate: undefined as number | undefined, bytesSent: 0, packetsSent: 0, inserted: 0, removed: 0, concealed: 0, samples: 0, lost: 0 };
  (await publisher.getStats()).send?.forEach((r) => {
    if (r.type === 'outbound-rtp' && r.kind === 'audio') Object.assign(stats, { targetBitrate: r.targetBitrate, bytesSent: r.bytesSent, packetsSent: r.packetsSent });
  });
  (await subscriber.getStats()).recv?.forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'audio') {
      Object.assign(stats, {
        inserted: r.insertedSamplesForDeceleration ?? 0,
        removed: r.removedSamplesForAcceleration ?? 0,
        concealed: r.concealedSamples ?? 0,
        samples: r.totalSamplesReceived ?? 0,
        lost: r.packetsLost ?? 0,
      });
    }
  });
  await publisher.leave();
  await subscriber.leave();
  await ac.close();

  const recorded = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) (recorded.set(c, o), (o += c.length));
  return { samples: toBase64(recorded), durationS: buffer.duration, stats };
}

Object.assign(window, { codecAB: { sendAndRecord } });
