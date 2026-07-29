import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  FolderOpen,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { useAppStore } from "../store";
import { EmptyRun, RunHeader, useSelectedRun } from "./shared";

export function ResultPane() {
  const { run } = useSelectedRun();
  const applySnapshot = useAppStore((state) => state.applySnapshot);
  const setBusy = useAppStore((state) => state.setBusy);
  const setError = useAppStore((state) => state.setError);

  async function retry() {
    if (!run) return;
    setBusy(true);
    setError(undefined);
    try {
      applySnapshot(await window.spire.retryRun(run.id));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!run) {
    return (
      <EmptyRun
        pane="result"
        message="Final graph state, validations, and artifacts land here."
      />
    );
  }

  return (
    <div className="pane pane-column" data-pane="result">
      <RunHeader run={run} />
      <div className="result-view pane-scroll">
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
      <footer className="run-actions">
        <button
          className="secondary-button"
          disabled={
            !["failed", "stopped", "needs_attention"].includes(run.status)
          }
          onClick={() => void retry()}
        >
          <RotateCcw size={14} /> Retry failed step
        </button>
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
            onClick={() => void window.spire.revealPath(run.artifacts!.worktreePath)}
          >
            <FolderOpen size={14} /> Open worktree
          </button>
        )}
      </footer>
    </div>
  );
}
