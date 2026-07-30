import type {
  AppSnapshot,
  GraphDefinition,
  ProviderInput,
  RunEvent,
  StartRunInput,
} from "./domain";
import type { TraceEvent, TraceFilter, TracePage } from "./trace";
import type {
  WorkspaceEnvironment,
  WorkspaceLayoutRecord,
} from "./workspace";

export type Unsubscribe = () => void;

export interface SpireApi {
  snapshot(): Promise<AppSnapshot>;
  detectOpenCode(): Promise<AppSnapshot>;
  connectOpenRouter(input: ProviderInput): Promise<AppSnapshot>;
  chooseRepository(): Promise<string | null>;
  saveGraph(graph: GraphDefinition): Promise<AppSnapshot>;
  startRun(input: StartRunInput): Promise<AppSnapshot>;
  stopRun(runId: string): Promise<AppSnapshot>;
  retryRun(runId: string): Promise<AppSnapshot>;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  exportPatch(runId: string): Promise<string | null>;
  cleanupWorktree(runId: string): Promise<AppSnapshot>;
  loadWorkspaceLayouts(graphId: string): Promise<WorkspaceLayoutRecord[]>;
  saveWorkspaceLayout(record: WorkspaceLayoutRecord): Promise<void>;
  resetWorkspaceLayouts(graphId: string): Promise<void>;
  environment(): Promise<WorkspaceEnvironment>;
  queryTraces(filter: TraceFilter): Promise<TracePage>;
  onRunEvent(listener: (event: RunEvent) => void): Unsubscribe;
  onTraceEvent(listener: (event: TraceEvent) => void): Unsubscribe;
}

export const IPC = {
  snapshot: "spire:snapshot",
  detectOpenCode: "spire:detect-opencode",
  connectOpenRouter: "spire:connect-openrouter",
  chooseRepository: "spire:choose-repository",
  saveGraph: "spire:save-graph",
  startRun: "spire:start-run",
  stopRun: "spire:stop-run",
  retryRun: "spire:retry-run",
  openExternal: "spire:open-external",
  revealPath: "spire:reveal-path",
  exportPatch: "spire:export-patch",
  cleanupWorktree: "spire:cleanup-worktree",
  loadWorkspaceLayouts: "spire:load-workspace-layouts",
  saveWorkspaceLayout: "spire:save-workspace-layout",
  resetWorkspaceLayouts: "spire:reset-workspace-layouts",
  environment: "spire:environment",
  queryTraces: "spire:query-traces",
  runEvent: "spire:run-event",
  traceEvent: "spire:trace-event",
} as const;
