import type { ReactNode } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Bot,
  Box,
  BrainCircuit,
  CircleCheck,
  FolderGit2,
  GitBranch,
  LoaderCircle,
} from "lucide-react";
import type { LegacyAgentNode as AgentNodeType, RunStatus } from "../../shared/domain";
import type { GraphNode } from "../../shared/domain";
import type { GraphGroup } from "../../shared/domain";
import type { NodeExecution, NodeExecutionStatus } from "../../shared/execution";

export type AgentFlowNode = Node<{
  agent: AgentNodeType;
  active: boolean;
  runStatus?: RunStatus;
  iteration?: number;
}, "legacy-agent">;

/** Data carried by every v2 canvas node. */
export type CanvasNodeData = {
  node: GraphNode;
  execution?: NodeExecution;
  active: boolean;
};

export type CanvasNode = Node<CanvasNodeData>;

/** Data carried by v2 group nodes. */
export type GroupNodeData = {
  group: GraphGroup;
  childCount: number;
  collapsed: boolean;
};

export type GroupNode = Node<GroupNodeData>;

/** Map a node execution status to a CSS color token. */
export function nodeStatusColor(status: NodeExecutionStatus): string {
  switch (status) {
    case "succeeded":
      return "var(--green)";
    case "failed":
      return "var(--red)";
    case "running":
      return "var(--orange)";
    case "cancelled":
      return "var(--red)";
    case "skipped":
      return "var(--text-3)";
    case "waiting":
      return "var(--amber)";
    default:
      return "var(--blue)";
  }
}

/** Map a v2 node kind to a CSS color token. */
export function kindColor(kind: GraphNode["kind"]): string {
  switch (kind) {
    case "agent":
      return "var(--blue)";
    case "decision":
      return "var(--amber)";
    case "checkpoint":
      return "var(--orange)";
    case "subgraph":
      return "#a78f75";
    default:
      return "var(--blue)";
  }
}

const KIND_ICON: Record<GraphNode["kind"], ReactNode> = {
  agent: <Bot size={15} />,
  decision: <GitBranch size={15} />,
  checkpoint: <CircleCheck size={15} />,
  subgraph: <FolderGit2 size={15} />,
};

const KIND_LABEL: Record<GraphNode["kind"], string> = {
  agent: "AGENT",
  decision: "DECISION",
  checkpoint: "CHECKPOINT",
  subgraph: "SUBGRAPH",
};

const EDGE_STATUS_COLOR: Record<NodeExecutionStatus, string> = {
  queued: "#4a5160",
  running: "var(--orange)",
  waiting: "var(--amber)",
  succeeded: "var(--green)",
  failed: "var(--red)",
  skipped: "#4a5160",
  cancelled: "#4a5160",
};

/** Shared rendering for the canvas node body (name + description + meta). */
function NodeBody({
  icon,
  label,
  title,
  subtitle,
  status,
  attempts,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  subtitle?: string;
  status?: NodeExecutionStatus;
  attempts?: number;
}) {
  const statusColor = status ? EDGE_STATUS_COLOR[status] : undefined;
  return (
    <>
      <div className="canvas-node-header">
        <span
          className="canvas-node-icon"
          style={{ color: statusColor }}
        >
          {icon}
        </span>
        <span className="canvas-node-label">{label}</span>
        {status && status !== "queued" && (
          <span className="canvas-node-dot" style={{ background: statusColor }} />
        )}
      </div>
      <div className="canvas-node-title">
        <h3>{title}</h3>
        {attempts !== undefined && attempts > 0 ? (
          <span className="canvas-node-attempts">pass {attempts}</span>
        ) : null}
      </div>
      {subtitle ? <p className="canvas-node-subtitle">{subtitle}</p> : null}
    </>
  );
}

export function V2AgentNode({ data, selected }: NodeProps<CanvasNode>) {
  const { node, execution, active } = data;
  if (node.kind !== "agent") return null;
  return (
    <div
      className={`canvas-node canvas-node--agent canvas-node--${node.kind} ${active ? "is-running" : ""} ${selected ? "is-selected" : ""}`}
    >
      <Handle
        id="left-target"
        type="target"
        position={Position.Left}
        className="node-handle"
      />
      <Handle
        id="right-source"
        type="source"
        position={Position.Right}
        className="node-handle"
      />
      <Handle
        id="top-target"
        type="target"
        position={Position.Top}
        className="node-handle secondary-handle"
      />
      <Handle
        id="top-source"
        type="source"
        position={Position.Top}
        className="node-handle secondary-handle"
      />
      <Handle
        id="bottom-target"
        type="target"
        position={Position.Bottom}
        className="node-handle secondary-handle"
      />
      <Handle
        id="bottom-source"
        type="source"
        position={Position.Bottom}
        className="node-handle secondary-handle"
      />
      <NodeBody
        icon={KIND_ICON.agent}
        label={KIND_LABEL.agent}
        title={node.name}
        subtitle={node.job}
        status={execution?.status}
        attempts={execution?.visits}
      />
      <div className="canvas-node-meta">
        <span>{node.modelId.split("/").slice(-1)[0] || "—"}</span>
        {active && <LoaderCircle className="spin" size={12} />}
      </div>
      {active && <div className="node-progress" />}
    </div>
  );
}

export function V2DecisionNode({ data, selected }: NodeProps<CanvasNode>) {
  const { node, execution, active } = data;
  if (node.kind !== "decision") return null;
  return (
    <div
      className={`canvas-node canvas-node--decision canvas-node--${node.kind} ${active ? "is-running" : ""} ${selected ? "is-selected" : ""}`}
    >
      <Handle type="target" position={Position.Top} className="node-handle" />
      <Handle type="source" position={Position.Right} className="node-handle" />
      <Handle type="source" position={Position.Bottom} className="node-handle secondary-handle" />
      <NodeBody
        icon={KIND_ICON.decision}
        label={KIND_LABEL.decision}
        title={node.name}
        subtitle={node.job}
        status={execution?.status}
        attempts={execution?.visits}
      />
      <div className="canvas-node-meta">
        <span>{node.activation}</span>
      </div>
    </div>
  );
}

export function V2CheckpointNode({ data, selected }: NodeProps<CanvasNode>) {
  const { node, execution, active } = data;
  if (node.kind !== "checkpoint") return null;
  return (
    <div
      className={`canvas-node canvas-node--checkpoint canvas-node--${node.kind} ${active ? "is-running" : ""} ${selected ? "is-selected" : ""}`}
    >
      <Handle type="target" position={Position.Top} className="node-handle" />
      <Handle type="source" position={Position.Bottom} className="node-handle" />
      <NodeBody
        icon={KIND_ICON.checkpoint}
        label={KIND_LABEL.checkpoint}
        title={node.name}
        subtitle={`Mode: ${node.mode}`}
        status={execution?.status}
        attempts={execution?.visits}
      />
    </div>
  );
}

export function V2SubgraphNode({ data, selected }: NodeProps<CanvasNode>) {
  const { node, execution, active } = data;
  if (node.kind !== "subgraph") return null;
  return (
    <div
      className={`canvas-node canvas-node--subgraph canvas-node--${node.kind} ${active ? "is-running" : ""} ${selected ? "is-selected" : ""}`}
    >
      <Handle type="target" position={Position.Left} className="node-handle" />
      <Handle type="source" position={Position.Right} className="node-handle" />
      <NodeBody
        icon={KIND_ICON.subgraph}
        label={KIND_LABEL.subgraph}
        title={node.name}
        subtitle={node.graphId}
        status={execution?.status}
        attempts={execution?.visits}
      />
    </div>
  );
}

export function V2GroupNode({ data, selected }: NodeProps<GroupNode>) {
  const { group, childCount, collapsed } = data;
  return (
    <div
      className={`canvas-node canvas-node--group ${collapsed ? "is-collapsed" : ""} ${selected ? "is-selected" : ""}`}
    >
      <Handle type="target" position={Position.Top} className="node-handle" />
      <Handle type="source" position={Position.Bottom} className="node-handle" />
      <Handle type="source" position={Position.Right} className="node-handle" />
      <div className="canvas-node-header">
        <Box size={15} />
        <span className="canvas-node-label">GROUP</span>
      </div>
      <h3>{group.name}</h3>
      <p className="canvas-node-subtitle">{childCount} node{childCount !== 1 ? "s" : ""}</p>
    </div>
  );
}

/** Legacy v1 agent node — preserved for backward compatibility. */
export function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const { agent, active, runStatus, iteration } = data;
  const planner = agent.role === "planner";
  const finished = runStatus === "succeeded";
  return (
    <div
      className={`agent-node liquid-border agent-${agent.role} ${active ? "is-active" : ""} ${selected ? "is-selected" : ""}`}
    >
      <Handle
        id="left-target"
        type="target"
        position={Position.Left}
        className="node-handle"
      />
      <Handle
        id="right-source"
        type="source"
        position={Position.Right}
        className="node-handle"
      />
      <Handle
        id="top-target"
        type="target"
        position={Position.Top}
        className="node-handle secondary-handle"
      />
      <Handle
        id="top-source"
        type="source"
        position={Position.Top}
        className="node-handle secondary-handle"
      />
      <Handle
        id="bottom-target"
        type="target"
        position={Position.Bottom}
        className="node-handle secondary-handle"
      />
      <Handle
        id="bottom-source"
        type="source"
        position={Position.Bottom}
        className="node-handle secondary-handle"
      />
      <div className="node-topline">
        <span className="node-role">
          {planner ? <BrainCircuit size={15} /> : <Bot size={15} />}
          {agent.role}
        </span>
        <span className="node-state">
          {active ? (
            <LoaderCircle className="spin" size={14} />
          ) : finished ? (
            <CircleCheck size={14} />
          ) : (
            <span className="idle-dot" />
          )}
          {active ? "running" : finished ? "complete" : "ready"}
        </span>
      </div>
      <h3>{agent.name}</h3>
      <p>{planner ? "Plans, evaluates, routes" : "Builds, tests, reports"}</p>
      <div className="node-meta">
        <span>{agent.model.split("/").slice(-1)[0]}</span>
        {active && iteration ? <span>PASS {iteration}</span> : <span>OPENCODE</span>}
      </div>
      {active && <div className="node-progress" />}
    </div>
  );
}
