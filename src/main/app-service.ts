import type {
  AppSnapshot,
  GraphDefinition,
  ProviderInput,
  RunRecord,
  StartRunInput,
} from "../shared/domain";
import type { WorkspaceLayoutRecord } from "../shared/workspace";
import { SpireControl } from "./control/spire-control";
import type { SpireDatabase } from "./database";
import type { AgentHarness } from "./harness/opencode";
import type { RunEngine } from "./run-engine";
import type { ExecutionBackend } from "./worktree";

/**
 * Compatibility facade for the existing Electron IPC layer.
 *
 * All behavior lives in `SpireControl`; every method here delegates to it and,
 * where the renderer contract expects an `AppSnapshot`, composes the snapshot
 * exactly as before. Kept until the IPC adapter calls `SpireControl` directly.
 */
export class AppService {
  private readonly control: SpireControl;

  constructor(
    database: SpireDatabase,
    harness: AgentHarness,
    engine: RunEngine,
    backend: ExecutionBackend,
  ) {
    this.control = new SpireControl({
      database,
      engine,
      harness,
      backend,
      journal: database.createTraceJournal(),
    });
  }

  snapshot(): AppSnapshot {
    return this.control.snapshot();
  }

  detectOpenCode(): Promise<AppSnapshot> {
    return this.control.detectOpenCode();
  }

  connectOpenRouter(input: ProviderInput): Promise<AppSnapshot> {
    return this.control.connectOpenRouter(input);
  }

  async saveGraph(graph: GraphDefinition): Promise<AppSnapshot> {
    await this.control.execute("graphs.save", { graph });
    return this.control.snapshot();
  }

  async startRun(input: StartRunInput): Promise<AppSnapshot> {
    await this.control.execute("runs.start", input);
    return this.control.snapshot();
  }

  async stopRun(runId: string): Promise<AppSnapshot> {
    await this.control.execute("runs.stop", { runId });
    return this.control.snapshot();
  }

  async retryRun(runId: string): Promise<AppSnapshot> {
    await this.control.execute("runs.retry", { runId });
    return this.control.snapshot();
  }

  async cleanupWorktree(runId: string): Promise<AppSnapshot> {
    await this.control.execute("worktrees.cleanup", { runId });
    return this.control.snapshot();
  }

  getRun(runId: string): RunRecord | undefined {
    return this.control.getRun(runId);
  }

  listWorkspaceLayouts(graphId: string): Promise<WorkspaceLayoutRecord[]> {
    return this.control.execute("layouts.list", { graphId });
  }

  saveWorkspaceLayout(input: unknown): void {
    // The IPC handler does not await this call; layouts.save is synchronous,
    // so execute() throws validation errors synchronously to the renderer.
    // Log async failures instead of leaving an unhandled rejection.
    void this.control.execute("layouts.save", input).catch((error: unknown) => {
      console.error("layouts.save failed:", error);
    });
  }

  resetWorkspaceLayouts(graphId: string): void {
    void this.control
      .execute("layouts.reset", { graphId })
      .catch((error: unknown) => {
        console.error("layouts.reset failed:", error);
      });
  }
}
