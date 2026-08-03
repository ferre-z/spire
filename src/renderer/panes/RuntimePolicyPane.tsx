import { ShieldCheck } from "lucide-react";
import { useAppStore } from "../store";

const GRAPH_POLICY = [
  { label: "Runs execute in isolated Git worktrees", allowed: true },
  { label: "External directories denied", allowed: false },
  { label: "Git push denied", allowed: false },
  { label: "Network access limited to the model provider", allowed: false },
];

export function RuntimePolicyPane() {
  const graph = useAppStore((state) => state.graph);

  if (!graph) return <div className="pane pane-empty">No graph selected.</div>;

  return (
    <div className="pane pane-scroll pane-form" data-pane="runtime-policy">
      <div className="policy-header">
        <ShieldCheck size={16} />
        <div>
          <strong>{graph.name}</strong>
          <small>APPLIES TO EVERY NODE IN THIS GRAPH</small>
        </div>
      </div>
      <div className="permission-summary">
        <span>FILESYSTEM</span>
        <div>
          <i className="allowed" />
          Filesystem edits follow each node's access mode
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
