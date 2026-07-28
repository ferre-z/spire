import { randomUUID } from "node:crypto";
import type {
  AgentNode,
  GraphDefinition,
  RunEvent,
  RunRecord,
  RunStatus,
  StartRunInput,
  TaskBrief,
} from "../shared/domain";
import {
  implementationReportSchema,
  reviewVerdictSchema,
  taskBriefSchema,
} from "../shared/domain";
import type { SpireDatabase } from "./database";
import type { AgentHarness, HarnessPrompt } from "./opencode";
import {
  implementationPrompt,
  implementationSystem,
  parseJson,
  plannerSystem,
  planningPrompt,
  repairPrompt,
  reviewPrompt,
} from "./prompts";
import type { ExecutionBackend } from "./worktree";

type SessionState = {
  planner?: string;
  implementer?: string;
  active?: { id: string; directory: string };
};

export class RunEngine {
  private activeRunId?: string;
  private sessions = new Map<string, SessionState>();

  constructor(
    private readonly database: SpireDatabase,
    private readonly harness: AgentHarness,
    private readonly backend: ExecutionBackend,
    private readonly notify: (event: RunEvent) => void,
  ) {
    const active = database
      .listRuns()
      .find((run) =>
        ["preparing", "planning", "implementing", "reviewing"].includes(
          run.status,
        ),
      );
    if (active) {
      active.status = "failed";
      active.error = "Spire closed while this run was active.";
      active.finishedAt = new Date().toISOString();
      database.saveRun(active);
    }
  }

  get activeId(): string | undefined {
    return this.activeRunId;
  }

  async start(input: StartRunInput): Promise<RunRecord> {
    if (this.activeRunId) throw new Error("Only one run can be active.");
    const id = randomUUID();
    const run: RunRecord = {
      id,
      graphId: input.graph.id,
      graphVersion: input.graph.version,
      repositoryPath: input.repositoryPath,
      goal: input.goal,
      status: "preparing",
      iteration: 0,
      startedAt: new Date().toISOString(),
      events: [],
    };
    this.database.saveGraph(input.graph);
    this.database.saveRun(run);
    this.activeRunId = id;
    this.sessions.set(id, {});
    void this.execute(run, input.graph).finally(() => {
      if (this.activeRunId === id) this.activeRunId = undefined;
    });
    return run;
  }

  async stop(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const session = this.sessions.get(runId);
    if (session?.active) {
      await this.harness
        .abort(session.active.id, session.active.directory)
        .catch(() => undefined);
    }
    this.transition(run, "stopped", "Run stopped by user.");
    run.finishedAt = new Date().toISOString();
    this.database.saveRun(run);
    if (this.activeRunId === runId) this.activeRunId = undefined;
  }

  async retry(runId: string): Promise<RunRecord> {
    if (this.activeRunId) throw new Error("Another run is active.");
    const run = this.requireRun(runId);
    if (!["failed", "needs_attention", "stopped"].includes(run.status)) {
      throw new Error("Only stopped or failed runs can be retried.");
    }
    const graphs = this.database.listGraphs();
    const graph = graphs.find(
      (item) => item.id === run.graphId && item.version === run.graphVersion,
    );
    if (!graph || !run.artifacts?.worktreePath) {
      throw new Error("The saved graph or workspace is unavailable.");
    }
    if (run.status === "needs_attention") {
      run.iteration = Math.max(0, run.iteration - 1);
    }
    run.error = undefined;
    run.finishedAt = undefined;
    this.activeRunId = runId;
    this.sessions.set(runId, {});
    void this.resume(run, graph).finally(() => {
      if (this.activeRunId === runId) this.activeRunId = undefined;
    });
    return run;
  }

  private async execute(
    run: RunRecord,
    graph: GraphDefinition,
  ): Promise<void> {
    try {
      this.emit(run, "status", "preparing", "Creating isolated worktree");
      const workspace = await this.backend.prepare(
        run.repositoryPath,
        run.id,
      );
      run.artifacts = {
        diff: "",
        changedFiles: [],
        worktreePath: workspace.path,
        branch: workspace.branch,
      };
      this.database.saveRun(run);
      if (workspace.dirtySource) {
        this.emit(
          run,
          "warning",
          "preparing",
          "Source repository has uncommitted changes; the worktree starts from HEAD.",
        );
      }
      await this.runGraph(run, graph);
    } catch (error) {
      this.fail(run, error);
    }
  }

  private async resume(
    run: RunRecord,
    graph: GraphDefinition,
  ): Promise<void> {
    try {
      this.emit(run, "status", "preparing", "Retrying from saved workspace");
      await this.runGraph(run, graph, run.artifacts?.brief);
    } catch (error) {
      this.fail(run, error);
    }
  }

  private async runGraph(
    run: RunRecord,
    graph: GraphDefinition,
    savedBrief?: TaskBrief,
  ): Promise<void> {
    const planner = graph.nodes.find((node) => node.role === "planner")!;
    const implementer = graph.nodes.find(
      (node) => node.role === "implementer",
    )!;
    const worktreePath = run.artifacts!.worktreePath;
    const brief =
      savedBrief ??
      (await this.structuredPrompt(
        run,
        planner,
        "planning",
        plannerSystem(graph),
        planningPrompt(run.goal),
        taskBriefSchema,
        "TaskBrief",
      ));
    run.artifacts!.brief = brief;
    this.database.saveRun(run);

    let feedback = run.artifacts?.verdict?.feedback ?? [];
    while (run.iteration < graph.maxIterations) {
      run.iteration += 1;
      this.database.saveRun(run);
      const implementation = await this.structuredPrompt(
        run,
        implementer,
        "implementing",
        implementationSystem(graph),
        implementationPrompt(brief, feedback),
        implementationReportSchema,
        "ImplementationReport",
      );
      run.artifacts!.implementation = implementation;
      const inspection = await this.backend.inspect(worktreePath);
      run.artifacts!.diff = inspection.diff;
      run.artifacts!.changedFiles = inspection.changedFiles;
      this.database.saveRun(run);

      const verdict = await this.structuredPrompt(
        run,
        planner,
        "reviewing",
        plannerSystem(graph),
        reviewPrompt(brief, implementation, inspection.diff),
        reviewVerdictSchema,
        "ReviewVerdict",
      );
      run.artifacts!.verdict = verdict;
      this.database.saveRun(run);
      if (verdict.decision === "accepted") {
        this.transition(run, "succeeded", "Planner accepted the implementation.");
        run.finishedAt = new Date().toISOString();
        this.database.saveRun(run);
        return;
      }
      feedback = verdict.feedback;
      this.emit(
        run,
        "transition",
        "reviewing",
        `Revision requested; returning to implementer (${run.iteration}/${graph.maxIterations}).`,
      );
    }
    this.transition(
      run,
      "needs_attention",
      `Iteration limit reached after ${graph.maxIterations} attempts.`,
    );
    run.finishedAt = new Date().toISOString();
    this.database.saveRun(run);
  }

  private async structuredPrompt<T>(
    run: RunRecord,
    node: AgentNode,
    phase: Extract<RunStatus, "planning" | "implementing" | "reviewing">,
    system: string,
    prompt: string,
    parser: { parse(value: unknown): T },
    schemaName: string,
  ): Promise<T> {
    this.transition(run, phase, `${node.name} started`);
    const first = await this.send(run, node, phase, system, prompt);
    try {
      return parseJson(first, parser);
    } catch {
      this.emit(
        run,
        "repair",
        phase,
        `${node.name} returned invalid structured output; requesting one repair.`,
      );
      const repaired = await this.send(
        run,
        node,
        phase,
        system,
        repairPrompt(schemaName, first),
      );
      return parseJson(repaired, parser);
    }
  }

  private async send(
    run: RunRecord,
    node: AgentNode,
    phase: string,
    system: string,
    prompt: string,
  ): Promise<string> {
    const sessions = this.sessions.get(run.id)!;
    const role = node.role;
    const input: HarnessPrompt = {
      directory: run.artifacts!.worktreePath,
      sessionId: sessions[role],
      title: `${run.goal.slice(0, 50)} — ${node.name}`,
      model: node.model,
      system,
      prompt,
      readOnly: node.role === "planner",
      onSession: (sessionId) => {
        sessions[role] = sessionId;
        sessions.active = {
          id: sessionId,
          directory: run.artifacts!.worktreePath,
        };
      },
      onEvent: (kind, message, payload) =>
        this.emit(run, kind, phase, message, node.id, this.redact(payload)),
    };
    const response = await this.harness.prompt(input);
    sessions[role] = response.sessionId;
    this.emit(
      run,
      "message",
      phase,
      response.text.slice(0, 1000),
      node.id,
    );
    return response.text;
  }

  private transition(
    run: RunRecord,
    status: RunStatus,
    message: string,
  ): void {
    run.status = status;
    const role =
      status === "implementing"
        ? "implementer"
        : status === "planning" || status === "reviewing"
          ? "planner"
          : undefined;
    const graph = this.database
      .listGraphs()
      .find(
        (item) =>
          item.id === run.graphId && item.version === run.graphVersion,
      );
    run.activeNodeId = role
      ? graph?.nodes.find((node) => node.role === role)?.id
      : undefined;
    this.emit(run, "status", status, message, run.activeNodeId);
    this.database.saveRun(run);
  }

  private emit(
    run: RunRecord,
    kind: string,
    phase: string,
    message: string,
    nodeId?: string,
    payload?: unknown,
  ): void {
    const event: RunEvent = {
      id: randomUUID(),
      runId: run.id,
      sequence: run.events.length,
      timestamp: new Date().toISOString(),
      nodeId,
      kind,
      phase,
      message,
      payload,
    };
    run.events.push(event);
    this.database.saveRun(run);
    this.notify(event);
  }

  private fail(run: RunRecord, error: unknown): void {
    if (run.status === "stopped") return;
    run.error = error instanceof Error ? error.message : String(error);
    run.finishedAt = new Date().toISOString();
    this.transition(run, "failed", run.error);
    this.database.saveRun(run);
  }

  private requireRun(id: string): RunRecord {
    const run = this.database.getRun(id);
    if (!run) throw new Error("Run not found.");
    return run;
  }

  private redact(payload: unknown): unknown {
    if (!payload) return payload;
    const text = JSON.stringify(payload, (key, value) => {
      if (/key|token|authorization|secret|password/i.test(key)) return "[redacted]";
      return value;
    });
    return JSON.parse(text);
  }
}
