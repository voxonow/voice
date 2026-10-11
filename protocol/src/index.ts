/**
 * The wire contract between @voxonow/voice-client and the voice server.
 *
 * This entry point is types and constants only, with no runtime dependencies,
 * so the client bundle stays small. The server validates every incoming
 * message with the zod schemas in `@voxonow/voice-protocol/schemas`, which are
 * type-checked against the definitions here.
 *
 * Transport: one WebSocket per participant. The client sends requests
 * (`{ id, method, data }`) and gets exactly one response per request
 * (`{ id, ok, data | error }`); the server also pushes notifications
 * (`{ notification, data }`). The first request on a connection must be
 * `join`, carrying a ticket — anything else closes the connection.
 */

export const PROTOCOL_VERSION = 1;

/** Path the voice server accepts WebSocket upgrades on. */
export const SIGNALING_PATH = '/ws';

/**
 * What a published track is. Named after LiveKit's `Track.Source` values so
 * Voxonow's voice UI can map one-to-one while both engines exist.
 */
export const SOURCES = ['microphone', 'camera', 'screen_share', 'screen_share_audio'] as const;
export type Source = (typeof SOURCES)[number];

export type MediaKind = 'audio' | 'video';

/** The media kind each source must carry — a camera cannot publish audio. */
export const SOURCE_KIND: Readonly<Record<Source, MediaKind>> = {
  microphone: 'audio',
  camera: 'video',
  screen_share: 'video',
  screen_share_audio: 'audio',
};

/**
 * Claims of a join ticket, beyond the registered ones (`iss`, `aud`, `iat`,
 * `nbf`, `exp`) that the verifier checks itself. Voxonow's API signs these
 * with its Ed25519 private key; the voice server only holds the public key.
 */
export interface TicketClaims {
  /** Voxonow user id. One user has at most one connection per room. */
  sub: string;
  /** Single-use ticket id. */
  jti: string;
  room: string;
  /** Display name, shown to the other participants. */
  name: string;
  /** Sources this participant may publish. Empty means listen-only. */
  publish: Source[];
}

/** mediasoup parameter objects; opaque to the protocol, validated by mediasoup. */
export type MediasoupObject = Record<string, unknown>;

export interface RequestData {
  join: { ticket: string; protocol: typeof PROTOCOL_VERSION };
  createTransport: { direction: 'send' | 'recv' };
  connectTransport: { transportId: string; dtlsParameters: MediasoupObject };
  /**
   * Declares the client's receive capabilities. Sent after the receive
   * transport exists; from then on the server pushes `newConsumer` for every
   * track in the room.
   */
  ready: { rtpCapabilities: MediasoupObject };
  produce: { transportId: string; kind: MediaKind; rtpParameters: MediasoupObject; source: Source };
  closeProducer: { producerId: string };
  pauseProducer: { producerId: string };
  resumeProducer: { producerId: string };
  resumeConsumer: { consumerId: string };
  leave: Record<string, never>;
  /**
   * Application-level liveness check (added without a protocol version change).
   * A server that predates it answers `bad_request` and keeps the connection;
   * clients then stop sending it for that session.
   */
  ping: Record<string, never>;
}

export type Method = keyof RequestData;

export interface ParticipantInfo {
  peerId: string;
  userId: string;
  name: string;
}

type Empty = Record<string, never>;

/** What each method answers with. */
export interface ResponseData {
  join: {
    peerId: string;
    roomId: string;
    routerRtpCapabilities: MediasoupObject;
    participants: ParticipantInfo[];
  };
  createTransport: {
    id: string;
    iceParameters: MediasoupObject;
    iceCandidates: MediasoupObject[];
    dtlsParameters: MediasoupObject;
  };
  connectTransport: Empty;
  ready: Empty;
  produce: { producerId: string };
  closeProducer: Empty;
  pauseProducer: Empty;
  resumeProducer: Empty;
  resumeConsumer: Empty;
  leave: Empty;
  ping: Empty;
}

export type ErrorCode = 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'internal';

export type Response =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: { code: ErrorCode; message: string } };

export interface Notifications {
  participantJoined: ParticipantInfo;
  participantLeft: { peerId: string };
  newConsumer: {
    consumerId: string;
    producerId: string;
    peerId: string;
    kind: MediaKind;
    source: Source;
    rtpParameters: MediasoupObject;
    producerPaused: boolean;
  };
  consumerClosed: { consumerId: string };
  consumerPaused: { consumerId: string };
  consumerResumed: { consumerId: string };
}

export type Notification = {
  [K in keyof Notifications]: { notification: K; data: Notifications[K] };
}[keyof Notifications];

/**
 * WebSocket close codes the server uses (4000–4999 is the application range).
 * The client uses them to decide whether reconnecting can help.
 */
export const CloseCode = {
  /** Sent `leave`. */
  Left: 4000,
  /** No valid `join` arrived in time, or another message came first. */
  AuthRequired: 4001,
  /** The ticket was rejected. A new ticket is needed. */
  Unauthorized: 4003,
  /** Too many messages. */
  RateLimited: 4008,
  /** The same user joined the room from another connection. */
  Replaced: 4009,
  /** The room was closed by the server (e.g. its media worker failed). */
  RoomClosed: 4010,
  /** The server is shutting down. */
  ServerShutdown: 4011,
} as const;
