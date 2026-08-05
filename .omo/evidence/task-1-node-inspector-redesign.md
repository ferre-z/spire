# Task 1 Evidence — node-inspector-redesign

**Task:** Extend agent/decision node schema with 5 persisted fields (thinkingEffort, skills, goal, subGoals, integrations) + nodeIntegrationSchema/NodeIntegration/ThinkingEffort exports + tests.

**Branch:** `feat/node-inspector-redesign` (worktree `/home/ferre/spire/.worktrees/node-inspector`)

## Changes

- `src/shared/domain.ts` (+14): added `nodeIntegrationSchema`, `NodeIntegration`, `ThinkingEffort` exports; added 5 lines to `agentLikeShape` after `maxVisits` (all `.default(...)`, no `.optional()`).
- `src/shared/domain.test.ts` (+107): 4 new test groups — defaults-when-absent, explicit round-trip, nodeIntegrationSchema validation (empty name / unknown type), checkpoint+subgraph unaffected.
- `src/main/graph-migration.test.ts`: **no change needed** — `v2 = migrateLegacyGraph(...)` is a fully-parsed object (defaults already filled), so the strict round-trip at line 201 passes as-is.

## Happy-path verification

```bash
$ pnpm test -- src/shared/domain.test.ts src/main/graph-migration.test.ts
Test Files  37 passed (37)
     Tests  619 passed (619)   # baseline 614 + 5 new

$ pnpm typecheck
$ tsc --noEmit
TYPECHECK_EXIT=0

$ pnpm lint
$ eslint .
LINT_EXIT=0
```

## Failure-probe QA (proves the new tests bite)

Temporarily commented out `goal: z.string().default(''),` in `agentLikeShape`, then:

```bash
$ pnpm exec vitest run src/shared/domain.test.ts
❯ src/shared/domain.test.ts (23 tests | 2 failed)
  × agent node new fields > applies defaults when the new fields are absent
  × agent node new fields > round-trips explicit values
Test Files  1 failed (1)
     Tests  2 failed | 21 passed (23)
```

Restored the line, re-ran:

```bash
$ pnpm exec vitest run src/shared/domain.test.ts
Test Files  1 passed (1)
     Tests  23 passed (23)
```

**Verdict:** PASS — happy path green; failure-probe confirms the new tests fail when a default is removed and pass once restored.

## Commit

`feat(shared): add thinking-effort, skills, goal, sub-goals and integrations to agent nodes`