import { VoiceClient, type RemoteTrack, type Source } from '@voxonow/voice-client';

/** Quality numbers read from WebRTC stats; what M1's acceptance criteria measure. */
export interface DemoStats {
  /** Audio packets received, summed over every subscribed audio track. */
  audioPacketsReceived: number;
  audioPacketsLost: number;
  /** Seconds, worst over subscribed audio tracks. */
  audioJitter: number;
  /** Share of received audio samples that had to be concealed (0–1). */
  audioConcealedRatio: number;
  audioPacketsSent: number;
  /** Seconds, from the selected candidate pair of the send transport. */
  roundTripTime?: number;
  subscribedTracks: number;
  participants: string[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let client: VoiceClient | undefined;
let micTrack: MediaStreamTrack | undefined;

async function fetchTicket(room: string, name: string, publish?: Source[]) {
  const response = await fetch('/api/ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room, name, publish }),
  });
  if (!response.ok) throw new Error(`ticket request failed: ${response.status}`);
  return (await response.json()) as { ticket: string; voiceUrl: string };
}

function log(message: string): void {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  $('log').prepend(line);
}

function renderParticipants(): void {
  const list = $('participants');
  list.replaceChildren();
  for (const participant of client?.participants.values() ?? []) {
    const item = document.createElement('li');
    item.textContent = participant.name;
    list.append(item);
  }
}

function attach(track: RemoteTrack): void {
  const element = document.createElement(track.kind === 'audio' ? 'audio' : 'video') as HTMLMediaElement;
  element.id = `track-${track.id}`;
  element.autoplay = true;
  element.setAttribute('playsinline', '');
  element.srcObject = new MediaStream([track.track]);
  $('media').append(element);
}

function detach(track: RemoteTrack): void {
  document.getElementById(`track-${track.id}`)?.remove();
}

async function join(room: string, name: string, options: { publish?: Source[]; microphone?: boolean } = {}) {
  if (client) throw new Error('already joined');
  const { ticket, voiceUrl } = await fetchTicket(room, name, options.publish);
  const next = new VoiceClient({ url: voiceUrl });
  client = next;
  next.on('participantJoined', (p) => {
    log(`${p.name} katıldı`);
    renderParticipants();
  });
  next.on('participantLeft', (p) => {
    log(`${p.name} ayrıldı`);
    renderParticipants();
  });
  next.on('mediaStateChanged', ({ direction, state }) => {
    const label = direction === 'send' ? 'gönderme' : 'alma';
    log(state === 'failed' ? `HATA: ${label} yolu kurulamadı (medya akmıyor)` : `${label} bağlantısı: ${state}`);
  });
  next.on('trackSubscribed', attach);
  next.on('trackUnsubscribed', detach);
  next.on('disconnected', ({ code, reason }) => {
    log(`bağlantı kapandı (${code} ${reason})`);
    if (client === next) client = undefined;
    micTrack?.stop();
    micTrack = undefined;
    $('media').replaceChildren();
    renderParticipants();
    setJoined(false);
  });

  await next.join(ticket);
  log(`odaya girildi: ${room}`);
  if (options.microphone !== false) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micTrack = stream.getAudioTracks()[0]!;
    await next.publish(micTrack, 'microphone');
    log('mikrofon yayında');
  }
  renderParticipants();
  setJoined(true);
}

async function leave(): Promise<void> {
  await client?.leave();
}

async function stats(): Promise<DemoStats> {
  const result: DemoStats = {
    audioPacketsReceived: 0,
    audioPacketsLost: 0,
    audioJitter: 0,
    audioConcealedRatio: 0,
    audioPacketsSent: 0,
    subscribedTracks: client?.tracks.size ?? 0,
    participants: [...(client?.participants.values() ?? [])].map((p) => p.name),
  };
  if (!client) return result;
  const { send, recv } = await client.getStats();
  let samples = 0;
  let concealed = 0;
  recv?.forEach((report) => {
    if (report.type === 'inbound-rtp' && report.kind === 'audio') {
      result.audioPacketsReceived += report.packetsReceived ?? 0;
      result.audioPacketsLost += report.packetsLost ?? 0;
      result.audioJitter = Math.max(result.audioJitter, report.jitter ?? 0);
      samples += report.totalSamplesReceived ?? 0;
      concealed += report.concealedSamples ?? 0;
    }
  });
  result.audioConcealedRatio = samples > 0 ? concealed / samples : 0;
  send?.forEach((report) => {
    if (report.type === 'outbound-rtp' && report.kind === 'audio') result.audioPacketsSent += report.packetsSent ?? 0;
    if (report.type === 'candidate-pair' && report.nominated && report.currentRoundTripTime !== undefined) {
      result.roundTripTime = report.currentRoundTripTime;
    }
  });
  return result;
}

function setJoined(joined: boolean): void {
  $<HTMLButtonElement>('join').disabled = joined;
  $<HTMLButtonElement>('leave').disabled = !joined;
  $<HTMLButtonElement>('mute').disabled = !joined || !micTrack;
  $<HTMLButtonElement>('mute').textContent = 'Sustur';
}

$('join').addEventListener('click', () => {
  const room = $<HTMLInputElement>('room').value.trim();
  const name = $<HTMLInputElement>('name').value.trim() || 'Misafir';
  join(room, name).catch((error: Error) => {
    log(`hata: ${error.message}`);
    client = undefined;
    setJoined(false);
  });
});
$('leave').addEventListener('click', () => void leave());
$('mute').addEventListener('click', async () => {
  if (!client || !micTrack) return;
  const muted = $('mute').textContent === 'Sustur';
  await client.setMuted('microphone', muted);
  $('mute').textContent = muted ? 'Sesi aç' : 'Sustur';
});

setInterval(async () => {
  if (!client) return;
  const s = await stats();
  $('stats').textContent = [
    `RTT: ${s.roundTripTime !== undefined ? Math.round(s.roundTripTime * 1000) + ' ms' : '–'}`,
    `alınan ses paketi: ${s.audioPacketsReceived}`,
    `kayıp: ${s.audioPacketsLost}`,
    `jitter: ${Math.round(s.audioJitter * 1000)} ms`,
    `gizlenen ses: %${(s.audioConcealedRatio * 100).toFixed(1)}`,
    `gönderilen ses paketi: ${s.audioPacketsSent}`,
  ].join('\n');
}, 1000);

// Driven by the end-to-end tests.
Object.assign(window, { voiceDemo: { join, leave, stats } });
