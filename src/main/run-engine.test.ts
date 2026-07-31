import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { GraphDefinition } from "../shared/domain";
import type { NodeOutcome } from "../shared/execution";
import type {
  HarnessAdapter,
  HarnessProbeStatus,
  HarnessRunInput,
  HarnessRunResult,
  HarnessSessionRef,
} from "../shared/harness";
import { SpireDatabase } from "./database";
import { createHarnessRegistry } from "./harness/registry";
import { RunEngine } from "./run-engine";
import { REDACTED, type TraceJournal } from "./trace-journal";
import type { ExecutionBackend, PreparedWorkspace } from "./worktree";

function ok(summary = "done"): NodeOutcome {
  return {
    status: "succeeded",
    summary,
    artifacts: [],
    messages: [],
    selectedEdgeIds: [],
  };
}

class FakeAdapter implements HarnessAdapter {
  readonly id = "opencode" as const;
  readonly calls: HarnessRunInput[] = [];
  readonly abortCalls: HarnessSessionRef[] = [];
  private index = 0;

  constructor(
    private readonly outputs: unknown[] = [],
    private readonly hang = false,
  ) {}

  async probe(): Promise<HarnessProbeStatus> {
    return {
      harnessId: "opencode",
      installed: true,
      compatible: true,
      connected: true,
    };
  }
  async listModels() {
    return [];
  }
  run(input: HarnessRunInput): Promise<HarnessRunResult> {
    this.calls.push(input);
    const ref: HarnessSessionRef = {
      harnessId: "opencode",
      sessionId: input.session?.sessionId ?? `session-${this.index}`,
      directory: input.directory,
    };
    input.onSession(ref);
    if (this.hang) return new Promise<HarnessRunResult>(() => undefined);
    input.onEvent({ type: "tool_result", tool: "fake", output: "done" });
    const output = this.outputs[this.index] ?? ok(`output-${this.index}`);
    this.index += 1;
    return Promise.resolve({ session: ref, output });
  }
  async abort(session: HarnessSessionRef): Promise<void> {
    this.abortCalls.push(session);
  }
  async close(): Promise<void> {}
}

class FakeBackend implements ExecutionBackend {
  async prepare(): Promise<PreparedWorkspace> {
    return { path: "/tmp/spire-fake", branch: "spire/test", dirtySource: false };
  }
  async inspect() {
    return { diff: "+export const value = 1;", changedFiles: ["src/value.ts"] };
  }
  async cleanup() {}
  async exportPatch() {}
}

function graph(maxIterations = 3): GraphDefinition {
  return {
    id: "graph",
    name: "Build",
    version: 1,
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

function setup(
  adapter: FakeAdapter,
  database?: SpireDatabase,
  journal?: TraceJournal,
) {
  const db = database ?? new SpireDatabase(":memory:");
  const events: string[] = [];
  const engine = new RunEngine(
    db,
    createHarnessRegistry([adapter]),
    new FakeBackend(),
    (event) => events.push(event.kind),
    journal,
  );
  return { database: db, engine, events };
}

describe("RunEngine", () => {
  it("runs a legacy two-node graph end-to-end through the scheduler", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "spire-engine-"));
    const database = new SpireDatabase(path.join(directory, "test.sqlite"));
    const adapter = new FakeAdapter();
    const { engine, events } = setup(adapter, database);
    const run = await engine.start({
      graph: graph(),
      repositoryPath: "/tmp/repository",
      goal: "Add value",
    });

    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    const saved = database.getRun(run.id)!;
    expect(saved.artifacts?.changedFiles).toEqual(["src/value.ts"]);
    expect(events).toContain("status");

    // The run compiled a persisted execution plan and routed every node
    // through the harness registry: the migrated legacy cycle runs planner
    // and implementer up to their visit bounds.
    const plan = database.getExecutionPlan(run.id)!;
    expect(plan.status).toBe("succeeded");
    expect(plan.graphId).toBe("graph");
    expect(adapter.calls.map((call) => call.nodeId)).toEqual([
      "planner",
      "implementer",
      "planner",
      "implementer",
      "planner",
      "implementer",
    ]);
    const executions = database.listNodeExecutions(run.id);
    expect(executions.map((node) => node.visits)).toEqual([3, 3]);
    expect(saved.iteration).toBe(3);
    database.close();
  });

  it("stops with needs_attention at the step cap", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "spire-limit-"));
    const database = new SpireDatabase(path.join(directory, "test.sqlite"));
    const adapter = new FakeAdapter();
    const { engine } = setup(adapter, database);
    const run = await engine.start({
      graph: graph(1),
      repositoryPath: "/tmp/repository",
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("needs_attention"),
      { timeout: 3000 },
    );
    expect(adapter.calls).toHaveLength(2);
    expect(database.getExecutionPlan(run.id)?.status).toBe("needs_attention");
    database.close();
  });

  it("retries a capped run until the graph quiesces", async () => {
    const database = new SpireDatabase(":memory:");
    const adapter = new FakeAdapter();
    const { engine } = setup(adapter, database);
    const run = await engine.start({
      graph: graph(1),
      repositoryPath: "/tmp/repository",
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("needs_attention"),
      { timeout: 3000 },
    );

    await engine.retry(run.id);
    await vi.waitFor(
      () =>
        expect(database.getRun(run.id)?.status).toBe("needs_attention"),
      { timeout: 3000 },
    );
    await engine.retry(run.id);
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    expect(adapter.calls).toHaveLength(6);
    database.close();
  });

  it("stops an active run and aborts the in-flight node attempt", async () => {
    const database = new SpireDatabase(":memory:");
    const adapter = new FakeAdapter([], true);
    const { engine } = setup(adapter, database);
    const run = await engine.start({
      graph: graph(),
      repositoryPath: "/tmp/repository",
      goal: "Add value",
    });
    await vi.waitFor(() => expect(adapter.calls.length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    await engine.stop(run.id);
    const saved = database.getRun(run.id)!;
    expect(saved.status).toBe("stopped");
    expect(saved.finishedAt).toBeDefined();
    expect(adapter.abortCalls.length).toBeGreaterThan(0);
    database.close();
  });

  it("recovers an orphaned run on restart instead of failing it", async () => {
    const database = new SpireDatabase(":memory:");
    const startedAt = new Date().toISOString();
    database.saveGraph(graph());
    database.saveRun({
      id: "run-1",
      graphId: "graph",
      graphVersion: 1,
      repositoryPath: "/tmp/repository",
      goal: "Add value",
      status: "implementing",
      iteration: 1,
      startedAt,
      events: [],
      artifacts: {
        diff: "",
        changedFiles: [],
        worktreePath: "/tmp/spire-fake",
        branch: "spire/test",
      },
    });
    database.saveExecutionPlan({
      runId: "run-1",
      graphId: "graph",
      graphVersion: 1,
      revision: 0,
      status: "running",
      stepCount: 2,
      nodes: [
        { nodeId: "planner", status: "succeeded", visits: 1, outcome: ok() },
        { nodeId: "implementer", status: "running", visits: 1 },
      ],
      edges: [
        {
          id: "a",
          source: "planner",
          target: "implementer",
          kind: "handoff",
          when: "always",
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
      patches: [],
      updatedAt: startedAt,
    });

    const adapter = new FakeAdapter();
    const { engine } = setup(adapter, database);
    expect(engine.activeId).toBe("run-1");
    await vi.waitFor(
      () => expect(database.getRun("run-1")?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    // The orphaned attempt was converted to a failure, not the whole run.
    const plan = database.getExecutionPlan("run-1")!;
    const orphaned = plan.nodes.find((node) => node.nodeId === "implementer")!;
    expect(orphaned.visits).toBe(3);
    expect(adapter.calls.length).toBeGreaterThan(0);
    database.close();
  });
});

describe("RunEngine trace journaling", () => {
  it("journals transitions, prompts, responses, and tool activity", async () => {
    const database = new SpireDatabase(":memory:");
    const journal = database.createTraceJournal();
    const adapter = new FakeAdapter();
    const { engine } = setup(adapter, database, journal);
    const run = await engine.start({
      graph: graph(),
      repositoryPath: "/tmp/repository",
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );

    const events = journal.query({ runId: run.id }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.runId === run.id)).toBe(true);
    const kinds = new Set(events.map((event) => event.kind));
    expect(kinds).toContain("run.transition");
    expect(kinds).toContain("run.prompt");
    expect(kinds).toContain("run.response");
    expect(kinds).toContain("run.tool_result");

    const plannerPrompt = events.find(
      (event) => event.kind === "run.prompt" && event.nodeId === "planner",
    );
    expect(plannerPrompt).toBeDefined();
    expect(plannerPrompt?.payload).toMatchObject({
      job: expect.stringContaining("Plan"),
    });
    const implementerResponse = events.find(
      (event) => event.kind === "run.response" && event.nodeId === "implementer",
    );
    expect(implementerResponse).toBeDefined();
    const toolEvent = events.find((event) => event.kind === "run.tool_result");
    expect(toolEvent).toBeDefined();
    database.close();
  });

  it("persists only redacted secrets from prompts and responses", async () => {
    const secret = "sk-abcdefghijklmnop";
    const database = new SpireDatabase(":memory:");
    const journal = database.createTraceJournal();
    const adapter = new FakeAdapter();
    const { engine } = setup(adapter, database, journal);
    const run = await engine.start({
      graph: graph(),
      repositoryPath: "/tmp/repository",
      goal: `Add value with ${secret}`,
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );

    const events = journal.query({ runId: run.id }).events;
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(REDACTED);
    database.close();
  });

  it("keeps the run alive when the journal append throws", async () => {
    const database = new SpireDatabase(":memory:");
    const broken = {
      append: () => {
        throw new Error("journal down");
      },
    } as unknown as TraceJournal;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const adapter = new FakeAdapter();
    const { engine } = setup(adapter, database, broken);
    const run = await engine.start({
      graph: graph(),
      repositoryPath: "/tmp/repository",
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    database.close();
  });
});
