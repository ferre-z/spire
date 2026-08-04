# Code review: backend contracts

Commit reviewed: `947f929b3f756f93fdbee683f2c54e2574867b8e`

## Scope and result

Reviewed the backend/shared/preload changes for the Fixed Premium Graph Workspace redesign, including their persistence and migration dependencies. The contract requirements are implemented: onboarding accepts a typed selection; the public/preload IPC no longer carries the API-key connection operation; onboarding probes and validates the selected adapter and live model list before marking completion; graph APIs expose V2 definitions and normalize legacy database rows; saves allocate `max(existing.version) + 1` and renew `createdAt`; workspace-layout persistence is untouched; no migration deletes or rewrites stored rows.

Skill-perspective check: **ran**. I consulted `omo:programming` (TypeScript rules) and `omo:remove-ai-slops` (overfit/slop test and production review). Production code does not violate either perspective in this scoped change. One test-quality finding below violates the remove-ai-slops perspective.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

1. **Removal-only assertion creates weak coverage.** [src/main/ipc.test.ts:350](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/main/ipc.test.ts:350) and [src/main/ipc.test.ts:351](/home/ferre/spire/.worktrees/fixed-premium-workspace/src/main/ipc.test.ts:351) assert only that a requested API surface was deleted (`IPC` lacks `connectOpenRouter` and its serialized constant does not mention an API key). This is not observable onboarding behavior and `JSON.stringify(IPC)` cannot establish that the public boundary never accepts credential-shaped payloads. Under the remove-ai-slops review pass, these are deletion-only/prompt-mirroring tests. Keep the behavior test for `completeOnboarding`; replace or omit these assertions in favor of contract/type-level coverage if the project requires an API-surface guard. This is MEDIUM because it adds false confidence but does not invalidate the implementation.

### LOW

None.

## Evidence

Commands run from `/home/ferre/spire/.worktrees/fixed-premium-workspace`:

```text
git show --no-ext-diff --format=fuller --find-renames --name-status 947f929
git show --no-ext-diff --format= --find-renames 947f929 --
rg -n -i 'connectOpenRouter|connect-openrouter|ProviderInput|api.?key|onboardingComplete|listGraphsV2|saveGraphV2|migrateLegacyGraph|workspace.?layout' src ...
git diff --check 947f929^ 947f929
pnpm exec vitest run src/shared/control.test.ts src/main/control/spire-control.test.ts src/main/ipc.test.ts src/main/database.test.ts src/main/graph-migration.test.ts
pnpm lint
pnpm typecheck
```

Results:

- `git diff --check`: pass.
- Focused Vitest suite: pass, 5 files / 169 tests.
- ESLint: pass, no findings.
- `pnpm typecheck`: exit 2 exclusively for the declared renderer-owned migration fallout: `Onboarding.tsx`, `GraphCanvasPane.test.tsx`, `GraphSettingsPane.tsx`, and `store.ts`. No reviewed backend/shared/preload file appears in the output.

## Recommendation

`codeQualityStatus: WATCH`

`recommendation: APPROVE`

`blockers: []`
