# Fixed premium graph workspace — clone/design-system fidelity review

Commit reviewed: `1cbbc037ad123e0820bae2d2f7f3e91f9b5317c8`.

Recommendation: **REQUEST_CHANGES**

## CRITICAL

None.

## HIGH

1. **The shipped renderer is not rigorously token-driven.** The design contract requires semantic aliases for component colors and named scales for repeated geometry/type ([`DESIGN.md:29`](/home/ferre/spire/.worktrees/fixed-premium-workspace/DESIGN.md:29)), yet live pane and launcher rules retain raw colors and one-off dimensions before the later shell overrides. For example, the graph-list icon rendered in the desktop baseline uses raw `#263040` and `#12161d` ([`styles.css:435`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/styles.css:435)), while the active list/launcher rules retain raw values such as 52px/9px/7px/8px ([`styles.css:423`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/styles.css:423)) and 120px/180px/160px/8px/10px/12px ([`styles.css:494`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/styles.css:494)). These are not mapped to the named scales introduced at [`styles.css:2304`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/styles.css:2304). The test narrowly starts its `activeRules` slice after the final root block, so it cannot detect these retained live rules ([`styles.test.ts:5`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/styles.test.ts:5)). This fails the requested token-driven-system gate.

## MEDIUM

1. **The stylesheet retains dead, contradictory visual systems alongside the active solid design.** The contract explicitly forbids glass, liquid treatment, gradient wash, and ornamental motion ([`DESIGN.md:5`](/home/ferre/spire/.worktrees/fixed-premium-workspace/DESIGN.md:5)). No current renderer component applies the `.glass`, `.liquid-border`, or `.workspace-mesh` classes, but the shipped stylesheet still defines glass/backdrop-filter ([`styles.css:109`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/styles.css:109)), liquid gradient animation ([`styles.css:139`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/styles.css:139)), and gradients ([`styles.css:431`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/styles.css:431), [`styles.css:568`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/styles.css:568)). It does not contaminate the five inspected frames, but makes the CSS a mixed system rather than the rigorous contract claimed.

## LOW

None.

## Verified evidence

- **Live component tree / no raster stand-in — pass.** `App` renders `WorkspaceShell` ([`App.tsx:63`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/App.tsx:63)); the shell mounts actual graph, navigation, context, dock, drawer, command-menu, and node-dialog components ([`WorkspaceShell.tsx:93`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/workspace/WorkspaceShell.tsx:93)). It composes reused `RailItem`, `ToolCard`, `Drawer`, `SegmentedControl`, and `StatusBadge` primitives ([`WorkspaceShell.tsx:101`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/workspace/WorkspaceShell.tsx:101), [`WorkspaceShell.tsx:141`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/workspace/WorkspaceShell.tsx:141), [`WorkspaceShell.tsx:187`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/workspace/WorkspaceShell.tsx:187)); their DOM implementations are real buttons/sections/dialogs ([`UiPrimitives.tsx:30`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/components/UiPrimitives.tsx:30), [`UiPrimitives.tsx:69`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/components/UiPrimitives.tsx:69), [`UiPrimitives.tsx:192`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/components/UiPrimitives.tsx:192)). A source search found no `url(...)`, `background-image`, `<img>`, or canvas image substitute in `src/renderer`.
- **Layer/layout structure — pass.** The shell grid encodes the contract's 56/248/fluid/312/52 wide layout and fixed 64px dock ([`styles.css:2450`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/styles.css:2450)); the 1279px and 1099px responsive overlay transitions follow it ([`styles.css:3213`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/styles.css:3213), [`styles.css:3241`](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/styles.css:3241)).
- **Visual baselines — pass for clipping/overflow and stated minimal premium direction.** Directly inspected all five current committed RGB PNGs: [`onboarding-linux.png`](/home/ferre/spire/.worktrees/fixed-premium-workspace/e2e/visual.spec.ts-snapshots/onboarding-linux.png) (1440x900), [`workspace-desktop-linux.png`](/home/ferre/spire/.worktrees/fixed-premium-workspace/e2e/visual.spec.ts-snapshots/workspace-desktop-linux.png) (1440x900), [`workspace-compact-linux.png`](/home/ferre/spire/.worktrees/fixed-premium-workspace/e2e/visual.spec.ts-snapshots/workspace-compact-linux.png) (1024x700), [`workspace-active-run-linux.png`](/home/ferre/spire/.worktrees/fixed-premium-workspace/e2e/visual.spec.ts-snapshots/workspace-active-run-linux.png) (1440x900), and [`workspace-node-dialog-linux.png`](/home/ferre/spire/.worktrees/fixed-premium-workspace/e2e/visual.spec.ts-snapshots/workspace-node-dialog-linux.png) (1440x900). They show solid charcoal hierarchy with blue navigation/orange execution, central graph, bounded dock/drawer/dialog, and no visible clipping or document overflow. The checked screenshots are exactly the five scenarios in [`visual.spec.ts:13`](/home/ferre/spire/.worktrees/fixed-premium-workspace/e2e/visual.spec.ts:13).

## Blockers

1. Remove or tokenise the live legacy component rules so the complete rendered CSS, not only the final override block, follows `DESIGN.md`'s semantic color, spacing, and typography system. This HIGH finding requires **REQUEST_CHANGES** under the clone-fidelity gate.

## Residual risk

The screenshots are reliable for the five listed fixed viewports/states only. They do not themselves prove all intermediate responsive sizes or interaction frames; the accompanying workspace suite supplies overflow assertions at 800x600, 1024x700, 1440x900, and 1920x1080 ([`workspace.spec.ts:41`](/home/ferre/spire/.worktrees/fixed-premium-workspace/e2e/workspace.spec.ts:41)), but I did not re-run Electron in this read-only audit.
