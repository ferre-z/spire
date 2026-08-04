import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../shared/workspace";
import type { TraceEvent } from "../../shared/trace";
import {
  bucketActivity,
  computeUptimeMs,
  countErrors,
  countToolCalls,
  sumTokens,
  toolCallFrequencies,
} from "./nodeMetrics";

/**
 * Build a minimal TraceEvent fixture. `payload` is intentionally loose so the
 * tests can exercise malformed payloads; the exported aggregator signatures
 * stay precise.
 */
function makeTrace(kind: string, timestamp: string, payload?: JsonValue): TraceEvent {
  return {
    sequence: 1,
    timestamp,
    correlationId: "corr",
    runId: "run",
    nodeId: "node",
    kind,
    level: "info",
    subsystem: "harness",
    message: kind,
    payload,
  };
}

const T0 = "2026-08-03T10:00:00.000Z";
const T1 = "2026-08-03T10:01:00.000Z";
const T2 = "2026-08-03T10:02:00.000Z";
const T3 = "2026-08-03T10:03:00.000Z";

describe("nodeMetrics", () => {
  describe("countToolCalls", () => {
    it("counts only run.tool_start events", () => {
      const events = [
        makeTrace("run.tool_start", T0, { tool: "read" }),
        makeTrace("run.tool_start", T1, { tool: "write" }),
        makeTrace("run.usage", T2, { tokens: {} }),
        makeTrace("run.error", T3, { message: "boom" }),
      ];
      expect(countToolCalls(events)).toBe(2);
    });

    it("returns 0 for empty input", () => {
      expect(countToolCalls([])).toBe(0);
    });
  });

  describe("sumTokens", () => {
    it("sums the five-way token breakdown and total", () => {
      const events = [
        makeTrace("run.usage", T0, {
          tokens: { input: 100, output: 20, reasoning: 10, cacheRead: 5, cacheWrite: 3 },
        }),
        makeTrace("run.usage", T1, {
          tokens: { input: 50, output: 10, reasoning: 5, cacheRead: 2, cacheWrite: 1 },
        }),
        makeTrace("run.tool_start", T2, { tool: "read" }),
      ];
      expect(sumTokens(events)).toEqual({
        input: 150,
        output: 30,
        reasoning: 15,
        cacheRead: 7,
        cacheWrite: 4,
        total: 206,
      });
    });

    it("treats missing or malformed payloads as zero, never NaN", () => {
      const events = [
        makeTrace("run.usage", T0, { tokens: { input: 10 } }),
        makeTrace("run.usage", T1, { tokens: "nope" }),
        makeTrace("run.usage", T2, undefined),
        makeTrace("run.usage", T3, { tokens: { input: "bad", output: 5 } }),
      ];
      const result = sumTokens(events);
      expect(result).toEqual({ input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 });
      expect(Number.isNaN(result.total)).toBe(false);
    });

    it("returns all-zero totals for empty input", () => {
      expect(sumTokens([])).toEqual({
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      });
    });
  });

  describe("countErrors", () => {
    it("counts only run.error events", () => {
      const events = [
        makeTrace("run.error", T0, { message: "a" }),
        makeTrace("run.error", T1, { message: "b" }),
        makeTrace("run.warning", T2, { message: "w" }),
        makeTrace("run.tool_start", T3, { tool: "read" }),
      ];
      expect(countErrors(events)).toBe(2);
    });

    it("returns 0 for empty input", () => {
      expect(countErrors([])).toBe(0);
    });
  });

  describe("computeUptimeMs", () => {
    it("computes the span between first and last parseable timestamps", () => {
      const events = [
        makeTrace("run.tool_start", T0, { tool: "read" }),
        makeTrace("run.usage", T1, { tokens: {} }),
        makeTrace("run.error", T3, { message: "boom" }),
      ];
      expect(computeUptimeMs(events)).toBe(180000);
    });

    it("returns 0 when timestamps are unparseable (NaN guard)", () => {
      const events = [
        makeTrace("run.tool_start", "not-a-date", { tool: "read" }),
        makeTrace("run.usage", "also-bad", { tokens: {} }),
      ];
      expect(computeUptimeMs(events)).toBe(0);
    });

    it("returns 0 for fewer than two events", () => {
      expect(computeUptimeMs([makeTrace("run.tool_start", T0, { tool: "read" })])).toBe(0);
      expect(computeUptimeMs([])).toBe(0);
    });
  });

  describe("toolCallFrequencies", () => {
    it("sorts by count desc then tool name asc and skips missing tools", () => {
      const events = [
        makeTrace("run.tool_start", T0, { tool: "b" }),
        makeTrace("run.tool_start", T0, { tool: "b" }),
        makeTrace("run.tool_start", T0, { tool: "a" }),
        makeTrace("run.tool_start", T0, { tool: "a" }),
        makeTrace("run.tool_start", T0, { tool: "a" }),
        makeTrace("run.tool_start", T0, { tool: "c" }),
        makeTrace("run.tool_start", T0, {}),
        makeTrace("run.tool_start", T0, undefined),
      ];
      expect(toolCallFrequencies(events)).toEqual([
        { tool: "a", count: 3 },
        { tool: "b", count: 2 },
        { tool: "c", count: 1 },
      ]);
    });

    it("returns an empty array for empty input", () => {
      expect(toolCallFrequencies([])).toEqual([]);
    });
  });

  describe("bucketActivity", () => {
    it("lands events at exactly min and max in the first and last buckets", () => {
      const events = [
        makeTrace("run.tool_start", T0, { tool: "read" }),
        makeTrace("run.usage", T3, { tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
        makeTrace("run.error", T3, { message: "boom" }),
      ];
      const buckets = bucketActivity(events, 4);
      expect(buckets).toHaveLength(4);
      expect(buckets[0]?.toolCalls).toBe(1);
      expect(buckets[0]?.tokens).toBe(0);
      expect(buckets[0]?.errors).toBe(0);
      expect(buckets[3]?.toolCalls).toBe(0);
      expect(buckets[3]?.tokens).toBe(10);
      expect(buckets[3]?.errors).toBe(1);
      expect(buckets[0]?.label).toBe(T0);
    });

    it("returns a single bucket containing everything for fewer than two distinct timestamps", () => {
      const events = [
        makeTrace("run.tool_start", T0, { tool: "read" }),
        makeTrace("run.tool_start", T0, { tool: "write" }),
        makeTrace("run.error", T0, { message: "boom" }),
      ];
      const buckets = bucketActivity(events, 24);
      expect(buckets).toHaveLength(1);
      expect(buckets[0]?.toolCalls).toBe(2);
      expect(buckets[0]?.errors).toBe(1);
    });

    it("returns a single zeroed bucket for zero events", () => {
      const buckets = bucketActivity([], 24);
      expect(buckets).toHaveLength(1);
      expect(buckets[0]).toEqual({ label: expect.any(String), toolCalls: 0, tokens: 0, errors: 0 });
    });

    it("never produces NaN for empty input", () => {
      const buckets = bucketActivity([], 24);
      expect(Number.isNaN(buckets[0]?.tokens)).toBe(false);
      expect(Number.isNaN(buckets[0]?.toolCalls)).toBe(false);
      expect(Number.isNaN(buckets[0]?.errors)).toBe(false);
    });
  });
});