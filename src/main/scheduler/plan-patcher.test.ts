import { describe, expect, it, vi } from "vitest";
import type {
  AgentNode,
  CheckpointNode,
  GraphDefinitionV2,
  GraphEdge,
  GraphGroup,
  GraphNode,
  NodeAuthority,
} from "../../shared/domain";
import type {
  ExecutionPlan,
  NodeExecutionStatus,
  NodeOutcome,
  PlanPatchDraft,
  PlanPatchOperation,
} from "../../shared/execution";
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
import {
  applyPlanPatch,
  buildGraphVersionInput,
  PlanPatchError,
  rebuildRuntimeGraph,
  rollbackPlanPatch,
  validatePlanPatch,
} from "./plan-patcher";
import { GraphScheduler, type SchedulerObserver } from "./scheduler";

// --- Fixtures ---------------------------------------------------------------

function authority(scope: NodeAuthority["scope"], actions: NodeAuthority["actions"]): NodeAuthority {
  return { scope, actions };
}

const ALL_ACTIONS: NodeAuthority["actions"] = [
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

function checkpoint(id: string, mode: "automatic" | "manual"): CheckpointNode {
  return { kind: "checkpoint", id, name: id, mode, position: { x: 0, y: 0 } };
}

function edge(
  id: string,
  source: string,
  target: string,
  when: GraphEdge["when"] = "always",
): GraphEdge {
  return { id, source, target, kind: "dependency", when, label: id };
}

function definition(
  nodes: GraphNode[],
  edges: GraphEdge[],
  groups: GraphGroup[] = [],
): GraphDefinitionV2 {
  return {
    id: "graph",
    name: "Test",
    version: 1,
    nodes,
    edges,
    groups,
    maxSteps: 100,
    createdAt: new Date().toISOString(),
  };
}

function setup(
  nodes: GraphNode[],
  edges: GraphEdge[],
  groups: GraphGroup[] = [],
) {
  const graph = definition(nodes, edges, groups);
  const compiled = compileGraph(graph);
  const plan = compileExecutionPlan(graph, "run-1");
  return { graph, compiled, plan };
}

function setExecution(
  plan: ExecutionPlan,
  nodeId: string,
  status: NodeExecutionStatus,
  visits = 0,
): void {
  const execution = plan.nodes.find((node) => node.nodeId === nodeId)!;
  execution.status = status;
  execution.visits = visits;
}

function draft(
  operations: PlanPatchOperation[],
  baseRevision = 0,
): PlanPatchDraft {
  return { baseRevision, reason: "test patch", operations };
}

function nodeIds(plan: ExecutionPlan): string[] {
  return plan.nodes.map((node) => node.nodeId);
}

function edgeIds(plan: ExecutionPlan): string[] {
  return plan.edges.map((item) => item.id);
}

// --- validatePlanPatch ------------------------------------------------------

describe("validatePlanPatch", () => {
  it("accepts a well-formed authorized patch", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    expect(
      validatePlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: "b" }])),
    ).toEqual([]);
  });

  it("rejects a stale base revision", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    plan.revision = 3;
    const issues = validatePlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "skip", nodeId: "b" }], 2),
    );
    expect(issues.join(" ")).toMatch(/base revision/i);
  });

  it("rejects an unknown actor and a non-agent actor", () => {
    const { compiled, plan } = setup(
      [agent("a"), checkpoint("cp", "automatic")],
      [edge("acp", "a", "cp")],
    );
    expect(
      validatePlanPatch(plan, compiled, "ghost", draft([{ action: "skip", nodeId: "a" }])).join(" "),
    ).toMatch(/actor/i);
    expect(
      validatePlanPatch(plan, compiled, "cp", draft([{ action: "skip", nodeId: "a" }])).join(" "),
    ).toMatch(/actor/i);
  });

  it("rejects actions the actor's authority does not grant", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ["retry"]) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    const issues = validatePlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "skip", nodeId: "b" }]),
    );
    expect(issues.join(" ")).toMatch(/skip/i);
  });

  it("limits self scope to the actor's own node", () => {
    const { compiled, plan } = setup(
      [
        agent("a", { authority: authority("self", ["retry", "skip"]) }),
        agent("b"),
      ],
      [edge("ab", "a", "b")],
    );
    setExecution(plan, "a", "failed", 1);
    expect(
      validatePlanPatch(plan, compiled, "a", draft([{ action: "retry", nodeId: "a" }])),
    ).toEqual([]);
    expect(
      validatePlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: "b" }])).join(" "),
    ).toMatch(/scope/i);
  });

  it("limits connected scope to adjacent nodes", () => {
    const { compiled, plan } = setup(
      [
        agent("a"),
        agent("b", { authority: authority("connected", ["skip"]) }),
        agent("c"),
        agent("d"),
      ],
      [edge("ab", "a", "b"), edge("bc", "b", "c"), edge("cd", "c", "d")],
    );
    expect(
      validatePlanPatch(plan, compiled, "b", draft([{ action: "skip", nodeId: "a" }])),
    ).toEqual([]);
    expect(
      validatePlanPatch(plan, compiled, "b", draft([{ action: "skip", nodeId: "c" }])),
    ).toEqual([]);
    expect(
      validatePlanPatch(plan, compiled, "b", draft([{ action: "skip", nodeId: "d" }])).join(" "),
    ).toMatch(/scope/i);
  });

  it("limits group scope to the actor's group members", () => {
    const groups: GraphGroup[] = [
      { id: "g1", name: "g1" },
      { id: "g2", name: "g2" },
    ];
    const { compiled, plan } = setup(
      [
        agent("a", { authority: authority("group", ["skip"]), groupId: "g1" }),
        agent("b", { groupId: "g1" }),
        agent("c", { groupId: "g2" }),
      ],
      [edge("ab", "a", "b"), edge("bc", "b", "c")],
      groups,
    );
    expect(
      validatePlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: "b" }])),
    ).toEqual([]);
    expect(
      validatePlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: "c" }])).join(" "),
    ).toMatch(/scope/i);
  });

  it("restricts reroute at connected scope to edges incident to the actor", () => {
    const { compiled, plan } = setup(
      [
        agent("a"),
        agent("b", { authority: authority("connected", ["reroute"]) }),
        agent("c"),
        agent("d"),
      ],
      [edge("ab", "a", "b"), edge("bc", "b", "c"), edge("cd", "c", "d")],
    );
    expect(
      validatePlanPatch(
        plan,
        compiled,
        "b",
        draft([{ action: "reroute", enableEdgeIds: [], disableEdgeIds: ["bc"] }]),
      ),
    ).toEqual([]);
    expect(
      validatePlanPatch(
        plan,
        compiled,
        "b",
        draft([{ action: "reroute", enableEdgeIds: [], disableEdgeIds: ["cd"] }]),
      ).join(" "),
    ).toMatch(/scope/i);
  });

  it("allows pause only at graph scope", () => {
    const { compiled, plan } = setup(
      [
        agent("a", { authority: authority("connected", ["pause"]) }),
        agent("b", { authority: authority("graph", ["pause"]) }),
      ],
      [edge("ab", "a", "b")],
    );
    expect(
      validatePlanPatch(plan, compiled, "a", draft([{ action: "pause", reason: "hold" }])).join(" "),
    ).toMatch(/scope/i);
    expect(
      validatePlanPatch(plan, compiled, "b", draft([{ action: "pause", reason: "hold" }])),
    ).toEqual([]);
  });

  it("rejects unknown node and edge references", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    expect(
      validatePlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: "ghost" }])).join(" "),
    ).toMatch(/ghost/);
    expect(
      validatePlanPatch(
        plan,
        compiled,
        "a",
        draft([{ action: "reroute", enableEdgeIds: ["ghost-edge"], disableEdgeIds: [] }]),
      ).join(" "),
    ).toMatch(/ghost-edge/);
    expect(
      validatePlanPatch(
        plan,
        compiled,
        "a",
        draft([{ action: "reorder", nodeId: "b", beforeNodeId: "ghost" }]),
      ).join(" "),
    ).toMatch(/ghost/);
  });

  it("rejects enabling an active edge and disabling an inactive edge", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ["reroute"]) }), agent("b")],
      [edge("ab", "a", "b"), edge("ba", "b", "a")],
    );
    expect(
      validatePlanPatch(
        plan,
        compiled,
        "a",
        draft([{ action: "reroute", enableEdgeIds: ["ab"], disableEdgeIds: [] }]),
      ).join(" "),
    ).toMatch(/ab/);
    // Simulate a previously disabled edge: absent from the plan, present in the universe.
    plan.edges = plan.edges.filter((item) => item.id !== "ba");
    expect(
      validatePlanPatch(
        plan,
        compiled,
        "a",
        draft([{ action: "reroute", enableEdgeIds: [], disableEdgeIds: ["ba"] }]),
      ).join(" "),
    ).toMatch(/ba/);
    expect(
      validatePlanPatch(
        plan,
        compiled,
        "a",
        draft([{ action: "reroute", enableEdgeIds: ["ba"], disableEdgeIds: [] }]),
      ),
    ).toEqual([]);
  });

  it("never removes or replaces a running or completed node", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b"), agent("c")],
      [edge("ab", "a", "b"), edge("bc", "b", "c")],
    );
    setExecution(plan, "b", "running", 1);
    setExecution(plan, "c", "succeeded", 1);
    for (const target of ["b", "c"]) {
      expect(
        validatePlanPatch(plan, compiled, "a", draft([{ action: "remove", nodeId: target }])).join(" "),
      ).toMatch(new RegExp(target));
      expect(
        validatePlanPatch(
          plan,
          compiled,
          "a",
          draft([{ action: "replace", nodeId: target, replacement: agent(`${target}2`) }]),
        ).join(" "),
      ).toMatch(new RegExp(target));
      expect(
        validatePlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: target }])).join(" "),
      ).toMatch(new RegExp(target));
    }
  });

  it("rejects retrying a node that is running or out of visits", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ["retry"]) }), agent("b", { maxVisits: 2 })],
      [edge("ab", "a", "b")],
    );
    setExecution(plan, "b", "running", 1);
    expect(
      validatePlanPatch(plan, compiled, "a", draft([{ action: "retry", nodeId: "b" }])).join(" "),
    ).toMatch(/b/);
    setExecution(plan, "b", "failed", 2);
    expect(
      validatePlanPatch(plan, compiled, "a", draft([{ action: "retry", nodeId: "b" }])).join(" "),
    ).toMatch(/maxVisits|visits/i);
  });

  it("rejects subgraph nodes and duplicate ids in insert/replace", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    const subgraphNode: GraphNode = {
      kind: "subgraph",
      id: "s1",
      name: "s1",
      graphId: "other",
      position: { x: 0, y: 0 },
    };
    expect(
      validatePlanPatch(
        plan,
        compiled,
        "a",
        draft([{ action: "insert", node: subgraphNode, edges: [] }]),
      ).join(" "),
    ).toMatch(/subgraph/i);
    expect(
      validatePlanPatch(
        plan,
        compiled,
        "a",
        draft([{ action: "insert", node: agent("b"), edges: [] }]),
      ).join(" "),
    ).toMatch(/b/);
    expect(
      validatePlanPatch(
        plan,
        compiled,
        "a",
        draft([{ action: "replace", nodeId: "b", replacement: subgraphNode }]),
      ).join(" "),
    ).toMatch(/subgraph/i);
  });

  it("requires insert edges to attach the new node to the plan", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ["insert"]) }), agent("b"), agent("c")],
      [edge("ab", "a", "b"), edge("bc", "b", "c")],
    );
    expect(
      validatePlanPatch(
        plan,
        compiled,
        "a",
        draft([{ action: "insert", node: agent("n2"), edges: [edge("bn2", "b", "n2")] }]),
      ),
    ).toEqual([]);
    expect(
      validatePlanPatch(
        plan,
        compiled,
        "a",
        draft([{ action: "insert", node: agent("n2"), edges: [edge("bc2", "b", "c")] }]),
      ).join(" "),
    ).toMatch(/n2/);
  });
});

// --- applyPlanPatch ---------------------------------------------------------

describe("applyPlanPatch", () => {
  it("skips a pending node and records the audited patch", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    const result = applyPlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: "b" }]), {
      patchId: "patch-1",
      appliedAt: "2026-07-31T10:00:00.000Z",
    });
    expect(plan.revision).toBe(1);
    const b = plan.nodes.find((node) => node.nodeId === "b")!;
    expect(b.status).toBe("skipped");
    expect(result.removedNodeIds).toEqual([]);
    expect(result.changedNodes.map((node) => node.nodeId)).toEqual(["b"]);
    expect(result.patch).toMatchObject({
      id: "patch-1",
      actorNodeId: "a",
      baseRevision: 0,
      appliedRevision: 1,
      appliedAt: "2026-07-31T10:00:00.000Z",
    });
    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].id).toBe("patch-1");
  });

  it("re-queues a failed node on retry and clears its error", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    setExecution(plan, "b", "failed", 1);
    plan.nodes[1].error = "boom";
    applyPlanPatch(plan, compiled, "a", draft([{ action: "retry", nodeId: "b" }]));
    const b = plan.nodes.find((node) => node.nodeId === "b")!;
    expect(b.status).toBe("queued");
    expect(b.error).toBeUndefined();
    expect(b.visits).toBe(1);
  });

  it("removes a pending node with its incident edges", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b"), agent("c")],
      [edge("ab", "a", "b"), edge("bc", "b", "c")],
    );
    const result = applyPlanPatch(plan, compiled, "a", draft([{ action: "remove", nodeId: "b" }]));
    expect(nodeIds(plan)).toEqual(["a", "c"]);
    expect(edgeIds(plan)).toEqual([]);
    expect(result.removedNodeIds).toEqual(["b"]);
  });

  it("reroutes by disabling and enabling edges", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b"), edge("ba", "b", "a")],
    );
    plan.edges = plan.edges.filter((item) => item.id !== "ba");
    applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "reroute", enableEdgeIds: ["ba"], disableEdgeIds: ["ab"] }]),
    );
    expect(edgeIds(plan)).toEqual(["ba"]);
  });

  it("reorders a node before another in the plan order", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b"), agent("c")],
      [edge("ab", "a", "b"), edge("bc", "b", "c")],
    );
    applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "reorder", nodeId: "c", beforeNodeId: "b" }]),
    );
    expect(nodeIds(plan)).toEqual(["a", "c", "b"]);
  });

  it("replaces a pending node: new node wired in, only pending work superseded", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b"), agent("c")],
      [edge("ab", "a", "b"), edge("bc", "b", "c")],
    );
    const result = applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "replace", nodeId: "b", replacement: agent("b2", { job: "job-b2" }) }]),
    );
    expect(nodeIds(plan)).toEqual(["a", "b", "b2", "c"]);
    const original = plan.nodes.find((node) => node.nodeId === "b")!;
    expect(original.status).toBe("skipped");
    const replacement = plan.nodes.find((node) => node.nodeId === "b2")!;
    expect(replacement.status).toBe("waiting");
    expect(replacement.visits).toBe(0);
    // Existing edges keep their ids but are rewired to the replacement.
    expect(plan.edges).toEqual([
      expect.objectContaining({ id: "ab", source: "a", target: "b2" }),
      expect.objectContaining({ id: "bc", source: "b2", target: "c" }),
    ]);
    // The runtime universe carries the replacement's configuration.
    expect(compiled.nodes.find((node) => node.id === "b2")).toMatchObject({
      id: "b2",
      job: "job-b2",
    });
    expect(result.changedNodes.map((node) => node.nodeId)).toEqual(["b", "b2"]);
  });

  it("inserts a new node with its edges", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "insert", node: agent("n2"), edges: [edge("an2", "a", "n2")] }]),
    );
    expect(nodeIds(plan)).toEqual(["a", "b", "n2"]);
    expect(edgeIds(plan)).toEqual(["ab", "an2"]);
    expect(compiled.nodes.map((node) => node.id)).toContain("n2");
    expect(compiled.edges.map((item) => item.id)).toContain("an2");
  });

  it("edits a pending node's configuration in place", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "edit", nodeId: "b", replacement: agent("b", { job: "rewritten" }) }]),
    );
    expect(nodeIds(plan)).toEqual(["a", "b"]);
    expect(compiled.nodes.find((node) => node.id === "b")).toMatchObject({ job: "rewritten" });
  });

  it("rejects edit when the replacement id or kind changes", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    expect(() =>
      applyPlanPatch(
        plan,
        compiled,
        "a",
        draft([{ action: "edit", nodeId: "b", replacement: agent("b2") }]),
      ),
    ).toThrowError(PlanPatchError);
    expect(() =>
      applyPlanPatch(
        plan,
        compiled,
        "a",
        draft([
          { action: "edit", nodeId: "b", replacement: checkpoint("b", "automatic") },
        ]),
      ),
    ).toThrowError(PlanPatchError);
  });

  it("pauses the plan", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    applyPlanPatch(plan, compiled, "a", draft([{ action: "pause", reason: "hold" }]));
    expect(plan.status).toBe("paused");
  });

  it("fails a multi-operation patch atomically with no partial apply", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b"), agent("c")],
      [edge("ab", "a", "b"), edge("bc", "b", "c")],
    );
    setExecution(plan, "c", "running", 1);
    const before = structuredClone(plan);
    const beforeGraph = structuredClone(compiled);
    let error: unknown;
    try {
      applyPlanPatch(
        plan,
        compiled,
        "a",
        draft([
          { action: "skip", nodeId: "b" },
          { action: "remove", nodeId: "c" },
        ]),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PlanPatchError);
    expect((error as PlanPatchError).issues.join(" ")).toMatch(/c/);
    // No partial apply: plan, universe, revision, and audit log are untouched.
    expect(plan).toEqual(before);
    expect(compiled).toEqual(beforeGraph);
    expect(plan.revision).toBe(0);
    expect(plan.patches).toEqual([]);
  });
});

// --- rebuildRuntimeGraph ----------------------------------------------------

describe("rebuildRuntimeGraph", () => {
  it("replays non-rolled-back patches onto the base graph", () => {
    const { graph, compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([
        { action: "insert", node: agent("n2"), edges: [edge("an2", "a", "n2")] },
        { action: "edit", nodeId: "b", replacement: agent("b", { job: "rewritten" }) },
      ]),
    );
    const rebuilt = rebuildRuntimeGraph(compileGraph(graph), plan.patches);
    expect(rebuilt).toEqual(compiled);
    expect(rebuilt.nodes.find((node) => node.id === "b")).toMatchObject({ job: "rewritten" });
  });

  it("skips rolled-back patches during replay", () => {
    const { graph, compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    const pre = structuredClone(plan);
    applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "edit", nodeId: "b", replacement: agent("b", { job: "rewritten" }) }]),
    );
    const applied = structuredClone(plan);
    rollbackPlanPatch(plan, compiled, plan.patches[0].id, { base: pre, applied });
    const rebuilt = rebuildRuntimeGraph(compileGraph(graph), plan.patches);
    expect(rebuilt.nodes.find((node) => node.id === "b")).toMatchObject({ job: "job-b" });
  });
});

// --- rollbackPlanPatch ------------------------------------------------------

describe("rollbackPlanPatch", () => {
  function patchedSetup() {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b"), agent("c")],
      [edge("ab", "a", "b"), edge("bc", "b", "c")],
    );
    return { compiled, plan };
  }

  it("rolls back a skip as a new audited revision", () => {
    const { compiled, plan } = patchedSetup();
    const pre = structuredClone(plan);
    applyPlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: "b" }]), {
      patchId: "patch-1",
    });
    const applied = structuredClone(plan);
    const result = rollbackPlanPatch(
      plan,
      compiled,
      "patch-1",
      { base: pre, applied },
      { patchId: "patch-2", appliedAt: "2026-07-31T11:00:00.000Z" },
    );
    expect(plan.revision).toBe(2);
    const b = plan.nodes.find((node) => node.nodeId === "b")!;
    expect(b.status).toBe("waiting");
    expect(result.patch).toMatchObject({
      id: "patch-2",
      actorNodeId: "a",
      baseRevision: 1,
      appliedRevision: 2,
      operations: [{ action: "retry", nodeId: "b" }],
    });
    expect(plan.patches).toHaveLength(2);
    expect(plan.patches[0].rolledBackBy).toBe("patch-2");
  });

  it("restores rerouted edges from the revision snapshot", () => {
    const { compiled, plan } = patchedSetup();
    const pre = structuredClone(plan);
    applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "reroute", enableEdgeIds: [], disableEdgeIds: ["bc"] }]),
      { patchId: "patch-1" },
    );
    expect(edgeIds(plan)).toEqual(["ab"]);
    const applied = structuredClone(plan);
    const result = rollbackPlanPatch(plan, compiled, "patch-1", { base: pre, applied });
    expect(edgeIds(plan)).toEqual(["ab", "bc"]);
    expect(result.patch.operations).toEqual([
      { action: "reroute", enableEdgeIds: ["bc"], disableEdgeIds: [] },
    ]);
  });

  it("restores a removed node with its snapshot state and edges", () => {
    const { compiled, plan } = patchedSetup();
    const pre = structuredClone(plan);
    applyPlanPatch(plan, compiled, "a", draft([{ action: "remove", nodeId: "b" }]), {
      patchId: "patch-1",
    });
    expect(nodeIds(plan)).toEqual(["a", "c"]);
    const applied = structuredClone(plan);
    const result = rollbackPlanPatch(plan, compiled, "patch-1", { base: pre, applied });
    expect(nodeIds(plan)).toEqual(["a", "b", "c"]);
    expect(edgeIds(plan)).toEqual(["ab", "bc"]);
    expect(plan.nodes.find((node) => node.nodeId === "b")).toMatchObject({
      status: "waiting",
      visits: 0,
    });
    expect(result.removedNodeIds).toEqual([]);
    expect(result.patch.operations[0]).toMatchObject({ action: "insert" });
  });

  it("drops a node added by an insert patch", () => {
    const { compiled, plan } = patchedSetup();
    const pre = structuredClone(plan);
    applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "insert", node: agent("n2"), edges: [edge("an2", "a", "n2")] }]),
      { patchId: "patch-1" },
    );
    const applied = structuredClone(plan);
    const result = rollbackPlanPatch(plan, compiled, "patch-1", { base: pre, applied });
    expect(nodeIds(plan)).toEqual(["a", "b", "c"]);
    expect(edgeIds(plan)).toEqual(["ab", "bc"]);
    expect(result.removedNodeIds).toEqual(["n2"]);
    expect(result.patch.operations).toEqual([{ action: "remove", nodeId: "n2" }]);
  });

  it("restores the original node after rolling back a replace", () => {
    const { compiled, plan } = patchedSetup();
    const pre = structuredClone(plan);
    applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "replace", nodeId: "b", replacement: agent("b2") }]),
      { patchId: "patch-1" },
    );
    const applied = structuredClone(plan);
    const result = rollbackPlanPatch(plan, compiled, "patch-1", { base: pre, applied });
    expect(nodeIds(plan)).toEqual(["a", "b", "c"]);
    expect(plan.nodes.find((node) => node.nodeId === "b")).toMatchObject({
      status: "waiting",
      visits: 0,
    });
    expect(plan.edges).toEqual([
      expect.objectContaining({ id: "ab", target: "b" }),
      expect.objectContaining({ id: "bc", source: "b" }),
    ]);
    expect(result.removedNodeIds).toEqual(["b2"]);
  });

  it("resumes the plan when rolling back a pause", () => {
    const { compiled, plan } = patchedSetup();
    const pre = structuredClone(plan);
    applyPlanPatch(plan, compiled, "a", draft([{ action: "pause", reason: "hold" }]), {
      patchId: "patch-1",
    });
    expect(plan.status).toBe("paused");
    const applied = structuredClone(plan);
    rollbackPlanPatch(plan, compiled, "patch-1", { base: pre, applied });
    expect(plan.status).toBe("running");
  });

  it("rejects rolling back anything but the latest active patch", () => {
    const { compiled, plan } = patchedSetup();
    applyPlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: "b" }]), {
      patchId: "patch-1",
    });
    applyPlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: "c" }], 1), {
      patchId: "patch-2",
    });
    const pre = structuredClone(plan);
    expect(() =>
      rollbackPlanPatch(plan, compiled, "patch-1", { base: pre, applied: pre }),
    ).toThrowError(/latest/i);
  });

  it("rejects rolling back an already rolled-back patch", () => {
    const { compiled, plan } = patchedSetup();
    const pre = structuredClone(plan);
    applyPlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: "b" }]), {
      patchId: "patch-1",
    });
    const applied = structuredClone(plan);
    rollbackPlanPatch(plan, compiled, "patch-1", { base: pre, applied });
    expect(() =>
      rollbackPlanPatch(plan, compiled, "patch-1", { base: pre, applied }),
    ).toThrowError(/rolled back/i);
  });

  it("rejects rollback when a node added by the patch has already run", () => {
    const { compiled, plan } = patchedSetup();
    const pre = structuredClone(plan);
    applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "insert", node: agent("n2"), edges: [edge("an2", "a", "n2")] }]),
      { patchId: "patch-1" },
    );
    const applied = structuredClone(plan);
    setExecution(plan, "n2", "succeeded", 1);
    expect(() =>
      rollbackPlanPatch(plan, compiled, "patch-1", { base: pre, applied }),
    ).toThrowError(/n2/);
  });

  it("rejects rollback when an affected node has progressed since the patch", () => {
    const { compiled, plan } = patchedSetup();
    const pre = structuredClone(plan);
    applyPlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: "b" }]), {
      patchId: "patch-1",
    });
    const applied = structuredClone(plan);
    // The patch was applied, then b ran anyway (e.g. via a later manual retry).
    setExecution(plan, "b", "succeeded", 1);
    expect(() =>
      rollbackPlanPatch(plan, compiled, "patch-1", { base: pre, applied }),
    ).toThrowError(/b/);
  });

  it("rejects unknown patches and mismatched snapshots", () => {
    const { compiled, plan } = patchedSetup();
    const pre = structuredClone(plan);
    applyPlanPatch(plan, compiled, "a", draft([{ action: "skip", nodeId: "b" }]), {
      patchId: "patch-1",
    });
    const applied = structuredClone(plan);
    expect(() =>
      rollbackPlanPatch(plan, compiled, "ghost", { base: pre, applied }),
    ).toThrowError(/ghost/);
    const wrongBase = structuredClone(pre);
    wrongBase.revision = 99;
    expect(() =>
      rollbackPlanPatch(plan, compiled, "patch-1", { base: wrongBase, applied }),
    ).toThrowError(PlanPatchError);
  });
});

// --- buildGraphVersionInput -------------------------------------------------

describe("buildGraphVersionInput", () => {
  it("promotes the current runtime topology without run state", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b"), agent("c")],
      [edge("ab", "a", "b"), edge("bc", "b", "c")],
    );
    setExecution(plan, "a", "succeeded", 1);
    applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "replace", nodeId: "b", replacement: agent("b2", { job: "job-b2" }) }]),
    );
    const input = buildGraphVersionInput(plan, compiled, { name: "Promoted" });
    expect(input).toMatchObject({
      graphId: "graph",
      name: "Promoted",
      baseVersion: 1,
      maxSteps: 100,
    });
    // The superseded node is stripped as temporary replacement metadata; the
    // replacement carries no run state (status, visits, outcome, messages).
    expect(input.nodes.map((node) => node.id)).toEqual(["a", "b2", "c"]);
    expect(input.nodes.find((node) => node.id === "b2")).toMatchObject({ job: "job-b2" });
    expect(input.edges).toEqual([
      expect.objectContaining({ id: "ab", target: "b2" }),
      expect.objectContaining({ id: "bc", source: "b2" }),
    ]);
    for (const node of input.nodes) {
      expect(node).not.toHaveProperty("status");
      expect(node).not.toHaveProperty("outcome");
    }
  });

  it("uses the active edge set, not disabled edges", () => {
    const { compiled, plan } = setup(
      [agent("a", { authority: authority("graph", ALL_ACTIONS) }), agent("b")],
      [edge("ab", "a", "b"), edge("ba", "b", "a")],
    );
    applyPlanPatch(
      plan,
      compiled,
      "a",
      draft([{ action: "reroute", enableEdgeIds: [], disableEdgeIds: ["ba"] }]),
    );
    const input = buildGraphVersionInput(plan, compiled);
    expect(input.edges.map((item) => item.id)).toEqual(["ab"]);
    expect(input.name).toBe("graph");
  });
});

// --- Scheduler integration --------------------------------------------------

function ok(summary = "done"): NodeOutcome {
  return { status: "succeeded", summary, artifacts: [], messages: [], selectedEdgeIds: [] };
}

class FakeAdapter implements HarnessAdapter {
  readonly calls: HarnessRunInput[] = [];
  private index = 0;

  constructor(
    readonly id: "opencode",
    private readonly outputs: unknown[] = [],
  ) {}

  async probe(): Promise<HarnessProbeStatus> {
    return { harnessId: this.id, installed: true, compatible: true, connected: true };
  }
  async listModels() {
    return [];
  }
  run(input: HarnessRunInput): Promise<HarnessRunResult> {
    this.calls.push(input);
    const ref: HarnessSessionRef = {
      harnessId: this.id,
      sessionId: `${this.id}-session-${this.index}`,
      directory: input.directory,
    };
    input.onSession(ref);
    const output = this.outputs[this.index] ?? ok(`output-${this.index}`);
    this.index += 1;
    return Promise.resolve({ session: ref, output });
  }
  async abort(): Promise<void> {}
  async close(): Promise<void> {}
}

function observer(): SchedulerObserver {
  return {
    nodeStarted: vi.fn(),
    nodeFinished: vi.fn(),
    harnessEvent: vi.fn(),
    planUpdated: vi.fn(),
  };
}

function schedulerSetup(graph: GraphDefinitionV2, adapter: FakeAdapter) {
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
  const compiled = compileGraph(graph);
  const plan = compileExecutionPlan(graph, "run-1");
  return { database, obs, scheduler, compiled, plan };
}

function withPatch(outcome: NodeOutcome, patch: PlanPatchDraft): NodeOutcome {
  return { ...outcome, patch };
}

describe("GraphScheduler plan patches", () => {
  it("applies a completed node's patch before successors activate", async () => {
    const graph = definition(
      [
        agent("a", { authority: authority("graph", ["skip"]) }),
        agent("b"),
        agent("c"),
      ],
      [edge("ab", "a", "b"), edge("ac", "a", "c")],
    );
    const adapter = new FakeAdapter("opencode", [
      withPatch(ok(), draft([{ action: "skip", nodeId: "c" }])),
    ]);
    const { database, scheduler, compiled, plan } = schedulerSetup(graph, adapter);
    const final = await scheduler.start(compiled, plan);

    expect(final.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.nodeId)).toEqual(["a", "b"]);
    expect(final.revision).toBe(1);
    expect(final.patches).toHaveLength(1);
    expect(final.patches[0]).toMatchObject({ actorNodeId: "a", appliedRevision: 1 });
    expect(final.nodes.find((node) => node.nodeId === "c")!.status).toBe("skipped");
    // The patch is persisted in the audit log with the new plan revision.
    expect(database.listPlanPatches("run-1")).toHaveLength(1);
    expect(database.getExecutionPlan("run-1")!.revision).toBe(1);
    database.close();
  });

  it("fails the node without mutating the plan when the patch is unauthorized", async () => {
    const graph = definition(
      [agent("a"), agent("b")],
      [edge("ab", "a", "b", "success")],
    );
    const adapter = new FakeAdapter("opencode", [
      withPatch(ok(), draft([{ action: "skip", nodeId: "b" }])),
    ]);
    const { database, scheduler, compiled, plan } = schedulerSetup(graph, adapter);
    const final = await scheduler.start(compiled, plan);

    expect(final.status).toBe("failed");
    const a = final.nodes.find((node) => node.nodeId === "a")!;
    expect(a.status).toBe("failed");
    expect(a.error).toMatch(/authority|action|scope/i);
    expect(final.revision).toBe(0);
    expect(final.patches).toEqual([]);
    expect(database.listPlanPatches("run-1")).toEqual([]);
    database.close();
  });

  it("applies nothing when one operation of a multi-operation patch is invalid", async () => {
    const graph = definition(
      [
        agent("a", { authority: authority("graph", ALL_ACTIONS) }),
        agent("b"),
        agent("c"),
      ],
      [edge("ab", "a", "b"), edge("ac", "a", "c")],
    );
    const adapter = new FakeAdapter("opencode", [
      withPatch(
        ok(),
        draft([
          { action: "skip", nodeId: "c" },
          { action: "remove", nodeId: "ghost" },
        ]),
      ),
    ]);
    const { database, scheduler, compiled, plan } = schedulerSetup(graph, adapter);
    const final = await scheduler.start(compiled, plan);

    // The rejected patch applied nothing: the run routed normally, the plan
    // kept its revision, and no audit row was written.
    expect(final.revision).toBe(0);
    expect(final.patches).toEqual([]);
    expect(final.nodes.find((node) => node.nodeId === "a")!.status).toBe("failed");
    expect(final.nodes.find((node) => node.nodeId === "c")!.status).toBe("succeeded");
    expect(database.listPlanPatches("run-1")).toEqual([]);
    database.close();
  });

  it("pauses the plan when the patch carries a pause operation", async () => {
    const graph = definition(
      [agent("a", { authority: authority("graph", ["pause"]) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    const adapter = new FakeAdapter("opencode", [
      withPatch(ok(), draft([{ action: "pause", reason: "review first" }])),
    ]);
    const { database, scheduler, compiled, plan } = schedulerSetup(graph, adapter);
    const paused = await scheduler.start(compiled, plan);

    expect(paused.status).toBe("paused");
    expect(adapter.calls.map((call) => call.nodeId)).toEqual(["a"]);
    const resumed = await scheduler.resume(compiled, paused);
    expect(resumed.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.nodeId)).toEqual(["a", "b"]);
    database.close();
  });

  it("applies patches delivered before a manual checkpoint pauses the plan", async () => {
    const graph = definition(
      [
        agent("a", { authority: authority("graph", ["edit"]) }),
        checkpoint("cp", "manual"),
        agent("b"),
      ],
      [edge("acp", "a", "cp"), edge("cpb", "cp", "b")],
    );
    const adapter = new FakeAdapter("opencode", [
      withPatch(
        ok(),
        draft([{ action: "edit", nodeId: "b", replacement: agent("b", { job: "patched-job" }) }]),
      ),
    ]);
    const { database, scheduler, compiled, plan } = schedulerSetup(graph, adapter);
    const paused = await scheduler.start(compiled, plan);

    // The manual checkpoint pauses the plan with the patch already applied.
    expect(paused.status).toBe("paused");
    expect(paused.revision).toBe(1);
    expect(paused.patches).toHaveLength(1);

    // Resume from the persisted base graph: the patched configuration is
    // rebuilt from the audit log and drives the next attempt.
    const resumed = await scheduler.resume(compileGraph(graph), paused);
    expect(resumed.status).toBe("succeeded");
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]).toMatchObject({ nodeId: "b", job: "patched-job" });
    database.close();
  });

  it("applies a failed node's recovery patch and routes the failure", async () => {
    const graph = definition(
      [
        agent("a"),
        agent("b", { authority: authority("graph", ["skip"]) }),
        agent("c"),
        agent("d"),
      ],
      [
        edge("ab", "a", "b"),
        edge("bc", "b", "c", "success"),
        edge("bd", "b", "d", "failure"),
      ],
    );
    const adapter = new FakeAdapter("opencode", [
      ok(),
      withPatch(
        { ...ok("rejected"), status: "failed" },
        draft([{ action: "skip", nodeId: "c" }]),
      ),
    ]);
    const { database, scheduler, compiled, plan } = schedulerSetup(graph, adapter);
    const final = await scheduler.start(compiled, plan);

    expect(final.status).toBe("succeeded");
    expect(final.patches).toHaveLength(1);
    expect(final.nodes.find((node) => node.nodeId === "c")!.status).toBe("skipped");
    expect(final.nodes.find((node) => node.nodeId === "d")!.status).toBe("succeeded");
    database.close();
  });

  it("rolls back an applied patch from the revision history", async () => {
    const graph = definition(
      [agent("a", { authority: authority("graph", ["skip"]) }), agent("b")],
      [edge("ab", "a", "b")],
    );
    const adapter = new FakeAdapter("opencode", [
      withPatch(ok(), draft([{ action: "skip", nodeId: "b" }])),
    ]);
    const { database, scheduler, compiled, plan } = schedulerSetup(graph, adapter);
    const final = await scheduler.start(compiled, plan);
    expect(final.status).toBe("succeeded");
    expect(final.nodes.find((node) => node.nodeId === "b")!.status).toBe("skipped");

    const rollback = scheduler.rollbackPatch(compiled, final, final.patches[0].id);
    expect(rollback.operations).toEqual([{ action: "retry", nodeId: "b" }]);
    expect(final.revision).toBe(2);
    expect(final.patches[0].rolledBackBy).toBe(rollback.id);
    expect(final.nodes.find((node) => node.nodeId === "b")!.status).toBe("waiting");

    // The rollback is audited: both patches are persisted, the first marked.
    const persisted = database.listPlanPatches("run-1");
    expect(persisted).toHaveLength(2);
    expect(persisted[0].rolledBackBy).toBe(rollback.id);
    expect(database.getExecutionPlan("run-1")!.revision).toBe(2);

    // Resuming routes the restored node.
    const resumed = await scheduler.resume(compiled, final);
    expect(resumed.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.nodeId)).toEqual(["a", "b"]);
    database.close();
  });
});
