import type {
  AppSnapshot,
  GraphDefinition,
  GraphDefinitionV2,
  ProviderInput,
  RunEvent,
  StartRunInput,
} from "./domain";
import type {
  AppliedPlanPatch,
  ExecutionPlan,
} from "./execution";
import type {
  GraphValidation,
  MessagePage,
  NodeExecutionPage,
  PlanPatchInput,
  PlanPromoteInput,
  PlanRollbackInput,
  RunScopedPageInput,
  SendMessageInput,
  SentMessage,
} from "./control";
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
  graphsValidate(graph: Record<string, unknown>): Promise<GraphValidation>;
  runsPlanGet(runId: string): Promise<ExecutionPlan>;
  runsNodesList(input: RunScopedPageInput): Promise<NodeExecutionPage>;
  runsMessagesList(input: RunScopedPageInput): Promise<MessagePage>;
  runsMessagesSend(input: SendMessageInput): Promise<SentMessage>;
  runsPlanPatch(input: PlanPatchInput): Promise<AppliedPlanPatch>;
  runsPlanRollback(input: PlanRollbackInput): Promise<AppliedPlanPatch>;
  runsCheckpointResume(runId: string): Promise<ExecutionPlan>;
  runsPlanPromote(input: PlanPromoteInput): Promise<GraphDefinitionV2>;
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
  graphsValidate: "spire:graphs-validate",
  runsPlanGet: "spire:runs-plan-get",
  runsNodesList: "spire:runs-nodes-list",
  runsMessagesList: "spire:runs-messages-list",
  runsMessagesSend: "spire:runs-messages-send",
  runsPlanPatch: "spire:runs-plan-patch",
  runsPlanRollback: "spire:runs-plan-rollback",
  runsCheckpointResume: "spire:runs-checkpoint-resume",
  runsPlanPromote: "spire:runs-plan-promote",
} as const;
