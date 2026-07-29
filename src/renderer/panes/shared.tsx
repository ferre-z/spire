import { Code2 } from "lucide-react";
import type { AppSnapshot, RunRecord } from "../../shared/domain";
import { relativeTime } from "../lib";
import { useAppStore } from "../store";
import { StatusPill } from "../components/StatusPill";

export function useSelectedRun(): {
  snapshot: AppSnapshot;
  run?: RunRecord;
  active: boolean;
} {
  const snapshot = useAppStore((state) => state.snapshot)!;
  const selectedRunId = useAppStore((state) => state.selectedRunId);
  const run = snapshot.runs.find((item) => item.id === selectedRunId);
  const active = run
    ? ["preparing", "planning", "implementing", "reviewing"].includes(
        run.status,
      )
    : false;
  return { snapshot, run, active };
}

export function EmptyRun({ message, pane }: { message: string; pane: string }) {
  return (
    <div className="pane pane-empty" data-pane={pane}>
      <div className="empty-run-orbit">
        <span />
        <Code2 size={26} />
      </div>
      <h3>No run selected</h3>
      <p>{message}</p>
    </div>
  );
}

export function RunHeader({ run }: { run: RunRecord }) {
  return (
    <header className="pane-run-header">
      <div>
        <span className="run-id">RUN {run.id.slice(0, 8).toUpperCase()}</span>
        <h2>{run.goal}</h2>
        <p>
          Started {relativeTime(run.startedAt)} · pass {run.iteration || "—"}
        </p>
      </div>
      <StatusPill status={run.status} />
    </header>
  );
}
