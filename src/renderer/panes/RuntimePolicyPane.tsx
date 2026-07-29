import { ShieldCheck } from "lucide-react";
import { useAppStore } from "../store";

const GRAPH_POLICY = [
  { label: "Runs execute in isolated Git worktrees", allowed: true },
  { label: "External directories denied", allowed: false },
  { label: "Git push denied", allowed: false },
  { label: "Network access limited to the model provider", allowed: false },
];

export function RuntimePolicyPane() {
  const graph = useAppStore((state) => state.graph)!;
  const selectedNodeId = useAppStore((state) => state.selectedNodeId);
  const node = graph.nodes.find((item) => item.id === selectedNodeId);

  return (
    <div className="pane pane-scroll pane-form" data-pane="runtime-policy">
      <div className="policy-header">
        <ShieldCheck size={16} />
        <div>
          <strong>{node ? node.name : "Graph-wide policy"}</strong>
          <small>
            {node
              ? `${node.role.toUpperCase()} NODE RUNTIME RULES`
              : "APPLIES TO EVERY NODE IN THIS GRAPH"}
          </small>
        </div>
      </div>
      <div className="permission-summary">
        <span>FILESYSTEM</span>
        <div>
          <i className={node && node.role === "planner" ? "denied" : "allowed"} />
          Filesystem edits{" "}
          {node && node.role === "planner" ? "denied" : "allowed"}
          {node ? "" : " for implementer nodes"}
        </div>
        <div>
          <i className="denied" />
          External directories denied
        </div>
      </div>
      <div className="permission-summary">
        <span>GRAPH</span>
        {GRAPH_POLICY.map((rule) => (
          <div key={rule.label}>
            <i className={rule.allowed ? "allowed" : "denied"} />
            {rule.label}
          </div>
        ))}
      </div>
    </div>
  );
}
