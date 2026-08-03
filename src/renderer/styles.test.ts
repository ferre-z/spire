import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const contractStart = stylesheet.lastIndexOf(":root {");
const activeRulesStart = stylesheet.indexOf("\nbody {", contractStart);
const activeRules = stylesheet.slice(activeRulesStart);
const modalRulesStart = stylesheet.indexOf(".node-dialog-overlay");
const modalRulesEnd = stylesheet.indexOf("/* ---------- run panes", modalRulesStart);
const modalRules = stylesheet.slice(modalRulesStart, modalRulesEnd);
const canvasRulesStart = activeRules.indexOf(".graph-canvas");
const canvasRulesEnd = activeRules.indexOf(".launch-dock", canvasRulesStart);
const canvasRules = activeRules.slice(canvasRulesStart, canvasRulesEnd);

describe("active renderer design contract", () => {
  it("routes active shell colors through semantic tokens", () => {
    expect(activeRules).not.toMatch(/#[\da-f]{3,8}/i);
    expect(stylesheet.slice(contractStart, activeRulesStart)).toContain(
      "--border-interactive",
    );
    expect(stylesheet.slice(contractStart, activeRulesStart)).toContain(
      "--overlay-scrim",
    );
  });

  it("uses three proportional columns and a segmented compact dialog", () => {
    expect(stylesheet).toContain(
      "grid-template-columns: minmax(0, 24fr) minmax(0, 52fr) minmax(0, 24fr)",
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 1099px\)[\s\S]*\.node-dialog-column\[data-active="true"\]/,
    );
    expect(stylesheet).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.node-dialog-overlay/,
    );
  });

  it("routes modal spacing, type, radius, motion, and color through tokens", () => {
    expect(modalRules).toContain("var(--duration-overlay)");
    expect(modalRules).toContain("var(--radius-overlay)");
    expect(modalRules).toContain("var(--control-height)");
    expect(modalRules).toContain("var(--touch-target-size)");
    expect(modalRules).not.toMatch(/#[\da-f]{3,8}|rgba?\(/i);
    expect(modalRules).not.toMatch(
      /^[ \t]+(?:gap|padding|margin(?:-[a-z]+)?|border-radius|font(?:-size)?|line-height|letter-spacing|animation(?:-duration)?|transition(?:-duration)?|width|height|min-width|min-height|max-width|max-height)\s*:[^;}]*(?:\d+(?:\.\d+)?(?:px|em|ms))/im,
    );
  });

  it("uses a token-driven vertical canvas toolbar and semantic node states", () => {
    expect(canvasRules).toContain("flex-direction: column");
    expect(canvasRules).toContain(".node-handle--incoming");
    expect(canvasRules).toContain(".node-handle--outgoing");
    expect(canvasRules).toContain(".canvas-node-status.status--success");
    expect(canvasRules).toContain(".canvas-node-status.status--waiting");
    expect(canvasRules).toContain(".canvas-node-status.status--failed");
    expect(canvasRules).not.toMatch(/#[\da-f]{3,8}|rgba?\(/i);
    expect(canvasRules).not.toContain("animation:");
  });
});
