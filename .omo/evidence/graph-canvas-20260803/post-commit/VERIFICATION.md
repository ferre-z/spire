# Post-commit verification

Verified commit: `6e9021905a3e2c1bd9a8bd6feeb52d01e234e0c4`.

| Scenario | Invocation | Observable | Evidence |
| --- | --- | --- | --- |
| Graph canvas behavior and styling contract | `NODE_ENV=test pnpm exec vitest run src/renderer/panes/GraphCanvasPane.test.tsx src/renderer/components/AgentNode.test.ts src/renderer/styles.test.ts` | Exit 0; 3 files passed; 21 tests passed | `focused-tests.log` |
| Type safety | `pnpm typecheck` | Exit 0; `tsc --noEmit` | `typecheck.log` |
| Repository lint | `pnpm lint` | Exit 0; `eslint .` | `lint.log` |
| Production Electron packaging | `pnpm build` | Exit 0; Linux x64 packaging completed | `build.log` |
| Exact commit identity | `git rev-parse HEAD` | Full SHA matches `6e90219` | `commit-sha.log` |
| Committed patch hygiene | `git show --check --oneline --stat HEAD` | Exit 0 plus explicit PASS marker | `commit-check.log` |

`git-status.log` records the post-commit worktree. It contains only untracked evidence owned by parallel tasks; no source changes remain unstaged.

Manual Electron visual capture is not claimed here. The single driver timeout is preserved one directory above in `electron-qa.log`, and the parent owns adjusted integrated visual QA.
