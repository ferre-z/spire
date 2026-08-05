# Agent MCP + Live Collaboration — Design

> Status: **Design / review — not yet an implementation plan.**
> Builds on: `docs/superpowers/plans/2026-07-30-graph-native-corporate-workflows.md`
> (Tasks 1–10, executed and summarized in `docs/graph-workflows-execution-summary.md`).

## 1. Problem

Today a node inside a run is a **batch** actor: it receives one frozen context
packet at activation, works with its native filesystem tools, and at the end
returns one structured `NodeOutcome` JSON blob that Spire interprets. It cannot,
while running:

- see new messages / questions from other agents (its inbox is only read at
  activation),
- ask a colleague or broadcast `question` / `handoff` / `report` and have it
  route *live*,
- inspect the org (plan / node states) or predecessor outputs mid-run,
- read or append shared Markdown docs.

The existing MCP sidecar (`mcp-dist/mcp.js`) is **external-client-only** — it
connects to the app's Unix control socket for *your* editor / outer agent. The
graph-node sessions never receive it.

## 2. Goals

1. **MCP tool surface inside every node session** — agents get read/write access
   to Spire's control plane (scoped to their run + their own node identity).
2. **Live visibility** — an agent can, mid-session, read its inbox, tail new
   messages, see the plan and every node's state, and read shared docs.
3. **Shared Markdown docs across layers** — a gitignored `.spire/` tree inside
   each worktree (inbox + layered shared docs), readable/writable with native
   tools, AND the same underlying docs via MCP reads. ("Both", per decision.)
4. **Destroy any ad-hoc reorg risk**: every destructive/acting tool reuses the
   existing `NodeAuthority` gate; an agent MCP server is hard-wired to act *as
   its own node* (it cannot impersonate another), and can never touch content
   outside its run's collaboration tree.

## 3. Architecture

```
main process                      spawns harness CLI per node attempt
  │  ControlSocketServer (token)        cwd = node worktree
  │        ▲   │
  │        │   └─ sets env: RUN_ID, NODE_ID, OPENCODE_CONFIG / --mcp-config
  │        │
  └─ Spawns per-run agent-mcp.js (child)
         │   stdio transport
         └─ serves scoped MCP tools  →  ControlSocketClient(token)
                                              └─ executes control ops
                                                 (only scoped to this run/node)
```

- **Agent MCP server** (`src/mcp/agent-server.ts`) is a new build entry that
  reuses `ControlSocketClient` + the existing `McpServer` tool registry but with
  a **filtered tool set** and **forced node identity**. It connects to the same
  authenticated control socket as the external sidecar.
- **Identity by env**: the spawned server reads `SPIRE_RUN_ID`, `SPIRE_NODE_ID`,
  and the resolved control paths. Every "act" tool substitutes `senderNodeId` /
  `actorNodeId` with `SPIRE_NODE_ID` and rejects requests whose `runId` ≠
  `SPIRE_RUN_ID`. An agent can only ever act as itself, inside its own run.
- **Injection** is per-harness config written by the main process at spawn time
  (see §6). No code is shipped inside the user's repo; config files live under
  Spire's data dir and are referenced by env/flag.

## 4. Why MCP (not an opencode plugin)

| | MCP server | opencode plugin |
|---|---|---|
| Harnesses | opencode, codex, claude — all speak MCP | opencode only |
| Reuse | existing `McpServer` registry + control socket + `applyPlanPatch` | new tool surface, vendor-locked |
| Act authorization | same `NodeAuthority` gate, unchanged | must reimplement around plan-patcher |

MCP is the cross-harness standard. A plugin is a fallback only if a specific
harness's MCP injection proves unreliable in the Task-0 spike.

## 5. Control-plane extension + agent tool surface

### 5.1 New control operations (`src/shared/control.ts` → `CONTROL_CAPABILITIES`)

Follow the existing capability pattern (input/output zod schemas, annotations,
handler in `src/main/control/spire-control.ts`, MCP coverage, tests). All are
`runs`-scoped; all read ops are `readOnly`.

| Op | Input | Output | Notes |
|---|---|---|---|
| `runs.inbox.get` | `{ runId, nodeId, since? }` | `{ messages: CollaborationMessage[] }` | Messages delivered *to* `nodeId`; optional `since` seq for live tailing |
| `runs.context.get` | `{ runId, nodeId }` | `{ context: string }` | Live-rebuilt context packet (objective, job, inbox, predecessors' **latest** outcomes, authority, paths) |
| `docs.list` | `{ runId, path? }` | `{ items: { path, kind }[] }` | Walk the collaboration Markdown tree; `path` confined to that tree |
| `docs.read` | `{ runId, path }` | `{ path, content }` | Read one doc; path-traversal-safe |
| `docs.write` | `{ runId, path, content }` | `{ path }` | Append or create under the tree; never escapes it; append-only for generated handoff/decision/report docs |

### 5.2 Reused existing ops (agent-facing exposure)

`runs.messages.list` · `runs.messages.send` · `runs.plan.get` ·
`runs.nodes.list` · `runs.plan.patch` · `runs.artifacts.get` · `traces.query` ·
`traces.tail`.

For `runs.plan.patch` and `runs.messages.send`, the agent server **forces** the
actor/sender to `SPIRE_NODE_ID` and run to `SPIRE_RUN_ID` regardless of the
tool input — the existing `applyPlanPatch` authority validation then applies
unchanged.

### 5.3 The agent-facing tool set (what the LLM sees)

Curated subset (no admin/global/list ops): `inbox_get`, `context_get`,
`docs_list`, `docs_read`, `docs_write`, `messages_list`, `messages_send`,
`plan_get`, `nodes_list`, `plan_patch`, `artifacts_get`, `traces_tail`.

**Not exposed to nodes:** `state.get`, `diagnostics.get`, `layouts.*`,
`graphs.save/promote`, `checkpoint.resume`, `plan.rollback`, `worktrees.cleanup`
— these are external/admin only.

## 6. Injection per harness (verified)

### 6.1 OpenCode — `OPENCODE_CONFIG` (confirmed)

Write a per-node config under Spire's data dir, then set `OPENCODE_CONFIG` on
the spawned process. Loaded between global and project config; `mcp` keys merge
by name.

```jsonc
// $SPIRE_DATA/agent-mcp/<runId>/<nodeId>.opencode.json
{
  "mcp": {
    "spire": {
      "type": "local",
      "command": ["node", "/abs/path/spire-mcp/agent-mcp.js"],
      "environment": {
        "SPIRE_RUN_ID": "<runId>",
        "SPIRE_NODE_ID": "<nodeId>",
        "SPIRE_USER_DATA": "<userData>"
      },
      "enabled": true
    }
  }
}
```

`environment` variables are passed to the server process; `{env:...}` / `{file:...}`
substitution is also available in config files.

### 6.2 Claude Code — `claude -p --mcp-config <file>` (confirmed)

```
claude -p --output-format stream-json --json-schema <schema> \
  --mcp-config "$SPIRE_DATA/agent-mcp/<runId>/<nodeId>.mcp.json" ...
```

```jsonc
// <nodeId>.mcp.json
{
  "mcpServers": {
    "spire": {
      "command": "node",
      "args": ["/abs/path/spire-mcp/agent-mcp.js"],
      "env": { "SPIRE_RUN_ID": "<runId>", "SPIRE_NODE_ID": "<nodeId>", "SPIRE_USER_DATA": "<userData>" }
    }
  }
}
```

`env` is passed to the server; `${VAR}` expansion is supported.

### 6.3 Codex — **Task-0 spike required** (docs unconfirmed)

The openai/codex doc paths 404'd during research. The plan must open with a
throwaway spike that confirms, against an installed codex:
- whether MCP servers are configured in `config.toml` under `[mcp_servers.<name>]`
  with `command`/`args`/`env`,
- a per-spawn config override (`CODEX_HOME` vs `--config`), and
- whether MCP tools are available in non-interactive `exec`/JSON mode.

Design does not block on the answer: injection is isolated behind a per-adapter
`buildAgentMcpConfig(spawnEnv, identity)` seam so each adapter can differ.

## 7. Shared Markdown + folder model ("Both")

Maintain **one source of truth** in the app-managed collaboration workspace
(`$SPIRE_USER_DATA/runs/<runId>/collaboration/`) and **mirror it into each
worktree** as a gitignored symlink so agents read/write natively with their own
tools.

### 7.1 Worktree mirror layout

```
<cwd>/  (integration or node worktree)
  .spire/                          ← symlink → $SPIRE_USER_DATA/runs/<runId>/collaboration/
    .gitignore                     (ignores everything under .spire)
    inbox.md                       this node's addressed messages (append-only)
    index.md                       chronological run log
    docs/
      objective.md                 run objective (shared, top layer)
      shared.md                    cross-cutting notes (append-only)
      <groupId>/ …                 per-group layered docs
    handoffs/  decisions/  reports/  checkpoints/
```

- A **symlink** (not a copy) keeps the mirror and the authoritative store
  identical — no sync problem.
- `.spire/` is **gitignored**, so `git status` never surfaces it: agents can
  write `.spire` freely without tripping `writeScopes` validation or polluting
  diffs. (Verified mechanics: `changedFiles`/`finalDiff` derive from `git
  status`, which excludes ignored paths.)
- `inbox.md` + docs are updated by the existing `CollaborationWorkspace.deliver`
  path (which already appends to the authoritative store); the symlink makes the
  same bytes appear in the worktree automatically.

### 7.2 Live inbox while working

Two complementary paths, both harness-agnostic:
1. **Native read**: agent runs `Read .spire/inbox.md` / `docs/…` at any time.
2. **MCP**: `inbox_get`/`messages_list`/`docs_read` for structured queries;
   `messages.send`/`docs.write` for structured writes.

Optional (Phase 2, best-effort): forward a new-message trace event as an MCP
logging notification so a capable harness can surface it without a poll.

## 8. Security & authority model

- Agents act only as `SPIRE_NODE_ID` in `SPIRE_RUN_ID`; impersonation is
  impossible because the server overwrites actor/sender fields.
- `runs.plan.patch` reuses `applyPlanPatch` → `NodeAuthority` (scope + actions +
  `baseRevision`) validation, unchanged and untrusted-by-layout.
- `docs.write` / `docs.read` / `docs.list` confine all paths inside the
  collaboration tree via the existing `safeSegment` / traversal-safe helpers;
  never escape to the repo.
- The token model is unchanged (`control.token`, mode 0600); the agent server is
  a same-user local peer like the external sidecar.
- Communication/docs stay **outside git diffs** (existing constraint, preserved
  by the `.spire` ignore).

## 9. Phased workstreams (design-level)

**WS0 — Injection spike (de-risk).** Throwaway script per harness: opencode
`OPENCODE_CONFIG`, claude `--mcp-config`, codex config. Confirm tool appears in
a headless session. ~small, no app code. Unblocks WS3's exact per-adapter args.

**WS1 — Visibility control ops.** Add `runs.inbox.get`, `runs.context.get`,
`docs.list/read/write` to `shared/control.ts`, `spire-control.ts`,
`capabilities.ts`, `database.ts` (+ collaboration read helpers), with schema,
annotation, MCP coverage, and tests (authority/parity pattern from prior Task 8).

**WS2 — Agent MCP server.** New `src/mcp/agent-server.ts` + build entry:
reuse `ControlSocketClient`/token, filter to the §5.3 tool set, force identity
from env. Test against a fixture control channel (mirroring `mcp.test.ts`).

**WS3 — Per-adapter injection.** Add `buildAgentMcpConfig(env, identity)` seam to
`opencode.ts`, `claude-code.ts`, `codex.ts`; main process writes config + sets
env/flag at spawn. Respect existing `abort`/timeout/`cwd` behavior.

**WS4 — Worktree mirror.** In `node-worktree.ts` / run setup, create the
gitignored `.spire/` symlink for integration + node worktrees; wire delivery to
refresh inbox.md (already the same bytes via symlink). Tests: native tool read,
.gitignore exclusion from `git status`, no scope-violation on `.spire` writes.

**WS5 — Context packet + docs layering.** Extend `buildContextPacket` to link the
mirrored docs; define group/shared layers in the layout; update CollaborationPane
to render `.spire/docs/…`.

**WS6 — Live notifications (best-effort).** New-inbox MCP logging notification;
optional.

## 10. Open decisions for review

- **MCP transport for the agent server**: stdio is simplest and matches `type:
  "local"`/`"command"` on opencode+claude; confirm codex in WS0.
- **Group/shared docs layers**: exact hierarchy (`docs/<groupId>/`) — settle in
  WS4/WS5.
- **`docs.write` append-only vs create**: append-only for generated kinds,
  overwrite-able for free-form `shared.md`.
- **Expose the new ops to external sidecar too** (recommended: yes, they are
  generally useful) vs agent-only.

## 11. Risks

- **Codex MCP availability/format** — mitigated by WS0 spike before any adapter
  work; codex can ship as a follow-up if MCP-in-exec is unsupported.
- **Context bloat** — many MCP tools add tokens; the curated §5.3 set is small
  and read-biased. Admin ops excluded.
- **Symlink in worktree** — gitignored and read-only-from-repo perspective;
  must not be treated as tracked content (covered by WS4 tests).
- **E2E** — fixture harness (`src/main/harness/fixture.ts`) already exists; new
  specs use it offline so no paid models/CLIs are required.

## 12. Reference

- Prior plan: `docs/superpowers/plans/2026-07-30-graph-native-corporate-workflows.md`
- MCP registry: `src/mcp/tool-registry.ts` (`MCP_TOOLS` derives from
  `CONTROL_CAPABILITIES`), `src/mcp/index.ts`, `src/mcp/socket-client.ts`
- Control ops: `src/shared/control.ts`, `src/main/control/capabilities.ts`,
  `src/main/control/spire-control.ts`
- Collaboration: `src/main/collaboration/workspace.ts`
- Harness spawn: `src/main/harness/{opencode,codex,claude-code}.ts`
- Worktrees: `src/main/worktree.ts`, `src/main/workspace/node-worktree.ts`
- OpenCode MCP/config docs: opencode.ai/docs/mcp-servers, opencode.ai/docs/config
- Claude Code MCP: code.claude.com/docs/en/mcp + CLI reference (`--mcp-config`)