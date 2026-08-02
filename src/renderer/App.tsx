import { useEffect } from "react";
import { AlertCircle, Command, GitBranch, X } from "lucide-react";
import { Brand } from "./components/Brand";
import { Onboarding } from "./components/Onboarding";
import { useAppStore } from "./store";
import { WorkspaceShell } from "./workspace/WorkspaceShell";
import { useWorkspaceUiStore } from "./workspace/workspaceUiStore";

declare global {
  interface ImportMeta {
    readonly env: {
      readonly DEV: boolean;
    };
  }
}

export function App() {
  const snapshot = useAppStore((state) => state.snapshot);
  const graph = useAppStore((state) => state.graph);
  const error = useAppStore((state) => state.error);
  const initialize = useAppStore((state) => state.initialize);
  const receiveEvent = useAppStore((state) => state.receiveEvent);
  const setError = useAppStore((state) => state.setError);
  const setCommandMenuOpen = useWorkspaceUiStore((state) => state.setCommandMenuOpen);

  useEffect(() => {
    void initialize();
    return window.spire.onRunEvent((event) => {
      void receiveEvent(event);
    });
  }, [initialize, receiveEvent]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let dispose: (() => void) | undefined;
    void import("./devDiagnostics").then((module) => {
      dispose = module.installReactDiagnostics();
    });
    return () => dispose?.();
  }, []);

  if (!snapshot) {
    return (
      <div className="app-loading" role="status">
        <span className="loading-indicator" /> Loading Spire…
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
      <header className="titlebar">
        <div className="titlebar-brand"><Brand compact /></div>
        <span className="titlebar-context">
          <GitBranch size={13} /> {graph.name} <code>v{graph.version}</code>
        </span>
        <button
          type="button"
          className="titlebar-command"
          onClick={() => setCommandMenuOpen(true)}
          title="Open commands (Ctrl/Cmd+K)"
          aria-label="Open commands"
        >
          <Command size={13} /> <span>Command</span> <kbd>⌘K</kbd>
        </button>
      </header>
      <WorkspaceShell />
      {error && <ErrorToast message={error} onClose={() => setError()} />}
    </main>
  );
}

function ErrorToast({ message, onClose }: { readonly message: string; readonly onClose: () => void }) {
  return (
    <div className="error-toast" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="Dismiss error">
        <X size={15} />
      </button>
    </div>
  );
}
