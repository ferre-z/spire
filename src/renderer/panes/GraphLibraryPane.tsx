import { ChevronRight, GitBranch, Plus } from "lucide-react";
import { useAppStore } from "../store";

export function GraphLibraryPane() {
  const snapshot = useAppStore((state) => state.snapshot)!;
  const graph = useAppStore((state) => state.graph);
  const selectGraph = useAppStore((state) => state.selectGraph);

  const graphGroups = new Map<string, typeof snapshot.graphs>();
  for (const item of snapshot.graphs) {
    const group = graphGroups.get(item.id) ?? [];
    group.push(item);
    graphGroups.set(item.id, group);
  }

  return (
    <div className="pane pane-scroll" data-pane="graph-library">
      <div className="section-heading">
        <span>GRAPHS</span>
        <button aria-label="Create graph" title="Two-node MVP graph">
          <Plus size={15} />
        </button>
      </div>
      {[...graphGroups.values()].map((versions) => {
        const latest = [...versions].sort((a, b) => b.version - a.version)[0];
        return (
          <button
            key={latest.id}
            className={`graph-list-item ${graph?.id === latest.id ? "selected" : ""}`}
            onClick={() => selectGraph(latest)}
          >
            <span className="graph-list-icon">
              <GitBranch size={15} />
            </span>
            <span>
              <strong>{latest.name}</strong>
              <small>
                {latest.nodes.length} nodes · v{latest.version}
              </small>
            </span>
            <ChevronRight size={14} />
          </button>
        );
      })}
    </div>
  );
}
