import { describe, expect, it } from "vitest";
import { collectPaneIds, sanitizePopoutRects } from "./layoutUtils";
import { PANE_META } from "./paneIds";

function modelWithPopout(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return {
    layout: {
      type: "row",
      children: [
        {
          type: "tabset",
          children: [
            {
              type: "tab",
              id: "graph-canvas",
              name: "Graph Canvas",
              component: "graph-canvas",
            },
          ],
        },
      ],
    },
    popouts: {
      "window-1": {
        rect,
        layout: {
          type: "row",
          children: [
            {
              type: "tabset",
              children: [
                {
                  type: "tab",
                  id: "live-stream",
                  name: "Live Stream",
                  component: "live-stream",
                },
              ],
            },
          ],
        },
      },
    },
  };
}

describe("collectPaneIds", () => {
  it("collects tabs from the main layout and popouts", () => {
    const ids = collectPaneIds(
      modelWithPopout({ x: 0, y: 0, width: 400, height: 300 }),
    );
    expect(ids).toEqual(new Set(["graph-canvas", "live-stream"]));
  });

  it("returns an empty set for malformed input", () => {
    expect(collectPaneIds(null).size).toBe(0);
    expect(collectPaneIds({}).size).toBe(0);
  });
});

describe("sanitizePopoutRects", () => {
  it("clamps popout dimensions to the pane minimums", () => {
    const result = sanitizePopoutRects(
      modelWithPopout({ x: 40, y: 50, width: 100, height: 90 }),
      { isWayland: false },
    ) as ReturnType<typeof modelWithPopout>;
    const rect = result.popouts["window-1"].rect;
    expect(rect.width).toBe(PANE_META["live-stream"].popoutMinWidth);
    expect(rect.height).toBe(PANE_META["live-stream"].popoutMinHeight);
    expect(rect.x).toBe(40);
    expect(rect.y).toBe(50);
  });

  it("keeps dimensions that already satisfy the minimums", () => {
    const result = sanitizePopoutRects(
      modelWithPopout({ x: 5, y: 6, width: 900, height: 700 }),
      { isWayland: false },
    ) as ReturnType<typeof modelWithPopout>;
    expect(result.popouts["window-1"].rect).toEqual({
      x: 5,
      y: 6,
      width: 900,
      height: 700,
    });
  });

  it("drops the saved position on Wayland but keeps the size", () => {
    const result = sanitizePopoutRects(
      modelWithPopout({ x: 120, y: 340, width: 900, height: 700 }),
      { isWayland: true },
    ) as ReturnType<typeof modelWithPopout>;
    const rect = result.popouts["window-1"].rect;
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(rect.width).toBe(900);
    expect(rect.height).toBe(700);
  });

  it("does not mutate the input model", () => {
    const input = modelWithPopout({ x: 1, y: 2, width: 10, height: 10 });
    sanitizePopoutRects(input, { isWayland: true });
    expect(input.popouts["window-1"].rect).toEqual({
      x: 1,
      y: 2,
      width: 10,
      height: 10,
    });
  });
});
