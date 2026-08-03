# AGENTS.md

Spire is a Linux-first Electron desktop app that orchestrates coding agents (OpenCode,
Codex, Claude Code) as durable workflow graphs: saved graphs compile to execution plans,
agents run in isolated Git worktrees, plan patches are authority-checked, and everything
persists to SQLite. The app ships a stdio MCP sidecar exposing the whole control plane.

## Commands

```bash
pnpm install      # hoisted layout; approve native builds: electron, esbuild, better-sqlite3
pnpm start        # run the dev app (electron-forge start)
pnpm typecheck    # tsc --noEmit — run before trusting types
pnpm test         # vitest run (NODE_ENV=test set by the script)
pnpm test:watch   # vitest watch
pnpm test:e2e     # SPIRE_ALLOW_INSPECT=1 pnpm build && xvfb-run -a playwright test
pnpm lint         # eslint .
pnpm build        # electron-forge package -> unpacked app in out/ (does NOT need zip/dpkg)
pnpm make         # linux ZIP + .deb; requires host zip, dpkg, fakeroot
pnpm build:mcp    # vite build (vite.mcp.config.ts) -> self-contained mcp-dist/mcp.js
pnpm spire:mcp    # build:mcp then run the sidecar (slow; not for MCP-client startup)
```

Node >= 22 and pnpm 11 (see `engines`/`packageManager`). Only Linux is supported for
packaging (ZIP + deb). Install at least one harness CLI (`opencode`, `codex`, or `claude`)
for real execution; onboarding only probes them and never collects credentials.

## Testing quirks

- Unit tests are colocated next to source as `src/**/*.test.{ts,tsx}`.
- Vitest runs in a **node** environment by default. Renderer component tests opt into
  jsdom **per file** with a `// @vitest-environment jsdom` pragma — do not force a global
  jsdom environment.
- `pnpm test` runs on TS directly (no prior build needed).
- E2E (`e2e/`, Playwright + Electron) drives the **packaged** production build from
  `out/`, so it only works after `pnpm build`. The `test:e2e` script chains the build and
  runs under `xvfb-run -a` on Linux with `workers: 1`. It uses offline seeded fixtures
  (`e2e/seed.ts`) — the real OpenCode/Codex/Claude providers are intentionally NOT in the
  suite because they need paid credentials. `visual.spec.ts` has screenshot snapshots
  (`maxDiffPixelRatio: 0.01` in `playwright.config.ts`).

## Architecture / where to put code

```
src/main/        Electron main process
  database.ts            SpireDatabase (better-sqlite3); migrations in graph-migration.ts
  run-engine.ts          compile saved graph -> persisted execution plan
  scheduler/             GraphScheduler: ready-node selection, loops, checkpoints, recovery
  harness/               HarnessAdapter impls: opencode.ts, codex.ts, claude-code.ts
  control/               ControlSocketServer + capabilities (Uni socket control plane)
  worktree/, workspace/  isolated git worktrees, scope validation, merges
src/preload/          sandboxed preload bridge (typed, narrow IPC)
src/renderer/         React 19 UI (Zustand store, ReactFlow graph canvas, Radix primitives)
src/mcp/              stdio sidecar: plain Node process (NO Electron), connects to the app's socket
src/shared/           pure contract types + zod validators shared across processes
```

- **`src/shared/` is the cross-process contract** — `domain.ts` (`GraphDefinitionV2`),
  `execution.ts`, `harness.ts`, `workspace.ts`, `control.ts`, `collaboration.ts`, `trace.ts`.
  Changing these ripples into main, renderer, mcp, and e2e at once. Keep the DB/migration
  story in mind: legacy v1 graphs normalize to v2 (`graph-migration.ts`), and the
  workspace-layout persistence table must stay write-inert for data compatibility.
- **Saved graphs vs execution plans**: the scheduler mutates only the plan, never the
  source graph; plan promotion to a new graph version is an explicit auditable step.
- Path aliases: `@shared/*`, `@renderer/*`, `@main/*` (`tsconfig.json`; vite aliases
  `@shared`/`@renderer`).
- The MCP sidecar is built standalone with `ssr.noExternal` into `mcp-dist/mcp.js` (CJS,
  shebang). Details/changes belong with forge config if it needs correct behavior.

## Renderer / design contract

`DESIGN.md` is a hard visual contract. Follow it for any UI work:

- Dark charcoal surfaces; exactly two semantic accents: **blue** for selection/input,
  **orange** for execution/output. No glass, glow, gradient wash, or ornamental motion.
- 4px spacing base; fixed radii (4/6/8/10px); named elevation z-layers 0–50.
- Colors/geometry come from **CSS semantic tokens** and the typed `CanvasTokens`
  contract — do not introduce raw color/motion/radius literals in component rules.
- The renderer is a **fixed workspace shell** (rails + canvas + dock), not user-dockable
  panes. Legacy FlexLayout/layout-persistence modules may remain, but the active renderer
  must not import them.
- Motion: only color/bg/border tints (120ms) and overlay transform/opacity (180ms); honor
  `prefers-reduced-motion`.

## Constraints & gotchas

- Harness authentication is native-CLI-owned only; Spire stores no credentials. Nodes can
  only ever patch the plan within their declared `NodeAuthority` scope.
- **Spire never commits, merges, pushes, or edits the user's source checkout** — it always
  works from the committed `HEAD` of an isolated git worktree.
- The `site/` directory is an **isolated Astro workspace** with its own `pnpm-workspace.yaml`
  and pnpm version. Root `pnpm install` does NOT cover it; run `pnpm install && pnpm dev`
  inside `site/` to work on the website.
- No CI is configured; there is no `opencode.json`. `lint` → `typecheck` → `test` is the
  safe local gate. `.vite/`, `.worktrees/`, `mcp-dist/`, `out/`, `coverage/` are
  gitignored; `.omo/` tooling state is intentionally NOT committed.
- Any out-of-date notes in `docs/` (e.g. per-branch code-review docs) are historical — the
  repo config and `src/` are the source of truth.