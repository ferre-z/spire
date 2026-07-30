# Spire

Spire is a Linux-first desktop application for orchestrating coding agents as
live, inspectable graphs. The MVP runs two role-configured
[OpenCode](https://opencode.ai/) agents in a bounded loop:

```text
Architect plans → Builder implements → Architect reviews
                         ↑                  │
                         └── revise ────────┘
```

Every run gets an isolated Git branch and worktree. Spire preserves the graph
version, normalized event stream, structured handoffs, real diff, validation
report, final verdict, and workspace reference in a local SQLite database.

## MVP capabilities

- Professional dockable workspace built with FlexLayout: ten closable,
  resizable, tab-groupable, maximizable panes with native popout windows.
- Per-graph persisted layouts with separate desktop and compact arrangements
  (breakpoint at 1100px), a View menu, and a Ctrl/Cmd+K layout command menu.
- Dark graph editor built with React Flow.
- Editable agent names, instructions, models, positions, and loop cap.
- In-app OpenRouter connection and model discovery through OpenCode.
- Real OpenCode sessions through its typed SDK and headless local server.
- Structured `TaskBrief`, `ImplementationReport`, and `ReviewVerdict` handoffs.
- Plan → implement → review → revise execution with a one-to-five pass limit.
- Stop, failure retention, and manual retry from the saved workspace.
- Isolated Git worktrees with actual tracked and untracked diffs.
- Persistent run history, live events, patch export, and worktree reveal.
- Secure Electron preload: context isolation, renderer sandbox, no Node
  integration, an exact popout window allowlist, and localhost-only OpenCode
  server with an in-memory password.

Self-modifying graphs, arbitrary graph topology, multiple simultaneous runs,
remote hosts, containers/pods, and other harnesses are intentionally deferred.

## Prerequisites

- Linux x64
- Node.js 22 or newer
- pnpm 11
- Git
- OpenCode 1.18 or newer available as `opencode`
- An OpenRouter API key

## Install and run

You asked to install dependencies yourself. From this repository:

```bash
pnpm install
pnpm start
```

The first command uses the hoisted dependency layout required by Electron
Forge and approves only the native build scripts for Electron, esbuild, and
SQLite.

If pnpm asks whether to run these build scripts, approve:

- `electron`
- `esbuild`
- `better-sqlite3`

Then launch Spire, confirm that OpenCode was detected, and enter the OpenRouter
key. The key is sent to the local OpenCode authentication endpoint and is never
stored in Spire's database or run events.

## Development commands

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm lint
pnpm build
pnpm make
```

- `pnpm build` creates an unpacked Linux application under `out/`.
- `pnpm test:e2e` packages the app and runs the Playwright Electron UI suite
  under Xvfb against seeded, offline fixtures.
- `pnpm spire:mcp` builds and runs the MCP stdio sidecar (see below).
- `pnpm make` produces Linux ZIP and `.deb` distributables.

Creating the distributables also requires the host-level `zip`, `dpkg`, and
`fakeroot` binaries. The unpacked application build does not require them.

## MCP control plane

Spire exposes its full control plane to local MCP clients through a stdio
sidecar. The sidecar is a plain Node 22+ process (no Electron) that connects
to the running desktop app's authenticated Unix control socket and serves
every control capability as MCP tools and resources.

Build the sidecar once:

```bash
pnpm build:mcp   # emits the self-contained mcp-dist/mcp.js
```

`pnpm spire:mcp` rebuilds and runs it in one shot, which is convenient for
manual checks but too slow as an MCP client startup command. Packaged builds
ship the same bundle at `resources/mcp.js` inside the app directory.

Client setup snippets (adjust the path to your checkout or package):

- Codex (`~/.codex/config.toml`):

  ```toml
  [mcp_servers.spire]
  command = "node"
  args = ["/path/to/spire/mcp-dist/mcp.js"]
  ```

- Claude Code:

  ```bash
  claude mcp add spire -- node /path/to/spire/mcp-dist/mcp.js
  ```

- OpenCode (`opencode.json`):

  ```json
  {
    "mcp": {
      "spire": {
        "type": "local",
        "command": ["node", "/path/to/spire/mcp-dist/mcp.js"]
      }
    }
  }
  ```

- Any generic stdio MCP client: spawn `node /path/to/spire/mcp-dist/mcp.js`
  and speak standard MCP over its stdin/stdout. stderr carries only
  diagnostics; stdout is clean JSON-RPC.

### Operation coverage

Every registered control capability maps to exactly one `spire_*` tool:
state and diagnostics snapshots, graph list/get/save, repository validation,
run list/get/start/stop/retry, run artifacts, managed worktree cleanup,
workspace layout list/save/reset, harness list/models, and trace journal
query/tail. Resources mirror the same data: `spire://state` plus templates
for `spire://graphs/{graphId}`, `spire://runs/{runId}`,
`spire://runs/{runId}/artifacts`, and `spire://traces/{runId}`. Live trace
events stream as MCP logging notifications, so a client can tail an active
run in real time; the subscription is re-established automatically after a
reconnect.

### Trust model

- The sidecar requires the Spire desktop app to be running. Without it, the
  sidecar exits with one actionable error naming the expected socket path
  and how to launch the app.
- The app publishes a per-launch random token in
  `<userData>/control/control.token` (mode 0600, directory 0700). Any process
  that can read the token already runs as the owning user, so the sidecar
  trusts same-user local processes; the token rotates on every app launch and
  is never logged or included in errors.
- The socket exposes semantic control operations only — validated by the same
  Zod schemas the Electron IPC adapter uses. There is no raw SQL, shell, or
  filesystem pass-through.
- Execution traces are redacted in the SQLite trace journal (the single
  redaction path) before they cross the socket, so MCP output never contains
  unredacted API keys, tokens, or credentials.

## Architecture

```text
React renderer
    │ typed, narrow IPC
Sandboxed preload
    │
Electron main process
    ├── RunEngine             graph state and bounded loop
    ├── OpenCodeHarness       SDK sessions, prompts, SSE, abort
    ├── LocalWorktreeBackend  Git isolation, diff, patch lifecycle
    └── SpireDatabase         graph versions and complete run history
```

The orchestration modules depend on two deliberately small seams:

- `AgentHarness` creates, continues, observes, and aborts agent sessions.
- `ExecutionBackend` prepares, inspects, exports, and cleans run workspaces.

This keeps future Codex/Claude Code harnesses and remote HQ runners out of the
graph engine and UI.

## Runtime behavior

1. Spire validates the selected Git repository and creates
   `spire/run-<id>` in its application-data worktree directory.
2. Architect inspects the repository without shell or edit tools and returns a
   structured task brief.
3. Builder edits and validates the isolated worktree.
4. Spire reads the real Git diff, including new untracked files.
5. Architect reviews the brief, implementation report, repository, and diff.
6. An accepted verdict completes the graph; requested changes loop back to
   Builder until the configured cap.
7. Spire never commits, merges, pushes, or edits the user's source checkout.

If the source checkout is dirty, Spire warns that the isolated worktree starts
from the committed `HEAD`.

## Verification

The automated suite covers:

- Graph invariants and invalid edges/roles.
- Structured output parsing and repair tolerance.
- Successful two-pass review/revision execution.
- Iteration-cap termination.
- Real temporary Git worktree creation, diff inspection, and cleanup.
- Workspace layout validation, corrupt-layout fallback, and the 512KB cap.
- Default desktop/compact models and panel registry completeness.
- Layout persistence per graph, per mode, and across graph versions.
- The popout window allowlist (everything else stays denied).
- Playwright Electron UI tests at 800×600 through 1920×1080: docking,
  tab grouping, maximize, reset, graph switching, keyboard navigation,
  native popouts, security denials, contrast, reduced motion, overflow,
  and screenshot comparisons — all with mocked run data, never OpenRouter.

The real provider contract is intentionally not part of the default test suite
because it requires a paid model credential.
