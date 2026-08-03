import type { Node, XYPosition } from "@xyflow/react";
import type { GraphDefinitionV2, GraphGroup } from "../../shared/domain";
import { CANVAS_TOKENS } from "./CanvasTokens";

export type GroupLayout = {
  readonly group: GraphGroup;
  readonly depth: number;
  readonly position: XYPosition;
  readonly width: number;
  readonly height: number;
};

type Bounds = XYPosition & {
  readonly width: number;
  readonly height: number;
};

function groupDepth(group: GraphGroup, groups: ReadonlyMap<string, GraphGroup>): number {
  const parent = group.parentGroupId ? groups.get(group.parentGroupId) : undefined;
  return parent ? groupDepth(parent, groups) + 1 : 0;
}

export function isGroupHidden(
  group: GraphGroup,
  collapsedGroups: ReadonlySet<string>,
  groups: ReadonlyMap<string, GraphGroup>,
): boolean {
  const parent = group.parentGroupId ? groups.get(group.parentGroupId) : undefined;
  if (!parent) return false;
  return collapsedGroups.has(parent.id) || isGroupHidden(parent, collapsedGroups, groups);
}

export function isNodeHidden(
  groupId: string | undefined,
  collapsedGroups: ReadonlySet<string>,
  groups: ReadonlyMap<string, GraphGroup>,
): boolean {
  if (!groupId) return false;
  if (collapsedGroups.has(groupId)) return true;
  const group = groups.get(groupId);
  return group ? isGroupHidden(group, collapsedGroups, groups) : false;
}

export function calculateGroupLayouts(graph: GraphDefinitionV2): ReadonlyMap<string, GroupLayout> {
  const groups = new Map(graph.groups.map((group) => [group.id, group]));
  const layouts = new Map<string, GroupLayout>();

  const calculate = (group: GraphGroup): GroupLayout => {
    const cached = layouts.get(group.id);
    if (cached) return cached;
    const directNodeBounds: Bounds[] = graph.nodes
      .filter((node) => node.groupId === group.id)
      .map((node) => ({
        ...node.position,
        width: CANVAS_TOKENS.nodeWidth,
        height: CANVAS_TOKENS.nodeHeight,
      }));
    const childGroupBounds: Bounds[] = graph.groups
      .filter((candidate) => candidate.parentGroupId === group.id)
      .map((candidate) => {
        const child = calculate(candidate);
        return { ...child.position, width: child.width, height: child.height };
      });
    const members = [...directNodeBounds, ...childGroupBounds];
    const minX = members.length > 0 ? Math.min(...members.map((member) => member.x)) : 0;
    const minY = members.length > 0 ? Math.min(...members.map((member) => member.y)) : 0;
    const maxX = members.length > 0
      ? Math.max(...members.map((member) => member.x + member.width))
      : CANVAS_TOKENS.nodeWidth;
    const maxY = members.length > 0
      ? Math.max(...members.map((member) => member.y + member.height))
      : CANVAS_TOKENS.nodeHeight;
    const position = {
      x: minX - CANVAS_TOKENS.groupPadding,
      y: minY - CANVAS_TOKENS.groupHeaderHeight,
    };
    const layout = {
      group,
      depth: groupDepth(group, groups),
      position,
      width: maxX + CANVAS_TOKENS.groupPadding - position.x,
      height: maxY + CANVAS_TOKENS.groupPadding - position.y,
    } satisfies GroupLayout;
    layouts.set(group.id, layout);
    return layout;
  };

  for (const group of graph.groups) calculate(group);
  return layouts;
}

export function visibleNodeIds(
  graph: GraphDefinitionV2,
  collapsedGroupIds: readonly string[],
): ReadonlySet<string> {
  const collapsedGroups = new Set(collapsedGroupIds);
  const groups = new Map(graph.groups.map((group) => [group.id, group]));
  return new Set(
    graph.nodes
      .filter((node) => !isNodeHidden(node.groupId, collapsedGroups, groups))
      .map((node) => node.id),
  );
}

export function absoluteGraphPosition(
  graph: GraphDefinitionV2,
  node: Node,
): XYPosition {
  const graphNode = graph.nodes.find((candidate) => candidate.id === node.id);
  if (!graphNode?.groupId) return node.position;
  const layout = calculateGroupLayouts(graph).get(graphNode.groupId);
  return layout
    ? { x: layout.position.x + node.position.x, y: layout.position.y + node.position.y }
    : node.position;
}
