import type { ReactNode } from "react";
import { Bot, History, Library, MessageSquare } from "lucide-react";
import { StatusBadge, ToolCard } from "../components/UiPrimitives";
import { CollaborationPane } from "../panes/CollaborationPane";
import { DiffPane } from "../panes/DiffPane";
import { GraphLibraryPane } from "../panes/GraphLibraryPane";
import { HarnessesPane } from "../panes/HarnessesPane";
import { LiveStreamPane } from "../panes/LiveStreamPane";
import { ResultPane } from "../panes/ResultPane";
import { RunHistoryPane } from "../panes/RunHistoryPane";
import { useAppStore } from "../store";
import type { DrawerDestination, NavigationDestination } from "./workspaceUiStore";

const NAVIGATION_LABELS: Readonly<Record<NavigationDestination, string>> = {
  "graph-library": "Graph Library",
  "run-history": "Run History",
  harnesses: "Harnesses",
  collaboration: "Collaboration",
};

export const NAVIGATION_ITEMS: readonly {
  readonly id: NavigationDestination;
  readonly label: string;
  readonly icon: ReactNode;
}[] = [
  { id: "graph-library", label: NAVIGATION_LABELS["graph-library"], icon: <Library size={18} /> },
  { id: "run-history", label: NAVIGATION_LABELS["run-history"], icon: <History size={18} /> },
  { id: "harnesses", label: NAVIGATION_LABELS.harnesses, icon: <Bot size={18} /> },
  { id: "collaboration", label: NAVIGATION_LABELS.collaboration, icon: <MessageSquare size={18} /> },
] as const;

export const DRAWER_LABELS: Readonly<Record<DrawerDestination, string>> = {
  "live-stream": "Live Stream",
  diff: "Diff",
  result: "Result",
};

function assertNever(value: never): never {
  throw new Error(`Unhandled workspace destination: ${String(value)}`);
}

export function PanelHeader({
  eyebrow,
  title,
}: {
  readonly eyebrow: string;
  readonly title: string;
}) {
  return (
    <header className="workspace-panel-header">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
    </header>
  );
}

export function navigationTitle(destination: NavigationDestination): string {
  return NAVIGATION_LABELS[destination];
}

export function renderNavigation(destination: NavigationDestination): ReactNode {
  switch (destination) {
    case "graph-library":
      return <GraphLibraryPane />;
    case "run-history":
      return <RunHistoryPane />;
    case "harnesses":
      return <HarnessesPane />;
    case "collaboration":
      return <CollaborationPane />;
    default:
      return assertNever(destination);
  }
}

export function renderDrawer(destination: DrawerDestination): ReactNode {
  switch (destination) {
    case "live-stream":
      return <LiveStreamPane />;
    case "diff":
      return <DiffPane />;
    case "result":
      return <ResultPane />;
    default:
      return assertNever(destination);
  }
}

export function SelectedRunSummary() {
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
