# Graph canvas modernization evidence

Implementation commit: `6e90219` (`feat: modernize graph canvas`).

## Success scenarios

| Scenario | Invocation | Binary observable | Artifact |
| --- | --- | --- | --- |
| V2-only node rendering, semantic execution markers, blue input/orange output handles, accessible icon toolbar, harness/model resolution, creation flow, local drag persistence, one-time fit, zoom/minimap/selection | `NODE_ENV=test pnpm exec vitest run src/renderer/panes/GraphCanvasPane.test.tsx src/renderer/components/AgentNode.test.ts src/renderer/styles.test.ts` | exit 0; 3 files and 21 tests passed | `focused-tests.log` |
| Canvas TypeScript contracts compile | `pnpm typecheck` | exit 0; `tsc --noEmit` | `typecheck.log` |
| Repository lint, including changed canvas sources and tests | `pnpm lint` | exit 0; `eslint .` | `lint.log` |
| Packaged Electron application builds after the canvas change | `pnpm build` | exit 0; Linux x64 package completed | `build.log` |
| Changed files contain no whitespace errors | `git diff --check` | exit 0 and explicit PASS marker | `diff-check.log` |

## Additional verification

- Full suite invocation: `NODE_ENV=test pnpm test`. Observable: 619 of 620 tests passed; the sole failure is the existing MCP zero-argument-tool `structuredContent` expectation outside canvas ownership. Artifact: `full-tests.log`.
- Isolated failure reproduction: `NODE_ENV=test pnpm exec vitest run src/mcp/mcp.test.ts`. Observable: the same single failure, 24 of 25 tests passed. Artifact: `mcp-tests.log`.
- Electron visual driver invocation: `node .omo/evidence/graph-canvas-20260803/qa.mjs`. Observable: Playwright timed out after 180 seconds. Artifact: `electron-qa.log`. Per parent direction, no retry was made; integrated visual QA owns the capture.

## Fixture

`canvas-seed.json` is the deterministic graph and harness fixture prepared for the integrated Electron capture. The `user-data/` directory records the profile generated during the timed-out run.
