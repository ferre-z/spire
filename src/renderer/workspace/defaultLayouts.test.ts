import { describe, expect, it } from "vitest";
import { isValidWorkspaceModel } from "../../shared/workspace";
import {
  defaultCompactLayout,
  defaultDesktopLayout,
  defaultLayoutForMode,
  paneTabJson,
} from "./defaultLayouts";
import { collectPaneIds } from "./layoutUtils";
import { PANE_IDS, PANE_META } from "./paneIds";

describe("default layout models", () => {
  it("desktop model is structurally valid", () => {
    expect(isValidWorkspaceModel(defaultDesktopLayout())).toBe(true);
  });

  it("compact model is structurally valid", () => {
    expect(isValidWorkspaceModel(defaultCompactLayout())).toBe(true);
  });

  it("both defaults contain every registered pane exactly once", () => {
    for (const model of [defaultDesktopLayout(), defaultCompactLayout()]) {
      const ids = collectPaneIds(model);
      expect(ids.size).toBe(PANE_IDS.length);
      for (const pane of PANE_IDS) {
        expect(ids.has(pane), `missing pane ${pane}`).toBe(true);
      }
    }
  });

  it("desktop layout places library/history left, canvas/launcher center, config/output right", () => {
    const model = defaultDesktopLayout();
    const [left, center, right] = model.layout.children as Array<{
      children: Array<{ children: Array<{ id: string }> }>;
    }>;
    expect(left.children[0].children[0].id).toBe("graph-library");
    expect(left.children[1].children[0].id).toBe("run-history");
    expect(center.children[0].children[0].id).toBe("graph-canvas");
    expect(center.children[1].children[0].id).toBe("task-launcher");
    expect(right.children[0].children.map((t) => t.id)).toEqual([
      "graph-settings",
      "node-inspector",
      "runtime-policy",
    ]);
    expect(right.children[1].children.map((t) => t.id)).toEqual([
      "live-stream",
      "diff",
      "result",
    ]);
  });

  it("compact layout tabs supporting panes into collapsed groups", () => {
    const model = defaultCompactLayout();
    const [edge, , support] = model.layout.children as Array<{
      children: Array<{ children: Array<{ id: string }> }>;
    }>;
    expect(edge.children[0].children.map((t) => t.id)).toEqual([
      "graph-library",
      "run-history",
    ]);
    expect(support.children[0].children.map((t) => t.id)).toEqual([
      "graph-settings",
      "node-inspector",
      "runtime-policy",
      "live-stream",
      "diff",
      "result",
    ]);
  });

  it("returns fresh objects on every call", () => {
    const first = defaultDesktopLayout();
    const second = defaultDesktopLayout();
    expect(first).not.toBe(second);
    expect(first.layout.children[0]).not.toBe(second.layout.children[0]);
  });

  it("selects the model by mode", () => {
    expect(defaultLayoutForMode("desktop")).toEqual(defaultDesktopLayout());
    expect(defaultLayoutForMode("compact")).toEqual(defaultCompactLayout());
  });

  it("pane tabs use registry metadata and stay closable and popout-capable", () => {
    for (const pane of PANE_IDS) {
      const tab = paneTabJson(pane);
      expect(tab.id).toBe(pane);
      expect(tab.component).toBe(PANE_META[pane].component);
      expect(tab.name).toBe(PANE_META[pane].title);
      expect(tab.enableClose).toBe(true);
      expect(tab.enablePopout).toBe(true);
    }
  });
});

describe("panel registry", () => {
  it("registers all ten workspace panes", () => {
    expect(PANE_IDS).toHaveLength(10);
    expect(new Set(PANE_IDS).size).toBe(10);
  });

  it("provides complete metadata for every pane", () => {
    for (const pane of PANE_IDS) {
      const meta = PANE_META[pane];
      expect(meta.title.length).toBeGreaterThan(0);
      expect(meta.component).toBe(pane);
      expect(meta.popoutMinWidth).toBeGreaterThan(0);
      expect(meta.popoutMinHeight).toBeGreaterThan(0);
    }
  });
});
