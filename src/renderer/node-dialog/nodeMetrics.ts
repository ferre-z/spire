import type { TraceEvent } from "../../shared/trace";

/**
 * Pure node-metrics aggregators. These consume the run engine's trace journal
 * (events journaled as `run.<event.type>`) and feed the Work tab and the
 * ActivityGraph. They are intentionally free of DOM/window/store imports so
 * they stay trivially testable and reusable.
 */

export type TokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type ActivityBucket = {
  /** ISO timestamp of the bucket's start. */
  label: string;
  toolCalls: number;
  tokens: number;
  errors: number;
};

const TOOL_START = "run.tool_start";
const USAGE = "run.usage";
const ERROR = "run.error";

/** Count of events journaled as tool starts. */
export function countToolCalls(events: TraceEvent[]): number {
  return events.filter((event) => event.kind === TOOL_START).length;
}

/** Sum the five-way token breakdown across usage events; malformed → 0, never NaN. */
export function sumTokens(events: TraceEvent[]): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const event of events) {
    if (event.kind !== USAGE) continue;
    const tokens = (event.payload as { tokens?: unknown } | undefined)?.tokens;
    if (typeof tokens !== "object" || tokens === null) continue;
    const t = tokens as Record<string, unknown>;
    const input = typeof t.input === "number" ? t.input : 0;
    const output = typeof t.output === "number" ? t.output : 0;
    const reasoning = typeof t.reasoning === "number" ? t.reasoning : 0;
    const cacheRead = typeof t.cacheRead === "number" ? t.cacheRead : 0;
    const cacheWrite = typeof t.cacheWrite === "number" ? t.cacheWrite : 0;
    totals.input += input;
    totals.output += output;
    totals.reasoning += reasoning;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
  }
  totals.total = totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite;
  return totals;
}

/** Count of events journaled as errors. */
export function countErrors(events: TraceEvent[]): number {
  return events.filter((event) => event.kind === ERROR).length;
}

/** Milliseconds between the first and last parseable timestamps; NaN-guarded to 0. */
export function computeUptimeMs(events: TraceEvent[]): number {
  const times = events
    .map((event) => Date.parse(event.timestamp))
    .filter((time) => !Number.isNaN(time));
  if (times.length < 2) return 0;
  const min = Math.min(...times);
  const max = Math.max(...times);
  return max - min;
}

/** Tool-call frequencies, sorted by count desc then tool name asc; missing tools skipped. */
export function toolCallFrequencies(events: TraceEvent[]): Array<{ tool: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== TOOL_START) continue;
    const tool = (event.payload as { tool?: unknown } | undefined)?.tool;
    if (typeof tool !== "string" || tool.length === 0) continue;
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
}

/**
 * Spread parseable event timestamps over [min, max] into `bucketCount` buckets.
 * Every event lands in exactly one bucket; out-of-span events clamp to the
 * nearest edge bucket. Fewer than two distinct timestamps collapses to a single
 * bucket; zero parseable events yields a single zeroed bucket.
 */
export function bucketActivity(events: TraceEvent[], bucketCount = 24): ActivityBucket[] {
  const parsed: Array<{ time: number; kind: string; tokens: number }> = [];
  for (const event of events) {
    const time = Date.parse(event.timestamp);
    if (Number.isNaN(time)) continue;
    let tokens = 0;
    if (event.kind === USAGE) {
      const t = (event.payload as { tokens?: unknown } | undefined)?.tokens;
      if (typeof t === "object" && t !== null) {
        const rec = t as Record<string, unknown>;
        tokens =
          (typeof rec.input === "number" ? rec.input : 0) +
          (typeof rec.output === "number" ? rec.output : 0) +
          (typeof rec.reasoning === "number" ? rec.reasoning : 0) +
          (typeof rec.cacheRead === "number" ? rec.cacheRead : 0) +
          (typeof rec.cacheWrite === "number" ? rec.cacheWrite : 0);
      }
    }
    parsed.push({ time, kind: event.kind, tokens });
  }

  if (parsed.length === 0) {
    return [{ label: "", toolCalls: 0, tokens: 0, errors: 0 }];
  }

  const distinct = new Set(parsed.map((entry) => entry.time));
  if (distinct.size < 2) {
    const bucket: ActivityBucket = { label: new Date(parsed[0]!.time).toISOString(), toolCalls: 0, tokens: 0, errors: 0 };
    for (const entry of parsed) {
      if (entry.kind === TOOL_START) bucket.toolCalls += 1;
      else if (entry.kind === ERROR) bucket.errors += 1;
      bucket.tokens += entry.tokens;
    }
    return [bucket];
  }

  const min = Math.min(...parsed.map((entry) => entry.time));
  const max = Math.max(...parsed.map((entry) => entry.time));
  const span = max - min;
  const buckets: ActivityBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    label: new Date(min + (span * i) / bucketCount).toISOString(),
    toolCalls: 0,
    tokens: 0,
    errors: 0,
  }));

  for (const entry of parsed) {
    let index = Math.floor(((entry.time - min) / span) * bucketCount);
    if (index < 0) index = 0;
    if (index >= bucketCount) index = bucketCount - 1;
    const bucket = buckets[index]!;
    if (entry.kind === TOOL_START) bucket.toolCalls += 1;
    else if (entry.kind === ERROR) bucket.errors += 1;
    bucket.tokens += entry.tokens;
  }

  return buckets;
}