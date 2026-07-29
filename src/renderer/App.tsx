import { useEffect } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Check,
  ChevronRight,
  Command,
  ExternalLink,
  GitBranch,
  LayoutGrid,
  Maximize2,
  PictureInPicture2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useAppStore } from "./store";
import { Onboarding } from "./components/Onboarding";
import { Brand } from "./components/Brand";
import { WorkspaceLayout } from "./workspace/WorkspaceLayout";
import { useLayoutStore, type LayoutCommandId } from "./workspace/layoutStore";
import { PANE_IDS, PANE_META } from "./workspace/paneIds";

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
      <div className="workspace-mesh" aria-hidden="true" />
      <header className="titlebar glass">
        <div className="titlebar-drag" />
        <div className="titlebar-brand">
          <Brand compact />
        </div>
        <span className="titlebar-context">
          <GitBranch size={13} /> {graph.name} / v{graph.version}
        </span>
        <ViewMenu />
        <button
          className="titlebar-command"
          onClick={() => useLayoutStore.getState().setCommandMenuOpen(true)}
          title="Layout commands (Ctrl/Cmd+K)"
        >
          <Command size={12} /> K
        </button>
      </header>
      <div className="workspace-toolbar">
        <div className="toolbar-title">
          <span className="kicker">ACTIVE GRAPH</span>
          <h1>{graph.name}</h1>
        </div>
        <div className="stage-metrics">
          <span>
            <strong>{graph.nodes.length}</strong> AGENTS
          </span>
          <span>
            <strong>{graph.maxIterations}</strong> MAX PASSES
          </span>
          <span className="local-status">
            <i /> LOCAL
          </span>
        </div>
      </div>
      <WorkspaceLayout />
      {error && <ErrorToast message={error} onClose={() => setError()} />}
    </main>
  );
}

function ViewMenu() {
  const closedPanes = useLayoutStore((state) => state.closedPanes);
  const hasActivePane = useLayoutStore((state) => state.hasActivePane);
  const hasPopouts = useLayoutStore((state) => state.hasPopouts);
  const isMaximized = useLayoutStore((state) => state.isMaximized);
  const reopenPane = useLayoutStore((state) => state.reopenPane);
  const runCommand = useLayoutStore((state) => state.runCommand);

  const command = (id: LayoutCommandId) => () => runCommand(id);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="titlebar-command titlebar-view">
        <LayoutGrid size={12} /> View
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu-content glass"
          sideOffset={6}
          align="end"
        >
          <DropdownMenu.Label className="menu-label">PANES</DropdownMenu.Label>
          {PANE_IDS.map((pane) => {
            const closed = closedPanes.includes(pane);
            return (
              <DropdownMenu.Item
                key={pane}
                className="menu-item"
                disabled={!closed}
                onSelect={() => reopenPane(pane)}
              >
                <span className="menu-item-check">
                  {!closed && <Check size={13} />}
                </span>
                {PANE_META[pane].title}
              </DropdownMenu.Item>
            );
          })}
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Label className="menu-label">
            ACTIVE PANE
          </DropdownMenu.Label>
          <DropdownMenu.Item
            className="menu-item"
            disabled={!hasActivePane}
            onSelect={command("move-left")}
          >
            <ArrowLeftToLine size={14} /> Move left
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="menu-item"
            disabled={!hasActivePane}
            onSelect={command("move-right")}
          >
            <ArrowRightToLine size={14} /> Move right
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="menu-item"
            disabled={!hasActivePane}
            onSelect={command("move-up")}
          >
            <ArrowUpToLine size={14} /> Move up
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="menu-item"
            disabled={!hasActivePane}
            onSelect={command("move-down")}
          >
            <ArrowDownToLine size={14} /> Move down
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="menu-item"
            disabled={!hasActivePane}
            onSelect={command("grow")}
          >
            <ZoomIn size={14} /> Resize larger
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="menu-item"
            disabled={!hasActivePane}
            onSelect={command("shrink")}
          >
            <ZoomOut size={14} /> Resize smaller
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="menu-item"
            disabled={!hasActivePane}
            onSelect={command("maximize-active")}
          >
            <Maximize2 size={14} /> {isMaximized ? "Restore" : "Maximize"}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item
            className="menu-item"
            disabled={!hasActivePane}
            onSelect={command("popout-active")}
          >
            <PictureInPicture2 size={14} /> Pop out active pane
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="menu-item"
            disabled={!hasPopouts}
            onSelect={command("dock-all")}
          >
            <ExternalLink size={14} /> Dock all popouts back
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item
            className="menu-item menu-item-danger"
            onSelect={command("reset-layout")}
          >
            <RotateCcw size={14} /> Reset layout
            <ChevronRight size={13} className="menu-item-trailing" />
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
    <div className="error-toast glass" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      <button onClick={onClose} aria-label="Dismiss error">
        <X size={15} />
      </button>
    </div>
  );
}
