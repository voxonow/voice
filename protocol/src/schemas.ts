/**
 * Runtime validation of everything a client sends. Server-side only — the
 * client imports the plain types from the package root.
 */
import { z } from 'zod';
import { PROTOCOL_VERSION, SOURCES, type Method, type RequestData, type TicketClaims } from './index.js';

export const Source = z.enum(SOURCES);

/** Room ids are opaque to the voice server; Voxonow decides their shape. */
export const RoomId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);

export const TicketClaimsSchema = z.object({
  sub: z.string().min(1).max(128),
  jti: z.string().min(16).max(128),
  room: RoomId,
  name: z.string().max(128),
  publish: z.array(Source).max(SOURCES.length),
});

// mediasoup validates its own parameter objects thoroughly; here they only
// have to be objects, and the WebSocket payload cap bounds their size.
const MediasoupObject = z.looseObject({});
const Id = z.string().min(1).max(64);

export const RequestSchemas = {
  join: z.object({
    ticket: z.string().min(1).max(4096),
    protocol: z.literal(PROTOCOL_VERSION),
  }),
  createTransport: z.object({ direction: z.enum(['send', 'recv']) }),
  connectTransport: z.object({ transportId: Id, dtlsParameters: MediasoupObject }),
  ready: z.object({ rtpCapabilities: MediasoupObject }),
  produce: z.object({
    transportId: Id,
    kind: z.enum(['audio', 'video']),
    rtpParameters: MediasoupObject,
    source: Source,
  }),
  closeProducer: z.object({ producerId: Id }),
  pauseProducer: z.object({ producerId: Id }),
  resumeProducer: z.object({ producerId: Id }),
  resumeConsumer: z.object({ consumerId: Id }),
  leave: z.strictObject({}),
  ping: z.strictObject({}),
} satisfies Record<Method, z.ZodType>;

export const RequestEnvelope = z.object({
  id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  method: z.string().max(64),
  data: z.unknown(),
});

// Compile-time proof that the schemas and the plain types describe the same
// messages: if either side changes alone, this file stops compiling.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type SchemaData = { [M in Method]: z.infer<(typeof RequestSchemas)[M]> };
export type _RequestsMatch = Assert<
  Same<
    { [M in Exclude<Method, 'leave'>]: SchemaData[M] },
    { [M in Exclude<Method, 'leave'>]: RequestData[M] }
  >
>;
export type _ClaimsMatch = Assert<Same<z.infer<typeof TicketClaimsSchema>, TicketClaims>>;
