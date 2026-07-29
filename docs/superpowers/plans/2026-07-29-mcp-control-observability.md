# MCP Control and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give same-user local MCP clients complete semantic control of Spire and live, persisted, recursively redacted execution traces.

**Architecture:** Extract a headless `SpireControl` module shared by Electron IPC and a bundled MCP stdio sidecar. The Electron main process owns execution and exposes a private authenticated Unix socket; the sidecar translates MCP tools and resources into control requests. A normalized trace journal becomes the source of truth for live debugging.

**Tech Stack:** TypeScript, Zod 4, Electron IPC, Node Unix sockets, SQLite/better-sqlite3, `@modelcontextprotocol/sdk`, Vitest, Playwright, MCP Inspector.

## Global Constraints

- Spire remains Linux-first and local-only.
- MCP exposes semantic product operations, not DOM, mouse, or screenshot automation.
- Any process running as the same OS user is fully trusted after reading the mode-`0600` socket token.
- Prompts, responses, tool activity, stdout/stderr, timings, routing data, and failures are persisted only after recursive secret redaction.
- Trace retention is 30 days or 1 GiB, whichever limit is reached first.
- Existing graph, run, worktree, layout, and renderer behavior must remain compatible.
- Every public control operation must have an MCP mapping enforced by an automated coverage test.

---

### Task 1: Define the control and trace contracts

**Files:**
- Create: `src/shared/control.ts`
- Create: `src/shared/trace.ts`
- Create: `src/shared/control.test.ts`
- Modify: `src/shared/api.ts`

**Interfaces:**
- Produces `ControlOperationMap`, `ControlOperationName`, `ControlContext`, `ControlCapability`, `TraceEvent`, `TraceFilter`, `TraceCursor`, `TracePage`, `TraceListener`, `PageInput`, `GraphRef`, `GraphPage`, `RepositoryValidation`, `RunQuery`, `RunPage`, `Diagnostics`, and the initial single-OpenCode `HarnessStatus`.
- `SpireControl.execute()` and all adapters use these exact shared types.

- [ ] **Step 1: Write failing schema tests**

Cover rejection of unknown operations, malformed IDs, invalid cursors, oversized trace limits, and non-JSON trace payloads. Assert that valid capability metadata includes `readOnly`, `destructive`, `idempotent`, `inputSchema`, and `outputSchema`.

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run src/shared/control.test.ts`

Expected: FAIL because `control.ts` and `trace.ts` do not exist.

- [ ] **Step 3: Implement the contracts**

Define the typed operation map with these initial names:

```ts
type ControlOperationMap = {
  "state.get": { input: Record<string, never>; output: AppSnapshot };
  "diagnostics.get": { input: Record<string, never>; output: Diagnostics };
  "graphs.list": { input: PageInput; output: GraphPage };
  "graphs.get": { input: GraphRef; output: GraphDefinition };
  "graphs.save": { input: UpdateGraphInput; output: GraphDefinition };
  "repositories.validate": {
    input: { path: string };
    output: RepositoryValidation;
  };
  "runs.list": { input: RunQuery; output: RunPage };
  "runs.get": { input: { runId: string }; output: RunRecord };
  "runs.start": { input: StartRunInput; output: RunRecord };
  "runs.stop": { input: { runId: string }; output: RunRecord };
  "runs.retry": { input: { runId: string }; output: RunRecord };
  "runs.artifacts.get": { input: { runId: string }; output: RunArtifacts };
  "worktrees.cleanup": { input: { runId: string }; output: RunRecord };
  "layouts.list": { input: { graphId: string }; output: WorkspaceLayoutRecord[] };
  "layouts.save": { input: WorkspaceLayoutRecord; output: { saved: true } };
  "layouts.reset": { input: { graphId: string }; output: { reset: true } };
  "harnesses.list": { input: Record<string, never>; output: HarnessStatus[] };
  "harnesses.models": { input: { harnessId: string }; output: ModelOption[] };
  "traces.query": { input: TraceFilter; output: TracePage };
  "traces.tail": { input: TraceCursor; output: TracePage };
};
```

- [ ] **Step 4: Run the shared tests**

Run: `pnpm vitest run src/shared/control.test.ts src/shared/domain.test.ts src/shared/workspace.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/control.ts src/shared/trace.ts src/shared/control.test.ts src/shared/api.ts
git commit -m "feat: define Spire control and trace contracts"
```

### Task 2: Add the append-only trace journal

**Files:**
- Create: `src/main/trace-journal.ts`
- Create: `src/main/trace-journal.test.ts`
- Modify: `src/main/database.ts`
- Modify: `src/main/database.test.ts`

**Interfaces:**
- Consumes `TraceEvent`, `TraceFilter`, and `TracePage`.
- Produces `TraceJournal.append()`, `query()`, `subscribe()`, `prune()`, and `close()`.

- [ ] **Step 1: Write failing persistence and redaction tests**

Test sequence ordering, correlation filters, cursor pagination, live subscription, restart persistence, recursive key redaction, bearer-token redaction inside strings, and pruning by age and byte budget.

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/main/trace-journal.test.ts src/main/database.test.ts`

Expected: FAIL because the journal and `trace_events` table are absent.

- [ ] **Step 3: Implement SQLite storage**

Create `trace_events` with indexed `sequence`, `timestamp`, `correlation_id`, `run_id`, `node_id`, `harness_id`, `provider_id`, and `request_id` fields. Store redacted payload JSON and its UTF-8 byte count. Run pruning after startup and every 1,000 appends.

- [ ] **Step 4: Implement one redaction path**

All trace producers must call the journal with raw payloads; the journal performs recursive redaction before persistence and before notifying subscribers. Never duplicate redaction logic in harness, provider, MCP, or renderer modules.

- [ ] **Step 5: Verify the journal**

Run: `pnpm vitest run src/main/trace-journal.test.ts src/main/database.test.ts`

Expected: PASS, including a test proving secrets are absent from the SQLite file.

- [ ] **Step 6: Commit**

```bash
git add src/main/trace-journal.ts src/main/trace-journal.test.ts src/main/database.ts src/main/database.test.ts
git commit -m "feat: persist redacted execution traces"
```

### Task 3: Extract the shared `SpireControl` module

**Files:**
- Create: `src/main/control/spire-control.ts`
- Create: `src/main/control/capabilities.ts`
- Create: `src/main/control/spire-control.test.ts`
- Modify: `src/main/app-service.ts`
- Modify: `src/main/run-engine.ts`

**Interfaces:**
- Consumes the database, run engine, harness facade, worktree backend, and trace journal through constructor injection.
- Produces `execute<Name extends ControlOperationName>()`, `subscribe()`, and `listCapabilities()`.

- [ ] **Step 1: Write failing control tests**

Use in-memory fakes to cover every operation in `ControlOperationMap`, including input validation, missing records, graph versioning, repository validation, run lifecycle, artifact retrieval, worktree cleanup, and trace queries.

- [ ] **Step 2: Run the control tests**

Run: `pnpm vitest run src/main/control/spire-control.test.ts`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement capability-driven dispatch**

Register each operation once with its schemas, annotations, and handler. `execute()` validates input, records start/success/failure trace events with a generated correlation ID, validates output, and returns typed data.

- [ ] **Step 4: Route existing service behavior through control**

Keep `AppService` temporarily as a compatibility facade, but make every method delegate to `SpireControl`. Move repository access validation out of renderer-facing IPC. Return patch content as a semantic artifact; keep native save dialogs in the Electron adapter.

- [ ] **Step 5: Verify control coverage**

Run: `pnpm vitest run src/main/control/spire-control.test.ts src/main/run-engine.test.ts src/main/worktree.test.ts`

Expected: PASS and the capability count equals the keys in `ControlOperationMap`.

- [ ] **Step 6: Commit**

```bash
git add src/main/control src/main/app-service.ts src/main/run-engine.ts
git commit -m "refactor: centralize app behavior in SpireControl"
```

### Task 4: Convert Electron IPC into a control adapter

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/api.ts`
- Create: `src/main/ipc.test.ts`

**Interfaces:**
- Consumes `SpireControl`.
- Produces the existing `SpireApi` renderer interface and generic control subscription without allowing arbitrary IPC channel invocation.

- [ ] **Step 1: Write failing IPC contract tests**

Assert that each renderer operation maps to one registered control capability, malformed payloads are rejected, Electron-only dialogs remain in IPC, and no handler bypasses `SpireControl`.

- [ ] **Step 2: Run the IPC tests**

Run: `pnpm vitest run src/main/ipc.test.ts`

Expected: FAIL against direct `AppService` handlers.

- [ ] **Step 3: Implement the adapter**

Preserve the narrow preload surface. Map repository selection to an Electron dialog followed by `repositories.validate`; map patch export to `runs.artifacts.get` followed by a save dialog. Forward trace notifications through a dedicated allowlisted channel.

- [ ] **Step 4: Verify renderer compatibility**

Run: `pnpm typecheck && pnpm vitest run src/main/ipc.test.ts src/shared/workspace.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts src/main/ipc.test.ts src/preload/index.ts src/shared/api.ts
git commit -m "refactor: route Electron IPC through SpireControl"
```

### Task 5: Add the authenticated local control socket

**Files:**
- Create: `src/main/control/socket-server.ts`
- Create: `src/main/control/socket-protocol.ts`
- Create: `src/main/control/socket-server.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes `SpireControl`.
- Produces newline-delimited request, response, subscribe, event, unsubscribe, and ping envelopes over a Unix socket.

- [ ] **Step 1: Write failing socket tests**

Cover token authentication, mode checks, request IDs, concurrent requests, subscriptions, malformed frames, slow consumers, reconnects, stale socket cleanup, and shutdown.

- [ ] **Step 2: Run the socket tests**

Run: `pnpm vitest run src/main/control/socket-server.test.ts`

Expected: FAIL because the server is absent.

- [ ] **Step 3: Implement the socket**

Create the socket and a random 32-byte token beneath Spire user data. Apply directory mode `0700` and token mode `0600`. Reject unauthenticated frames before parsing operation payloads. Cap each frame at 1 MiB and disconnect clients that exceed the bounded event queue.

- [ ] **Step 4: Wire lifecycle**

Start the socket after database/control initialization and close it before the database on application shutdown. Remove only the socket file owned by the current process.

- [ ] **Step 5: Verify**

Run: `pnpm vitest run src/main/control/socket-server.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/control/socket-server.ts src/main/control/socket-protocol.ts src/main/control/socket-server.test.ts src/main/index.ts
git commit -m "feat: expose authenticated local control socket"
```

### Task 6: Build the MCP stdio sidecar

**Files:**
- Create: `src/mcp/index.ts`
- Create: `src/mcp/socket-client.ts`
- Create: `src/mcp/tool-registry.ts`
- Create: `src/mcp/resources.ts`
- Create: `src/mcp/mcp.test.ts`
- Modify: `package.json`
- Modify: `forge.config.ts`

**Interfaces:**
- Consumes the control socket protocol and capability registry.
- Produces the `spire-mcp` executable, MCP tools, resources, logging notifications, and structured tool results.

- [ ] **Step 1: Add the MCP SDK and write failing registry tests**

Install `@modelcontextprotocol/sdk` as a runtime dependency. Assert exact tool names, annotations, input schemas, output schemas, resource templates, and complete capability coverage.

- [ ] **Step 2: Run the MCP tests**

Run: `pnpm vitest run src/mcp/mcp.test.ts`

Expected: FAIL because no MCP server exists.

- [ ] **Step 3: Implement MCP mappings**

Map control names to stable MCP names such as `spire_graphs_list`, `spire_runs_start`, `spire_runs_stop`, `spire_run_artifacts_get`, `spire_worktrees_cleanup`, `spire_traces_query`, and `spire_traces_tail`. Return `structuredContent` plus concise text summaries.

- [ ] **Step 4: Implement resources and live logs**

Register `spire://state`, graph, run, artifact, and trace resource templates. Convert trace subscriptions into MCP logging notifications. If Spire is not running, return one actionable error containing the expected socket path and launch instruction.

- [ ] **Step 5: Package the executable**

Add a `spire:mcp` development script and ensure Electron Forge includes the compiled sidecar and executable shim in packaged builds.

- [ ] **Step 6: Verify**

Run: `pnpm typecheck && pnpm vitest run src/mcp/mcp.test.ts`

Expected: PASS with zero uncovered control capabilities.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml forge.config.ts src/mcp
git commit -m "feat: add full-control MCP sidecar"
```

### Task 7: Move the Live Stream pane to the trace journal

**Files:**
- Modify: `src/renderer/store.ts`
- Modify: `src/renderer/panes/LiveStreamPane.tsx`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/panes/LiveStreamPane.test.tsx`

**Interfaces:**
- Consumes trace pages and subscription events.
- Produces filtering by run, node, subsystem, level, kind, correlation ID, and free text.

- [ ] **Step 1: Write failing renderer tests**

Cover initial pagination, live append, reconnect from cursor, redaction display, filtering, bounded in-memory rows, copy-event JSON, and correlation navigation.

- [ ] **Step 2: Implement the trace-backed store**

Keep at most 5,000 rendered rows, load older rows on demand, and preserve the last cursor across pane remounts. Do not duplicate persisted traces in Zustand.

- [ ] **Step 3: Verify**

Run: `pnpm vitest run src/renderer/panes/LiveStreamPane.test.tsx && pnpm typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store.ts src/renderer/panes/LiveStreamPane.tsx src/renderer/panes/LiveStreamPane.test.tsx src/preload/index.ts
git commit -m "feat: add trace-backed live debugging pane"
```

### Task 8: End-to-end verification and documentation

**Files:**
- Create: `e2e/mcp.spec.ts`
- Modify: `README.md`
- Modify: `docs/ui-redesign-plan.md` only if its architecture summary becomes inaccurate

**Interfaces:**
- Produces documented MCP setup snippets for Codex, Claude Code, OpenCode, and generic stdio clients.

- [ ] **Step 1: Add end-to-end scenarios**

Launch seeded Spire, connect the sidecar, inspect state, save a graph, start/stop/retry a mocked run, tail traces, retrieve artifacts, and clean a managed worktree. Verify invalid tokens and an absent app fail safely.

- [ ] **Step 2: Run the complete verification suite**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Expected: every command exits zero.

- [ ] **Step 3: Inspect with MCP Inspector**

Run: `npx @modelcontextprotocol/inspector pnpm spire:mcp`

Expected: all tools and resources enumerate successfully; a live trace subscription receives run events.

- [ ] **Step 4: Document operation coverage and trust**

Document that the sidecar requires the desktop app to be running, trusts same-user local processes, exposes semantic operations only, and never returns unredacted secrets.

- [ ] **Step 5: Commit**

```bash
git add e2e/mcp.spec.ts README.md docs/ui-redesign-plan.md
git commit -m "test: verify MCP control and live debugging"
```

## Completion Criteria

- Electron IPC and MCP exercise the same `SpireControl` handlers.
- Every registered control capability has an MCP tool or resource mapping.
- An MCP client can perform the complete graph/run/artifact/worktree lifecycle.
- Live trace attachment works during an active run and after reconnect.
- Secret fixtures never appear in SQLite, MCP output, renderer output, or logs.
- Existing tests and packaged desktop behavior remain green.
