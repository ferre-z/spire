# Headless Coordinator Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Spire's existing control plane into an independently runnable coordinator so workflow execution survives Electron shutdown and exposes one versioned remote interface.

**Architecture:** A new composition-root module constructs the existing database, run engine, harness registry, and `SpireControl` without Electron imports. A Node HTTP server exposes authenticated control requests plus an SSE run-event stream; Electron continues using its current local composition until the later remote-client plan. This phase deliberately preserves SQLite and in-process harnesses as a transitional executable path; the next plans replace persistence with PostgreSQL and execution with remote workers behind the seams established here.

**Tech Stack:** Node.js 22, TypeScript 5.9, Zod 4, native `node:http`, Vitest 3, Vite 7, pnpm 11

## Global Constraints

- The coordinator must contain no Electron imports.
- Closing Electron must not terminate a separately started coordinator run.
- Existing `ControlOperationMap` schemas remain the sole control-operation contract.
- Authentication uses a constant-time comparison against `SPIRE_COORDINATOR_TOKEN`; no token is accepted from query parameters.
- The server binds to `127.0.0.1` by default and requires an explicit `SPIRE_COORDINATOR_HOST` override for remote access.
- SQLite and in-process harness execution are transitional in this plan only; no new SQLite-specific behavior may enter shared coordinator modules.
- Do not add Redis, NATS, Kubernetes, or a web framework.
- Preserve all existing IPC and MCP behavior during this phase.

---

## Program Decomposition

This specification is too large for one safe implementation plan. Execute these plans in order:

1. **This plan:** headless coordinator composition, authenticated HTTP control, SSE events, and standalone packaging.
2. **PostgreSQL state plan:** asynchronous state-store interface, PostgreSQL schema/adapter, transactional importer, and database-backed concurrency.
3. **Distributed worker plan:** worker protocol, leases, fencing, event spool, Docker supervision, artifacts, and OpenCode worker image.
4. **Remote client and deployment plan:** Electron remote transport, scale-to-one Compose deployment, TLS/enrollment, backup/restore, and capacity/failure gates.
5. **Additional harness plan:** Pi production adapter followed by experimental JCode conformance.

Each follow-on plan begins only after the preceding interface has shipped and passed its end-to-end acceptance test.

---

### Task 1: Coordinator composition root

**Files:**

- Create: `src/coordinator/runtime.ts`
- Create: `src/coordinator/runtime.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**

- Consumes: `SpireDatabase`, `createDefaultHarnessRegistry(dataRoot)`, `LocalWorktreeBackend`, `RunEngine`, `SpireControl`, and `HarnessRegistry`.
- Produces: `createCoordinatorRuntime(options: CoordinatorRuntimeOptions): Promise<CoordinatorRuntime>` and `CoordinatorRuntime.close(): Promise<void>`.

- [ ] **Step 1: Write the failing runtime-construction test**

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureHarnessRegistry } from "../main/harness/fixture";
import { createCoordinatorRuntime } from "./runtime";

describe("createCoordinatorRuntime", () => {
  it("constructs and closes without Electron", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "spire-coordinator-"));
    const runtime = await createCoordinatorRuntime({
      dataRoot,
      registry: createFixtureHarnessRegistry({}),
      environment: { appVersion: "test", platform: "linux", isWayland: false },
    });

    await expect(
      runtime.control.execute("state.get", {}),
    ).resolves.toMatchObject({
      graphs: [],
      runs: [],
    });
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `pnpm vitest run src/coordinator/runtime.test.ts`

Expected: FAIL because `src/coordinator/runtime.ts` does not exist.

- [ ] **Step 3: Implement the coordinator runtime**

Create `CoordinatorRuntimeOptions` with `dataRoot`, optional `registry`, optional `environment`, and optional `notify`. Construct the existing modules in dependency order. Expose only `{ control, close }`; keep the database, registry, engine, and legacy OpenCode facade private to the runtime implementation. `close()` must be idempotent, close the legacy facade and all harness adapters, then close the database. Move `SeedFixture` and fixture seeding from `src/main/index.ts` only if the coordinator entry point needs them; keep Electron window code in `src/main/index.ts`.

```ts
export type CoordinatorRuntimeOptions = {
  dataRoot: string;
  registry?: HarnessRegistry;
  environment?: SpireControlEnvironment;
  notify?: (event: RunEvent) => void;
};

export type CoordinatorRuntime = {
  control: SpireControl;
  close(): Promise<void>;
};
```

- [ ] **Step 4: Run runtime and existing control tests**

Run: `pnpm vitest run src/coordinator/runtime.test.ts src/main/control/spire-control.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the composition root**

```bash
git add src/coordinator/runtime.ts src/coordinator/runtime.test.ts src/main/index.ts
git commit -m "refactor: extract coordinator runtime"
```

---

### Task 2: Versioned HTTP control protocol

**Files:**

- Create: `src/shared/coordinator-protocol.ts`
- Create: `src/shared/coordinator-protocol.test.ts`

**Interfaces:**

- Consumes: `controlOperationNameSchema` and `ControlOperationName` from `src/shared/control.ts`.
- Produces: `controlRequestSchema`, `controlResponseSchema`, `ControlRequest`, `ControlResponse`, and `COORDINATOR_PROTOCOL_VERSION`.

- [ ] **Step 1: Write failing protocol-schema tests**

```ts
import { describe, expect, it } from "vitest";
import {
  controlRequestSchema,
  controlResponseSchema,
} from "./coordinator-protocol";

describe("coordinator protocol", () => {
  it("rejects unknown operations", () => {
    expect(
      controlRequestSchema.safeParse({ operation: "runs.destroy", input: {} })
        .success,
    ).toBe(false);
  });

  it("requires exactly one response outcome", () => {
    expect(
      controlResponseSchema.safeParse({ ok: true, output: {} }).success,
    ).toBe(true);
    expect(
      controlResponseSchema.safeParse({ ok: false, error: "denied" }).success,
    ).toBe(true);
    expect(
      controlResponseSchema.safeParse({ ok: true, output: {}, error: "bad" })
        .success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the protocol test and verify it fails**

Run: `pnpm vitest run src/shared/coordinator-protocol.test.ts`

Expected: FAIL because the protocol module does not exist.

- [ ] **Step 3: Implement strict request and discriminated response schemas**

```ts
export const COORDINATOR_PROTOCOL_VERSION = 1;

export const controlRequestSchema = z.strictObject({
  operation: controlOperationNameSchema,
  input: z.unknown(),
});

export const controlResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), output: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: z.string().min(1) }),
]);
```

- [ ] **Step 4: Run protocol tests and type checking**

Run: `pnpm vitest run src/shared/coordinator-protocol.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the protocol**

```bash
git add src/shared/coordinator-protocol.ts src/shared/coordinator-protocol.test.ts
git commit -m "feat: define coordinator control protocol"
```

---

### Task 3: Authenticated HTTP control server

**Files:**

- Create: `src/coordinator/http-server.ts`
- Create: `src/coordinator/http-server.test.ts`

**Interfaces:**

- Consumes: `SpireControl.execute()`, `controlRequestSchema`, and `controlResponseSchema`.
- Produces: `CoordinatorHttpServer`, `start(): Promise<{ host: string; port: number }>`, and `close(): Promise<void>`.

- [ ] **Step 1: Write failing real-socket tests**

Create a fake control object whose `execute("state.get", {})` returns `{ ready: true }`. Start on `127.0.0.1:0` and test all of these cases with native `fetch`:

```ts
expect((await fetch(`${base}/healthz`)).status).toBe(200);
expect((await fetch(`${base}/v1/control`, { method: "POST" })).status).toBe(
  401,
);
expect(
  (await authorizedFetch({ operation: "runs.destroy", input: {} })).status,
).toBe(400);
expect(
  await (await authorizedFetch({ operation: "state.get", input: {} })).json(),
).toEqual({ ok: true, output: { ready: true } });
```

Also send a body larger than 1 MiB and expect HTTP 413, and invoke `close()` twice to prove idempotency.

- [ ] **Step 2: Run the server test and verify it fails**

Run: `pnpm vitest run src/coordinator/http-server.test.ts`

Expected: FAIL because `CoordinatorHttpServer` does not exist.

- [ ] **Step 3: Implement the native Node HTTP server**

Support only:

- `GET /healthz` returning `{ "status": "ok", "protocolVersion": 1 }`.
- `POST /v1/control` with `Authorization: Bearer <token>`.
- HTTP 400 for invalid JSON/schema, 401 for absent or invalid authentication, 404 for other routes, 413 above 1 MiB, and 500 with a non-sensitive error string for handler failures.

Compare SHA-256 digests of expected and supplied tokens with `timingSafeEqual`; do not compare raw token strings or log authorization headers. Apply a 30-second request timeout.

- [ ] **Step 4: Run focused tests, typecheck, and lint changed files**

Run: `pnpm vitest run src/coordinator/http-server.test.ts && pnpm typecheck && pnpm eslint src/coordinator/http-server.ts src/coordinator/http-server.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the HTTP server**

```bash
git add src/coordinator/http-server.ts src/coordinator/http-server.test.ts
git commit -m "feat: expose authenticated coordinator control"
```

---

### Task 4: Resumable SSE run-event stream

**Files:**

- Create: `src/coordinator/event-stream.ts`
- Create: `src/coordinator/event-stream.test.ts`
- Modify: `src/coordinator/runtime.ts`
- Modify: `src/coordinator/http-server.ts`
- Modify: `src/coordinator/http-server.test.ts`

**Interfaces:**

- Consumes: `RunEvent` notifications emitted by `RunEngine`.
- Produces: `CoordinatorEventStream.publish(event)`, `subscribe(afterSequence)`, and `GET /v1/events` SSE frames with numeric IDs.

- [ ] **Step 1: Write failing bounded-replay tests**

Test that publishing events assigns increasing IDs, a subscriber receives future events, `Last-Event-ID: 1` replays events 2 and 3, and a subscriber behind the retained 1,000-event window receives an initial `reset` event instructing it to fetch a fresh snapshot.

```ts
stream.publish({ type: "run.updated", run: runFixture("one") });
stream.publish({ type: "run.updated", run: runFixture("two") });
expect(stream.replayAfter(1).map((entry) => entry.sequence)).toEqual([2]);
```

- [ ] **Step 2: Run the event-stream tests and verify they fail**

Run: `pnpm vitest run src/coordinator/event-stream.test.ts src/coordinator/http-server.test.ts`

Expected: FAIL because the stream and `/v1/events` route do not exist.

- [ ] **Step 3: Implement the in-memory resumable stream**

Keep at most 1,000 entries, remove subscribers on socket close, send a comment heartbeat every 15 seconds, set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and `X-Accel-Buffering: no`. Route the runtime's `RunEngine` notifier into one stream instance. This phase's replay window is intentionally in-memory; durable event cursors move to PostgreSQL in the next plan.

- [ ] **Step 4: Run stream, server, engine, and type tests**

Run: `pnpm vitest run src/coordinator/event-stream.test.ts src/coordinator/http-server.test.ts src/main/run-engine.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit SSE support**

```bash
git add src/coordinator/event-stream.ts src/coordinator/event-stream.test.ts src/coordinator/runtime.ts src/coordinator/http-server.ts src/coordinator/http-server.test.ts
git commit -m "feat: stream coordinator run events"
```

---

### Task 5: Standalone coordinator executable

**Files:**

- Create: `src/coordinator/index.ts`
- Create: `src/coordinator/config.ts`
- Create: `src/coordinator/config.test.ts`
- Create: `vite.coordinator.config.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `createCoordinatorRuntime()` and `CoordinatorHttpServer`.
- Produces: `pnpm build:coordinator`, `pnpm spire:coordinator`, and `coordinator-dist/coordinator.js`.

- [ ] **Step 1: Write failing configuration tests**

Test defaults `host=127.0.0.1`, `port=43110`, and `<cwd>/.spire-data`; reject a missing token, port zero outside tests, non-integer ports, and a non-loopback host unless `SPIRE_ALLOW_REMOTE=1`.

```ts
expect(() =>
  readCoordinatorConfig({ SPIRE_COORDINATOR_TOKEN: "secret" }, "/srv/spire"),
).not.toThrow();
expect(() => readCoordinatorConfig({}, "/srv/spire")).toThrow(
  /SPIRE_COORDINATOR_TOKEN/,
);
```

- [ ] **Step 2: Run the config test and verify it fails**

Run: `pnpm vitest run src/coordinator/config.test.ts`

Expected: FAIL because the config module does not exist.

- [ ] **Step 3: Implement config, entry point, and bundle**

The entry point reads config, creates the data directory, starts runtime and HTTP server, prints only the listening origin, and handles `SIGINT`/`SIGTERM` through one idempotent shutdown promise. The Vite config targets Node 22, emits CJS `coordinator-dist/coordinator.js`, bundles JavaScript dependencies, and keeps `better-sqlite3` external like the Electron main bundle.

Add:

```json
{
  "build:coordinator": "vite build --config vite.coordinator.config.ts",
  "spire:coordinator": "pnpm build:coordinator && node coordinator-dist/coordinator.js"
}
```

- [ ] **Step 4: Verify executable behavior**

Run: `pnpm vitest run src/coordinator/config.test.ts && pnpm build:coordinator && pnpm typecheck`

Then start the built coordinator with a temporary data root and token, request `/healthz`, terminate it, and verify exit code 0:

```bash
SPIRE_COORDINATOR_TOKEN=test-token SPIRE_USER_DATA="$(mktemp -d)" node coordinator-dist/coordinator.js
curl --fail http://127.0.0.1:43110/healthz
```

Expected: health response reports protocol version 1; SIGTERM exits cleanly.

- [ ] **Step 5: Commit the executable**

```bash
git add src/coordinator/index.ts src/coordinator/config.ts src/coordinator/config.test.ts vite.coordinator.config.ts package.json
git commit -m "feat: package headless coordinator"
```

---

### Task 6: End-to-end desktop-independent run

**Files:**

- Create: `src/coordinator/coordinator.e2e.test.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: the built coordinator HTTP interface, fixture harness registry injection, and existing graph/run control operations.
- Produces: executable evidence that a run finishes after its initiating client disconnects.

- [ ] **Step 1: Write the failing end-to-end test**

Start a coordinator on an ephemeral port with a deterministic fixture harness. Save a two-node graph and start a run through `POST /v1/control`; discard the initiating HTTP client; reconnect with a new client and poll `runs.get` until the run is `succeeded`. Assert both node executions and the terminal run survive the client disconnect.

- [ ] **Step 2: Run the E2E test and verify it fails before final wiring**

Run: `pnpm vitest run src/coordinator/coordinator.e2e.test.ts`

Expected: FAIL until the standalone runtime exposes fixture injection and completes runs independently of request lifetime.

- [ ] **Step 3: Complete only the wiring required by the E2E test**

Keep request objects out of `RunEngine` and scheduler state. Ensure `runs.start` returns after durable run creation while execution continues under the coordinator runtime. Document the standalone start command, required token, loopback default, health endpoint, and the transitional limitation that harnesses still run in the coordinator process.

- [ ] **Step 4: Run the complete phase gate**

Run: `pnpm vitest run src/coordinator src/main/control src/main/run-engine.test.ts src/main/scheduler && pnpm typecheck && pnpm lint && pnpm build:coordinator`

Expected: every command exits 0.

Manual QA:

1. Start the built coordinator.
2. Start a fixture-backed run through the HTTP control interface.
3. Close the initiating terminal client without stopping the coordinator.
4. Reconnect from a fresh client and observe the terminal run plus SSE history.
5. Stop the coordinator and verify clean process exit.

- [ ] **Step 5: Commit documentation and E2E coverage**

```bash
git add src/coordinator/coordinator.e2e.test.ts README.md
git commit -m "test: verify desktop-independent coordinator runs"
```

---

## Phase Completion Criteria

- `coordinator-dist/coordinator.js` runs under plain Node 22 without Electron.
- Authenticated remote control uses the existing validated operation contract.
- Live run events are available through resumable SSE.
- A run continues after its initiating desktop/client disconnects.
- Existing Electron IPC and MCP tests remain green.
- The standalone coordinator shuts down cleanly and leaves no active harness process.
- The PostgreSQL state plan can replace persistence without changing the HTTP interface.
- The distributed worker plan can replace harness execution without changing desktop clients.
