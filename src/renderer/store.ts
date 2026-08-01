import { create } from "zustand";
import type {
  AppSnapshot,
  GraphDefinition,
  GraphDefinitionV2,
  GraphEdge,
  GraphGroup,
  GraphNode,
  HarnessId,
  ModelOption,
  RunEvent,
} from "../shared/domain";
import type {
  AppliedPlanPatch,
  ExecutionPlan,
  NodeExecution,
  PlanPatchDraft,
} from "../shared/execution";
import type {
  GraphValidation,
  HarnessStatus,
  SendMessageInput,
} from "../shared/control";
import { CONTROL_PAGE_MAX_LIMIT } from "../shared/control";
import type { CollaborationMessage } from "../shared/collaboration";
import type {
  TraceCursor,
  TraceEvent,
  TraceFilter,
  TraceLevel,
  TracePage,
  TracePrevCursor,
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

export type GraphLike = GraphDefinition | GraphDefinitionV2;

export function isGraphV2(graph: GraphLike): graph is GraphDefinitionV2 {
  return "maxSteps" in graph;
}

type AppState = {
  snapshot?: AppSnapshot;
  graph?: GraphLike;
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
  /** Backward cursor for paging older history; undefined until exhausted/started. */
  traceBackfillCursor?: TracePrevCursor;
  traceHasOlder: boolean;
  traceLoading: boolean;
  traceFilters: TraceFilters;
  /** Live execution plan for the selected run (v2 runtime state overlay). */
  plan?: ExecutionPlan;
  planLoading: boolean;
  /** Applied plan patches for the selected run. */
  planPatches: AppliedPlanPatch[];
  /** Node execution states from runs.nodes.list. */
  nodeExecutions: NodeExecution[];
  nodeExecutionsLoading: boolean;
  nodeExecutionsHasMore: boolean;
  nodeExecutionsCursor?: string | null;
  /** Collaboration messages from runs.messages.list. */
  messages: CollaborationMessage[];
  messagesLoading: boolean;
  messagesHasMore: boolean;
  messagesCursor?: string | null;
  /** Harness statuses from harnesses.list. */
  harnesses: HarnessStatus[];
  /** Model options cached per harness id from harnesses.models. */
  harnessModels: Record<string, ModelOption[]>;
  harnessLoading: boolean;
  /** Latest graph validation result. */
  validationResult?: GraphValidation;
  /** Patch id selected for before/after diff view. */
  selectedPatchId?: string;
  /** Group ids collapsed on the canvas. */
  collapsedGroups: string[];
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  applySnapshot(snapshot: AppSnapshot): void;
  receiveEvent(event: RunEvent): Promise<void>;
  loadInitialTraces(): Promise<void>;
  loadOlderTraces(): Promise<void>;
  catchUpTraces(): Promise<void>;
  receiveTraceEvent(event: TraceEvent): void;
  setTraceFilters(filters: TraceFilters): Promise<void>;
  selectGraph(graph: GraphLike): void;
  updateGraph(graph: GraphLike): void;
  selectNode(id?: string): void;
  selectRun(id?: string): void;
  setRepositoryPath(value: string): void;
  setGoal(value: string): void;
  setBusy(value: boolean): void;
  setError(value?: string): void;
  /** Control: graphs.validate */
  validateGraph(graph: Record<string, unknown>): Promise<GraphValidation>;
  /** Control: runs.plan.get — fetches the live plan for the selected run. */
  loadPlan(): Promise<void>;
  /** Control: runs.nodes.list — fetches node executions for the selected run. */
  loadNodeExecutions(): Promise<void>;
  /** Control: runs.messages.list — fetches collaboration messages for the selected run. */
  loadMessages(): Promise<void>;
  /** Control: runs.messages.send — sends a collaboration message. */
  sendMessage(
    draft: Pick<
      SendMessageInput,
      "recipient" | "kind" | "subject" | "body" | "artifactPaths"
    >,
  ): Promise<void>;
  /** Control: runs.plan.patch — applies a plan patch. */
  applyPlanPatch(
    draft: PlanPatchDraft,
    actorNodeId: string,
  ): Promise<AppliedPlanPatch>;
  /** Control: runs.plan.rollback — rolls back an applied patch. */
  rollbackPlanPatch(patchId: string): Promise<AppliedPlanPatch>;
  /** Control: runs.checkpoint.resume — resumes from a checkpoint. */
  resumeCheckpoint(): Promise<void>;
  /** Control: runs.plan.promote — promotes the live plan as a graph version. */
  promotePlan(name?: string): Promise<GraphDefinitionV2>;
  /** Control: harnesses.list — fetches all harness statuses. */
  loadHarnesses(): Promise<void>;
  /** Control: harnesses.models — fetches models for a harness. */
  loadHarnessModels(harnessId: HarnessId): Promise<ModelOption[]>;
  /** Palette: inserts a v2 node into the current graph. */
  addNode(node: GraphNode): void;
  /** Removes a node and its connected edges. */
  removeNode(nodeId: string): void;
  /** Updates a node's fields in the current graph. */
  updateNode(nodeId: string, patch: Partial<GraphNode>): void;
  /** Adds an edge between two nodes. */
  addEdge(edge: GraphEdge): void;
  /** Removes an edge. */
  removeEdge(edgeId: string): void;
  /** Adds a group to the current v2 graph. */
  addGroup(group: GraphGroup): void;
  /** Removes a group. */
  removeGroup(groupId: string): void;
  /** Toggles group collapse on the canvas. */
  collapseGroup(groupId: string): void;
  /** Selects a patch for before/after diff viewing. */
  selectPatch(patchId?: string): void;
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
  plan: undefined,
  planLoading: false,
  planPatches: [],
  nodeExecutions: [],
  nodeExecutionsLoading: false,
  nodeExecutionsHasMore: false,
  nodeExecutionsCursor: undefined,
  messages: [],
  messagesLoading: false,
  messagesHasMore: false,
  messagesCursor: undefined,
  harnesses: [],
  harnessModels: {},
  harnessLoading: false,
  validationResult: undefined,
  selectedPatchId: undefined,
  collapsedGroups: [],
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
    // Preserve a v2 graph (e.g. from promote) that isn't stored in the v1
    // snapshot; fall back to the latest known v1 graph otherwise.
    const graph = currentGraph ?? latestGraph(snapshot.graphs) ?? current.graph;
    const selectedRunId =
      snapshot.activeRunId ??
      (current.selectedRunId &&
      snapshot.runs.some((run) => run.id === current.selectedRunId)
        ? current.selectedRunId
        : snapshot.runs[0]?.id);
    set({ snapshot, graph, selectedRunId });
  },
  async receiveEvent(event) {
    await get().refresh();
    // When a run event arrives for the selected run, refresh the live plan
    // so the canvas can overlay runtime state (queued/running/succeeded/…).
    if (event.runId && event.runId === get().selectedRunId) {
      await get().loadPlan();
    }
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
  async validateGraph(graph) {
    const result = await window.spire.graphsValidate(graph);
    set({ validationResult: result });
    return result;
  },
  async loadPlan() {
    const runId = get().selectedRunId;
    if (!runId) return;
    set({ planLoading: true });
    try {
      const plan = await window.spire.runsPlanGet(runId);
      set({ plan, planPatches: plan.patches });
    } catch (error) {
      traceError(error);
    } finally {
      set({ planLoading: false });
    }
  },
  async loadNodeExecutions() {
    const runId = get().selectedRunId;
    if (!runId) return;
    if (get().nodeExecutionsLoading) return;
    set({ nodeExecutionsLoading: true });
    try {
      const page = await window.spire.runsNodesList({
        runId,
        limit: CONTROL_PAGE_MAX_LIMIT,
        cursor: get().nodeExecutionsCursor ?? undefined,
      });
      set((state) => ({
        nodeExecutions: [...state.nodeExecutions, ...page.nodes],
        nodeExecutionsHasMore: page.nextCursor !== null,
        nodeExecutionsCursor: page.nextCursor,
      }));
    } catch (error) {
      traceError(error);
    } finally {
      set({ nodeExecutionsLoading: false });
    }
  },
  async loadMessages() {
    const runId = get().selectedRunId;
    if (!runId) return;
    if (get().messagesLoading) return;
    set({ messagesLoading: true });
    try {
      const page = await window.spire.runsMessagesList({
        runId,
        limit: CONTROL_PAGE_MAX_LIMIT,
        cursor: get().messagesCursor ?? undefined,
      });
      set((state) => ({
        messages: [...state.messages, ...page.messages],
        messagesHasMore: page.nextCursor !== null,
        messagesCursor: page.nextCursor,
      }));
    } catch (error) {
      traceError(error);
    } finally {
      set({ messagesLoading: false });
    }
  },
  async sendMessage(draft) {
    const runId = get().selectedRunId;
    if (!runId) return;
    const senderNodeId = get().selectedNodeId ?? "planner";
    await window.spire.runsMessagesSend({
      ...draft,
      runId,
      senderNodeId,
    });
  },
  async applyPlanPatch(draft, actorNodeId) {
    const runId = get().selectedRunId;
    if (!runId) throw new Error("No run selected.");
    const applied = await window.spire.runsPlanPatch({
      runId,
      actorNodeId,
      draft,
    });
    set((state) => ({
      planPatches: state.planPatches.map((patch) =>
        patch.id === applied.id ? applied : patch,
      ).concat(applied),
    }));
    return applied;
  },
  async rollbackPlanPatch(patchId) {
    const runId = get().selectedRunId;
    if (!runId) throw new Error("No run selected.");
    const applied = await window.spire.runsPlanRollback({ runId, patchId });
    set((state) => ({
      planPatches: state.planPatches.map((patch) =>
        patch.id === patchId ? applied : patch,
      ),
    }));
    return applied;
  },
  async resumeCheckpoint() {
    const runId = get().selectedRunId;
    if (!runId) return;
    set({ planLoading: true });
    try {
      const plan = await window.spire.runsCheckpointResume(runId);
      set({ plan, planPatches: plan.patches });
    } catch (error) {
      traceError(error);
    } finally {
      set({ planLoading: false });
    }
  },
  async promotePlan(name) {
    const runId = get().selectedRunId;
    if (!runId) throw new Error("No run selected.");
    const v2 = await window.spire.runsPlanPromote({ runId, name });
    set({ graph: v2, selectedNodeId: undefined, selectedPatchId: undefined });
    return v2;
  },
  async loadHarnesses() {
    set({ harnessLoading: true });
    try {
      const harnesses = await window.spire.harnessesList();
      set({ harnesses: harnesses ?? [] });
    } catch (error) {
      traceError(error);
    } finally {
      set({ harnessLoading: false });
    }
  },
  async loadHarnessModels(harnessId) {
    const models = await window.spire.harnessesModels(harnessId);
    set((state) => ({
      harnessModels: { ...state.harnessModels, [harnessId]: models },
    }));
    return models;
  },
  addNode(node) {
    const graph = get().graph;
    if (!graph || !isGraphV2(graph)) return;
    set({
      graph: { ...graph, nodes: [...graph.nodes, node] },
      selectedNodeId: node.id,
    });
  },
  removeNode(nodeId) {
    const graph = get().graph;
    if (!graph || !isGraphV2(graph)) return;
    set({
      graph: {
        ...graph,
        nodes: graph.nodes.filter((node) => node.id !== nodeId),
        edges: graph.edges.filter(
          (edge) => edge.source !== nodeId && edge.target !== nodeId,
        ),
      },
      selectedNodeId: get().selectedNodeId === nodeId ? undefined : get().selectedNodeId,
    });
  },
  updateNode(nodeId, patch) {
    const graph = get().graph;
    if (!graph || !isGraphV2(graph)) return;
    set({
      graph: {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === nodeId ? ({ ...node, ...patch } as GraphNode) : node,
        ),
      },
    });
  },
  addEdge(edge) {
    const graph = get().graph;
    if (!graph || !isGraphV2(graph)) return;
    set({ graph: { ...graph, edges: [...graph.edges, edge] } });
  },
  removeEdge(edgeId) {
    const graph = get().graph;
    if (!graph || !isGraphV2(graph)) return;
    set({
      graph: { ...graph, edges: graph.edges.filter((edge) => edge.id !== edgeId) },
    });
  },
  addGroup(group) {
    const graph = get().graph;
    if (!graph || !isGraphV2(graph)) return;
    set({ graph: { ...graph, groups: [...graph.groups, group] } });
  },
  removeGroup(groupId) {
    const graph = get().graph;
    if (!graph || !isGraphV2(graph)) return;
    set({
      graph: {
        ...graph,
        groups: graph.groups.filter((group) => group.id !== groupId),
      },
      collapsedGroups: get().collapsedGroups.filter((id) => id !== groupId),
    });
  },
  collapseGroup(groupId) {
    set((state) => {
      const collapsed = state.collapsedGroups.includes(groupId);
      return {
        collapsedGroups: collapsed
          ? state.collapsedGroups.filter((id) => id !== groupId)
          : [...state.collapsedGroups, groupId],
      };
    });
  },
  selectPatch(patchId) {
    set({ selectedPatchId: patchId });
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
      // Backward paging: with no backfill cursor this fetches the newest page
      // (journal tail); afterwards it walks back via the page's prevCursor.
      const filter: TraceFilter = {
        ...toTraceFilter(state.traceFilters),
        limit: TRACE_PAGE_SIZE,
        direction: "backward",
      };
      if (state.traceBackfillCursor) {
        filter.beforeSequence = state.traceBackfillCursor.beforeSequence;
      }
      const page = await window.spire.queryTraces(filter);
      mergePage(page);
      set({
        traceBackfillCursor: page.prevCursor ?? undefined,
        traceHasOlder: (page.prevCursor ?? null) !== null,
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
