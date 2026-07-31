/**
 * Canonical list of workspace panes. Kept free of React imports so default
 * layouts, validation, and unit tests can use it in a plain node runtime.
 */
export const PANE_IDS = [
  "graph-library",
  "run-history",
  "graph-canvas",
  "task-launcher",
  "graph-settings",
  "node-inspector",
  "runtime-policy",
  "live-stream",
  "collaboration",
  "harnesses",
  "diff",
  "result",
] as const;

export type PaneId = (typeof PANE_IDS)[number];

export type PaneMeta = {
  id: PaneId;
  /** FlexLayout tab `component` value. */
  component: string;
  title: string;
  /** Minimum size applied to native popout windows hosting this pane. */
  popoutMinWidth: number;
  popoutMinHeight: number;
};

export const PANE_META: Record<PaneId, PaneMeta> = {
  "graph-library": {
    id: "graph-library",
    component: "graph-library",
    title: "Graph Library",
    popoutMinWidth: 280,
    popoutMinHeight: 320,
  },
  "run-history": {
    id: "run-history",
    component: "run-history",
    title: "Run History",
    popoutMinWidth: 300,
    popoutMinHeight: 320,
  },
  "graph-canvas": {
    id: "graph-canvas",
    component: "graph-canvas",
    title: "Graph Canvas",
    popoutMinWidth: 480,
    popoutMinHeight: 360,
  },
  "task-launcher": {
    id: "task-launcher",
    component: "task-launcher",
    title: "Task Launcher",
    popoutMinWidth: 420,
    popoutMinHeight: 220,
  },
  "graph-settings": {
    id: "graph-settings",
    component: "graph-settings",
    title: "Graph Settings",
    popoutMinWidth: 300,
    popoutMinHeight: 320,
  },
  "node-inspector": {
    id: "node-inspector",
    component: "node-inspector",
    title: "Node Inspector",
    popoutMinWidth: 320,
    popoutMinHeight: 380,
  },
  "runtime-policy": {
    id: "runtime-policy",
    component: "runtime-policy",
    title: "Runtime Policy",
    popoutMinWidth: 300,
    popoutMinHeight: 280,
  },
  "live-stream": {
    id: "live-stream",
    component: "live-stream",
    title: "Live Stream",
    popoutMinWidth: 360,
    popoutMinHeight: 300,
  },
  collaboration: {
    id: "collaboration",
    component: "collaboration",
    title: "Collaboration",
    popoutMinWidth: 360,
    popoutMinHeight: 320,
  },
  harnesses: {
    id: "harnesses",
    component: "harnesses",
    title: "Harness connections",
    popoutMinWidth: 300,
    popoutMinHeight: 320,
  },
  diff: {
    id: "diff",
    component: "diff",
    title: "Diff",
    popoutMinWidth: 420,
    popoutMinHeight: 320,
  },
  result: {
    id: "result",
    component: "result",
    title: "Result",
    popoutMinWidth: 360,
    popoutMinHeight: 320,
  },
};

export function isPaneId(value: unknown): value is PaneId {
  return (
    typeof value === "string" && (PANE_IDS as readonly string[]).includes(value)
  );
}
