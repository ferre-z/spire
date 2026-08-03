import type { ReactNode } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Bot,
  Box,
  Circle,
  CircleCheck,
  CircleX,
  Clock3,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  MinusCircle,
} from "lucide-react";
import type { GraphGroup, GraphNode } from "../../shared/domain";
import type { NodeExecution, NodeExecutionStatus } from "../../shared/execution";

export type CanvasNodeData = {
  readonly node: GraphNode;
  readonly execution?: NodeExecution;
  readonly active: boolean;
};

export type CanvasNode = Node<CanvasNodeData>;

export type GroupNodeData = {
  readonly group: GraphGroup;
  readonly childCount: number;
  readonly collapsed: boolean;
};

export type GroupNode = Node<GroupNodeData>;

type StatusMetadata = {
  readonly tone: "neutral" | "running" | "waiting" | "success" | "failed";
  readonly label: string;
};

export function nodeStatusMetadata(status: NodeExecutionStatus): StatusMetadata {
  switch (status) {
    case "queued":
      return { tone: "neutral", label: "Queued" };
    case "running":
      return { tone: "running", label: "Running" };
    case "waiting":
      return { tone: "waiting", label: "Waiting" };
    case "succeeded":
      return { tone: "success", label: "Succeeded" };
    case "failed":
      return { tone: "failed", label: "Failed" };
    case "skipped":
      return { tone: "neutral", label: "Skipped" };
    case "cancelled":
      return { tone: "failed", label: "Cancelled" };
  }
}

const KIND_ICON: Readonly<Record<GraphNode["kind"], ReactNode>> = {
  agent: <Bot size={15} />,
  decision: <GitBranch size={15} />,
  checkpoint: <CircleCheck size={15} />,
  subgraph: <FolderGit2 size={15} />,
};

const KIND_LABEL: Readonly<Record<GraphNode["kind"], string>> = {
  agent: "Agent",
  decision: "Decision",
  checkpoint: "Checkpoint",
  subgraph: "Subgraph",
};

const STATUS_ICON: Readonly<Record<NodeExecutionStatus, ReactNode>> = {
  queued: <Circle size={12} />,
  running: <LoaderCircle className="spin" size={12} />,
  waiting: <Clock3 size={12} />,
  succeeded: <CircleCheck size={12} />,
  failed: <CircleX size={12} />,
  skipped: <MinusCircle size={12} />,
  cancelled: <CircleX size={12} />,
};

function StatusMarker({ status }: { readonly status: NodeExecutionStatus }) {
  const metadata = nodeStatusMetadata(status);
  return (
    <span
      className={`canvas-node-status status--${metadata.tone}`}
      aria-label={`Execution status: ${metadata.label}`}
    >
      {STATUS_ICON[status]}
      <span>{metadata.label}</span>
    </span>
  );
}

type NodeBodyProps = {
  readonly node: GraphNode;
  readonly subtitle?: string;
  readonly execution?: NodeExecution;
  readonly meta?: string;
};

function NodeBody({ node, subtitle, execution, meta }: NodeBodyProps) {
  return (
    <>
      <div className="canvas-node-header">
        <span className="canvas-node-icon">{KIND_ICON[node.kind]}</span>
        <span className="canvas-node-label">{KIND_LABEL[node.kind]}</span>
        {execution ? <StatusMarker status={execution.status} /> : null}
      </div>
      <div className="canvas-node-title">
        <h3 title={node.name}>{node.name}</h3>
        {execution && execution.visits > 0 ? (
          <span className="canvas-node-attempts">pass {execution.visits}</span>
        ) : null}
      </div>
      {subtitle ? <p className="canvas-node-subtitle">{subtitle}</p> : null}
      {meta ? <div className="canvas-node-meta" title={meta}>{meta}</div> : null}
    </>
  );
}

function nodeClassName(kind: GraphNode["kind"], active: boolean, selected: boolean): string {
  return [
    "canvas-node",
    `canvas-node--${kind}`,
    active ? "is-running" : "",
    selected ? "is-selected" : "",
  ].filter(Boolean).join(" ");
}

export function V2AgentNode({ data, selected }: NodeProps<CanvasNode>) {
  const { node, execution, active } = data;
  if (node.kind !== "agent") return null;
  return (
    <div className={nodeClassName(node.kind, active, selected)}>
      <Handle id="left-target" type="target" position={Position.Left} className="node-handle node-handle--incoming" />
      <Handle id="right-source" type="source" position={Position.Right} className="node-handle node-handle--outgoing" />
      <Handle id="top-target" type="target" position={Position.Top} className="node-handle node-handle--incoming secondary-handle" />
      <Handle id="top-source" type="source" position={Position.Top} className="node-handle node-handle--outgoing secondary-handle" />
      <Handle id="bottom-target" type="target" position={Position.Bottom} className="node-handle node-handle--incoming secondary-handle" />
      <Handle id="bottom-source" type="source" position={Position.Bottom} className="node-handle node-handle--outgoing secondary-handle" />
      <NodeBody node={node} subtitle={node.job} execution={execution} meta={node.modelId} />
    </div>
  );
}

export function V2DecisionNode({ data, selected }: NodeProps<CanvasNode>) {
  const { node, execution, active } = data;
  if (node.kind !== "decision") return null;
  return (
    <div className={nodeClassName(node.kind, active, selected)}>
      <Handle type="target" position={Position.Top} className="node-handle node-handle--incoming" />
      <Handle type="source" position={Position.Right} className="node-handle node-handle--outgoing" />
      <Handle type="source" position={Position.Bottom} className="node-handle node-handle--outgoing secondary-handle" />
      <NodeBody node={node} subtitle={node.job} execution={execution} meta={node.modelId} />
    </div>
  );
}

export function V2CheckpointNode({ data, selected }: NodeProps<CanvasNode>) {
  const { node, execution, active } = data;
  if (node.kind !== "checkpoint") return null;
  return (
    <div className={nodeClassName(node.kind, active, selected)}>
      <Handle type="target" position={Position.Top} className="node-handle node-handle--incoming" />
      <Handle type="source" position={Position.Bottom} className="node-handle node-handle--outgoing" />
      <NodeBody node={node} subtitle={`Mode: ${node.mode}`} execution={execution} />
    </div>
  );
}

export function V2SubgraphNode({ data, selected }: NodeProps<CanvasNode>) {
  const { node, execution, active } = data;
  if (node.kind !== "subgraph") return null;
  return (
    <div className={nodeClassName(node.kind, active, selected)}>
      <Handle type="target" position={Position.Left} className="node-handle node-handle--incoming" />
      <Handle type="source" position={Position.Right} className="node-handle node-handle--outgoing" />
      <NodeBody node={node} subtitle={node.graphId} execution={execution} />
    </div>
  );
}

export function V2GroupNode({ data, selected }: NodeProps<GroupNode>) {
  const { group, childCount, collapsed } = data;
  return (
    <div className={`canvas-node canvas-node--group ${collapsed ? "is-collapsed" : ""} ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={Position.Top} className="node-handle node-handle--incoming" />
      <Handle type="source" position={Position.Bottom} className="node-handle node-handle--outgoing" />
      <Handle type="source" position={Position.Right} className="node-handle node-handle--outgoing" />
      <div className="canvas-node-header">
        <span className="canvas-node-icon"><Box size={15} /></span>
        <span className="canvas-node-label">Group</span>
      </div>
      <div className="canvas-node-title"><h3 title={group.name}>{group.name}</h3></div>
      <p className="canvas-node-subtitle">{childCount} node{childCount === 1 ? "" : "s"}</p>
    </div>
  );
}
