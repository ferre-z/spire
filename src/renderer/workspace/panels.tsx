import type { ReactNode } from "react";
import { PANE_META, type PaneId } from "./paneIds";
import { GraphLibraryPane } from "../panes/GraphLibraryPane";
import { RunHistoryPane } from "../panes/RunHistoryPane";
import { GraphCanvasPane } from "../panes/GraphCanvasPane";
import { TaskLauncherPane } from "../panes/TaskLauncherPane";
import { GraphSettingsPane } from "../panes/GraphSettingsPane";
import { NodeInspectorPane } from "../panes/NodeInspectorPane";
import { RuntimePolicyPane } from "../panes/RuntimePolicyPane";
import { LiveStreamPane } from "../panes/LiveStreamPane";
import { DiffPane } from "../panes/DiffPane";
import { ResultPane } from "../panes/ResultPane";
import { CollaborationPane } from "../panes/CollaborationPane";
import { HarnessesPane } from "../panes/HarnessesPane";

const PANE_RENDERERS: Record<PaneId, () => ReactNode> = {
  "graph-library": () => <GraphLibraryPane />,
  "run-history": () => <RunHistoryPane />,
  "graph-canvas": () => <GraphCanvasPane />,
  "task-launcher": () => <TaskLauncherPane />,
  "graph-settings": () => <GraphSettingsPane />,
  "node-inspector": () => <NodeInspectorPane />,
  "runtime-policy": () => <RuntimePolicyPane />,
  "live-stream": () => <LiveStreamPane />,
  collaboration: () => <CollaborationPane />,
  harnesses: () => <HarnessesPane />,
  diff: () => <DiffPane />,
  result: () => <ResultPane />,
};

export function renderPane(id: PaneId): ReactNode {
  return PANE_RENDERERS[id]();
}

export function paneTitle(id: PaneId): string {
  return PANE_META[id].title;
}
