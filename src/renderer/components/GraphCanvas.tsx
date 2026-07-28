import { useCallback, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type NodeChange,
  applyNodeChanges,
} from "@xyflow/react";
import type { AgentNode as DomainAgentNode } from "../../shared/domain";
import { useAppStore } from "../store";
import { AgentNode, type AgentFlowNode } from "./AgentNode";

const nodeTypes = { agent: AgentNode };

export function GraphCanvas() {
  const graph = useAppStore((state) => state.graph)!;
  const snapshot = useAppStore((state) => state.snapshot)!;
  const selectedRunId = useAppStore((state) => state.selectedRunId);
  const selectedNodeId = useAppStore((state) => state.selectedNodeId);
  const updateGraph = useAppStore((state) => state.updateGraph);
  const selectNode = useAppStore((state) => state.selectNode);
  const run = snapshot.runs.find((item) => item.id === selectedRunId);

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
            color: active ? "#8b7cf6" : "#465168",
          },
          style: {
            stroke: active ? "#8b7cf6" : "#465168",
            strokeWidth: active ? 2 : 1.25,
          },
          labelStyle: {
            fill: active ? "#c6befd" : "#758197",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          },
          labelBgStyle: { fill: "#0d1320", fillOpacity: 0.92 },
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
    <div className="graph-canvas">
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
          color="#273147"
        />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor={(node) =>
            node.id === "planner" ? "#7467db" : "#29a878"
          }
          maskColor="rgba(7, 10, 17, 0.75)"
        />
      </ReactFlow>
      <div className="canvas-coordinate">LOCAL / WORKTREE ISOLATED</div>
    </div>
  );
}
