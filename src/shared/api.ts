import type {
  AppSnapshot,
  GraphDefinition,
  ProviderInput,
  RunEvent,
  StartRunInput,
} from "./domain";

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
  onRunEvent(listener: (event: RunEvent) => void): Unsubscribe;
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
  runEvent: "spire:run-event",
} as const;
