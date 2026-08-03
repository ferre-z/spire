import { useCallback, useEffect, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
  type OnNodeDrag,
} from "@xyflow/react";
import type {
  GraphDefinitionV2,
  GraphGroup,
  GraphNode,
} from "../../shared/domain";
import type { ExecutionPlan, NodeExecution } from "../../shared/execution";
import {
  V2AgentNode,
  V2CheckpointNode,
  V2DecisionNode,
  V2GroupNode,
  V2SubgraphNode,
} from "../components/AgentNode";
import { useAppStore } from "../store";
import { GraphCanvasPalette } from "./GraphCanvasPalette";

export {
  PALETTE_ITEMS,
  resolveDefaultRuntime,
  type DefaultRuntimeResult,
  type PaletteItem,
} from "./GraphCanvasPalette";

const EDGE_IDLE = "var(--canvas-edge-idle)";
const EDGE_EXECUTING = "var(--accent-execution)";
const LABEL_IDLE = "var(--text-3)";
const LABEL_EXECUTING = "var(--accent-execution)";
const NODE_TYPES = {
  agent: V2AgentNode,
  decision: V2DecisionNode,
  checkpoint: V2CheckpointNode,
  subgraph: V2SubgraphNode,
  group: V2GroupNode,
} satisfies NodeTypes;

const EDGE_TYPES = {} satisfies EdgeTypes;

type CanvasNodeData = {
  readonly node?: GraphNode;
  readonly execution?: NodeExecution;
  readonly active?: boolean;
  readonly group?: GraphGroup;
  readonly childCount?: number;
  readonly collapsed?: boolean;
};

type CanvasFlowNode = Node<CanvasNodeData> & {
  readonly collapsed?: boolean;
};

export function buildCanvasNodes(
  graph: GraphDefinitionV2,
  plan?: ExecutionPlan,
  collapsedGroups: readonly string[] = [],
): CanvasFlowNode[] {
  const executionByNodeId = new Map(
    (plan?.nodes ?? []).map((execution) => [execution.nodeId, execution]),
  );
  const nodes: CanvasFlowNode[] = graph.groups.map((group) => {
    const collapsed = collapsedGroups.includes(group.id);
    return {
      id: `group__${group.id}`,
      type: "group",
      position: { x: 0, y: 0 },
      extent: "parent",
      data: {
        group,
        childCount: graph.nodes.filter((node) => node.groupId === group.id).length,
        collapsed,
      },
      collapsed,
    };
  });

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

export function buildCanvasEdges(
  graph: GraphDefinitionV2,
  plan?: ExecutionPlan,
): Edge[] {
  const executionByNodeId = new Map(
    (plan?.nodes ?? []).map((execution) => [execution.nodeId, execution]),
  );
  return graph.edges.map((edge) => {
    const executing =
      executionByNodeId.get(edge.source)?.status === "running" ||
      executionByNodeId.get(edge.target)?.status === "running";
    const color = executing ? EDGE_EXECUTING : EDGE_IDLE;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      data: { kind: edge.kind, when: edge.when, label: edge.label },
      type: "smoothstep",
      className: executing ? "canvas-edge is-executing" : "canvas-edge",
      animated: false,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color,
      },
      style: { stroke: color, strokeWidth: executing ? 2 : 1.25 },
      labelStyle: {
        fill: executing ? LABEL_EXECUTING : LABEL_IDLE,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      },
      labelBgStyle: { fill: "var(--surface-panel)", fillOpacity: 0.94 },
      labelBgPadding: [7, 4],
      labelBgBorderRadius: 4,
    };
  });
}

export function GraphCanvasPane() {
  const graph = useAppStore((state) => state.graph);
  return (
    <div className="graph-canvas" data-pane="graph-canvas">
      {graph ? <GraphCanvasPalette graph={graph} /> : null}
      {graph ? (
        <ReactFlowProvider>
          <CanvasView graph={graph} />
        </ReactFlowProvider>
      ) : null}
    </div>
  );
}

function CanvasView({ graph }: { readonly graph: GraphDefinitionV2 }) {
  const updateGraph = useAppStore((state) => state.updateGraph);
  const selectNode = useAppStore((state) => state.selectNode);
  const plan = useAppStore((state) => state.plan);
  const collapsedGroups = useAppStore((state) => state.collapsedGroups);
  const { fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasFlowNode>(
    buildCanvasNodes(graph, plan, collapsedGroups),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    buildCanvasEdges(graph, plan),
  );
  const draggingRef = useRef(false);

  useEffect(() => {
    void fitView({ padding: 0.2, duration: 120 });
  }, [fitView]);

  useEffect(() => {
    if (draggingRef.current) return;
    setNodes(buildCanvasNodes(graph, plan, collapsedGroups));
    setEdges(buildCanvasEdges(graph, plan));
  }, [collapsedGroups, graph, plan, setEdges, setNodes]);

  const handleNodeDragStart = useCallback(() => {
    draggingRef.current = true;
  }, []);

  const handleNodeDragStop = useCallback<OnNodeDrag<CanvasFlowNode>>(
    (_event, node) => {
      draggingRef.current = false;
      updateGraph({
        ...graph,
        nodes: graph.nodes.map((item) =>
          item.id === node.id ? { ...item, position: node.position } : item,
        ),
      });
    },
    [graph, updateGraph],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_event, node) => selectNode(node.id)}
      onPaneClick={() => selectNode(undefined)}
      onNodeDragStart={handleNodeDragStart}
      onNodeDragStop={handleNodeDragStop}
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
        color="var(--canvas-grid-dot)"
      />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        nodeColor="var(--canvas-minimap-node)"
        maskColor="var(--canvas-minimap-mask)"
      />
    </ReactFlow>
  );
}
