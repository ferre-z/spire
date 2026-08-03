# Resolved interface issues

## 1. Harness models — resolved

Spire does not collect API keys or native CLI credentials. OpenCode, Codex, and
Claude Code retain their own authentication, while onboarding and node settings
use the harness `probe` and `listModels` contracts to display only runtime/model
availability.

- Implementation: `947f929` (onboarding and graph contracts), `0ed238b`
  (normalized harness registry), and `387edc5` (Codex/Claude adapters).
- Verification: `src/renderer/components/Onboarding.test.tsx`,
  `src/renderer/panes/HarnessesPane.test.tsx`, renderer store harness/model
  contract tests, plus full `pnpm test`, `pnpm typecheck`, and `pnpm build`.
- Electron limitation: first-run E2E performs the real packaged runtime probe;
  no test-only credential or fake external CLI is injected. Component/contract
  tests provide deterministic discovery/model coverage without credentials.

## 2. Node settings — resolved

Selecting a canvas node opens a responsive modal with input, settings, and
output regions. Edits remain live across close/reopen, Save version persists
the graph, and keyboard/focus behavior is covered by component contracts.

- Implementation: `91bc784` (responsive dialog) and `41e9300` (integration
  hardening).
- Verification: `src/renderer/node-dialog/NodeDialog.test.tsx`,
  `src/renderer/node-dialog/selectors.test.ts`,
  `src/renderer/workspace/WorkspaceShell.test.tsx`, plus full `pnpm test`,
  `pnpm typecheck`, `pnpm lint`, and `pnpm build`.

## 3. Grid/canvas and fixed workspace — resolved

The graph workspace now uses fixed activity, navigation, canvas, context,
utility, and 64px launch regions with responsive overlay breakpoints. The
canvas provides a dot grid, typed nodes/edges/groups, controls, minimap,
selection, dragging, keyboard traversal, and reduced-motion handling in the
premium charcoal surface with orange/blue accents.

- Implementation: `eed8f6c` (fixed workspace shell), `6e90219` (modern graph
  canvas), `42896b2` (group hardening), and `5ab0f31` (shared canvas metrics).
- Verification: renderer workspace/canvas component and contract tests, plus
  full `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`.
- Electron E2E status at cleanup commit `0f0e08e`: pending. The focused run
  used a package built without `SPIRE_ALLOW_INSPECT=1`, so Playwright timed out
  inside `electron.launch` before app readiness or role selectors were reached.
  The migrated `e2e/workspace.spec.ts` and `e2e/visual.spec.ts` scenarios were
  not claimed as passing at that commit.

The former FlexLayout renderer and its dependency are removed. Existing
workspace-layout rows and their shared/main/preload/database persistence APIs
remain intact for compatibility, but the fixed renderer leaves those records
inert and does not delete or overwrite them.
