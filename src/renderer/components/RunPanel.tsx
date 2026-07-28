import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Code2,
  FileCode2,
  FolderOpen,
  LoaderCircle,
  RotateCcw,
  Square,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import { relativeTime } from "../lib";
import { useAppStore } from "../store";
import { StatusPill } from "./StatusPill";

export function RunPanel() {
  const snapshot = useAppStore((state) => state.snapshot)!;
  const selectedRunId = useAppStore((state) => state.selectedRunId);
  const applySnapshot = useAppStore((state) => state.applySnapshot);
  const setBusy = useAppStore((state) => state.setBusy);
  const setError = useAppStore((state) => state.setError);
  const [tab, setTab] = useState<"stream" | "diff" | "result">("stream");
  const run = snapshot.runs.find((item) => item.id === selectedRunId);
  const active = run
    ? ["preparing", "planning", "implementing", "reviewing"].includes(run.status)
    : false;

  const groupedEvents = useMemo(() => {
    if (!run) return [];
    return run.events.slice(-80);
  }, [run]);

  async function action(operation: () => Promise<typeof snapshot>) {
    setBusy(true);
    setError(undefined);
    try {
      applySnapshot(await operation());
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!run) {
    return (
      <section className="run-panel empty-run-panel">
        <div className="empty-run-orbit">
          <span />
          <Code2 size={28} />
        </div>
        <h3>No run selected</h3>
        <p>Launch the graph to watch events, revisions, and artifacts arrive.</p>
      </section>
    );
  }

  return (
    <section className="run-panel">
      <header className="run-panel-header">
        <div>
          <span className="run-id">RUN {run.id.slice(0, 8).toUpperCase()}</span>
          <h2>{run.goal}</h2>
          <p>Started {relativeTime(run.startedAt)} · pass {run.iteration || "—"}</p>
        </div>
        <StatusPill status={run.status} />
      </header>
      <div className="run-tabs" role="tablist">
        <button
          className={tab === "stream" ? "active" : ""}
          onClick={() => setTab("stream")}
        >
          <TerminalSquare size={14} /> LIVE STREAM
          <span>{run.events.length}</span>
        </button>
        <button
          className={tab === "diff" ? "active" : ""}
          onClick={() => setTab("diff")}
        >
          <FileCode2 size={14} /> DIFF
          <span>{run.artifacts?.changedFiles.length ?? 0}</span>
        </button>
        <button
          className={tab === "result" ? "active" : ""}
          onClick={() => setTab("result")}
        >
          <CheckCircle2 size={14} /> RESULT
        </button>
      </div>

      <div className="run-panel-body">
        {tab === "stream" && (
          <div className="event-stream">
            {groupedEvents.length === 0 ? (
              <div className="waiting-events">
                <LoaderCircle className="spin" size={18} /> Waiting for the
                first graph event…
              </div>
            ) : (
              groupedEvents.map((event) => (
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
        )}

        {tab === "diff" && (
          <div className="diff-view">
            {run.artifacts?.changedFiles.length ? (
              <div className="changed-files">
                {run.artifacts.changedFiles.map((file) => (
                  <span key={file}>
                    <FileCode2 size={13} /> {file}
                  </span>
                ))}
              </div>
            ) : null}
            <pre>
              <code>{run.artifacts?.diff || "No tracked changes yet."}</code>
            </pre>
          </div>
        )}

        {tab === "result" && (
          <div className="result-view">
            <div className={`result-hero result-${run.status}`}>
              {run.status === "succeeded" ? (
                <CheckCircle2 size={26} />
              ) : run.status === "failed" ? (
                <XCircle size={26} />
              ) : (
                <AlertTriangle size={26} />
              )}
              <div>
                <small>FINAL GRAPH STATE</small>
                <h3>{run.status.replace("_", " ")}</h3>
              </div>
            </div>
            {run.artifacts?.implementation && (
              <article className="result-section">
                <span>IMPLEMENTATION</span>
                <p>{run.artifacts.implementation.summary}</p>
                {run.artifacts.implementation.validations.map((validation) => (
                  <div className="validation-row" key={validation.command}>
                    {validation.status === "passed" ? (
                      <CheckCircle2 size={14} />
                    ) : (
                      <AlertTriangle size={14} />
                    )}
                    <code>{validation.command}</code>
                    <strong>{validation.status}</strong>
                  </div>
                ))}
              </article>
            )}
            {run.artifacts?.verdict && (
              <article className="result-section">
                <span>REVIEW EVIDENCE</span>
                <ul>
                  {run.artifacts.verdict.evidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            )}
            {run.error && <div className="error-box">{run.error}</div>}
          </div>
        )}
      </div>

      <footer className="run-actions">
        {active ? (
          <button
            className="danger-button"
            onClick={() =>
              void action(() => window.spire.stopRun(run.id))
            }
          >
            <Square size={13} fill="currentColor" /> Stop run
          </button>
        ) : (
          <button
            className="secondary-button"
            disabled={!["failed", "stopped", "needs_attention"].includes(run.status)}
            onClick={() =>
              void action(() => window.spire.retryRun(run.id))
            }
          >
            <RotateCcw size={14} /> Retry failed step
          </button>
        )}
        <div className="run-action-spacer" />
        {run.artifacts?.diff && (
          <button
            className="ghost-button labeled"
            onClick={() => void window.spire.exportPatch(run.id)}
          >
            <Clipboard size={14} /> Export patch
          </button>
        )}
        {run.artifacts?.worktreePath && (
          <button
            className="ghost-button labeled"
            onClick={() =>
              void window.spire.revealPath(run.artifacts!.worktreePath)
            }
          >
            <FolderOpen size={14} /> Open worktree
          </button>
        )}
      </footer>
    </section>
  );
}
