import { create } from "zustand";
import type {
  AppSnapshot,
  GraphDefinition,
  RunEvent,
} from "../shared/domain";
import type {
  TraceCursor,
  TraceEvent,
  TraceFilter,
  TraceLevel,
  TracePage,
} from "../shared/trace";

/** Maximum number of trace rows kept in the rendered window. */
export const TRACE_WINDOW_LIMIT = 5000;
/** Page size for journal pagination (within TRACE_QUERY_MAX_LIMIT). */
export const TRACE_PAGE_SIZE = 200;

/** Pane-level filters; `text` is applied client-side (the journal has no text index). */
export type TraceFilters = {
  runId?: string;
  nodeId?: string;
  subsystem?: string;
  level?: TraceLevel;
  kind?: string;
  correlationId?: string;
  text?: string;
};

export function matchesTraceFilters(
  event: TraceEvent,
  filters: TraceFilters,
): boolean {
  if (filters.runId && event.runId !== filters.runId) return false;
  if (filters.nodeId && event.nodeId !== filters.nodeId) return false;
  if (filters.subsystem && event.subsystem !== filters.subsystem) return false;
  if (filters.level && event.level !== filters.level) return false;
  if (filters.kind && event.kind !== filters.kind) return false;
  if (
    filters.correlationId &&
    event.correlationId !== filters.correlationId
  ) {
    return false;
  }
  if (filters.text) {
    const needle = filters.text.toLowerCase();
    const payload =
      event.payload === undefined
        ? ""
        : JSON.stringify(event.payload).toLowerCase();
    if (
      !event.message.toLowerCase().includes(needle) &&
      !payload.includes(needle)
    ) {
      return false;
    }
  }
  return true;
}

/** Server-side portion of the pane filters (free text stays client-side). */
function toTraceFilter(filters: TraceFilters): TraceFilter {
  const filter: TraceFilter = {};
  if (filters.runId) filter.runId = filters.runId;
  if (filters.nodeId) filter.nodeId = filters.nodeId;
  if (filters.subsystem) filter.subsystem = filters.subsystem;
  if (filters.level) filter.level = filters.level;
  if (filters.kind) filter.kind = filters.kind;
  if (filters.correlationId) filter.correlationId = filters.correlationId;
  return filter;
}

/**
 * Merges incoming events into the rendered window: deduplicated by sequence,
 * ascending, client-side filters applied, capped at TRACE_WINDOW_LIMIT by
 * dropping the oldest rows. Persisted traces stay in the journal — this
 * window is the only copy held in the store.
 */
function mergeTraceEvents(
  current: TraceEvent[],
  incoming: TraceEvent[],
  filters: TraceFilters,
): TraceEvent[] {
  const accepted = incoming.filter((event) =>
    matchesTraceFilters(event, filters),
  );
  if (accepted.length === 0) return current;
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of accepted) bySequence.set(event.sequence, event);
  const merged = [...bySequence.values()].sort(
    (a, b) => a.sequence - b.sequence,
  );
  return merged.length > TRACE_WINDOW_LIMIT
    ? merged.slice(merged.length - TRACE_WINDOW_LIMIT)
    : merged;
}

type AppState = {
  snapshot?: AppSnapshot;
  graph?: GraphDefinition;
  selectedNodeId?: string;
  selectedRunId?: string;
  repositoryPath: string;
  goal: string;
  busy: boolean;
  error?: string;
  /** Rendered trace window (ascending, capped at TRACE_WINDOW_LIMIT). */
  traceWindow: TraceEvent[];
  /** Newest journal sequence seen; survives pane remounts for reconnect. */
  traceCursor: TraceCursor | null;
  /** Forward cursor for paging older history; undefined until exhausted/started. */
  traceBackfillCursor?: TraceCursor;
  traceHasOlder: boolean;
  traceLoading: boolean;
  traceFilters: TraceFilters;
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  applySnapshot(snapshot: AppSnapshot): void;
  receiveEvent(event: RunEvent): Promise<void>;
  loadInitialTraces(): Promise<void>;
  loadOlderTraces(): Promise<void>;
  catchUpTraces(): Promise<void>;
  receiveTraceEvent(event: TraceEvent): void;
  setTraceFilters(filters: TraceFilters): Promise<void>;
  selectGraph(graph: GraphDefinition): void;
  updateGraph(graph: GraphDefinition): void;
  selectNode(id?: string): void;
  selectRun(id?: string): void;
  setRepositoryPath(value: string): void;
  setGoal(value: string): void;
  setBusy(value: boolean): void;
  setError(value?: string): void;
};

function latestGraph(graphs: GraphDefinition[]): GraphDefinition | undefined {
  return [...graphs].sort((a, b) => b.version - a.version)[0];
}

export const useAppStore = create<AppState>((set, get) => {
  /** Merge a journal page into the window and advance the live cursor. */
  function mergePage(page: TracePage): void {
    const state = get();
    const traceWindow = mergeTraceEvents(
      state.traceWindow,
      page.events,
      state.traceFilters,
    );
    const newest = page.events.reduce(
      (max, event) => Math.max(max, event.sequence),
      state.traceCursor?.afterSequence ?? 0,
    );
    set({
      traceWindow,
      traceCursor: newest > 0 ? { afterSequence: newest } : state.traceCursor,
    });
  }

  function traceError(error: unknown): void {
    get().setError(error instanceof Error ? error.message : String(error));
  }

  return {
  repositoryPath: "",
  goal: "",
  busy: false,
  traceWindow: [],
  traceCursor: null,
  traceBackfillCursor: undefined,
  traceHasOlder: true,
  traceLoading: false,
  traceFilters: {},
  async initialize() {
    try {
      const snapshot = await window.spire.snapshot();
      get().applySnapshot(snapshot);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  async refresh() {
    const snapshot = await window.spire.snapshot();
    get().applySnapshot(snapshot);
  },
  applySnapshot(snapshot) {
    const current = get();
    const currentGraph = current.graph
      ? snapshot.graphs
          .filter((item) => item.id === current.graph!.id)
          .sort((a, b) => b.version - a.version)[0]
      : undefined;
    const graph = currentGraph ?? latestGraph(snapshot.graphs);
    const selectedRunId =
      snapshot.activeRunId ??
      (current.selectedRunId &&
      snapshot.runs.some((run) => run.id === current.selectedRunId)
        ? current.selectedRunId
        : snapshot.runs[0]?.id);
    set({ snapshot, graph, selectedRunId });
  },
  async receiveEvent() {
    await get().refresh();
  },
  selectGraph(graph) {
    set({ graph, selectedNodeId: undefined });
  },
  updateGraph(graph) {
    set({ graph });
  },
  selectNode(selectedNodeId) {
    set({ selectedNodeId });
  },
  selectRun(selectedRunId) {
    set({ selectedRunId });
  },
  setRepositoryPath(repositoryPath) {
    set({ repositoryPath });
  },
  setGoal(goal) {
    set({ goal });
  },
  setBusy(busy) {
    set({ busy });
  },
  setError(error) {
    set({ error });
  },
  async loadInitialTraces() {
    if (get().traceLoading) return;
    // Reconnect from the preserved cursor on remount; otherwise page history.
    if (get().traceCursor) {
      await get().catchUpTraces();
    } else {
      await get().loadOlderTraces();
    }
  },
  async loadOlderTraces() {
    const state = get();
    if (state.traceLoading || !state.traceHasOlder) return;
    set({ traceLoading: true });
    try {
      const filter: TraceFilter = {
        ...toTraceFilter(state.traceFilters),
        limit: TRACE_PAGE_SIZE,
      };
      if (state.traceBackfillCursor) filter.cursor = state.traceBackfillCursor;
      const page = await window.spire.queryTraces(filter);
      mergePage(page);
      set({
        traceBackfillCursor: page.nextCursor ?? undefined,
        traceHasOlder: page.nextCursor !== null,
      });
    } catch (error) {
      traceError(error);
    } finally {
      set({ traceLoading: false });
    }
  },
  async catchUpTraces() {
    const cursor = get().traceCursor;
    if (!cursor || get().traceLoading) return;
    set({ traceLoading: true });
    try {
      let after: TraceCursor | undefined = cursor;
      while (after) {
        const page = await window.spire.queryTraces({
          ...toTraceFilter(get().traceFilters),
          limit: TRACE_PAGE_SIZE,
          cursor: after,
        });
        mergePage(page);
        after = page.nextCursor ?? undefined;
      }
    } catch (error) {
      traceError(error);
    } finally {
      set({ traceLoading: false });
    }
  },
  receiveTraceEvent(event) {
    const state = get();
    const traceCursor = {
      afterSequence: Math.max(
        state.traceCursor?.afterSequence ?? 0,
        event.sequence,
      ),
    };
    if (!matchesTraceFilters(event, state.traceFilters)) {
      // The cursor still advances: filtered-out events must not be
      // re-fetched by a later reconnect.
      set({ traceCursor });
      return;
    }
    set({
      traceWindow: mergeTraceEvents(state.traceWindow, [event], state.traceFilters),
      traceCursor,
    });
  },
  async setTraceFilters(traceFilters) {
    set({
      traceFilters,
      traceWindow: [],
      traceCursor: null,
      traceBackfillCursor: undefined,
      traceHasOlder: true,
      traceLoading: false,
    });
    await get().loadOlderTraces();
  },
  };
});
