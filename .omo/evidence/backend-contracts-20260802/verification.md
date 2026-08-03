# Backend contract verification

Date: 2026-08-02

## Targeted behavior suite

- Scenario: v2-only renderer graph contracts, transparent legacy row normalization, highest-version increment with refreshed `createdAt`, selected-harness onboarding acceptance/rejection, no duplicate seed, no credential-bearing IPC, and v2 IPC/preload save flow.
- Invocation: `pnpm exec vitest run src/shared/control.test.ts src/main/control/spire-control.test.ts src/main/ipc.test.ts src/main/database.test.ts src/main/graph-migration.test.ts`
- Binary observable: exit code 0; 5 test files passed; 169 tests passed; 0 failed.

## Lint

- Scenario: repository lint after the backend/shared/preload edits.
- Invocation: `pnpm lint`
- Binary observable: exit code 0; ESLint emitted no findings.

## Typecheck handoff

- Scenario: full repository TypeScript compile after the public contract change.
- Invocation: `pnpm typecheck`
- Binary observable: exit code 2 only in renderer-owned consumers pending parallel migration: `src/renderer/components/Onboarding.tsx:36`, `src/renderer/panes/GraphCanvasPane.test.tsx:241`, `src/renderer/panes/GraphSettingsPane.tsx:14`, and `src/renderer/store.ts:311`. No backend/shared/preload error was reported.

## Static diff check

- Scenario: whitespace/error-marker validation of the owned patch.
- Invocation: `git diff --check`
- Binary observable: exit code 0; no findings.
