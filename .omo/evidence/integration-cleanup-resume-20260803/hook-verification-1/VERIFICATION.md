# Stop-hook verification 1

Verified commit: `0f0e08ed6422b20b426b7d43687d86abb0b042d1`

| Criterion | Command | Observable | Artifact |
| --- | --- | --- | --- |
| Commit and clean tracked tree before validation | `git rev-parse HEAD && git status --porcelain --untracked-files=no` | target SHA printed; no tracked status entries | `git-before.log` |
| Full tests | `pnpm rebuild better-sqlite3 && pnpm test` | exit 0; 37/37 files and 609/609 tests passed | `native-rebuild.log`, `test.log` |
| Typecheck | `pnpm typecheck` | exit 0; no diagnostics | `typecheck.log` |
| Lint | `pnpm lint` | exit 0; no diagnostics | `lint.log` |
| Package build | `pnpm build` | exit 0; Linux x64 package produced | `build.log` |
| Saved focused Electron diagnosis | extract `test.trace` and search launch/readiness actions | only `Launch electron` followed by 45-second timeout; no `firstWindow`, shell, or role action | `trace-audit.log` |
| Focused package fuse | `pnpm exec electron-fuses read --app out/Spire-linux-x64/spire` | `EnableNodeCliInspectArguments is Disabled` | `fuse-audit.log` |
| Developer native runtime restored | `pnpm rebuild better-sqlite3` and in-memory SQLite query | exit 0; `{ ok: 1 }` | `native-restore.log`, `native-smoke.log` |
| Final tracked state | `git status --porcelain --untracked-files=no && git log -1` | no tracked entries; target SHA remains HEAD | `git-after.log` |

Electron was not relaunched because the task explicitly allowed only one focused attempt. The saved trace directly establishes that the attempt never progressed beyond `electron.launch`; therefore it cannot support a product-readiness or selector failure claim. The package used for that attempt had inspection disabled because its manual build omitted `SPIRE_ALLOW_INSPECT=1`, while the repository's canonical E2E script includes that variable.
