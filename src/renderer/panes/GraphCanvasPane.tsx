import { useCallback, useEffect, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeTypes,
  type NodeTypes,
  type OnNodeDrag,
} from "@xyflow/react";
import type { GraphDefinitionV2 } from "../../shared/domain";
import {
  V2AgentNode,
  V2CheckpointNode,
  V2DecisionNode,
  V2GroupNode,
  V2SubgraphNode,
} from "../components/AgentNode";
import { CanvasEdgeRenderer } from "../components/CanvasEdge";
import { useAppStore } from "../store";
import { GraphCanvasPalette } from "./GraphCanvasPalette";
import { absoluteGraphPosition } from "./GraphCanvasLayout";
import {
  buildCanvasEdges,
  buildCanvasNodes,
  type CanvasFlowNode,
} from "./GraphCanvasModel";

export {
  PALETTE_ITEMS,
  resolveDefaultRuntime,
  type DefaultRuntimeResult,
  type PaletteItem,
} from "./GraphCanvasPalette";
export { buildCanvasEdges, buildCanvasNodes } from "./GraphCanvasModel";

const NODE_TYPES = {
  agent: V2AgentNode,
  decision: V2DecisionNode,
  checkpoint: V2CheckpointNode,
  subgraph: V2SubgraphNode,
  group: V2GroupNode,
} satisfies NodeTypes;

const EDGE_TYPES = { canvas: CanvasEdgeRenderer } satisfies EdgeTypes;

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
    buildCanvasEdges(graph, plan, collapsedGroups),
  );
  const draggingRef = useRef(false);

  useEffect(() => {
    void fitView({ padding: 0.2, duration: 120 });
  }, [fitView]);

  useEffect(() => {
    if (draggingRef.current) return;
    setNodes(buildCanvasNodes(graph, plan, collapsedGroups));
    setEdges(buildCanvasEdges(graph, plan, collapsedGroups));
  }, [collapsedGroups, graph, plan, setEdges, setNodes]);

  const handleNodeDragStart = useCallback(() => {
    draggingRef.current = true;
  }, []);

  const handleNodeDragStop = useCallback<OnNodeDrag<CanvasFlowNode>>(
    (_event, node) => {
      draggingRef.current = false;
      const position = absoluteGraphPosition(graph, node);
      updateGraph({
        ...graph,
        nodes: graph.nodes.map((item) =>
          item.id === node.id ? { ...item, position } : item,
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
