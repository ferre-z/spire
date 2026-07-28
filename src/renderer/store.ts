import { create } from "zustand";
import type {
  AppSnapshot,
  GraphDefinition,
  RunEvent,
} from "../shared/domain";

type AppState = {
  snapshot?: AppSnapshot;
  graph?: GraphDefinition;
  selectedNodeId?: string;
  selectedRunId?: string;
  repositoryPath: string;
  goal: string;
  busy: boolean;
  error?: string;
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  applySnapshot(snapshot: AppSnapshot): void;
  receiveEvent(event: RunEvent): Promise<void>;
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

export const useAppStore = create<AppState>((set, get) => ({
  repositoryPath: "",
  goal: "",
  busy: false,
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
}));
