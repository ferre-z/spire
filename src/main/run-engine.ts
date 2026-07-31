import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  graphDefinitionV2Schema,
  type GraphDefinition,
  type GraphDefinitionV2,
  type RunEvent,
  type RunRecord,
  type RunStatus,
  type StartRunInput,
} from "../shared/domain";
import type {
  AppliedPlanPatch,
  CollaborationMessageDraft,
  ExecutionPlan,
  NodeExecution,
  PlanPatchDraft,
} from "../shared/execution";
import type { HarnessEvent, HarnessRegistry } from "../shared/harness";
import type { JsonValue } from "../shared/workspace";
import { CollaborationWorkspace } from "./collaboration/workspace";
import type { CollaborationMessage } from "../shared/collaboration";
import type { SpireDatabase } from "./database";
import { readGraphDefinition } from "./graph-migration";
import {
  compileExecutionPlan,
  compileGraph,
  type CompiledGraph,
  type CompiledNode,
  type SubgraphResolver,
} from "./scheduler/graph-compiler";
import {
  GraphScheduler,
  type ResumeOptions,
  type SchedulerObserver,
} from "./scheduler/scheduler";
import {
  applyPlanPatch,
  buildGraphVersionInput,
  rollbackPlanPatch,
} from "./scheduler/plan-patcher";
import type { TraceJournal } from "./trace-journal";
import { NodeWorkspaceCoordinator } from "./workspace/node-worktree";
import type { ExecutionBackend } from "./worktree";

/** Maximum number of RunEvents kept in a RunRecord's events array. */
const MAX_RUN_EVENTS = 200;

/** Run statuses that mean the engine is actively driving the run. */
const ACTIVE_STATUSES: RunStatus[] = [
  "preparing",
  "planning",
  "implementing",
  "reviewing",
];

/**
 * Normalize a payload to the JSON domain (drops `undefined` properties, which
 * the trace journal's `jsonValueSchema` rejects). This is not redaction — the
 * journal remains the only redaction path for journaled events.
 */
function toJsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return String(value);
  }
}

function harnessEventMessage(event: HarnessEvent): string {
  switch (event.type) {
    case "session":
      return `Session ${event.session.sessionId}`;
    case "assistant_text":
    case "reasoning":
      return event.text;
    case "tool_start":
      return `${event.tool} pending`;
    case "tool_progress":
      return event.message;
    case "tool_result":
      return event.error ? `${event.tool} error` : `${event.tool} completed`;
    case "approval":
      return event.title;
    case "usage":
      return "Usage reported";
    case "stdout":
    case "stderr":
      return event.text;
    case "warning":
    case "error":
    case "timeout":
    case "cancelled":
    case "status":
      return event.message;
  }
}

/**
 * Drives a run: compiles the run's graph version into a persisted execution
 * plan and lets the GraphScheduler route node work through the HarnessRegistry.
 * The engine owns the RunRecord lifecycle (statuses, events, artifacts) and
 * maps scheduler progress onto it; the plan is the durable execution state.
 */
export class RunEngine {
  private activeRunId?: string;
  private schedulers = new Map<string, GraphScheduler>();
  /** The live run objects mutated by in-flight executions, keyed by run id. */
  private live = new Map<string, RunRecord>();
  /** Per-run node workspace coordinators, keyed by run id. */
  private runWorkspaces = new Map<string, NodeWorkspaceCoordinator>();
  /** Per-run collaboration workspaces, keyed by run id. */
  private collaborationWorkspaces = new Map<string, CollaborationWorkspace>();

  constructor(
    private readonly database: SpireDatabase,
    private readonly registry: HarnessRegistry,
    private readonly backend: ExecutionBackend,
    private readonly notify: (event: RunEvent) => void,
    private readonly journal?: TraceJournal,
    /**
     * Electron userData root. When set, real runs get the collaboration
     * workspace (runs/<runId>/collaboration) and per-node worktree isolation
     * (runs/<runId>/node-worktrees); tests omit it to run dep-free.
     */
    private readonly userDataDir?: string,
  ) {
    const active = database
      .listRuns()
      .find((run) => ACTIVE_STATUSES.includes(run.status));
    if (!active) return;
    const plan = database.getExecutionPlan(active.id);
    if (!plan) {
      // Pre-scheduler run record with no durable plan: nothing to resume.
      active.status = "failed";
      active.error = "Spire closed while this run was active.";
      active.finishedAt = new Date().toISOString();
      database.saveRun(active);
      return;
    }
    // Restart recovery: orphaned attempts are converted to failures inside
    // resume(), and routing continues from the persisted plan — the run is
    // not failed merely because Spire closed.
    this.activeRunId = active.id;
    this.live.set(active.id, active);
    void this.resumePlan(active, plan).finally(() => {
      this.live.delete(active.id);
      this.runWorkspaces.delete(active.id);
      if (this.activeRunId === active.id) this.activeRunId = undefined;
    });
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
    // readGraphDefinition normalizes both legacy v1 and native v2 graphs to
    // v2 for compilation. Persist in the graph's native format so listGraphs
    // (v1) and listGraphsV2 (v2) both round-trip correctly.
    const graph = readGraphDefinition(input.graph);
    if (graphDefinitionV2Schema.safeParse(input.graph).success) {
      this.database.saveGraphV2(graph);
    } else {
      this.database.saveGraph(input.graph as GraphDefinition);
    }
    // Persist the compiled plan before execution starts.
    const plan = this.compilePlan(graph, id);
    this.database.saveExecutionPlan(plan);
    this.database.saveRun(run);
    this.activeRunId = id;
    this.live.set(id, run);
    void this.execute(run, graph, plan).finally(() => {
      this.live.delete(id);
      this.runWorkspaces.delete(id);
      if (this.activeRunId === id) this.activeRunId = undefined;
    });
    return run;
  }

  async stop(runId: string): Promise<void> {
    const run = this.live.get(runId) ?? this.requireRun(runId);
    const scheduler = this.schedulers.get(runId);
    if (scheduler) await scheduler.stop();
    if (run.status === "stopped") return;
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
    if (!run.artifacts?.worktreePath) {
      throw new Error("The saved graph or workspace is unavailable.");
    }
    run.error = undefined;
    run.finishedAt = undefined;
    this.activeRunId = runId;
    this.live.set(runId, run);
    void this.retryPlan(run).finally(() => {
      this.live.delete(runId);
      this.runWorkspaces.delete(runId);
      if (this.activeRunId === runId) this.activeRunId = undefined;
    });
    return run;
  }

  // --- External control-plane operations -------------------------------------

  /**
   * Get the persisted execution plan for a run, or throw if no plan exists.
   * Returns the plan as last written by the scheduler (persisted after every
   * node transition), so it reflects the latest durable state.
   */
  getExecutionPlan(runId: string): ExecutionPlan {
    const plan = this.database.getExecutionPlan(runId);
    if (!plan) throw new Error("Execution plan not found.");
    return plan;
  }

  /**
   * Deliver a collaboration message: persist it with the next sequence
   * number, then deliver it to the run's collaboration workspace if one
   * exists. Returns the fully-formed persisted message.
   */
  async deliverMessage(
    runId: string,
    draft: CollaborationMessageDraft,
    senderNodeId: string,
  ): Promise<CollaborationMessage> {
    this.requireRun(runId);
    const sequence = this.database.listCollaborationMessages(runId).length;
    const message: CollaborationMessage = {
      ...draft,
      id: `${runId}:${sequence}`,
      runId,
      senderNodeId,
      sequence,
      createdAt: new Date().toISOString(),
    };
    this.database.appendCollaborationMessage(message);
    const workspace = this.collaborationWorkspaces.get(runId);
    if (workspace) {
      await workspace.deliver(message);
    }
    return message;
  }

  /**
   * Validate and apply a plan patch to a run's persisted execution plan.
   * The actor node must have authority for every operation in the draft.
   * On success the patched plan and audit record are persisted atomically.
   */
  applyPlanPatch(
    runId: string,
    actorNodeId: string,
    draft: PlanPatchDraft,
  ): AppliedPlanPatch {
    const plan = this.getExecutionPlan(runId);
    const compiled = this.compileFor(plan);
    const result = applyPlanPatch(plan, compiled, actorNodeId, draft);
    this.database.savePatchedPlan(plan, result.patch, {
      removedNodeIds: result.removedNodeIds,
      changedNodes: result.changedNodes,
    });
    return result.patch;
  }

  /**
   * Roll back the most recent applied patch on a run's plan, restoring the
   * pre-patch topology from revision snapshots. Only the latest active patch
   * can be rolled back (stack semantics).
   */
  rollbackPlanPatch(runId: string, patchId: string): AppliedPlanPatch {
    const plan = this.getExecutionPlan(runId);
    const compiled = this.compileFor(plan);
    const target = plan.patches.find((item) => item.id === patchId);
    if (!target) {
      throw new Error(`Unknown patch ${patchId}.`);
    }
    const base = this.database.getExecutionPlanRevision(
      plan.runId,
      target.baseRevision,
    );
    const applied = this.database.getExecutionPlanRevision(
      plan.runId,
      target.appliedRevision,
    );
    if (!base || !applied) {
      throw new Error(
        `Plan revision history for run ${plan.runId} is unavailable; ` +
          `cannot roll back ${patchId}.`,
      );
    }
    const result = rollbackPlanPatch(plan, compiled, patchId, { base, applied });
    this.database.savePatchedPlan(plan, result.patch, {
      removedNodeIds: result.removedNodeIds,
      changedNodes: result.changedNodes,
      rolledBackPatchId: patchId,
    });
    return result.patch;
  }

  /**
   * Resume a run that is paused at a manual checkpoint. Passes the checkpoint,
   * re-queues any checkpoint-gated nodes, and continues scheduling to a
   * terminal state. Returns the final execution plan.
   */
  async resumeCheckpoint(runId: string): Promise<ExecutionPlan> {
    if (this.activeRunId) throw new Error("Another run is active.");
    const run = this.requireRun(runId);
    if (run.status !== "needs_attention") {
      throw new Error(
        `Run ${runId} is not paused (status: ${run.status}).`,
      );
    }
    let plan = this.database.getExecutionPlan(runId);
    if (!plan) throw new Error("Execution plan not found.");
    const compiled = this.compileFor(plan);
    let scheduler = this.schedulers.get(runId);
    if (!scheduler) {
      scheduler = this.createScheduler(run, compiled);
    }
    this.activeRunId = runId;
    this.live.set(runId, run);
    plan = await scheduler.resume(compiled, plan);
    await this.finishFromPlan(run, plan);
    this.schedulers.delete(runId);
    this.live.delete(runId);
    this.runWorkspaces.delete(runId);
    this.collaborationWorkspaces.delete(runId);
    if (this.activeRunId === runId) this.activeRunId = undefined;
    return plan;
  }

  /**
   * Promote the live plan topology (active nodes and edges, minus superseded
   * replacement nodes) to a new saved graph v2 version. The run's graph id and
   * an incremented version are used; the caller may override the display name.
   */
  promotePlan(runId: string, name?: string): GraphDefinitionV2 {
    const plan = this.getExecutionPlan(runId);
    const compiled = this.compileFor(plan);
    const promotion = buildGraphVersionInput(plan, compiled, { name });
    const existing = this.database
      .listGraphsV2()
      .filter((item) => item.id === promotion.graphId);
    const newVersion =
      Math.max(0, ...existing.map((item) => item.version)) + 1;
    const promoted: GraphDefinitionV2 = {
      id: promotion.graphId,
      name: promotion.name,
      version: newVersion,
      nodes: promotion.nodes,
      edges: promotion.edges,
      groups: promotion.groups,
      maxSteps: promotion.maxSteps,
      createdAt: new Date().toISOString(),
    };
    this.database.saveGraphV2(promoted);
    return promoted;
  }

  // --- Run lifecycle --------------------------------------------------------

  private async execute(
    run: RunRecord,
    graph: GraphDefinitionV2,
    plan: ExecutionPlan,
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
      const compiled = compileGraph(graph, this.subgraphResolver());
      const scheduler = this.createScheduler(run, compiled);
      const final = await scheduler.start(compiled, plan);
      await this.finishFromPlan(run, final);
    } catch (error) {
      this.fail(run, error);
    }
  }

  /** Restart recovery: resume routing from the persisted plan. */
  private async resumePlan(run: RunRecord, plan: ExecutionPlan): Promise<void> {
    try {
      const compiled = this.compileFor(plan);
      const scheduler = this.createScheduler(run, compiled);
      const final = await scheduler.resume(compiled, plan);
      await this.finishFromPlan(run, final);
    } catch (error) {
      this.fail(run, error);
    }
  }

  /** User-initiated retry: re-queue failed nodes and reset the step budget. */
  private async retryPlan(run: RunRecord): Promise<void> {
    const options: ResumeOptions = { retryFailed: true, resetSteps: true };
    try {
      let plan = this.database.getExecutionPlan(run.id);
      if (!plan) {
        // Run predates durable plans: compile a fresh one from the graph.
        const graph = this.loadGraph(run.graphId, run.graphVersion);
        plan = this.compilePlan(graph, run.id);
        this.database.saveExecutionPlan(plan);
      }
      const compiled = this.compileFor(plan);
      const scheduler = this.createScheduler(run, compiled);
      const final = await scheduler.resume(compiled, plan, options);
      await this.finishFromPlan(run, final);
    } catch (error) {
      this.fail(run, error);
    }
  }

  private async finishFromPlan(
    run: RunRecord,
    plan: ExecutionPlan,
  ): Promise<void> {
    if (run.status === "stopped") return;
    switch (plan.status) {
      case "succeeded": {
        // With node workspace isolation, committed node branches merge into
        // the integration branch at checkpoints; sweep any work committed
        // after the last checkpoint before computing the run diff.
        const workspaces = this.runWorkspaces.get(run.id);
        if (workspaces) {
          const merge = await workspaces.mergeAtCheckpoint();
          if (merge.conflicts.length > 0) {
            this.journalEvent({
              runId: run.id,
              kind: "run.warning",
              level: "warn",
              message:
                `Final merge dropped conflicting node work: ${merge.conflicts
                  .map((conflict) => conflict.nodeId)
                  .join(", ")}.`,
            });
          }
          const final = await workspaces.finalDiff();
          run.artifacts!.diff = final.diff;
          run.artifacts!.changedFiles = final.changedFiles;
        } else {
          const inspection = await this.backend.inspect(
            run.artifacts!.worktreePath,
          );
          run.artifacts!.diff = inspection.diff;
          run.artifacts!.changedFiles = inspection.changedFiles;
        }
        this.transition(run, "succeeded", "All graph work completed.");
        run.finishedAt = new Date().toISOString();
        this.database.saveRun(run);
        return;
      }
      case "failed": {
        const failedNode = plan.nodes.find((node) => node.status === "failed");
        const message =
          failedNode?.error ??
          failedNode?.outcome?.summary ??
          "The execution plan failed.";
        run.error = message;
        run.finishedAt = new Date().toISOString();
        this.transition(run, "failed", message, failedNode?.nodeId);
        this.journalEvent({
          runId: run.id,
          nodeId: failedNode?.nodeId,
          kind: "run.failure",
          level: "error",
          message,
        });
        this.database.saveRun(run);
        return;
      }
      case "needs_attention":
        this.transition(
          run,
          "needs_attention",
          "The run needs attention before it can continue.",
        );
        run.finishedAt = new Date().toISOString();
        this.database.saveRun(run);
        return;
      case "paused":
        this.transition(
          run,
          "needs_attention",
          "Run paused; retry the run to resume.",
        );
        run.finishedAt = new Date().toISOString();
        this.database.saveRun(run);
        return;
      case "running":
        return;
    }
  }

  // --- Scheduler wiring -----------------------------------------------------

  private compilePlan(graph: GraphDefinitionV2, runId: string): ExecutionPlan {
    return compileExecutionPlan(graph, runId, this.subgraphResolver());
  }

  private compileFor(plan: ExecutionPlan): CompiledGraph {
    const graph = this.loadGraph(plan.graphId, plan.graphVersion);
    return compileGraph(graph, this.subgraphResolver());
  }

  private loadGraph(graphId: string, version: number): GraphDefinitionV2 {
    const graph = this.database
      .listGraphsV2()
      .find((item) => item.id === graphId && item.version === version);
    if (!graph) throw new Error("The saved graph is unavailable.");
    return graph;
  }

  private subgraphResolver(): SubgraphResolver {
    return (graphId, version) => {
      const versions = this.database
        .listGraphsV2()
        .filter((item) => item.id === graphId);
      const pinned =
        version !== undefined
          ? versions.find((item) => item.version === version)
          : undefined;
      const resolved =
        pinned ??
        (version === undefined
          ? versions.reduce<GraphDefinitionV2 | undefined>(
              (latest, item) =>
                !latest || item.version > latest.version ? item : latest,
              undefined,
            )
          : undefined);
      if (!resolved) {
        throw new Error(`Subgraph ${graphId} is not available.`);
      }
      return resolved;
    };
  }

  private createScheduler(run: RunRecord, compiled: CompiledGraph): GraphScheduler {
    // Production runs get the collaboration workspace and per-node worktree
    // isolation; both are rooted under userData so nothing lands in the
    // repository's git status.
    const collaboration = this.userDataDir
      ? new CollaborationWorkspace({
          userDataDir: this.userDataDir,
          runId: run.id,
          goal: run.goal,
          nodes: compiled.nodes.map((node) => ({
            id: node.id,
            name: node.name,
            groupId: node.groupId,
          })),
          edges: compiled.edges.map((edge) => ({
            source: edge.source,
            target: edge.target,
          })),
        })
      : undefined;
    if (this.userDataDir && collaboration) {
      this.collaborationWorkspaces.set(run.id, collaboration);
    }
    let workspaces: NodeWorkspaceCoordinator | undefined;
    if (this.userDataDir && run.artifacts?.worktreePath) {
      workspaces = new NodeWorkspaceCoordinator({
        repositoryPath: run.repositoryPath,
        integrationPath: run.artifacts.worktreePath,
        integrationBranch: run.artifacts.branch,
        runId: run.id,
        rootDir: path.join(
          this.userDataDir,
          "runs",
          run.id,
          "node-worktrees",
        ),
      });
      this.runWorkspaces.set(run.id, workspaces);
    }
    const scheduler = new GraphScheduler({
      database: this.database,
      registry: this.registry,
      goal: run.goal,
      directory: run.artifacts!.worktreePath,
      observer: this.observerFor(run),
      collaboration,
      workspaces,
    });
    this.schedulers.set(run.id, scheduler);
    return scheduler;
  }

  private observerFor(run: RunRecord): SchedulerObserver {
    return {
      nodeStarted: (node, visit, context) =>
        this.markNodeStart(run, node, visit, context),
      nodeFinished: (node, execution) =>
        this.markNodeFinish(run, node, execution),
      harnessEvent: (nodeId, event) => {
        const message = harnessEventMessage(event);
        this.journalEvent({
          runId: run.id,
          nodeId,
          kind: `run.${event.type}`,
          message,
          payload: event,
        });
        this.emit(
          run,
          event.type,
          run.status,
          message,
          nodeId,
          this.redact(event),
        );
      },
      planUpdated: () => undefined,
    };
  }

  /**
   * Map a node start onto the legacy run phases so the existing UI keeps its
   * planning/implementing/reviewing signals for migrated legacy graphs.
   */
  private markNodeStart(
    run: RunRecord,
    node: CompiledNode,
    visit: number,
    context: string,
  ): void {
    const roleLabel =
      node.kind === "agent" || node.kind === "decision"
        ? node.roleLabel
        : undefined;
    const phase: RunStatus =
      roleLabel === "planner"
        ? visit <= 1
          ? "planning"
          : "reviewing"
        : roleLabel === "implementer"
          ? "implementing"
          : ACTIVE_STATUSES.includes(run.status)
            ? run.status
            : "implementing";
    this.transition(run, phase, `${node.name} started`, node.id);
    if (node.kind === "agent" || node.kind === "decision") {
      const stored = this.database.getHarnessSession(run.id, node.id);
      this.journalEvent({
        runId: run.id,
        nodeId: node.id,
        harnessId: node.harnessId,
        kind: "run.prompt",
        message: `${node.name} prompt sent`,
        payload: {
          job: node.job,
          context,
          model: node.modelId,
          sessionId: stored?.sessionId,
          visit,
        },
      });
    }
  }

  private markNodeFinish(
    run: RunRecord,
    node: CompiledNode,
    execution: NodeExecution,
  ): void {
    if (
      (node.kind === "agent" || node.kind === "decision") &&
      node.roleLabel === "implementer"
    ) {
      run.iteration = execution.visits;
    }
    const message =
      execution.outcome?.summary ?? execution.error ?? `${node.name} finished`;
    this.journalEvent({
      runId: run.id,
      nodeId: node.id,
      harnessId:
        node.kind === "agent" || node.kind === "decision"
          ? node.harnessId
          : undefined,
      kind: "run.response",
      level: execution.status === "failed" ? "error" : "info",
      message: `${node.name} responded`,
      payload: {
        status: execution.status,
        outcome: execution.outcome,
        error: execution.error,
      },
    });
    this.emit(
      run,
      execution.status === "failed" ? "error" : "message",
      run.status,
      message.slice(0, 1000),
      node.id,
    );
    this.database.saveRun(run);
  }

  // --- Run record plumbing --------------------------------------------------

  private transition(
    run: RunRecord,
    status: RunStatus,
    message: string,
    nodeId?: string,
  ): void {
    run.status = status;
    run.activeNodeId = nodeId;
    this.emit(run, "status", status, message, nodeId);
    this.journalEvent({
      runId: run.id,
      nodeId,
      kind: "run.transition",
      message,
      payload: { status },
    });
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
    if (run.events.length > MAX_RUN_EVENTS) {
      run.events = run.events.slice(-MAX_RUN_EVENTS);
    }
    this.database.saveRun(run);
    this.notify(event);
  }

  private fail(run: RunRecord, error: unknown): void {
    if (run.status === "stopped") return;
    run.error = error instanceof Error ? error.message : String(error);
    run.finishedAt = new Date().toISOString();
    this.transition(run, "failed", run.error);
    this.journalEvent({
      runId: run.id,
      kind: "run.failure",
      level: "error",
      message: run.error,
    });
    this.database.saveRun(run);
  }

  private requireRun(id: string): RunRecord {
    const run = this.database.getRun(id);
    if (!run) throw new Error("Run not found.");
    return run;
  }

  /**
   * Append a raw execution event to the trace journal (the single redaction
   * path — payloads here are NOT pre-redacted). The journal is observability,
   * not control flow: a failed append is logged and never breaks a run. The
   * run id doubles as the correlation id — the engine has no access to the
   * control layer's per-operation correlation id.
   */
  private journalEvent(input: {
    runId: string;
    nodeId?: string;
    harnessId?: string;
    kind: string;
    level?: "info" | "warn" | "error";
    message: string;
    payload?: unknown;
  }): void {
    if (!this.journal) return;
    try {
      this.journal.append({
        correlationId: input.runId,
        runId: input.runId,
        nodeId: input.nodeId,
        harnessId: input.harnessId,
        kind: input.kind,
        level: input.level ?? "info",
        subsystem: "run-engine",
        message: input.message,
        payload:
          input.payload === undefined ? undefined : toJsonValue(input.payload),
      });
    } catch (error) {
      console.error("trace journal append failed", error);
    }
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
