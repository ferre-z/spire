# NodeDialog evidence ledger

| Success criterion | Scenario | Invocation | Binary observable | Artifact |
| --- | --- | --- | --- | --- |
| Projections and deduplication | Incoming/outgoing topology resolves endpoint names; messages split received/authored; latest execution and duplicate ids win | `NODE_ENV=development pnpm exec vitest run src/renderer/node-dialog/selectors.test.ts` | 4 tests passed, exit 0 | `focused-tests.log` |
| All kinds and dialog behavior | Agent, decision, checkpoint, and subgraph settings; unavailable model; awaited harness change; live reopen; Escape/focus; Settings default; inline validation | `NODE_ENV=development pnpm exec vitest run src/renderer/node-dialog/NodeDialog.test.tsx` | 10 tests passed, exit 0 | `focused-tests.log` |
| Shell mount and responsive contract | Selected node resolves to modal; 24/52/24 desktop grid; compact active panel and reduced motion rules | `NODE_ENV=development pnpm exec vitest run src/renderer/workspace/WorkspaceShell.test.tsx src/renderer/styles.test.ts` | 10 tests passed, exit 0 | `focused-tests.log` |
| Real wide dialog | Open agent from the graph at 1440x900 | Playwright Chromium against the Vite renderer with a deterministic v2 graph | Dialog box 979.1875x684, matching 68vw x 76vh; no console errors | `node-dialog-wide.png`, `manual-qa.json` |
| Real compact dialog | Resize open dialog to 1000x760 and switch Settings to Input | Playwright Chromium against the Vite renderer with a deterministic v2 graph | Settings initially active; segmented control visible; Input becomes visible; focus restores to canvas node | `node-dialog-compact.png`, `manual-qa.json`, `manual-qa.log` |
| Lint | Full repository lint | `pnpm lint` | Exit 0 | `lint.log` |
| Production package | Electron Forge production package | `pnpm build` | Exit 0 | `build.log` |
| Typecheck exception | Full TypeScript check | `pnpm typecheck` | Only four explicitly allowed GraphCanvasPane/GraphCanvasPane.test legacy-v2 errors; no changed-file error | `typecheck.log` |

## Post-commit verification

Verified commit: `91bc784b1c3f8f1aec9b9602747638c5968c64ad`.

- Focused tests: 24 passed, zero failed (`post-commit-focused-tests.log`).
- Full lint: exit 0 (`post-commit-lint.log`).
- Production Electron package: exit 0 (`post-commit-build.log`).
- Typecheck: exit 2 with exactly four diagnostics, all confined to the explicitly allowed `GraphCanvasPane.tsx` and `GraphCanvasPane.test.tsx`; no changed-file diagnostic (`post-commit-typecheck.log`).
- Browser artifacts: wide PNG 95,911 bytes; compact PNG 38,985 bytes. The parsed QA result confirms compact Settings default, visible segmented control, successful Input switch, focus restoration, and zero console errors (`post-commit-artifact-check.log`).
