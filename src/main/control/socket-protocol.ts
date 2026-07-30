import { z } from "zod";
import { controlOperationNameSchema } from "../../shared/control";
import { traceEventSchema } from "../../shared/trace";

/**
 * Wire protocol for the local control socket.
 *
 * Newline-delimited JSON envelopes over a Unix domain socket. Every client
 * frame carries the per-launch token from the mode-0600 token file; the
 * server checks it before the frame is parsed any further, so these schemas
 * only ever run for authenticated peers. There is one subscription topic
 * (trace events); `subscribe` maps to `SpireControl.subscribe()` and events
 * arrive as `event` frames carrying the subscribing frame's id.
 */

const tokenField = z.string().min(1);
const idField = z.string().min(1);

export const requestFrameSchema = z.strictObject({
  type: z.literal("request"),
  id: idField,
  token: tokenField,
  operation: controlOperationNameSchema,
  input: z.unknown().optional(),
});
export type RequestFrame = z.infer<typeof requestFrameSchema>;

export const subscribeFrameSchema = z.strictObject({
  type: z.literal("subscribe"),
  id: idField,
  token: tokenField,
});
export type SubscribeFrame = z.infer<typeof subscribeFrameSchema>;

export const unsubscribeFrameSchema = z.strictObject({
  type: z.literal("unsubscribe"),
  id: idField,
  token: tokenField,
  subscription: idField,
});
export type UnsubscribeFrame = z.infer<typeof unsubscribeFrameSchema>;

export const pingFrameSchema = z.strictObject({
  type: z.literal("ping"),
  id: idField,
  token: tokenField,
});
export type PingFrame = z.infer<typeof pingFrameSchema>;

export const clientFrameSchema = z.discriminatedUnion("type", [
  requestFrameSchema,
  subscribeFrameSchema,
  unsubscribeFrameSchema,
  pingFrameSchema,
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

export const responseFrameSchema = z.strictObject({
  type: z.literal("response"),
  // Empty when the failing frame had no usable id (malformed JSON).
  id: z.string(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});
export type ResponseFrame = z.infer<typeof responseFrameSchema>;

export const eventFrameSchema = z.strictObject({
  type: z.literal("event"),
  subscription: idField,
  event: traceEventSchema,
});
export type EventFrame = z.infer<typeof eventFrameSchema>;

export const serverFrameSchema = z.discriminatedUnion("type", [
  responseFrameSchema,
  eventFrameSchema,
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;
