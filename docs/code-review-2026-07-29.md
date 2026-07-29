# Spire — Exhaustive Code Review (2026-07-29)

Scope: read-only audit of `/home/ubuntu/spire` covering both local branches.
Reviewer posture: critical, factual, file:line-cited. No source modifications were
made; the only writes from this session are the two `.md` files under `docs/`.

---

## 0. Environment snapshot (recorded verbatim)

```text
$ node --version
v22.23.1
$ pnpm --version
9.15.0
$ uname -a
Linux 6.17.0-1011-oracle
$ cat /etc/os-release (head)
PRETTY_NAME="Ubuntu 24.04.4 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.4 LTS (Noble Numbat)"
```

`package.json` declares `"engines": { "node": ">=22" }` and
`"packageManager": "pnpm@11.9.0"`. The host actually has pnpm 9.15.0, not 11 —
`pnpm install --frozen-lockfile` still succeeded because pnpm 9/11 share the
lockfile schema, but the repository is misaligned with its declared package
manager. See **§3 (Tooling)**.

---

## 1. Branch inventory and divergence

```text
$ git branch --format='%(refname:short) %(objectname:short) %(committerdate:short)'
main          7c10ccf 2026-07-28
ui-redesign   7c10ccf 2026-07-28

$ git log --all --pretty=format:'%h %ad %s' --date=iso
7c10ccf 2026-07-28 23:56:41 +0200 spire mvp v0.1
20a727b 2026-07-27 14:30:28 +0200 Initial commit

$ git log --oneline main..ui-redesign        # (empty)
$ git log --oneline ui-redesign..main        # (empty)

$ git worktree list
/home/ubuntu/spire  7c10ccf [ui-redesign]
/tmp/spire-main     7c10ccf [main]

$ git diff main..ui-redesign -- ':!package.json' ':!pnpm-lock.yaml'
(empty)

$ diff -r --brief --exclude=node_modules --exclude=.git \
       --exclude=.vite --exclude=out --exclude=coverage \
       /tmp/spire-main /home/ubuntu/spire
Files /tmp/spire-main/package.json      and /home/ubuntu/spire/package.json      differ
Files /tmp/spire-main/pnpm-lock.yaml    and /home/ubuntu/spire/pnpm-lock.yaml    differ
```

**Finding 1.1 — `main` and `ui-redesign` are the same commit.**
Both branches point at `7c10ccf spire mvp v0.1` with **zero commits diverging in
either direction**. The only differences on disk are two uncommitted modifications
to `package.json` and `pnpm-lock.yaml` in the working tree of `ui-redesign`
(see **Finding 1.2**). The branch name implies meaningful redesign work, but at
the tracked-tree level there is none.

*Severity: process / hygiene. Severity escalates if you read the
`docs/ui-redesign-plan.md` and the modified `package.json` together — see
the per-branch report.*

*Fix:* either commit the design-system dependency additions to `ui-redesign` or
revert them. A branch with only uncommitted additions is a *suggestion*, not a
redesign.

**Finding 1.2 — Uncommitted working-tree changes on `ui-redesign`.**
```text
$ git status --short
 M package.json
 M pnpm-lock.yaml
```
`git diff package.json` (relevant hunks):
```text
@@ -16,6 +16,8 @@
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
These additions correspond to the dependency manifest promised by
`docs/ui-redesign-plan.md` (`flexlayout-react 0.8.x`, the two font packages,
and `playwright` for the UI-test plan). They are present but the actual code
that consumes them is not.

---

## 2. Tooling runs on the current branch (`ui-redesign`)

All commands run from `/home/ubuntu/spire`. Exit codes captured below.

| Command | Exit | Trimmed output (tail) |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | `Lockfile is up to date, resolution step is skipped` / `Already up to date` / `Done in 1.3s` |
| `pnpm typecheck` (`tsc --noEmit`) | 0 | (no diagnostics) |
| `pnpm lint` (`eslint .`) | 0 | (no diagnostics) |
| `pnpm test` (`vitest run`) | 0 | 4 files, 9 tests passed (run-engine 2, domain 3, worktree 1, prompts 3) |
| `pnpm audit` | 0 | **20 vulnerabilities found. Severity: 3 low · 5 moderate · 11 high · 1 critical** |
| `npx vitest run --coverage` | non-zero | `MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'` |

### 2.1 Typecheck / lint / test
Clean. Nothing to flag in the current source on either dimension at the
default config. (`eslint.config.mjs` enables only `@eslint/js` recommended +
`typescript-eslint/recommended` + `react-hooks`; see **§7.6 A11y** for the
absence of an a11y plugin.)

### 2.2 `pnpm audit` — supply-chain findings (Material)

Audit exited 0 (informational), but reports 20 known vulnerabilities across
the dependency closure. Highlights from the verbatim report:

- **critical — `node-tar` ≤7.5.18** Decompression/parse DoS via unlimited
  input. Hit through **117 paths**, all under
  `@electron-forge/cli > @electron-forge/core > @electron/rebuild >
  make-fetch-happen > cacache > tar@6.2.1` and adjacent toolchain chains.
- **high (×2)** `node-tar` arbitrary file overwrite via hardlink path
  traversal and symlink poisoning through `insufficient path sanitization`.
- **low — Electron** Use-after-free in offscreen shared texture release
  callback, and a clipboard `readImage` crash on malformed clipboard data.
  Versions `<39.8.5` are vulnerable; the project pins `electron@^38.3.0`
  (resolved to `38.8.6`).
- **moderate** `@inquirer/prompts > external-editor > tmp@0.0.33`
  (prototype pollution / arbitrary file write) reachable through
  `@electron-forge/cli > @listr2/prompt-adapter-inquirer`.

These are mostly *dev-time* or *Forge-installer* CVEs that don't ship in the
packaged app (Electron's `asar` packager excludes `node_modules` from the
artifact — see `forge.config.ts:11-23`), but the **runtime Electron CVE
remains** because Spire ships Electron 38.8.6, not ≥39.8.5.

*Severity: medium (runtime Electron CVE on shipped binary), low
(installer-only tar CVE). Fix:* bump Electron to ≥39.8.5. Patch tar via
`pnpm.overrides` if Forge pins it.

### 2.3 Coverage tooling not wired up
`vitest.config.ts:5-9` declares `coverage: { reporter: ['text', 'html'] }`
but `@vitest/coverage-v8` is not in `devDependencies`. `pnpm test --coverage`
fails, and a bare `npx vitest run --coverage` errors with
`MISSING DEPENDENCY`. Coverage is *promised by config but never executed*.

---

## 3. Security review (selected, with file:line citations)

### 3.1 Renderer sandbox posture — strong, but with one stretchable gap

- `src/main/index.ts:30-35` sets
  `contextIsolation: true, nodeIntegration: false, sandbox: true` on the
  `BrowserWindow` `webPreferences` — best practice.
- `src/main/index.ts:38-39` denies `setWindowOpenHandler` and blocks
  `will-navigate`. The plan (`docs/ui-redesign-plan.md:88-92`) requires
  replacing the blanket deny with a same-origin allowlist for `popout.html`;
  no `popout.html` exists and no allowlist exists yet (see
  `code-review-2026-07-29-branch-ui-redesign.md`).
- `forge.config.ts:51-63` flips the relevant Fuses:
  `RunAsNode=false`, `EnableNodeOptionsEnvironmentVariable=false`,
  `EnableNodeCliInspectArguments=false`,
  `EnableEmbeddedAsarIntegrityValidation=true`, `OnlyLoadAppFromAsar=true`.
  Good. `EnableCookieEncryption` is enabled but no `electron-session` cookies
  are set in source — harmless future-proofing.
- `src/preload/index.ts:36` exposes `window.spire` via `contextBridge`. No
  surface that takes raw `Function`, `Buffer`, or `Object.prototype`
  primitives. All bridges are narrow.
- CSP in `index.html:7-8`:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; connect-src 'self' http://127.0.0.1:*`.
  `connect-src` deliberately permits `http://127.0.0.1:*` to reach the
  in-process OpenCode server. **Concern:** the wildcard port range means *any*
  process listening on `127.0.0.1` can be reached by a compromised renderer.
  See **Finding 3.2**.

### 3.2 `connect-src 'self' http://127.0.0.1:*'` is broader than necessary

`index.html:8` permits the renderer to fetch any HTTP port on `127.0.0.1`.
The OpenCode server binds to `127.0.0.1` with `--port=0` (kernel-assigned,
see `src/main/opencode.ts:185`), and the URL is discovered via stdout
parsing (`src/main/opencode.ts:214-225`). The renderer code (`src/main/opencode.ts:102-105`,
`src/main/opencode.ts:248-253`) only sends Bearer-equivalent basic-auth to the
captured URL, but if a malicious SVG, font, or XHR ever reached `connect-src`,
nothing restricts it to the discovered port. Tightening to a sentinel URL
re-bound after discovery or pinning to a known random port would be safer.

*Severity: low (renderer is sandboxed and origin-locked), but the plan's
popout changes widen the surface.*

### 3.3 OpenRouter API key handling — adequate, but worth tightening

- `src/main/app-service.ts:48-50` calls
  `this.harness.connectOpenRouter(input.apiKey.trim())` and never stores the
  key in the DB or settings. The `ProviderInput` is not persisted.
- `src/main/opencode.ts:78-83` posts the key directly to OpenCode's local
  auth endpoint via the SDK; it is held only in the `OpenCodeHarness` instance
  (`apiKey` is a function parameter, not a class field — good).
- `src/renderer/components/Onboarding.tsx:101-107` uses `<input type="password"
  autoComplete="off" />`. After `connect()` succeeds the local state is wiped
  (`setApiKey("")` on `Onboarding.tsx:38`).
- `src/main/run-engine.ts:381-388` redacts any payload field whose key matches
  `/key|token|authorization|secret|password/i` before emitting events. Good.
  *Concern:* the regex is case-insensitive but **does not redact values whose
  keys are nested**, e.g. `{ openRouter: { key: "..." } }` is not redacted
  because the parent key is `openRouter`. Acceptable given the structured
  payloads are produced by OpenCode and are unlikely to embed credentials, but
  worth a note.

*Severity: low. The key never reaches SQLite (only `onboardingComplete=true`
is persisted, see `src/main/app-service.ts:59`).*

### 3.4 IPC handler hygiene

`src/main/ipc.ts:13-75` registers handlers for the channels enumerated in
`src/shared/api.ts:27-41`. Two observations:

- `IPC.openExternal` (`src/main/ipc.ts:46-52`) parses the target with
  `new URL(target)` and rejects anything not equal to `https://opencode.ai`.
  This is a **strict host allowlist** (good). It does **not** allow a path,
  so `https://opencode.ai/install` is implicitly allowed because URL parsing
  doesn't compare paths. Acceptable.
- `IPC.revealPath` (`src/main/ipc.ts:53-56`) passes a renderer-controlled
  string straight to `shell.openPath`. The renderer should only ever pass
  paths previously returned by `IPC.exportPatch` or the worktree artifacts,
  but there is no allowlist or `path.resolve` check. A compromised renderer
  could call `revealPath("/etc/passwd")` and trigger the file manager to
  open that directory. *Severity: low* — `shell.openPath` only opens the
  directory, not the file — but the surface is unfiltered.
- `IPC.exportPatch` (`src/main/ipc.ts:57-72`) writes `run.artifacts.diff`
  (already produced by us from `git diff`) to a user-chosen path via the
  system Save dialog. The patch content is *not* sanitized — it contains
  user-file diffs. The path is from the Save dialog. Acceptable.
- No `webContents.send` channels other than `spire:run-event`
  (`src/main/ipc.ts:78-84`). Good — no surface for renderer-side replay.

### 3.5 Shell-out hygiene

`src/main/opencode.ts:53-56` uses `promisify(execFile)` with an array arg
(no shell interpolation) for `which opencode` and `opencode --version`. The
binary path returned by `which` is `access()`-checked before being executed
(`opencode.ts:55`). Good.

`src/main/worktree.ts:31-90` invokes `git` via `execFile` with hardcoded
subcommands and arguments — no user-controlled strings are spliced. The
`runId` is sanitized at `src/main/worktree.ts:37`
(`runId.replace(/[^a-zA-Z0-9]/g, "")`). Good.

`src/main/opencode.ts:181-205` spawns `opencode serve` with `--port=0`,
`--hostname=127.0.0.1`, and `OPENCODE_SERVER_PASSWORD` set in `env`. The
binary path comes from `which` (see above). However, the **rest of
`process.env` is inherited via `...process.env`** (`opencode.ts:188`). That
includes any `OPENCODE_*` or `OPENROUTER_*` overrides the user happens to
have, which could silently redirect OpenCode to a remote server or alter
permission defaults. Pinning `env` to a whitelist would be safer.

*Severity: low (user-process trust).*

### 3.6 Worktree path traversal — `LocalWorktreeBackend.assertManaged`

`src/main/worktree.ts:100-108` rejects paths that escape `this.root` via
`path.relative`. The check is correct for normal paths, but
`relative.length === 0` rejects the root itself — fine, but `cleanup` for the
root path will throw, leaving stale worktrees. Acceptable trade-off.

The `prepare()` step (`worktree.ts:39`) builds
`workspacePath = path.join(this.root, shortId)` where `shortId` is the
sanitized run-id (10 alphanumerics). Safe.

### 3.7 Persistent secrets in SQLite — none found

`src/main/database.ts:13-30` declares `settings`, `graphs`, `runs`. Only
`onboardingComplete=true` is written to `settings`. Graphs and runs are JSON
snapshots that mirror `domain.ts` shapes (no key fields in the schemas).
Verified by reading every Zod schema (`src/shared/domain.ts:6-118`).

---

## 4. IPC review

13 channels across `src/shared/api.ts:27-41`. All `ipcMain.handle` calls in
`src/main/ipc.ts:17-75`. Each handler either:
- Delegates to a typed `AppService` method (good for testability),
- Or performs a narrow OS action (`dialog.showOpenDialog`, `shell.openPath`,
  `shell.openExternal`, `writeFile`).

Channel → handler mapping:

| Channel | Handler (file:line) | Notes |
| --- | --- | --- |
| `spire:snapshot` | `ipc.ts:17` | Pure read |
| `spire:detect-opencode` | `ipc.ts:18` | Spawns `which opencode`; safe |
| `spire:connect-openrouter` | `ipc.ts:19-22` | Forwards `ProviderInput`; not persisted |
| `spire:choose-repository` | `ipc.ts:23-33` | Native open-dir dialog; renderer gets the chosen path |
| `spire:save-graph` | `ipc.ts:34-36` | `graphDefinitionSchema.parse` enforced in service |
| `spire:start-run` | `ipc.ts:37-39` | Engine validates via schema; rejects if goal empty |
| `spire:stop-run` | `ipc.ts:40-42` | Engine stops + aborts OpenCode session |
| `spire:retry-run` | `ipc.ts:43-45` | Engine rejects if another run is active |
| `spire:open-external` | `ipc.ts:46-52` | URL host-allowlist to `opencode.ai` |
| `spire:reveal-path` | `ipc.ts:53-56` | Unfiltered `shell.openPath` (see 3.4) |
| `spire:export-patch` | `ipc.ts:57-72` | Save-dialog + write patch |
| `spire:cleanup-worktree` | `ipc.ts:73-75` | `ExecutionBackend.cleanup` |
| `spire:run-event` (push) | `ipc.ts:78-84` | One-way main→renderer |

The renderer-side bridge is `src/preload/index.ts:10-36`. It exposes
`window.spire` with thirteen typed methods and an `onRunEvent(listener)` that
returns an unsubscribe. No `removeAllListeners` is exposed — good.

**Finding 4.1 — `IPC.snapshot` does not surface the active run's `startedAt`
or `artifacts` while in flight.** Wait — actually it does (it returns the full
`AppSnapshot`). However, *live updates* rely on `spire:run-event` push plus
`receiveEvent` (`src/renderer/store.ts:67-69`) which simply calls
`refresh()` (full snapshot pull). That works, but a single SSE event triggers a
full DB read+IPC round-trip. Acceptable at MVP scale.

**Finding 4.2 — `IPC.stopRun` does not await the harness abort result**.
`src/main/run-engine.ts:92-94` does
`await this.harness.abort(...).catch(() => undefined)`. Good — the catch
prevents a stuck OpenCode session from blocking stop. The OpenCode `abort`
RPC could hang; there's no timeout on `abort()` — see **§5.2**.

**Finding 4.3 — `IPC.startRun` does not check `engine.activeId` before
scheduling.** `src/main/app-service.ts:82-88` calls
`this.engine.start(...)`; the engine itself guards with
`if (this.activeRunId) throw new Error("Only one run can be active.")`
(`run-engine.ts:65`). Good.

---

## 5. Architecture & runtime correctness

### 5.1 Engine loop — `src/main/run-engine.ts:171-246`

The orchestration matches the README contract:

1. Planner produces `TaskBrief` (`run-engine.ts:181-191`).
2. Loop:
   - Implementer produces `ImplementationReport` (`run-engine.ts:199-207`).
   - `backend.inspect` snapshots the diff and changed files
     (`run-engine.ts:209-212`).
   - Planner reviews → `ReviewVerdict` (`run-engine.ts:214-222`).
   - Accepted → exit; needs_changes → loop with `feedback = verdict.feedback`.
3. `maxIterations` cap terminates with `needs_attention`.

*Concern:* the engine does **not** early-exit if the implementer's diff is
empty — i.e. the planner will be asked to review nothing. This is a semantic
bug, not a crash: `run-engine.ts:209-212` overwrites `artifacts.diff` with
`""`, the planner sees `(No tracked diff was produced.)`
(`prompts.ts:85`), and loops back. With an honest agent that may consume
iterations until `maxIterations`. *Severity: low — a quality concern, not
correctness.*

*Concern:* in `run-engine.ts:230` the loop terminates with `succeeded` only
on `accepted`. If `runGraph` throws after the first iteration, `fail()`
catches and marks `failed`. If the planner returns a non-JSON response, the
`structuredPrompt` (lines 248-277) attempts one repair; if that also fails
to parse, `parseJson` rethrows and `fail()` catches. So a permanent parser
break leaves the run `failed` with the parse error message. Acceptable.

### 5.2 Concurrency / lifecycle

- `engine.activeRunId` is the single-active-run guard (`run-engine.ts:65, 99,
  103, 120`). Strings only, no async race condition because the constructor
  reads `database.listRuns()` once (`run-engine.ts:45-57`) and the engine is
  the only writer of `activeRunId`.
- `OpenCodeHarness.server` is a single `ChildProcess` per process. The class
  doesn't restart the server if it dies — `close()` sets fields to
  `undefined` but doesn't try again. If the server crashes mid-run, the next
  `prompt()` call will re-enter `ensureClient()` (line 173) and detect a
  fresh binary, but the crash detection relies on `server.once('exit', ...)`
  (line 226) which only fires during startup. After that, a silently dead
  server will hang every subsequent RPC. *Severity: medium.*
- `run-engine.ts:82-84` uses `void this.execute(...).finally(...)`. The
  `finally` runs on the next microtask but does not observe rejection. If
  `execute()` rejects *and* the engine is reset before the finally fires,
  `activeRunId` may clear on a different run. The current code only runs
  the finally on the run that was started (`if (this.activeRunId === id)`),
  so this is safe today, but it's a footgun for future contributors.
- `src/main/index.ts:78-81` registers `before-quit` to close the harness and
  DB. Order matters: harness first, then DB. OK.

### 5.3 Persistence

`src/main/database.ts` uses `better-sqlite3` with WAL. Prepared statements
are cached per call (good); transactions are implicit per statement.
There's no `BEGIN/COMMIT` block across `saveGraph` + `saveRun` in
`run-engine.ts:78-79`, but they are independent rows.

`src/main/database.ts:31` has no migration runner. If schema ever changes,
existing user databases break on first open (no `ALTER TABLE`). The README
claims persistent history; that is true for the current schema only.

`src/main/database.ts:30` — runs table has no index on `updated_at`; the
`ORDER BY updated_at DESC` will full-scan. Acceptable at MVP scale (≤
hundreds of runs).

*Finding 5.1 — Setting `onboardingComplete` is not idempotent against a stale
DB.* `src/main/app-service.ts:59` writes `"true"`. If the OpenRouter
auth fails after the call but before the snapshot is returned, the user is
shown connected but `onboardingComplete=true` is already set. The next
launch skips onboarding and the user must manually clear settings.

### 5.4 `OpenCodeHarness` — observation

- Server URL discovery is regex-based on stdout (`opencode.ts:215-221`). The
  regex `opencode server listening.*?(https?:\/\/[^\s]+)` accepts the first
  match it sees, but `https?:` would also match `http://`, even though the
  server is started with `--hostname=127.0.0.1` which should be HTTP. No
  harm, but `https?` should be `http`.
- `forwardEvents` (`opencode.ts:256-274`) silently swallows all errors in
  the SSE stream (`} catch { ... }`). The comment is correct that the
  prompt response is authoritative, but a malformed OpenCode event payload
  will be dropped without trace.
- `forwardEvents` filters events by `serialized.includes(sessionId)` — i.e.
  string-match on the JSON. A session id that happens to be a substring of
  another session's event (UUIDs make this astronomically unlikely) would
  leak. *Severity: theoretical.*

### 5.5 The default graph

`src/main/app-service.ts:116-170` builds a hard-coded two-node default
graph at first connect. The README also says "1-5 pass limit"; the
default is `maxIterations: 3`. Default planner instructions are 169
characters, well under the 12,000 cap. Good.

---

## 6. Testing

### 6.1 Inventory
- `src/shared/domain.test.ts` (3 tests): schema accept, role uniqueness, edge
  integrity.
- `src/main/prompts.test.ts` (3 tests): JSON parse, markdown fence repair,
  missing-field rejection.
- `src/main/run-engine.test.ts` (2 tests): successful two-pass run; cap
  terminates at `maxIterations=1`.
- `src/main/worktree.test.ts` (1 test): real `git worktree add`, diff
  inspection, cleanup.

### 6.2 Coverage gaps

- `AppService` is **not unit-tested**. Default-graph logic, saveGraph
  version-bump (`app-service.ts:67-80`), goal-trim, worktree cleanup are all
  untested. `app-service.ts` is the largest un-tested surface in the
  repository.
- `database.ts` is **not unit-tested**. The PRAGMA / schema migrations
  are untested. The risk is small because we never alter schema.
- `ipc.ts` is **not unit-tested**. Handlers are thin wrappers; the value of
  a unit test is low, but the `openExternal` allowlist
  (`opencode.ai` only) deserves an automated test.
- `opencode.ts` is **not unit-tested** — only `FakeHarness` exists
  (`run-engine.test.ts:15-41`). The URL discovery regex and the
  `forwardEvents` substring filter are untested.
- `worktree.ts` `inspect()` is exercised end-to-end (one test). The 20 MB
  `maxBuffer` constant is untested.
- No tests assert the **redaction regex** in `run-engine.ts:381-388`. Add
  one.

### 6.3 Test infrastructure

`vitest.config.ts:5-9` uses `environment: 'node'` and
`include: ['src/**/*.test.ts']`. The `tsx` extension is **not** in the
include list — there are no `.test.tsx` files, but if any renderer tests are
added in the redesign, this needs updating.

`test:watch` exists. No `coverage` script and no coverage dependency (see
**§2.3**).

---

## 7. UI plan compliance (`docs/ui-redesign-plan.md`)

The plan declares 10 closable/dockable panes (`flexlayout-react 0.8.x`), a
default desktop layout, a compact layout at 800–1099 px, popout windows, a
`workspace_layouts` SQLite table, and a redesigned accessibility posture.
**None of this exists in source.** See the per-branch report for the detailed
gap analysis.

What does exist:

- The CSS palette is charcoal/grey with light-blue and orange accents
  (`src/renderer/styles.css:5-23`). However, "orange" is not present — the
  only accent color is `--violet: #8b7cf6` (`styles.css:18`). The plan
  states *"orange execution/CTA states"* but **no orange token is defined**.
- `prefers-reduced-motion` is honored
  (`src/renderer/styles.css:1645-1654`). Good.
- A single `@media (max-width: 1250px)` breakpoint exists (`styles.css:1631`)
  — but it only resizes the workspace grid, not the layout topology that
  the plan requires.
- Inter and JetBrains Mono are referenced by name in CSS (`styles.css:3, 100`)
  but the `@fontsource-variable/inter` and `.../jetbrains-mono` packages are
  declared in `package.json` and **never imported**. The fonts fall back to
  `system-ui` / `monospace` — silently.

### 7.1 Accessibility (general)

The renderer is keyboard-friendly (focusable buttons, inputs, selects,
textareas; CSS `:focus-visible` rings at `styles.css:46-50`), and reduced
motion is respected.

What's missing for an MVP-grade a11y posture:

- No `aria-current` on selected sidebar items
  (`src/renderer/components/Sidebar.tsx:57-58` uses class only).
- `RunPanel` tablist (`src/renderer/components/RunPanel.tsx:72-93`) has
  `role="tablist"` but the tab buttons lack `role="tab"`, `aria-selected`,
  and `aria-controls`.
- `<select>` chevron is decorative but unlabeled (`Inspector.tsx:127`).
- `ErrorToast` correctly uses `role="alert"` (`App.tsx:103`).
- No `prefers-contrast` or forced-colors adaptation in `styles.css`.
- The "Settings" button at `Sidebar.tsx:101-103` has no `onClick` — it's
  visually present but inert. *Severity: low — visual placeholder.*

### 7.2 Visual / styling notes (selected)

- The "Graph Library" / "Run History" / "Graph Canvas" / "Task Launcher" /
  "Graph Settings" / "Node Inspector" / "Runtime Policy" / "Live Stream" /
  "Diff" / "Result" panes in the plan map to existing components only
  loosely. The current code uses a single titlebar + sidebar + canvas-row +
  run-composer + run-panel layout (`src/renderer/App.tsx:51-89`) — not
  dockable.
- The titlebar says `<Command size={12} /> K` (App.tsx:60) suggesting
  ⌘K, but no `keydown` handler for that exists in `App.tsx`.
- `node-graph-canvas` `Background` color is `#273147` with `1px` dots on a
  22px gap. Subtle. Good baseline.

### 7.3 Persistence per the plan

Plan: `workspace_layouts` SQLite table keyed by `(graph_id, mode)`. Not
present. **Finding 7.1 — no `workspace_layouts` schema, no IPC, no renderer
hook.**

### 7.4 Window-open allowlist

Plan: replace the blanket `setWindowOpenHandler(() => ({ action: "deny" }))`
with an exact allowlist for `popout.html`. **Finding 7.2 — neither the
popout HTML nor the allowlist exists.**

### 7.5 Renderer side-effects

The `useEffect` in `App.tsx:19-24` subscribes to `onRunEvent`. The cleanup
returns the unsubscribe — good. No leaked listeners.

### 7.6 ESLint coverage

`eslint.config.mjs` does **not** include `eslint-plugin-jsx-a11y`. The plan
calls out keyboard navigation and contrast checks; the lint config does
not enforce any of this. *Severity: low — a recommended addition, not a
blocker.*

---

## 8. Findings ranked (severity, file:line, recommendation)

| # | Sev | Where | Finding | Recommended action |
| --- | --- | --- | --- | --- |
| 1.1 | process | `git:branch inventory` | `main` and `ui-redesign` are the same commit; no work has landed on `ui-redesign` despite the branch name. | Either commit the `package.json`/`pnpm-lock.yaml` dependency additions to `ui-redesign`, or revert them. |
| 1.2 | process | working tree | Uncommitted changes on `ui-redesign`. | Commit with a clear message; don't ship dep-only WIP as a "branch". |
| 2.1 | medium | `pnpm audit` | Electron 38.8.6 < 39.8.5; runtime CVEs in shipped binary. | Bump Electron to ≥39.8.5. |
| 2.2 | low | `pnpm audit` | `node-tar` CVEs in toolchain only; not shipped. | Optional `pnpm.overrides` for `tar`. |
| 2.3 | low | `vitest.config.ts:5-9` | Coverage configured but `@vitest/coverage-v8` missing; `pnpm test --coverage` fails. | Install `@vitest/coverage-v8` or drop the coverage block. |
| 3.1 | low | `src/preload/index.ts:36` | Bridge surface is narrow and typed. | No change required. |
| 3.2 | low | `index.html:8` | `connect-src 'self' http://127.0.0.1:*` is broader than necessary. | Replace wildcard with a sentinel port after discovery. |
| 3.3 | low | `src/main/run-engine.ts:381-388` | Redaction is regex-on-key at top level only. | Walk nested objects; add a unit test. |
| 3.4 | low | `src/main/ipc.ts:53-56` | `IPC.revealPath` has no allowlist. | Allowlist to `userData/worktrees/<id>` and `<repository>/<sub>` paths only. |
| 3.5 | low | `src/main/opencode.ts:188` | `process.env` inherited wholesale. | Whitelist env vars passed to `spawn`. |
| 4.1 | low | `src/renderer/store.ts:67-69` | Each SSE event triggers a full snapshot pull. | Apply event incrementally. (Not a bug — perf concern at scale.) |
| 4.2 | medium | `src/main/opencode.ts:157-163` | No timeout on `harness.abort()`. | Wrap in `Promise.race` with a 5s timeout. |
| 4.3 | n/a | `src/main/app-service.ts:82-88` | Single-active-run guard is in the engine, not the service. | Acceptable as-is. |
| 5.1 | low | `src/main/app-service.ts:59` | `onboardingComplete` written before the connect call returns. | Move after `this.snapshot()` is built. |
| 6.1 | medium | tests | No tests for `AppService`, `database.ts`, `ipc.ts`, `opencode.ts`. | Add focused unit tests with `FakeDatabase`/`FakeBackend` to mirror `FakeHarness`. |
| 7.1 | medium | `src/main/database.ts` and plan §"Persistence" | No `workspace_layouts` table. | Implement when redesign work begins. |
| 7.2 | medium | `src/main/index.ts:38` and plan §"Persistence, Security, and Interfaces" | No popout allowlist, no `popout.html`. | Implement when redesign work begins. |
| 7.3 | low | `src/renderer/components/RunPanel.tsx:72-93` | `role="tablist"` without `role="tab"` / `aria-selected`. | Fix or remove `role="tablist"`. |
| 7.4 | low | `src/renderer/components/Sidebar.tsx:101-103` | Inert "Settings" button. | Either remove or wire up. |
| 7.5 | low | `src/renderer/styles.css` | `--orange` token missing; plan calls for it. | Add an orange accent variable and use it for primary CTA. |
| 7.6 | low | `eslint.config.mjs` | No `eslint-plugin-jsx-a11y`. | Add the plugin and recommended rules. |

---

## 9. Branch divergence table (verbatim)

```text
Branch       Commit    Date         Subject
main         7c10ccf   2026-07-28   spire mvp v0.1
ui-redesign  7c10ccf   2026-07-28   spire mvp v0.1
```

```text
git log --oneline main..ui-redesign        # (empty)
git log --oneline ui-redesign..main        # (empty)
git diff main..ui-redesign -- ':!package.json' ':!pnpm-lock.yaml'
# (empty)
```

Per-branch report: see `docs/code-review-2026-07-29-branch-ui-redesign.md`
for the gap analysis between this branch and the
`docs/ui-redesign-plan.md` blueprint.

---

## 10. Appendix — verbatim command outputs

### 10.1 `pnpm install --frozen-lockfile`
```
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 1.3s
```
Exit 0.

### 10.2 `pnpm typecheck`
```
> spire@0.1.0 typecheck /home/ubuntu/spire
> tsc --noEmit
```
Exit 0. No diagnostics.

### 10.3 `pnpm lint`
```
> spire@0.1.0 lint /home/ubuntu/spire
> eslint .
```
Exit 0. No diagnostics.

### 10.4 `pnpm test`
```
> spire@0.1.0 test /home/ubuntu/spire
> vitest run


 RUN  v3.2.7 /home/ubuntu/spire

 ✓ src/main/run-engine.test.ts (2 tests) 173ms
 ✓ src/shared/domain.test.ts (3 tests) 10ms
 ✓ src/main/worktree.test.ts (1 test) 94ms
 ✓ src/main/prompts.test.ts (3 tests) 14ms

 Test Files  4 passed (4)
      Tests  9 passed (9)
   Start at  23:03:51
   Duration  1.71s
```
Exit 0.

### 10.5 `pnpm audit` (summary)
```
20 vulnerabilities found
Severity: 3 low | 5 moderate | 11 high | 1 critical
```
Top three: `node-tar` DoS (critical), `node-tar` hardlink path traversal
(high), `node-tar` symlink poisoning (high). Electron use-after-free in
offscreen shared texture and clipboard `readImage` crash are the runtime
hits; both fixed in Electron ≥39.8.5.

Exit 0 (informational).

### 10.6 `npx vitest run --coverage`
```
MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'
```
Exit non-zero.

---

*End of main review.*
