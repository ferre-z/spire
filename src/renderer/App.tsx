import { useEffect } from "react";
import { AlertCircle, Command, GitBranch, X } from "lucide-react";
import { useAppStore } from "./store";
import { Onboarding } from "./components/Onboarding";
import { Sidebar } from "./components/Sidebar";
import { GraphCanvas } from "./components/GraphCanvas";
import { Inspector } from "./components/Inspector";
import { RunPanel } from "./components/RunPanel";
import { RunComposer } from "./components/RunComposer";

export function App() {
  const snapshot = useAppStore((state) => state.snapshot);
  const graph = useAppStore((state) => state.graph);
  const error = useAppStore((state) => state.error);
  const initialize = useAppStore((state) => state.initialize);
  const receiveEvent = useAppStore((state) => state.receiveEvent);
  const setError = useAppStore((state) => state.setError);

  useEffect(() => {
    void initialize();
    return window.spire.onRunEvent((event) => {
      void receiveEvent(event);
    });
  }, [initialize, receiveEvent]);

  if (!snapshot) {
    return (
      <div className="app-loading">
        <div className="spire-loader">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }

  if (!snapshot.onboardingComplete) {
    return (
      <>
        <Onboarding />
        {error && <ErrorToast message={error} onClose={() => setError()} />}
      </>
    );
  }

  if (!graph) {
    return <div className="app-loading">No graph is configured.</div>;
  }

  return (
    <main className="app-shell">
      <div className="titlebar">
        <div className="titlebar-drag" />
        <span className="titlebar-context">
          <GitBranch size={13} /> {graph.name} / v{graph.version}
        </span>
        <span className="titlebar-command">
          <Command size={12} /> K
        </span>
      </div>
      <div className="workspace">
        <Sidebar />
        <section className="main-stage">
          <header className="stage-header">
            <div>
              <span className="kicker">ACTIVE GRAPH</span>
              <h1>{graph.name}</h1>
            </div>
            <div className="stage-metrics">
              <span>
                <strong>2</strong> AGENTS
              </span>
              <span>
                <strong>{graph.maxIterations}</strong> MAX PASSES
              </span>
              <span className="local-status">
                <i /> LOCAL
              </span>
            </div>
          </header>
          <div className="canvas-row">
            <GraphCanvas />
            <Inspector />
          </div>
          <RunComposer />
        </section>
        <RunPanel />
      </div>
      {error && <ErrorToast message={error} onClose={() => setError()} />}
    </main>
  );
}

function ErrorToast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div className="error-toast" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      <button onClick={onClose} aria-label="Dismiss error">
        <X size={15} />
      </button>
    </div>
  );
}
