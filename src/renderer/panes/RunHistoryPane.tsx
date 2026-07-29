import { Clock3 } from "lucide-react";
import { relativeTime, shortPath } from "../lib";
import { useAppStore } from "../store";
import { StatusPill } from "../components/StatusPill";

export function RunHistoryPane() {
  const snapshot = useAppStore((state) => state.snapshot)!;
  const selectedRunId = useAppStore((state) => state.selectedRunId);
  const selectRun = useAppStore((state) => state.selectRun);

  return (
    <div className="pane pane-scroll" data-pane="run-history">
      <div className="section-heading">
        <span>RECENT RUNS</span>
        <Clock3 size={14} />
      </div>
      {snapshot.runs.length === 0 ? (
        <div className="empty-sidebar">Your first run will appear here.</div>
      ) : (
        snapshot.runs.map((run) => (
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
  );
}
