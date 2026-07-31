import {
  graphDefinitionSchema,
  graphDefinitionV2Schema,
  type GraphDefinition,
  type GraphDefinitionV2,
  type GraphEdge,
  type LegacyGraphEdge,
  type NodeRole,
} from "../shared/domain";

/**
 * Explicit legacy graph -> graph v2 normalization.
 *
 * Field mapping:
 * - node.type "opencode"   -> harnessId "opencode"
 * - node.instructions      -> job
 * - node.model             -> modelId
 * - node.role              -> roleLabel
 * - role "planner"         -> read-only access
 * - role "implementer"     -> workspace-write access, writeScopes all files
 * - activation             -> "any" (the legacy fixed loop fires a node
 *   whenever any incoming condition triggers; the v2 default "all" would
 *   deadlock the split handoff/revise edges below)
 * - authority / maxVisits  -> v2 schema defaults (self scope with no
 *   actions, 3)
 *
 * Edge condition mapping (edge ids and labels are preserved):
 * - "always" planner -> implementer   -> when "selected" (the brief handoff:
 *   the planner selects this edge in its NodeOutcome after writing the brief,
 *   so a later review-accept does not refire the implementer — this preserves
 *   the legacy early-accept termination)
 * - "always" implementer -> planner   -> when "success" (a completed build
 *   deterministically routes to review)
 * - "always" anything else            -> when "always"
 * - "accepted"                        -> when "success"
 * - "needs_changes"                   -> when "failure"
 * Edge kind is inferred from the flow direction:
 * - planner -> implementer   -> "handoff"
 * - implementer -> planner   -> "review"
 * - anything else            -> "dependency"
 *
 * Graph-level safety bound: legacy maxIterations counts full
 * implement-plus-review cycles, while v2 maxSteps counts single node
 * executions. We map maxSteps = maxIterations * 2 (one implement step plus
 * one review step per iteration). This is lossy: v2 has no per-cycle bound,
 * so the converted graph may take one extra partial cycle compared to the
 * legacy semantics.
 */
const LEGACY_WHEN_BY_CONDITION: Record<
  LegacyGraphEdge["condition"],
  GraphEdge["when"]
> = {
  always: "always",
  accepted: "success",
  needs_changes: "failure",
};

function legacyEdgeWhen(
  edge: LegacyGraphEdge,
  sourceRole: NodeRole,
  targetRole: NodeRole,
): GraphEdge["when"] {
  if (edge.condition === "always") {
    if (sourceRole === "planner" && targetRole === "implementer") {
      return "selected";
    }
    if (sourceRole === "implementer" && targetRole === "planner") {
      return "success";
    }
  }
  return LEGACY_WHEN_BY_CONDITION[edge.condition];
}

function legacyEdgeKind(
  sourceRole: NodeRole,
  targetRole: NodeRole,
): GraphEdge["kind"] {
  if (sourceRole === "planner" && targetRole === "implementer") {
    return "handoff";
  }
  if (sourceRole === "implementer" && targetRole === "planner") {
    return "review";
  }
  return "dependency";
}

export function migrateLegacyGraph(
  legacy: GraphDefinition,
): GraphDefinitionV2 {
  const rolesById = new Map(legacy.nodes.map((node) => [node.id, node.role]));
  const nodes = legacy.nodes.map((node) => ({
    kind: "agent" as const,
    id: node.id,
    name: node.name,
    roleLabel: node.role,
    job: node.instructions,
    harnessId: "opencode" as const,
    modelId: node.model,
    activation: "any" as const,
    access:
      node.role === "implementer"
        ? { mode: "workspace-write" as const, writeScopes: ["**/*"] }
        : { mode: "read-only" as const, writeScopes: [] },
    position: { x: node.position.x, y: node.position.y },
  }));
  const edges: GraphEdge[] = legacy.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: legacyEdgeKind(
      rolesById.get(edge.source) ?? "planner",
      rolesById.get(edge.target) ?? "implementer",
    ),
    when: legacyEdgeWhen(
      edge,
      rolesById.get(edge.source) ?? "planner",
      rolesById.get(edge.target) ?? "implementer",
    ),
    label: edge.label,
  }));
  return graphDefinitionV2Schema.parse({
    id: legacy.id,
    name: legacy.name,
    version: legacy.version,
    nodes,
    edges,
    groups: [],
    maxSteps: legacy.maxIterations * 2,
    createdAt: legacy.createdAt,
  });
}

/**
 * Read a stored graph definition of either schema generation. Legacy graphs
 * are normalized to graph v2; v2 graphs are returned as-is. Anything else is
 * a validation error.
 */
export function readGraphDefinition(raw: unknown): GraphDefinitionV2 {
  const legacy = graphDefinitionSchema.safeParse(raw);
  if (legacy.success) {
    return migrateLegacyGraph(legacy.data);
  }
  const v2 = graphDefinitionV2Schema.safeParse(raw);
  if (v2.success) {
    return v2.data;
  }
  throw new Error(
    `Invalid graph definition: matches neither the legacy schema (${legacy.error.issues
      .map((issue) => issue.message)
      .join("; ")}) nor graph v2 (${v2.error.issues
      .map((issue) => issue.message)
      .join("; ")}).`,
  );
}
