import type { CollaborationMessage } from "../../shared/collaboration";
import type { GraphDefinitionV2, GraphEdge, NodeKind } from "../../shared/domain";
import type { NodeExecution } from "../../shared/execution";

export type TopologyProjection = GraphEdge & {
  readonly endpointId: string;
  readonly endpointName: string;
  readonly endpointKind?: NodeKind;
};

export function deduplicateById<T extends { readonly id: string }>(
  values: readonly T[],
): T[] {
  const positions = new Map<string, number>();
  const result: T[] = [];
  for (const value of values) {
    const position = positions.get(value.id);
    if (position === undefined) {
      positions.set(value.id, result.length);
      result.push(value);
    } else {
      result[position] = value;
    }
  }
  return result;
}

function projectEdge(
  graph: GraphDefinitionV2,
  edge: GraphEdge,
  endpointId: string,
): TopologyProjection {
  const endpoint = graph.nodes.find((node) => node.id === endpointId);
  return {
    ...edge,
    endpointId,
    endpointName: endpoint?.name ?? endpointId,
    endpointKind: endpoint?.kind,
  };
}

export function projectTopology(graph: GraphDefinitionV2, nodeId: string): {
  readonly incoming: readonly TopologyProjection[];
  readonly outgoing: readonly TopologyProjection[];
} {
  return {
    incoming: deduplicateById(
      graph.edges
        .filter((edge) => edge.target === nodeId)
        .map((edge) => projectEdge(graph, edge, edge.source)),
    ),
    outgoing: deduplicateById(
      graph.edges
        .filter((edge) => edge.source === nodeId)
        .map((edge) => projectEdge(graph, edge, edge.target)),
    ),
  };
}

export function projectMessages(
  messages: readonly CollaborationMessage[],
  nodeId: string,
): {
  readonly received: readonly CollaborationMessage[];
  readonly authored: readonly CollaborationMessage[];
} {
  const unique = deduplicateById(messages);
  return {
    received: unique.filter(
      (message) =>
        message.recipient.kind === "node" && message.recipient.id === nodeId,
    ),
    authored: unique.filter((message) => message.senderNodeId === nodeId),
  };
}

export function projectExecution(
  executions: readonly NodeExecution[],
  nodeId: string,
): NodeExecution | undefined {
  let selected: NodeExecution | undefined;
  for (const execution of executions) {
    if (execution.nodeId === nodeId) selected = execution;
  }
  return selected;
}
