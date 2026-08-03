import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const renderedRules = stylesheet.replace(/:root\s*\{[^}]*\}/gs, "");
const contractStart = stylesheet.lastIndexOf(":root {");
const activeRulesStart = stylesheet.indexOf("\nbody {", contractStart);
const activeRules = stylesheet.slice(activeRulesStart);
const modalRulesStart = stylesheet.indexOf(".node-dialog-overlay");
const modalRulesEnd = stylesheet.indexOf("/* ---------- run panes", modalRulesStart);
const modalRules = stylesheet.slice(modalRulesStart, modalRulesEnd);
const canvasRulesStart = activeRules.indexOf(".graph-canvas");
const canvasRulesEnd = activeRules.indexOf(".launch-dock", canvasRulesStart);
const canvasRules = activeRules.slice(canvasRulesStart, canvasRulesEnd);
const listAndLauncherStart = stylesheet.indexOf(".section-heading {");
const listAndLauncherEnd = stylesheet.indexOf("/* ---------- buttons", listAndLauncherStart);
const listAndLauncherRules = stylesheet.slice(listAndLauncherStart, listAndLauncherEnd);

describe("active renderer design contract", () => {
  it("contains no selectors for the removed FlexLayout renderer", () => {
    expect(stylesheet).not.toContain(".flexlayout__");
  });

  it("contains no obsolete decorative visual system", () => {
    expect(stylesheet).not.toMatch(/\.glass|\.liquid-border|\.workspace-mesh/);
    expect(stylesheet).not.toMatch(/(?:linear|radial|conic)-gradient|backdrop-filter/);
  });

  it("routes graph-list and launcher visuals through design tokens", () => {
    expect(listAndLauncherRules).not.toMatch(/#[\da-f]{3,8}|rgba?\(|gradient/i);
    expect(listAndLauncherRules).not.toMatch(
      /^[ \t]+(?:gap|padding|border-radius|font(?:-size)?|line-height|letter-spacing|width|height|min-width|min-height|max-width|max-height)\s*:[^;}]*(?:\d+(?:\.\d+)?(?:px|em|ms))/im,
    );
  });

  it("routes active shell colors through semantic tokens", () => {
    expect(activeRules).not.toMatch(/#[\da-f]{3,8}/i);
    expect(stylesheet.slice(contractStart, activeRulesStart)).toContain(
      "--border-interactive",
    );
    expect(stylesheet.slice(contractStart, activeRulesStart)).toContain(
      "--overlay-scrim",
    );
  });

  it("routes every rendered color through semantic tokens", () => {
    expect(renderedRules).not.toMatch(/#[\da-f]{3,8}|rgba?\(/i);
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
    expect(canvasRules).toContain("var(--canvas-group-padding)");
    expect(canvasRules).toContain("var(--canvas-edge-label-padding-block)");
    expect(canvasRules).toContain("var(--canvas-edge-label-font)");
    expect(canvasRules).toContain("var(--canvas-edge-label-radius)");
    expect(canvasRules).toContain("var(--canvas-motion-duration)");
    expect(canvasRules).toContain("var(--canvas-group-header-height)");
    expect(canvasRules).toContain("var(--canvas-selection-outline-width)");
    expect(canvasRules).toContain("var(--canvas-handle-border-width)");
    expect(canvasRules).toMatch(
      /\.canvas-group-toggle\s*\{[\s\S]*?width:\s*var\(--control-height\);[\s\S]*?height:\s*var\(--control-height\);/,
    );
    expect(stylesheet.slice(contractStart, activeRulesStart)).toContain(
      "--control-height: 36px",
    );
    expect(canvasRules).not.toContain("var(--space-7)");
    expect(canvasRules).not.toMatch(/labelStyle|labelBgStyle/);
    expect(canvasRules).not.toMatch(
      /^[ \t]+(?:gap|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|border-radius|font(?:-size)?|line-height|letter-spacing|animation(?:-duration)?|transition(?:-duration)?|outline(?:-offset)?)\s*:[^;}]*(?:\d+(?:\.\d+)?(?:px|em|ms))/im,
    );
  });

  it("receives canvas geometry from the typed runtime contract instead of duplicating it", () => {
    const rootContract = stylesheet.slice(contractStart, activeRulesStart);
    expect(rootContract).not.toMatch(
      /--canvas-(?:node-width|node-height|group-padding|group-header-height|minimap-width|motion-duration|edge-label-padding|edge-label-radius|selection-outline|handle-border-width)\s*:/,
    );
  });
});
