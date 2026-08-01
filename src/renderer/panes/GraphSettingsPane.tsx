import { GitCompare, Save } from "lucide-react";
import { isGraphV2, useAppStore } from "../store";

export function useSaveGraph() {
  const graph = useAppStore((state) => state.graph)!;
  const applySnapshot = useAppStore((state) => state.applySnapshot);
  const setBusy = useAppStore((state) => state.setBusy);
  const setError = useAppStore((state) => state.setError);

  return async () => {
    setBusy(true);
    setError(undefined);
    try {
      applySnapshot(await window.spire.saveGraph(graph));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
}

export function GraphSettingsPane() {
  const graph = useAppStore((state) => state.graph)!;
  const updateGraph = useAppStore((state) => state.updateGraph);
  const save = useSaveGraph();

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
        <label>
          {isGraphV2(graph) ? "MAX STEPS" : "MAX IMPLEMENTATION PASSES"}
        </label>
        <div className="range-row">
          <input
            type="range"
            min={1}
            max={isGraphV2(graph) ? graph.maxSteps : graph.maxIterations}
            value={isGraphV2(graph) ? graph.maxSteps : graph.maxIterations}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (isGraphV2(graph)) {
                updateGraph({ ...graph, maxSteps: value });
              } else {
                updateGraph({ ...graph, maxIterations: value });
              }
            }}
          />
          <strong>
            {isGraphV2(graph) ? graph.maxSteps : graph.maxIterations}
          </strong>
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
