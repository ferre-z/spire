import { describe, expect, it } from "vitest";
import {
  CONTROL_CAPABILITIES,
  CONTROL_OPERATION_NAMES,
  CONTROL_PAGE_MAX_LIMIT,
  controlOperationNameSchema,
  graphRefSchema,
  pageInputSchema,
  runIdInputSchema,
} from "./control";
import {
  TRACE_QUERY_MAX_LIMIT,
  traceCursorSchema,
  traceEventSchema,
  traceFilterSchema,
} from "./trace";

const EXPECTED_OPERATIONS = [
  "state.get",
  "diagnostics.get",
  "graphs.list",
  "graphs.get",
  "graphs.save",
  "repositories.validate",
  "runs.list",
  "runs.get",
  "runs.start",
  "runs.stop",
  "runs.retry",
  "runs.artifacts.get",
  "worktrees.cleanup",
  "layouts.list",
  "layouts.save",
  "layouts.reset",
  "harnesses.list",
  "harnesses.models",
  "traces.query",
  "traces.tail",
] as const;

const validTraceEvent = {
  sequence: 1,
  timestamp: new Date().toISOString(),
  correlationId: "corr-1",
  runId: "run-1",
  nodeId: "planner",
  harnessId: "opencode",
  providerId: "openrouter",
  requestId: "req-1",
  kind: "harness.request",
  level: "info",
  subsystem: "harness",
  message: "Prompt sent to harness.",
  payload: { prompt: "hello", candidates: ["a", "b"], depth: { n: 1 } },
};

describe("controlOperationNameSchema", () => {
  it("accepts every declared operation", () => {
    for (const name of EXPECTED_OPERATIONS) {
      expect(controlOperationNameSchema.parse(name)).toBe(name);
    }
  });

  it("rejects unknown operations", () => {
    expect(controlOperationNameSchema.safeParse("runs.delete").success).toBe(
      false,
    );
    expect(controlOperationNameSchema.safeParse("").success).toBe(false);
    expect(controlOperationNameSchema.safeParse("state.get.extra").success).toBe(
      false,
    );
    expect(controlOperationNameSchema.safeParse(42).success).toBe(false);
  });
});

describe("CONTROL_CAPABILITIES", () => {
  it("covers exactly the declared operations", () => {
    expect([...CONTROL_OPERATION_NAMES].sort()).toEqual(
      [...EXPECTED_OPERATIONS].sort(),
    );
    expect(Object.keys(CONTROL_CAPABILITIES).sort()).toEqual(
      [...EXPECTED_OPERATIONS].sort(),
    );
  });

  it("declares complete metadata for every operation", () => {
    for (const name of EXPECTED_OPERATIONS) {
      const capability = CONTROL_CAPABILITIES[name];
      expect(typeof capability.readOnly).toBe("boolean");
      expect(typeof capability.destructive).toBe("boolean");
      expect(typeof capability.idempotent).toBe("boolean");
      expect(typeof capability.inputSchema.safeParse).toBe("function");
      expect(typeof capability.outputSchema.safeParse).toBe("function");
    }
  });

  it("marks read operations as read-only and mutations as not", () => {
    expect(CONTROL_CAPABILITIES["state.get"].readOnly).toBe(true);
    expect(CONTROL_CAPABILITIES["traces.query"].readOnly).toBe(true);
    expect(CONTROL_CAPABILITIES["runs.start"].readOnly).toBe(false);
    expect(CONTROL_CAPABILITIES["worktrees.cleanup"].destructive).toBe(true);
  });

  it("validates operation inputs through the capability schemas", () => {
    expect(
      CONTROL_CAPABILITIES["graphs.get"].inputSchema.safeParse({
        graphId: "graph-1",
      }).success,
    ).toBe(true);
    expect(
      CONTROL_CAPABILITIES["graphs.get"].inputSchema.safeParse({ graphId: "" })
        .success,
    ).toBe(false);
    expect(
      CONTROL_CAPABILITIES["state.get"].inputSchema.safeParse({ extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe("input identifier schemas", () => {
  it("accepts well-formed run ids", () => {
    expect(runIdInputSchema.parse({ runId: "run-1" })).toEqual({
      runId: "run-1",
    });
  });

  it("rejects malformed run ids", () => {
    expect(runIdInputSchema.safeParse({ runId: "" }).success).toBe(false);
    expect(runIdInputSchema.safeParse({}).success).toBe(false);
    expect(runIdInputSchema.safeParse({ runId: 7 }).success).toBe(false);
    expect(
      runIdInputSchema.safeParse({ runId: "run-1", extra: true }).success,
    ).toBe(false);
  });

  it("rejects malformed graph references", () => {
    expect(graphRefSchema.safeParse({ graphId: "" }).success).toBe(false);
    expect(
      graphRefSchema.safeParse({ graphId: "graph-1", version: 0 }).success,
    ).toBe(false);
    expect(
      graphRefSchema.safeParse({ graphId: "graph-1", version: 1.5 }).success,
    ).toBe(false);
    expect(
      graphRefSchema.safeParse({ graphId: "graph-1", version: 2 }).success,
    ).toBe(true);
  });
});

describe("pageInputSchema", () => {
  it("accepts empty and bounded page inputs", () => {
    expect(pageInputSchema.safeParse({}).success).toBe(true);
    expect(
      pageInputSchema.safeParse({ limit: 50, cursor: "abc" }).success,
    ).toBe(true);
  });

  it("rejects oversized or malformed page inputs", () => {
    expect(
      pageInputSchema.safeParse({ limit: CONTROL_PAGE_MAX_LIMIT + 1 }).success,
    ).toBe(false);
    expect(pageInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(pageInputSchema.safeParse({ limit: 2.5 }).success).toBe(false);
    expect(pageInputSchema.safeParse({ cursor: "" }).success).toBe(false);
    expect(pageInputSchema.safeParse({ offset: 10 }).success).toBe(false);
  });
});

describe("traceEventSchema", () => {
  it("accepts a fully populated event with a JSON payload", () => {
    expect(traceEventSchema.parse(validTraceEvent)).toEqual(validTraceEvent);
  });

  it("accepts an event without optional correlation fields", () => {
    const minimal = {
      sequence: 2,
      timestamp: new Date().toISOString(),
      correlationId: "corr-2",
      kind: "run.started",
      level: "debug",
      subsystem: "runner",
      message: "Run started.",
    };
    expect(traceEventSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects non-JSON payloads", () => {
    expect(
      traceEventSchema.safeParse({
        ...validTraceEvent,
        payload: { handler: () => undefined },
      }).success,
    ).toBe(false);
    expect(
      traceEventSchema.safeParse({ ...validTraceEvent, payload: 10n }).success,
    ).toBe(false);
    expect(
      traceEventSchema.safeParse({
        ...validTraceEvent,
        payload: { missing: undefined },
      }).success,
    ).toBe(false);
  });

  it("rejects malformed events", () => {
    expect(
      traceEventSchema.safeParse({ ...validTraceEvent, sequence: 0 }).success,
    ).toBe(false);
    expect(
      traceEventSchema.safeParse({ ...validTraceEvent, level: "verbose" })
        .success,
    ).toBe(false);
    expect(
      traceEventSchema.safeParse({ ...validTraceEvent, timestamp: "soon" })
        .success,
    ).toBe(false);
    expect(
      traceEventSchema.safeParse({ ...validTraceEvent, extra: true }).success,
    ).toBe(false);
    const noCorrelation: Record<string, unknown> = { ...validTraceEvent };
    delete noCorrelation.correlationId;
    expect(traceEventSchema.safeParse(noCorrelation).success).toBe(false);
  });
});

describe("traceCursorSchema", () => {
  it("accepts a well-formed cursor", () => {
    expect(traceCursorSchema.parse({ afterSequence: 0 })).toEqual({
      afterSequence: 0,
    });
    expect(traceCursorSchema.safeParse({ afterSequence: 41 }).success).toBe(
      true,
    );
  });

  it("rejects invalid cursors", () => {
    expect(traceCursorSchema.safeParse({ afterSequence: -1 }).success).toBe(
      false,
    );
    expect(traceCursorSchema.safeParse({ afterSequence: 1.5 }).success).toBe(
      false,
    );
    expect(traceCursorSchema.safeParse({ afterSequence: "41" }).success).toBe(
      false,
    );
    expect(traceCursorSchema.safeParse({}).success).toBe(false);
    expect(
      traceCursorSchema.safeParse({ afterSequence: 1, page: 2 }).success,
    ).toBe(false);
  });
});

describe("traceFilterSchema", () => {
  it("accepts empty and fully specified filters", () => {
    expect(traceFilterSchema.safeParse({}).success).toBe(true);
    expect(
      traceFilterSchema.safeParse({
        runId: "run-1",
        nodeId: "planner",
        harnessId: "opencode",
        providerId: "openrouter",
        requestId: "req-1",
        correlationId: "corr-1",
        kind: "harness.request",
        level: "warn",
        subsystem: "harness",
        since: new Date().toISOString(),
        limit: 100,
        cursor: { afterSequence: 9 },
      }).success,
    ).toBe(true);
  });

  it("rejects oversized trace limits", () => {
    expect(
      traceFilterSchema.safeParse({ limit: TRACE_QUERY_MAX_LIMIT + 1 }).success,
    ).toBe(false);
    expect(
      traceFilterSchema.safeParse({ limit: TRACE_QUERY_MAX_LIMIT }).success,
    ).toBe(true);
  });

  it("rejects malformed filters", () => {
    expect(traceFilterSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(traceFilterSchema.safeParse({ level: "verbose" }).success).toBe(
      false,
    );
    expect(traceFilterSchema.safeParse({ since: "yesterday" }).success).toBe(
      false,
    );
    expect(traceFilterSchema.safeParse({ runId: "" }).success).toBe(false);
    expect(traceFilterSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});
