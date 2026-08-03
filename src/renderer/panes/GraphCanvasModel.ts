import { MarkerType, type Node } from "@xyflow/react";
import type { GraphDefinitionV2 } from "../../shared/domain";
import type { ExecutionPlan } from "../../shared/execution";
import type { CanvasEdge } from "../components/CanvasEdge";
import {
  calculateGroupLayouts,
  CANVAS_METRICS,
  isGroupHidden,
  isNodeHidden,
  visibleNodeIds,
} from "./GraphCanvasLayout";

const EDGE_IDLE = "var(--canvas-edge-idle)";
const EDGE_EXECUTING = "var(--accent-execution)";

export type CanvasFlowNode = Node;

export function buildCanvasNodes(
  graph: GraphDefinitionV2,
  plan?: ExecutionPlan,
  collapsedGroups: readonly string[] = [],
): CanvasFlowNode[] {
  const executionByNodeId = new Map(
    (plan?.nodes ?? []).map((execution) => [execution.nodeId, execution]),
  );
  const collapsed = new Set(collapsedGroups);
  const groups = new Map(graph.groups.map((group) => [group.id, group]));
  const layouts = calculateGroupLayouts(graph);
  const nodes: CanvasFlowNode[] = graph.groups
    .filter((group) => !isGroupHidden(group, collapsed, groups))
    .sort((left, right) => {
      const leftDepth = layouts.get(left.id)?.depth ?? 0;
      const rightDepth = layouts.get(right.id)?.depth ?? 0;
      return leftDepth - rightDepth;
    })
    .map((group) => {
      const layout = layouts.get(group.id);
      const isCollapsed = collapsed.has(group.id);
      const parentLayout = group.parentGroupId ? layouts.get(group.parentGroupId) : undefined;
      const absolutePosition = layout?.position ?? { x: 0, y: 0 };
      return {
        id: `group__${group.id}`,
        type: "group",
        position: parentLayout
          ? {
              x: absolutePosition.x - parentLayout.position.x,
              y: absolutePosition.y - parentLayout.position.y,
            }
          : absolutePosition,
        parentId: group.parentGroupId ? `group__${group.parentGroupId}` : undefined,
        extent: group.parentGroupId ? "parent" : undefined,
        draggable: false,
        style: {
          width: isCollapsed ? CANVAS_METRICS.collapsedGroupWidth : layout?.width,
          height: isCollapsed ? CANVAS_METRICS.collapsedGroupHeight : layout?.height,
        },
        data: {
          group,
          childCount: graph.nodes.filter((node) => node.groupId === group.id).length,
          collapsed: isCollapsed,
        },
      };
    });

  for (const node of graph.nodes) {
    if (isNodeHidden(node.groupId, collapsed, groups)) continue;
    const execution = executionByNodeId.get(node.id);
    const parentLayout = node.groupId ? layouts.get(node.groupId) : undefined;
    nodes.push({
      id: node.id,
      type: node.kind,
      position: parentLayout
        ? {
            x: node.position.x - parentLayout.position.x,
            y: node.position.y - parentLayout.position.y,
          }
        : node.position,
      parentId: node.groupId ? `group__${node.groupId}` : undefined,
      extent: node.groupId ? "parent" : undefined,
      data: {
        node,
        execution,
        active: execution?.status === "running",
      },
    });
  }
  return nodes;
}

export function buildCanvasEdges(
  graph: GraphDefinitionV2,
  plan?: ExecutionPlan,
  collapsedGroups: readonly string[] = [],
): CanvasEdge[] {
  const executionByNodeId = new Map(
    (plan?.nodes ?? []).map((execution) => [execution.nodeId, execution]),
  );
  const visibleIds = visibleNodeIds(graph, collapsedGroups);
  return graph.edges
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .map((edge) => {
      const executing =
        executionByNodeId.get(edge.source)?.status === "running" ||
        executionByNodeId.get(edge.target)?.status === "running";
      const color = executing ? EDGE_EXECUTING : EDGE_IDLE;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        data: { kind: edge.kind, when: edge.when, label: edge.label, executing },
        type: "canvas",
        className: executing ? "canvas-edge is-executing" : "canvas-edge",
        animated: false,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color,
        },
        style: { stroke: color, strokeWidth: executing ? 2 : 1.25 },
      };
    });
}
