# Integration cleanup evidence

Commit: `0f0e08e` (`refactor: remove obsolete dockable workspace`)

## Success criteria

| Scenario | Invocation | Binary observable | Artifact |
| --- | --- | --- | --- |
| Full unit/component/integration suite | `pnpm rebuild better-sqlite3 && pnpm test` | exit 0; `37 passed (37)`, `609 passed (609)` | `native-rebuild.log`, `test-after-rebuild.log` |
| Strict TypeScript compilation | `pnpm typecheck` | exit 0; `tsc --noEmit` emitted no diagnostics | `typecheck.log` |
| Repository lint | `pnpm lint` | exit 0; `eslint .` emitted no diagnostics | `lint.log` |
| Production package | `pnpm build` | exit 0; Electron Forge packaged Linux x64 application | `final-build.log` |
| Native addon restored for developer Node runtime | `pnpm rebuild better-sqlite3` then an in-memory SQLite `select 1 as ok` | exit 0; `{ ok: 1 }` | `native-restore-after-build.log`, `native-smoke.log` |
| Atomic cleanup commit | `git show --stat --oneline --summary HEAD` | `0f0e08e`; 22 files, 340 insertions, 1753 deletions | `commit.log` |
| No remaining tracked edits | `git status --porcelain --untracked-files=no` | exit 0; no tracked paths printed | `tracked-status.log` |

## Focused Electron diagnosis

Scenario: fixed workspace at 800x600 on the existing X display.

Invocation:

```text
DISPLAY=:1 pnpm exec playwright test e2e/workspace.spec.ts \
  --grep "fits fixed regions at 800x600" --trace on --timeout 45000
```

Observable: exit 1 after 45 seconds. The trace contains one unresolved `Launch electron` call at `e2e/fixtures.ts:38`; it never reaches `firstWindow`, `.workspace-shell`, or any ARIA-role selector. `pnpm exec electron-fuses read --app out/Spire-linux-x64/spire` reports `EnableNodeCliInspectArguments is Disabled` because the focused package build omitted `SPIRE_ALLOW_INSPECT=1`. The canonical `test:e2e` script supplies that build variable but cannot run here because `xvfb-run` is unavailable. Per the one-focused-attempt constraint, Electron was not retried.

Artifacts: `focused-e2e.log`, `focused-trace.zip`, `focused-error-context.md`, and `fuse-state.log`.

## Scope notes

- The obsolete FlexLayout renderer modules, popout E2E, CSS import, package dependency, and lockfile entries are removed.
- E2E seeds/specs now exercise graph-v2 and fixed-workspace contracts.
- Existing shared/main/preload/database workspace-layout persistence APIs remain intact for data compatibility.
- Pre-existing legacy CSS and historical documentation references were outside the assigned tracked-file scope and were not changed.
