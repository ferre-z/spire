import { GitCompare, Save } from "lucide-react";
import { useAppStore } from "../store";

export function useSaveGraph() {
  return useAppStore((state) => state.saveCurrentGraph);
}

export function GraphSettingsPane() {
  const graph = useAppStore((state) => state.graph);
  const updateGraph = useAppStore((state) => state.updateGraph);
  const save = useSaveGraph();

  if (!graph) return <div className="pane pane-empty">No graph selected.</div>;

  return (
    <div className="pane pane-scroll pane-form" data-pane="graph-settings">
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
        <label>MAX STEPS</label>
        <div className="range-row">
          <input
            type="range"
            min={1}
            max={500}
            value={graph.maxSteps}
            onChange={(event) => {
              updateGraph({ ...graph, maxSteps: Number(event.target.value) });
            }}
          />
          <strong>{graph.maxSteps}</strong>
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
    </div>
  );
}
