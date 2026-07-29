# Spire — Per-Branch Review: `ui-redesign` (2026-07-29)

Scope: read-only audit of the `ui-redesign` branch at `/home/ubuntu/spire`.
Companion document: `docs/code-review-2026-07-29.md` (cross-branch findings).

---

## 1. Branch state

```text
$ git branch -v
* ui-redesign 7c10ccf [ahead 0, behind 0] spire mvp v0.1
  main        7c10ccf spire mvp v0.1

$ git status --short
 M package.json
 M pnpm-lock.yaml

$ git diff main..ui-redesign -- ':!package.json' ':!pnpm-lock.yaml'
(empty)

$ git worktree list
/home/ubuntu/spire  7c10ccf [ui-redesign]
/tmp/spire-main     7c10ccf [main]
```

**Finding U-1 — `ui-redesign` is the same commit as `main`.** No commits
ahead, no commits behind, no merges. The branch name implies a redesign is
in flight; only a package manifest diff is in the working tree.

**Finding U-2 — The branch's `package.json` modification declares 6 new
dependencies but the source tree uses 0 of them.** See `git diff package.json`
below and the dependency-by-dependency analysis in §3.

---

## 2. The working-tree diff (verbatim)

```text
$ git diff package.json
@@ -16,6 +16,8 @@
   "author": "Spire contributors",
   "license": "MIT",
   "dependencies": {
+    "@fontsource-variable/inter": "^5",
+    "@fontsource-variable/jetbrains-mono": "^5",
     "@opencode-ai/sdk": "^1.0.0",
@@ -23,9 +25,10 @@
     "@radix-ui/react-tabs": "^1.1.13",
     "@xyflow/react": "^12.9.2",
     "better-sqlite3": "^12.4.1",
-    "classcat": "^5.0.5",
     "class-variance-authority": "^0.7.1",
+    "classcat": "^5.0.5",
     "clsx": "^2.1.1",
+    "flexlayout-react": "^0.8.0",
@@ -51,6 +54,7 @@
     "electron": "^38.3.0",
     "eslint": "^9.38.0",
     "eslint-plugin-react-hooks": "^7.0.0",
+    "playwright": "^1.62.0",
```

`pnpm-lock.yaml` was regenerated to match. Lockfile content was not
manually modified.

---

## 3. UI redesign plan — gap analysis

`docs/ui-redesign-plan.md` describes a FlexLayout-based IDE workspace.
This section checks every concrete deliverable in the plan against the
`ui-redesign` branch.

| Plan deliverable | Plan §  | Source-tree evidence | Verdict |
| --- | --- | --- | --- |
| `flexlayout-react 0.8.x` adopted | "Summary" | `package.json` adds `flexlayout-react@^0.8.0`; **no `import` in `src/`** (`grep -rn flexlayout src/` → 0 hits) | Declared, unused |
| Inter / JetBrains Mono variable fonts | "Design and Workspace Changes" | `package.json` adds both `@fontsource-variable/*` packages; **no `import` in `src/`** (`grep -rn @fontsource src/` → 0 hits); CSS uses the names directly (`src/renderer/styles.css:3,100,152,…`) but the font-face declarations are missing | Declared, unused; system fallback |
| Default desktop layout (10 panes) | "Design and Workspace Changes" | Current renderer uses a single fixed `<titlebar/> + <sidebar/> + <canvas-row/> + <run-composer/> + <run-panel/>` (`src/renderer/App.tsx:51-89`); no FlexLayout container; no pane registry | Missing |
| `F6` / `Shift+F6` / `Ctrl/Cmd+K` | "Design and Workspace Changes" | No keyboard handler in `App.tsx`; the visible `<Command>K` glyph (`App.tsx:60`) is decorative | Missing |
| Window min 800×600 with two persisted layouts | "Design and Workspace Changes" | `BrowserWindow minWidth: 1080, minHeight: 700` (`src/main/index.ts:21-22`); the only media query in CSS is `@media (max-width: 1250px)` (`src/renderer/styles.css:1631`) which just resizes the existing grid; no layout swap; no persisted compact mode | Missing |
| `workspace_layouts` SQLite table | "Persistence, Security, and Interfaces" | `src/main/database.ts:13-30` defines only `settings`, `graphs`, `runs` — no `workspace_layouts` | Missing |
| `WorkspaceLayoutMode`, `JsonValue`, `WorkspaceLayoutRecord` types | "Persistence, Security, and Interfaces" | None defined in `src/shared/domain.ts:1-173` | Missing |
| Preload API: `loadWorkspaceLayouts`, `saveWorkspaceLayout`, `resetWorkspaceLayouts`, `environment()` | "Persistence, Security, and Interfaces" | `src/shared/api.ts:11-25` defines 13 methods; **none of the four new ones exist** | Missing |
| Popout allowlist | "Persistence, Security, and Interfaces" | `src/main/index.ts:38` is a blanket deny `() => ({ action: "deny" })`; no allowlist | Missing |
| `popout.html` | "Persistence, Security, and Interfaces" | `find . -name 'popout*' -not -path '*/node_modules/*'` → empty | Missing |
| Schema validation, 512KB cap, 300ms debounce | "Persistence, Security, and Interfaces" | None | Missing |
| Reduced-motion handling | "Test Plan" / design | `@media (prefers-reduced-motion: reduce)` block exists at `src/renderer/styles.css:1645-1654`; honored | Present |
| UI test plan with Playwright | "Test Plan" | `package.json` adds `playwright@^1.62.0`; **no test file imports it** (`grep -rn playwright src/` → 0 hits) | Declared, unused |
| Default onboarding/workspace/active-run screenshots | "Test Plan" | None — there is no test directory under `src/renderer/` | Missing |
| Existing lint/typecheck/runtime/worktree/graph-engine tests unchanged | "Test Plan" | `pnpm typecheck` / `lint` / `test` all pass with 9 tests (see main report §2). | Present |

### 3.1 Concrete summary

| Plan deliverable bucket | Status |
| --- | --- |
| Dependency declarations | 5 of 5 declared, **0 of 5 imported** |
| Renderer layout | 0% — single fixed shell, no FlexLayout |
| Persistence schema | 0% — no `workspace_layouts` table, no shared types |
| Preload API extensions | 0 of 4 methods present |
| Window-open allowlist + `popout.html` | 0% |
| Keyboard shortcuts (`F6`, `Ctrl/Cmd+K`) | 0% |
| 800×600 minimum and compact mode | 0% — main window min is 1080×700 |
| Visual tokens (orange CTA) | 0% — `--violet` only; no `--orange` |
| Reduced-motion handling | 100% |
| Existing tests | 100% |

---

## 4. Dependency-by-dependency audit

The five new dependencies declared on `ui-redesign`:

### 4.1 `flexlayout-react@^0.8.0` — declared, never imported

```text
$ grep -rn "flexlayout" src/
(no matches)
```

The plan says the renderer is rebuilt with `flexlayout-react`. There is no
FlexLayout container, no `react-reflex` alternative, no `react-mosaic`. The
renderer is still a single fixed shell.

*Severity: medium — the headline change of the redesign is absent.*

### 4.2 `@fontsource-variable/inter@^5` — declared, never imported

```text
$ grep -rn "@fontsource" src/
(no matches)
```

`src/renderer/styles.css:3` declares
`font-family: "Inter", system-ui, sans-serif;` but the `@font-face` rules
that the `@fontsource-variable/inter` package would expose are not loaded
anywhere. The browser falls back to `system-ui`.

*Severity: low — visual polish, not correctness.*

### 4.3 `@fontsource-variable/jetbrains-mono@^5` — declared, never imported

Same as 4.2 — `"JetBrains Mono", monospace` is referenced at 9+ sites in
`styles.css` but no `@font-face` rules are wired.

### 4.4 `playwright@^1.62.0` — declared, never imported

```text
$ grep -rn "playwright" src/
(no matches)
```

The plan ("Test Plan") commits to running UI tests at four resolutions plus
onboarding/popout checks. None of this exists. The dependency is
added but the harness (`@playwright/test`, runner scripts, fixtures) is not.

*Severity: medium — test infrastructure absent.*

### 4.5 `class-variance-authority@^0.7.1` — already present

`class-variance-authority` was already at `^0.7.1` in `package.json`; the
diff just reorders it relative to `classcat`. There is still no
`import { cva } from "class-variance-authority"` in the codebase (verified
manually in §4 of the main report). The renderer uses `clsx` +
`tailwind-merge` only (`src/renderer/lib.ts:1-6`). `classcat` and `cva` are
both dead weight.

*Severity: low — bundle hygiene.*

---

## 5. Layout / runtime gap (specific)

The plan describes 10 panes:
1. Graph Library
2. Run History
3. Graph Canvas
4. Task Launcher
5. Graph Settings
6. Node Inspector
7. Runtime Policy
8. Live Stream
9. Diff
10. Result

The current code approximates 5 of them as fixed components:

| Plan pane | Current component | Closest file |
| --- | --- | --- |
| Graph Library | Sidebar GRAPHS list | `src/renderer/components/Sidebar.tsx:46-71` |
| Run History | Sidebar RECENT RUNS | `src/renderer/components/Sidebar.tsx:73-99` |
| Graph Canvas | `<GraphCanvas/>` | `src/renderer/components/GraphCanvas.tsx` |
| Task Launcher | `<RunComposer/>` | `src/renderer/components/RunComposer.tsx` |
| Graph Settings | `<Inspector/>` empty branch | `src/renderer/components/Inspector.tsx:43-89` |
| Node Inspector | `<Inspector/>` node branch | `src/renderer/components/Inspector.tsx:91-163` |
| Runtime Policy | `<Inspector/> permission-summary block` | `src/renderer/components/Inspector.tsx:138-152` |
| Live Stream | `<RunPanel/> tab=stream` | `src/renderer/components/RunPanel.tsx:96-135` |
| Diff | `<RunPanel/> tab=diff` | `src/renderer/components/RunPanel.tsx:137-152` |
| Result | `<RunPanel/> tab=result` | `src/renderer/components/RunPanel.tsx:154-198` |

So **all 10 panes exist logically** as fixed components, but the plan's
*dockability*, *tab-grouping*, *popout*, and *resizability* — the entire
point of the redesign — are not implemented.

---

## 6. Color/visual token gap (specific)

`docs/ui-redesign-plan.md` "Design and Workspace Changes":
> *"semantic tokens around deep charcoal backgrounds, graphite surfaces,
> translucent glass, restrained borders, light-blue selection/focus, and
> orange execution/CTA states."*

`src/renderer/styles.css:5-23` defines:

```css
:root {
  --bg: #080b12;
  --panel: #0c111b;
  --panel-2: #101724;
  --panel-3: #131b2a;
  --border: #202a3b;
  --border-soft: #182131;
  --text: #edf2fa;
  --text-2: #9aa7bd;
  --text-3: #67748a;
  --violet: #8b7cf6;        /* accent (violet, not blue) */
  --violet-2: #6558c9;
  --violet-soft: rgba(139, 124, 246, 0.12);
  --green: #32d296;
  --green-soft: rgba(50, 210, 150, 0.11);
  --red: #ff6b72;
  --amber: #eeb968;
}
```

**Finding U-3 — No orange token.** The plan says *"orange execution/CTA
states"*. The palette has only `--violet` (which is closer to a lavender
than to the plan's "light-blue selection/focus"). `--amber` (#eeb968) is
the closest orange-ish hue but is reserved for warnings and is not used
as an action color in `styles.css`. The current primary buttons use
`--violet` (e.g. `run-button`, `primary-button compact-button`).

*Severity: low — visual identity gap, not a blocker.*

---

## 7. Reduced-motion / accessibility delta

The plan commits to honoring `prefers-reduced-motion`. The current code
does so via `@media (prefers-reduced-motion: reduce)` at
`src/renderer/styles.css:1645-1654`. ✅

The plan's accessibility narrative ("contrast checks, reduced-motion
tests, overflow checks, keyboard navigation, command-menu alternatives")
is unverified by automated tests; see §4.4 above (`playwright` declared
but unused).

---

## 8. Persistence / security gap (specific to the redesign)

The plan introduces a `workspace_layouts` SQLite table; this requires
schema migration. The current `SpireDatabase` constructor
(`src/main/database.ts:13-30`) uses `CREATE TABLE IF NOT EXISTS` with **no
versioning**. If `workspace_layouts` is added naively, existing user
databases will simply lack the table and reads will throw.

A robust redesign will need:

1. A `schemaVersion` row in `settings`,
2. A migration runner that runs `ALTER TABLE` / `CREATE TABLE` as needed,
3. A clear fallback path when the row is missing (per plan: *"fall back to
   the appropriate default layout without blocking startup"*).

None of this is in place.

---

## 9. Recommended next steps for `ui-redesign`

1. **Commit or revert the dep diff.** Either commit the additions with a
   message describing what they enable, or revert them. Don't leave
   uncommitted dep-only WIP as a "branch" state.
2. **Decide the layout library.** `flexlayout-react@0.8.x` per plan, or
   something else. If `flexlayout-react`, land the import and the
   `Layout` container in `App.tsx`. The plan's pane registry should be
   one source of truth, not 10 ad-hoc `<section/>`s.
3. **Land the persistence schema.** `workspace_layouts` table; the
   four preload methods; the 512 KB cap and 300 ms debounce; a
   `schemaVersion` migration runner.
4. **Add the popout HTML + allowlist.** Replace the blanket `deny` in
   `src/main/index.ts:38` with a same-origin allowlist that only opens
   `popout.html` (which must exist). CSP in `index.html:8` needs a
   `frame-src` directive covering the popout.
5. **Tighten `connect-src`.** Drop the wildcard port; pin to the
   discovered port or use `connect-src` per-window after `webRequest`.
6. **Wire up the keyboard shortcuts.** `F6`/`Shift+F6` for pane
   cycling; `Ctrl/Cmd+K` for the layout command menu.
7. **Land the orange CTA token.** Add `--orange: #f59e0b` (or similar)
   and apply it to primary buttons and run-active states.
8. **Bump Electron to ≥39.8.5.** Closes the two runtime CVEs identified
   by `pnpm audit` (§2.1 of the main report).
9. **Land Playwright UI tests.** Even a smoke test (onboarding renders,
   default workspace renders, popout opens, F6 cycles) would meaningfully
   de-risk the redesign.
10. **Bump the in-source tests.** Add `AppService`, `database`,
    `ipc.ts`, `opencode.ts` coverage; add a redaction regex test for
    `run-engine.ts:381-388`.

---

## 10. Severity-ranked findings (ui-redesign only)

| # | Sev | Where | Finding |
| --- | --- | --- | --- |
| U-1 | process | `git:branch inventory` | `ui-redesign` is the same commit as `main`; the branch carries only an uncommitted dep diff. |
| U-2 | high | `package.json` + `src/` | 5 new deps declared (`flexlayout-react`, 2 font packages, `playwright`, `cva`); **0 imports** in source. |
| U-3 | medium | `src/renderer/styles.css:5-23` + plan §"Design" | No `--orange` token; primary CTA uses `--violet`. |
| U-4 | medium | `src/main/index.ts:38` + plan §"Persistence, Security, and Interfaces" | `setWindowOpenHandler` is blanket deny; no popout allowlist, no `popout.html`. |
| U-5 | medium | `src/main/database.ts:13-30` + plan §"Persistence, Security, and Interfaces" | No `workspace_layouts` table; no `schemaVersion` migration runner. |
| U-6 | medium | `src/shared/api.ts:11-25` + plan §"Persistence, Security, and Interfaces" | None of the four preload methods (`loadWorkspaceLayouts`, `saveWorkspaceLayout`, `resetWorkspaceLayouts`, `environment`) exist. |
| U-7 | medium | `src/renderer/App.tsx` + plan §"Design and Workspace Changes" | No FlexLayout container; the 10 panes are 10 fixed components, not dockable. |
| U-8 | medium | `src/main/index.ts:21-22` + plan §"Design and Workspace Changes" | Window min is 1080×700, not 800×600; no compact-layout persistence. |
| U-9 | low | `src/renderer/styles.css:1631` | Only one media query at 1250px; doesn't model the 1100px breakpoint or the compact mode. |
| U-10 | low | `src/renderer/styles.css:3,100,…` + `package.json` | Font packages declared; CSS uses `font-family: "Inter"` / `"JetBrains Mono"` strings but no `@font-face` declarations; browsers fall back to system fonts. |
| U-11 | low | `src/renderer/components/Sidebar.tsx:34-43` | Two nav buttons (`Graphs`, `Runs`) are visually present but only `Graphs` is wired; `Runs` has no `onClick`. |
| U-12 | low | `src/renderer/components/Sidebar.tsx:101-103` | Inert "Settings" button. |
| U-13 | low | `src/renderer/components/RunPanel.tsx:72-93` | `role="tablist"` without `role="tab"` / `aria-selected`. |
| U-14 | low | `App.tsx:60` | "⌘K" glyph is decorative; no keyboard handler. |
| U-15 | low | `src/renderer/App.tsx:51-89` | The visual titlebar shows `<GitBranch size={13}/>` and a status dot, but the menu items promised in the plan (View/command menu, pane reopen, dock/undock) do not exist. |
| U-16 | low | `eslint.config.mjs` | No `eslint-plugin-jsx-a11y`. |
| U-17 | low | `vitest.config.ts:5-9` | Coverage configured but `@vitest/coverage-v8` missing. |

---

## 11. Verbatim command outputs (this branch)

### 11.1 `git status`
```
 M package.json
 M pnpm-lock.yaml
```

### 11.2 `git diff --stat`
```
 package.json   | 8 ++++++++
 pnpm-lock.yaml | many lines
```

### 11.3 `pnpm test` (run on this branch, exit 0)
```
 ✓ src/main/run-engine.test.ts (2 tests) 173ms
 ✓ src/shared/domain.test.ts (3 tests) 10ms
 ✓ src/main/worktree.test.ts (1 test) 94ms
 ✓ src/main/prompts.test.ts (3 tests) 14ms

 Test Files  4 passed (4)
      Tests  9 passed (9)
```

### 11.4 `pnpm audit` (summary, exit 0)
```
20 vulnerabilities found
Severity: 3 low | 5 moderate | 11 high | 1 critical
```

### 11.5 `grep -rn "flexlayout" src/` → empty
### 11.6 `grep -rn "@fontsource" src/` → empty
### 11.7 `grep -rn "playwright" src/` → empty
### 11.8 `grep -rn "class-variance-authority" src/` → empty
### 11.9 `find . -name 'popout*' -not -path '*/node_modules/*'` → empty

---

*End of per-branch review.*
