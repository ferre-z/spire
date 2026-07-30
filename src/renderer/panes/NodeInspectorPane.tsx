import { ChevronDown, Cpu, MousePointer2, Save } from "lucide-react";
import type { LegacyAgentNode } from "../../shared/domain";
import { useAppStore } from "../store";
import { useSaveGraph } from "./GraphSettingsPane";

export function NodeInspectorPane() {
  const graph = useAppStore((state) => state.graph)!;
  const snapshot = useAppStore((state) => state.snapshot)!;
  const selectedNodeId = useAppStore((state) => state.selectedNodeId);
  const updateGraph = useAppStore((state) => state.updateGraph);
  const save = useSaveGraph();
  const node = graph.nodes.find((item) => item.id === selectedNodeId);

  function updateNode(patch: Partial<LegacyAgentNode>) {
    updateGraph({
      ...graph,
      nodes: graph.nodes.map((item) =>
        item.id === selectedNodeId ? { ...item, ...patch } : item,
      ),
    });
  }

  if (!node) {
    return (
      <div className="pane pane-empty" data-pane="node-inspector">
        <MousePointer2 size={22} />
        <h3>No node selected</h3>
        <p>Select an agent on the canvas to edit its model and instructions.</p>
      </div>
    );
  }

  return (
    <div className="pane pane-scroll pane-form" data-pane="node-inspector">
      <div className={`inspector-node-badge badge-${node.role}`}>
        <span>{node.role === "planner" ? "01" : "02"}</span>
        <div>
          <strong>{node.name}</strong>
          <small>
            <Cpu size={10} /> {node.role.toUpperCase()} NODE
          </small>
        </div>
      </div>
      <div className="setting-block">
        <label>DISPLAY NAME</label>
        <input
          value={node.name}
          onChange={(event) => updateNode({ name: event.target.value })}
        />
      </div>
      <div className="setting-block">
        <label>MODEL</label>
        <div className="select-wrap">
          <select
            value={node.model}
            onChange={(event) => updateNode({ model: event.target.value })}
          >
            {snapshot.models.length === 0 && (
              <option value={node.model}>{node.model}</option>
            )}
            {snapshot.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>
      </div>
      <div className="setting-block prompt-block">
        <label>INSTRUCTIONS</label>
        <textarea
          value={node.instructions}
          onChange={(event) => updateNode({ instructions: event.target.value })}
        />
        <small>{node.instructions.length} / 12,000</small>
      </div>
      <div className="inspector-actions">
        <button className="primary-button compact-button liquid-border" onClick={() => void save()}>
          <Save size={15} /> Save version
        </button>
      </div>
    </div>
  );
}
