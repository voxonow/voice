import { VoiceClient, type RemoteTrack, type Source } from '@voxonow/voice-client';
import { openContext, parseNs, processTrack, type NsKind } from './noise.js';

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
  /** Opus encoder target (bits/s) of the microphone, as the browser reports it. */
  audioTargetBitrate?: number;
  /** Noise suppressor in the microphone path ('none' unless ?ns=…). */
  noiseSuppressor: NsKind | 'none';
  /** State of the suppressor's AudioContext ('running' when audio flows through it). */
  noiseContextState?: AudioContextState;
  /**
   * Average time received audio waits in the jitter buffer before playout
   * (seconds), worst over subscribed audio tracks. Network RTT plus this is
   * most of what a listener experiences as delay.
   */
  audioPlayoutDelay?: number;
  /** Per received audio track, keyed by the sender's display name. */
  perTrack: TrackStats[];
  subscribedTracks: number;
  participants: string[];
}

export interface TrackStats {
  from: string;
  packetsReceived: number;
  packetsLost: number;
  /** Seconds. */
  jitter: number;
  concealedRatio: number;
  /** Seconds; average jitter-buffer wait before playout, since the start. */
  playoutDelay?: number;
  /** Raw counters, so a sampler can compute the delay over an interval. */
  jitterBufferDelay: number;
  jitterBufferEmittedCount: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let client: VoiceClient | undefined;
let micTrack: MediaStreamTrack | undefined;
/** Present only with ?ns=…: the context running the noise suppressor. */
let nsContext: AudioContext | undefined;

async function fetchTicket(room: string, name: string, publish?: Source[]) {
  const response = await fetch('/api/ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room, name, publish }),
  });
  if (!response.ok) throw new Error(`ticket request failed: ${response.status}`);
  return (await response.json()) as { ticket: string; voiceUrl: string };
}

/** Short browser label for the shared dev log, e.g. "Safari 18" or "Firefox 140". */
const browserLabel = (() => {
  const ua = navigator.userAgent;
  const match =
    /Firefox\/(\d+)/.exec(ua)?.[0] ??
    /Edg\/(\d+)/.exec(ua)?.[0] ??
    /Chrome\/(\d+)/.exec(ua)?.[0] ??
    (/Version\/(\d+).*Safari/.exec(ua) ? `Safari/${/Version\/(\d+)/.exec(ua)![1]}` : 'unknown');
  return `${match.replace('/', ' ')} #${Math.random().toString(36).slice(2, 6)}`;
})();

let pendingLines: string[] = [];
function shipLog(line: string): void {
  pendingLines.push(line);
  if (pendingLines.length === 1) {
    setTimeout(() => {
      const lines = pendingLines;
      pendingLines = [];
      void fetch('/api/log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client: browserLabel, lines }),
      }).catch(() => {});
    }, 300);
  }
}

function log(message: string): void {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  $('log').prepend(line);
  shipLog(message);
}

window.addEventListener('error', (event) => log(`JS hatası: ${event.message}`));
window.addEventListener('unhandledrejection', (event) => log(`yakalanmamış hata: ${String(event.reason?.message ?? event.reason)}`));
shipLog(`sayfa açıldı: ${navigator.userAgent}`);

function renderParticipants(): void {
  const list = $('participants');
  list.replaceChildren();
  for (const participant of client?.participants.values() ?? []) {
    const item = document.createElement('li');
    item.textContent = participant.name;
    list.append(item);
  }
  const status = $('room-status');
  if (!client?.roomId) status.textContent = '';
  else if (client.participants.size === 0) {
    // The most common demo mistake: two windows with different room names.
    status.textContent = `Oda: "${client.roomId}" — odada senden başka kimse yok. Diğer pencerede de oda adının aynı olduğundan emin ol.`;
  } else status.textContent = `Oda: "${client.roomId}"`;
}

function attach(track: RemoteTrack): void {
  const element = document.createElement(track.kind === 'audio' ? 'audio' : 'video') as HTMLMediaElement;
  element.id = `track-${track.id}`;
  element.autoplay = true;
  element.setAttribute('playsinline', '');
  element.srcObject = new MediaStream([track.track]);
  $('media').append(element);
  element.play().catch(() => {
    // Autoplay blocked (Safari can do this): playback needs a click.
    log('tarayıcı sesi otomatik başlatmadı — "Sesi başlat" düğmesine bas');
    const button = $<HTMLButtonElement>('unlock-audio');
    button.hidden = false;
    button.onclick = () => {
      for (const media of document.querySelectorAll<HTMLMediaElement>('#media audio, #media video')) void media.play();
      button.hidden = true;
    };
  });
}

function detach(track: RemoteTrack): void {
  document.getElementById(`track-${track.id}`)?.remove();
}

async function join(room: string, name: string, options: { publish?: Source[]; microphone?: boolean } = {}) {
  if (client) throw new Error('already joined');
  // Demo-only M6 trial switch: ?ns=rnnoise | gtcrn | gtcrn-split. Absent =
  // the microphone track is published untouched, as before. The context is
  // opened here, before any await, while the click still counts as a gesture.
  const ns = options.microphone !== false ? parseNs(new URLSearchParams(location.search).get('ns')) : undefined;
  const ctx = ns ? openContext(ns) : undefined;
  nsContext = ctx;
  const { ticket, voiceUrl } = await fetchTicket(room, name, options.publish);
  // Demo-only comparison switch, e.g. ?audioBitrate=32000. Absent = the
  // client's default (48 kbps).
  const audioBitrate = Number(new URLSearchParams(location.search).get('audioBitrate')) || undefined;
  if (audioBitrate) log(`deneysel ses bit hızı: ${audioBitrate / 1000} kbps`);
  const next = new VoiceClient({ url: voiceUrl, audioMaxBitrate: audioBitrate });
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
    void nsContext?.close();
    nsContext = undefined;
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
    let published = micTrack;
    if (ns && ctx) {
      published = await processTrack(ctx, micTrack, ns);
      log(`gürültü bastırma: ${ns} (${ctx.sampleRate / 1000} kHz)`);
    }
    await next.publish(published, 'microphone');
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
    perTrack: [],
    noiseSuppressor: (nsContext && parseNs(new URLSearchParams(location.search).get('ns'))) || 'none',
    noiseContextState: nsContext?.state,
    subscribedTracks: client?.tracks.size ?? 0,
    participants: [...(client?.participants.values() ?? [])].map((p) => p.name),
  };
  if (!client) return result;
  const { send, recv } = await client.getStats();
  let samples = 0;
  let concealed = 0;
  const senderByTrackId = new Map<string, string>();
  for (const track of client.tracks.values()) {
    senderByTrackId.set(track.track.id, client.participants.get(track.peerId)?.name ?? track.peerId);
  }
  recv?.forEach((report) => {
    if (report.type === 'inbound-rtp' && report.kind === 'audio') {
      const trackSamples = report.totalSamplesReceived ?? 0;
      result.perTrack.push({
        from: senderByTrackId.get(report.trackIdentifier) ?? '?',
        packetsReceived: report.packetsReceived ?? 0,
        packetsLost: report.packetsLost ?? 0,
        jitter: report.jitter ?? 0,
        concealedRatio: trackSamples > 0 ? (report.concealedSamples ?? 0) / trackSamples : 0,
        playoutDelay:
          report.jitterBufferEmittedCount > 0 ? report.jitterBufferDelay / report.jitterBufferEmittedCount : undefined,
        jitterBufferDelay: report.jitterBufferDelay ?? 0,
        jitterBufferEmittedCount: report.jitterBufferEmittedCount ?? 0,
      });
      result.audioPacketsReceived += report.packetsReceived ?? 0;
      result.audioPacketsLost += report.packetsLost ?? 0;
      result.audioJitter = Math.max(result.audioJitter, report.jitter ?? 0);
      samples += report.totalSamplesReceived ?? 0;
      if (report.jitterBufferEmittedCount > 0) {
        const delay = report.jitterBufferDelay / report.jitterBufferEmittedCount;
        result.audioPlayoutDelay = Math.max(result.audioPlayoutDelay ?? 0, delay);
      }
      concealed += report.concealedSamples ?? 0;
    }
  });
  result.audioConcealedRatio = samples > 0 ? concealed / samples : 0;
  send?.forEach((report) => {
    if (report.type === 'outbound-rtp' && report.kind === 'audio') {
      result.audioPacketsSent += report.packetsSent ?? 0;
      if (report.targetBitrate) result.audioTargetBitrate = report.targetBitrate;
    }
  });
  // RTT from whichever transport has a selected pair (listen-only clients
  // have no send transport).
  for (const report of [send, recv]) {
    report?.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime !== undefined) {
        result.roundTripTime ??= r.currentRoundTripTime;
      }
    });
  }
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
  log(`katıl'a basıldı: oda="${room}" ad="${name}"`);
  const listenOnly = $<HTMLInputElement>('listen-only').checked;
  if (listenOnly) log('mikrofonsuz katılım');
  join(room, name, { microphone: !listenOnly }).catch((error: Error) => {
    log(`hata: ${error.name}: ${error.message}`);
    void nsContext?.close();
    nsContext = undefined;
    client = undefined;
    setJoined(false);
  });
});
$('leave').addEventListener('click', () => {
  log("ayrıl'a basıldı");
  void leave();
});
$('mute').addEventListener('click', async () => {
  if (!client || !micTrack) return;
  const muted = $('mute').textContent === 'Sustur';
  await client.setMuted('microphone', muted);
  $('mute').textContent = muted ? 'Sesi aç' : 'Sustur';
  log(muted ? 'mikrofon susturuldu' : 'mikrofon açıldı');
});

let tick = 0;
setInterval(async () => {
  if (!client) return;
  const s = await stats();
  if (tick++ % 5 === 0) {
    const playing = [...document.querySelectorAll<HTMLMediaElement>('#media audio')].map((m) => (m.paused ? 'durdu' : 'çalıyor'));
    shipLog(
      `istatistik: oda="${client.roomId}" kişiler=[${s.participants.join(', ')}] abonelik=${s.subscribedTracks} ` +
        `alınan=${s.audioPacketsReceived} gönderilen=${s.audioPacketsSent} kayıp=${s.audioPacketsLost} ` +
        `hedef=${s.audioTargetBitrate !== undefined ? Math.round(s.audioTargetBitrate / 1000) + 'kbps' : '-'} ` +
        `rtt=${s.roundTripTime !== undefined ? Math.round(s.roundTripTime * 1000) + 'ms' : '-'} ` +
        `oynatma-tamponu=${s.audioPlayoutDelay !== undefined ? Math.round(s.audioPlayoutDelay * 1000) + 'ms' : '-'} ses-öğeleri=[${playing.join(', ')}]`,
    );
  }
  $('stats').textContent = [
    `RTT: ${s.roundTripTime !== undefined ? Math.round(s.roundTripTime * 1000) + ' ms' : '–'}`,
    `alınan ses paketi: ${s.audioPacketsReceived}`,
    `kayıp: ${s.audioPacketsLost}`,
    `jitter: ${Math.round(s.audioJitter * 1000)} ms`,
    `oynatma tamponu: ${s.audioPlayoutDelay !== undefined ? Math.round(s.audioPlayoutDelay * 1000) + ' ms' : '–'}`,
    `gizlenen ses: %${(s.audioConcealedRatio * 100).toFixed(1)}`,
    `gönderilen ses paketi: ${s.audioPacketsSent}`,
    `kodlayıcı hedefi: ${s.audioTargetBitrate !== undefined ? Math.round(s.audioTargetBitrate / 1000) + ' kbps' : '–'}`,
  ].join('\n');
}, 1000);

// Driven by the end-to-end tests.
Object.assign(window, { voiceDemo: { join, leave, stats } });
