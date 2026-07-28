import {
  ChevronDown,
  Cpu,
  GitCompare,
  RotateCcw,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import type { AgentNode } from "../../shared/domain";
import { useAppStore } from "../store";

export function Inspector() {
  const graph = useAppStore((state) => state.graph)!;
  const snapshot = useAppStore((state) => state.snapshot)!;
  const selectedNodeId = useAppStore((state) => state.selectedNodeId);
  const updateGraph = useAppStore((state) => state.updateGraph);
  const applySnapshot = useAppStore((state) => state.applySnapshot);
  const setBusy = useAppStore((state) => state.setBusy);
  const setError = useAppStore((state) => state.setError);
  const node = graph.nodes.find((item) => item.id === selectedNodeId);

  function updateNode(patch: Partial<AgentNode>) {
    updateGraph({
      ...graph,
      nodes: graph.nodes.map((item) =>
        item.id === selectedNodeId ? { ...item, ...patch } : item,
      ),
    });
  }

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      applySnapshot(await window.spire.saveGraph(graph));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!node) {
    return (
      <aside className="inspector empty-inspector">
        <div className="inspector-heading">
          <SlidersHorizontal size={16} />
          GRAPH SETTINGS
        </div>
        <div className="setting-block">
          <label>GRAPH NAME</label>
          <input
            value={graph.name}
            onChange={(event) =>
              updateGraph({ ...graph, name: event.target.value })
            }
          />
        </div>
        <div className="setting-block">
          <label>MAX IMPLEMENTATION PASSES</label>
          <div className="range-row">
            <input
              type="range"
              min={1}
              max={5}
              value={graph.maxIterations}
              onChange={(event) =>
                updateGraph({
                  ...graph,
                  maxIterations: Number(event.target.value),
                })
              }
            />
            <strong>{graph.maxIterations}</strong>
          </div>
        </div>
        <div className="graph-rule">
          <GitCompare size={17} />
          <span>
            <strong>Bounded review loop</strong>
            Builder returns to Architect when review requests changes.
          </span>
        </div>
        <button className="secondary-button save-graph" onClick={() => void save()}>
          <Save size={15} /> Save new version
        </button>
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <Cpu size={16} />
        NODE INSPECTOR
      </div>
      <div className={`inspector-node-badge badge-${node.role}`}>
        <span>{node.role === "planner" ? "01" : "02"}</span>
        <div>
          <strong>{node.name}</strong>
          <small>{node.role.toUpperCase()} NODE</small>
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
      <div className="permission-summary">
        <span>RUNTIME POLICY</span>
        <div>
          <i className={node.role === "planner" ? "denied" : "allowed"} />
          Filesystem edits {node.role === "planner" ? "denied" : "allowed"}
        </div>
        <div>
          <i className="denied" />
          External directories denied
        </div>
        <div>
          <i className="denied" />
          Git push denied
        </div>
      </div>
      <div className="inspector-actions">
        <button className="ghost-button" title="Reset unsaved changes">
          <RotateCcw size={15} />
        </button>
        <button className="primary-button compact-button" onClick={() => void save()}>
          <Save size={15} /> Save version
        </button>
      </div>
    </aside>
  );
}
