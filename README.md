# Spire

Spire is a Linux-first desktop application for orchestrating coding agents as
visual, durable corporate workflow graphs. Users build graphs whose nodes are
bespoke agent tasks routed through OpenCode, Codex, or Claude Code; the nodes
collaborate through shared Markdown artifacts, execute in isolated Git worktrees,
branch and loop, and apply authorized runtime plan changes at checkpoints — all
persisted in a local SQLite database and fully controllable through MCP.

```text
Research → Implement → Review → Gate ──┬── checkpoint → Deploy → Finalize
                                          │   ↑                  │
                                          │   └── revise ────────┘
                                          └── need revisions
```

Every run gets an isolated Git worktree. Spire preserves the graph version,
execution plan, node states, collaboration messages, trace journal, and
workspace references in a local SQLite database.

## Workflow model

### Saved graphs versus run plans

- **Saved graphs** (`GraphDefinitionV2`) are immutable, versioned templates.
  They define the topology, node configs, edges, groups, and subgraphs that can
  be reused across runs.
- **Execution plans** are compiled from one graph version into a separate,
  persisted, mutable record. The scheduler changes only the plan — never the
  source graph — when a node proposes an authorized patch. A promoted plan can be
  saved as a new graph version, but promotion is always an explicit, auditable
  step.

### Block types

A graph is composed of five block kinds:

- **Agent** — runs a bespoke job through a configured harness (OpenCode, Codex,
  or Claude Code). Has `job`, `harnessId`, `modelId`, `access`, `authority`,
  `activation`, and `maxVisits`.
- **Decision** — like an agent node but expected to choose a branch by selecting
  an outgoing edge. Routes by `selected` edges rather than fixed conditions.
- **Checkpoint** — gates progress. `automatic` checkpoints pause for scope
  validation and workspace merges; `manual` checkpoints pause until a user
  explicitly resumes via `runs.checkpoint.resume`.
- **Subgraph** — references another saved graph version. The compiler resolves
  the exact version at compile time and namespaces nested node IDs so subgraph
  instances never collide.
- **Group** — a visual container for nodes. Has no execution semantics; it only
  scopes the `group` authority boundary.

### Bespoke jobs

Each agent/decision node carries a `job` string (the prompt or task description)
rather than a fixed "Architect" or "Builder" role. Node behavior comes entirely
from its combined configuration: `job`, `harnessId`, `modelId`, `access`,
routing, and `authority` — never from a title or role label.

### Typed edges

Edges carry `kind` and `when` fields:

- **kind** — `dependency` (activation order), `handoff` (artifact transfer),
  `review` (feedback routing), `approval` (gate passage), `escalation`
  (failure recovery).
- **when** — `always`, `success`, `failure`, or `selected` (chosen by a
  decision node's outcome).

A target node becomes ready when its activation policy (`all` or `any`) and
incoming edge conditions are satisfied. Each completed source visit offers one
token on every outgoing edge whose condition the outcome satisfies; each target
activation consumes one token per incoming `all` edge (or any single token for
`any`).

### Groups and subgraphs

- Nodes can be placed inside `GraphGroup` containers for visual organization.
  Groups are purely presentational — a node's title or group membership has no
  execution or authorization semantics.
- Subgraph nodes reference another saved graph by `graphId` (and optionally
  `graphVersion`). At compile time the scheduler expands subgraphs into the plan
  and namespaces nested node IDs (e.g. `subgraphId::innerNodeId`) so loops and
  branches within subgraphs stay isolated.

### Authority

Each agent/decision node declares a `NodeAuthority`:

```ts
type NodeAuthority = {
  scope: "self" | "connected" | "group" | "graph";
  actions: PlanMutation[]; // subset of: retry, skip, reorder, reroute, pause,
                            // replace, insert, remove, edit
};
```

- **scope** — `self` (only the node's own nodes), `connected` (nodes reachable
  via success edges), `group` (nodes in the same group), `graph` (any node).
- **actions** — the plan mutations the node is permitted to propose. Defaults are
  self scope with no actions (a node cannot patch the plan unless authorized).

Patches are only permitted after node completion, at explicit checkpoints, or
during failure recovery. The `baseRevision` must equal the current plan revision;
stale proposals are rejected. Unauthorized or over-scoped patches are rejected
without corrupting the plan.

### Plan patches and rollback

A `NodeOutcome` may include a `PlanPatchDraft` proposing mutations. The scheduler
validates the patch against the actor's authority before applying it in a single
transaction. Rollback applies the inverse operations as a new audited revision.

Promotion saves the live plan topology as a new graph version, stripping run
states, attempt IDs, messages, and temporary replacement metadata.

### Markdown collaboration

Collaboration memory is app-managed Markdown — no vector store or knowledge
graph. Each run gets `<userData>/runs/<runId>/collaboration/` with per-node
inboxes. Nodes exchange handoff, decision, report, question, and checkpoint
messages as append-only Markdown documents. Context packets for each node are
assembled from the job, run objective, incoming messages, relevant outputs,
accessible repository paths, and authority. Communication files stay outside Git
diffs.

### File-scope isolation

- **read-only** nodes run in the run's integration worktree and cannot write to
  the repository.
- **workspace-write** nodes branch into a private node worktree from the current
  checkpoint. Changed paths are validated against the node's `writeScopes`.
  Out-of-scope edits raise a `ScopeViolationError` and are discarded; the node
  fails so failure routing can engage.
- At checkpoints, successful scoped changes are committed and merged into the
  integration branch. Merge conflicts also become node failures.
- Spire never commits, merges, pushes, or edits the user's source checkout. If
  the source is dirty, Spire warns that the isolated worktree starts from the
  committed `HEAD`.

### Harnesses

OpenCode, Codex, and Claude Code are the production harnesses for this release.
Each implements the normalized `HarnessAdapter` contract (`probe`, `listModels`,
`run`, `abort`, `close`). Native CLI authentication remains owned by each
harness: authenticate with the native `opencode`, `codex`, or `claude` CLI,
never inside Spire. Spire stores no native harness credentials and only probes
whether a runtime is installed/available and which models that runtime exposes.
The harness registry routes each node through the adapter configured for that
node's `harnessId`.

## Workspace interface

The renderer uses a fixed graph workspace rather than user-dockable panes:

- The activity rail on the left selects Graph Library, Run History, Harnesses,
  and Collaboration. The context panel contains graph/runtime controls, and the
  utility rail on the right opens Live Stream, Diff, and Result drawers.
- The graph canvas remains central. Selecting a node opens a modal with input,
  editable settings, and output; closing and reopening it retains live edits,
  while **Save version** persists a new graph version.
- The 64px launch dock remains anchored across the bottom for repository, goal,
  and run controls.
- `Cmd/Ctrl+K` opens the command menu. `F6` and `Shift+F6` move focus forward
  and backward through the major workspace regions.
- At 1280px and wider, navigation and context are fixed beside the canvas.
  Below 1280px context becomes an overlay; below 1100px navigation does too;
  below 861px the launcher compacts. The supported minimum window is 800×600.

The legacy workspace-layout persistence table and shared/main/preload APIs are
retained for data compatibility. The fixed renderer does not read or write
those records, so existing rows remain intact and inert.

### Failure routing

A node may fail for any reason: harness error, timeout, cancellation, scope
violation, merge conflict, or exhausted retries. Edges with `when: "failure"`
activate on failure, letting the graph route to recovery or escalation nodes.
Nodes that exceed `maxVisits` are suppressed, and the plan reports
`needs_attention` rather than hard-failing the entire run.

### Restart recovery

On app restart, orphaned `running` node attempts are converted to `failed`, a
failure checkpoint is persisted, and routing resumes from the last durable plan
state. The run is not marked failed merely because Spire closed.

## MCP control plane

Spire exposes its full control plane to local MCP clients through a stdio
sidecar. The sidecar is a plain Node 22+ process (no Electron) that connects to
the running desktop app's authenticated Unix control socket and serves every
control capability as MCP tools and resources.

Build the sidecar once:

```bash
pnpm build:mcp   # emits the self-contained mcp-dist/mcp.js
```

`pnpm spire:mcp` rebuilds and runs it in one shot, which is convenient for manual
checks but too slow as an MCP client startup command. Packaged builds ship the
same bundle at `resources/mcp.js` inside the app directory.

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

| Tool | Operation | Read-only |
|---|---|---|
| `spire_state_get` | `state.get` | yes |
| `spire_diagnostics_get` | `diagnostics.get` | yes |
| `spire_graphs_list` | `graphs.list` | yes |
| `spire_graphs_get` | `graphs.get` | yes |
| `spire_graphs_save` | `graphs.save` | no |
| `spire_graphs_validate` | `graphs.validate` | yes |
| `spire_repositories_validate` | `repositories.validate` | yes |
| `spire_runs_list` | `runs.list` | yes |
| `spire_runs_get` | `runs.get` | yes |
| `spire_runs_start` | `runs.start` | no |
| `spire_runs_stop` | `runs.stop` | no |
| `spire_runs_retry` | `runs.retry` | no |
| `spire_runs_artifacts_get` | `runs.artifacts.get` | yes |
| `spire_worktrees_cleanup` | `worktrees.cleanup` | destructive |
| `spire_layouts_list` | `layouts.list` | yes |
| `spire_layouts_save` | `layouts.save` | no |
| `spire_layouts_reset` | `layouts.reset` | destructive |
| `spire_harnesses_list` | `harnesses.list` | yes |
| `spire_harnesses_models` | `harnesses.models` | yes |
| `spire_traces_query` | `traces.query` | yes |
| `spire_traces_tail` | `traces.tail` | yes |
| `spire_runs_plan_get` | `runs.plan.get` | yes |
| `spire_runs_nodes_list` | `runs.nodes.list` | yes |
| `spire_runs_messages_list` | `runs.messages.list` | yes |
| `spire_runs_messages_send` | `runs.messages.send` | no |
| `spire_runs_plan_patch` | `runs.plan.patch` | no |
| `spire_runs_plan_rollback` | `runs.plan.rollback` | destructive |
| `spire_runs_checkpoint_resume` | `runs.checkpoint.resume` | no |
| `spire_runs_plan_promote` | `runs.plan.promote` | no |

Resources mirror the same data: `spire://state` plus templates for
`spire://graphs/{graphId}`, `spire://runs/{runId}`,
`spire://runs/{runId}/nodes/{nodeId}`, `spire://runs/{runId}/messages`,
`spire://runs/{runId}/patches`, `spire://runs/{runId}/artifacts`, and
`spire://traces/{runId}`. Live trace events stream as MCP logging
notifications, so a client can tail an active run in real time; the subscription
is re-established automatically after a reconnect.

Message and patch lists are byte-bounded and paginated (default limit 200, max
200). Trace summaries are returned only — plan, message-list, and trace-query
results are never embedded recursively in success events.

### Trust model

- The sidecar requires the Spire desktop app to be running. Without it, the
  sidecar exits with one actionable error naming the expected socket path and
  how to launch the app.
- The app publishes a per-launch random token in
  `<userData>/control/control.token` (mode 0600, directory 0700). Any process
  that can read the token already runs as the owning user, so the sidecar trusts
  same-user local processes; the token rotates on every app launch and is never
  logged or included in errors.
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
    ├── RunEngine            graph compilation, scheduling, plan persistence
    ├── GraphScheduler       ready-node selection, node execution, restart recovery
    ├── HarnessRegistry      OpenCode / Codex / Claude Code adapters
    ├── NodeWorkspaceCoordinator  isolated git worktrees, scope validation, merges
    ├── CollaborationWorkspace   app-managed Markdown handoffs
    ├── SpireDatabase         SQLite: graphs, plans, messages, patches, sessions
    ├── TraceJournal          append-only redacted event log
    ├── ControlSocketServer   authenticated Unix socket control plane
    └── LocalWorktreeBackend  git integration worktrees, diff, patch lifecycle
```

The orchestration modules depend on two deliberately small seams:

- `HarnessAdapter` creates, continues, observes, and aborts agent sessions for one
  harness implementation.
- `ExecutionBackend` prepares, inspects, exports, and cleans run workspaces.

This keeps future harnesses and remote HQ runners out of the graph engine and UI.

## Runtime behavior

1. Spire validates the selected Git repository and creates an integration
   worktree from its committed `HEAD`.
2. The run engine compiles the selected graph version into a persisted execution
   plan, expanding subgraph references and namespacing nested node IDs.
3. The scheduler selects ready nodes (activation policy + incoming edge
   conditions satisfied) and routes them through the matching harness adapter.
4. read-only nodes run in the integration worktree; workspace-write nodes branch
   into isolated node worktrees.
5. Each node's context packet is assembled from its job, the run objective,
   incoming Markdown messages, and accessible repository paths.
6. Node outcomes (status, artifacts, messages, selected edges, optional patches)
   are stored before successors are activated.
7. At checkpoints, workspace-write changes are scope-checked, committed, and
   merged into the integration branch.
8. Authorized nodes can propose plan patches at checkpoints or during failure
   recovery; the scheduler validates authority before applying them.
9. The run completes when all terminal nodes are settled, or reports
   `needs_attention` when bounds are exceeded.
10. Spire never commits, merges, pushes, or edits the user's source checkout.

If the source checkout is dirty, Spire warns that the isolated worktree starts
from the committed `HEAD`.

## Prerequisites

- Linux x64 or arm64
- Node.js 22 or newer
- pnpm 11
- Git

Install at least one supported harness CLI for real execution:

- OpenCode 1.18 or newer (`opencode`)
- Codex (`codex`)
- Claude Code (`claude`)

## Install and run

From this repository:

```bash
pnpm install
pnpm start
```

The first command uses the hoisted dependency layout required by Electron Forge
and approves only the native build scripts for Electron, esbuild, and SQLite.

If pnpm asks whether to run these build scripts, approve:

- `electron`
- `esbuild`
- `better-sqlite3`

Then authenticate in at least one native CLI, launch Spire, and complete the
two-step onboarding flow. Onboarding discovers connected runtimes and their
available models; it never requests or stores CLI credentials.

### Standalone coordinator

The headless coordinator runs as a plain Node process and requires an explicit
control token:

```bash
SPIRE_COORDINATOR_TOKEN="replace-with-a-secret" pnpm spire:coordinator
```

It listens on `127.0.0.1:43110` by default. Set `SPIRE_COORDINATOR_HOST` and
`SPIRE_COORDINATOR_PORT` to choose another address. Loopback listeners use HTTP
by default. A non-loopback host is refused unless `SPIRE_ALLOW_REMOTE=1` and a
TLS identity is supplied through both `SPIRE_COORDINATOR_TLS_CERT` and
`SPIRE_COORDINATOR_TLS_KEY`:

```bash
SPIRE_COORDINATOR_TOKEN="replace-with-a-secret" \
SPIRE_COORDINATOR_HOST="0.0.0.0" \
SPIRE_ALLOW_REMOTE=1 \
SPIRE_COORDINATOR_TLS_CERT="/run/secrets/spire.crt" \
SPIRE_COORDINATOR_TLS_KEY="/run/secrets/spire.key" \
pnpm spire:coordinator
```

The certificate and private key must be a valid matching PEM pair. The startup
URL uses `https://` whenever they are configured. The unauthenticated health
endpoint is `GET /healthz`; authenticated control requests use
`POST /v1/control` with `Authorization: Bearer <SPIRE_COORDINATOR_TOKEN>`, and
resumable run events stream from `GET /v1/events` using the same header.

This is a transitional deployment surface: SQLite state and harness adapters
still run inside the coordinator process. A future worker deployment can replace
the harness execution layer without changing the HTTP interface.

## Development commands

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm build:mcp
pnpm make
pnpm test:e2e
```

- `pnpm build` creates an unpacked Linux application under `out/`.
- `pnpm build:mcp` emits the self-contained MCP sidecar at `mcp-dist/mcp.js`.
- `pnpm test:e2e` packages the app and runs the Playwright Electron UI suite
  under Xvfb against seeded, offline fixtures.
- `pnpm make` produces Linux ZIP and `.deb` distributables.

Creating the distributables also requires the host-level `zip`, `dpkg`, and
`fakeroot` binaries. The unpacked application build does not require them.

## Verification

The automated suite covers:

- Graph v2 schema invariants: valid mixed node kinds, nested groups, subgraph
  references, cycles, all/any joins, typed success/failure/selected routing,
  duplicate IDs, invalid group references, invalid authority actions, stale
  patches, and strict outcome/message validation.
- Legacy graph migration: v1 planner/implementer graphs normalize to v2
  preserving IDs, instructions, positions, edges, versions, and model IDs;
  planner → read-only, implementer → workspace-write with `writeScopes: ["**/*"]`.
- Execution persistence: plan round-trips, node executions, messages, patches,
  and harness sessions through SQLite, with transactional plan + node updates.
- Harness registry: deterministic adapter ordering, duplicate/unknown IDs,
  probe failure isolation, event normalization across OpenCode, Codex, and
  Claude Code.
- Scheduler: linear, parallel, all/any joins, loops, max visits, max steps,
  automatic/manual checkpoints, subgraph expansion, deterministic ordering,
  stop/retry, deadlock detection, and restart recovery.
- Collaboration: per-node Markdown inboxes, context packets, append-only handoff/
  decision/report/checkpoint documents, communication files outside Git status.
- Node worktrees: parallel isolation, scope violations, clean merges, merge
  conflicts, read-only vs. workspace-write, source-repository preservation,
  final run diff generation.
- Plan patches: authority validation per scope/action, stale base revisions,
  running/completed node protection, rollback, and graph-version promotion.
- Control plane: capability parity across IPC and MCP, Zod input/output
  validation, read-only/destructive/idempotent annotations, redaction, and
  correlated traces.

The real provider contract is intentionally not part of the default test suite
because it requires paid model credentials and installed CLIs. An optional
offline E2E suite exercises the full scheduler with fixture harness adapters.
