import { z } from "zod";
import { jsonValueSchema } from "./workspace";

/**
 * Trace observability contract.
 *
 * Trace events are append-only records of everything the control plane does:
 * harness requests/responses, run lifecycle transitions, and control
 * operations. The journal (a later task) indexes events by sequence,
 * correlation id, run id, node id, harness id, provider id, and request id.
 * Payloads may carry prompts and responses and must be recursively redacted
 * before leaving the process — redaction is implemented by a later task, so
 * payloads here are plain JSON values only.
 */

export const TRACE_RETENTION_DAYS = 30;
export const TRACE_RETENTION_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const TRACE_QUERY_MAX_LIMIT = 1000;

export const traceLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type TraceLevel = z.infer<typeof traceLevelSchema>;

export const traceEventSchema = z.strictObject({
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  correlationId: z.string().min(1),
  runId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  harnessId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  kind: z.string().min(1),
  level: traceLevelSchema,
  subsystem: z.string().min(1),
  message: z.string(),
  payload: jsonValueSchema.optional(),
});
export type TraceEvent = z.infer<typeof traceEventSchema>;

/** Position into the trace journal: events after this sequence number. */
export const traceCursorSchema = z.strictObject({
  afterSequence: z.number().int().nonnegative(),
});
export type TraceCursor = z.infer<typeof traceCursorSchema>;

/** Position into the trace journal for paging back: events before this sequence number. */
export const tracePrevCursorSchema = z.strictObject({
  beforeSequence: z.number().int().positive(),
});
export type TracePrevCursor = z.infer<typeof tracePrevCursorSchema>;

export const traceFilterSchema = z.strictObject({
  runId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  harnessId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  level: traceLevelSchema.optional(),
  subsystem: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(TRACE_QUERY_MAX_LIMIT).optional(),
  cursor: traceCursorSchema.optional(),
  /**
   * Read direction: "forward" (default) pages from the cursor toward newer
   * rows; "backward" returns the newest page at or below beforeSequence (or
   * the journal tail when omitted) for "load older" style history paging.
   */
  direction: z.enum(["forward", "backward"]).optional(),
  /** Exclusive upper bound on sequence, used with direction "backward". */
  beforeSequence: z.number().int().positive().optional(),
});
export type TraceFilter = z.infer<typeof traceFilterSchema>;

export const tracePageSchema = z.strictObject({
  events: z.array(traceEventSchema),
  nextCursor: traceCursorSchema.nullable(),
  /** Points at older rows; null when no older rows remain. */
  prevCursor: tracePrevCursorSchema.nullable().optional(),
});
export type TracePage = z.infer<typeof tracePageSchema>;

export type TraceListener = (event: TraceEvent) => void;
