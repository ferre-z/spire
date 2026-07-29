# OmniRoute Provider Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OmniRoute Spire's managed local provider-routing companion, including provider setup, models, combos/fallbacks, health, quotas, usage, and isolated routing for all supported harnesses.

**Architecture:** Integrate OmniRoute as an external companion through a deep `OmniRouteGateway` module; do not vendor its source or reimplement provider executors. Spire may adopt a compatible existing instance or start a Spire-owned instance, while all UI, Electron IPC, MCP, and harness adapters use normalized Spire interfaces.

**Tech Stack:** TypeScript, Node child processes and fetch, Electron `safeStorage`, Zod, OmniRoute REST/OpenAI-compatible APIs, SQLite for non-secret references, Vitest, Playwright.

## Global Constraints

- Plans 1 and 2 are required: provider operations use `SpireControl`, traces use the shared journal, and routing is delivered through `HarnessLaunchConfig`.
- Support OmniRoute `>=3.8.49 <4`, plus required endpoint capability probes.
- Spire never vendors OmniRoute or directly accesses its database.
- Provider credentials and OmniRoute management secrets never enter Spire SQLite, renderer snapshots, MCP responses, or traces.
- Existing graph nodes retain native model routing; new nodes default to OmniRoute only when it is healthy.
- Spire never modifies users' global OpenCode, Claude Code, Codex, or Hermes configuration.
- Spire stops only OmniRoute processes that Spire started.
- Full OmniRoute dashboard parity, plugins, skills, webhooks, guardrails, cache administration, and cloud-agent tasks are out of scope.

---

### Task 1: Define provider, routing, usage, and lifecycle contracts

**Files:**
- Create: `src/shared/provider.ts`
- Create: `src/shared/provider.test.ts`
- Modify: `src/shared/harness.ts`
- Modify: `src/shared/domain.ts`

**Interfaces:**
- Produces `OmniRouteStatus`, `ProviderSummary`, `ProviderConnectionInput`, `ProviderHealth`, `RoutedModel`, `RouteCombo`, `RouteComboInput`, `RoutingHealth`, `RoutingContext`, `QuotaSummary`, `UsageFilter`, `UsageRecord`, `UsagePage`, and `HarnessLaunchConfig`.

- [ ] **Step 1: Write failing schema tests**

Cover lifecycle ownership, provider auth methods, masked credentials, model/combo identifiers, fallback order, health states, quota windows, usage pagination, and invalid native/OmniRoute model combinations.

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/shared/provider.test.ts src/shared/harness.test.ts src/shared/domain.test.ts`

Expected: FAIL because provider contracts are absent.

- [ ] **Step 3: Implement the shared contracts**

Keep model selection stable:

```ts
type ModelSelection = {
  source: "native" | "omniroute";
  modelId: string;
  comboId?: string;
};

type HarnessLaunchConfig = {
  modelId: string;
  environment: Record<string, string>;
  arguments: string[];
  temporaryFiles: Array<{ path: string; contents: string; mode: number }>;
  correlationHeaders: Record<string, string>;
};
```

Ensure serialized status objects contain only masked or non-secret fields.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/shared/provider.test.ts src/shared/harness.test.ts src/shared/domain.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/provider.ts src/shared/provider.test.ts src/shared/harness.ts src/shared/domain.ts
git commit -m "feat: define OmniRoute provider contracts"
```

### Task 2: Implement the typed OmniRoute HTTP client

**Files:**
- Create: `src/main/provider/omniroute-client.ts`
- Create: `src/main/provider/omniroute-client.test.ts`
- Create: `src/main/provider/fixtures/server.ts`
- Create: `src/main/provider/schemas.ts`

**Interfaces:**
- Produces typed methods for `/api/init`, `/api/providers`, provider validation/test/models, `/api/models/catalog`, `/api/combos`, `/api/monitoring/health`, `/api/rate-limits`, `/api/usage/request-logs`, and `/v1/models`.

- [ ] **Step 1: Write failing client tests**

Use a local fake server to cover success, management authentication, pagination, masked secrets, schema drift, non-JSON errors, timeouts, cancellation, rate limiting, and unavailable endpoints.

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/main/provider/omniroute-client.test.ts`

Expected: FAIL because the client is absent.

- [ ] **Step 3: Implement one request pipeline**

Centralize base URL validation, management authentication, timeout, response parsing, Zod validation, actionable error normalization, request IDs, and trace correlation. Permit only loopback HTTP by default; require HTTPS for explicitly configured remote endpoints.

- [ ] **Step 4: Implement endpoint methods**

Return normalized shared types instead of upstream response objects. Treat missing required endpoints as incompatibility; optional analytics fields may be omitted.

- [ ] **Step 5: Verify**

Run: `pnpm vitest run src/main/provider/omniroute-client.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/provider/omniroute-client.ts src/main/provider/omniroute-client.test.ts src/main/provider/fixtures/server.ts src/main/provider/schemas.ts
git commit -m "feat: add typed OmniRoute client"
```

### Task 3: Add companion discovery and lifecycle ownership

**Files:**
- Create: `src/main/provider/omniroute-process.ts`
- Create: `src/main/provider/omniroute-process.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces `probe()`, `start()`, `stop()`, `restart()`, and ownership-aware `OmniRouteStatus`.

- [ ] **Step 1: Write failing lifecycle tests**

Cover executable discovery, compatible running server adoption, incompatible server rejection, port occupied by another process, startup readiness, startup timeout, child crash, restart, app shutdown, and never stopping an adopted process.

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/main/provider/omniroute-process.test.ts`

Expected: FAIL because lifecycle management is absent.

- [ ] **Step 3: Implement discovery**

Probe `127.0.0.1:20128` first, then locate `omniroute` through the platform executable search. Parse the version, call required capability endpoints, and report installation, compatibility, running state, ownership, PID, URL, and remediation.

- [ ] **Step 4: Implement managed launch**

Launch without a shell, bind to loopback, use the Spire-owned OmniRoute data directory, capture stdout/stderr through the trace journal, wait for readiness, and record the child PID. Stop with SIGTERM and bounded SIGKILL escalation only for an owned child.

- [ ] **Step 5: Verify**

Run: `pnpm vitest run src/main/provider/omniroute-process.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/provider/omniroute-process.ts src/main/provider/omniroute-process.test.ts src/main/index.ts
git commit -m "feat: manage OmniRoute companion lifecycle"
```

### Task 4: Provision and protect companion secrets

**Files:**
- Create: `src/main/provider/omniroute-secrets.ts`
- Create: `src/main/provider/omniroute-secrets.test.ts`
- Modify: `src/main/provider/omniroute-process.ts`

**Interfaces:**
- Produces generated `JWT_SECRET`, `API_KEY_SECRET`, `INITIAL_PASSWORD`, and `OMNIROUTE_WS_BRIDGE_SECRET` only to the owned child environment.
- Exposes masked secret status, never secret values, to callers.

- [ ] **Step 1: Write failing secret tests**

Cover first generation, stable reload, mode `0600`, safeStorage encryption, unavailable secure-storage behavior, rotation, trace redaction, and absence from SQLite/control snapshots.

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/main/provider/omniroute-secrets.test.ts`

Expected: FAIL because secret provisioning is absent.

- [ ] **Step 3: Implement secure persistence**

Use cryptographically random values. Encrypt the payload with Electron `safeStorage` when an encrypted backend is available. Write through a temporary file, fsync, rename atomically, and apply mode `0600`. If only insecure `basic_text` storage is available, use the protected file and surface a persistent warning without logging secret contents.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/main/provider/omniroute-secrets.test.ts src/main/trace-journal.test.ts`

Expected: PASS, including a filesystem scan that finds no plaintext secret fixture outside the encrypted/protected secret file.

- [ ] **Step 5: Commit**

```bash
git add src/main/provider/omniroute-secrets.ts src/main/provider/omniroute-secrets.test.ts src/main/provider/omniroute-process.ts
git commit -m "feat: protect OmniRoute companion secrets"
```

### Task 5: Implement the deep `OmniRouteGateway`

**Files:**
- Create: `src/main/provider/omniroute-gateway.ts`
- Create: `src/main/provider/omniroute-gateway.test.ts`
- Modify: `src/main/control/capabilities.ts`

**Interfaces:**
- Produces:

```ts
interface OmniRouteGateway {
  probe(): Promise<OmniRouteStatus>;
  start(): Promise<OmniRouteStatus>;
  stop(): Promise<void>;
  listProviders(): Promise<ProviderSummary[]>;
  connectProvider(input: ProviderConnectionInput): Promise<ProviderSummary>;
  testProvider(providerId: string): Promise<ProviderHealth>;
  listModels(): Promise<RoutedModel[]>;
  listCombos(): Promise<RouteCombo[]>;
  saveCombo(input: RouteComboInput): Promise<RouteCombo>;
  deleteCombo(comboId: string): Promise<void>;
  getHealth(): Promise<RoutingHealth>;
  getQuotas(): Promise<QuotaSummary[]>;
  getUsage(filter: UsageFilter): Promise<UsagePage>;
  createLaunchConfig(input: RoutingContext): Promise<HarnessLaunchConfig>;
}
```

- [ ] **Step 1: Write failing gateway tests**

Cover process adoption/start, management login, provider creation and test, OAuth pending/success/cancel, model normalization, combo CRUD, health, quotas, usage, and launch configuration.

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/main/provider/omniroute-gateway.test.ts`

Expected: FAIL because the gateway is absent.

- [ ] **Step 3: Implement gateway orchestration**

Compose the process, secret, and HTTP modules. Cache model catalogs for 60 seconds, invalidate after provider/combo mutations, and convert every upstream error into a stable Spire error code plus remediation.

- [ ] **Step 4: Register control capabilities**

Add `providers.status`, `providers.start`, `providers.stop`, `providers.list`, `providers.connect`, `providers.test`, `providers.models`, `providers.combos.list`, `providers.combos.save`, `providers.combos.delete`, `providers.health`, `providers.quotas`, and `providers.usage`. The MCP coverage test must require mappings for all of them.

- [ ] **Step 5: Verify**

Run: `pnpm vitest run src/main/provider/omniroute-gateway.test.ts src/main/control/spire-control.test.ts src/mcp/mcp.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/provider/omniroute-gateway.ts src/main/provider/omniroute-gateway.test.ts src/main/control/capabilities.ts
git commit -m "feat: expose OmniRoute provider gateway"
```

### Task 6: Generate isolated routing configurations for every harness

**Files:**
- Create: `src/main/provider/harness-routing.ts`
- Create: `src/main/provider/harness-routing.test.ts`
- Modify: `src/main/harness/opencode.ts`
- Modify: `src/main/harness/claude-code.ts`
- Modify: `src/main/harness/codex.ts`
- Modify: `src/main/harness/hermes.ts`

**Interfaces:**
- Consumes `HarnessLaunchConfig`.
- Produces adapter-specific temporary files, arguments, environment, and correlation metadata without changing global user configuration.

- [ ] **Step 1: Write failing routing tests**

For each harness assert the expected base URL, API key environment name, model identifier, temporary config path, file mode, request/session correlation, cleanup, and native-mode no-op behavior.

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/main/provider/harness-routing.test.ts`

Expected: FAIL because routing configuration is absent.

- [ ] **Step 3: Implement per-harness generation**

Generate OpenCode provider config, Claude Anthropic-compatible environment, isolated Codex home/provider TOML, and Hermes provider environment/config. Store files only under the run's Spire data directory and remove secret-bearing temporary files after the adapter process exits.

- [ ] **Step 4: Integrate adapters**

Merge launch configuration with the adapter's safe baseline. Reject attempts to override the worktree, executable, sandbox policy, output protocol, or secret redaction settings.

- [ ] **Step 5: Verify**

Run: `pnpm vitest run src/main/provider/harness-routing.test.ts src/main/harness && pnpm typecheck`

Expected: PASS and tests prove global CLI config files remain byte-identical.

- [ ] **Step 6: Commit**

```bash
git add src/main/provider/harness-routing.ts src/main/provider/harness-routing.test.ts src/main/harness
git commit -m "feat: route all harnesses through OmniRoute"
```

### Task 7: Correlate routing and usage with Spire traces

**Files:**
- Modify: `src/main/provider/omniroute-gateway.ts`
- Modify: `src/main/run-engine.ts`
- Modify: `src/main/trace-journal.ts`
- Create: `src/main/provider/usage-correlation.test.ts`

**Interfaces:**
- Produces trace events containing run, graph, node, harness, model, combo, provider, fallback, request ID, latency, tokens, and cost.

- [ ] **Step 1: Write failing correlation tests**

Simulate direct routing, one fallback, rate-limit failure, missing upstream request ID, and delayed usage-log availability. Assert deterministic correlation and no credential leakage.

- [ ] **Step 2: Run the focused tests**

Run: `pnpm vitest run src/main/provider/usage-correlation.test.ts`

Expected: FAIL because routing usage is not joined to run traces.

- [ ] **Step 3: Implement correlation**

Send correlation headers where supported, capture IDs emitted by harness protocols, and poll request logs with bounded exponential backoff after completion. Emit a warning rather than failing the run when usage enrichment is unavailable.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/main/provider/usage-correlation.test.ts src/main/trace-journal.test.ts src/main/run-engine.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/provider/omniroute-gateway.ts src/main/provider/usage-correlation.test.ts src/main/run-engine.ts src/main/trace-journal.ts
git commit -m "feat: correlate OmniRoute usage with graph traces"
```

### Task 8: Build native Provider and Routing panes

**Files:**
- Create: `src/renderer/panes/ProvidersPane.tsx`
- Create: `src/renderer/panes/RoutingPane.tsx`
- Create: `src/renderer/panes/ProvidersPane.test.tsx`
- Create: `src/renderer/panes/RoutingPane.test.tsx`
- Modify: `src/renderer/panes/NodeInspectorPane.tsx`
- Modify: `src/renderer/workspace/paneIds.ts`
- Modify: `src/renderer/workspace/defaultLayouts.ts`
- Modify: `src/renderer/store.ts`

**Interfaces:**
- Consumes provider control capabilities.
- Produces lifecycle, provider connection, OAuth handoff, models, combos, health, quotas, and usage UI.

- [ ] **Step 1: Write failing UI tests**

Cover not installed, stopped, starting, healthy, incompatible, and crashed states; API-key connection; OAuth pending/cancel/success; provider test; model search; combo editing; fallback order; health/cooldown/quota badges; usage pagination; and keyboard accessibility.

- [ ] **Step 2: Implement Providers pane**

Show install/remediation, owned/adopted process state, provider catalog, masked connections, connect/test actions, and system-browser OAuth. Secret input values must be cleared immediately after submission.

- [ ] **Step 3: Implement Routing pane**

Provide model search and combo/fallback editing with explicit ordering, health, quota, and cost context. Do not expose out-of-scope OmniRoute administration.

- [ ] **Step 4: Update Node Inspector**

Offer Native and OmniRoute sources. When OmniRoute is healthy, default only newly created nodes to it. Preserve existing graph selections and display unavailable routes without silently replacing them.

- [ ] **Step 5: Verify**

Run:

```bash
pnpm vitest run src/renderer/panes/ProvidersPane.test.tsx src/renderer/panes/RoutingPane.test.tsx
pnpm vitest run src/renderer/workspace/defaultLayouts.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/panes/ProvidersPane.tsx src/renderer/panes/ProvidersPane.test.tsx src/renderer/panes/RoutingPane.tsx src/renderer/panes/RoutingPane.test.tsx src/renderer/panes/NodeInspectorPane.tsx src/renderer/workspace src/renderer/store.ts
git commit -m "feat: add native OmniRoute provider workspace"
```

### Task 9: Migration, offline behavior, and end-to-end verification

**Files:**
- Create: `e2e/providers.spec.ts`
- Modify: `README.md`
- Modify: `src/main/app-service.ts`

**Interfaces:**
- Deprecates direct onboarding dependence on `connectOpenRouter` while retaining native OpenCode/OpenRouter compatibility for existing graphs.

- [ ] **Step 1: Add migration and offline tests**

Verify existing OpenRouter nodes remain native, new nodes default to healthy OmniRoute, saved OmniRoute nodes stay selected while offline, and native harness execution remains available without the companion.

- [ ] **Step 2: Add E2E provider scenarios**

Use the fake OmniRoute server to exercise process state, provider connection, model selection, combo creation, fallback health, mixed-harness routed execution, usage display, crash/restart, and MCP provider tools.

- [ ] **Step 3: Run complete verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Expected: every command exits zero.

- [ ] **Step 4: Run the opt-in pinned contract suite**

Launch a temporary OmniRoute `3.8.49` instance with isolated data and fake provider credentials. Verify capability probes and response schemas without issuing paid inference.

- [ ] **Step 5: Audit secrets and global config**

Search the test user-data directory, SQLite database, trace exports, MCP responses, and application logs for secret fixtures. Compare native harness config files before and after the suite.

Expected: secret fixtures exist only in the protected companion secret file and ephemeral child environment; global harness configs are unchanged.

- [ ] **Step 6: Document installation and ownership**

Document the OmniRoute version contract, owned versus adopted lifecycle, provider credential ownership, native fallback, model-source behavior, and excluded dashboard features.

- [ ] **Step 7: Commit**

```bash
git add e2e/providers.spec.ts README.md src/main/app-service.ts
git commit -m "test: verify native OmniRoute integration"
```

## Completion Criteria

- Spire can adopt or start a compatible OmniRoute instance and reports ownership accurately.
- Users can connect/test providers, select models, and manage combos/fallbacks without opening the OmniRoute dashboard.
- All four harnesses can use OmniRoute through isolated per-run configuration.
- New nodes default to healthy OmniRoute while existing graphs remain unchanged.
- Provider health, quota, request, fallback, latency, token, and cost data correlate with run traces.
- Secrets never appear in Spire persistence, UI state, MCP output, or logs.
- Native harness execution still works while OmniRoute is stopped or unavailable.
