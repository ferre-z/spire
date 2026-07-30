// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpireApi } from "../../shared/api";
import type { TraceEvent, TracePage } from "../../shared/trace";
import {
  TRACE_PAGE_SIZE,
  TRACE_WINDOW_LIMIT,
  useAppStore,
} from "../store";
import { LiveStreamPane } from "./LiveStreamPane";

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

function page(events: TraceEvent[], nextCursor: TracePage["nextCursor"] = null) {
  return { events, nextCursor };
}

let queryTraces: ReturnType<typeof vi.fn>;
let onTraceEvent: ReturnType<typeof vi.fn>;
let unsubscribeTrace: ReturnType<typeof vi.fn>;
let traceListener: ((event: TraceEvent) => void) | undefined;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function renderPane() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<LiveStreamPane />);
  });
}

async function unmountPane() {
  if (!root) return;
  await act(async () => {
    root!.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
}

function rows(): NodeListOf<Element> {
  return container!.querySelectorAll(".event-row");
}

function findButton(label: string): HTMLButtonElement {
  const button = [...container!.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  expect(button, `button containing "${label}"`).toBeDefined();
  return button!;
}

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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
  useAppStore.setState({
    traceWindow: [],
    traceCursor: null,
    traceBackfillCursor: undefined,
    traceHasOlder: true,
    traceLoading: false,
    traceFilters: {},
  });
});

afterEach(async () => {
  await unmountPane();
  document.body.innerHTML = "";
});

describe("LiveStreamPane (trace journal)", () => {
  it("loads the first page of trace history on mount", async () => {
    queryTraces.mockResolvedValue(
      page([makeEvent(1), makeEvent(2)], { afterSequence: 2 }),
    );
    await renderPane();

    expect(queryTraces).toHaveBeenCalledTimes(1);
    expect(queryTraces).toHaveBeenCalledWith({ limit: TRACE_PAGE_SIZE });
    expect(rows()).toHaveLength(2);
    expect(container!.textContent).toContain("event 1");
    expect(container!.textContent).toContain("event 2");
  });

  it("loads older rows on demand using the page cursor", async () => {
    queryTraces
      .mockResolvedValueOnce(
        page([makeEvent(1), makeEvent(2)], { afterSequence: 2 }),
      )
      .mockResolvedValueOnce(page([makeEvent(3)]));

    await renderPane();
    const loadOlder = findButton("Load older");
    expect(loadOlder.disabled).toBe(false);

    await act(async () => {
      loadOlder.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(queryTraces).toHaveBeenCalledTimes(2);
    expect(queryTraces).toHaveBeenLastCalledWith({
      limit: TRACE_PAGE_SIZE,
      cursor: { afterSequence: 2 },
    });
    expect(rows()).toHaveLength(3);
    // The journal reports no further history, so the button is disabled.
    expect(findButton("Load older").disabled).toBe(true);
  });

  it("appends live events from the trace subscription", async () => {
    await renderPane();
    expect(onTraceEvent).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(0);

    act(() => {
      traceListener!(makeEvent(7));
    });

    expect(rows()).toHaveLength(1);
    expect(container!.textContent).toContain("event 7");
    expect(useAppStore.getState().traceCursor).toEqual({ afterSequence: 7 });
  });

  it("advances the cursor but skips live events that fail the filters", async () => {
    useAppStore.setState({ traceFilters: { level: "error" } });
    await renderPane();

    act(() => {
      traceListener!(makeEvent(8, { level: "info" }));
    });

    expect(rows()).toHaveLength(0);
    expect(useAppStore.getState().traceCursor).toEqual({ afterSequence: 8 });
  });

  it("unsubscribes from trace events on unmount", async () => {
    await renderPane();
    await unmountPane();
    expect(unsubscribeTrace).toHaveBeenCalledTimes(1);
  });

  it("reconnects from the preserved cursor after a remount", async () => {
    queryTraces.mockResolvedValue(
      page([makeEvent(1), makeEvent(2)], { afterSequence: 2 }),
    );
    await renderPane();
    await unmountPane();

    queryTraces.mockClear();
    queryTraces.mockResolvedValue(page([makeEvent(3)]));
    await renderPane();

    // The remount must not restart history from scratch: it catches up from
    // the last seen sequence and keeps the previously rendered window.
    expect(queryTraces).toHaveBeenCalledTimes(1);
    expect(queryTraces).toHaveBeenCalledWith({
      limit: TRACE_PAGE_SIZE,
      cursor: { afterSequence: 2 },
    });
    expect(rows()).toHaveLength(3);
    expect(container!.textContent).toContain("event 1");
    expect(container!.textContent).toContain("event 3");
  });

  it("renders already-redacted payload values as [REDACTED]", async () => {
    queryTraces.mockResolvedValue(
      page([
        makeEvent(1, {
          payload: { apiKey: "[REDACTED]", note: "visible" },
        }),
      ]),
    );
    await renderPane();

    expect(container!.textContent).toContain("[REDACTED]");
    expect(container!.textContent).toContain("visible");
  });

  it("sends server-side filters with the query", async () => {
    await renderPane();
    queryTraces.mockClear();

    await act(async () => {
      await useAppStore
        .getState()
        .setTraceFilters({ runId: "run-1", level: "error", kind: "run.stop" });
    });

    expect(queryTraces).toHaveBeenCalledWith({
      runId: "run-1",
      level: "error",
      kind: "run.stop",
      limit: TRACE_PAGE_SIZE,
    });
  });

  it("applies the free-text filter client-side without sending it", async () => {
    await renderPane();
    queryTraces.mockClear();
    queryTraces.mockResolvedValue(
      page([makeEvent(1, { message: "has needle inside" }), makeEvent(2)]),
    );

    await act(async () => {
      await useAppStore.getState().setTraceFilters({ text: "needle" });
    });

    expect(queryTraces).toHaveBeenCalledWith({ limit: TRACE_PAGE_SIZE });
    expect(rows()).toHaveLength(1);
    expect(container!.textContent).toContain("has needle inside");
    expect(container!.textContent).not.toContain("event 2");
  });

  it("applies filter form input through the UI", async () => {
    await renderPane();
    queryTraces.mockClear();
    queryTraces.mockResolvedValue(page([makeEvent(9, { runId: "run-9" })]));

    const input = container!.querySelector<HTMLInputElement>(
      'input[aria-label="Filter by run"]',
    )!;
    expect(input).toBeDefined();
    act(() => {
      changeInput(input, "run-9");
    });
    const form = container!.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(queryTraces).toHaveBeenCalledWith({
      runId: "run-9",
      limit: TRACE_PAGE_SIZE,
    });
    expect(container!.textContent).toContain("event 9");
  });

  it("keeps at most TRACE_WINDOW_LIMIT rendered rows", async () => {
    const full = Array.from({ length: TRACE_WINDOW_LIMIT }, (_, index) =>
      makeEvent(index + 1),
    );
    useAppStore.setState({
      traceWindow: full,
      traceCursor: { afterSequence: TRACE_WINDOW_LIMIT },
    });

    act(() => {
      useAppStore.getState().receiveTraceEvent(makeEvent(TRACE_WINDOW_LIMIT + 1));
    });

    const window = useAppStore.getState().traceWindow;
    expect(window).toHaveLength(TRACE_WINDOW_LIMIT);
    expect(window[0].sequence).toBe(2);
    expect(window[window.length - 1].sequence).toBe(TRACE_WINDOW_LIMIT + 1);
    expect(useAppStore.getState().traceCursor).toEqual({
      afterSequence: TRACE_WINDOW_LIMIT + 1,
    });
  });

  it("copies an event as JSON", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    queryTraces.mockResolvedValue(page([makeEvent(4)]));
    await renderPane();

    const copy = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy event JSON"]',
    )!;
    expect(copy).toBeDefined();
    await act(async () => {
      copy.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = JSON.parse(writeText.mock.calls[0][0]) as TraceEvent;
    expect(copied).toEqual(makeEvent(4));
  });

  it("navigates to a correlation id by filtering the stream", async () => {
    queryTraces.mockResolvedValue(
      page([makeEvent(1, { correlationId: "corr-target" })]),
    );
    await renderPane();
    queryTraces.mockClear();
    queryTraces.mockResolvedValue(
      page([makeEvent(1, { correlationId: "corr-target" })]),
    );

    const correlation = container!.querySelector<HTMLButtonElement>(
      ".trace-correlation",
    )!;
    expect(correlation.textContent).toContain("corr-target");
    await act(async () => {
      correlation.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useAppStore.getState().traceFilters.correlationId).toBe(
      "corr-target",
    );
    expect(queryTraces).toHaveBeenCalledWith({
      correlationId: "corr-target",
      limit: TRACE_PAGE_SIZE,
    });
  });
});
