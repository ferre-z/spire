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

- Cinematic dark graph editor built with React Flow.
- Editable agent names, instructions, models, positions, and loop cap.
- In-app OpenRouter connection and model discovery through OpenCode.
- Real OpenCode sessions through its typed SDK and headless local server.
- Structured `TaskBrief`, `ImplementationReport`, and `ReviewVerdict` handoffs.
- Plan → implement → review → revise execution with a one-to-five pass limit.
- Stop, failure retention, and manual retry from the saved workspace.
- Isolated Git worktrees with actual tracked and untracked diffs.
- Persistent run history, live events, patch export, and worktree reveal.
- Secure Electron preload: context isolation, renderer sandbox, no Node
  integration, localhost-only OpenCode server with an in-memory password.

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
pnpm lint
pnpm build
pnpm make
```

- `pnpm build` creates an unpacked Linux application under `out/`.
- `pnpm make` produces Linux ZIP and `.deb` distributables.

Creating the distributables also requires the host-level `zip`, `dpkg`, and
`fakeroot` binaries. The unpacked application build does not require them.

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

The real provider contract is intentionally not part of the default test suite
because it requires a paid model credential.
