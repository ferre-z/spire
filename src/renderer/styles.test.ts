import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const contractStart = stylesheet.lastIndexOf(":root {");
const activeRulesStart = stylesheet.indexOf("\nbody {", contractStart);
const activeRules = stylesheet.slice(activeRulesStart);

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
});
