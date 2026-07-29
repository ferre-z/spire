# Multi-Harness Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each graph node independently run through OpenCode, Claude Code, Codex, or Hermes with normalized sessions, events, structured responses, and cancellation.

**Architecture:** Replace the OpenCode-specific seam with a `HarnessRegistry` and four native adapters. Keep protocol differences inside adapters while the run engine depends only on a small normalized interface. Persist harness session references by run and node so retry and recovery do not depend on process memory.

**Tech Stack:** TypeScript, Zod, Node child processes, OpenCode SDK, Claude Code stream JSON, Codex JSONL, Hermes ACP JSON-RPC, SQLite, Vitest, Playwright.

## Global Constraints

- Plan 1's `SpireControl` and trace journal are required and remain the only public control and observability seams.
- Harness selection is per node and mixed-harness graphs are supported.
- Existing stored graphs migrate to OpenCode without changing graph IDs.
- Native CLI authentication remains owned by each harness; Spire never stores native harness credentials.
- Planner nodes are read-only and implementer nodes may write only inside the Spire worktree.
- The graph remains a two-role bounded loop with one active run.
- Unsupported protocol events are omitted rather than fabricated.

---

### Task 1: Define harness, model, event, and session contracts

**Files:**
- Create: `src/shared/harness.ts`
- Create: `src/shared/harness.test.ts`
- Modify: `src/shared/domain.ts`
- Modify: `src/shared/domain.test.ts`

**Interfaces:**
- Produces `HarnessId`, `HarnessStatus`, `HarnessCapabilities`, `HarnessEvent`, `HarnessSessionRef`, `HarnessRunInput`, `HarnessRunResult`, and `ModelSelection`.

- [ ] **Step 1: Write failing schema and migration tests**

Cover all four harness IDs, normalized event variants, invalid session references, native model selections, unknown harness rejection, and migration of `{type:"opencode", model:"openrouter/x"}` nodes.

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/shared/harness.test.ts src/shared/domain.test.ts`

Expected: FAIL because the shared harness contracts do not exist.

- [ ] **Step 3: Implement the shared types**

Use these stable shapes:

```ts
type HarnessId = "opencode" | "claude-code" | "codex" | "hermes";

type ModelSelection = {
  source: "native" | "omniroute";
  modelId: string;
  comboId?: string;
};

type HarnessSessionRef = {
  harnessId: HarnessId;
  sessionId: string;
  directory: string;
};
```

Define discriminated harness events for lifecycle, assistant delta/final, reasoning, tool start/progress/result, approval, usage, stdout, stderr, warning, and error.

- [ ] **Step 4: Add explicit graph migration**

Read old graphs through a legacy schema and normalize them to `harnessId: "opencode"` and `model: {source:"native", modelId:<old value>}`. Save only the new schema.

- [ ] **Step 5: Verify**

Run: `pnpm vitest run src/shared/harness.test.ts src/shared/domain.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/harness.ts src/shared/harness.test.ts src/shared/domain.ts src/shared/domain.test.ts
git commit -m "feat: define multi-harness graph contracts"
```

### Task 2: Introduce the harness registry

**Files:**
- Create: `src/main/harness/adapter.ts`
- Create: `src/main/harness/registry.ts`
- Create: `src/main/harness/registry.test.ts`
- Move: `src/main/opencode.ts` to `src/main/harness/opencode.ts`

**Interfaces:**
- Produces:

```ts
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
}
```

- [ ] **Step 1: Write failing registry contract tests**

Assert deterministic adapter order, duplicate-ID rejection, unknown-ID errors, isolated probe failures, close-all behavior, and trace emission.

- [ ] **Step 2: Run the tests**

Run: `pnpm vitest run src/main/harness/registry.test.ts`

Expected: FAIL because the registry is absent.

- [ ] **Step 3: Implement the registry and adapt OpenCode**

Move OpenCode without changing its runtime behavior. Translate OpenCode events into normalized `HarnessEvent` values and expose capability probing through the registry.

- [ ] **Step 4: Verify OpenCode compatibility**

Run: `pnpm vitest run src/main/harness/registry.test.ts src/main/run-engine.test.ts`

Expected: PASS using only the OpenCode adapter.

- [ ] **Step 5: Commit**

```bash
git add src/main/harness src/main/opencode.ts src/main/run-engine.test.ts
git commit -m "refactor: introduce native harness registry"
```

### Task 3: Persist node-scoped harness sessions

**Files:**
- Modify: `src/shared/domain.ts`
- Modify: `src/main/database.ts`
- Modify: `src/main/run-engine.ts`
- Modify: `src/main/run-engine.test.ts`

**Interfaces:**
- Adds `sessions: Record<string, HarnessSessionRef>` to persisted run execution state, keyed by node ID.
- Removes the run engine's process-only planner/implementer session map.

- [ ] **Step 1: Write failing persistence tests**

Start a run, persist two node sessions, recreate the engine, retry the run, and assert that the correct harness/session/directory is resumed for each node.

- [ ] **Step 2: Run the tests**

Run: `pnpm vitest run src/main/run-engine.test.ts src/main/database.test.ts`

Expected: FAIL because sessions are memory-only.

- [ ] **Step 3: Implement persisted sessions**

Update the session reference as soon as an adapter reports session creation. Clear only the active process handle after completion; retain resumable session IDs with run history.

- [ ] **Step 4: Verify recovery behavior**

Run: `pnpm vitest run src/main/run-engine.test.ts src/main/database.test.ts`

Expected: PASS for new, resumed, stopped, failed, and crashed runs.

- [ ] **Step 5: Commit**

```bash
git add src/shared/domain.ts src/main/database.ts src/main/run-engine.ts src/main/run-engine.test.ts
git commit -m "feat: persist harness sessions by graph node"
```

### Task 4: Implement the Claude Code adapter

**Files:**
- Create: `src/main/harness/claude-code.ts`
- Create: `src/main/harness/claude-code.test.ts`
- Create: `src/main/harness/fixtures/claude-stream.jsonl`

**Interfaces:**
- Consumes `claude -p`, `--output-format stream-json`, `--session-id`/`--resume`, `--json-schema`, and tool restrictions.
- Produces normalized harness events and a final structured response.

- [ ] **Step 1: Write fixture-driven failing tests**

Cover probe/auth status, session creation, resume, text deltas, tool calls, usage, API retry events, structured output, malformed JSONL, non-zero exit, timeout, and abort.

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/main/harness/claude-code.test.ts`

Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement process execution**

Use argument arrays with `spawn`; never invoke a shell. For planners restrict tools to read/search capabilities. For implementers allow editing and shell tools inside the supplied worktree. Parse JSONL incrementally with a maximum line size and preserve stderr as trace events.

- [ ] **Step 4: Implement capability probing**

Probe executable presence, `--version`, `auth status`, and required help flags. Report installed, compatible, authenticated, and remediation text independently.

- [ ] **Step 5: Verify**

Run: `pnpm vitest run src/main/harness/claude-code.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/harness/claude-code.ts src/main/harness/claude-code.test.ts src/main/harness/fixtures/claude-stream.jsonl
git commit -m "feat: add Claude Code harness adapter"
```

### Task 5: Implement the Codex adapter

**Files:**
- Create: `src/main/harness/codex.ts`
- Create: `src/main/harness/codex.test.ts`
- Create: `src/main/harness/fixtures/codex-events.jsonl`

**Interfaces:**
- Consumes `codex exec --json`, `--output-schema`, `exec resume`, `--cd`, and sandbox modes.
- Produces normalized events, session references, structured final responses, and abort.

- [ ] **Step 1: Write fixture-driven failing tests**

Cover probe, new session, resume, item events, command/tool activity, final response, token usage, malformed JSONL, schema failure, process failure, timeout, and SIGTERM/SIGKILL abort escalation.

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/main/harness/codex.test.ts`

Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement Codex execution**

Generate a temporary JSON Schema file beneath Spire run data. Use `--sandbox read-only` for planners and `--sandbox workspace-write` for implementers. Pass the worktree through `--cd` and never use the dangerous bypass flags.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/main/harness/codex.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/harness/codex.ts src/main/harness/codex.test.ts src/main/harness/fixtures/codex-events.jsonl
git commit -m "feat: add Codex harness adapter"
```

### Task 6: Implement the Hermes ACP adapter

**Files:**
- Create: `src/main/harness/hermes.ts`
- Create: `src/main/harness/acp-client.ts`
- Create: `src/main/harness/hermes.test.ts`
- Create: `src/main/harness/fixtures/hermes-acp.jsonl`

**Interfaces:**
- Consumes `hermes acp` JSON-RPC over stdio.
- Produces initialize, session/new, session/load, session/prompt, session/update, permission response, and session/cancel behavior.

- [ ] **Step 1: Write failing ACP protocol tests**

Cover handshake capabilities, session creation/load, assistant chunks, thoughts, tool calls/updates, permission requests, final response, JSON-RPC errors, cancellation, process death, and request timeouts.

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/main/harness/hermes.test.ts`

Expected: FAIL because the ACP client and adapter are absent.

- [ ] **Step 3: Implement the ACP client**

Use monotonically increasing JSON-RPC IDs, a pending-request map, line-size limits, explicit timeouts, and deterministic rejection of pending requests when the subprocess exits.

- [ ] **Step 4: Implement Hermes mapping**

Map ACP content blocks and tool updates into normalized harness events. Deny planner write permissions and allow implementer permissions only for the run worktree. Send `session/cancel` before process termination.

- [ ] **Step 5: Verify**

Run: `pnpm vitest run src/main/harness/hermes.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/harness/acp-client.ts src/main/harness/hermes.ts src/main/harness/hermes.test.ts src/main/harness/fixtures/hermes-acp.jsonl
git commit -m "feat: add Hermes ACP harness adapter"
```

### Task 7: Route graph execution through the selected adapter

**Files:**
- Modify: `src/main/run-engine.ts`
- Modify: `src/main/run-engine.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/control/capabilities.ts`

**Interfaces:**
- Consumes `AgentNode.harnessId`, `HarnessRegistry`, persisted sessions, and normalized events.
- Extends `harnesses.list` and `harnesses.models` control operations.

- [ ] **Step 1: Write failing mixed-harness tests**

Test Claude planner → Codex implementer, Hermes planner → OpenCode implementer, retries using the original adapters, unavailable harness failure before worktree mutation, and stopping the active adapter only.

- [ ] **Step 2: Run the run-engine tests**

Run: `pnpm vitest run src/main/run-engine.test.ts`

Expected: FAIL while the engine still owns one harness.

- [ ] **Step 3: Implement registry routing**

Resolve the adapter from each node, pass the node model selection, persist its session, translate events into trace entries, and keep structured parsing/one-repair behavior authoritative in the run engine.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/main/run-engine.test.ts src/main/harness && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/run-engine.ts src/main/run-engine.test.ts src/main/index.ts src/main/control/capabilities.ts
git commit -m "feat: execute graph nodes with mixed harnesses"
```

### Task 8: Add harness management and per-node selection UI

**Files:**
- Create: `src/renderer/panes/HarnessesPane.tsx`
- Modify: `src/renderer/panes/NodeInspectorPane.tsx`
- Modify: `src/renderer/workspace/paneIds.ts`
- Modify: `src/renderer/workspace/defaultLayouts.ts`
- Modify: `src/renderer/store.ts`
- Create: `src/renderer/panes/HarnessesPane.test.tsx`

**Interfaces:**
- Consumes harness status/model control operations.
- Produces install/auth/capability diagnostics and per-node harness/model editing.

- [ ] **Step 1: Write failing UI tests**

Cover four harness cards, unavailable/auth-required states, refresh, remediation copy, per-node selection, free-text model fallback, graph migration display, and keyboard accessibility.

- [ ] **Step 2: Implement the Harnesses pane**

Show executable path, version, compatibility, authentication, supported capabilities, and the exact remediation returned by the adapter. Never display credential values.

- [ ] **Step 3: Update Node Inspector**

Changing harness resets the model to that harness's configured default or blank free-text entry. Preserve unsaved graph edits and validate unavailable harness selections before a run.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm vitest run src/renderer/panes/HarnessesPane.test.tsx
pnpm vitest run src/renderer/workspace/defaultLayouts.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/panes/HarnessesPane.tsx src/renderer/panes/HarnessesPane.test.tsx src/renderer/panes/NodeInspectorPane.tsx src/renderer/workspace src/renderer/store.ts
git commit -m "feat: add per-node harness selection"
```

### Task 9: End-to-end verification and documentation

**Files:**
- Create: `e2e/harnesses.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Produces installation/authentication documentation and an optional real-harness smoke-test matrix.

- [ ] **Step 1: Add offline E2E coverage**

Use fixture adapters to create and save mixed graphs, display harness failures, start a mixed run, stream normalized events, stop it, and retry with persisted sessions.

- [ ] **Step 2: Run complete verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Expected: every command exits zero.

- [ ] **Step 3: Run optional local probes**

Run the installed OpenCode, Codex, and Hermes probe commands without issuing paid prompts. If Claude Code is not installed, verify the remediation state rather than failing the suite.

- [ ] **Step 4: Document behavior**

Document per-node selection, native CLI authentication ownership, planner/implementer restrictions, session persistence, and optional credential-gated smoke tests.

- [ ] **Step 5: Commit**

```bash
git add e2e/harnesses.spec.ts README.md
git commit -m "test: verify multi-harness graph execution"
```

## Completion Criteria

- Every graph node can select any of the four harnesses.
- Mixed-harness runs complete the existing plan/build/review loop.
- Sessions survive retry and application restart.
- Planner write attempts are denied consistently.
- All adapters emit the normalized event taxonomy and support cancellation.
- Credentials remain owned by the native CLIs and never enter Spire storage.
