import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Bot, BrainCircuit, CircleCheck, LoaderCircle } from "lucide-react";
import type { AgentNode as AgentNodeType, RunStatus } from "../../shared/domain";

export type AgentFlowNode = Node<{
  agent: AgentNodeType;
  active: boolean;
  runStatus?: RunStatus;
  iteration?: number;
}, "agent">;

export function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const { agent, active, runStatus, iteration } = data;
  const planner = agent.role === "planner";
  const finished = runStatus === "succeeded";
  return (
    <div
      className={`agent-node agent-${agent.role} ${active ? "is-active" : ""} ${selected ? "is-selected" : ""}`}
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
