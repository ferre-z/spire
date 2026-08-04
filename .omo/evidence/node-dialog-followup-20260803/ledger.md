# NodeDialog follow-up verification ledger

Verified: 2026-08-03T07:31:35+02:00

## Source identity

- Commit: `41e9300477daab8424d792660bb2d429b792de5f`
- Commit subject: `fix: harden node dialog integration`
- Commit tree: `4de2b630392378ff37729ca6d3e4212a72d1b306`
- Visual QA was captured from the staged candidate with the same tree hash, immediately before committing.
- Owned-path status after commit: empty. The remaining untracked `.omo/evidence/` entries shown by `git status --short` are evidence artifacts and were not committed.

## Automated contract scenarios

### Node dialog behavior, registry/layout removal, and CSS token contract

- Scenario: selectors, modal behavior/focus, segmented-control roving keyboard behavior, fixed-shell integration, legacy pane removal from both layouts/registry, layout utilities, and semantic NodeDialog CSS token enforcement.
- Invocation: `NODE_ENV=development pnpm exec vitest run src/renderer/node-dialog/selectors.test.ts src/renderer/node-dialog/NodeDialog.test.tsx src/renderer/workspace/WorkspaceShell.test.tsx src/renderer/workspace/defaultLayouts.test.ts src/renderer/workspace/layoutUtils.test.ts src/renderer/styles.test.ts`
- Binary observable: exit code `0`; `6 passed (6)` test files; `43 passed (43)` tests.
- Captured output:

```text
✓ src/renderer/styles.test.ts (3 tests)
✓ src/renderer/workspace/layoutUtils.test.ts (6 tests)
✓ src/renderer/node-dialog/selectors.test.ts (4 tests)
✓ src/renderer/workspace/defaultLayouts.test.ts (10 tests)
✓ src/renderer/workspace/WorkspaceShell.test.tsx (8 tests)
✓ src/renderer/node-dialog/NodeDialog.test.tsx (12 tests)
Test Files  6 passed (6)
Tests  43 passed (43)
```

### Lint

- Scenario: repository lint after deleting the temporary browser driver.
- Invocation: `pnpm lint`
- Binary observable: exit code `0`.
- Captured output: `$ eslint .`

### Production packaging

- Scenario: Electron production package, including Vite main, preload, and renderer targets.
- Invocation: `pnpm build`
- Binary observable: exit code `0`; `Built target main_window`; `Packaging for x64 on linux`; all packaging hooks completed.

### Type diagnostics audit

- Scenario: ensure the follow-up introduces no new TypeScript diagnostics while preserving the caller-approved GraphCanvas fallout.
- Invocation: `pnpm typecheck`
- Binary observable: exit code `2`, containing exactly four diagnostics and all four confined to the approved paths: three in `src/renderer/panes/GraphCanvasPane.test.tsx` (lines 241, 418, 459) and one in `src/renderer/panes/GraphCanvasPane.tsx` (line 456). No changed NodeDialog, workspace registry/layout, styles-test, or DESIGN path appears in the output.
- Judgment: this is the explicitly permitted GraphCanvas-only baseline, not a claimed passing typecheck.

### Registry residue and sole consumer

- Scenario: prove the legacy pane is absent from runtime code and NodeDialog has one production consumer.
- Invocation: `rg -n "node-inspector|Node Inspector" src DESIGN.md || true` followed by `rg -n "NodeDialog" src/renderer --glob '!**/*.test.*'`.
- Binary observable: the only legacy-string match is the negative assertion `expect(PANE_IDS).not.toContain("node-inspector")`; the only production NodeDialog import/render consumer is `WorkspaceShell.tsx`.

## Browser and visual scenarios

- Invocation: Playwright Chromium against Vite at `http://127.0.0.1:4173`, viewport `1440x900` then `1000x760`, `reducedMotion: "reduce"`. The temporary driver was deleted after capture so it cannot affect repository lint.
- Fixture: one selected agent node with 16 incoming and 16 outgoing edges, repeated long unbroken node names, labels, job text, and write scopes.
- Machine-readable artifact: `qa.json` (1096 bytes), SHA-256 `fc45736cb168a798ab1dbd491795565df9de61a3cc1e9aeb755d7d114ca4ca6b`.

### Wide modal

- Scenario: three-column desktop modal at 1440x900.
- Binary observable: dialog box `{x:230.40625,y:108,width:979.1875,height:684}`; no console errors.
- Artifact: `wide.png` (217544 bytes), SHA-256 `84ff942619b458621664df97cd0d8eab2b2679655ba7988f0c463c89435724f2`.
- Visual judgment: centered modal, header/status/close controls visible, three columns aligned, footer actions visible, long content wraps inside its columns without viewport escape.

### Compact Input and long-content scrolling

- Scenario: compact viewport with Input selected and 16 long incoming edge cards.
- Binary observable: Input radio selected; panel `clientWidth=974`, `scrollWidth=974`, `clientHeight=527`, `scrollHeight=3263`. Equal client/scroll width proves no horizontal overflow; greater scroll height proves vertical scrolling is available.
- Artifact: `compact-input.png` (113035 bytes), SHA-256 `7588490f67a77133fefbc4c1589ff4b5fa38e3afcd64c3e73899269895f524ab`.
- Visual judgment: segmented control and sticky footer remain usable; cards wrap and stay inside the dialog.

### Compact Output and keyboard roving

- Scenario: focus Input, press `End`, verify Output becomes both selected and focused, with 16 long outgoing edge cards.
- Binary observable: `rovingSelected="true"`, `rovingFocused=true`; panel `clientWidth=974`, `scrollWidth=974`, `clientHeight=527`, `scrollHeight=3320`.
- Artifact: `compact-output.png` (113084 bytes), SHA-256 `957a5d280d5c2e42992543584e9f775ce3c5bb1b4196591b458f18717a8b5c9c`.
- Visual judgment: Output selection has a visible focus ring and long cards remain horizontally contained.

### Modal containment, inert background, reduced motion, and focus restoration

- Scenario: attempt programmatic background focus while open; tab from final action; inspect reduced-motion computed styles; close after React Flow rerender.
- Binary observable: `bodyPointerEvents="none"`, `backgroundFocusContained=true`, `tabFocusContained=true`, dialog/overlay `animationName="none"` and `animationDuration="1e-05s"`, `focusRestored=true`, `activeAfterClose="builder"`, `consoleErrors=[]`.
- Judgment: background interaction is inert while open, keyboard focus remains within the dialog, reduced-motion override is active, and closing restores focus to the current React Flow DOM node by stable `data-id` even if the original node element was replaced.

## Final result

All requested follow-up criteria are directly verified. Focused tests, lint, and production packaging pass. Browser observables and reviewed screenshots cover wide/compact layouts, compact Input and Output, long unbroken content, keyboard roving, focus containment, background inertness, reduced motion, focus restoration, and console cleanliness. Typecheck contains only the four explicitly allowed GraphCanvas diagnostics.
