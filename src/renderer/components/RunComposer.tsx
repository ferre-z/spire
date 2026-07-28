import { FolderGit2, LoaderCircle, Play, Sparkles } from "lucide-react";
import { useAppStore } from "../store";

export function RunComposer() {
  const graph = useAppStore((state) => state.graph)!;
  const snapshot = useAppStore((state) => state.snapshot)!;
  const repositoryPath = useAppStore((state) => state.repositoryPath);
  const goal = useAppStore((state) => state.goal);
  const busy = useAppStore((state) => state.busy);
  const setRepositoryPath = useAppStore((state) => state.setRepositoryPath);
  const setGoal = useAppStore((state) => state.setGoal);
  const setBusy = useAppStore((state) => state.setBusy);
  const setError = useAppStore((state) => state.setError);
  const applySnapshot = useAppStore((state) => state.applySnapshot);
  const active = Boolean(snapshot.activeRunId);

  async function chooseRepository() {
    const path = await window.spire.chooseRepository();
    if (path) setRepositoryPath(path);
  }

  async function start() {
    if (!goal.trim() || !repositoryPath) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await window.spire.startRun({
        graph,
        repositoryPath,
        goal,
      });
      applySnapshot(next);
      setGoal("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="run-composer">
      <button
        className="repo-picker"
        onClick={() => void chooseRepository()}
        title={repositoryPath || "Choose Git repository"}
      >
        <FolderGit2 size={16} />
        <span>{repositoryPath || "Choose repository"}</span>
      </button>
      <div className="goal-field">
        <Sparkles size={16} />
        <input
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              void start();
            }
          }}
          placeholder="Describe the coding outcome for this graph…"
          disabled={active}
        />
        <span>⌘↵</span>
      </div>
      <button
        className="primary-button run-button"
        disabled={busy || active || !goal.trim() || !repositoryPath}
        onClick={() => void start()}
      >
        {busy ? (
          <LoaderCircle className="spin" size={17} />
        ) : (
          <Play size={16} fill="currentColor" />
        )}
        {active ? "Run active" : "Launch graph"}
      </button>
    </section>
  );
}
