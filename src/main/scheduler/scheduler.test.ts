import { describe, expect, it, vi } from "vitest";
import type {
  AgentNode,
  CheckpointNode,
  DecisionNode,
  GraphDefinitionV2,
  GraphEdge,
  GraphNode,
  HarnessId,
  SubgraphNode,
} from "../../shared/domain";
import type { NodeOutcome } from "../../shared/execution";
import type {
  HarnessAdapter,
  HarnessProbeStatus,
  HarnessRunInput,
  HarnessRunResult,
  HarnessSessionRef,
} from "../../shared/harness";
import { SpireDatabase } from "../database";
import { createHarnessRegistry } from "../harness/registry";
import { compileExecutionPlan, compileGraph } from "./graph-compiler";
import { GraphScheduler, type SchedulerObserver } from "./scheduler";

// --- Fixtures ---------------------------------------------------------------

function ok(summary = "done", selectedEdgeIds: string[] = []): NodeOutcome {
  return {
    status: "succeeded",
    summary,
    artifacts: [],
    messages: [],
    selectedEdgeIds,
  };
}

function failedOutcome(summary = "rejected"): NodeOutcome {
  return { ...ok(summary), status: "failed" };
}

function agent(id: string, overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    kind: "agent",
    id,
    name: id,
    job: `job-${id}`,
    harnessId: "opencode",
    modelId: "test-model",
    access: { mode: "read-only", writeScopes: [] },
    authority: { scope: "self", actions: [] },
    activation: "all",
    maxVisits: 3,
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

function decision(id: string): DecisionNode {
  return { ...agent(id), kind: "decision" };
}

function checkpoint(id: string, mode: "automatic" | "manual"): CheckpointNode {
  return { kind: "checkpoint", id, name: id, mode, position: { x: 0, y: 0 } };
}

function subgraph(id: string, graphId: string, graphVersion?: number): SubgraphNode {
  return {
    kind: "subgraph",
    id,
    name: id,
    graphId,
    graphVersion,
    position: { x: 0, y: 0 },
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  when: GraphEdge["when"] = "always",
): GraphEdge {
  return { id, source, target, kind: "dependency", when, label: id };
}

function graph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  maxSteps = 100,
): GraphDefinitionV2 {
  return {
    id: "graph",
    name: "Test",
    version: 1,
    nodes,
    edges,
    groups: [],
    maxSteps,
    createdAt: new Date().toISOString(),
  };
}

// --- Fake harness -----------------------------------------------------------

type FakeAdapterOptions = {
  hang?: boolean;
  skipSession?: boolean;
};

class FakeAdapter implements HarnessAdapter {
  readonly calls: HarnessRunInput[] = [];
  readonly abortCalls: HarnessSessionRef[] = [];
  private index = 0;

  constructor(
    readonly id: HarnessId,
    private readonly outputs: unknown[] = [],
    private readonly options: FakeAdapterOptions = {},
  ) {}

  async probe(): Promise<HarnessProbeStatus> {
    return {
      harnessId: this.id,
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
      harnessId: this.id,
      sessionId: input.session?.sessionId ?? `${this.id}-session-${this.index}`,
      directory: input.directory,
    };
    if (!this.options.skipSession) input.onSession(ref);
    if (this.options.hang) return new Promise<HarnessRunResult>(() => undefined);
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

// --- Harness ----------------------------------------------------------------

function observer(): SchedulerObserver {
  return {
    nodeStarted: vi.fn(),
    nodeFinished: vi.fn(),
    harnessEvent: vi.fn(),
    planUpdated: vi.fn(),
  };
}

function setup(
  definition: GraphDefinitionV2,
  adapter: FakeAdapter,
  runId = "run-1",
) {
  const database = new SpireDatabase(":memory:");
  const registry = createHarnessRegistry([adapter]);
  const obs = observer();
  const scheduler = new GraphScheduler({
    database,
    registry,
    goal: "test goal",
    directory: "/tmp/worktree",
    observer: obs,
  });
  const compiled = compileGraph(definition);
  const plan = compileExecutionPlan(definition, runId);
  return { database, registry, obs, scheduler, compiled, plan };
}

function nodeIds(adapter: FakeAdapter): string[] {
  return adapter.calls.map((call) => call.nodeId);
}

describe("compileExecutionPlan", () => {
  it("seeds entry nodes as queued and the rest as waiting", () => {
    const definition = graph(
      [agent("a"), agent("b")],
      [edge("ab", "a", "b")],
    );
    const plan = compileExecutionPlan(definition, "run-1");
    expect(plan.runId).toBe("run-1");
    expect(plan.graphId).toBe("graph");
    expect(plan.graphVersion).toBe(1);
    expect(plan.revision).toBe(0);
    expect(plan.status).toBe("running");
    expect(plan.stepCount).toBe(0);
    expect(plan.nodes).toEqual([
      { nodeId: "a", status: "queued", visits: 0 },
      { nodeId: "b", status: "waiting", visits: 0 },
    ]);
    expect(plan.edges).toHaveLength(1);
  });

  it("seeds a deterministic node when the graph is a pure cycle", () => {
    const definition = graph(
      [agent("planner"), agent("implementer")],
      [edge("a", "planner", "implementer"), edge("b", "implementer", "planner")],
    );
    const plan = compileExecutionPlan(definition, "run-1");
    const seeds = plan.nodes.filter((node) => node.status === "queued");
    expect(seeds.map((node) => node.nodeId)).toEqual(["planner"]);
  });

  it("expands subgraphs at compile time with namespaced node ids", () => {
    const inner = graph([agent("p"), agent("q")], [edge("pq", "p", "q")]);
    inner.id = "inner";
    const outer = graph(
      [agent("x"), subgraph("S", "inner", 2), agent("y")],
      [edge("xs", "x", "S"), edge("sy", "S", "y")],
    );
    const requested: Array<[string, number | undefined]> = [];
    const compiled = compileGraph(outer, (graphId, version) => {
      requested.push([graphId, version]);
      return inner;
    });
    expect(requested).toEqual([["inner", 2]]);
    expect(compiled.nodes.map((node) => node.id)).toEqual([
      "x",
      "S/p",
      "S/q",
      "y",
    ]);
    // The external edge into S is rewired to the inner entry node, and the
    // edge out of S to the inner exit node.
    expect(compiled.edges).toHaveLength(3);
    expect(compiled.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "x", target: "S/p" }),
        expect.objectContaining({ source: "S/p", target: "S/q" }),
        expect.objectContaining({ source: "S/q", target: "y" }),
      ]),
    );
  });

  it("expands nested subgraphs recursively", () => {
    const innermost = graph([agent("m")], []);
    innermost.id = "innermost";
    const inner = graph([subgraph("T", "innermost")], []);
    inner.id = "inner";
    const outer = graph(
      [agent("x"), subgraph("S", "inner"), agent("y")],
      [edge("xs", "x", "S"), edge("sy", "S", "y")],
    );
    const compiled = compileGraph(outer, (graphId) =>
      graphId === "inner" ? inner : innermost,
    );
    expect(compiled.nodes.map((node) => node.id)).toEqual([
      "x",
      "S/T/m",
      "y",
    ]);
  });
});

describe("GraphScheduler", () => {
  it("runs a linear graph to success and persists the plan", async () => {
    const adapter = new FakeAdapter("opencode");
    const definition = graph(
      [agent("a"), agent("b")],
      [edge("ab", "a", "b")],
    );
    const { scheduler, compiled, plan, database } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);

    expect(final.status).toBe("succeeded");
    expect(nodeIds(adapter)).toEqual(["a", "b"]);
    expect(final.stepCount).toBe(2);
    const persisted = database.getExecutionPlan("run-1")!;
    expect(persisted.status).toBe("succeeded");
    const executions = database.listNodeExecutions("run-1");
    expect(executions).toHaveLength(2);
    expect(
      executions.every(
        (node) => node.status === "succeeded" && node.visits === 1,
      ),
    ).toBe(true);
    database.close();
  });

  it("runs parallel branches in deterministic declaration order", async () => {
    const adapter = new FakeAdapter("opencode");
    const definition = graph(
      [agent("a"), agent("c"), agent("b")],
      [edge("ab", "a", "b"), edge("ac", "a", "c")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("succeeded");
    expect(nodeIds(adapter)).toEqual(["a", "c", "b"]);
  });

  it("waits for every input at an all-join", async () => {
    const adapter = new FakeAdapter("opencode");
    const definition = graph(
      [agent("a"), agent("b"), agent("c")],
      [edge("ac", "a", "c"), edge("bc", "b", "c")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("succeeded");
    expect(nodeIds(adapter)).toEqual(["a", "b", "c"]);
  });

  it("activates an any-join once when the first input completes", async () => {
    const adapter = new FakeAdapter("opencode");
    const definition = graph(
      [agent("a"), agent("b"), agent("c", { activation: "any" })],
      [edge("ac", "a", "c"), edge("bc", "b", "c")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("succeeded");
    // Both entries run; the join fires exactly once.
    expect(nodeIds(adapter).sort()).toEqual(["a", "b", "c"]);
    expect(nodeIds(adapter).filter((id) => id === "c")).toHaveLength(1);
  });

  it("routes success edges only on succeeded outcomes", async () => {
    const adapter = new FakeAdapter("opencode", [ok("a done")]);
    const definition = graph(
      [agent("a"), agent("b"), agent("c")],
      [edge("ab", "a", "b", "success"), edge("ac", "a", "c", "failure")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("succeeded");
    expect(nodeIds(adapter)).toEqual(["a", "b"]);
    expect(final.nodes.find((node) => node.nodeId === "c")?.visits).toBe(0);
  });

  it("routes failure edges on failed outcomes without failing the plan", async () => {
    const adapter = new FakeAdapter("opencode", [failedOutcome(), ok()]);
    const definition = graph(
      [agent("a"), agent("b")],
      [edge("ab", "a", "b", "failure")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(nodeIds(adapter)).toEqual(["a", "b"]);
    expect(final.nodes.find((node) => node.nodeId === "a")?.status).toBe(
      "failed",
    );
    // The failure was routed and handled downstream.
    expect(final.status).toBe("succeeded");
  });

  it("fails the plan when a node failure has no failure routing", async () => {
    const adapter = new FakeAdapter("opencode", [failedOutcome()]);
    const definition = graph(
      [agent("a"), agent("b")],
      [edge("ab", "a", "b", "success")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(nodeIds(adapter)).toEqual(["a"]);
    expect(final.status).toBe("failed");
    // The unrouted branch was never activated: it settles as skipped.
    expect(final.nodes.find((node) => node.nodeId === "b")?.status).toBe(
      "skipped",
    );
  });

  it("settles a starved all-join as skipped without failing the plan", async () => {
    // a fails -> b runs (failure route); j needs both a (success) and b, and
    // a's success token never arrives: j is a no-ready-node deadlock.
    const adapter = new FakeAdapter("opencode", [failedOutcome(), ok()]);
    const definition = graph(
      [agent("a"), agent("b"), agent("j")],
      [
        edge("ab", "a", "b", "failure"),
        edge("aj", "a", "j", "success"),
        edge("bj", "b", "j", "always"),
      ],
    );
    const { scheduler, compiled, plan, database } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);

    expect(nodeIds(adapter)).toEqual(["a", "b"]);
    expect(final.status).toBe("succeeded");
    const join = final.nodes.find((node) => node.nodeId === "j")!;
    expect(join.status).toBe("skipped");
    expect(join.visits).toBe(0);
    // The skip is persisted, not just computed in memory.
    const persisted = database
      .listNodeExecutions("run-1")
      .find((node) => node.nodeId === "j")!;
    expect(persisted.status).toBe("skipped");
    database.close();
  });

  it("routes selected edges only when the outcome selects them", async () => {
    const adapter = new FakeAdapter("opencode", [
      ok("decided", ["e2"]),
      ok("y done"),
    ]);
    const definition = graph(
      [decision("d"), agent("x"), agent("y")],
      [edge("e1", "d", "x", "selected"), edge("e2", "d", "y", "selected")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("succeeded");
    expect(nodeIds(adapter)).toEqual(["d", "y"]);
    expect(final.nodes.find((node) => node.nodeId === "x")?.visits).toBe(0);
  });

  it("loops until maxVisits, creating a new attempt per visit", async () => {
    const adapter = new FakeAdapter("opencode");
    const definition = graph(
      [agent("a"), agent("b")],
      [edge("ab", "a", "b"), edge("ba", "b", "a")],
    );
    const { scheduler, compiled, plan, obs } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    // b's last completion still has a route into a, but a is at its visit
    // cap: the suppressed route settles as needs_attention.
    expect(final.status).toBe("needs_attention");
    expect(nodeIds(adapter)).toEqual(["a", "b", "a", "b", "a", "b"]);
    expect(final.nodes.map((node) => node.visits)).toEqual([3, 3]);
    // Every visit is its own attempt, reported as a separate start.
    expect(obs.nodeStarted).toHaveBeenCalledTimes(6);
  });

  it("prefers failed over needs_attention when both apply at settle", async () => {
    // f fails with no routing (unhandled) while the a<->b loop exhausts its
    // visit budget with a suppressed route: failed wins.
    const adapter = new FakeAdapter("opencode", [failedOutcome()]);
    const definition = graph(
      [agent("f"), agent("a"), agent("b")],
      [edge("ab", "a", "b"), edge("ba", "b", "a")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("failed");
    expect(final.nodes.find((node) => node.nodeId === "f")?.status).toBe(
      "failed",
    );
  });

  it("honors a per-node maxVisits override", async () => {
    const adapter = new FakeAdapter("opencode");
    const definition = graph(
      [agent("a", { maxVisits: 2 }), agent("b", { maxVisits: 2 })],
      [edge("ab", "a", "b"), edge("ba", "b", "a")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(nodeIds(adapter)).toEqual(["a", "b", "a", "b"]);
    expect(final.status).toBe("needs_attention");
  });

  it("stops with needs_attention when maxSteps is exhausted with work pending", async () => {
    const adapter = new FakeAdapter("opencode");
    const definition = graph(
      [agent("a"), agent("b")],
      [edge("ab", "a", "b"), edge("ba", "b", "a")],
      3,
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("needs_attention");
    expect(final.stepCount).toBe(3);
    expect(adapter.calls).toHaveLength(3);
  });

  it("completes automatic checkpoints without a harness call", async () => {
    const adapter = new FakeAdapter("opencode");
    const definition = graph(
      [agent("a"), checkpoint("gate", "automatic"), agent("b")],
      [edge("ag", "a", "gate"), edge("gb", "gate", "b")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("succeeded");
    expect(nodeIds(adapter)).toEqual(["a", "b"]);
    const gate = final.nodes.find((node) => node.nodeId === "gate")!;
    expect(gate.status).toBe("succeeded");
    expect(gate.visits).toBe(1);
  });

  it("pauses at a manual checkpoint and resumes on resume()", async () => {
    const adapter = new FakeAdapter("opencode");
    const definition = graph(
      [agent("a"), checkpoint("gate", "manual"), agent("b")],
      [edge("ag", "a", "gate"), edge("gb", "gate", "b")],
    );
    const { scheduler, compiled, plan, obs } = setup(definition, adapter);
    const paused = await scheduler.start(compiled, plan);
    expect(paused.status).toBe("paused");
    expect(nodeIds(adapter)).toEqual(["a"]);
    expect(paused.nodes.find((node) => node.nodeId === "gate")?.status).toBe(
      "waiting",
    );
    expect(obs.planUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" }),
    );

    const resumed = await scheduler.resume(compiled, paused);
    expect(resumed.status).toBe("succeeded");
    expect(nodeIds(adapter)).toEqual(["a", "b"]);
    expect(resumed.nodes.find((node) => node.nodeId === "gate")?.status).toBe(
      "succeeded",
    );
  });

  it("expands and runs subgraph nodes through the harness", async () => {
    const inner = graph([agent("p"), agent("q")], [edge("pq", "p", "q")]);
    inner.id = "inner";
    const outer = graph(
      [agent("x"), subgraph("S", "inner"), agent("y")],
      [edge("xs", "x", "S"), edge("sy", "S", "y")],
    );
    const adapter = new FakeAdapter("opencode");
    const database = new SpireDatabase(":memory:");
    const registry = createHarnessRegistry([adapter]);
    const scheduler = new GraphScheduler({
      database,
      registry,
      goal: "goal",
      directory: "/tmp/worktree",
      observer: observer(),
    });
    const resolver = () => inner;
    const compiled = compileGraph(outer, resolver);
    const plan = compileExecutionPlan(outer, "run-1", resolver);
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("succeeded");
    expect(nodeIds(adapter)).toEqual(["x", "S/p", "S/q", "y"]);
    database.close();
  });

  it("retries malformed structured output once on the same session", async () => {
    const adapter = new FakeAdapter("opencode", ["not json at all", ok()]);
    const definition = graph([agent("a")], []);
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("succeeded");
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1].job).toMatch(/not valid/i);
    expect(adapter.calls[1].session?.sessionId).toBe(
      `${"opencode"}-session-0`,
    );
  });

  it("fails the node when output is still malformed after one repair", async () => {
    const adapter = new FakeAdapter("opencode", ["junk", "more junk"]);
    const definition = graph([agent("a")], []);
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(adapter.calls).toHaveLength(2);
    expect(final.status).toBe("failed");
    expect(final.nodes[0].status).toBe("failed");
    expect(final.nodes[0].error).toBeTruthy();
  });

  it("persists harness sessions as soon as they are reported and reuses them", async () => {
    const adapter = new FakeAdapter("opencode");
    const definition = graph(
      [agent("a"), agent("b")],
      [edge("ab", "a", "b"), edge("ba", "b", "a")],
      4,
    );
    const { scheduler, compiled, plan, database } = setup(definition, adapter);
    await scheduler.start(compiled, plan);
    const session = database.getHarnessSession("run-1", "a");
    expect(session).toMatchObject({
      harnessId: "opencode",
      sessionId: "opencode-session-0",
      directory: "/tmp/worktree",
    });
    // The second visit of "a" resumes its persisted session.
    const revisit = adapter.calls.find(
      (call, index) => index > 0 && call.nodeId === "a",
    );
    expect(revisit?.session?.sessionId).toBe("opencode-session-0");
    database.close();
  });

  it("stop() aborts an in-flight attempt whose session is known", async () => {
    const adapter = new FakeAdapter("opencode", [], { hang: true });
    const definition = graph([agent("a")], []);
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const started = scheduler.start(compiled, plan);
    await vi.waitFor(() => expect(adapter.calls).toHaveLength(1));
    await scheduler.stop();
    const final = await started;
    expect(adapter.abortCalls).toEqual([
      expect.objectContaining({ sessionId: "opencode-session-0" }),
    ]);
    expect(final.nodes[0].status).toBe("cancelled");
    expect(final.status).toBe("paused");
  });

  it("stop() cancels an in-flight attempt even before its session is reported", async () => {
    const adapter = new FakeAdapter("opencode", [], {
      hang: true,
      skipSession: true,
    });
    const definition = graph([agent("a")], []);
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const started = scheduler.start(compiled, plan);
    await vi.waitFor(() => expect(adapter.calls).toHaveLength(1));
    await scheduler.stop();
    const final = await started;
    // No session was ever reported, so there is nothing to abort at the
    // adapter — but the pending run must still be cancelled, not left hanging.
    expect(adapter.abortCalls).toHaveLength(0);
    expect(final.nodes[0].status).toBe("cancelled");
    expect(final.status).toBe("paused");
  });

  it("resume() re-runs a cancelled attempt after a stop", async () => {
    const hanging = new FakeAdapter("opencode", [], { hang: true });
    const definition = graph([agent("a")], []);
    const { scheduler, compiled, plan } = setup(definition, hanging);
    const started = scheduler.start(compiled, plan);
    await vi.waitFor(() => expect(hanging.calls).toHaveLength(1));
    await scheduler.stop();
    const stopped = await started;
    expect(stopped.nodes[0].status).toBe("cancelled");

    const retrying = new FakeAdapter("opencode");
    const database = new SpireDatabase(":memory:");
    const registry = createHarnessRegistry([retrying]);
    const resumedScheduler = new GraphScheduler({
      database,
      registry,
      goal: "goal",
      directory: "/tmp/worktree",
      observer: observer(),
    });
    const final = await resumedScheduler.resume(compiled, stopped);
    expect(final.nodes[0].status).toBe("succeeded");
    expect(final.status).toBe("succeeded");
    database.close();
  });

  it("converts orphaned running attempts to failed on resume and keeps routing", async () => {
    const adapter = new FakeAdapter("opencode");
    const definition = graph(
      [agent("a"), agent("b"), agent("c")],
      [edge("ab", "a", "b"), edge("bc", "b", "c")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    // Simulate a crash: a finished, b was mid-flight when Spire closed.
    plan.nodes = [
      { nodeId: "a", status: "succeeded", visits: 1, outcome: ok() },
      { nodeId: "b", status: "running", visits: 1 },
      { nodeId: "c", status: "waiting", visits: 0 },
    ];
    plan.stepCount = 2;
    const final = await scheduler.resume(compiled, plan);

    const b = final.nodes.find((node) => node.nodeId === "b")!;
    expect(b.status).toBe("failed");
    expect(b.error).toMatch(/closed/i);
    // The run is not failed merely because Spire closed: failure routing
    // continues from the checkpoint and the plan can still succeed.
    expect(nodeIds(adapter)).toEqual(["c"]);
    expect(final.status).toBe("succeeded");
  });

  it("forwards normalized harness events and outcome summaries to the observer", async () => {
    const adapter = new FakeAdapter("opencode");
    const definition = graph([agent("a")], []);
    const { scheduler, compiled, plan, obs } = setup(definition, adapter);
    await scheduler.start(compiled, plan);
    expect(obs.harnessEvent).toHaveBeenCalledWith(
      "a",
      expect.objectContaining({ type: "tool_result" }),
    );
    expect(obs.nodeFinished).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      expect.objectContaining({
        status: "succeeded",
        outcome: expect.objectContaining({ status: "succeeded" }),
      }),
    );
  });
});
