import type { WorkspaceLayoutMode } from "../../shared/workspace";
import { PANE_META, type PaneId } from "./paneIds";

/**
 * Default FlexLayout models for both workspace modes. These are plain JSON
 * factories (no FlexLayout imports) so they stay unit-testable in node and
 * every call returns a fresh, mutation-safe object.
 *
 * FlexLayout rows alternate orientation by depth: the root row is
 * horizontal, its child rows are vertical.
 */

export type LayoutTabJson = {
  type: "tab";
  id: string;
  name: string;
  component: string;
  enableClose: boolean;
  enablePopout: boolean;
};

export type LayoutTabSetJson = {
  type: "tabset";
  id: string;
  weight?: number;
  children: LayoutTabJson[];
};

export type LayoutRowJson = {
  type: "row";
  weight?: number;
  children: (LayoutRowJson | LayoutTabSetJson)[];
};

export type DefaultLayoutModel = {
  global: Record<string, unknown>;
  layout: LayoutRowJson;
};

export function paneTabJson(id: PaneId): LayoutTabJson {
  const meta = PANE_META[id];
  return {
    type: "tab",
    id: meta.id,
    name: meta.title,
    component: meta.component,
    enableClose: true,
    enablePopout: true,
  };
}

function tabSet(
  id: string,
  panes: PaneId[],
  weight?: number,
): LayoutTabSetJson {
  return {
    type: "tabset",
    id,
    ...(weight === undefined ? {} : { weight }),
    children: panes.map(paneTabJson),
  };
}

const GLOBAL_ATTRIBUTES: Record<string, unknown> = {
  // 8px interaction region; the visible 1px line is drawn in CSS.
  splitterSize: 8,
  tabEnableClose: true,
  tabEnablePopout: true,
  tabEnableRename: false,
  tabSetEnableMaximize: true,
  tabEnableFloat: false,
};

/**
 * Desktop (>= 1100px):
 * - left column: Graph Library over Run History
 * - center: Graph Canvas over Task Launcher
 * - right column: Graph Settings / Runtime Policy /
 *   Collaboration / Harnesses tabbed, over Live Stream / Diff / Result tabbed
 */
export function defaultDesktopLayout(): DefaultLayoutModel {
  return {
    global: { ...GLOBAL_ATTRIBUTES },
    layout: {
      type: "row",
      children: [
        {
          type: "row",
          weight: 18,
          children: [
            tabSet("ts-library", ["graph-library"], 45),
            tabSet("ts-history", ["run-history"], 55),
          ],
        },
        {
          type: "row",
          weight: 52,
          children: [
            tabSet("ts-canvas", ["graph-canvas"], 72),
            tabSet("ts-launcher", ["task-launcher"], 28),
          ],
        },
        {
          type: "row",
          weight: 30,
          children: [
            tabSet(
              "ts-config",
              [
                "graph-settings",
                "runtime-policy",
                "collaboration",
                "harnesses",
              ],
              50,
            ),
            tabSet("ts-output", ["live-stream", "diff", "result"], 50),
          ],
        },
      ],
    },
  };
}

/**
 * Compact (800-1099px): collapsed edge groups, supporting panes tabbed.
 * - left: Graph Library and Run History tabbed together
 * - center: Graph Canvas over Task Launcher
 * - right: every supporting pane in one tab group
 */
export function defaultCompactLayout(): DefaultLayoutModel {
  return {
    global: { ...GLOBAL_ATTRIBUTES },
    layout: {
      type: "row",
      children: [
        {
          type: "row",
          weight: 24,
          children: [
            tabSet("ts-compact-edge", ["graph-library", "run-history"]),
          ],
        },
        {
          type: "row",
          weight: 46,
          children: [
            tabSet("ts-compact-canvas", ["graph-canvas"], 70),
            tabSet("ts-compact-launcher", ["task-launcher"], 30),
          ],
        },
        {
          type: "row",
          weight: 30,
          children: [
            tabSet("ts-compact-support", [
              "graph-settings",
              "runtime-policy",
              "collaboration",
              "harnesses",
              "live-stream",
              "diff",
              "result",
            ]),
          ],
        },
      ],
    },
  };
}

export function defaultLayoutForMode(mode: WorkspaceLayoutMode): DefaultLayoutModel {
  return mode === "desktop" ? defaultDesktopLayout() : defaultCompactLayout();
}
