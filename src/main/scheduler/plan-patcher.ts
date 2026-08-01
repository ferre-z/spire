import { randomUUID } from "node:crypto";
import type {
  AgentNode,
  DecisionNode,
  GraphEdge,
  GraphGroup,
  GraphNode,
  PlanMutation,
} from "../../shared/domain";
import {
  executionPlanSchema,
  type AppliedPlanPatch,
  type ExecutionPlan,
  type NodeExecution,
  type PlanPatchDraft,
  type PlanPatchOperation,
} from "../../shared/execution";
import type { CompiledGraph, CompiledNode } from "./graph-compiler";

/**
 * Authorized runtime plan patches.
 *
 * A node whose outcome carries a `PlanPatchDraft` asks to mutate the run's
 * execution plan. The patcher is the single authority gate and topology
 * mutation point:
 *
 * - Timing is the caller's responsibility: the scheduler applies patches only
 *   after a node completes (success or failure — a failed node's patch is its
 *   failure recovery); control APIs may apply them at explicit checkpoints.
 * - `draft.baseRevision` must equal the plan's current revision (optimistic
 *   concurrency: a patch computed against a stale plan is rejected).
 * - Every operation must be granted by the actor's `NodeAuthority` — the
 *   action name must be listed and the operation's targets must fall inside
 *   the actor's scope:
 *     self       only the actor's own node;
 *     connected  the actor plus nodes adjacent to it in the active plan
 *                edges; reroute/insert only edges incident to the actor;
 *     group      additionally every node sharing the actor's groupId;
 *     graph      the whole plan, including plan-wide `pause`.
 *   Scope is always evaluated against the pre-patch plan topology.
 * - A running or completed attempt is never removed, replaced, or skipped;
 *   `replace` creates a new execution node and marks only the pending
 *   original as superseded (skipped). Runtime plans are flat, so inserted or
 *   replacement nodes may not be subgraph references.
 * - Validation runs against a candidate copy; the live plan and graph are
 *   mutated only after the complete candidate validates, so a failing
 *   multi-operation patch leaves no partial apply. The caller persists the
 *   result in one transaction (see SpireDatabase.savePatchedPlan).
 *
 * The "universe" (the runtime CompiledGraph) is the union of every node and
 * edge the plan has ever known: `reroute` moves edges between the universe
 * and the plan's active edge set, and `insert`/`replace`/`edit` extend the
 * universe. `rebuildRuntimeGraph` re-derives the universe from the base
 * compiled graph plus the non-rolled-back patch log, so a restarted process
 * recovers the exact runtime topology.
 *
 * Rollback restores the pre-patch topology from the persisted revision
 * snapshots (first write per revision — topology is constant within a
 * revision) as a new audited revision, and marks the original patch with
 * `rolledBackBy`. Only the latest active patch can be rolled back (a stack).
 * A rollback is rejected when the patch's work has already executed — an
 * inserted/replacement node that ran, or an affected node whose state
 * progressed since the patch. Restored nodes keep their current visit count
 * (visits are monotonic; token accounting never rewinds). The recorded
 * operation list is the semantic inverse of the original operations;
 * `reorder`/`edit`/`pause` have no expressible inverse operation, so their
 * original operation is recorded while the undo happens at state level via
 * the revision snapshot.
 */

export class PlanPatchError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join(" "));
    this.name = "PlanPatchError";
  }
}

export type PlanPatchApplyOptions = {
  /** Deterministic id for tests; defaults to a random UUID. */
  patchId?: string;
  /** Deterministic timestamp for tests; defaults to now. */
  appliedAt?: string;
};

export type AppliedPatchResult = {
  /** The audit record appended to the plan (and to persist). */
  patch: AppliedPlanPatch;
  /** Node ids dropped from the plan (their execution rows can be deleted). */
  removedNodeIds: string[];
  /** Executions the patch created or modified (upsert their rows). */
  changedNodes: NodeExecution[];
};

/** Snapshots the rollback needs: the plan at baseRevision and at appliedRevision. */
export type PlanPatchHistory = {
  base: ExecutionPlan;
  applied: ExecutionPlan;
};

/**
 * Input for saving a promoted runtime plan as a new saved graph version.
 * The caller assigns the version number and timestamp at save time.
 */
export type GraphVersionPromotionInput = {
  graphId: string;
  name: string;
  /** The saved graph version the run was compiled from. */
  baseVersion: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
  maxSteps: number;
};

const SCOPE_RANK: Record<AgentNode["authority"]["scope"], number> = {
  self: 0,
  connected: 1,
  group: 2,
  graph: 3,
};

const NODE_TARGETED_ACTIONS = new Set([
  "retry",
  "skip",
  "remove",
  "reorder",
  "edit",
  "replace",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isAgentLike(node: CompiledNode): node is AgentNode | DecisionNode {
  return node.kind === "agent" || node.kind === "decision";
}

function maxVisits(node: CompiledNode): number {
  return isAgentLike(node) ? node.maxVisits : Number.MAX_SAFE_INTEGER;
}

function planNode(plan: ExecutionPlan, nodeId: string): NodeExecution | undefined {
  return plan.nodes.find((node) => node.nodeId === nodeId);
}

function universeNode(graph: CompiledGraph, nodeId: string): CompiledNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

function isPending(execution: NodeExecution): boolean {
  return (
    execution.visits === 0 &&
    (execution.status === "waiting" || execution.status === "queued")
  );
}

/** Scope-derived target sets, always computed on the pre-patch plan. */
type ActorScope = {
  rank: number;
  /** Node ids node-targeted operations may touch. */
  targetIds: Set<string>;
  /** Endpoint ids allowed for rerouted/inserted edges. */
  endpointIds: Set<string>;
};

function actorScope(plan: ExecutionPlan, graph: CompiledGraph, actor: CompiledNode): ActorScope {
  const authority = isAgentLike(actor)
    ? actor.authority
    : { scope: "self" as const, actions: [] };
  const rank = SCOPE_RANK[authority.scope];
  const targetIds = new Set([actor.id]);
  const endpointIds = new Set([actor.id]);
  if (rank >= SCOPE_RANK.connected) {
    for (const edge of plan.edges) {
      if (edge.source === actor.id) targetIds.add(edge.target);
      if (edge.target === actor.id) targetIds.add(edge.source);
    }
  }
  if (rank >= SCOPE_RANK.group && isAgentLike(actor) && actor.groupId) {
    for (const node of graph.nodes) {
      if (isAgentLike(node) && node.groupId === actor.groupId) {
        targetIds.add(node.id);
        endpointIds.add(node.id);
      }
    }
  }
  if (rank >= SCOPE_RANK.graph) {
    for (const node of plan.nodes) targetIds.add(node.nodeId);
    for (const node of graph.nodes) endpointIds.add(node.id);
  }
  return { rank, targetIds, endpointIds };
}

type MutationContext = {
  candidate: ExecutionPlan;
  universe: CompiledGraph;
  actor: CompiledNode;
  scope: ActorScope;
  issues: string[];
  removedNodeIds: string[];
  changed: Map<string, NodeExecution>;
};

function markChanged(context: MutationContext, execution: NodeExecution): void {
  context.changed.set(execution.nodeId, { ...execution });
}

function checkActionAndScope(
  context: MutationContext,
  operation: PlanPatchOperation,
): boolean {
  const authority = isAgentLike(context.actor)
    ? context.actor.authority
    : { scope: "self" as const, actions: [] as PlanMutation[] };
  if (!authority.actions.includes(operation.action as PlanMutation)) {
    context.issues.push(
      `Node ${context.actor.id} authority does not grant action "${operation.action}".`,
    );
    return false;
  }
  if (NODE_TARGETED_ACTIONS.has(operation.action) && "nodeId" in operation) {
    if (!context.scope.targetIds.has(operation.nodeId)) {
      context.issues.push(
        `Node ${operation.nodeId} is outside the actor's ${authority.scope} authority scope.`,
      );
      return false;
    }
  }
  if (operation.action === "pause" && context.scope.rank < SCOPE_RANK.graph) {
    context.issues.push(
      `Pausing the plan is outside the actor's ${authority.scope} authority scope.`,
    );
    return false;
  }
  if (operation.action === "reroute") {
    for (const edgeId of [...operation.enableEdgeIds, ...operation.disableEdgeIds]) {
      const edge = context.universe.edges.find((item) => item.id === edgeId);
      if (!edge) continue; // unknown-edge issue is reported by the operation itself
      if (
        !context.scope.endpointIds.has(edge.source) &&
        !context.scope.endpointIds.has(edge.target)
      ) {
        context.issues.push(
          `Edge ${edgeId} is outside the actor's ${authority.scope} authority scope.`,
        );
        return false;
      }
    }
  }
  if (operation.action === "insert") {
    for (const edge of operation.edges) {
      if (
        !context.scope.endpointIds.has(edge.source) &&
        !context.scope.endpointIds.has(edge.target)
      ) {
        context.issues.push(
          `Insert edge ${edge.id} is outside the actor's ${authority.scope} authority scope.`,
        );
        return false;
      }
    }
  }
  return true;
}

function applyOperation(operation: PlanPatchOperation, context: MutationContext): void {
  if (!checkActionAndScope(context, operation)) return;
  const { candidate, universe, issues } = context;
  switch (operation.action) {
    case "retry": {
      const execution = planNode(candidate, operation.nodeId);
      if (!execution) {
        issues.push(`Unknown node ${operation.nodeId}.`);
        return;
      }
      const retryable =
        execution.status === "failed" ||
        execution.status === "cancelled" ||
        execution.status === "skipped" ||
        execution.status === "succeeded";
      if (!retryable) {
        issues.push(
          `Cannot retry node ${operation.nodeId} in status "${execution.status}".`,
        );
        return;
      }
      const config = universeNode(universe, operation.nodeId);
      if (config && execution.visits >= maxVisits(config)) {
        issues.push(
          `Cannot retry node ${operation.nodeId}: it exhausted its maxVisits bound.`,
        );
        return;
      }
      execution.status = "queued";
      execution.error = undefined;
      markChanged(context, execution);
      return;
    }
    case "skip": {
      const execution = planNode(candidate, operation.nodeId);
      if (!execution) {
        issues.push(`Unknown node ${operation.nodeId}.`);
        return;
      }
      if (!isPending(execution)) {
        issues.push(
          `Cannot skip node ${operation.nodeId} in status "${execution.status}".`,
        );
        return;
      }
      execution.status = "skipped";
      markChanged(context, execution);
      return;
    }
    case "remove": {
      const execution = planNode(candidate, operation.nodeId);
      if (!execution) {
        issues.push(`Unknown node ${operation.nodeId}.`);
        return;
      }
      if (!isPending(execution)) {
        issues.push(
          `Cannot remove node ${operation.nodeId} in status "${execution.status}": ` +
            `only pending work can be removed.`,
        );
        return;
      }
      if (candidate.nodes.length <= 1) {
        issues.push(`A patch cannot remove the plan's last node.`);
        return;
      }
      candidate.nodes = candidate.nodes.filter(
        (node) => node.nodeId !== operation.nodeId,
      );
      candidate.edges = candidate.edges.filter(
        (edge) => edge.source !== operation.nodeId && edge.target !== operation.nodeId,
      );
      context.removedNodeIds.push(operation.nodeId);
      context.changed.delete(operation.nodeId);
      return;
    }
    case "reorder": {
      const execution = planNode(candidate, operation.nodeId);
      const before = planNode(candidate, operation.beforeNodeId);
      if (!execution) issues.push(`Unknown node ${operation.nodeId}.`);
      if (!before) issues.push(`Unknown node ${operation.beforeNodeId}.`);
      if (!execution || !before) return;
      if (operation.nodeId === operation.beforeNodeId) {
        issues.push(`Cannot reorder node ${operation.nodeId} before itself.`);
        return;
      }
      if (execution.status === "running") {
        issues.push(`Cannot reorder running node ${operation.nodeId}.`);
        return;
      }
      const nodes = candidate.nodes.filter(
        (node) => node.nodeId !== operation.nodeId,
      );
      nodes.splice(
        nodes.findIndex((node) => node.nodeId === operation.beforeNodeId),
        0,
        execution,
      );
      candidate.nodes = nodes;
      return;
    }
    case "reroute": {
      const overlap = operation.enableEdgeIds.filter((id) =>
        operation.disableEdgeIds.includes(id),
      );
      if (overlap.length > 0) {
        issues.push(`Edges cannot be enabled and disabled at once: ${overlap.join(", ")}.`);
        return;
      }
      let valid = true;
      for (const edgeId of operation.enableEdgeIds) {
        if (!universe.edges.some((edge) => edge.id === edgeId)) {
          issues.push(`Unknown edge ${edgeId}.`);
          valid = false;
        } else if (candidate.edges.some((edge) => edge.id === edgeId)) {
          issues.push(`Edge ${edgeId} is already active.`);
          valid = false;
        }
      }
      for (const edgeId of operation.disableEdgeIds) {
        if (!candidate.edges.some((edge) => edge.id === edgeId)) {
          issues.push(`Edge ${edgeId} is not active.`);
          valid = false;
        }
      }
      if (!valid) return;
      candidate.edges = candidate.edges.filter(
        (edge) => !operation.disableEdgeIds.includes(edge.id),
      );
      for (const edge of universe.edges) {
        if (operation.enableEdgeIds.includes(edge.id)) {
          candidate.edges.push(clone(edge));
        }
      }
      return;
    }
    case "pause": {
      candidate.status = "paused";
      return;
    }
    case "replace": {
      const execution = planNode(candidate, operation.nodeId);
      if (!execution) {
        issues.push(`Unknown node ${operation.nodeId}.`);
        return;
      }
      const replacement = operation.replacement;
      if (replacement.kind === "subgraph") {
        issues.push(`Replacement node ${replacement.id} cannot be a subgraph reference.`);
        return;
      }
      if (replacement.id === operation.nodeId) {
        issues.push(
          `Replacement node ${replacement.id} reuses the replaced id; use edit instead.`,
        );
        return;
      }
      if (universeNode(universe, replacement.id)) {
        issues.push(`Replacement node ${replacement.id} already exists.`);
        return;
      }
      if (!isPending(execution)) {
        issues.push(
          `Cannot replace node ${operation.nodeId} in status "${execution.status}": ` +
            `only pending work can be superseded.`,
        );
        return;
      }
      // Only pending work is superseded: the original stays in the log as
      // skipped, and the replacement takes over its edges and queue state.
      const priorStatus = execution.status;
      execution.status = "skipped";
      markChanged(context, execution);
      const successor: NodeExecution = {
        nodeId: replacement.id,
        status: priorStatus,
        visits: 0,
      };
      candidate.nodes.splice(
        candidate.nodes.findIndex((node) => node.nodeId === operation.nodeId) + 1,
        0,
        successor,
      );
      candidate.edges = candidate.edges.map((edge) => ({
        ...edge,
        source: edge.source === operation.nodeId ? replacement.id : edge.source,
        target: edge.target === operation.nodeId ? replacement.id : edge.target,
      }));
      universe.nodes.push(clone(replacement) as CompiledNode);
      markChanged(context, successor);
      return;
    }
    case "insert": {
      const node = operation.node;
      if (node.kind === "subgraph") {
        issues.push(`Inserted node ${node.id} cannot be a subgraph reference.`);
        return;
      }
      if (universeNode(universe, node.id)) {
        issues.push(`Inserted node ${node.id} already exists.`);
        return;
      }
      let valid = true;
      const edgeIds = new Set<string>();
      for (const edge of operation.edges) {
        if (edge.source !== node.id && edge.target !== node.id) {
          issues.push(`Insert edge ${edge.id} is not attached to node ${node.id}.`);
          valid = false;
        }
        if (edgeIds.has(edge.id) || universe.edges.some((item) => item.id === edge.id)) {
          issues.push(`Insert edge ${edge.id} already exists.`);
          valid = false;
        }
        edgeIds.add(edge.id);
        const endpoints = [edge.source, edge.target];
        for (const endpoint of endpoints) {
          if (endpoint !== node.id && !universeNode(universe, endpoint)) {
            issues.push(`Insert edge ${edge.id} references unknown node ${endpoint}.`);
            valid = false;
          }
        }
      }
      if (!valid) return;
      universe.nodes.push(clone(node) as CompiledNode);
      universe.edges.push(...operation.edges.map((item) => clone(item)));
      candidate.edges.push(...operation.edges.map((item) => clone(item)));
      const hasIncoming = candidate.edges.some((edge) => edge.target === node.id);
      const execution: NodeExecution = {
        nodeId: node.id,
        status: hasIncoming ? "waiting" : "queued",
        visits: 0,
      };
      candidate.nodes.push(execution);
      markChanged(context, execution);
      return;
    }
    case "edit": {
      const execution = planNode(candidate, operation.nodeId);
      if (!execution) {
        issues.push(`Unknown node ${operation.nodeId}.`);
        return;
      }
      if (execution.status === "running") {
        issues.push(`Cannot edit running node ${operation.nodeId}.`);
        return;
      }
      const replacement = operation.replacement;
      if (replacement.id !== operation.nodeId) {
        issues.push(
          `Edit of node ${operation.nodeId} must keep its id (got ${replacement.id}).`,
        );
        return;
      }
      const index = universe.nodes.findIndex((node) => node.id === operation.nodeId);
      if (index < 0) {
        issues.push(`Unknown node ${operation.nodeId}.`);
        return;
      }
      if (universe.nodes[index].kind !== replacement.kind) {
        issues.push(
          `Edit of node ${operation.nodeId} cannot change its kind.`,
        );
        return;
      }
      universe.nodes[index] = clone(replacement) as CompiledNode;
      return;
    }
  }
}

function validateCandidatePlan(candidate: ExecutionPlan, issues: string[]): void {
  const ids = new Set(candidate.nodes.map((node) => node.nodeId));
  if (ids.size !== candidate.nodes.length) {
    issues.push(`The patched plan contains duplicate node ids.`);
  }
  const edgeIds = new Set<string>();
  for (const edge of candidate.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push(`The patched plan contains duplicate edge id ${edge.id}.`);
    }
    edgeIds.add(edge.id);
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      issues.push(`The patched plan's edge ${edge.id} references a removed node.`);
    }
  }
  if (candidate.nodes.length === 0) {
    issues.push(`The patched plan has no nodes left.`);
  }
  if (issues.length > 0) return;
  const parsed = executionPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`Invalid patched plan: ${issue.message}`);
    }
  }
}

type PreparedPatch = {
  candidate: ExecutionPlan;
  universe: CompiledGraph;
  issues: string[];
  removedNodeIds: string[];
  changedNodes: NodeExecution[];
};

function preparePatch(
  plan: ExecutionPlan,
  graph: CompiledGraph,
  actorNodeId: string,
  draft: PlanPatchDraft,
): PreparedPatch {
  const candidate = clone(plan);
  const universe = clone(graph);
  const issues: string[] = [];
  const actor = universeNode(universe, actorNodeId);
  if (!actor || !isAgentLike(actor)) {
    issues.push(`Actor ${actorNodeId} cannot author plan patches.`);
    return { candidate, universe, issues, removedNodeIds: [], changedNodes: [] };
  }
  if (draft.baseRevision !== plan.revision) {
    issues.push(
      `Stale base revision ${draft.baseRevision}: the plan is at revision ${plan.revision}.`,
    );
    return { candidate, universe, issues, removedNodeIds: [], changedNodes: [] };
  }
  const context: MutationContext = {
    candidate,
    universe,
    actor,
    scope: actorScope(plan, graph, actor),
    issues,
    removedNodeIds: [],
    changed: new Map(),
  };
  for (const operation of draft.operations) {
    applyOperation(operation, context);
  }
  if (issues.length === 0) {
    candidate.revision = plan.revision + 1;
    validateCandidatePlan(candidate, issues);
  }
  return {
    candidate,
    universe,
    issues,
    removedNodeIds: context.removedNodeIds,
    changedNodes: [...context.changed.values()],
  };
}

/**
 * Validate a patch draft without mutating anything. Returns the list of
 * issues; an empty list means the patch can be applied.
 */
export function validatePlanPatch(
  plan: ExecutionPlan,
  graph: CompiledGraph,
  actorNodeId: string,
  draft: PlanPatchDraft,
): string[] {
  return preparePatch(plan, graph, actorNodeId, draft).issues;
}

/**
 * Validate and apply a patch to the live plan and runtime graph. Throws
 * PlanPatchError with every issue found; on failure the plan and graph are
 * untouched (atomic multi-operation failure). On success the plan's revision
 * is bumped and the audit record is appended to `plan.patches`; persistence
 * is the caller's job (one transaction).
 */
export function applyPlanPatch(
  plan: ExecutionPlan,
  graph: CompiledGraph,
  actorNodeId: string,
  draft: PlanPatchDraft,
  options: PlanPatchApplyOptions = {},
): AppliedPatchResult {
  const prepared = preparePatch(plan, graph, actorNodeId, draft);
  if (prepared.issues.length > 0) {
    throw new PlanPatchError(prepared.issues);
  }
  const appliedAt = options.appliedAt ?? new Date().toISOString();
  const patch: AppliedPlanPatch = {
    baseRevision: draft.baseRevision,
    reason: draft.reason,
    operations: clone(draft.operations),
    id: options.patchId ?? randomUUID(),
    actorNodeId,
    appliedRevision: prepared.candidate.revision,
    appliedAt,
  };
  prepared.candidate.patches = [...plan.patches, patch];
  prepared.candidate.updatedAt = appliedAt;
  commit(plan, graph, prepared.candidate, prepared.universe);
  return {
    patch,
    removedNodeIds: prepared.removedNodeIds,
    changedNodes: prepared.changedNodes,
  };
}

function commit(
  plan: ExecutionPlan,
  graph: CompiledGraph,
  candidate: ExecutionPlan,
  universe: CompiledGraph,
): void {
  plan.nodes = candidate.nodes;
  plan.edges = candidate.edges;
  plan.status = candidate.status;
  plan.revision = candidate.revision;
  plan.patches = candidate.patches;
  plan.stepCount = candidate.stepCount;
  plan.updatedAt = candidate.updatedAt;
  graph.nodes = universe.nodes;
  graph.edges = universe.edges;
  graph.seedIds = universe.seedIds;
}

/** Node ids whose execution state or membership a patch's operations touch. */
function affectedNodeIds(patch: AppliedPlanPatch): string[] {
  const ids: string[] = [];
  for (const operation of patch.operations) {
    switch (operation.action) {
      case "retry":
      case "skip":
      case "remove":
      case "reorder":
      case "edit":
        ids.push(operation.nodeId);
        break;
      case "replace":
        ids.push(operation.nodeId, operation.replacement.id);
        break;
      case "insert":
        ids.push(operation.node.id);
        break;
      default:
        break;
    }
  }
  return ids;
}

/** The semantic inverse of one operation, for the rollback audit record. */
function inverseOperations(
  operation: PlanPatchOperation,
  graph: CompiledGraph,
  base: ExecutionPlan,
): PlanPatchOperation[] {
  switch (operation.action) {
    case "retry":
      return [{ action: "skip", nodeId: operation.nodeId }];
    case "skip":
      return [{ action: "retry", nodeId: operation.nodeId }];
    case "remove": {
      const config = universeNode(graph, operation.nodeId);
      if (!config) return [operation];
      return [
        {
          action: "insert",
          node: clone(config) as GraphNode,
          edges: base.edges
            .filter(
              (edge) =>
                edge.source === operation.nodeId || edge.target === operation.nodeId,
            )
            .map((edge) => clone(edge)),
        },
      ];
    }
    case "insert":
      return [{ action: "remove", nodeId: operation.node.id }];
    case "reroute":
      return [
        {
          action: "reroute",
          enableEdgeIds: [...operation.disableEdgeIds],
          disableEdgeIds: [...operation.enableEdgeIds],
        },
      ];
    case "replace":
      return [
        { action: "remove", nodeId: operation.replacement.id },
        { action: "retry", nodeId: operation.nodeId },
      ];
    default:
      // reorder/edit/pause: no expressible inverse operation; the undo
      // happens at state level via the revision snapshot.
      return [clone(operation)];
  }
}

/**
 * Roll back an applied patch as a new audited revision. Only the latest
 * active (not rolled-back) patch can be rolled back. The pre-patch topology
 * is restored from the revision snapshots while unaffected nodes keep their
 * current execution state; nodes the patch added must not have run, and
 * affected nodes must not have progressed since the patch. Throws
 * PlanPatchError on any violation. Mutates only the plan — the caller
 * re-derives the runtime graph via rebuildRuntimeGraph and persists.
 */
export function rollbackPlanPatch(
  plan: ExecutionPlan,
  graph: CompiledGraph,
  patchId: string,
  history: PlanPatchHistory,
  options: PlanPatchApplyOptions = {},
): AppliedPatchResult {
  const patch = plan.patches.find((item) => item.id === patchId);
  if (!patch) {
    throw new PlanPatchError([`Unknown patch ${patchId}.`]);
  }
  if (patch.rolledBackBy) {
    throw new PlanPatchError([
      `Patch ${patchId} is already rolled back by ${patch.rolledBackBy}.`,
    ]);
  }
  const later = plan.patches.filter(
    (item) => item.appliedRevision > patch.appliedRevision && !item.rolledBackBy,
  );
  if (later.length > 0) {
    throw new PlanPatchError([
      `Only the latest active patch can be rolled back; roll back ` +
        `${later.map((item) => item.id).join(", ")} first.`,
    ]);
  }
  const { base, applied } = history;
  if (base.runId !== plan.runId || base.revision !== patch.baseRevision) {
    throw new PlanPatchError([
      `The base snapshot does not match patch ${patchId} (expected revision ${patch.baseRevision}).`,
    ]);
  }
  if (applied.runId !== plan.runId || applied.revision !== patch.appliedRevision) {
    throw new PlanPatchError([
      `The applied snapshot does not match patch ${patchId} (expected revision ${patch.appliedRevision}).`,
    ]);
  }

  const preIds = new Set(base.nodes.map((node) => node.nodeId));
  const postIds = new Set(applied.nodes.map((node) => node.nodeId));
  const addedIds = [...postIds].filter((id) => !preIds.has(id));
  const affected = new Set(affectedNodeIds(patch));

  const issues: string[] = [];
  // Nodes the patch added must still be fresh: rollback discards them.
  for (const nodeId of addedIds) {
    const current = planNode(plan, nodeId);
    if (!current || !isPending(current)) {
      issues.push(
        `Node ${nodeId} added by patch ${patchId} has already run; rollback would discard work.`,
      );
    }
  }
  // Affected nodes present before and after must not have progressed.
  for (const nodeId of affected) {
    if (!preIds.has(nodeId) || !postIds.has(nodeId)) continue;
    const current = planNode(plan, nodeId);
    const post = planNode(applied, nodeId);
    if (!current || !post) continue;
    if (current.status !== post.status || current.visits !== post.visits) {
      issues.push(
        `Node ${nodeId} has progressed since patch ${patchId}; rollback would discard work.`,
      );
    }
  }
  if (issues.length > 0) {
    throw new PlanPatchError(issues);
  }

  const appliedAt = options.appliedAt ?? new Date().toISOString();
  const rollbackId = options.patchId ?? randomUUID();
  const candidate = clone(plan);
  // Restore the base-revision topology in base order. Affected nodes get
  // their pre-patch state (visits stay monotonic); untouched nodes keep
  // their current state; nodes added by the patch are dropped.
  const restored: NodeExecution[] = [];
  for (const preNode of base.nodes) {
    const current = planNode(plan, preNode.nodeId);
    if (affected.has(preNode.nodeId)) {
      restored.push({
        ...clone(preNode),
        visits: Math.max(preNode.visits, current?.visits ?? preNode.visits),
      });
    } else {
      restored.push(clone(current ?? preNode));
    }
  }
  candidate.nodes = restored;
  candidate.edges = clone(base.edges);
  if (patch.operations.some((operation) => operation.action === "pause")) {
    candidate.status = base.status;
  }
  candidate.revision = plan.revision + 1;
  candidate.updatedAt = appliedAt;

  const operations = patch.operations.flatMap((operation) =>
    inverseOperations(operation, graph, base),
  );
  const rollbackPatch: AppliedPlanPatch = {
    baseRevision: plan.revision,
    reason: `Rollback of ${patch.id}: ${patch.reason}`,
    operations,
    id: rollbackId,
    actorNodeId: patch.actorNodeId,
    appliedRevision: candidate.revision,
    appliedAt,
  };
  candidate.patches = [
    ...plan.patches.map((item) =>
      item.id === patch.id ? { ...item, rolledBackBy: rollbackId } : item,
    ),
    rollbackPatch,
  ];

  const candidateIssues: string[] = [];
  validateCandidatePlan(candidate, candidateIssues);
  if (candidateIssues.length > 0) {
    throw new PlanPatchError(candidateIssues);
  }

  const affectedAndRestored = new Set([...affected, ...[...preIds].filter((id) => !postIds.has(id))]);
  plan.nodes = candidate.nodes;
  plan.edges = candidate.edges;
  plan.status = candidate.status;
  plan.revision = candidate.revision;
  plan.patches = candidate.patches;
  plan.updatedAt = candidate.updatedAt;
  return {
    patch: rollbackPatch,
    removedNodeIds: addedIds,
    changedNodes: plan.nodes.filter((node) => affectedAndRestored.has(node.nodeId)),
  };
}

/**
 * Re-derive the runtime universe (every node and edge the plan has ever
 * known) from the base compiled graph and the patch log. Used on resume —
 * the persisted plan carries the active node/edge sets, while node
 * configurations live only in the universe.
 *
 * The log is a stack: a rollback record removes the patch it rolled back
 * (identified via the target's `rolledBackBy`) instead of contributing
 * operations itself, so a patch/rollback pair has zero net effect and a
 * rolled-back rollback (a redo) replays the rollback record's inverse
 * operations.
 */
export function rebuildRuntimeGraph(
  base: CompiledGraph,
  patches: AppliedPlanPatch[],
): CompiledGraph {
  const graph: CompiledGraph = {
    ...base,
    nodes: base.nodes.map((node) => clone(node)),
    edges: base.edges.map((edge) => clone(edge)),
    seedIds: [...base.seedIds],
  };
  const active: AppliedPlanPatch[] = [];
  for (const patch of patches) {
    const rolledBackIndex = active.findIndex(
      (item) => item.rolledBackBy === patch.id,
    );
    if (rolledBackIndex >= 0) {
      active.splice(rolledBackIndex, 1);
    } else {
      active.push(patch);
    }
  }
  for (const patch of active) {
    for (const operation of patch.operations) {
      switch (operation.action) {
        case "insert":
          graph.nodes.push(clone(operation.node) as CompiledNode);
          graph.edges.push(...operation.edges.map((edge) => clone(edge)));
          break;
        case "replace":
          graph.nodes.push(clone(operation.replacement) as CompiledNode);
          break;
        case "edit": {
          const index = graph.nodes.findIndex((node) => node.id === operation.nodeId);
          if (index >= 0) {
            graph.nodes[index] = clone(operation.replacement) as CompiledNode;
          }
          break;
        }
        default:
          break;
      }
    }
  }
  const targeted = new Set(graph.edges.map((edge) => edge.target));
  let seedIds = graph.nodes
    .filter((node) => !targeted.has(node.id))
    .map((node) => node.id);
  if (seedIds.length === 0 && graph.nodes.length > 0) {
    seedIds = [graph.nodes[0].id];
  }
  graph.seedIds = seedIds;
  return graph;
}

/**
 * Build the input for promoting the current runtime topology to a new saved
 * graph version: active nodes (in plan order, minus nodes superseded by
 * `replace`) mapped back to their configurations, and the active edge set.
 * Run state (statuses, visits, outcomes, attempt ids, messages) and
 * temporary replacement metadata never leave the plan — only graph
 * definitions cross over. The caller assigns the new version and timestamp.
 */
export function buildGraphVersionInput(
  plan: ExecutionPlan,
  graph: CompiledGraph,
  options: { name?: string; groups?: GraphGroup[] } = {},
): GraphVersionPromotionInput {
  const superseded = new Set(
    plan.patches
      .filter((patch) => !patch.rolledBackBy)
      .flatMap((patch) =>
        patch.operations
          .filter((operation) => operation.action === "replace")
          .map((operation) => (operation as { nodeId: string }).nodeId),
      ),
  );
  const configById = new Map(graph.nodes.map((node) => [node.id, node]));
  const issues: string[] = [];
  const nodes: GraphNode[] = [];
  for (const execution of plan.nodes) {
    if (superseded.has(execution.nodeId)) continue;
    const config = configById.get(execution.nodeId);
    if (!config) {
      issues.push(`Plan node ${execution.nodeId} has no graph configuration.`);
      continue;
    }
    nodes.push(clone(config) as GraphNode);
  }
  const ids = new Set(nodes.map((node) => node.id));
  const edges = plan.edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .map((edge) => clone(edge));
  if (issues.length > 0) {
    throw new PlanPatchError(issues);
  }
  return {
    graphId: plan.graphId,
    name: options.name ?? plan.graphId,
    baseVersion: plan.graphVersion,
    nodes,
    edges,
    groups: options.groups ?? [],
    maxSteps: graph.maxSteps,
  };
}
