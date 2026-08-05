import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
import { CollaborationWorkspace } from "../collaboration/workspace";
import { NodeWorkspaceCoordinator } from "../workspace/node-worktree";
import { compileExecutionPlan, compileGraph } from "./graph-compiler";
import {
  GraphScheduler,
  type GraphSchedulerDeps,
  type SchedulerObserver,
} from "./scheduler";

const exec = promisify(execFile);

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
    thinkingEffort: "medium",
    skills: [],
    goal: "",
    subGoals: [],
    integrations: [],
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
  /** Side effect performed mid-run (e.g. writing into the node directory). */
  sideEffect?: (input: HarnessRunInput) => Promise<void> | void;
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
    return Promise.resolve(this.options.sideEffect?.(input)).then(() => ({
      session: ref,
      output,
    }));
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
  extras: Partial<
    Pick<
      GraphSchedulerDeps,
      "collaboration" | "workspaces" | "directory" | "goal"
    >
  > = {},
) {
  const database = new SpireDatabase(":memory:");
  const registry = createHarnessRegistry([adapter]);
  const obs = observer();
  const scheduler = new GraphScheduler({
    database,
    registry,
    goal: extras.goal ?? "test goal",
    directory: extras.directory ?? "/tmp/worktree",
    observer: obs,
    collaboration: extras.collaboration,
    workspaces: extras.workspaces,
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

  it("does not block an all-join on a cycle back-edge whose source is unvisited", async () => {
    // Graph: implement → review → gate → {checkpoint, revise}
    //        revise → review  (cycle back-edge, selected)
    // review has activation "all" with two incoming edges:
    //   implement → review (success, forward)
    //   revise → review (selected, back-edge)
    // When gate selects checkpoint, revise never runs — the back-edge
    // never offers a token, but it must not block review's first activation.
    const adapter = new FakeAdapter("opencode", [
      ok("implement done"),
      ok("review done"),
      ok("gate done", ["gc"]),
      ok("checkpoint done"),
    ]);
    const definition = graph(
      [
        agent("implement"),
        agent("review", { activation: "all" }),
        agent("gate"),
        agent("revise"),
        agent("checkpoint"),
      ],
      [
        edge("ir", "implement", "review", "success"),
        edge("rg", "review", "gate", "success"),
        edge("gc", "gate", "checkpoint", "selected"),
        edge("gr", "gate", "revise", "selected"),
        edge("rr", "revise", "review", "selected"),
      ],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("succeeded");
    expect(final.nodes.find((n) => n.nodeId === "review")?.status).toBe(
      "succeeded",
    );
    expect(final.nodes.find((n) => n.nodeId === "revise")?.status).toBe(
      "skipped",
    );
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

// --- Collaboration + workspace wiring ----------------------------------------

function handoffMessage(
  recipient: NodeOutcome["messages"][number]["recipient"],
  subject: string,
): NodeOutcome["messages"][number] {
  return { recipient, kind: "handoff", subject, body: `body: ${subject}`, artifactPaths: [] };
}

function collaborationFor(
  userDataDir: string,
  definition: GraphDefinitionV2,
  runId = "run-1",
): CollaborationWorkspace {
  return new CollaborationWorkspace({
    userDataDir,
    runId,
    goal: "test goal",
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      groupId: node.groupId,
    })),
    edges: definition.edges.map((item) => ({
      source: item.source,
      target: item.target,
    })),
  });
}

/** A real source repo + integration worktree, as RunEngine would prepare. */
async function gitSetup(runId: string) {
  const root = await mkdtemp(path.join(tmpdir(), "spire-sched-git-"));
  const repository = path.join(root, "repository");
  await mkdir(repository);
  await exec("git", ["init", "-b", "main"], { cwd: repository });
  await exec("git", ["config", "user.email", "spire@example.test"], {
    cwd: repository,
  });
  await exec("git", ["config", "user.name", "Spire Test"], { cwd: repository });
  await mkdir(path.join(repository, "src"));
  await writeFile(path.join(repository, "README.md"), "# Fixture\n");
  await writeFile(path.join(repository, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(repository, "shared.txt"), "line\n");
  await exec("git", ["add", "."], { cwd: repository });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repository });
  const integrationPath = path.join(root, "integration");
  const integrationBranch = `spire/run-${runId}`;
  await exec(
    "git",
    ["worktree", "add", "-b", integrationBranch, integrationPath, "HEAD"],
    { cwd: repository },
  );
  const coordinator = new NodeWorkspaceCoordinator({
    repositoryPath: repository,
    integrationPath,
    integrationBranch,
    runId,
    rootDir: path.join(root, "nodes"),
  });
  return { root, repository, integrationPath, coordinator };
}

describe("GraphScheduler collaboration and workspaces", () => {
  it("delivers outcome messages to inboxes and the database", async () => {
    const adapter = new FakeAdapter("opencode", [
      { ...ok("a done"), messages: [handoffMessage({ kind: "node", id: "b" }, "Handoff notes")] },
      ok("b done"),
    ]);
    const definition = graph(
      [agent("a"), agent("b")],
      [edge("ab", "a", "b")],
    );
    const userDataDir = await mkdtemp(path.join(tmpdir(), "spire-collab-"));
    const collaboration = collaborationFor(userDataDir, definition);
    const { scheduler, compiled, plan, database } = setup(
      definition,
      adapter,
      "run-1",
      { collaboration },
    );
    const final = await scheduler.start(compiled, plan);

    expect(final.status).toBe("succeeded");
    const persisted = database.listCollaborationMessages("run-1");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      senderNodeId: "a",
      sequence: 0,
      subject: "Handoff notes",
    });
    const inbox = await readFile(
      path.join(collaboration.root, "inbox", "b.md"),
      "utf8",
    );
    expect(inbox).toContain("Handoff notes");
    database.close();
  });

  it("feeds a context packet with routing choices into HarnessRunInput.context", async () => {
    const adapter = new FakeAdapter("opencode", [
      { ...ok("a done"), messages: [handoffMessage({ kind: "successors" }, "Notes for b")] },
      ok("b done"),
    ]);
    const definition = graph(
      [agent("a"), decision("b"), agent("c")],
      [
        edge("ab", "a", "b"),
        { ...edge("e1", "b", "c", "selected"), label: "Continue" },
      ],
    );
    const userDataDir = await mkdtemp(path.join(tmpdir(), "spire-collab-"));
    const collaboration = collaborationFor(userDataDir, definition);
    const { scheduler, compiled, plan } = setup(definition, adapter, "run-1", {
      collaboration,
    });
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("succeeded");

    const bCall = adapter.calls.find((call) => call.nodeId === "b")!;
    // Context packet content.
    expect(bCall.context).toContain("test goal"); // run objective
    expect(bCall.context).toContain("job-b"); // node job
    expect(bCall.context).toContain("Notes for b"); // incoming message
    expect(bCall.context).toContain("a done"); // predecessor output
    // The Task 5 routing section survives inside the packet context.
    expect(bCall.context).toContain('"e1" (Continue)');
    expect(bCall.context).toContain("selectedEdgeIds");
  });

  it("runs workspace-write nodes isolated and merges at a checkpoint", async () => {
    const runId = "run-iso";
    const { integrationPath, coordinator } = await gitSetup(runId);
    const adapter = new FakeAdapter("opencode", [ok("wrote"), ok("read")], {
      sideEffect: async (input) => {
        if (input.nodeId === "writer") {
          await writeFile(
            path.join(input.directory, "src", "a.ts"),
            "export const a = 2;\n",
          );
        }
      },
    });
    const definition = graph(
      [
        agent("writer", {
          access: { mode: "workspace-write", writeScopes: ["src"] },
        }),
        checkpoint("gate", "automatic"),
        agent("reader"),
      ],
      [edge("wg", "writer", "gate"), edge("gr", "gate", "reader")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter, runId, {
      directory: integrationPath,
      workspaces: coordinator,
    });
    const final = await scheduler.start(compiled, plan);

    expect(final.status).toBe("succeeded");
    const writerCall = adapter.calls.find((call) => call.nodeId === "writer")!;
    const readerCall = adapter.calls.find((call) => call.nodeId === "reader")!;
    // The writer ran in its own worktree; the read-only reader in the run's.
    expect(writerCall.directory).not.toBe(integrationPath);
    expect(readerCall.directory).toBe(integrationPath);
    // The checkpoint merged the writer's branch into the integration branch.
    expect(
      await readFile(path.join(integrationPath, "src", "a.ts"), "utf8"),
    ).toBe("export const a = 2;\n");
    const diff = await coordinator.finalDiff();
    expect(diff.changedFiles).toEqual(["src/a.ts"]);
  });

  it("converts scope violations into node failures eligible for failure routing", async () => {
    const runId = "run-scope";
    const { integrationPath, coordinator } = await gitSetup(runId);
    const adapter = new FakeAdapter("opencode", [ok("wrote"), ok("handled")], {
      sideEffect: async (input) => {
        if (input.nodeId === "writer") {
          await writeFile(path.join(input.directory, "README.md"), "# Pwned\n");
        }
      },
    });
    const definition = graph(
      [
        agent("writer", {
          access: { mode: "workspace-write", writeScopes: ["src"] },
        }),
        agent("handler"),
      ],
      [edge("wh", "writer", "handler", "failure")],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter, runId, {
      directory: integrationPath,
      workspaces: coordinator,
    });
    const final = await scheduler.start(compiled, plan);

    const writer = final.nodes.find((node) => node.nodeId === "writer")!;
    expect(writer.status).toBe("failed");
    expect(writer.error).toMatch(/write scopes/);
    expect(writer.error).toContain("README.md");
    // The failure routed to the handler, so the plan still succeeds — and
    // the out-of-scope edit never reached the integration worktree.
    expect(nodeIds(adapter)).toEqual(["writer", "handler"]);
    expect(final.status).toBe("succeeded");
    expect(await readFile(path.join(integrationPath, "README.md"), "utf8")).toBe(
      "# Fixture\n",
    );
  });

  it("converts checkpoint merge conflicts into node failures", async () => {
    const runId = "run-conflict";
    const { integrationPath, coordinator } = await gitSetup(runId);
    const adapter = new FakeAdapter(
      "opencode",
      [ok("first"), ok("second")],
      {
        sideEffect: async (input) => {
          if (input.nodeId !== "w-first" && input.nodeId !== "w-second") return;
          const content = input.nodeId === "w-first" ? "first\n" : "second\n";
          await writeFile(path.join(input.directory, "shared.txt"), content);
        },
      },
    );
    const writeAccess = {
      mode: "workspace-write" as const,
      writeScopes: ["shared.txt"],
    };
    const definition = graph(
      [
        agent("w-first", { access: writeAccess }),
        agent("w-second", { access: writeAccess }),
        checkpoint("gate", "automatic"),
        agent("handler"),
      ],
      [
        edge("fg", "w-first", "gate"),
        edge("sg", "w-second", "gate"),
        edge("sh", "w-second", "handler", "failure"),
      ],
    );
    const { scheduler, compiled, plan } = setup(definition, adapter, runId, {
      directory: integrationPath,
      workspaces: coordinator,
    });
    const final = await scheduler.start(compiled, plan);

    // Node-id order: w-first merged, w-second conflicted and failed.
    expect(
      final.nodes.find((node) => node.nodeId === "w-first")?.status,
    ).toBe("succeeded");
    const second = final.nodes.find((node) => node.nodeId === "w-second")!;
    expect(second.status).toBe("failed");
    expect(second.error).toMatch(/merge conflict/i);
    expect(second.error).toContain("shared.txt");
    expect(
      await readFile(path.join(integrationPath, "shared.txt"), "utf8"),
    ).toBe("first\n");
    // The conflict failure is eligible for failure routing: the handler on
    // w-second's failure edge ran, so the plan settles succeeded.
    expect(nodeIds(adapter)).toContain("handler");
    expect(final.status).toBe("succeeded");
  });

  it("converts collaboration delivery failures into node failures without crashing", async () => {
    const adapter = new FakeAdapter("opencode", [
      { ...ok("a done"), messages: [handoffMessage({ kind: "node", id: "b" }, "Doomed")] },
    ]);
    const definition = graph(
      [agent("a"), agent("b")],
      [edge("ab", "a", "b", "success")],
    );
    const userDataDir = await mkdtemp(path.join(tmpdir(), "spire-collab-"));
    const collaboration = collaborationFor(userDataDir, definition);
    vi.spyOn(collaboration, "deliver").mockRejectedValue(
      new Error("disk full"),
    );
    const { scheduler, compiled, plan } = setup(definition, adapter, "run-1", {
      collaboration,
    });
    const final = await scheduler.start(compiled, plan);

    const a = final.nodes.find((node) => node.nodeId === "a")!;
    expect(a.status).toBe("failed");
    expect(a.error).toBe("disk full");
    // No failure routing out of "a": the plan fails and b settles skipped.
    expect(final.status).toBe("failed");
    expect(final.nodes.find((node) => node.nodeId === "b")?.status).toBe(
      "skipped",
    );
  });

  it("serializes message delivery so concurrent nodes get unique chronological sequences", async () => {
    // Two seed nodes run concurrently; "a" emits two drafts, "b" one. The
    // deliver stub yields a macrotask per call, so without serialization
    // node's a read-count → append → deliver sequence interleaves with b's
    // and a's second draft reuses b's sequence (duplicate <runId>:<seq>).
    const adapter = new FakeAdapter("opencode", [
      {
        ...ok("a done"),
        messages: [
          handoffMessage({ kind: "node", id: "b" }, "a-first"),
          handoffMessage({ kind: "node", id: "b" }, "a-second"),
        ],
      },
      { ...ok("b done"), messages: [handoffMessage({ kind: "node", id: "a" }, "b-only")] },
    ]);
    const definition = graph([agent("a"), agent("b")], []);
    const userDataDir = await mkdtemp(path.join(tmpdir(), "spire-collab-"));
    const collaboration = collaborationFor(userDataDir, definition);
    const delivered: number[] = [];
    vi.spyOn(collaboration, "deliver").mockImplementation(async (message) => {
      delivered.push(message.sequence);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return [];
    });
    const { scheduler, compiled, plan, database } = setup(
      definition,
      adapter,
      "run-1",
      { collaboration },
    );
    const final = await scheduler.start(compiled, plan);

    expect(final.status).toBe("succeeded");
    // Exactly one deliver per draft, with unique monotonic sequences.
    expect(delivered).toHaveLength(3);
    const persisted = database.listCollaborationMessages("run-1");
    expect(persisted).toHaveLength(3);
    expect(persisted.map((message) => message.sequence)).toEqual([0, 1, 2]);
    expect(new Set(persisted.map((message) => message.id)).size).toBe(3);
    expect([...delivered].sort((x, y) => x - y)).toEqual([0, 1, 2]);
    database.close();
  });
});
