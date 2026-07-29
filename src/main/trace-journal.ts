import type Database from "better-sqlite3";
import {
  TRACE_QUERY_MAX_LIMIT,
  TRACE_RETENTION_DAYS,
  TRACE_RETENTION_MAX_BYTES,
  traceEventSchema,
  type TraceEvent,
  type TraceFilter,
  type TraceListener,
  type TracePage,
} from "../shared/trace";
import type { JsonValue } from "../shared/workspace";

/**
 * Append-only trace journal.
 *
 * This is the single redaction path for execution traces: producers pass raw
 * payloads to append(), and the journal redacts them recursively before
 * persisting and before notifying subscribers. No other module redacts.
 */

export const REDACTED = "[REDACTED]";

const PRUNE_EVERY_APPENDS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sensitive object keys, compared case-insensitively after stripping `-` and
 * `_` (so `apiKey`, `api_key`, and `API-KEY` all match `apikey`).
 */
const SENSITIVE_KEYS = new Set([
  "apikey",
  "xapikey",
  "accesstoken",
  "refreshtoken",
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "privatekey",
  "sessiontoken",
  "cookie",
  "clientsecret",
  "apisecret",
  "sessionid",
  "accesskey",
  "secretaccesskey",
]);

/** `Bearer <token>` inside a string, e.g. an Authorization header value. */
const BEARER_PATTERN = /\bBearer[ \t]+[A-Za-z0-9\-._~+/]{8,}={0,2}\b/gi;
/**
 * API-key shapes inside a string: `sk-...`, `pk-...`, `xoxb-...`, plus
 * GitHub tokens (`ghp_...`, `gho_...`), which use underscore separators.
 */
const API_KEY_PATTERN =
  /\b(?:(?:sk|pk|rk|xox[baprs])-|(?:ghp|gho)_)[A-Za-z0-9][A-Za-z0-9_-]{11,}\b/g;

function scrubString(value: string): string {
  return value
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(API_KEY_PATTERN, REDACTED);
}

/**
 * Redact a string leaf. Producers often embed JSON payloads as strings (e.g.
 * tool arguments); when a string parses as a JSON object or array, redact the
 * parsed structure recursively and re-serialize so key-based rules still
 * apply. Strings that merely look like JSON but fail to parse fall through
 * to plain pattern scrubbing.
 */
function redactString(value: string): string {
  const first = value.trimStart().charAt(0);
  if (first === "{" || first === "[") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") {
        return JSON.stringify(redactValue(parsed as JsonValue));
      }
    } catch {
      // Not JSON after all — scrub as a plain string below.
    }
  }
  return scrubString(value);
}

function redactValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[-_]/g, "");
      result[key] = SENSITIVE_KEYS.has(normalized) ? REDACTED : redactValue(item);
    }
    return result;
  }
  return value;
}

export type TraceAppendInput = Omit<TraceEvent, "sequence" | "timestamp"> & {
  timestamp?: string;
};

export interface TraceJournalOptions {
  retentionMaxAgeMs?: number;
  retentionMaxBytes?: number;
}

export interface TracePruneOptions {
  maxAgeMs?: number;
  maxBytes?: number;
}

type TraceRow = {
  sequence: number;
  timestamp: string;
  correlation_id: string;
  run_id: string | null;
  node_id: string | null;
  harness_id: string | null;
  provider_id: string | null;
  request_id: string | null;
  kind: string;
  level: string;
  subsystem: string;
  message: string;
  payload: string | null;
};

type ByteRow = { total: number | null };
type SequenceBytesRow = { sequence: number; payload_bytes: number };

function rowToEvent(row: TraceRow): TraceEvent {
  return traceEventSchema.parse({
    sequence: row.sequence,
    timestamp: row.timestamp,
    correlationId: row.correlation_id,
    runId: row.run_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    harnessId: row.harness_id ?? undefined,
    providerId: row.provider_id ?? undefined,
    requestId: row.request_id ?? undefined,
    kind: row.kind,
    level: row.level,
    subsystem: row.subsystem,
    message: row.message,
    payload: row.payload === null ? undefined : JSON.parse(row.payload),
  });
}

export class TraceJournal {
  private readonly db: Database.Database;
  private readonly retentionMaxAgeMs: number;
  private readonly retentionMaxBytes: number;
  private readonly listeners = new Set<TraceListener>();
  private appendsSincePrune = 0;

  constructor(db: Database.Database, options: TraceJournalOptions = {}) {
    this.db = db;
    this.retentionMaxAgeMs =
      options.retentionMaxAgeMs ?? TRACE_RETENTION_DAYS * DAY_MS;
    this.retentionMaxBytes =
      options.retentionMaxBytes ?? TRACE_RETENTION_MAX_BYTES;
    this.prune();
  }

  append(input: TraceAppendInput): TraceEvent {
    const redactedPayload =
      input.payload === undefined
        ? undefined
        : redactValue(input.payload as JsonValue);
    const payloadJson =
      redactedPayload === undefined ? null : JSON.stringify(redactedPayload);
    const payloadBytes =
      payloadJson === null ? 0 : Buffer.byteLength(payloadJson, "utf8");
    const timestamp = input.timestamp ?? new Date().toISOString();
    const message = scrubString(input.message);

    // Validate the full event shape BEFORE persisting: a schema-invalid
    // input is rejected here so it can never create a poison row that would
    // make every later query() hitting it throw in rowToEvent.
    const validated = traceEventSchema.omit({ sequence: true }).parse({
      ...input,
      timestamp,
      message,
      payload: redactedPayload,
    });

    const result = this.db
      .prepare(
        `INSERT INTO trace_events
           (timestamp, correlation_id, run_id, node_id, harness_id,
            provider_id, request_id, kind, level, subsystem, message,
            payload, payload_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validated.timestamp,
        validated.correlationId,
        validated.runId ?? null,
        validated.nodeId ?? null,
        validated.harnessId ?? null,
        validated.providerId ?? null,
        validated.requestId ?? null,
        validated.kind,
        validated.level,
        validated.subsystem,
        validated.message,
        payloadJson,
        payloadBytes,
      );

    const event: TraceEvent = {
      ...validated,
      sequence: Number(result.lastInsertRowid),
    };

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // A faulty listener must not break append() or starve the others.
        console.error("trace listener threw", error);
      }
    }

    this.appendsSincePrune += 1;
    if (this.appendsSincePrune >= PRUNE_EVERY_APPENDS) {
      this.appendsSincePrune = 0;
      this.prune();
    }

    return event;
  }

  query(filter: TraceFilter): TracePage {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    const columns: Record<string, string | undefined> = {
      correlation_id: filter.correlationId,
      run_id: filter.runId,
      node_id: filter.nodeId,
      harness_id: filter.harnessId,
      provider_id: filter.providerId,
      request_id: filter.requestId,
      kind: filter.kind,
      level: filter.level,
      subsystem: filter.subsystem,
    };
    for (const [column, value] of Object.entries(columns)) {
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (filter.since !== undefined) {
      conditions.push("timestamp >= ?");
      params.push(filter.since);
    }
    if (filter.cursor !== undefined) {
      conditions.push("sequence > ?");
      params.push(filter.cursor.afterSequence);
    }

    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const limit = filter.limit ?? TRACE_QUERY_MAX_LIMIT;
    const rows = this.db
      .prepare(
        `SELECT sequence, timestamp, correlation_id, run_id, node_id,
                harness_id, provider_id, request_id, kind, level, subsystem,
                message, payload
         FROM trace_events ${where}
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(...params, limit) as TraceRow[];

    const events = rows.map(rowToEvent);
    const nextCursor =
      rows.length === limit
        ? { afterSequence: rows[rows.length - 1].sequence }
        : null;
    return { events, nextCursor };
  }

  subscribe(listener: TraceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  prune(options: TracePruneOptions = {}): void {
    const maxAgeMs = options.maxAgeMs ?? this.retentionMaxAgeMs;
    const maxBytes = options.maxBytes ?? this.retentionMaxBytes;

    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    this.db.prepare("DELETE FROM trace_events WHERE timestamp < ?").run(cutoff);

    const { total } = this.db
      .prepare("SELECT SUM(payload_bytes) AS total FROM trace_events")
      .get() as ByteRow;
    let excess = (total ?? 0) - maxBytes;
    if (excess <= 0) {
      return;
    }

    const oldest = this.db
      .prepare(
        "SELECT sequence, payload_bytes FROM trace_events ORDER BY sequence ASC",
      )
      .all() as SequenceBytesRow[];
    const doomed: number[] = [];
    for (const row of oldest) {
      if (excess <= 0) {
        break;
      }
      doomed.push(row.sequence);
      excess -= row.payload_bytes;
    }
    if (doomed.length > 0) {
      this.db
        .prepare(
          `DELETE FROM trace_events WHERE sequence IN
             (${doomed.map(() => "?").join(", ")})`,
        )
        .run(...doomed);
    }
  }

  close(): void {
    this.listeners.clear();
  }
}
