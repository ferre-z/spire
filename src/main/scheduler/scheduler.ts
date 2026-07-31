import { z } from "zod";
import type { CollaborationMessage } from "../../shared/collaboration";
import type {
  AgentNode,
  CheckpointNode,
  DecisionNode,
} from "../../shared/domain";
import {
  nodeOutcomeSchema,
  type AppliedPlanPatch,
  type CollaborationMessageDraft,
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
import type { CollaborationWorkspace } from "../collaboration/workspace";
import type { SpireDatabase } from "../database";
import { runHarnessStructured } from "../harness/adapter";
import type { NodeWorkspaceCoordinator } from "../workspace/node-worktree";
import type { CompiledGraph, CompiledNode } from "./graph-compiler";
import {
  applyPlanPatch,
  PlanPatchError,
  rebuildRuntimeGraph,
  rollbackPlanPatch,
} from "./plan-patcher";

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
  /**
   * App-managed Markdown collaboration space. When present, outcome messages
   * are delivered to per-node inboxes and each agent-like node's context is
   * its assembled context packet (plus the routing section).
   */
  collaboration?: CollaborationWorkspace;
  /**
   * Per-node workspace isolation. When present, workspace-write nodes run in
   * private node worktrees that merge into the integration branch at
   * checkpoints; scope violations and merge conflicts become node failures.
   */
  workspaces?: NodeWorkspaceCoordinator;
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
  private readonly collaboration?: CollaborationWorkspace;
  private readonly workspaces?: NodeWorkspaceCoordinator;
  private readonly inFlight = new Set<InFlightAttempt>();
  private stopRequested = false;

  constructor(deps: GraphSchedulerDeps) {
    this.database = deps.database;
    this.registry = deps.registry;
    this.goal = deps.goal;
    this.directory = deps.directory;
    this.observer = deps.observer;
    this.collaboration = deps.collaboration;
    this.workspaces = deps.workspaces;
  }

  /**
   * Run a freshly compiled plan to a terminal state (or until stopped).
   * Resolves with the final plan; never rejects for node-level failures.
   * The routing graph is the runtime universe: the base compiled graph plus
   * every non-rolled-back patch (fresh plans have none).
   */
  async start(
    graph: CompiledGraph,
    plan: ExecutionPlan,
  ): Promise<ExecutionPlan> {
    this.stopRequested = false;
    plan.status = "running";
    this.persist(plan);
    return this.runLoop(rebuildRuntimeGraph(graph, plan.patches), plan);
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
        await this.passCheckpoint(plan, execution, node);
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
    return this.runLoop(rebuildRuntimeGraph(graph, plan.patches), plan);
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
      // A patch's pause operation takes effect at the next safe point: the
      // current node completions finish, then the loop stops scheduling.
      if (plan.status === "paused") {
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
        execution.status === "failed" && !this.failureHandled(plan, execution),
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
    const seeds = this.seedIds(plan);
    return plan.edges.some((edge) => {
      const target = byId.get(edge.target);
      const node = graph.nodes.find((item) => item.id === edge.target);
      if (!target || !node) return false;
      if (target.visits < this.maxVisits(node)) return false;
      return this.tokenPending(plan, byId, seeds, edge);
    });
  }

  /**
   * A failed node is "handled" when its failure was routed and consumed
   * downstream: some node it could activate (failure/always edge, or a
   * selected edge it chose) has since run.
   */
  private failureHandled(
    plan: ExecutionPlan,
    execution: NodeExecution,
  ): boolean {
    const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
    return plan.edges.some((edge) => {
      if (edge.source !== execution.nodeId) return false;
      const routed =
        edge.when === "failure" ||
        edge.when === "always" ||
        (edge.when === "selected" &&
          (execution.outcome?.selectedEdgeIds.includes(edge.id) ?? false));
      return routed && (byId.get(edge.target)?.visits ?? 0) > 0;
    });
  }

  /**
   * The active topology's seed set: nodes with no incoming active edge, or —
   * for a pure cycle — the first node in plan order. Derived from the plan
   * (not the compiled graph) so runtime patches reshape activation.
   */
  private seedIds(plan: ExecutionPlan): Set<string> {
    const targeted = new Set(plan.edges.map((edge) => edge.target));
    const seeds = plan.nodes
      .filter((node) => !targeted.has(node.nodeId))
      .map((node) => node.nodeId);
    if (seeds.length === 0 && plan.nodes.length > 0) {
      seeds.push(plan.nodes[0].nodeId);
    }
    return new Set(seeds);
  }

  private selectReady(graph: CompiledGraph, plan: ExecutionPlan): CompiledNode[] {
    const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
    const configs = new Map(graph.nodes.map((node) => [node.id, node]));
    const seeds = this.seedIds(plan);
    const ready: CompiledNode[] = [];
    // Plan order is the deterministic declaration order (patches may have
    // reordered it); node configurations come from the runtime universe.
    for (const execution of plan.nodes) {
      const node = configs.get(execution.nodeId);
      if (!node) continue;
      // Terminal-unless-retried: patches (skip/remove supersede) and stops
      // park nodes here; only an explicit retry (re-queue) revives them.
      if (execution.status === "skipped" || execution.status === "cancelled") {
        continue;
      }
      if (execution.status === "queued") {
        ready.push(node);
        continue;
      }
      if (execution.status === "running") continue;
      // `waiting` with visits > 0 is a paused manual checkpoint.
      if (execution.status === "waiting" && execution.visits > 0) continue;
      if (execution.visits >= this.maxVisits(node)) continue;
      if (seeds.has(node.id) && execution.visits === 0) {
        ready.push(node);
        continue;
      }
      const incoming = plan.edges.filter((edge) => edge.target === node.id);
      if (incoming.length === 0) continue;
      const pending = (edge: (typeof incoming)[number]) =>
        this.tokenPending(plan, byId, seeds, edge);
      const activation = isAgentLike(node) ? node.activation : "all";
      const active =
        activation === "any"
          ? incoming.some(pending)
          : incoming.every(pending);
      if (active) ready.push(node);
    }
    return ready;
  }

  /**
   * A token is pending on an edge when the source has completed more visits
   * than the target has consumed, and the source's latest outcome satisfies
   * the edge condition.
   */
  private tokenPending(
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
  private nodeContext(plan: ExecutionPlan, node: CompiledNode): string {
    return `Run goal: ${this.goal}${this.routingContext(plan, node)}`;
  }

  /**
   * The routing section listing a node's selectable outgoing edges. Kept in
   * every context form (plain or collaboration packet): the model must see
   * the edge ids + labels to fill `selectedEdgeIds`. Only active plan edges
   * are offered — patch-disabled edges are not routing choices.
   */
  private routingContext(plan: ExecutionPlan, node: CompiledNode): string {
    const selectable = plan.edges.filter(
      (edge) => edge.source === node.id && edge.when === "selected",
    );
    if (selectable.length === 0) return "";
    const choices = selectable
      .map((edge) => `"${edge.id}" (${edge.label})`)
      .join(", ");
    return (
      `\n\nRouting: to pass work to the next node, include the matching ` +
      `edge id in your output's selectedEdgeIds: ${choices}. ` +
      `Leave selectedEdgeIds empty when no further work is needed.`
    );
  }

  /**
   * Context for a node attempt. With a collaboration workspace, agent-like
   * nodes get the assembled Markdown context packet (run objective, job,
   * accessible paths, authority, incoming messages, predecessor outputs)
   * built against the attempt's actual working directory; the routing
   * section is appended either way.
   */
  private async contextFor(
    graph: CompiledGraph,
    plan: ExecutionPlan,
    node: CompiledNode,
    directory: string,
  ): Promise<string> {
    if (!this.collaboration || !isAgentLike(node)) {
      return this.nodeContext(plan, node);
    }
    const byId = new Map(plan.nodes.map((item) => [item.nodeId, item]));
    const predecessors = plan.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => {
        const source = graph.nodes.find((item) => item.id === edge.source);
        const execution = byId.get(edge.source);
        return {
          nodeId: edge.source,
          name: source?.name ?? edge.source,
          status: execution?.status ?? "waiting",
          summary: execution?.outcome?.summary ?? execution?.error,
          artifacts: execution?.outcome?.artifacts ?? [],
        };
      });
    const packet = await this.collaboration.buildContextPacket({
      node,
      directory,
      predecessors,
    });
    return `${packet}${this.routingContext(plan, node)}`;
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

    if (node.kind === "checkpoint") {
      this.observer.nodeStarted(
        node,
        execution.visits,
        this.nodeContext(plan, node),
      );
      await this.passCheckpoint(plan, execution, node);
      this.persistNode(plan, execution);
      this.observer.nodeFinished(node, execution);
      return;
    }

    // Workspace isolation: workspace-write attempts branch a private node
    // worktree off the current checkpoint; read-only nodes run in the run's
    // integration worktree. A preparation failure is a node failure, never
    // a scheduler crash.
    let directory = this.directory;
    let isolated = false;
    if (this.workspaces && isAgentLike(node)) {
      try {
        const prepared = await this.workspaces.prepareNode({
          nodeId: node.id,
          visit: execution.visits,
          access: node.access,
        });
        directory = prepared.directory;
        isolated = prepared.branch !== undefined;
      } catch (error) {
        execution.status = "failed";
        execution.error = errorMessage(error);
        this.persistNode(plan, execution);
        this.observer.nodeStarted(
          node,
          execution.visits,
          this.nodeContext(plan, node),
        );
        this.observer.nodeFinished(node, execution);
        return;
      }
    }

    const context = await this.contextFor(graph, plan, node, directory);
    this.observer.nodeStarted(node, execution.visits, context);

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
            directory,
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
        await this.discardWorkspace(node);
        this.persistNode(plan, execution);
        this.observer.nodeFinished(node, execution);
        return;
      }
      execution.outcome = result.output;
      execution.status =
        result.output.status === "succeeded" ? "succeeded" : "failed";
      // Post-outcome bookkeeping. Scope violations, delivery errors, and
      // other collaboration/workspace failures convert into node failures
      // (eligible for failure routing) instead of crashing the loop.
      try {
        if (execution.status === "succeeded" && isolated && this.workspaces) {
          await this.workspaces.commitNode(node.id);
        }
        await this.deliverMessages(plan, node, result.output.messages);
      } catch (error) {
        execution.status = "failed";
        execution.error = errorMessage(error);
      }
      // A patch draft in the outcome applies now — after node completion, a
      // safe point — and before any successor activates. Both succeeded and
      // failed outcomes may carry one (a failed node's patch is its failure
      // recovery). Validation/authorization failures fail the node; a
      // rejected patch never partially applies.
      if (result.output.patch) {
        try {
          const applied = applyPlanPatch(plan, graph, node.id, result.output.patch);
          this.database.savePatchedPlan(plan, applied.patch, {
            removedNodeIds: applied.removedNodeIds,
            changedNodes: applied.changedNodes,
          });
          this.observer.planUpdated(plan);
        } catch (error) {
          execution.status = "failed";
          execution.error = errorMessage(error);
        }
      }
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
    // A node worktree whose attempt did not succeed never merges.
    if (execution.status !== "succeeded") {
      await this.discardWorkspace(node);
    }
    this.persistNode(plan, execution);
    this.observer.nodeFinished(node, execution);
  }

  /** Discard a node's workspace-write worktree/branch, if any. */
  private async discardWorkspace(node: CompiledNode): Promise<void> {
    if (!this.workspaces || !isAgentLike(node)) return;
    await this.workspaces.discardNode(node.id).catch(() => undefined);
  }

  /**
   * Per-run delivery queue. A scheduler instance drives exactly one run, and
   * sequences are allocated from the persisted message count, so the whole
   * read-count → append → deliver sequence for one node's drafts must
   * complete before another node's begins — otherwise two nodes completing
   * concurrently interleave and allocate duplicate `<runId>:<seq>` ids.
   */
  private deliveryQueue: Promise<unknown> = Promise.resolve();

  /**
   * Persist an outcome's collaboration drafts (database first, then the
   * Markdown inboxes) with run-scoped chronological sequences. Serialized
   * per run; errors still propagate to the caller (node failure) without
   * poisoning the queue.
   */
  private deliverMessages(
    plan: ExecutionPlan,
    node: CompiledNode,
    drafts: CollaborationMessageDraft[],
  ): Promise<void> {
    if (drafts.length === 0) return Promise.resolve();
    const delivery = this.deliveryQueue.then(() =>
      this.deliverMessagesNow(plan, node, drafts),
    );
    this.deliveryQueue = delivery.catch(() => undefined);
    return delivery;
  }

  private async deliverMessagesNow(
    plan: ExecutionPlan,
    node: CompiledNode,
    drafts: CollaborationMessageDraft[],
  ): Promise<void> {
    let sequence = this.database.listCollaborationMessages(plan.runId).length;
    for (const draft of drafts) {
      const message: CollaborationMessage = {
        ...draft,
        id: `${plan.runId}:${sequence}`,
        runId: plan.runId,
        senderNodeId: node.id,
        sequence,
        createdAt: new Date().toISOString(),
      };
      this.database.appendCollaborationMessage(message);
      await this.collaboration?.deliver(message);
      sequence += 1;
    }
  }

  /**
   * Pass a checkpoint (automatic pass or manual resume): merge every pending
   * node branch into the integration branch — in node-id order — and record
   * the checkpoint document. Merge conflicts flip the conflicting nodes to
   * `failed` (eligible for failure routing); a merge/collaboration
   * infrastructure error fails the checkpoint itself rather than crashing
   * the loop.
   */
  private async passCheckpoint(
    plan: ExecutionPlan,
    execution: NodeExecution,
    node: CheckpointNode,
  ): Promise<void> {
    if (this.workspaces) {
      let mergeError: unknown;
      try {
        const result = await this.workspaces.mergeAtCheckpoint();
        for (const conflict of result.conflicts) {
          const target = plan.nodes.find(
            (item) => item.nodeId === conflict.nodeId,
          );
          if (!target) continue;
          target.status = "failed";
          target.error =
            `Merge conflict merging node ${conflict.nodeId} at checkpoint ` +
            `${node.id}: ${conflict.files.join(", ") || "unknown files"}.`;
          this.persistNode(plan, target);
        }
      } catch (error) {
        mergeError = error;
      }
      if (mergeError !== undefined) {
        execution.status = "failed";
        execution.error = errorMessage(mergeError);
        return;
      }
    }
    if (this.collaboration) {
      try {
        await this.collaboration.recordCheckpoint({
          nodeId: node.id,
          name: node.name,
          summary: `Checkpoint ${node.name} passed.`,
        });
      } catch (error) {
        execution.status = "failed";
        execution.error = errorMessage(error);
        return;
      }
    }
    this.completeCheckpoint(execution, node);
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
      this.nodeContext(plan, node),
    );
    this.observer.planUpdated(plan);
  }

  /**
   * Roll back an applied patch as a new audited revision, using the
   * persisted revision snapshots. Only the latest active patch can be rolled
   * back; the runtime graph is re-derived from the base graph plus the
   * remaining patch log on the next start/resume. Throws PlanPatchError on
   * any violation; on success the rollback is persisted atomically (plan,
   * rollback record, rolled-back marker, dropped node rows).
   */
  rollbackPatch(
    graph: CompiledGraph,
    plan: ExecutionPlan,
    patchId: string,
  ): AppliedPlanPatch {
    const target = plan.patches.find((item) => item.id === patchId);
    if (!target) {
      throw new PlanPatchError([`Unknown patch ${patchId}.`]);
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
      throw new PlanPatchError([
        `Plan revision history for run ${plan.runId} is unavailable; ` +
          `cannot roll back ${patchId}.`,
      ]);
    }
    const runtime = rebuildRuntimeGraph(graph, plan.patches);
    const result = rollbackPlanPatch(plan, runtime, patchId, { base, applied });
    this.database.savePatchedPlan(plan, result.patch, {
      removedNodeIds: result.removedNodeIds,
      changedNodes: result.changedNodes,
      rolledBackPatchId: patchId,
    });
    this.observer.planUpdated(plan);
    return result.patch;
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
