import { useEffect, type ReactNode } from "react";
import {
  Activity,
  Bot,
  GitBranch,
  History,
  Library,
  MessageSquare,
  ScrollText,
  Settings2,
} from "lucide-react";
import { Drawer, RailItem, SegmentedControl, StatusBadge, ToolCard } from "../components/UiPrimitives";
import { CollaborationPane } from "../panes/CollaborationPane";
import { DiffPane } from "../panes/DiffPane";
import { GraphCanvasPane } from "../panes/GraphCanvasPane";
import { GraphLibraryPane } from "../panes/GraphLibraryPane";
import { GraphSettingsPane } from "../panes/GraphSettingsPane";
import { HarnessesPane } from "../panes/HarnessesPane";
import { LiveStreamPane } from "../panes/LiveStreamPane";
import { ResultPane } from "../panes/ResultPane";
import { RunHistoryPane } from "../panes/RunHistoryPane";
import { RuntimePolicyPane } from "../panes/RuntimePolicyPane";
import { TaskLauncherPane } from "../panes/TaskLauncherPane";
import { useAppStore } from "../store";
import { CommandMenu } from "./CommandMenu";
import {
  DRAWER_DESTINATIONS,
  type DrawerDestination,
  type NavigationDestination,
  useWorkspaceUiStore,
} from "./workspaceUiStore";

const NAVIGATION_ITEMS: readonly {
  readonly id: NavigationDestination;
  readonly label: string;
  readonly icon: ReactNode;
}[] = [
  { id: "graph-library", label: "Graph Library", icon: <Library size={18} /> },
  { id: "run-history", label: "Run History", icon: <History size={18} /> },
  { id: "harnesses", label: "Harnesses", icon: <Bot size={18} /> },
  { id: "collaboration", label: "Collaboration", icon: <MessageSquare size={18} /> },
] as const;

const DRAWER_LABELS: Readonly<Record<DrawerDestination, string>> = {
  "live-stream": "Live Stream",
  diff: "Diff",
  result: "Result",
};

export function WorkspaceShell() {
  const activeNavigation = useWorkspaceUiStore((state) => state.activeNavigation);
  const navigationOpen = useWorkspaceUiStore((state) => state.navigationOpen);
  const contextOpen = useWorkspaceUiStore((state) => state.contextOpen);
  const drawer = useWorkspaceUiStore((state) => state.drawer);
  const openNavigation = useWorkspaceUiStore((state) => state.openNavigation);
  const setNavigationOpen = useWorkspaceUiStore((state) => state.setNavigationOpen);
  const setContextOpen = useWorkspaceUiStore((state) => state.setContextOpen);
  const openDrawer = useWorkspaceUiStore((state) => state.openDrawer);
  const closeDrawer = useWorkspaceUiStore((state) => state.closeDrawer);
  const setCommandMenuOpen = useWorkspaceUiStore((state) => state.setCommandMenuOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandMenuOpen(true);
        return;
      }
      if (event.key === "Escape") {
        closeDrawer();
        setNavigationOpen(false);
        setContextOpen(false);
        return;
      }
      if (event.key !== "F6") return;
      event.preventDefault();
      const regions = [...document.querySelectorAll<HTMLElement>("[data-major-region]")];
      if (regions.length === 0) return;
      const current = regions.findIndex((region) => region === document.activeElement);
      const delta = event.shiftKey ? -1 : 1;
      const nextIndex = current < 0
        ? event.shiftKey
          ? regions.length - 1
          : 0
        : (current + delta + regions.length) % regions.length;
      regions[nextIndex]?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDrawer, setCommandMenuOpen, setContextOpen, setNavigationOpen]);

  return (
    <div className="workspace-shell">
      <nav
        className="activity-rail major-region"
        aria-label="Activity destinations"
        data-major-region
        tabIndex={-1}
      >
        {NAVIGATION_ITEMS.map((item) => (
          <RailItem
            key={item.id}
            label={item.label}
            text={item.label}
            current={activeNavigation === item.id}
            onClick={() => openNavigation(item.id)}
          >
            {item.icon}
          </RailItem>
        ))}
      </nav>

      <aside
        className={`navigation-panel major-region ${navigationOpen ? "is-open" : ""}`}
        aria-label="Graph navigation"
        data-major-region
        tabIndex={-1}
      >
        <PanelHeader eyebrow="NAVIGATION" title={navigationTitle(activeNavigation)} />
        <div className="workspace-scroll">{renderNavigation(activeNavigation)}</div>
      </aside>

      <section
        className="canvas-region major-region"
        aria-label="Graph canvas"
        data-major-region
        tabIndex={-1}
      >
        <GraphCanvasPane />
      </section>

      <aside
        className={`context-panel major-region ${contextOpen ? "is-open" : ""}`}
        aria-label="Graph context"
        data-major-region
        tabIndex={-1}
      >
        <PanelHeader eyebrow="CONTEXT" title="Graph controls" />
        <div className="context-scroll">
          <ToolCard title="Graph Settings"><GraphSettingsPane /></ToolCard>
          <ToolCard title="Runtime Policy"><RuntimePolicyPane /></ToolCard>
          <SelectedRunSummary />
        </div>
      </aside>

      <nav
        className="utility-rail major-region"
        aria-label="Output utilities"
        data-major-region
        tabIndex={-1}
      >
        <RailItem label="Context" onClick={() => setContextOpen(true)}>
          <Settings2 size={18} />
        </RailItem>
        <span className="utility-spacer" />
        <RailItem label="Live Stream" current={drawer === "live-stream"} onClick={() => openDrawer("live-stream")}>
          <Activity size={18} />
        </RailItem>
        <RailItem label="Diff" current={drawer === "diff"} onClick={() => openDrawer("diff")}>
          <GitBranch size={18} />
        </RailItem>
        <RailItem label="Result" current={drawer === "result"} onClick={() => openDrawer("result")}>
          <ScrollText size={18} />
        </RailItem>
      </nav>

      <section
        className="launch-dock major-region"
        aria-label="Launch graph"
        data-major-region
        tabIndex={-1}
      >
        <TaskLauncherPane />
      </section>

      <button
        type="button"
        className={`responsive-scrim ${navigationOpen || contextOpen ? "is-visible" : ""}`}
        aria-label="Close workspace panel"
        onClick={() => {
          setNavigationOpen(false);
          setContextOpen(false);
        }}
      />

      <Drawer
        open={drawer !== undefined}
        title={drawer ? DRAWER_LABELS[drawer] : "Output"}
        onClose={closeDrawer}
        controls={drawer ? (
          <SegmentedControl
            label="Output view"
            value={drawer}
            options={DRAWER_DESTINATIONS.map((id) => ({ id, label: DRAWER_LABELS[id] }))}
            onChange={openDrawer}
          />
        ) : undefined}
      >
        {drawer ? renderDrawer(drawer) : null}
      </Drawer>
      <CommandMenu />
    </div>
  );
}

function PanelHeader({ eyebrow, title }: { readonly eyebrow: string; readonly title: string }) {
  return (
    <header className="workspace-panel-header">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
    </header>
  );
}

function navigationTitle(destination: NavigationDestination): string {
  return NAVIGATION_ITEMS.find((item) => item.id === destination)?.label ?? "Navigation";
}

function renderNavigation(destination: NavigationDestination): ReactNode {
  switch (destination) {
    case "graph-library":
      return <GraphLibraryPane />;
    case "run-history":
      return <RunHistoryPane />;
    case "harnesses":
      return <HarnessesPane />;
    case "collaboration":
      return <CollaborationPane />;
  }
}

function renderDrawer(destination: DrawerDestination): ReactNode {
  switch (destination) {
    case "live-stream":
      return <LiveStreamPane />;
    case "diff":
      return <DiffPane />;
    case "result":
      return <ResultPane />;
  }
}

function SelectedRunSummary() {
  const snapshot = useAppStore((state) => state.snapshot);
  const selectedRunId = useAppStore((state) => state.selectedRunId);
  const run = snapshot?.runs.find((candidate) => candidate.id === selectedRunId);
  const tone = run
    ? ["failed", "needs_attention"].includes(run.status)
      ? "error"
      : ["succeeded"].includes(run.status)
        ? "ready"
        : "warning"
    : "neutral";
  return (
    <ToolCard title="Selected Run" className="run-summary-card">
      {run ? (
        <>
          <StatusBadge label={run.status.replace("_", " ")} tone={tone} />
          <strong>{run.goal}</strong>
          <code>{run.id}</code>
        </>
      ) : (
        <p>No run selected.</p>
      )}
    </ToolCard>
  );
}
