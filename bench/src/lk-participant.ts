/**
 * A LiveKit participant page exposing the same `window.voiceDemo` API as our
 * demo (join / stats / leave), so bench/quality.mjs can measure both engines
 * with one sampler. livekit-client defaults, as Voxonow uses it today.
 */
import { Room, RoomEvent, Track, type RemoteAudioTrack } from 'livekit-client';

let room: Room | undefined;

async function join(roomName: string, name: string): Promise<void> {
  const response = await fetch('/api/lk-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room: roomName, name }),
  });
  const { token, url } = (await response.json()) as { token: string; url: string };
  room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return;
    const element = track.attach();
    document.body.append(element);
  });
  await room.connect(url, token);
  await room.localParticipant.setMicrophoneEnabled(true);
}

async function stats() {
  const result = {
    audioPacketsReceived: 0,
    audioPacketsSent: 0,
    roundTripTime: undefined as number | undefined,
    participants: [] as string[],
    perTrack: [] as {
      from: string;
      packetsReceived: number;
      packetsLost: number;
      jitter: number;
      concealedRatio: number;
      jitterBufferDelay: number;
      jitterBufferEmittedCount: number;
    }[],
  };
  if (!room) return result;
  for (const participant of room.remoteParticipants.values()) {
    result.participants.push(participant.name || participant.identity);
    for (const publication of participant.audioTrackPublications.values()) {
      const track = publication.track as RemoteAudioTrack | undefined;
      const report = await track?.getRTCStatsReport();
      report?.forEach((r) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'audio') return;
        const samples = r.totalSamplesReceived ?? 0;
        result.audioPacketsReceived += r.packetsReceived ?? 0;
        result.perTrack.push({
          from: participant.name || participant.identity,
          packetsReceived: r.packetsReceived ?? 0,
          packetsLost: r.packetsLost ?? 0,
          jitter: r.jitter ?? 0,
          concealedRatio: samples > 0 ? (r.concealedSamples ?? 0) / samples : 0,
          jitterBufferDelay: r.jitterBufferDelay ?? 0,
          jitterBufferEmittedCount: r.jitterBufferEmittedCount ?? 0,
        });
      });
    }
  }
  const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  const sendReport = await mic?.getRTCStatsReport();
  sendReport?.forEach((r) => {
    if (r.type === 'outbound-rtp' && r.kind === 'audio') result.audioPacketsSent += r.packetsSent ?? 0;
    if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime !== undefined) {
      result.roundTripTime ??= r.currentRoundTripTime;
    }
  });
  return result;
}

async function leave(): Promise<void> {
  await room?.disconnect();
  room = undefined;
}

Object.assign(window, { voiceDemo: { join, stats, leave } });
