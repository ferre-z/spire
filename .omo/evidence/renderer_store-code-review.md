# Code review: renderer store (`173bcd4`)

## Scope and method

Reviewed commit `173bcd4dd69a7ae5d12f72a612bb9e527e995d7f` against the supplied renderer-store requirements. The ULW-loop status command reported `ULW_LOOP_PLAN_MISSING`, so this report uses the required fallback evidence location.

The `remove-ai-slops` and `programming` (including its TypeScript reference) skill perspectives were explicitly consulted. The new tests are behavioral rather than deletion-only, prompt-text, or implementation-constant tests. The production diff has no `any`, assertion, non-null assertion, or catch-and-swallow introduced. It does, however, add substantial runtime-loading orchestration to an already oversized store (780 pure LOC); this is a maintainability observation, not a blocking finding for this goal.

## CRITICAL

None.

## HIGH

1. The application’s actual run-selection path never calls `activateRun`, so switching a run in the UI leaves the old plan, node executions, messages, cursors, patches, and error in place instead of executing the specified clear-and-concurrently-load lifecycle. `activateRun` has no production caller; [RunHistoryPane.tsx:9](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/panes/RunHistoryPane.tsx:9) reads the legacy `selectRun`, and [RunHistoryPane.tsx:24](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/panes/RunHistoryPane.tsx:24) invokes it. That method merely assigns the id at [store.ts:487](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/store.ts:487), while the required lifecycle exists only in [store.ts:490](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/store.ts:490). The direct-store tests therefore give false confidence about the end-user run switch. This is an in-scope functional integration gap, distinct from the excluded backend API migration fallout.

## MEDIUM

1. The store is 780 pure LOC after this change, and this commit adds the new activation/request machinery into that same module ([store.ts:283](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/store.ts:283)-[store.ts:385](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/store.ts:385)). This violates the `remove-ai-slops` / `programming` size perspective and makes future concurrency changes harder to review. Extract the run-runtime loader/request-token responsibility into a focused module before the store grows further.

## LOW

1. `validationInput` manually mirrors every current V2 graph property solely to produce `Record<string, unknown>` ([store.ts:270](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/renderer/store.ts:270)). It is currently behaviorally equivalent, but it is unnecessary transformation of already typed store state and can silently omit later graph fields from validation while sending them to save. Prefer a typed validation API or a single schema-owned boundary conversion.

## Verification evidence

- `pnpm exec vitest run src/renderer/store.test.ts` — PASS (37 tests).
- `pnpm exec eslint src/renderer/store.ts src/renderer/store.test.ts` — PASS.
- `git diff 173bcd4^ 173bcd4 --check` — PASS.
- `pnpm typecheck` — FAILS in renderer files outside this commit’s changed files, including `App.tsx`, `Onboarding.tsx`, `GraphCanvasPane*`, `GraphSettingsPane.tsx`, and `RuntimePolicyPane.tsx`; this matches the explicitly excluded renderer UI/backend-migration fallout and is not separately ranked here.
- `pnpm test` — FAILS: 30 renderer-pane failures due to `act` not being a function plus one MCP snapshot-contract failure. These are outside the two changed files and not attributable to a changed-line failure in this commit, but mean repository-wide green evidence is absent.

## Conclusion

`codeQualityStatus`: BLOCK

`recommendation`: REQUEST_CHANGES

`blockers`: Wire the production run-selection action to the activation lifecycle (or make `selectRun` perform that lifecycle) and add a UI-facing regression test proving a real run switch clears and loads the new run state. No CRITICAL findings remain.
