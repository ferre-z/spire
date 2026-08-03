# Fixed workspace shell follow-up evidence

Commit candidate: `391c3da`

## Automated contract verification

- Scenario: semantic CSS tokens, current rail destination, drawer focus containment/restoration, command-menu focus containment/restoration, onboarding, and Run History activation.
  - Invocation: `NODE_ENV=test pnpm vitest run src/renderer/workspace/WorkspaceShell.test.tsx src/renderer/styles.test.ts src/renderer/components/Onboarding.test.tsx src/renderer/panes/RunHistoryPane.test.tsx`
  - Observable: 4 test files passed, 16 tests passed.
  - Artifact: `focused-tests.log` and `post-commit-focused-tests.log`.
- Scenario: repository lint.
  - Invocation: `pnpm lint`
  - Observable: exit 0 with no diagnostics.
  - Artifact: `lint.log` and `post-commit-lint.log`.
- Scenario: production Electron package and dev-diagnostic removal.
  - Invocation: `SPIRE_ALLOW_INSPECT=1 pnpm build`; `rg -n "Spire renderer" .vite/renderer`.
  - Observable: package exit 0; diagnostic search has no matches.
  - Artifact: `build.log` and `production-diagnostics.log`.
- Scenario: strict TypeScript baseline audit.
  - Invocation: `pnpm typecheck`.
  - Observable: no follow-up-file errors; the same 10 existing V1/V2 migration errors remain in GraphCanvasPane, GraphSettingsPane, and RuntimePolicyPane.
  - Artifact: `typecheck.log`.

## Packaged Electron verification

- Scenario: packaged binary at 1440x900, 1024x700, and 800x600; 1024 navigation/context overlays; 440px drawer; drawer and command-menu focus wrapping/restoration; `aria-current`; onboarding; console monitoring.
  - Invocation: `node .omo/evidence/fixed-workspace-shell-followup/qa.mjs` against `out/Spire-linux-x64/spire` with isolated `SPIRE_USER_DATA` and deterministic seeds.
  - Observable: every boolean in `manual-qa.json.checks` is `true`; all viewport overflow deltas are 0; console error list is empty.
  - Artifact: `electron-qa.log`, `manual-qa.json`, `workspace-1440.png`, `drawer-diff-1440.png`, `workspace-1024-navigation.png`, `workspace-1024-overlays.png`, `workspace-800.png`, and `onboarding-1024.png`.
- Scenario: direct visual inspection of all final captures.
  - Observable: shell regions remain legible and aligned; compact overlays stay within bounds; the drawer is visibly modal; onboarding shows three local harness rows with no credential-entry UI.
  - Artifact: the PNG files listed above.
