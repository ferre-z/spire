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
the graph, and keyboard/focus behavior is covered at component and packaged-app
levels.

- Implementation: `91bc784` (responsive dialog) and `41e9300` (integration
  hardening).
- Verification: `src/renderer/node-dialog/NodeDialog.test.tsx`,
  `src/renderer/node-dialog/selectors.test.ts`,
  `src/renderer/workspace/WorkspaceShell.test.tsx`, and
  `e2e/workspace.spec.ts`.

## 3. Grid/canvas and fixed workspace — resolved

The graph workspace now uses fixed activity, navigation, canvas, context,
utility, and 64px launch regions with responsive overlay breakpoints. The
canvas provides a dot grid, typed nodes/edges/groups, controls, minimap,
selection, dragging, keyboard traversal, and reduced-motion handling in the
premium charcoal surface with orange/blue accents.

- Implementation: `eed8f6c` (fixed workspace shell), `6e90219` (modern graph
  canvas), `42896b2` (group hardening), and `5ab0f31` (shared canvas metrics).
- Verification: renderer workspace/canvas component tests,
  `e2e/workspace.spec.ts` across 800×600, 1024×700, 1440×900, and 1920×1080,
  `e2e/visual.spec.ts`, plus full `pnpm test`, `pnpm typecheck`, `pnpm lint`, and
  `pnpm build`.

The former FlexLayout renderer and its dependency are removed. Existing
workspace-layout rows and their shared/main/preload/database persistence APIs
remain intact for compatibility, but the fixed renderer leaves those records
inert and does not delete or overwrite them.
