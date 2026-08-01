import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
  applyNodeChanges,
} from "@xyflow/react";
import {
  Box,
  Bot,
  CircleCheck,
  FolderGit2,
  GitBranch,
} from "lucide-react";
import { nanoid } from "nanoid";
import type { ReactNode } from "react";
import type {
  GraphDefinition,
  GraphDefinitionV2,
  GraphGroup,
  GraphNode,
  LegacyAgentNode as DomainAgentNode,
  NodeKind,
  RunStatus,
} from "../../shared/domain";
import type { NodeExecution, ExecutionPlan } from "../../shared/execution";
import { useAppStore, isGraphV2, type GraphLike } from "../store";
import {
  AgentNode,
  V2AgentNode,
  V2DecisionNode,
  V2CheckpointNode,
  V2SubgraphNode,
  V2GroupNode,
} from "../components/AgentNode";

const ACCENT = "#6ea8fe";
const ACCENT_TEXT = "#a8caff";
const EDGE_IDLE = "#4a5160";
const LABEL_IDLE = "#7b8496";

/** Palette entries for every v2 block kind — used by the canvas sidebar. */
export type PaletteItem = {
  kind: NodeKind | "group";
  label: string;
  icon: ReactNode;
};

export const PALETTE_ITEMS: PaletteItem[] = [
  { kind: "agent", label: "Agent", icon: <Bot size={15} /> },
  {
    kind: "decision",
    label: "Decision",
    icon: <GitBranch size={15} />,
  },
  {
    kind: "checkpoint",
    label: "Checkpoint",
    icon: <CircleCheck size={15} />,
  },
  {
    kind: "subgraph",
    label: "Subgraph",
    icon: <FolderGit2 size={15} />,
  },
  { kind: "group", label: "Group", icon: <Box size={15} /> },
];

/** ReactFlow node type → component registry (v1 legacy + v2 kinds + groups). */
const nodeTypes: NodeTypes = {
  "legacy-agent": AgentNode,
  agent: V2AgentNode,
  decision: V2DecisionNode,
  checkpoint: V2CheckpointNode,
  subgraph: V2SubgraphNode,
  group: V2GroupNode,
};

/** Data shape shared by all canvas nodes (legacy, v2, and group). */
type CanvasNodeDataAny = {
  node?: GraphNode;
  execution?: NodeExecution;
  active?: boolean;
  agent?: DomainAgentNode;
  runStatus?: RunStatus;
  iteration?: number;
  group?: GraphGroup;
  childCount?: number;
  collapsed?: boolean;
};

/**
 * ReactFlow's Node type doesn't expose `collapsed` in its type definitions,
 * but the runtime honors it for group nodes. We extend the type so the
 * property is visible to TypeScript without resorting to `any`.
 */
type CanvasFlowNode = Node<CanvasNodeDataAny> & {
  collapsed?: boolean;
};

// --- builders --------------------------------------------------------------

/**
 * Convert a graph definition into ReactFlow nodes.
 *
 * Legacy v1 graphs yield `legacy-agent` canvas nodes (read-only migration
 * path — the graph still loads and renders). V2 graphs yield typed nodes
 * per `GraphNode.kind` plus one `group` node per defined `GraphGroup`.
 */
export function buildCanvasNodes(
  graph: GraphLike,
  plan?: ExecutionPlan,
  collapsedGroups: string[] = [],
): CanvasFlowNode[] {
  if (isGraphV2(graph)) {
    return buildV2CanvasNodes(graph, plan, collapsedGroups);
  }
  return buildLegacyCanvasNodes(graph);
}

function buildLegacyCanvasNodes(graph: GraphDefinition): CanvasFlowNode[] {
  return graph.nodes.map((agent) => ({
    id: agent.id,
    type: "legacy-agent" as const,
    position: agent.position,
    initialWidth: 224,
    initialHeight: 143,
    data: { agent, active: false },
  }));
}

function buildV2CanvasNodes(
  graph: GraphDefinitionV2,
  plan?: ExecutionPlan,
  collapsedGroups: string[] = [],
): CanvasFlowNode[] {
  const executionByNodeId = new Map(
    (plan?.nodes ?? []).map((item) => [item.nodeId, item]),
  );

  const nodes: CanvasFlowNode[] = [];

  // Group placeholder nodes — one per GraphGroup, identified by a
  // `group__<id>` convention so child nodes can reference them as parents.
  for (const group of graph.groups) {
    const childCount = graph.nodes.filter(
      (node) => node.groupId === group.id,
    ).length;
    const collapsed = collapsedGroups.includes(group.id);
    nodes.push({
      id: `group__${group.id}`,
      type: "group",
      position: { x: 0, y: 0 },
      extent: "parent",
      data: { group, childCount, collapsed },
      collapsed,
    });
  }

  // Graph nodes — one per GraphNode, with runtime overlay from the plan.
  for (const node of graph.nodes) {
    const execution = executionByNodeId.get(node.id);
    nodes.push({
      id: node.id,
      type: node.kind,
      position: node.position,
      parentId: node.groupId ? `group__${node.groupId}` : undefined,
      data: {
        node,
        execution,
        active: execution?.status === "running",
      },
    });
  }

  return nodes;
}

/**
 * Convert a graph definition into ReactFlow edges.
 *
 * V2 edges carry the original `kind` / `when` / `label` in `data` so the
 * inspector can display typed-connection metadata. Edges whose source or
 * target node is currently running are animated.
 */
export function buildCanvasEdges(graph: GraphLike, plan?: ExecutionPlan): Edge[] {
  if (isGraphV2(graph)) {
    return buildV2CanvasEdges(graph, plan);
  }
  return buildLegacyCanvasEdges(graph);
}

function buildLegacyCanvasEdges(graph: GraphDefinition): Edge[] {
  return graph.edges.map((edge) => {
    const handles =
      edge.id === "build-review"
        ? { sourceHandle: "top-source", targetHandle: "top-target" }
        : edge.id === "revise"
          ? { sourceHandle: "bottom-source", targetHandle: "bottom-target" }
          : { sourceHandle: "right-source", targetHandle: "left-target" };
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      ...handles,
      type: "default",
      animated: false,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: EDGE_IDLE,
      },
      style: { stroke: EDGE_IDLE, strokeWidth: 1.25 },
      labelStyle: {
        fill: LABEL_IDLE,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      },
      labelBgStyle: { fill: "#101216", fillOpacity: 0.92 },
      labelBgPadding: [7, 4] as [number, number],
      labelBgBorderRadius: 5,
    };
  });
}

function buildV2CanvasEdges(
  graph: GraphDefinitionV2,
  plan?: ExecutionPlan,
): Edge[] {
  const executionByNodeId = new Map(
    (plan?.nodes ?? []).map((item) => [item.nodeId, item]),
  );

  return graph.edges.map((edge) => {
    const sourceExec = executionByNodeId.get(edge.source);
    const targetExec = executionByNodeId.get(edge.target);
    const active =
      sourceExec?.status === "running" || targetExec?.status === "running";

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      data: { kind: edge.kind, when: edge.when, label: edge.label },
      type: "smoothstep",
      animated: active,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: active ? ACCENT : EDGE_IDLE,
      },
      style: {
        stroke: active ? ACCENT : EDGE_IDLE,
        strokeWidth: active ? 2 : 1.25,
      },
      labelStyle: {
        fill: active ? ACCENT_TEXT : LABEL_IDLE,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      },
      labelBgStyle: { fill: "#101216", fillOpacity: 0.92 },
      labelBgPadding: [7, 4] as [number, number],
      labelBgBorderRadius: 5,
    };
  });
}

/** Build a default node template for palette insertion. */
function createNodeTemplate(
  kind: Exclude<PaletteItem["kind"], "group">,
  graph: GraphDefinitionV2,
): GraphNode {
  const id = nanoid();
  const position = { x: 100, y: 100 };
  const modelId = "gpt-4";

  switch (kind) {
    case "agent":
      return {
        kind: "agent",
        id,
        name: "Agent",
        job: "Describe the agent's job",
        harnessId: "opencode",
        modelId,
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        position,
      };
    case "decision":
      return {
        kind: "decision",
        id,
        name: "Decision",
        job: "Evaluate options and select a path",
        harnessId: "opencode",
        modelId,
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 1,
        position,
      };
    case "checkpoint":
      return {
        kind: "checkpoint",
        id,
        name: "Checkpoint",
        mode: "automatic",
        position,
      };
    case "subgraph":
      return {
        kind: "subgraph",
        id,
        name: "Subgraph",
        graphId: graph.id,
        position,
      };
  }
}

// --- components ------------------------------------------------------------

/** Floating palette of block types for v2 graph editing. */
function NodePalette() {
  const graph = useAppStore((state) => state.graph);
  const addNode = useAppStore((state) => state.addNode);
  const addGroup = useAppStore((state) => state.addGroup);

  if (!graph || !isGraphV2(graph)) return null;

  function handleAdd(item: PaletteItem) {
    if (item.kind === "group") {
      addGroup({ id: `group-${nanoid(6)}`, name: "Group" });
    } else if (graph && isGraphV2(graph)) {
      addNode(createNodeTemplate(item.kind, graph));
    }
  }

  return (
    <div className="node-palette" data-palette="node-palette">
      {PALETTE_ITEMS.map((item) => (
        <button
          key={item.kind}
          className="palette-button"
          onClick={() => handleAdd(item)}
          aria-label={`Add ${item.label} block`}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function GraphCanvasPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div className="graph-canvas" ref={containerRef} data-pane="graph-canvas">
      <NodePalette />
      <ReactFlowProvider>
        <CanvasView containerRef={containerRef} />
      </ReactFlowProvider>
      <div className="canvas-coordinate">LOCAL / WORKTREE ISOLATED</div>
    </div>
  );
}

function CanvasView({
  containerRef,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const graph = useAppStore((state) => state.graph)!;
  const updateGraph = useAppStore((state) => state.updateGraph);
  const selectNode = useAppStore((state) => state.selectNode);
  const plan = useAppStore((state) => state.plan);
  const collapsedGroups = useAppStore((state) => state.collapsedGroups);
  const { fitView } = useReactFlow();

  // Refit whenever the pane is resized, redocked, or popped out so the
  // graph stays framed inside its new bounds. In jsdom (tests)
  // ResizeObserver may be unavailable — fall back to a single fitView.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    if (typeof ResizeObserver === "undefined") {
      void fitView({ padding: 0.2, duration: 120 });
      return;
    }
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void fitView({ padding: 0.2, duration: 120 });
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [containerRef, fitView]);

  const nodes = useMemo(
    () => buildCanvasNodes(graph, plan, collapsedGroups),
    [graph, plan, collapsedGroups],
  );

  const edges = useMemo(
    () => buildCanvasEdges(graph, plan),
    [graph, plan],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const changed = applyNodeChanges(changes, nodes);
      const positions = new Map(
        changed.map((node) => [node.id, node.position]),
      );
      updateGraph({
        ...graph,
        nodes: graph.nodes.map((node) => ({
          ...node,
          position: positions.get(node.id) ?? node.position,
        })),
      } as GraphLike);
    },
    [graph, nodes, updateGraph],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_event, node) => selectNode(node.id)}
      onPaneClick={() => selectNode(undefined)}
      fitView
      minZoom={0.55}
      maxZoom={1.6}
      deleteKeyCode={null}
      proOptions={{ hideAttribution: true }}
      aria-label="Graph editor"
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={22}
        size={1}
        color="#23262d"
      />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        nodeColor={(node) =>
          node.type === "legacy-agent" ? "#5b8def" : "#2fbf8f"
        }
        maskColor="rgba(10, 11, 14, 0.78)"
      />
    </ReactFlow>
  );
}
