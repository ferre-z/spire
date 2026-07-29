import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeChange,
  applyNodeChanges,
} from "@xyflow/react";
import type { AgentNode as DomainAgentNode } from "../../shared/domain";
import { useAppStore } from "../store";
import { AgentNode, type AgentFlowNode } from "../components/AgentNode";

const nodeTypes = { agent: AgentNode };

const ACCENT = "#6ea8fe";
const ACCENT_TEXT = "#a8caff";
const EDGE_IDLE = "#4a5160";
const LABEL_IDLE = "#7b8496";

export function GraphCanvasPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div className="graph-canvas" ref={containerRef} data-pane="graph-canvas">
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
  const snapshot = useAppStore((state) => state.snapshot)!;
  const selectedRunId = useAppStore((state) => state.selectedRunId);
  const selectedNodeId = useAppStore((state) => state.selectedNodeId);
  const updateGraph = useAppStore((state) => state.updateGraph);
  const selectNode = useAppStore((state) => state.selectNode);
  const run = snapshot.runs.find((item) => item.id === selectedRunId);
  const { fitView } = useReactFlow();

  // Refit whenever the pane is resized, redocked, or popped out so the
  // graph stays framed inside its new bounds.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
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

  const nodes = useMemo<AgentFlowNode[]>(
    () =>
      graph.nodes.map((agent) => ({
        id: agent.id,
        type: "agent",
        position: agent.position,
        initialWidth: 224,
        initialHeight: 143,
        handles: [
          {
            id: "left-target",
            type: "target",
            position: Position.Left,
            x: -4,
            y: 67.5,
            width: 8,
            height: 8,
          },
          {
            id: "right-source",
            type: "source",
            position: Position.Right,
            x: 220,
            y: 67.5,
            width: 8,
            height: 8,
          },
          {
            id: "top-target",
            type: "target",
            position: Position.Top,
            x: 108,
            y: -4,
            width: 8,
            height: 8,
          },
          {
            id: "top-source",
            type: "source",
            position: Position.Top,
            x: 108,
            y: -4,
            width: 8,
            height: 8,
          },
          {
            id: "bottom-target",
            type: "target",
            position: Position.Bottom,
            x: 108,
            y: 139,
            width: 8,
            height: 8,
          },
          {
            id: "bottom-source",
            type: "source",
            position: Position.Bottom,
            x: 108,
            y: 139,
            width: 8,
            height: 8,
          },
        ],
        selected: selectedNodeId === agent.id,
        data: {
          agent,
          active: run?.activeNodeId === agent.id,
          runStatus: run?.status,
          iteration: run?.iteration,
        },
      })),
    [graph.nodes, run, selectedNodeId],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge, index) => {
        const sourceActive = run?.activeNodeId === edge.source;
        const targetActive = run?.activeNodeId === edge.target;
        const active = sourceActive || targetActive;
        const handles =
          edge.id === "build-review"
            ? {
                sourceHandle: "top-source",
                targetHandle: "top-target",
              }
            : edge.id === "revise"
              ? {
                  sourceHandle: "bottom-source",
                  targetHandle: "bottom-target",
                }
              : {
                  sourceHandle: "right-source",
                  targetHandle: "left-target",
                };
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.label,
          ...handles,
          type: index === 0 ? "default" : "smoothstep",
          animated: active && run?.status !== "succeeded",
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
      }),
    [graph.edges, run],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<AgentFlowNode>[]) => {
      const changed = applyNodeChanges(changes, nodes);
      const positions = new Map(
        changed.map((node) => [node.id, node.position]),
      );
      updateGraph({
        ...graph,
        nodes: graph.nodes.map((node): DomainAgentNode => ({
          ...node,
          position: positions.get(node.id) ?? node.position,
        })),
      });
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
      aria-label="Agent graph editor"
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
        nodeColor={(node) => (node.id === "planner" ? "#5b8def" : "#2fbf8f")}
        maskColor="rgba(10, 11, 14, 0.78)"
      />
    </ReactFlow>
  );
}
