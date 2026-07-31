import type {
  AgentNode,
  CheckpointNode,
  DecisionNode,
  GraphDefinitionV2,
  GraphEdge,
} from "../../shared/domain";
import type { ExecutionPlan } from "../../shared/execution";

/**
 * Graph compiler.
 *
 * A saved graph definition is an immutable, versioned template. A run compiles
 * one graph version into a flat `CompiledGraph` (subgraph nodes resolved to an
 * exact graph version and inlined with namespaced node ids) plus a persisted
 * `ExecutionPlan`. The scheduler mutates only the plan, never the graph.
 */

/** Node kinds that survive compilation: subgraphs are inlined away. */
export type CompiledNode = AgentNode | DecisionNode | CheckpointNode;

export type CompiledGraph = {
  graphId: string;
  graphVersion: number;
  maxSteps: number;
  /** Flat node list in deterministic declaration order (subgraphs inlined). */
  nodes: CompiledNode[];
  /** Flat edge list; endpoints and ids are namespaced for inlined nodes. */
  edges: GraphEdge[];
  /**
   * Deterministic initial activation set: nodes with no incoming edges, or —
   * for a pure cycle — the first node in declaration order.
   */
  seedIds: string[];
};

/**
 * Resolves a subgraph reference to an exact graph version at compile time.
 * `version` is the pinned version requested by the subgraph node, when set.
 */
export type SubgraphResolver = (
  graphId: string,
  version?: number,
) => GraphDefinitionV2;

function missingSubgraphResolver(): SubgraphResolver {
  return (graphId) => {
    throw new Error(`Subgraph ${graphId} cannot be resolved.`);
  };
}

type Flattened = {
  nodes: CompiledNode[];
  edges: GraphEdge[];
  seedIds: string[];
};

/** Per-subgraph-node expansion record used to rewire external edges. */
type SubgraphExpansion = {
  /** Inner nodes that external inbound edges attach to. */
  entries: string[];
  /** Inner nodes that external outbound edges originate from. */
  exits: string[];
};

function flatten(
  graph: GraphDefinitionV2,
  resolve: SubgraphResolver,
  prefix: string,
): Flattened {
  const nodes: CompiledNode[] = [];
  const expansions = new Map<string, SubgraphExpansion>();
  /** Already-namespaced edges from inlined subgraph levels. */
  const innerEdges: GraphEdge[] = [];

  for (const node of graph.nodes) {
    if (node.kind !== "subgraph") {
      nodes.push({ ...node, id: `${prefix}${node.id}` } as CompiledNode);
      continue;
    }
    const inner = resolve(node.graphId, node.graphVersion);
    const flat = flatten(inner, resolve, `${prefix}${node.id}/`);
    nodes.push(...flat.nodes);
    // External inbound edges attach to inner entries (nodes with no inner
    // incoming edge); outbound edges originate from inner exits. A pure inner
    // cycle has no degree-based entry/exit, so its deterministic seeds stand
    // in for both.
    const hasIncoming = new Set(flat.edges.map((edge) => edge.target));
    const hasOutgoing = new Set(flat.edges.map((edge) => edge.source));
    const entries = flat.nodes
      .filter((innerNode) => !hasIncoming.has(innerNode.id))
      .map((innerNode) => innerNode.id);
    const exits = flat.nodes
      .filter((innerNode) => !hasOutgoing.has(innerNode.id))
      .map((innerNode) => innerNode.id);
    expansions.set(node.id, {
      entries: entries.length > 0 ? entries : flat.seedIds,
      exits: exits.length > 0 ? exits : flat.seedIds,
    });
    // Inner edges are already namespaced by the recursive call.
    innerEdges.push(...flat.edges);
  }

  const edges: GraphEdge[] = [...innerEdges];
  for (const edge of graph.edges) {
    const sourceExpansion = expansions.get(edge.source);
    const targetExpansion = expansions.get(edge.target);
    const sources = sourceExpansion ? sourceExpansion.exits : [`${prefix}${edge.source}`];
    const targets = targetExpansion ? targetExpansion.entries : [`${prefix}${edge.target}`];
    const fanOut = sources.length > 1 || targets.length > 1;
    for (const source of sources) {
      for (const target of targets) {
        edges.push({
          ...edge,
          id: fanOut
            ? `${prefix}${edge.id}:${source}->${target}`
            : `${prefix}${edge.id}`,
          source,
          target,
        });
      }
    }
  }

  // Deterministic seeds: nodes with no incoming edge, or — for a pure
  // cycle — the first node in declaration order.
  const targeted = new Set(edges.map((edge) => edge.target));
  let seedIds = nodes
    .filter((node) => !targeted.has(node.id))
    .map((node) => node.id);
  if (seedIds.length === 0 && nodes.length > 0) {
    seedIds = [nodes[0].id];
  }
  return { nodes, edges, seedIds };
}

/**
 * Compile a graph definition into the flat executable form the scheduler
 * runs. Every subgraph reference is resolved to an exact graph version now;
 * nested node ids are namespaced by subgraph instance (`sub/inner`).
 */
export function compileGraph(
  graph: GraphDefinitionV2,
  resolve: SubgraphResolver = missingSubgraphResolver(),
): CompiledGraph {
  const flat = flatten(graph, resolve, "");
  return {
    graphId: graph.id,
    graphVersion: graph.version,
    maxSteps: graph.maxSteps,
    nodes: flat.nodes,
    edges: flat.edges,
    seedIds: flat.seedIds,
  };
}

/**
 * Compile a graph version into a fresh persisted execution plan for a run.
 * Seed nodes start `queued`; every other node starts `waiting` for its
 * activation inputs.
 */
export function compileExecutionPlan(
  graph: GraphDefinitionV2,
  runId: string,
  resolve: SubgraphResolver = missingSubgraphResolver(),
): ExecutionPlan {
  const compiled = compileGraph(graph, resolve);
  const seeds = new Set(compiled.seedIds);
  return {
    runId,
    graphId: compiled.graphId,
    graphVersion: compiled.graphVersion,
    revision: 0,
    status: "running",
    stepCount: 0,
    nodes: compiled.nodes.map((node) => ({
      nodeId: node.id,
      status: seeds.has(node.id) ? "queued" : "waiting",
      visits: 0,
    })),
    edges: compiled.edges,
    patches: [],
    updatedAt: new Date().toISOString(),
  };
}
