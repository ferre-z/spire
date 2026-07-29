import { useMemo } from "react";
import {
  AlertTriangle,
  ChevronRight,
  LoaderCircle,
  Square,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import { useAppStore } from "../store";
import { EmptyRun, RunHeader, useSelectedRun } from "./shared";

export function LiveStreamPane() {
  const { run, active } = useSelectedRun();
  const applySnapshot = useAppStore((state) => state.applySnapshot);
  const setBusy = useAppStore((state) => state.setBusy);
  const setError = useAppStore((state) => state.setError);

  const events = useMemo(() => (run ? run.events.slice(-120) : []), [run]);

  async function stop() {
    if (!run) return;
    setBusy(true);
    setError(undefined);
    try {
      applySnapshot(await window.spire.stopRun(run.id));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!run) {
    return (
      <EmptyRun
        pane="live-stream"
        message="Launch the graph to watch events arrive live."
      />
    );
  }

  return (
    <div className="pane pane-column" data-pane="live-stream">
      <RunHeader run={run} />
      <div className="event-stream pane-scroll">
        {events.length === 0 ? (
          <div className="waiting-events">
            <LoaderCircle className="spin" size={18} /> Waiting for the first
            graph event…
          </div>
        ) : (
          events.map((event) => (
            <div className={`event-row event-${event.kind}`} key={event.id}>
              <span className="event-sequence">
                {String(event.sequence + 1).padStart(3, "0")}
              </span>
              <span className="event-icon">
                {event.kind === "error" ? (
                  <XCircle size={14} />
                ) : event.kind === "warning" ? (
                  <AlertTriangle size={14} />
                ) : event.kind === "tool" ? (
                  <TerminalSquare size={14} />
                ) : (
                  <ChevronRight size={14} />
                )}
              </span>
              <span className="event-content">
                <small>{event.phase.toUpperCase()}</small>
                <strong>{event.message}</strong>
              </span>
              <time>
                {new Date(event.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </time>
            </div>
          ))
        )}
      </div>
      {active && (
        <footer className="run-actions">
          <button className="danger-button" onClick={() => void stop()}>
            <Square size={13} fill="currentColor" /> Stop run
          </button>
        </footer>
      )}
    </div>
  );
}
