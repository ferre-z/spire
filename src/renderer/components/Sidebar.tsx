import {
  Activity,
  Box,
  ChevronRight,
  Clock3,
  GitBranch,
  Plus,
  Settings,
} from "lucide-react";
import { Brand } from "./Brand";
import { StatusPill } from "./StatusPill";
import { relativeTime, shortPath } from "../lib";
import { useAppStore } from "../store";

export function Sidebar() {
  const snapshot = useAppStore((state) => state.snapshot)!;
  const graph = useAppStore((state) => state.graph);
  const selectedRunId = useAppStore((state) => state.selectedRunId);
  const selectGraph = useAppStore((state) => state.selectGraph);
  const selectRun = useAppStore((state) => state.selectRun);

  const graphGroups = new Map<string, typeof snapshot.graphs>();
  for (const item of snapshot.graphs) {
    const group = graphGroups.get(item.id) ?? [];
    group.push(item);
    graphGroups.set(item.id, group);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Brand />
      </div>
      <nav className="sidebar-nav" aria-label="Primary">
        <button className="nav-item active">
          <Box size={16} /> Graphs
          <span>{graphGroups.size}</span>
        </button>
        <button className="nav-item">
          <Activity size={16} /> Runs
          <span>{snapshot.runs.length}</span>
        </button>
      </nav>

      <div className="sidebar-section">
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
                <small>2 nodes · v{latest.version}</small>
              </span>
              <ChevronRight size={14} />
            </button>
          );
        })}
      </div>

      <div className="sidebar-section run-history">
        <div className="section-heading">
          <span>RECENT RUNS</span>
          <Clock3 size={14} />
        </div>
        {snapshot.runs.length === 0 ? (
          <div className="empty-sidebar">
            Your first run will appear here.
          </div>
        ) : (
          snapshot.runs.slice(0, 8).map((run) => (
            <button
              key={run.id}
              className={`run-list-item ${run.id === selectedRunId ? "selected" : ""}`}
              onClick={() => selectRun(run.id)}
            >
              <StatusPill status={run.status} compact />
              <span>
                <strong>{run.goal}</strong>
                <small>
                  {shortPath(run.repositoryPath)} · {relativeTime(run.startedAt)}
                </small>
              </span>
            </button>
          ))
        )}
      </div>

      <button className="settings-link">
        <Settings size={16} /> Settings
      </button>
    </aside>
  );
}
