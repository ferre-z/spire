import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type {
  AppSnapshot,
  GraphDefinition,
  OpenCodeStatus,
  ProviderInput,
  StartRunInput,
} from "../shared/domain";
import { graphDefinitionSchema } from "../shared/domain";
import type { WorkspaceLayoutRecord } from "../shared/workspace";
import { validateWorkspaceLayoutRecord } from "../shared/workspace";
import type { SpireDatabase } from "./database";
import type { AgentHarness } from "./opencode";
import type { RunEngine } from "./run-engine";
import type { ExecutionBackend } from "./worktree";

export class AppService {
  private openCodeStatus: OpenCodeStatus = {
    installed: false,
    compatible: false,
    connected: false,
  };
  private modelsCache: AppSnapshot["models"] = [];

  constructor(
    private readonly database: SpireDatabase,
    private readonly harness: AgentHarness,
    private readonly engine: RunEngine,
    private readonly backend: ExecutionBackend,
  ) {}

  snapshot(): AppSnapshot {
    return {
      onboardingComplete:
        this.database.getSetting("onboardingComplete") === "true",
      openCode: this.openCodeStatus,
      models: this.modelsCache,
      graphs: this.database.listGraphs(),
      runs: this.database.listRuns(),
      activeRunId: this.engine.activeId,
    };
  }

  async detectOpenCode(): Promise<AppSnapshot> {
    this.openCodeStatus = await this.harness.detect();
    return this.snapshot();
  }

  async connectOpenRouter(input: ProviderInput): Promise<AppSnapshot> {
    if (!input.apiKey.trim()) throw new Error("OpenRouter API key is required.");
    await this.harness.connectOpenRouter(input.apiKey.trim());
    this.modelsCache = await this.harness.models();
    if (this.modelsCache.length === 0) {
      throw new Error("OpenRouter connected, but no models were returned.");
    }
    this.openCodeStatus = {
      ...(await this.harness.detect()),
      connected: true,
    };
    this.database.setSetting("onboardingComplete", "true");
    if (this.database.listGraphs().length === 0) {
      this.database.saveGraph(this.defaultGraph(this.modelsCache[0].id));
    }
    return this.snapshot();
  }

  saveGraph(graph: GraphDefinition): AppSnapshot {
    const parsed = graphDefinitionSchema.parse(graph);
    const existing = this.database
      .listGraphs()
      .filter((item) => item.id === parsed.id);
    const highestVersion = Math.max(0, ...existing.map((item) => item.version));
    const changed = existing.find((item) => item.version === parsed.version);
    const version = changed ? highestVersion + 1 : parsed.version;
    this.database.saveGraph({
      ...parsed,
      version,
      createdAt: new Date().toISOString(),
    });
    return this.snapshot();
  }

  async startRun(input: StartRunInput): Promise<AppSnapshot> {
    graphDefinitionSchema.parse(input.graph);
    if (!input.goal.trim()) throw new Error("A coding goal is required.");
    await access(input.repositoryPath);
    await this.engine.start({ ...input, goal: input.goal.trim() });
    return this.snapshot();
  }

  async stopRun(runId: string): Promise<AppSnapshot> {
    await this.engine.stop(runId);
    return this.snapshot();
  }

  async retryRun(runId: string): Promise<AppSnapshot> {
    await this.engine.retry(runId);
    return this.snapshot();
  }

  async cleanupWorktree(runId: string): Promise<AppSnapshot> {
    const run = this.database.getRun(runId);
    if (!run?.artifacts?.worktreePath) throw new Error("Worktree not found.");
    await this.backend.cleanup(
      run.artifacts.worktreePath,
      run.repositoryPath,
    );
    run.artifacts.worktreePath = "";
    this.database.saveRun(run);
    return this.snapshot();
  }

  getRun(runId: string) {
    return this.database.getRun(runId);
  }

  listWorkspaceLayouts(graphId: string): WorkspaceLayoutRecord[] {
    if (!graphId) throw new Error("A graph id is required.");
    return this.database.listWorkspaceLayouts(graphId);
  }

  saveWorkspaceLayout(input: unknown): void {
    const validation = validateWorkspaceLayoutRecord(input);
    if (!validation.ok) {
      throw new Error(`Workspace layout rejected: ${validation.reason}`);
    }
    this.database.saveWorkspaceLayout(validation.record);
  }

  resetWorkspaceLayouts(graphId: string): void {
    if (!graphId) throw new Error("A graph id is required.");
    this.database.resetWorkspaceLayouts(graphId);
  }

  private defaultGraph(model: string): GraphDefinition {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      name: "Build & Review",
      version: 1,
      maxIterations: 3,
      createdAt: now,
      nodes: [
        {
          id: "planner",
          type: "opencode",
          role: "planner",
          name: "Architect",
          model,
          instructions:
            "Turn coding goals into focused implementation briefs, then review the result with high standards.",
          position: { x: 160, y: 190 },
        },
        {
          id: "implementer",
          type: "opencode",
          role: "implementer",
          name: "Builder",
          model,
          instructions:
            "Implement the brief carefully, keep changes scoped, and validate the result before reporting.",
          position: { x: 570, y: 190 },
        },
      ],
      edges: [
        {
          id: "plan-build",
          source: "planner",
          target: "implementer",
          condition: "always",
          label: "task brief",
        },
        {
          id: "build-review",
          source: "implementer",
          target: "planner",
          condition: "always",
          label: "review",
        },
        {
          id: "revise",
          source: "planner",
          target: "implementer",
          condition: "needs_changes",
          label: "revise",
        },
      ],
    };
  }
}
