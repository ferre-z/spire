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
- Packaged Electron verification: first-run onboarding discovers deterministic
  CLI fixture adapters, selects a native harness/model pair, and enters Spire
  without rendering or transporting credentials.

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
- Packaged Electron verification: all 15 focused workspace and visual scenarios
  pass. Coverage includes credential-free onboarding, run activation, utility
  drawers, node editing and version save, canvas interactions, command and F6
  keyboard navigation, reduced motion, the window policy, and overflow checks
  at 800x600, 1024x700, 1440x900, and 1920x1080. Current screenshots cover
  onboarding, wide and compact shells, an active run, and the node dialog.

The former FlexLayout renderer and its dependency are removed. Existing
workspace-layout rows and their shared/main/preload/database persistence APIs
remain intact for compatibility, but the fixed renderer leaves those records
inert and does not delete or overwrite them.
