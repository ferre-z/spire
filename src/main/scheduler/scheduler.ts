import { z } from "zod";
import type {
  AgentNode,
  CheckpointNode,
  DecisionNode,
} from "../../shared/domain";
import {
  nodeOutcomeSchema,
  type ExecutionPlan,
  type NodeExecution,
  type NodeOutcome,
} from "../../shared/execution";
import type {
  HarnessEvent,
  HarnessRegistry,
  HarnessSession,
  HarnessSessionRef,
} from "../../shared/harness";
import type { SpireDatabase } from "../database";
import { runHarnessStructured } from "../harness/adapter";
import type { CompiledGraph, CompiledNode } from "./graph-compiler";

/**
 * Durable graph scheduler.
 *
 * Executes a compiled graph against a persisted execution plan. The plan is
 * the single source of truth: it is saved before execution and after every
 * node transition, so a crash or restart can resume routing from the last
 * persisted state. Readiness is derived from the plan alone (node visits,
 * statuses, and latest outcomes) using a token model: each completed source
 * visit offers one token on every outgoing edge whose condition the outcome
 * satisfies, and each target activation consumes one token per incoming edge
 * (`all`) or any single token (`any`). Seed nodes (the compiler's initial
 * set) get their first activation for free.
 *
 * Safety bounds: a node runs at most `maxVisits` times (pending tokens beyond
 * that are dropped), and the plan runs at most `maxSteps` node attempts —
 * exceeding the step budget with work still pending yields `needs_attention`.
 */

/** Live progress sink implemented by the run engine. */
export type SchedulerObserver = {
  nodeStarted(node: CompiledNode, visit: number, context: string): void;
  nodeFinished(node: CompiledNode, execution: NodeExecution): void;
  harnessEvent(nodeId: string, event: HarnessEvent): void;
  planUpdated(plan: ExecutionPlan): void;
};

export type GraphSchedulerDeps = {
  database: SpireDatabase;
  registry: HarnessRegistry;
  /** Run objective, prepended to every node's context. */
  goal: string;
  /** Node working directory (the run's integration worktree). */
  directory: string;
  observer: SchedulerObserver;
};

export type ResumeOptions = {
  /** Re-queue failed/cancelled nodes that still have visits left (retry). */
  retryFailed?: boolean;
  /** Reset the consumed step budget (retry after a maxSteps cap). */
  resetSteps?: boolean;
};

const NODE_OUTCOME_JSON_SCHEMA = z.toJSONSchema(nodeOutcomeSchema) as Record<
  string,
  unknown
>;

function isAgentLike(node: CompiledNode): node is AgentNode | DecisionNode {
  return node.kind === "agent" || node.kind === "decision";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type InFlightAttempt = {
  nodeId: string;
  session?: HarnessSessionRef;
  cancelled: boolean;
  cancel: () => void;
};

export class GraphScheduler {
  private readonly database: SpireDatabase;
  private readonly registry: HarnessRegistry;
  private readonly goal: string;
  private readonly directory: string;
  private readonly observer: SchedulerObserver;
  private readonly inFlight = new Set<InFlightAttempt>();
  private stopRequested = false;

  constructor(deps: GraphSchedulerDeps) {
    this.database = deps.database;
    this.registry = deps.registry;
    this.goal = deps.goal;
    this.directory = deps.directory;
    this.observer = deps.observer;
  }

  /**
   * Run a freshly compiled plan to a terminal state (or until stopped).
   * Resolves with the final plan; never rejects for node-level failures.
   */
  async start(
    graph: CompiledGraph,
    plan: ExecutionPlan,
  ): Promise<ExecutionPlan> {
    this.stopRequested = false;
    plan.status = "running";
    this.persist(plan);
    return this.runLoop(graph, plan);
  }

  /**
   * Continue a persisted plan after a stop, pause, or process restart.
   * Orphaned `running` attempts (Spire closed mid-attempt) are converted to
   * `failed` and persisted before routing resumes — the plan is not failed
   * merely because the process went away; failure edges still route.
   */
  async resume(
    graph: CompiledGraph,
    plan: ExecutionPlan,
    options: ResumeOptions = {},
  ): Promise<ExecutionPlan> {
    this.stopRequested = false;
    if (options.resetSteps) plan.stepCount = 0;
    for (const execution of plan.nodes) {
      const node = graph.nodes.find((item) => item.id === execution.nodeId);
      if (!node) continue;
      if (execution.status === "running") {
        execution.status = "failed";
        execution.error = "Spire closed while this node was running.";
        this.persistNode(plan, execution);
      } else if (
        execution.status === "waiting" &&
        execution.visits > 0 &&
        node.kind === "checkpoint"
      ) {
        // A manual checkpoint the user chose to resume past.
        this.completeCheckpoint(execution, node);
        this.persistNode(plan, execution);
      } else if (
        options.retryFailed &&
        (execution.status === "failed" || execution.status === "cancelled") &&
        execution.visits < this.maxVisits(node)
      ) {
        execution.status = "queued";
        execution.error = undefined;
        this.persistNode(plan, execution);
      } else if (
        execution.status === "cancelled" &&
        execution.visits < this.maxVisits(node)
      ) {
        execution.status = "queued";
        execution.error = undefined;
        this.persistNode(plan, execution);
      }
    }
    plan.status = "running";
    this.persist(plan);
    this.observer.planUpdated(plan);
    return this.runLoop(graph, plan);
  }

  /**
   * Stop scheduling and cancel every in-flight attempt. Attempts whose
   * harness session is already known are aborted at the adapter; attempts
   * that have not reported a session yet are still cancelled — their late
   * results are discarded. Abort of an unknown or already-completed session
   * is a successful no-op.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    const attempts = [...this.inFlight];
    for (const attempt of attempts) {
      attempt.cancelled = true;
      if (attempt.session) {
        await this.registry
          .get(attempt.session.harnessId)
          .abort(attempt.session)
          .catch(() => undefined);
      }
      attempt.cancel();
    }
  }

  // --- Scheduling core ------------------------------------------------------

  private async runLoop(
    graph: CompiledGraph,
    plan: ExecutionPlan,
  ): Promise<ExecutionPlan> {
    for (;;) {
      if (this.stopRequested) {
        plan.status = "paused";
        this.persist(plan);
        this.observer.planUpdated(plan);
        return plan;
      }
      const ready = this.selectReady(graph, plan);
      if (ready.length === 0) {
        return this.settle(graph, plan);
      }
      if (plan.stepCount >= graph.maxSteps) {
        plan.status = "needs_attention";
        this.persist(plan);
        this.observer.planUpdated(plan);
        return plan;
      }
      // A ready manual checkpoint pauses the plan for human input before any
      // other ready node runs (deterministic: humans review a stable state).
      const manualGate = ready.find(
        (node): node is CheckpointNode =>
          node.kind === "checkpoint" && node.mode === "manual",
      );
      if (manualGate) {
        this.pauseAtCheckpoint(graph, plan, manualGate);
        return plan;
      }
      await Promise.all(
        ready.map((node) => this.executeNode(graph, plan, node)),
      );
    }
  }

  /**
   * Terminal evaluation once no node is running and none can become ready.
   * Nodes that were never activated (still `waiting`/`queued` with zero
   * visits) are marked `skipped` first: they are branches legitimately
   * unreached due to routing — e.g. an all-join whose other input sat on a
   * branch that was not taken (the no-ready-node deadlock case).
   *
   * Status precedence: an unhandled failure settles `failed`; otherwise a
   * suppressed route — an edge whose token was ready to fire but whose target
   * exhausted its maxVisits bound — settles `needs_attention` (budget
   * exhaustion, matching the legacy iteration-cap signal); otherwise
   * `succeeded`. Routes that simply never fired because the outcome selected
   * or conditioned no onward edge are not suppressions.
   */
  private settle(graph: CompiledGraph, plan: ExecutionPlan): ExecutionPlan {
    for (const execution of plan.nodes) {
      const neverActivated =
        execution.visits === 0 &&
        (execution.status === "waiting" || execution.status === "queued");
      if (neverActivated) {
        execution.status = "skipped";
        this.persistNode(plan, execution);
      }
    }
    const unhandled = plan.nodes.filter(
      (execution) =>
        execution.status === "failed" && !this.failureHandled(graph, plan, execution),
    );
    plan.status =
      unhandled.length > 0
        ? "failed"
        : this.hasSuppressedRoute(graph, plan)
          ? "needs_attention"
          : "succeeded";
    this.persist(plan);
    this.observer.planUpdated(plan);
    return plan;
  }

  /**
   * A route is suppressed when an edge has a pending token (the source
   * completed a visit the target has not consumed, and the edge condition is
   * satisfied) but the target cannot accept it because it exhausted its
   * maxVisits bound.
   */
  private hasSuppressedRoute(
    graph: CompiledGraph,
    plan: ExecutionPlan,
  ): boolean {
    const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
    const seeds = new Set(graph.seedIds);
    return graph.edges.some((edge) => {
      const target = byId.get(edge.target);
      const node = graph.nodes.find((item) => item.id === edge.target);
      if (!target || !node) return false;
      if (target.visits < this.maxVisits(node)) return false;
      return this.tokenPending(graph, plan, byId, seeds, edge);
    });
  }

  /**
   * A failed node is "handled" when its failure was routed and consumed
   * downstream: some node it could activate (failure/always edge, or a
   * selected edge it chose) has since run.
   */
  private failureHandled(
    graph: CompiledGraph,
    plan: ExecutionPlan,
    execution: NodeExecution,
  ): boolean {
    const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
    return graph.edges.some((edge) => {
      if (edge.source !== execution.nodeId) return false;
      const routed =
        edge.when === "failure" ||
        edge.when === "always" ||
        (edge.when === "selected" &&
          (execution.outcome?.selectedEdgeIds.includes(edge.id) ?? false));
      return routed && (byId.get(edge.target)?.visits ?? 0) > 0;
    });
  }

  private selectReady(graph: CompiledGraph, plan: ExecutionPlan): CompiledNode[] {
    const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
    const seeds = new Set(graph.seedIds);
    return graph.nodes.filter((node) => {
      const execution = byId.get(node.id);
      if (!execution) return false;
      if (execution.status === "queued") return true;
      if (execution.status === "running") return false;
      // `waiting` with visits > 0 is a paused manual checkpoint.
      if (execution.status === "waiting" && execution.visits > 0) return false;
      if (execution.visits >= this.maxVisits(node)) return false;
      if (seeds.has(node.id) && execution.visits === 0) return true;
      const incoming = graph.edges.filter((edge) => edge.target === node.id);
      if (incoming.length === 0) return false;
      const pending = (edge: (typeof incoming)[number]) =>
        this.tokenPending(graph, plan, byId, seeds, edge);
      const activation = isAgentLike(node) ? node.activation : "all";
      return activation === "any"
        ? incoming.some(pending)
        : incoming.every(pending);
    });
  }

  /**
   * A token is pending on an edge when the source has completed more visits
   * than the target has consumed, and the source's latest outcome satisfies
   * the edge condition.
   */
  private tokenPending(
    graph: CompiledGraph,
    plan: ExecutionPlan,
    byId: Map<string, NodeExecution>,
    seeds: Set<string>,
    edge: CompiledGraph["edges"][number],
  ): boolean {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) return false;
    const sourceCompleted = this.completedVisits(source);
    const consumed = seeds.has(target.nodeId)
      ? Math.max(0, target.visits - (target.visits > 0 ? 1 : 0))
      : target.visits;
    if (sourceCompleted <= consumed) return false;
    switch (edge.when) {
      case "always":
        return true;
      case "success":
        return source.status === "succeeded";
      case "failure":
        return source.status === "failed";
      case "selected":
        return source.outcome?.selectedEdgeIds.includes(edge.id) ?? false;
    }
  }

  /** Visits whose outcome is final (an in-flight attempt is not complete). */
  private completedVisits(execution: NodeExecution): number {
    const inFlight =
      execution.status === "running" ||
      execution.status === "queued" ||
      execution.status === "waiting";
    return Math.max(0, execution.visits - (inFlight && execution.visits > 0 ? 1 : 0));
  }

  private maxVisits(node: CompiledNode): number {
    return isAgentLike(node) ? node.maxVisits : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Node prompt context: the run goal plus, when the node has outgoing
   * `selected` edges, the explicit routing choices (edge ids + labels) the
   * model must pick from via `selectedEdgeIds` in its NodeOutcome.
   */
  private nodeContext(graph: CompiledGraph, node: CompiledNode): string {
    let context = `Run goal: ${this.goal}`;
    const selectable = graph.edges.filter(
      (edge) => edge.source === node.id && edge.when === "selected",
    );
    if (selectable.length > 0) {
      const choices = selectable
        .map((edge) => `"${edge.id}" (${edge.label})`)
        .join(", ");
      context +=
        `\n\nRouting: to pass work to the next node, include the matching ` +
        `edge id in your output's selectedEdgeIds: ${choices}. ` +
        `Leave selectedEdgeIds empty when no further work is needed.`;
    }
    return context;
  }

  // --- Node execution -------------------------------------------------------

  private async executeNode(
    graph: CompiledGraph,
    plan: ExecutionPlan,
    node: CompiledNode,
  ): Promise<void> {
    const execution = plan.nodes.find((item) => item.nodeId === node.id)!;
    execution.status = "queued";
    execution.visits += 1;
    execution.status = "running";
    execution.error = undefined;
    plan.stepCount += 1;
    this.persistNode(plan, execution);
    const context = this.nodeContext(graph, node);
    this.observer.nodeStarted(node, execution.visits, context);

    if (node.kind === "checkpoint") {
      this.completeCheckpoint(execution, node);
      this.persistNode(plan, execution);
      this.observer.nodeFinished(node, execution);
      return;
    }

    const attempt: InFlightAttempt = {
      nodeId: node.id,
      cancelled: false,
      cancel: () => undefined,
    };
    let cancelSignal: () => void;
    const cancelled = new Promise<"cancelled">((resolve) => {
      cancelSignal = () => resolve("cancelled");
    });
    attempt.cancel = cancelSignal!;
    this.inFlight.add(attempt);
    try {
      const stored = this.database.getHarnessSession(plan.runId, node.id);
      const session: HarnessSessionRef | undefined = stored
        ? {
            harnessId: stored.harnessId,
            sessionId: stored.sessionId,
            directory: stored.directory,
          }
        : undefined;
      const result = await Promise.race([
        runHarnessStructured({
          adapter: this.registry.get(node.harnessId),
          input: {
            runId: plan.runId,
            nodeId: node.id,
            directory: this.directory,
            session,
            modelId: node.modelId,
            job: node.job,
            context,
            access: node.access,
            outputSchema: NODE_OUTCOME_JSON_SCHEMA,
            onSession: (ref) => {
              attempt.session = ref;
              const record: HarnessSession = {
                runId: plan.runId,
                nodeId: node.id,
                harnessId: ref.harnessId,
                sessionId: ref.sessionId,
                directory: ref.directory,
                updatedAt: new Date().toISOString(),
              };
              // Persist the session as soon as it is reported so a restart
              // can resume (or abort) it.
              this.database.saveHarnessSession(record);
            },
            onEvent: (event) => this.observer.harnessEvent(node.id, event),
          },
          parse: (value) => nodeOutcomeSchema.parse(value),
          schemaName: "NodeOutcome",
        }),
        cancelled,
      ]);
      if (result === "cancelled" || attempt.cancelled || this.stopRequested) {
        execution.status = "cancelled";
        this.persistNode(plan, execution);
        this.observer.nodeFinished(node, execution);
        return;
      }
      execution.outcome = result.output;
      execution.status =
        result.output.status === "succeeded" ? "succeeded" : "failed";
    } catch (error) {
      if (attempt.cancelled || this.stopRequested) {
        execution.status = "cancelled";
      } else {
        execution.status = "failed";
        execution.error = errorMessage(error);
      }
    } finally {
      this.inFlight.delete(attempt);
    }
    this.persistNode(plan, execution);
    this.observer.nodeFinished(node, execution);
  }

  private completeCheckpoint(
    execution: NodeExecution,
    node: CheckpointNode,
  ): void {
    const outcome: NodeOutcome = {
      status: "succeeded",
      summary: `Checkpoint ${node.name} passed.`,
      artifacts: [],
      messages: [],
      selectedEdgeIds: [],
    };
    execution.outcome = outcome;
    execution.status = "succeeded";
  }

  private pauseAtCheckpoint(
    graph: CompiledGraph,
    plan: ExecutionPlan,
    node: CheckpointNode,
  ): void {
    const execution = plan.nodes.find((item) => item.nodeId === node.id)!;
    execution.visits += 1;
    execution.status = "waiting";
    plan.stepCount += 1;
    plan.status = "paused";
    this.persistNode(plan, execution);
    this.observer.nodeStarted(
      node,
      execution.visits,
      this.nodeContext(graph, node),
    );
    this.observer.planUpdated(plan);
  }

  // --- Persistence ----------------------------------------------------------

  private persist(plan: ExecutionPlan): void {
    plan.updatedAt = new Date().toISOString();
    this.database.saveExecutionPlan(plan);
  }

  private persistNode(plan: ExecutionPlan, execution: NodeExecution): void {
    plan.updatedAt = new Date().toISOString();
    this.database.savePlanAndNodeExecution(plan, execution);
  }
}
