// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpireApi } from "../../shared/api";
import type { TraceEvent, TracePage } from "../../shared/trace";
import { useNodeTraces } from "./useNodeTraces";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function makeEvent(
  sequence: number,
  overrides: Partial<TraceEvent> = {},
): TraceEvent {
  return {
    sequence,
    timestamp: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
    correlationId: `corr-${sequence}`,
    kind: "run.lifecycle",
    level: "info",
    subsystem: "runs",
    message: `event ${sequence}`,
    ...overrides,
  };
}

function page(
  events: TraceEvent[],
  nextCursor: TracePage["nextCursor"] = null,
): TracePage {
  return { events, nextCursor, prevCursor: null };
}

type HookResult = ReturnType<typeof useNodeTraces>;

function Probe({
  runId,
  nodeId,
  onResult,
}: {
  runId: string | undefined;
  nodeId: string | undefined;
  onResult: (result: HookResult) => void;
}) {
  const result = useNodeTraces(runId, nodeId);
  onResult(result);
  return (
    <div>
      {result.loading ? "loading" : "idle"}:
      {result.events.map((event) => `#${event.sequence}`).join(",")}
    </div>
  );
}

let queryTraces: ReturnType<typeof vi.fn>;
let onTraceEvent: ReturnType<typeof vi.fn>;
let unsubscribeTrace: ReturnType<typeof vi.fn>;
let traceListener: ((event: TraceEvent) => void) | undefined;

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let latest: HookResult | undefined;
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

async function renderProbe(runId: string | undefined, nodeId: string | undefined) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latest = undefined;
  await act(async () => {
    root!.render(
      <Probe
        runId={runId}
        nodeId={nodeId}
        onResult={(result) => {
          latest = result;
        }}
      />,
    );
  });
}

async function unmountProbe() {
  if (!root) return;
  await act(async () => {
    root!.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
}

beforeEach(() => {
  queryTraces = vi.fn(async (): Promise<TracePage> => page([]));
  unsubscribeTrace = vi.fn();
  traceListener = undefined;
  onTraceEvent = vi.fn((listener: (event: TraceEvent) => void) => {
    traceListener = listener;
    return unsubscribeTrace;
  });
  window.spire = { queryTraces, onTraceEvent } as unknown as SpireApi;
});

afterEach(async () => {
  consoleErrorSpy?.mockRestore();
  consoleErrorSpy = undefined;
  await unmountProbe();
  document.body.innerHTML = "";
});

describe("useNodeTraces (scoped live trace hook)", () => {
  it("fetches the initial page with exactly the scoped filter", async () => {
    const scoped = { runId: "run-1", nodeId: "node-1" };
    queryTraces.mockResolvedValue(page([makeEvent(1, scoped)]));
    await renderProbe("run-1", "node-1");

    expect(queryTraces).toHaveBeenCalledTimes(1);
    expect(queryTraces).toHaveBeenCalledWith({
      runId: "run-1",
      nodeId: "node-1",
      limit: 1000,
    });
    expect(latest!.loading).toBe(false);
    expect(latest!.events.map((event) => event.sequence)).toEqual([1]);
  });

  it("follows next cursors up to two more pages, ascending and deduped", async () => {
    const scoped = { runId: "run-1", nodeId: "node-1" };
    queryTraces
      .mockResolvedValueOnce(
        page([makeEvent(1, scoped), makeEvent(2, scoped)], {
          afterSequence: 2,
        }),
      )
      .mockResolvedValueOnce(
        page([makeEvent(2, scoped), makeEvent(3, scoped)], {
          afterSequence: 3,
        }),
      )
      .mockResolvedValueOnce(page([makeEvent(4, scoped)], null));
    await renderProbe("run-1", "node-1");

    expect(queryTraces).toHaveBeenCalledTimes(3);
    expect(queryTraces).toHaveBeenNthCalledWith(1, {
      runId: "run-1",
      nodeId: "node-1",
      limit: 1000,
    });
    expect(queryTraces).toHaveBeenNthCalledWith(2, {
      runId: "run-1",
      nodeId: "node-1",
      limit: 1000,
      cursor: { afterSequence: 2 },
    });
    expect(queryTraces).toHaveBeenNthCalledWith(3, {
      runId: "run-1",
      nodeId: "node-1",
      limit: 1000,
      cursor: { afterSequence: 3 },
    });
    expect(latest!.events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("appends matching live events from the subscription", async () => {
    await renderProbe("run-1", "node-1");
    expect(latest!.events).toEqual([]);

    act(() => {
      traceListener!(
        makeEvent(7, { runId: "run-1", nodeId: "node-1" }),
      );
    });

    expect(latest!.events.map((event) => event.sequence)).toEqual([7]);
    expect(container!.textContent).toContain("#7");
  });

  it("ignores live events for a different run or node", async () => {
    await renderProbe("run-1", "node-1");

    act(() => {
      traceListener!(makeEvent(3, { runId: "run-other", nodeId: "node-1" }));
      traceListener!(makeEvent(4, { runId: "run-1", nodeId: "node-other" }));
      // Global event: both fields undefined.
      traceListener!(makeEvent(5));
    });

    expect(latest!.events).toEqual([]);
    expect(container!.textContent).not.toContain("#3");
    expect(container!.textContent).not.toContain("#4");
    expect(container!.textContent).not.toContain("#5");
  });

  it("unsubscribes from trace events on unmount", async () => {
    await renderProbe("run-1", "node-1");
    expect(onTraceEvent).toHaveBeenCalledTimes(1);
    expect(unsubscribeTrace).not.toHaveBeenCalled();

    await unmountProbe();
    expect(unsubscribeTrace).toHaveBeenCalledTimes(1);
  });

  it("does not fetch or subscribe when runId is undefined", async () => {
    await renderProbe(undefined, "node-1");

    expect(queryTraces).not.toHaveBeenCalled();
    expect(onTraceEvent).not.toHaveBeenCalled();
    expect(latest!.loading).toBe(false);
    expect(latest!.events).toEqual([]);
  });

  it("recovers when the initial query rejects: loading false, no crash", async () => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    queryTraces.mockRejectedValue(new Error("journal unavailable"));
    await renderProbe("run-1", "node-1");

    expect(latest!.loading).toBe(false);
    expect(latest!.events).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("preserves a live event that arrives while the initial fetch is pending", async () => {
    const scoped = { runId: "run-1", nodeId: "node-1" };
    let resolveQuery!: (value: TracePage) => void;
    queryTraces.mockReturnValue(
      new Promise<TracePage>((resolve) => {
        resolveQuery = resolve;
      }),
    );

    await renderProbe("run-1", "node-1");
    expect(latest!.loading).toBe(true);

    // Live event fires while the query promise is still pending.
    act(() => {
      traceListener!(makeEvent(9, scoped));
    });
    expect(latest!.events.map((event) => event.sequence)).toEqual([9]);

    // Now the fetch resolves with its own (older) events.
    await act(async () => {
      resolveQuery(page([makeEvent(1, scoped), makeEvent(2, scoped)]));
    });

    // Both the fetched events AND the live event survive the resolution.
    expect(latest!.loading).toBe(false);
    expect(latest!.events.map((event) => event.sequence)).toEqual([1, 2, 9]);
  });
});
