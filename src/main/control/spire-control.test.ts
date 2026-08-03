import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  GraphDefinition,
  GraphDefinitionV2,
  HarnessId,
  PlanMutation,
  RunRecord,
} from "../../shared/domain";
import { CONTROL_OPERATION_NAMES } from "../../shared/control";
import type {
  PlanPatchDraft,
} from "../../shared/execution";
import type { TraceEvent } from "../../shared/trace";
import { WORKSPACE_LAYOUT_SCHEMA_VERSION } from "../../shared/workspace";
import type { WorkspaceLayoutRecord } from "../../shared/workspace";
import { AppService } from "../app-service";
import { SpireDatabase } from "../database";
import type {
  AgentHarness,
  HarnessPrompt,
  HarnessResponse,
} from "../harness/opencode";
import type { OpenCodeStatus } from "../../shared/domain";
import type { NodeOutcome } from "../../shared/execution";
import type {
  HarnessAdapter,
  HarnessProbeStatus,
  HarnessRunInput,
  HarnessRunResult,
  HarnessSessionRef,
} from "../../shared/harness";
import { createHarnessRegistry } from "../harness/registry";
import { migrateLegacyGraph } from "../graph-migration";
import { RunEngine } from "../run-engine";
import type { ExecutionBackend, PreparedWorkspace } from "../worktree";
import { SpireControl } from "./spire-control";

function okOutcome(summary = "done"): NodeOutcome {
  return {
    status: "succeeded",
    summary,
    artifacts: [],
    messages: [],
    selectedEdgeIds: [],
  };
}

/** HarnessAdapter fake driving the scheduler-based RunEngine. */
class FakeAdapter implements HarnessAdapter {
  readonly id: HarnessId;
  probeResult: HarnessProbeStatus;
  modelsResult = [{ id: "openrouter/test-model", name: "Test Model" }];
  private index = 0;

  constructor(
    private readonly outputs: unknown[] = [],
    private readonly hang = false,
    id: HarnessId = "opencode",
  ) {
    this.id = id;
    this.probeResult = {
      harnessId: id,
      installed: true,
      binaryPath: `/usr/bin/${id}`,
      version: "1.0.0",
      compatible: true,
      connected: true,
    };
  }

  async probe(): Promise<HarnessProbeStatus> {
    return this.probeResult;
  }
  async listModels() {
    return this.modelsResult;
  }
  run(input: HarnessRunInput): Promise<HarnessRunResult> {
    const ref: HarnessSessionRef = {
      harnessId: this.id,
      sessionId: input.session?.sessionId ?? `session-${this.index}`,
      directory: input.directory,
    };
    input.onSession(ref);
    if (this.hang) return new Promise<HarnessRunResult>(() => undefined);
    const output = this.outputs[this.index] ?? okOutcome();
    this.index += 1;
    return Promise.resolve({ session: ref, output });
  }
  async abort(): Promise<void> {}
  async close(): Promise<void> {}
}

class FakeHarness implements AgentHarness {
  private index = 0;
  modelsResult = [{ id: "openrouter/test-model", name: "Test Model" }];
  detectResult: OpenCodeStatus = {
    installed: true,
    binaryPath: "/usr/bin/opencode",
    version: "1.0.0",
    compatible: true,
    connected: true,
  };
  connectedApiKey?: string;

  constructor(
    private readonly answers: string[] = [],
    private readonly hang = false,
  ) {}

  async detect(): Promise<OpenCodeStatus> {
    return this.detectResult;
  }
  async connectOpenRouter(apiKey: string): Promise<void> {
    this.connectedApiKey = apiKey;
  }
  async models() {
    return this.modelsResult;
  }
  async prompt(input: HarnessPrompt): Promise<HarnessResponse> {
    input.onSession?.(input.sessionId ?? `session-${this.index}`);
    input.onEvent("tool", "fake tool completed");
    if (this.hang) return new Promise<HarnessResponse>(() => undefined);
    return {
      sessionId: input.sessionId ?? `session-${this.index}`,
      text: this.answers[this.index++] ?? "{}",
    };
  }
  async abort() {}
  close() {}
}

class FakeBackend implements ExecutionBackend {
  cleanupCalls: { workspacePath: string; repositoryPath: string }[] = [];

  async prepare(): Promise<PreparedWorkspace> {
    return {
      path: "/tmp/spire-fake-worktree",
      branch: "spire/test",
      dirtySource: false,
    };
  }
  async inspect() {
    return {
      diff: "+export const value = 1;",
      changedFiles: ["src/value.ts"],
    };
  }
  async cleanup(workspacePath: string, repositoryPath: string): Promise<void> {
    this.cleanupCalls.push({ workspacePath, repositoryPath });
  }
  async exportPatch() {}
}

function graph(id = "graph", version = 1, maxIterations = 3): GraphDefinition {
  return {
    id,
    name: "Build",
    version,
    maxIterations,
    createdAt: new Date().toISOString(),
    nodes: [
      {
        id: "planner",
        type: "opencode",
        role: "planner",
        name: "Architect",
        instructions: "Plan",
        model: "openrouter/test",
        position: { x: 0, y: 0 },
      },
      {
        id: "implementer",
        type: "opencode",
        role: "implementer",
        name: "Builder",
        instructions: "Build",
        model: "openrouter/test",
        position: { x: 200, y: 0 },
      },
    ],
    edges: [
      {
        id: "a",
        source: "planner",
        target: "implementer",
        condition: "always",
        label: "brief",
      },
      {
        id: "b",
        source: "implementer",
        target: "planner",
        condition: "always",
        label: "review",
      },
    ],
  };
}

const ALL_ACTIONS: PlanMutation[] = [
  "retry",
  "skip",
  "reorder",
  "reroute",
  "pause",
  "replace",
  "insert",
  "remove",
  "edit",
];

/** A v2 graph with a planner that has graph-scope authority for patching. */
function graphV2(id = "graph", version = 1, maxSteps = 100): GraphDefinitionV2 {
  return {
    id,
    name: "Build",
    version,
    nodes: [
      {
        kind: "agent",
        id: "planner",
        name: "Architect",
        roleLabel: "planner",
        job: "Plan the work.",
        harnessId: "opencode",
        modelId: "openrouter/test",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "graph", actions: ALL_ACTIONS },
        activation: "all",
        maxVisits: 3,
        position: { x: 0, y: 0 },
      },
      {
        kind: "agent",
        id: "implementer",
        name: "Builder",
        roleLabel: "implementer",
        job: "Build the work.",
        harnessId: "opencode",
        modelId: "openrouter/test",
        access: { mode: "workspace-write", writeScopes: ["."] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        position: { x: 200, y: 0 },
      },
    ],
    edges: [
      {
        id: "a",
        source: "planner",
        target: "implementer",
        kind: "handoff",
        when: "selected",
        label: "brief",
      },
      {
        id: "b",
        source: "implementer",
        target: "planner",
        kind: "review",
        when: "always",
        label: "review",
      },
    ],
    maxSteps,
    groups: [],
    createdAt: new Date().toISOString(),
  };
}

/** A v2 graph with a manual checkpoint between planner and implementer. */
function graphV2WithCheckpoint(id = "graph-cp", version = 1): GraphDefinitionV2 {
  return {
    id,
    name: "Checkpoint Test",
    version,
    nodes: [
      {
        kind: "agent",
        id: "planner",
        name: "Architect",
        roleLabel: "planner",
        job: "Plan the work.",
        harnessId: "opencode",
        modelId: "openrouter/test",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "graph", actions: ALL_ACTIONS },
        activation: "any",
        maxVisits: 3,
        position: { x: 0, y: 0 },
      },
      {
        kind: "checkpoint",
        id: "checkpoint",
        name: "Gate",
        mode: "manual",
        position: { x: 200, y: 0 },
      },
      {
        kind: "agent",
        id: "implementer",
        name: "Builder",
        roleLabel: "implementer",
        job: "Build the work.",
        harnessId: "opencode",
        modelId: "openrouter/test",
        access: { mode: "workspace-write", writeScopes: ["."] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        position: { x: 400, y: 0 },
      },
    ],
    edges: [
      {
        id: "plan-cp",
        source: "planner",
        target: "checkpoint",
        kind: "handoff",
        when: "selected",
        label: "plan",
      },
      {
        id: "cp-impl",
        source: "checkpoint",
        target: "implementer",
        kind: "dependency",
        when: "always",
        label: "implement",
      },
      {
        id: "impl-review",
        source: "implementer",
        target: "planner",
        kind: "review",
        when: "success",
        label: "review",
      },
    ],
    maxSteps: 100,
    groups: [],
    createdAt: new Date().toISOString(),
  };
}

function layoutRecord(graphId = "graph"): WorkspaceLayoutRecord {
  return {
    graphId,
    mode: "desktop",
    schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
    model: {
      layout: {
        type: "row",
        children: [
          {
            type: "tabset",
            children: [{ type: "tab", id: "tab-1", component: "graph" }],
          },
        ],
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

function createControl(
  answers: string[] = [],
  hang = false,
  outputs: unknown[] = [],
) {
  const database = new SpireDatabase(":memory:");
  const journal = database.createTraceJournal();
  const harness = new FakeHarness(answers, hang);
  const adapter = new FakeAdapter(outputs, hang);
  const registry = createHarnessRegistry([adapter]);
  const backend = new FakeBackend();
  const engine = new RunEngine(database, registry, backend, () => undefined);
  const control = new SpireControl({
    database,
    engine,
    harness,
    registry,
    backend,
    journal,
    environment: { appVersion: "1.2.3-test", platform: "linux", isWayland: false },
  });
  return { control, database, journal, harness, adapter, registry, backend, engine };
}

function selectOutcome(edgeIds: string[], summary = "done"): NodeOutcome {
  return { ...okOutcome(summary), selectedEdgeIds: edgeIds };
}

async function makeRepository(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "spire-repo-"));
  await writeFile(path.join(directory, ".git"), "gitdir: elsewhere", "utf8");
  return directory;
}

describe("SpireControl registry", () => {
  it("exposes one capability per ControlOperationMap key", () => {
    const { control } = createControl();
    const listed = control.listCapabilities();
    // ControlOperationMap has exactly 29 operations; the mapped type ties the
    // dispatch registry to it at compile time, so assert runtime coverage of
    // the registry itself — keys, count, and a bound handler per operation.
    expect(CONTROL_OPERATION_NAMES).toHaveLength(29);
    expect(Object.keys(listed).sort()).toEqual(
      [...CONTROL_OPERATION_NAMES].sort(),
    );
    expect(Object.keys(listed)).toHaveLength(29);
    for (const name of CONTROL_OPERATION_NAMES) {
      expect(typeof listed[name].handler).toBe("function");
      expect(listed[name].inputSchema).toBeDefined();
      expect(listed[name].outputSchema).toBeDefined();
      expect(typeof listed[name].readOnly).toBe("boolean");
      expect(typeof listed[name].destructive).toBe("boolean");
      expect(typeof listed[name].idempotent).toBe("boolean");
    }
  });

  it("executes every registered operation through dispatch", async () => {
    const { control, database } = createControl();
    database.saveGraph(graph());
    const repositoryPath = await makeRepository();

    await expect(control.execute("state.get", {})).resolves.toMatchObject({
      onboardingComplete: false,
    });
    await expect(
      control.execute("diagnostics.get", {}),
    ).resolves.toMatchObject({ appVersion: "1.2.3-test" });
    await expect(control.execute("graphs.list", {})).resolves.toMatchObject({
      nextCursor: null,
    });
    await expect(
      control.execute("graphs.get", { graphId: "graph" }),
    ).resolves.toMatchObject({ id: "graph" });
    await expect(
      control.execute("graphs.save", { graph: graphV2("other") }),
    ).resolves.toMatchObject({ id: "other" });
    await expect(
      control.execute("repositories.validate", { path: repositoryPath }),
    ).resolves.toMatchObject({ ok: true });

    const run = await control.execute("runs.start", {
      graph: graph(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    await expect(
      control.execute("runs.list", {}),
    ).resolves.toMatchObject({ nextCursor: null });
    await expect(
      control.execute("runs.get", { runId: run.id }),
    ).resolves.toMatchObject({ id: run.id });
    await expect(
      control.execute("runs.artifacts.get", { runId: run.id }),
    ).resolves.toMatchObject({ changedFiles: ["src/value.ts"] });
    // A succeeded run is not retryable.
    await expect(
      control.execute("runs.retry", { runId: run.id }),
    ).rejects.toThrow(/retried/i);
    await expect(
      control.execute("worktrees.cleanup", { runId: run.id }),
    ).resolves.toMatchObject({ id: run.id });
    await expect(
      control.execute("runs.stop", { runId: run.id }),
    ).resolves.toMatchObject({ status: "stopped" });

    await expect(
      control.execute("layouts.save", layoutRecord()),
    ).resolves.toEqual({ saved: true });
    await expect(
      control.execute("layouts.list", { graphId: "graph" }),
    ).resolves.toHaveLength(1);
    await expect(
      control.execute("layouts.reset", { graphId: "graph" }),
    ).resolves.toEqual({ reset: true });

    await expect(control.execute("harnesses.list", {})).resolves.toHaveLength(
      1,
    );
    await expect(
      control.execute("harnesses.models", { harnessId: "opencode" }),
    ).resolves.toHaveLength(1);
    await expect(control.execute("traces.query", {})).resolves.toMatchObject({
      nextCursor: null,
    });
    await expect(
      control.execute("traces.tail", { afterSequence: 0 }),
    ).resolves.toMatchObject({ nextCursor: null });

    // --- New operations: graph validation, plan/nodes/messages, patches ---
    const v2graph = migrateLegacyGraph(graph());
    await expect(
      control.execute("graphs.validate", { graph: v2graph }),
    ).resolves.toMatchObject({ valid: true });

    await expect(
      control.execute("runs.plan.get", { runId: run.id }),
    ).resolves.toMatchObject({ runId: run.id });

    await expect(
      control.execute("runs.nodes.list", { runId: run.id }),
    ).resolves.toMatchObject({ nodes: expect.any(Array) });

    await expect(
      control.execute("runs.messages.list", { runId: run.id }),
    ).resolves.toMatchObject({ messages: expect.any(Array) });

    const sent = await control.execute("runs.messages.send", {
      runId: run.id,
      recipient: { kind: "node", id: "implementer" },
      kind: "question",
      subject: "Test message",
      body: "Can you build this?",
      artifactPaths: [],
      senderNodeId: "user",
    });
    expect(sent).toEqual({
      sent: true,
      messageId: expect.any(String),
      sequence: 0,
    });
  });
});

describe("SpireControl.execute tracing", () => {
  it("records start and success events with a shared generated correlation id", async () => {
    const { control } = createControl();
    const events: TraceEvent[] = [];
    const unsubscribe = control.subscribe((event) => events.push(event));

    await control.execute("graphs.list", {});
    unsubscribe();

    const start = events.find((event) => event.kind === "control.start");
    const success = events.find((event) => event.kind === "control.success");
    expect(start).toBeDefined();
    expect(success).toBeDefined();
    expect(start!.correlationId).toBe(success!.correlationId);
    expect(start!.correlationId.length).toBeGreaterThan(0);
    expect(start!.subsystem).toBe("control");
    expect(start!.message).toContain("graphs.list");
    expect(success!.level).toBe("info");
  });

  it("records a failure event and rethrows when input validation fails", async () => {
    const { control, journal } = createControl();
    // Input validation failures throw synchronously from execute().
    expect(() => control.execute("runs.stop", {})).toThrow();

    const page = journal.query({ kind: "control.failure" });
    expect(page.events).toHaveLength(1);
    expect(page.events[0].level).toBe("error");
    expect(page.events[0].message).toContain("runs.stop");
    const starts = journal.query({
      correlationId: page.events[0].correlationId,
    });
    expect(starts.events.map((event) => event.kind)).toEqual([
      "control.start",
      "control.failure",
    ]);
  });

  it("records a failure event when the handler throws", async () => {
    const { control, journal } = createControl();
    expect(() => control.execute("runs.get", { runId: "missing" })).toThrow(
      /not found/i,
    );
    const failures = journal.query({ kind: "control.failure" });
    expect(failures.events).toHaveLength(1);
    expect(failures.events[0].message).toContain("runs.get");
  });

  it("records a failure event with the shared correlation id when an async handler rejects", async () => {
    const { control, journal } = createControl();
    const repositoryPath = await makeRepository();
    // handleRunsStart is async: the blank-goal error arrives as a rejection,
    // not a synchronous throw, and must still be traced.
    await expect(
      control.execute("runs.start", {
        graph: graph(),
        repositoryPath,
        goal: "   ",
      }),
    ).rejects.toThrow(/goal/i);

    const failures = journal.query({ kind: "control.failure" });
    expect(failures.events).toHaveLength(1);
    expect(failures.events[0].level).toBe("error");
    expect(failures.events[0].message).toContain("runs.start");
    const correlated = journal.query({
      correlationId: failures.events[0].correlationId,
    });
    expect(correlated.events.map((event) => event.kind)).toEqual([
      "control.start",
      "control.failure",
    ]);
  });

  it("passes raw payloads to the journal, which is the only redactor", async () => {
    const { control, journal } = createControl();
    // A secret-looking value inside the input must be redacted by the
    // journal, not by the control layer.
    expect(() =>
      control.execute("graphs.get", { graphId: "sk-abcdefghijklmnop" }),
    ).toThrow();
    const failures = journal.query({ kind: "control.failure" });
    const serialized = JSON.stringify(failures.events[0].payload);
    expect(serialized).not.toContain("sk-abcdefghijklmnop");
    expect(serialized).toContain("[REDACTED]");
  });

  it("stops delivering events after unsubscribe", async () => {
    const { control } = createControl();
    const events: TraceEvent[] = [];
    const unsubscribe = control.subscribe((event) => events.push(event));
    unsubscribe();
    await control.execute("graphs.list", {});
    expect(events).toHaveLength(0);
  });
});

describe("state.get / diagnostics.get", () => {
  it("composes the app snapshot from the database and harness state", async () => {
    const { control, database } = createControl();
    database.setSetting("onboardingComplete", "true");
    database.saveGraph(graph());
    const snapshot = await control.execute("state.get", {});
    expect(snapshot.onboardingComplete).toBe(true);
    expect(snapshot.graphs).toHaveLength(1);
    expect(snapshot.graphs[0]?.nodes[0]?.kind).toBe("agent");
    expect("models" in snapshot).toBe(false);
    expect(snapshot.activeRunId).toBeUndefined();
    expect(snapshot.openCode.installed).toBe(false);
  });

  it("reports diagnostics from real counts and injected environment", async () => {
    const { control, database } = createControl();
    database.saveGraph(graph("a"));
    database.saveGraph(graph("b"));
    database.saveRun({
      id: "run-1",
      graphId: "a",
      graphVersion: 1,
      repositoryPath: "/tmp/repo",
      goal: "goal",
      status: "succeeded",
      iteration: 1,
      startedAt: new Date().toISOString(),
      events: [],
    });
    const diagnostics = await control.execute("diagnostics.get", {});
    expect(diagnostics).toEqual({
      appVersion: "1.2.3-test",
      platform: "linux",
      isWayland: false,
      openCode: { installed: false, compatible: false, connected: false },
      graphCount: 2,
      runCount: 1,
    });
  });
});

describe("graphs operations", () => {
  it("paginates graphs.list with an opaque cursor", async () => {
    const { control, database } = createControl();
    database.saveGraph(graph("g1"));
    database.saveGraphV2(graphV2("g2"));
    database.saveGraphV2(graphV2("g3"));

    const first = await control.execute("graphs.list", { limit: 2 });
    expect(first.graphs).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await control.execute("graphs.list", {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.graphs).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.graphs, ...second.graphs].map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("gets the latest version by default and a pinned version on request", async () => {
    const { control, database } = createControl();
    database.saveGraph(graph("g", 1));
    database.saveGraphV2({ ...graphV2("g", 2), name: "Build v2" });

    const latest = await control.execute("graphs.get", { graphId: "g" });
    expect(latest.version).toBe(2);
    const pinned = await control.execute("graphs.get", {
      graphId: "g",
      version: 1,
    });
    expect(pinned.version).toBe(1);
    expect(() => control.execute("graphs.get", { graphId: "missing" })).toThrow(
      /not found/i,
    );
  });

  it("validates v2 and increments the highest stored version for an existing id", async () => {
    const { control, database } = createControl();
    const first = await control.execute("graphs.save", { graph: graphV2("g") });
    expect(first.version).toBe(1);
    database.saveGraphV2(graphV2("g", 4));
    const suppliedCreatedAt = "2026-07-29T12:00:00.000Z";
    const second = await control.execute("graphs.save", {
      graph: {
        ...graphV2("g", 99),
        name: "Renamed",
        createdAt: suppliedCreatedAt,
      },
    });
    expect(second.version).toBe(5);
    expect(second.createdAt).not.toBe(suppliedCreatedAt);
    expect(
      database.listGraphsV2().filter((item) => item.id === "g"),
    ).toHaveLength(3);
  });

  it("rejects an invalid graph through input validation", async () => {
    const { control } = createControl();
    expect(() =>
      control.execute("graphs.save", { graph: { id: "broken" } }),
    ).toThrow();
  });
});

describe("repositories.validate", () => {
  it("accepts an accessible git repository", async () => {
    const { control } = createControl();
    const repositoryPath = await makeRepository();
    const result = await control.execute("repositories.validate", {
      path: repositoryPath,
    });
    expect(result).toEqual({ path: repositoryPath, ok: true });
  });

  it("rejects a missing path with a reason instead of throwing", async () => {
    const { control } = createControl();
    const result = await control.execute("repositories.validate", {
      path: "/definitely/not/here",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("rejects a directory that is not a git repository", async () => {
    const { control } = createControl();
    const directory = await mkdtemp(path.join(tmpdir(), "spire-notrepo-"));
    const result = await control.execute("repositories.validate", {
      path: directory,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/git/i);
  });
});

describe("runs operations", () => {
  it("starts a run, returning the persisted record", async () => {
    const { control, database } = createControl();
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graph(),
      repositoryPath,
      goal: "  Add value  ",
    });
    expect(run.goal).toBe("Add value");
    expect(run.graphId).toBe("graph");
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
  });

  it("rejects a blank goal and an inaccessible repository", async () => {
    const { control } = createControl();
    const repositoryPath = await makeRepository();
    await expect(
      control.execute("runs.start", {
        graph: graph(),
        repositoryPath,
        goal: "   ",
      }),
    ).rejects.toThrow(/goal/i);
    await expect(
      control.execute("runs.start", {
        graph: graph(),
        repositoryPath: "/definitely/not/here",
        goal: "Add value",
      }),
    ).rejects.toThrow();
  });

  it("stops an active run and returns the stopped record", async () => {
    // The hanging harness keeps the run mid-flight so stop is the only writer.
    const { control } = createControl([], true);
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graph(),
      repositoryPath,
      goal: "Add value",
    });
    const stopped = await control.execute("runs.stop", { runId: run.id });
    expect(stopped.status).toBe("stopped");
    expect(stopped.finishedAt).toBeDefined();
  });

  it("retries a run that exhausted its step budget to completion", async () => {
    // maxIterations 1 compiles to maxSteps 2: brief + build fit the budget,
    // the review does not; a retry resets the step budget and finishes.
    const { control, database } = createControl([], false, [
      selectOutcome(["a"], "brief written"),
      okOutcome("built"),
      okOutcome("accepted"),
    ]);
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graph("graph", 1, 1),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () =>
        expect(database.getRun(run.id)?.status).toBe("needs_attention"),
      { timeout: 3000 },
    );

    const retried = await control.execute("runs.retry", { runId: run.id });
    expect(retried.id).toBe(run.id);
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
  });

  it("rejects retrying an unknown run", async () => {
    const { control } = createControl();
    await expect(
      control.execute("runs.retry", { runId: "missing" }),
    ).rejects.toThrow(/not found/i);
  });

  it("filters and paginates runs.list", async () => {
    const { control, database } = createControl();
    const template: RunRecord = {
      id: "run",
      graphId: "graph",
      graphVersion: 1,
      repositoryPath: "/tmp/repo",
      goal: "goal",
      status: "succeeded",
      iteration: 1,
      startedAt: new Date().toISOString(),
      events: [],
    };
    database.saveRun({ ...template, id: "r1", status: "succeeded" });
    database.saveRun({ ...template, id: "r2", status: "failed" });
    database.saveRun({ ...template, id: "r3", status: "succeeded" });

    const succeeded = await control.execute("runs.list", {
      status: "succeeded",
    });
    expect(succeeded.runs.map((run) => run.id).sort()).toEqual(["r1", "r3"]);

    const paged = await control.execute("runs.list", { limit: 2 });
    expect(paged.runs).toHaveLength(2);
    expect(paged.nextCursor).not.toBeNull();
    const rest = await control.execute("runs.list", {
      limit: 2,
      cursor: paged.nextCursor!,
    });
    expect(rest.runs).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
  });

  it("gets a single run and rejects unknown ids", async () => {
    const { control, database } = createControl();
    database.saveRun({
      id: "run-1",
      graphId: "graph",
      graphVersion: 1,
      repositoryPath: "/tmp/repo",
      goal: "goal",
      status: "succeeded",
      iteration: 1,
      startedAt: new Date().toISOString(),
      events: [],
    });
    const run = await control.execute("runs.get", { runId: "run-1" });
    expect(run.id).toBe("run-1");
    expect(() => control.execute("runs.get", { runId: "missing" })).toThrow(
      /not found/i,
    );
  });
});

describe("runs.artifacts.get", () => {
  it("returns the semantic artifact including the patch content", async () => {
    const { control, database } = createControl();
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graph(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    const artifacts = await control.execute("runs.artifacts.get", {
      runId: run.id,
    });
    expect(artifacts.diff).toBe("+export const value = 1;");
    expect(artifacts.changedFiles).toEqual(["src/value.ts"]);
    expect(artifacts.branch).toBe("spire/test");
  });

  it("rejects runs without artifacts and unknown runs", async () => {
    const { control, database } = createControl();
    database.saveRun({
      id: "run-1",
      graphId: "graph",
      graphVersion: 1,
      repositoryPath: "/tmp/repo",
      goal: "goal",
      status: "failed",
      iteration: 0,
      startedAt: new Date().toISOString(),
      events: [],
    });
    expect(() =>
      control.execute("runs.artifacts.get", { runId: "run-1" }),
    ).toThrow(/artifacts/i);
    expect(() =>
      control.execute("runs.artifacts.get", { runId: "missing" }),
    ).toThrow(/not found/i);
  });
});

describe("worktrees.cleanup", () => {
  it("cleans the worktree and clears the artifact path", async () => {
    const { control, database, backend } = createControl();
    database.saveRun({
      id: "run-1",
      graphId: "graph",
      graphVersion: 1,
      repositoryPath: "/tmp/repo",
      goal: "goal",
      status: "succeeded",
      iteration: 1,
      startedAt: new Date().toISOString(),
      events: [],
      artifacts: {
        diff: "+x",
        changedFiles: ["x.ts"],
        worktreePath: "/tmp/spire-fake-worktree",
        branch: "spire/test",
      },
    });
    const run = await control.execute("worktrees.cleanup", { runId: "run-1" });
    expect(backend.cleanupCalls).toEqual([
      { workspacePath: "/tmp/spire-fake-worktree", repositoryPath: "/tmp/repo" },
    ]);
    expect(run.artifacts?.worktreePath).toBe("");
    expect(database.getRun("run-1")?.artifacts?.worktreePath).toBe("");
  });

  it("rejects cleanup when no worktree exists", async () => {
    const { control, database } = createControl();
    database.saveRun({
      id: "run-1",
      graphId: "graph",
      graphVersion: 1,
      repositoryPath: "/tmp/repo",
      goal: "goal",
      status: "succeeded",
      iteration: 1,
      startedAt: new Date().toISOString(),
      events: [],
    });
    await expect(
      control.execute("worktrees.cleanup", { runId: "run-1" }),
    ).rejects.toThrow(/worktree/i);
  });
});

describe("layouts operations", () => {
  it("saves, lists, and resets workspace layouts", async () => {
    const { control } = createControl();
    await expect(
      control.execute("layouts.save", layoutRecord("g")),
    ).resolves.toEqual({ saved: true });
    const listed = await control.execute("layouts.list", { graphId: "g" });
    expect(listed).toHaveLength(1);
    expect(listed[0].graphId).toBe("g");
    await expect(
      control.execute("layouts.reset", { graphId: "g" }),
    ).resolves.toEqual({ reset: true });
    await expect(
      control.execute("layouts.list", { graphId: "g" }),
    ).resolves.toHaveLength(0);
  });

  it("rejects structurally invalid layouts with the validation reason", async () => {
    const { control } = createControl();
    expect(() =>
      control.execute("layouts.save", {
        ...layoutRecord("g"),
        schemaVersion: 99,
      }),
    ).toThrow(/rejected/i);
  });
});

describe("harnesses operations", () => {
  it("lists the OpenCode harness with a freshly detected status", async () => {
    const { control } = createControl();
    const harnesses = await control.execute("harnesses.list", {});
    expect(harnesses).toEqual([
      {
        id: "opencode",
        name: "OpenCode",
        status: {
          harnessId: "opencode",
          installed: true,
          binaryPath: "/usr/bin/opencode",
          version: "1.0.0",
          compatible: true,
          connected: true,
        },
      },
    ]);
  });

  it("returns models for a known harness and rejects unknown harnesses", async () => {
    const { control } = createControl();
    const models = await control.execute("harnesses.models", {
      harnessId: "opencode",
    });
    expect(models).toEqual([{ id: "openrouter/test-model", name: "Test Model" }]);
    // Unknown harness ids fail input validation, which execute() throws
    // synchronously.
    expect(() =>
      control.execute("harnesses.models", { harnessId: "claude" }),
    ).toThrow(/harness/i);
  });
});

describe("traces operations", () => {
  it("queries recorded control events by filter fields", async () => {
    const { control, journal } = createControl();
    journal.append({
      correlationId: "seed-correlation",
      kind: "harness.request",
      level: "info",
      subsystem: "harness",
      message: "seeded event",
    });
    await control.execute("graphs.list", {});

    const seeded = await control.execute("traces.query", {
      correlationId: "seed-correlation",
    });
    expect(seeded.events).toHaveLength(1);
    expect(seeded.events[0].message).toBe("seeded event");

    const controlOnly = await control.execute("traces.query", {
      subsystem: "control",
    });
    expect(
      controlOnly.events.every((event) => event.subsystem === "control"),
    ).toBe(true);
    expect(controlOnly.events.length).toBeGreaterThan(0);
  });

  it("tails events after a sequence cursor", async () => {
    const { control } = createControl();
    await control.execute("graphs.list", {});
    const all = await control.execute("traces.tail", { afterSequence: 0 });
    expect(all.events.length).toBeGreaterThan(1);
    const first = all.events[0];
    const rest = await control.execute("traces.tail", {
      afterSequence: first.sequence,
    });
    // The cursor excludes the first event; the tail operations' own trace
    // events make exact counts brittle, so assert exclusion and monotonicity.
    expect(rest.events.length).toBeGreaterThan(0);
    expect(
      rest.events.every((event) => event.sequence > first.sequence),
    ).toBe(true);
  });
});

describe("graphs.validate", () => {
  it("accepts a valid graph v2 definition", async () => {
    const { control } = createControl();
    const v2graph = migrateLegacyGraph(graph());
    await expect(
      control.execute("graphs.validate", { graph: v2graph }),
    ).resolves.toEqual({ valid: true, issues: [] });
  });

  it("reports validation issues for a structurally broken graph", async () => {
    const { control } = createControl();
    const broken = migrateLegacyGraph(graph());
    broken.nodes = [broken.nodes[0]]; // only one node, edges reference removed node
    const result = await control.execute("graphs.validate", { graph: broken });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("reports issues for non-graph input instead of throwing", async () => {
    const { control } = createControl();
    const result = await control.execute("graphs.validate", {
      graph: { id: "broken" },
    });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("runs.plan operations", () => {
  it("gets the persisted execution plan for a run", async () => {
    const { control, database } = createControl();
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graph(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    const plan = await control.execute("runs.plan.get", { runId: run.id });
    expect(plan.runId).toBe(run.id);
    expect(plan.nodes.length).toBeGreaterThan(0);
    expect(plan.edges.length).toBeGreaterThan(0);
  });

  it("rejects runs.plan.get for an unknown run", () => {
    const { control } = createControl();
    expect(() =>
      control.execute("runs.plan.get", { runId: "missing" }),
    ).toThrow(/not found/i);
  });

  it("rejects malformed runId input", () => {
    const { control } = createControl();
    expect(() => control.execute("runs.plan.get", {})).toThrow();
  });
});

describe("runs.nodes.list", () => {
  it("lists node executions for a completed run", async () => {
    const { control, database } = createControl();
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graph(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    const result = await control.execute("runs.nodes.list", { runId: run.id });
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nextCursor).toBeNull();
    for (const node of result.nodes) {
      expect(node).toHaveProperty("nodeId");
      expect(node).toHaveProperty("status");
      expect(node).toHaveProperty("visits");
    }
  });

  it("paginates node executions with an opaque cursor", async () => {
    const { control, database } = createControl();
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graph(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    const first = await control.execute("runs.nodes.list", {
      runId: run.id,
      limit: 1,
    });
    expect(first.nodes).toHaveLength(1);
    if (first.nextCursor) {
      const second = await control.execute("runs.nodes.list", {
        runId: run.id,
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(second.nodes.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects an unknown run", () => {
    const { control } = createControl();
    expect(() =>
      control.execute("runs.nodes.list", { runId: "missing" }),
    ).toThrow(/not found/i);
  });
});

describe("runs.messages.list", () => {
  it("lists messages for a run that has messages", async () => {
    const { control, database } = createControl();
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graph(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    await control.execute("runs.messages.send", {
      runId: run.id,
      recipient: { kind: "node", id: "implementer" },
      kind: "question",
      subject: "Test",
      body: "Question body",
      artifactPaths: [],
      senderNodeId: "user",
    });
    const result = await control.execute("runs.messages.list", {
      runId: run.id,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
    expect(result.messages[0].subject).toBe("Test");
  });

  it("returns an empty list when no messages exist", async () => {
    const { control, database } = createControl();
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graph(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    const result = await control.execute("runs.messages.list", {
      runId: run.id,
    });
    expect(result.messages).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("rejects an unknown run", () => {
    const { control } = createControl();
    expect(() =>
      control.execute("runs.messages.list", { runId: "missing" }),
    ).toThrow(/not found/i);
  });
});

describe("runs.messages.send", () => {
  it("sends a message and persists it with a sequence number", async () => {
    const { control, database } = createControl();
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graph(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    const result = await control.execute("runs.messages.send", {
      runId: run.id,
      recipient: { kind: "node", id: "implementer" },
      kind: "handoff",
      subject: "Brief",
      body: "Here is the brief.",
      artifactPaths: [],
      senderNodeId: "user",
    });
    expect(result.sent).toBe(true);
    expect(result.sequence).toBe(0);
    const stored = database.listCollaborationMessages(run.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].subject).toBe("Brief");
    expect(stored[0].senderNodeId).toBe("user");
  });

  it("rejects sending to an unknown run", async () => {
    const { control } = createControl();
    await expect(
      control.execute("runs.messages.send", {
        runId: "missing",
        recipient: { kind: "node", id: "impl" },
        kind: "question",
        subject: "Test",
        body: "Body",
        artifactPaths: [],
        senderNodeId: "user",
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("runs.plan.patch", () => {
  it("applies an authorized skip patch and persists it", async () => {
    const { control, database } = createControl([], false, [
      selectOutcome(["plan-cp"], "brief written"),
    ]);
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graphV2WithCheckpoint(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("needs_attention"),
      { timeout: 3000 },
    );
    const plan = database.getExecutionPlan(run.id)!;
    expect(
      plan.nodes.find((n) => n.nodeId === "implementer")?.status,
    ).toBe("waiting");
    const draft: PlanPatchDraft = {
      baseRevision: plan.revision,
      reason: "test patch: skip implementer",
      operations: [{ action: "skip", nodeId: "implementer" }],
    };
    const patch = await control.execute("runs.plan.patch", {
      runId: run.id,
      actorNodeId: "planner",
      draft,
    });
    expect(patch.id).toBeTruthy();
    expect(patch.appliedRevision).toBe(plan.revision + 1);
    const repersisted = database.getExecutionPlan(run.id)!;
    expect(repersisted.patches).toHaveLength(1);
    expect(repersisted.patches[0].id).toBe(patch.id);
  });

  it("rejects a patch with a stale base revision", async () => {
    const { control, database } = createControl();
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graphV2(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    const draft: PlanPatchDraft = {
      baseRevision: 999,
      reason: "stale",
      operations: [{ action: "skip", nodeId: "implementer" }],
    };
    expect(() =>
      control.execute("runs.plan.patch", {
        runId: run.id,
        actorNodeId: "planner",
        draft,
      }),
    ).toThrow();
  });

  it("rejects patching an unknown run", () => {
    const { control } = createControl();
    const draft: PlanPatchDraft = {
      baseRevision: 0,
      reason: "test",
      operations: [{ action: "skip", nodeId: "impl" }],
    };
    expect(() =>
      control.execute("runs.plan.patch", {
        runId: "missing",
        actorNodeId: "planner",
        draft,
      }),
    ).toThrow(/not found/i);
  });
});

describe("runs.plan.rollback", () => {
  it("rolls back an applied patch", async () => {
    const { control, database } = createControl([], false, [
      selectOutcome(["plan-cp"], "brief written"),
    ]);
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graphV2WithCheckpoint(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("needs_attention"),
      { timeout: 3000 },
    );
    const planBefore = database.getExecutionPlan(run.id)!;
    const draft: PlanPatchDraft = {
      baseRevision: planBefore.revision,
      reason: "patch to roll back",
      operations: [{ action: "skip", nodeId: "implementer" }],
    };
    const applied = await control.execute("runs.plan.patch", {
      runId: run.id,
      actorNodeId: "planner",
      draft,
    });
    const rolledBack = await control.execute("runs.plan.rollback", {
      runId: run.id,
      patchId: applied.id,
    });
    expect(rolledBack.id).not.toBe(applied.id);
    const planAfter = database.getExecutionPlan(run.id)!;
    const target = planAfter.patches.find((p) => p.id === applied.id);
    expect(target?.rolledBackBy).toBe(rolledBack.id);
  });

  it("rejects rolling back an unknown patch", async () => {
    const { control, database } = createControl();
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graphV2(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    expect(() =>
      control.execute("runs.plan.rollback", {
        runId: run.id,
        patchId: "nonexistent",
      }),
    ).toThrow(/unknown patch/i);
  });
});

describe("runs.checkpoint.resume", () => {
  it("resumes a run paused at a manual checkpoint", async () => {
    const { control, database } = createControl([], false, [
      selectOutcome(["plan-cp"], "brief written"),
    ]);
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graphV2WithCheckpoint(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () =>
        expect(database.getRun(run.id)?.status).toBe("needs_attention"),
      { timeout: 3000 },
    );
    const plan = await control.execute("runs.checkpoint.resume", {
      runId: run.id,
    });
    expect(plan.runId).toBe(run.id);
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
  });

  it("rejects resuming a run that is not paused", async () => {
    const { control } = createControl();
    await expect(
      control.execute("runs.checkpoint.resume", { runId: "missing" }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("runs.plan.promote", () => {
  it("promotes a run plan topology to a new saved graph version", async () => {
    const { control, database } = createControl();
    const repositoryPath = await makeRepository();
    const run = await control.execute("runs.start", {
      graph: graphV2(),
      repositoryPath,
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    const promoted = await control.execute("runs.plan.promote", {
      runId: run.id,
      name: "Promoted Graph",
    });
    expect(promoted.id).toBe("graph");
    expect(promoted.name).toBe("Promoted Graph");
    expect(promoted.version).toBe(2);
    const saved = database.listGraphsV2().find(
      (g) => g.id === "graph" && g.version === 2,
    );
    expect(saved).toBeDefined();
    expect(saved?.nodes).toHaveLength(2);
  });

  it("rejects promoting a plan for an unknown run", () => {
    const { control } = createControl();
    expect(() =>
      control.execute("runs.plan.promote", { runId: "missing" }),
    ).toThrow(/not found/i);
  });
});

describe("AppService facade", () => {
  function createService(
    answers: string[] = [],
    adapter = new FakeAdapter(),
  ) {
    const database = new SpireDatabase(":memory:");
    const harness = new FakeHarness(answers);
    const registry = createHarnessRegistry([adapter]);
    const backend = new FakeBackend();
    const engine = new RunEngine(database, registry, backend, () => undefined);
    const service = new AppService(database, harness, engine, backend, registry);
    return { service, database, harness, adapter, backend };
  }

  it("keeps the snapshot shape the renderer expects", () => {
    const { service } = createService();
    const snapshot = service.snapshot();
    expect(snapshot).toMatchObject({
      onboardingComplete: false,
      graphs: [],
      runs: [],
    });
    expect("models" in snapshot).toBe(false);
    expect(snapshot.openCode).toBeDefined();
  });

  it("detects OpenCode and reflects the status in the snapshot", async () => {
    const { service } = createService();
    const snapshot = await service.detectOpenCode();
    expect(snapshot.openCode.installed).toBe(true);
  });

  it("re-probes the selected harness and seeds a v2 graph with the selected model", async () => {
    const { service, database } = createService();
    const snapshot = await service.completeOnboarding({
      harnessId: "opencode",
      modelId: "openrouter/test-model",
    });
    expect(snapshot.onboardingComplete).toBe(true);
    expect(snapshot.graphs).toHaveLength(1);
    expect(snapshot.graphs[0]?.name).toBe("Build & Review");
    expect(
      snapshot.graphs[0]?.nodes.every(
        (node) =>
          node.kind === "agent" &&
          node.harnessId === "opencode" &&
          node.modelId === "openrouter/test-model",
      ),
    ).toBe(true);
    expect(database.getSetting("onboardingComplete")).toBe("true");
    expect(database.getSetting("harnessId")).toBeUndefined();
    expect(database.getSetting("modelId")).toBeUndefined();
  });

  it("uses a non-OpenCode harness selected from the registry", async () => {
    const adapter = new FakeAdapter([], false, "codex");
    adapter.modelsResult = [{ id: "openai/gpt-5", name: "GPT-5" }];
    const { service } = createService([], adapter);
    const snapshot = await service.completeOnboarding({
      harnessId: "codex",
      modelId: "openai/gpt-5",
    });
    expect(
      snapshot.graphs[0]?.nodes.every(
        (node) =>
          node.kind === "agent" &&
          node.harnessId === "codex" &&
          node.modelId === "openai/gpt-5",
      ),
    ).toBe(true);
  });

  it.each([
    ["unavailable", { installed: false, compatible: false, connected: false }],
    ["incompatible", { installed: true, compatible: false, connected: true }],
    ["disconnected", { installed: true, compatible: true, connected: false }],
  ])("rejects an %s selected harness without completing onboarding", async (_label, state) => {
    const { service, database, adapter } = createService();
    adapter.probeResult = { ...adapter.probeResult, ...state };
    await expect(
      service.completeOnboarding({
        harnessId: "opencode",
        modelId: "openrouter/test-model",
      }),
    ).rejects.toThrow();
    expect(database.getSetting("onboardingComplete")).toBeUndefined();
    expect(database.listGraphsV2()).toHaveLength(0);
  });

  it("rejects an empty or absent model selection after re-reading models", async () => {
    const { service, database, adapter } = createService();
    adapter.modelsResult = [];
    await expect(
      service.completeOnboarding({
        harnessId: "opencode",
        modelId: "openrouter/test-model",
      }),
    ).rejects.toThrow(/model/i);
    adapter.modelsResult = [{ id: "other-model", name: "Other" }];
    await expect(
      service.completeOnboarding({
        harnessId: "opencode",
        modelId: "missing-model",
      }),
    ).rejects.toThrow(/model/i);
    expect(database.getSetting("onboardingComplete")).toBeUndefined();
  });

  it("does not seed a duplicate when any graph already exists", async () => {
    const { service, database } = createService();
    database.saveGraph(graph("existing"));
    const snapshot = await service.completeOnboarding({
      harnessId: "opencode",
      modelId: "openrouter/test-model",
    });
    expect(snapshot.graphs).toHaveLength(1);
    expect(snapshot.graphs[0]?.id).toBe("existing");
    expect(snapshot.graphs[0]?.nodes[0]?.kind).toBe("agent");
  });

  it("saves graphs with version bumps and returns the snapshot", async () => {
    const { service } = createService();
    const first = await service.saveGraph(graphV2("g"));
    expect(first.graphs).toHaveLength(1);
    const second = await service.saveGraph({ ...graphV2("g"), name: "v2" });
    expect(second.graphs.filter((item) => item.id === "g")).toHaveLength(2);
  });

  it("starts and stops runs, returning snapshots with the active run", async () => {
    const { service } = createService();
    const repositoryPath = await makeRepository();
    const started = await service.startRun({
      graph: graph(),
      repositoryPath,
      goal: "Add value",
    });
    expect(started.activeRunId).toBeDefined();
    const stopped = await service.stopRun(started.activeRunId!);
    expect(stopped.activeRunId).toBeUndefined();
  });

  it("keeps getRun synchronous and tolerant of missing runs", () => {
    const { service, database } = createService();
    expect(service.getRun("missing")).toBeUndefined();
    database.saveRun({
      id: "run-1",
      graphId: "graph",
      graphVersion: 1,
      repositoryPath: "/tmp/repo",
      goal: "goal",
      status: "succeeded",
      iteration: 1,
      startedAt: new Date().toISOString(),
      events: [],
    });
    expect(service.getRun("run-1")?.id).toBe("run-1");
  });

  it("delegates workspace layout operations", async () => {
    const { service } = createService();
    service.saveWorkspaceLayout(layoutRecord("g"));
    const layouts = await service.listWorkspaceLayouts("g");
    expect(layouts).toHaveLength(1);
    service.resetWorkspaceLayouts("g");
    expect(await service.listWorkspaceLayouts("g")).toHaveLength(0);
  });

  it("rejects invalid layouts with the original error message", async () => {
    const { service } = createService();
    expect(() =>
      service.saveWorkspaceLayout({ ...layoutRecord("g"), schemaVersion: 99 }),
    ).toThrow(/Workspace layout rejected/);
  });

  it("rejects worktree cleanup when no worktree exists", async () => {
    const { service, database } = createService();
    database.saveRun({
      id: "run-1",
      graphId: "graph",
      graphVersion: 1,
      repositoryPath: "/tmp/repo",
      goal: "goal",
      status: "succeeded",
      iteration: 1,
      startedAt: new Date().toISOString(),
      events: [],
    });
    await expect(service.cleanupWorktree("run-1")).rejects.toThrow(
      /worktree/i,
    );
  });
});
