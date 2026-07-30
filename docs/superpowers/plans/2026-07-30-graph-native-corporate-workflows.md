# Graph-Native Corporate Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Spire's fixed planner/implementer loop with a visual, durable corporate workflow engine whose bespoke agent nodes can run through OpenCode, Codex, or Claude Code, collaborate through shared artifacts, branch and loop, and apply authorized runtime plan changes at checkpoints.

**Architecture:** Saved graph definitions are immutable, versioned workflow templates. A run compiles one graph version into a separate persisted execution plan; the scheduler changes that plan, never the source graph, when authorized nodes reroute or repair work. Harness-specific behavior stays behind adapters, collaboration uses app-managed Markdown plus isolated Git worktrees, and every runtime capability remains available through `SpireControl` and MCP.

**Tech Stack:** TypeScript, Zod, Electron, React 19, `@xyflow/react`, Zustand, SQLite/`better-sqlite3`, Node child processes, OpenCode SDK, Codex JSONL, Claude Code stream JSON, MCP SDK, Vitest, Playwright.

## Global Constraints

- Commit `c86e926` (trace echo-chamber and run-event bound fix) is a required baseline.
- This plan supersedes `2026-07-29-multi-harness-support.md`; do not preserve its two-role or bounded-loop assumptions.
- OmniRoute/provider routing follows this plan and must consume the resulting graph and harness contracts.
- A node's title or role label has no execution or authorization semantics.
- OpenCode, Codex, and Claude Code are the production harnesses for this release; Hermes is not part of this release.
- Native CLI authentication remains owned by each harness; Spire never stores native harness credentials.
- One workflow may be active at a time, but its nodes may execute concurrently when workspace isolation permits.
- Runtime changes modify only the run's execution plan until a user explicitly promotes the result to a new saved graph version.
- Collaboration memory is app-managed Markdown; no vector store, long-term memory service, or knowledge graph is introduced.
- Multi-host execution, OmniRoute, autonomous graph optimization, and third-party block plugins remain separate follow-up projects.
- All repository edits happen in Spire-managed worktrees; communication files stay outside Git diffs.
- Every new control capability must have matching MCP coverage, input/output validation, annotations, traces, and tests.

---

### Task 1: Define graph v2, execution, collaboration, and authority contracts

**Files:**
- Modify: `src/shared/domain.ts`
- Create: `src/shared/execution.ts`
- Create: `src/shared/collaboration.ts`
- Create: `src/shared/domain.test.ts`
- Create: `src/shared/execution.test.ts`

**Interfaces:**
- Produces `GraphDefinitionV2`, `GraphNode`, `AgentNode`, `DecisionNode`, `CheckpointNode`, `SubgraphNode`, `GraphGroup`, `GraphEdge`, `NodeAuthority`, `NodeOutcome`, `ExecutionPlan`, `NodeExecution`, `PlanPatch`, and `CollaborationMessage`.

- [ ] **Step 1: Write failing graph and execution schema tests**

Cover one-node graphs, mixed node kinds, nested visual groups, subgraph references, cycles, all/any activation, typed success/failure/selected edges, duplicate IDs, invalid group references, invalid authority actions, execution revisions, stale patches, and strict outcome/message validation.

- [ ] **Step 2: Run the focused tests and confirm the legacy schema fails**

Run:

```bash
pnpm vitest run src/shared/domain.test.ts src/shared/execution.test.ts
```

Expected: FAIL because the current schema requires exactly two OpenCode planner/implementer nodes.

- [ ] **Step 3: Implement the stable graph v2 shapes**

Use these discriminants and names throughout later tasks:

```ts
type HarnessId = "opencode" | "codex" | "claude-code";
type NodeKind = "agent" | "decision" | "checkpoint" | "subgraph";
type PlanMutation =
  | "retry" | "skip" | "reorder" | "reroute" | "pause"
  | "replace" | "insert" | "remove" | "edit";

type NodeAuthority = {
  scope: "self" | "connected" | "group" | "graph";
  actions: PlanMutation[];
};

type AgentNode = {
  kind: "agent";
  id: string;
  name: string;
  roleLabel?: string;
  job: string;
  harnessId: HarnessId;
  modelId: string;
  access: { mode: "read-only" | "workspace-write"; writeScopes: string[] };
  authority: NodeAuthority;
  activation: "all" | "any";
  maxVisits: number;
  groupId?: string;
  position: { x: number; y: number };
};

type DecisionNode = Omit<AgentNode, "kind"> & { kind: "decision" };
type CheckpointNode = {
  kind: "checkpoint";
  id: string;
  name: string;
  mode: "automatic" | "manual";
  groupId?: string;
  position: { x: number; y: number };
};
type SubgraphNode = {
  kind: "subgraph";
  id: string;
  name: string;
  graphId: string;
  graphVersion?: number;
  groupId?: string;
  position: { x: number; y: number };
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "dependency" | "handoff" | "review" | "approval" | "escalation";
  when: "always" | "success" | "failure" | "selected";
  label: string;
};
```

Set graph defaults to `maxSteps: 100`, agent `maxVisits: 3`, activation `"all"`, read-only access with no write scopes, self-scoped authority, and no mutation actions. Defaults are editable safety bounds, not role semantics.

- [ ] **Step 4: Define execution and outcome contracts**

Use persisted node states:

```ts
type NodeExecutionStatus =
  | "queued" | "running" | "waiting" | "succeeded"
  | "failed" | "skipped" | "cancelled";

type NodeOutcome = {
  status: "succeeded" | "failed";
  summary: string;
  artifacts: { name: string; path: string; mediaType?: string }[];
  messages: CollaborationMessageDraft[];
  selectedEdgeIds: string[];
  patch?: PlanPatchDraft;
};

type ExecutionPlan = {
  runId: string;
  graphId: string;
  graphVersion: number;
  revision: number;
  status: "running" | "paused" | "succeeded" | "failed" | "needs_attention";
  stepCount: number;
  nodes: NodeExecution[];
  edges: GraphEdge[];
  patches: AppliedPlanPatch[];
  updatedAt: string;
};

type CollaborationMessageDraft = {
  recipient:
    | { kind: "node"; id: string }
    | { kind: "group"; id: string }
    | { kind: "successors" };
  kind: "question" | "handoff" | "report" | "decision";
  subject: string;
  body: string;
  artifactPaths: string[];
};

type PlanPatchOperation =
  | { action: "retry" | "skip" | "remove"; nodeId: string }
  | { action: "reorder"; nodeId: string; beforeNodeId: string }
  | { action: "reroute"; enableEdgeIds: string[]; disableEdgeIds: string[] }
  | { action: "pause"; reason: string }
  | { action: "replace"; nodeId: string; replacement: GraphNode }
  | { action: "insert"; node: GraphNode; edges: GraphEdge[] }
  | { action: "edit"; nodeId: string; replacement: GraphNode };

type PlanPatchDraft = {
  baseRevision: number;
  reason: string;
  operations: PlanPatchOperation[];
};

type AppliedPlanPatch = PlanPatchDraft & {
  id: string;
  actorNodeId: string;
  appliedRevision: number;
  appliedAt: string;
  rolledBackBy?: string;
};
```

Patch operations use the same stable mutation names as `NodeAuthority`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm vitest run src/shared/domain.test.ts src/shared/execution.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/shared/domain.ts src/shared/domain.test.ts src/shared/execution.ts src/shared/execution.test.ts src/shared/collaboration.ts
git commit -m "feat: define graph-native workflow contracts"
```

### Task 2: Migrate legacy graphs and persist execution state

**Files:**
- Modify: `src/main/database.ts`
- Modify: `src/main/database.test.ts`
- Create: `src/main/graph-migration.ts`
- Create: `src/main/graph-migration.test.ts`

**Interfaces:**
- Consumes the Task 1 schemas.
- Produces `readGraphDefinition(raw): GraphDefinitionV2` and database methods for execution plans, node executions, messages, patches, and harness sessions.

- [ ] **Step 1: Write failing migration and persistence tests**

Read an existing `{type:"opencode", role:"planner"|"implementer"}` graph, preserve its graph/node IDs, instructions, positions, edges, versions, and model IDs, and normalize it to graph v2. Round-trip a complete execution plan, message, patch, and node-scoped session through SQLite.

- [ ] **Step 2: Verify failure**

Run:

```bash
pnpm vitest run src/main/graph-migration.test.ts src/main/database.test.ts
```

Expected: FAIL because graph v2 migration and execution tables do not exist.

- [ ] **Step 3: Implement explicit legacy normalization**

Legacy planner nodes become read-only OpenCode agent nodes; legacy implementers become workspace-write OpenCode agent nodes with `writeScopes: ["**/*"]`. Convert legacy edge conditions to success/failure/selected routes without changing IDs. Read legacy and v2; save only v2.

- [ ] **Step 4: Add normalized persistence**

Add tables keyed by run ID and stable sequence/revision for execution plans, node executions, collaboration messages, plan patches, and harness sessions. Store graph and plan JSON only after strict Zod validation. Add methods that update a plan and its node state inside one SQLite transaction.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm vitest run src/main/graph-migration.test.ts src/main/database.test.ts
pnpm typecheck
```

Expected: PASS with restart round-trips.

Commit:

```bash
git add src/main/database.ts src/main/database.test.ts src/main/graph-migration.ts src/main/graph-migration.test.ts
git commit -m "feat: persist graph v2 execution state"
```

### Task 3: Introduce the harness registry and normalize OpenCode

**Files:**
- Create: `src/shared/harness.ts`
- Create: `src/shared/harness.test.ts`
- Create: `src/main/harness/adapter.ts`
- Create: `src/main/harness/registry.ts`
- Create: `src/main/harness/registry.test.ts`
- Move: `src/main/opencode.ts` to `src/main/harness/opencode.ts`
- Create: `src/main/harness/opencode.test.ts`

**Interfaces:**
- Produces:

```ts
type HarnessSessionRef = {
  harnessId: HarnessId;
  sessionId: string;
  directory: string;
};

type HarnessRunInput = {
  runId: string;
  nodeId: string;
  directory: string;
  session?: HarnessSessionRef;
  modelId: string;
  job: string;
  context: string;
  access: AgentNode["access"];
  outputSchema: Record<string, unknown>;
  onSession(ref: HarnessSessionRef): void;
  onEvent(event: HarnessEvent): void;
};

type HarnessRunResult = {
  session: HarnessSessionRef;
  output: unknown;
};

interface HarnessAdapter {
  readonly id: HarnessId;
  probe(): Promise<HarnessStatus>;
  listModels(): Promise<ModelOption[]>;
  run(input: HarnessRunInput): Promise<HarnessRunResult>;
  abort(session: HarnessSessionRef): Promise<void>;
  close(): Promise<void>;
}

interface HarnessRegistry {
  get(id: HarnessId): HarnessAdapter;
  probeAll(): Promise<HarnessStatus[]>;
  closeAll(): Promise<void>;
}
```

- [ ] **Step 1: Write failing registry and event-normalization tests**

Cover deterministic adapter order, duplicate and unknown IDs, isolated probe failures, close-all behavior, session creation, assistant text, reasoning, tool start/progress/result, approval, usage, stdout/stderr, warning, error, timeout, and cancellation events.

- [ ] **Step 2: Verify failure**

Run:

```bash
pnpm vitest run src/shared/harness.test.ts src/main/harness/registry.test.ts
```

Expected: FAIL because the registry and normalized contracts are absent.

- [ ] **Step 3: Implement the registry and move OpenCode**

Move OpenCode without functional regressions. Translate SDK events into normalized harness events, emit session references immediately, accept a requested `NodeOutcome` JSON Schema, and keep one automatic structured-output repair attempt in the adapter-independent caller.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm vitest run src/shared/harness.test.ts src/main/harness/registry.test.ts src/main/harness/opencode.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/shared/harness.ts src/shared/harness.test.ts src/main/harness src/main/opencode.ts
git commit -m "refactor: introduce normalized harness registry"
```

### Task 4: Add Claude Code and Codex adapters

**Files:**
- Create: `src/main/harness/claude-code.ts`
- Create: `src/main/harness/claude-code.test.ts`
- Create: `src/main/harness/codex.ts`
- Create: `src/main/harness/codex.test.ts`
- Create: `src/main/harness/fixtures/claude-stream.jsonl`
- Create: `src/main/harness/fixtures/codex-events.jsonl`

**Interfaces:**
- Consumes `HarnessAdapter`, `HarnessRunInput`, `NodeOutcome`, and `HarnessSessionRef`.
- Produces complete `claude-code` and `codex` adapters.

- [ ] **Step 1: Write fixture-driven failing Claude Code tests**

Cover executable/version/auth probing, stream JSON parsing, session creation/resume, tool and usage events, JSON-schema output, malformed/oversized lines, non-zero exit, timeout, abort, and stderr redaction.

- [ ] **Step 2: Implement Claude Code execution**

Spawn argument arrays without a shell. Use print mode with stream JSON, structured output, resume/session flags, the supplied working directory, and tool restrictions derived from node access. Parse JSONL incrementally with a 1 MiB line cap and terminate timed-out processes.

- [ ] **Step 3: Write fixture-driven failing Codex tests**

Cover executable/version/auth probing, `codex exec --json`, resume, item/tool events, token usage, output schema, sandbox selection, malformed/oversized lines, non-zero exit, timeout, and SIGTERM-to-SIGKILL cancellation.

- [ ] **Step 4: Implement Codex execution**

Use `codex exec --json`, `--output-schema`, `--cd`, and native resume support. Select `read-only` or `workspace-write` sandbox from node access. Write temporary schemas beneath Spire run data with mode `0600`; never use dangerous bypass flags.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm vitest run src/main/harness/claude-code.test.ts src/main/harness/codex.test.ts
pnpm typecheck
```

Expected: PASS without requiring installed CLIs or paid prompts.

Commit:

```bash
git add src/main/harness/claude-code.ts src/main/harness/claude-code.test.ts src/main/harness/codex.ts src/main/harness/codex.test.ts src/main/harness/fixtures
git commit -m "feat: add Claude Code and Codex harnesses"
```

### Task 5: Replace the fixed loop with a durable graph scheduler

**Files:**
- Create: `src/main/scheduler/graph-compiler.ts`
- Create: `src/main/scheduler/scheduler.ts`
- Create: `src/main/scheduler/scheduler.test.ts`
- Modify: `src/main/run-engine.ts`
- Modify: `src/main/run-engine.test.ts`

**Interfaces:**
- Produces `compileExecutionPlan(graph, runId)`, `GraphScheduler.start()`, `GraphScheduler.stop()`, `GraphScheduler.resume()`, and deterministic ready-node selection.

- [ ] **Step 1: Write failing compiler and scheduler tests**

Cover linear execution, parallel branches, all/any joins, success/failure/selected routing, loops, max visits, max steps, automatic/manual checkpoints, nested subgraph expansion, deterministic ordering, stop/retry, no-ready-node deadlock, and restart recovery.

- [ ] **Step 2: Verify failure**

Run:

```bash
pnpm vitest run src/main/scheduler/scheduler.test.ts src/main/run-engine.test.ts
```

Expected: FAIL while `RunEngine` still searches for planner and implementer roles.

- [ ] **Step 3: Implement compilation and scheduling**

Resolve every subgraph to an exact graph version at compile time and namespace nested node IDs by subgraph instance. Persist the plan before execution and after every node transition. A node becomes ready only when its activation policy and incoming edge conditions are satisfied. Each loop visit creates a new `NodeExecution` attempt rather than overwriting history.

- [ ] **Step 4: Route agent work through `HarnessRegistry`**

Resolve the adapter from each node, persist its session as soon as it is reported, pass normalized events to the existing run-event/trace pipeline, parse `NodeOutcome`, retry malformed output once, and store the final outcome before activating successors.

- [ ] **Step 5: Implement restart behavior**

On app restart, convert orphaned `running` attempts to `failed`, persist a failure checkpoint, and resume routing from that checkpoint. Do not mark the entire run failed merely because Spire closed.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm vitest run src/main/scheduler/scheduler.test.ts src/main/run-engine.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/main/scheduler src/main/run-engine.ts src/main/run-engine.test.ts
git commit -m "feat: execute durable corporate workflow graphs"
```

### Task 6: Add Markdown collaboration and isolated node workspaces

**Files:**
- Create: `src/main/collaboration/workspace.ts`
- Create: `src/main/collaboration/workspace.test.ts`
- Create: `src/main/workspace/node-worktree.ts`
- Create: `src/main/workspace/node-worktree.test.ts`
- Modify: `src/main/scheduler/scheduler.ts`

**Interfaces:**
- Produces `CollaborationWorkspace`, `NodeWorkspaceCoordinator`, node context packets, scoped merge results, and conflict/failure outcomes.

- [ ] **Step 1: Write failing collaboration tests**

Cover node/group/successor recipients, deterministic Markdown paths, safe filenames, chronological indexes, artifact links, context packet filtering, app restart, and communication files staying outside Git status.

- [ ] **Step 2: Implement app-managed Markdown collaboration**

Create `<userData>/runs/<runId>/collaboration/` with per-node inboxes and append-only handoff, decision, report, and checkpoint documents. Build each context packet from the node job, run objective, incoming messages, relevant outputs, accessible repository paths, and authority.

- [ ] **Step 3: Write failing node-worktree tests**

Cover parallel non-overlapping changes, out-of-scope edits, clean merges, merge conflicts, failed-node cleanup, read-only nodes, source-repository preservation, and final run diff generation.

- [ ] **Step 4: Implement isolated write execution**

Read-only nodes use the run integration worktree. Each workspace-write attempt branches into a node worktree from the current checkpoint. Validate changed paths against `writeScopes`, commit successful scoped changes, and merge them into the integration branch at a checkpoint. Convert scope violations and merge conflicts into node failures eligible for failure routing.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm vitest run src/main/collaboration/workspace.test.ts src/main/workspace/node-worktree.test.ts src/main/scheduler/scheduler.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/main/collaboration src/main/workspace src/main/scheduler/scheduler.ts
git commit -m "feat: add agent collaboration and isolated workspaces"
```

### Task 7: Implement authorized runtime plan patches and rollback

**Files:**
- Create: `src/main/scheduler/plan-patcher.ts`
- Create: `src/main/scheduler/plan-patcher.test.ts`
- Modify: `src/main/scheduler/scheduler.ts`
- Modify: `src/main/database.ts`

**Interfaces:**
- Produces `validatePlanPatch(plan, actor, draft)`, `applyPlanPatch(...)`, `rollbackPlanPatch(...)`, and graph-version promotion input.

- [ ] **Step 1: Write failing authority and patch tests**

Cover every mutation action and scope, highest-tier full-graph edits, connected/group boundary rejection, invalid references, removal of running/completed nodes, stale base revisions, atomic multi-operation failure, audit records, rollback, and manual checkpoint pauses.

- [ ] **Step 2: Verify failure**

Run:

```bash
pnpm vitest run src/main/scheduler/plan-patcher.test.ts
```

Expected: FAIL because runtime patches are not implemented.

- [ ] **Step 3: Implement patch validation**

Allow patches only after node completion, at explicit checkpoints, or during failure recovery. Require `baseRevision === plan.revision`. Never remove or replace a running or completed attempt; a replacement creates a new execution node and marks only pending work as superseded. Validate the complete candidate plan before one transactional write.

- [ ] **Step 4: Implement rollback and promotion**

Rollback applies the inverse operation list as a new audited revision. Promotion creates a new saved graph version from the current runtime topology while stripping run states, attempt IDs, messages, and temporary replacement metadata.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm vitest run src/main/scheduler/plan-patcher.test.ts src/main/scheduler/scheduler.test.ts src/main/database.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/main/scheduler/plan-patcher.ts src/main/scheduler/plan-patcher.test.ts src/main/scheduler/scheduler.ts src/main/database.ts
git commit -m "feat: authorize runtime workflow adaptation"
```

### Task 8: Extend `SpireControl`, MCP, and preload APIs

**Files:**
- Modify: `src/shared/control.ts`
- Modify: `src/main/control/spire-control.ts`
- Modify: `src/mcp/tool-registry.ts`
- Modify: `src/mcp/resources.ts`
- Modify: `src/preload/index.ts`
- Test: `src/mcp/mcp.test.ts`

**Interfaces:**
- Adds operations for graph validation, plan inspection, node states, messages, patch application/rollback, checkpoint resume, and plan promotion.

- [ ] **Step 1: Write failing capability-parity tests**

For every new control operation, assert one registry handler, one MCP tool, matching Zod schemas, correct read-only/destructive/idempotent annotations, structured content, concise text, correlation traces, and actionable errors.

- [ ] **Step 2: Define the control operations**

Add stable operation names:

```ts
"graphs.validate"
"runs.plan.get"
"runs.nodes.list"
"runs.messages.list"
"runs.messages.send"
"runs.plan.patch"
"runs.plan.rollback"
"runs.checkpoint.resume"
"runs.plan.promote"
```

Expose MCP resources:

```text
spire://runs/{runId}/plan
spire://runs/{runId}/nodes/{nodeId}
spire://runs/{runId}/messages
spire://runs/{runId}/patches
```

- [ ] **Step 3: Implement through the existing control seam**

Keep renderer IPC and MCP as adapters over `SpireControl`; neither may call the scheduler or database directly. Return byte-bounded/paginated message and patch lists. Trace summaries only—never embed plan, message-list, or trace-query results recursively in success events.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm vitest run src/main/control src/mcp/mcp.test.ts
pnpm typecheck
pnpm build:mcp
```

Expected: PASS with the MCP sidecar connected to fixture control channels.

Commit:

```bash
git add src/shared/control.ts src/main/control src/mcp src/preload/index.ts
git commit -m "feat: expose corporate workflows through MCP"
```

### Task 9: Build the visual corporate workflow editor and live run view

**Files:**
- Modify: `src/renderer/panes/GraphCanvasPane.tsx`
- Modify: `src/renderer/panes/NodeInspectorPane.tsx`
- Create: `src/renderer/panes/CollaborationPane.tsx`
- Create: `src/renderer/panes/HarnessesPane.tsx`
- Modify: `src/renderer/store.ts`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes graph v2, plan/node/message control APIs, normalized harness status, and live run events.
- Produces editing and runtime inspection for all MVP node kinds and plan states.

- [ ] **Step 1: Write failing editor and runtime tests**

Cover palette insertion, typed connections, group nesting/collapse, subgraph selection, inspector editing, harness/model selection, authority presets plus custom permissions, file scopes, graph validation, keyboard access, runtime state overlays, plan diffs, rollback, messages, and responsive layouts.

- [ ] **Step 2: Implement graph editing**

Add palette entries for agent, decision, checkpoint, subgraph, and group blocks. Keep templates as editable initial values only. Split the inspector into job, runtime, access, authority, routing, checkpoint, and failure sections without assigning semantics to role labels.

- [ ] **Step 3: Implement live execution visualization**

Render queued/running/waiting/succeeded/failed/skipped/cancelled states, animated active edges, attempt counts, checkpoint pauses, and nested plan nodes. A selected runtime patch opens a before/after visual diff and exposes rollback when valid.

- [ ] **Step 4: Add collaboration and harness panes**

Show Markdown message indexes and previews, node/group recipients, produced artifacts, harness executable/version/auth state, model refresh, and remediation without exposing credentials.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm vitest run src/renderer
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/renderer
git commit -m "feat: visualize corporate agent workflows"
```

### Task 10: Verify a realistic workflow and document operation

**Files:**
- Create: `e2e/corporate-workflows.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Produces an offline fixture E2E suite, optional real-harness smoke procedure, and operator documentation.

- [ ] **Step 1: Add the offline E2E workflow**

Build a five-to-ten-node graph containing OpenCode, Codex, and Claude fixture adapters; parallel research, implementation, review, a decision route, an explicit checkpoint, a failed node, an authorized recovery patch, Markdown handoffs, and final convergence. Assert the canvas states and complete decision history.

- [ ] **Step 2: Add crash and security scenarios**

Restart the app at a checkpoint and resume. Attempt an unauthorized patch and out-of-scope write. Verify both fail without corrupting the integration worktree. Scan SQLite, Markdown collaboration, traces, MCP responses, and renderer state for secret fixtures.

- [ ] **Step 3: Document the workflow model**

Document block types, bespoke jobs, typed edges, groups/subgraphs, authority, plan-versus-graph behavior, Markdown collaboration, native harness authentication, file-scope isolation, failure routing, MCP setup, and promotion of a run plan to a graph version.

- [ ] **Step 4: Run complete verification**

Use Electron's embedded Node runtime for native SQLite tests when the shell ABI differs:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build:mcp
pnpm build
```

Expected: every command exits zero.

- [ ] **Step 5: Run optional real-harness smoke tests**

Probe installed OpenCode, Codex, and Claude Code CLIs without paid prompts first. When credentials and usage approval are present, run one harmless read-only node per harness and one mixed three-node workflow. Missing optional CLIs produce documented remediation, not a failed offline suite.

- [ ] **Step 6: Commit**

```bash
git add e2e/corporate-workflows.spec.ts README.md
git commit -m "test: verify graph-native corporate workflows"
```

## Completion Criteria

- Users can visually build, save, reopen, and run a five-to-ten-node corporate workflow.
- Node behavior comes entirely from its configured job, harness, access, routing, and authority—not its title.
- OpenCode, Codex, and Claude Code execute through one normalized harness contract.
- Parallel branches, joins, cycles, selected routes, checkpoints, subgraphs, and failure edges behave deterministically.
- Agents exchange scoped Markdown handoffs and repository artifacts.
- Write-capable parallel work is isolated, scope-checked, and merged without corrupting the source repository.
- Authorized nodes can patch a run plan at safe checkpoints; unauthorized or stale changes are rejected.
- App restarts resume from durable checkpoints.
- Every workflow capability is available through validated `SpireControl` and MCP operations.
- Runtime plans remain distinct from saved graph definitions until explicit promotion.
- OmniRoute can be implemented afterward without changing the harness or graph contracts.
