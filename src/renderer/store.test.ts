// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  GraphDefinitionV2,
  GraphNode,
  HarnessId,
  ModelOption,
} from "../shared/domain";
import type {
  ExecutionPlan,
  NodeExecution,
} from "../shared/execution";
import type { CollaborationMessage } from "../shared/collaboration";
import type {
  HarnessStatus,
} from "../shared/control";
import { useAppStore } from "./store";

function snapshot(): Record<string, unknown> {
  return {
    onboardingComplete: true,
    openCode: { installed: true, compatible: true, connected: true },
    models: [{ id: "gpt-4", name: "GPT-4" }],
    graphs: [],
    runs: [
      {
        id: "run-1",
        graphId: "graph-1",
        graphVersion: 1,
        repositoryPath: "/repo",
        goal: "test goal",
        status: "running",
        iteration: 0,
        startedAt: new Date().toISOString(),
        events: [],
      },
    ],
  };
}

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    runId: "run-1",
    graphId: "graph-1",
    graphVersion: 1,
    revision: 1,
    status: "running",
    stepCount: 0,
    nodes: [],
    edges: [],
    patches: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeNodeExecution(
  overrides: Partial<NodeExecution> = {},
): NodeExecution {
  return {
    nodeId: "node-1",
    status: "queued",
    visits: 0,
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<CollaborationMessage> = {},
): CollaborationMessage {
  return {
    id: "msg-1",
    runId: "run-1",
    senderNodeId: "planner",
    sequence: 1,
    createdAt: new Date().toISOString(),
    recipient: { kind: "node", id: "implementer" },
    kind: "question",
    subject: "Status?",
    body: "How is it going?",
    artifactPaths: [],
    ...overrides,
  };
}

function makeHarness(
  overrides: Partial<HarnessStatus> = {},
): HarnessStatus {
  return {
    id: "opencode",
    name: "OpenCode",
    status: {
      harnessId: "opencode",
      installed: true,
      compatible: true,
      connected: true,
    },
    ...overrides,
  };
}

const spire: Record<string, ReturnType<typeof vi.fn>> = {};

beforeEach(() => {
  for (const key of [
    "snapshot",
    "graphsValidate",
    "runsPlanGet",
    "runsNodesList",
    "runsMessagesList",
    "runsMessagesSend",
    "runsPlanPatch",
    "runsPlanRollback",
    "runsCheckpointResume",
    "runsPlanPromote",
    "harnessesList",
    "harnessesModels",
    "saveGraph",
  ]) {
    spire[key] = vi.fn();
  }
  spire.snapshot.mockResolvedValue(snapshot());
  (window as { spire?: unknown }).spire = spire;
  useAppStore.setState({
    snapshot: undefined,
    graph: undefined,
    selectedNodeId: undefined,
    selectedRunId: undefined,
    plan: undefined,
    planLoading: false,
    nodeExecutions: [],
    messages: [],
    harnesses: [],
    harnessModels: {},
    selectedPatchId: undefined,
  });
});

afterEach(() => {
  delete (window as { spire?: unknown }).spire;
});

describe("store: v2 graph support", () => {
  it("accepts a v2 graph via selectGraph", () => {
    const v2: GraphDefinitionV2 = {
      id: "g2",
      name: "v2 graph",
      version: 1,
      nodes: [
        {
          kind: "agent",
          id: "a1",
          name: "Builder",
          job: "Build stuff",
          harnessId: "opencode",
          modelId: "gpt-4",
          roleLabel: undefined,
          access: { mode: "read-only", writeScopes: [] },
          authority: { scope: "self", actions: [] },
          activation: "all",
          maxVisits: 3,
          position: { x: 100, y: 100 },
        },
      ],
      edges: [],
      groups: [],
      maxSteps: 100,
      createdAt: new Date().toISOString(),
    };
    useAppStore.getState().selectGraph(v2);
    expect(useAppStore.getState().graph).toBe(v2);
  });

  it("accepts a v2 graph via updateGraph", () => {
    const v2: GraphDefinitionV2 = {
      id: "g2",
      name: "v2 graph",
      version: 1,
      nodes: [
        {
          kind: "agent",
          id: "a1",
          name: "Builder",
          job: "Build stuff",
          harnessId: "opencode",
          modelId: "gpt-4",
          access: { mode: "read-only", writeScopes: [] },
          authority: { scope: "self", actions: [] },
          activation: "all",
          maxVisits: 3,
          position: { x: 100, y: 100 },
        },
      ],
      edges: [],
      groups: [],
      maxSteps: 100,
      createdAt: new Date().toISOString(),
    };
    useAppStore.getState().updateGraph(v2);
    expect(useAppStore.getState().graph).toBe(v2);
  });
});

describe("store: validateGraph", () => {
  it("calls graphsValidate with the raw graph and stores the result", async () => {
    const raw = { id: "x", nodes: [] };
    spire.graphsValidate.mockResolvedValue({
      valid: false,
      issues: ["missing nodes"],
    });
    await useAppStore.getState().validateGraph(raw);
    expect(spire.graphsValidate).toHaveBeenCalledWith(raw);
    const result = useAppStore.getState().validationResult;
    expect(result).toEqual({ valid: false, issues: ["missing nodes"] });
  });
});

describe("store: loadPlan", () => {
  it("fetches the plan for the selected run and stores it", async () => {
    useAppStore.setState({ selectedRunId: "run-42" });
    const plan = makePlan({ runId: "run-42" });
    spire.runsPlanGet.mockResolvedValue(plan);
    await useAppStore.getState().loadPlan();
    expect(spire.runsPlanGet).toHaveBeenCalledWith("run-42");
    expect(useAppStore.getState().plan).toBe(plan);
    expect(useAppStore.getState().planLoading).toBe(false);
  });

  it("sets loading state while fetching", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    let resolvePlan: (value: ExecutionPlan) => void = () => {};
    const deferred = new Promise<ExecutionPlan>((resolve) => {
      resolvePlan = resolve;
    });
    spire.runsPlanGet.mockReturnValue(deferred);
    const promise = useAppStore.getState().loadPlan();
    expect(useAppStore.getState().planLoading).toBe(true);
    resolvePlan(makePlan());
    await promise;
    expect(useAppStore.getState().planLoading).toBe(false);
  });
});

describe("store: loadNodeExecutions", () => {
  it("fetches node executions and stores them", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    const exec = makeNodeExecution({ nodeId: "n1", status: "running" });
    spire.runsNodesList.mockResolvedValue({
      nodes: [exec],
      nextCursor: null,
    });
    await useAppStore.getState().loadNodeExecutions();
    expect(spire.runsNodesList).toHaveBeenCalledWith({
      runId: "run-1",
      limit: 200,
    });
    expect(useAppStore.getState().nodeExecutions).toHaveLength(1);
    expect(useAppStore.getState().nodeExecutions[0].nodeId).toBe("n1");
  });

  it("paginates when nextCursor is present", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    spire.runsNodesList
      .mockResolvedValueOnce({
        nodes: [makeNodeExecution({ nodeId: "n1" })],
        nextCursor: "page2",
      })
      .mockResolvedValueOnce({
        nodes: [makeNodeExecution({ nodeId: "n2" })],
        nextCursor: null,
      });
    await useAppStore.getState().loadNodeExecutions();
    expect(useAppStore.getState().nodeExecutions).toHaveLength(1);
    expect(useAppStore.getState().nodeExecutionsHasMore).toBe(true);
    await useAppStore.getState().loadNodeExecutions();
    expect(spire.runsNodesList).toHaveBeenLastCalledWith({
      runId: "run-1",
      limit: 200,
      cursor: "page2",
    });
    expect(useAppStore.getState().nodeExecutions).toHaveLength(2);
    expect(useAppStore.getState().nodeExecutionsHasMore).toBe(false);
  });
});

describe("store: loadMessages", () => {
  it("fetches messages and stores them", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    const msg = makeMessage();
    spire.runsMessagesList.mockResolvedValue({
      messages: [msg],
      nextCursor: null,
    });
    await useAppStore.getState().loadMessages();
    expect(spire.runsMessagesList).toHaveBeenCalledWith({
      runId: "run-1",
      limit: 200,
    });
    expect(useAppStore.getState().messages).toHaveLength(1);
    expect(useAppStore.getState().messages[0].subject).toBe("Status?");
  });

  it("paginates when nextCursor is present", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    spire.runsMessagesList
      .mockResolvedValueOnce({
        messages: [makeMessage({ sequence: 1 })],
        nextCursor: "page2",
      })
      .mockResolvedValueOnce({
        messages: [makeMessage({ sequence: 2 })],
        nextCursor: null,
      });
    await useAppStore.getState().loadMessages();
    expect(useAppStore.getState().messagesHasMore).toBe(true);
    await useAppStore.getState().loadMessages();
    expect(useAppStore.getState().messages).toHaveLength(2);
    expect(useAppStore.getState().messagesHasMore).toBe(false);
  });
});

describe("store: sendMessage", () => {
  it("sends a message with the run id and sender node", async () => {
    useAppStore.setState({ selectedRunId: "run-1", selectedNodeId: "implementer" });
    spire.runsMessagesSend.mockResolvedValue({
      sent: true,
      messageId: "msg-1",
      sequence: 1,
    });
    await useAppStore.getState().sendMessage({
      recipient: { kind: "node", id: "implementer" },
      kind: "handoff",
      subject: "Handoff",
      body: "Done",
      artifactPaths: [],
    });
    expect(spire.runsMessagesSend).toHaveBeenCalledWith({
      runId: "run-1",
      senderNodeId: "implementer", // from selectedNodeId
      recipient: { kind: "node", id: "implementer" },
      kind: "handoff",
      subject: "Handoff",
      body: "Done",
      artifactPaths: [],
    });
  });

  it("falls back to node id 'planner' when no node is selected", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    spire.runsMessagesSend.mockResolvedValue({
      sent: true,
      messageId: "msg-1",
      sequence: 1,
    });
    await useAppStore.getState().sendMessage({
      recipient: { kind: "group", id: "planning" },
      kind: "question",
      subject: "Q",
      body: "?",
      artifactPaths: [],
    });
    expect(spire.runsMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        senderNodeId: "planner",
        runId: "run-1",
      }),
    );
  });
});

describe("store: plan patch and rollback", () => {
  it("applies a plan patch and stores the applied result", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    const draft = {
      baseRevision: 1,
      reason: "skip checkpoint",
      operations: [{ action: "skip" as const, nodeId: "node-1" }],
    };
    spire.runsPlanPatch.mockResolvedValue({
      id: "patch-1",
      baseRevision: 1,
      appliedRevision: 2,
      reason: "skip checkpoint",
      operations: draft.operations,
      actorNodeId: "planner",
      appliedAt: new Date().toISOString(),
    });
    const result = await useAppStore.getState().applyPlanPatch(draft, "planner");
    expect(spire.runsPlanPatch).toHaveBeenCalledWith({
      runId: "run-1",
      actorNodeId: "planner",
      draft,
    });
    expect(result.id).toBe("patch-1");
    expect(useAppStore.getState().planPatches).toContainEqual(
      expect.objectContaining({ id: "patch-1" }),
    );
  });

  it("rolls back a patch by id and stores the result", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    const rolledBack = {
      id: "patch-1",
      baseRevision: 1,
      appliedRevision: 2,
      reason: "skip checkpoint",
      operations: [{ action: "skip" as const, nodeId: "node-1" }],
      actorNodeId: "planner",
      appliedAt: new Date().toISOString(),
      rolledBackBy: "run-1",
    };
    spire.runsPlanRollback.mockResolvedValue(rolledBack);
    const result = await useAppStore.getState().rollbackPlanPatch("patch-1");
    expect(spire.runsPlanRollback).toHaveBeenCalledWith({
      runId: "run-1",
      patchId: "patch-1",
    });
    expect(result.rolledBackBy).toBe("run-1");
    expect(useAppStore.getState().planPatches).toContainEqual(
      expect.objectContaining({ id: "patch-1", rolledBackBy: "run-1" }),
    );
  });
});

describe("store: resumeCheckpoint", () => {
  it("resumes from a checkpoint and stores the new plan", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    const plan = makePlan({ status: "paused" });
    spire.runsCheckpointResume.mockResolvedValue(plan);
    await useAppStore.getState().resumeCheckpoint();
    expect(spire.runsCheckpointResume).toHaveBeenCalledWith("run-1");
    expect(useAppStore.getState().plan).toBe(plan);
  });
});

describe("store: promotePlan", () => {
  it("promotes the live plan as a new graph version", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    const v2: GraphDefinitionV2 = {
      id: "graph-1",
      name: "promoted",
      version: 2,
      nodes: [],
      edges: [],
      groups: [],
      maxSteps: 100,
      createdAt: new Date().toISOString(),
    };
    spire.runsPlanPromote.mockResolvedValue(v2);
    const result = await useAppStore.getState().promotePlan("my-promotion");
    expect(spire.runsPlanPromote).toHaveBeenCalledWith({
      runId: "run-1",
      name: "my-promotion",
    });
    expect(result).toBe(v2);
    expect(useAppStore.getState().graph).toBe(v2);
  });
});

describe("store: harness actions", () => {
  it("loads harnesses and stores statuses", async () => {
    const statuses = [makeHarness(), makeHarness({ id: "codex", name: "Codex" })];
    spire.harnessesList.mockResolvedValue(statuses);
    await useAppStore.getState().loadHarnesses();
    expect(spire.harnessesList).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().harnesses).toHaveLength(2);
    expect(useAppStore.getState().harnesses[0].id).toBe("opencode");
  });

  it("loads models for a harness", async () => {
    const models: ModelOption[] = [
      { id: "model-a", name: "Model A" },
    ];
    spire.harnessesModels.mockResolvedValue(models);
    const result = await useAppStore
      .getState()
      .loadHarnessModels("opencode" as HarnessId);
    expect(spire.harnessesModels).toHaveBeenCalledWith("opencode");
    expect(result).toEqual(models);
    expect(useAppStore.getState().harnessModels["opencode"]).toEqual(models);
  });
});

describe("store: graph editing", () => {
  const v2Graph: GraphDefinitionV2 = {
    id: "g2",
    name: "v2 graph",
    version: 1,
    nodes: [
      {
        kind: "agent",
        id: "a1",
        name: "Builder",
        job: "Build stuff",
        harnessId: "opencode",
        modelId: "gpt-4",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        position: { x: 100, y: 100 },
      },
    ],
    edges: [],
    groups: [],
    maxSteps: 100,
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    useAppStore.setState({ graph: v2Graph });
  });

  it("adds a node to a v2 graph", () => {
    const newNode: GraphNode = {
      kind: "decision",
      id: "d1",
      name: "Check",
      job: "Decide",
      harnessId: "opencode",
      modelId: "gpt-4",
      access: { mode: "read-only", writeScopes: [] },
      authority: { scope: "self", actions: [] },
      activation: "all",
      maxVisits: 3,
      position: { x: 200, y: 200 },
    };
    useAppStore.getState().addNode(newNode);
    expect(useAppStore.getState().graph!.nodes).toHaveLength(2);
    expect(
      (useAppStore.getState().graph!.nodes as GraphDefinitionV2["nodes"])[1].id,
    ).toBe("d1");
  });

  it("removes a node and its connected edges", () => {
    useAppStore.getState().removeNode("a1");
    expect(useAppStore.getState().graph!.nodes).toHaveLength(0);
  });

  it("updates a node field via updateNode", () => {
    useAppStore.getState().updateNode("a1", { name: "Renamed" });
    expect(
      useAppStore.getState().graph!.nodes[0].name,
    ).toBe("Renamed");
  });

  it("adds and removes a group", () => {
    useAppStore.getState().addGroup({ id: "grp-1", name: "Team" });
    expect(
      (useAppStore.getState().graph as GraphDefinitionV2)!.groups,
    ).toHaveLength(1);
    useAppStore.getState().removeGroup("grp-1");
    expect(
      (useAppStore.getState().graph as GraphDefinitionV2)!.groups,
    ).toHaveLength(0);
  });

  it("toggles group collapse state", () => {
    useAppStore.getState().addGroup({ id: "grp-1", name: "Team" });
    useAppStore.getState().collapseGroup("grp-1");
    expect(useAppStore.getState().collapsedGroups).toContain("grp-1");
    useAppStore.getState().collapseGroup("grp-1");
    expect(useAppStore.getState().collapsedGroups).not.toContain("grp-1");
  });

  it("adds and removes an edge", () => {
    useAppStore.getState().addEdge({
      id: "e1",
      source: "a1",
      target: "a1",
      kind: "dependency",
      when: "always",
      label: "dep",
    });
    expect(useAppStore.getState().graph!.edges).toHaveLength(1);
    useAppStore.getState().removeEdge("e1");
    expect(useAppStore.getState().graph!.edges).toHaveLength(0);
  });
});

describe("store: patch selection", () => {
  it("selects and clears a patch for diff view", () => {
    useAppStore.getState().selectPatch("patch-1");
    expect(useAppStore.getState().selectedPatchId).toBe("patch-1");
    useAppStore.getState().selectPatch(undefined);
    expect(useAppStore.getState().selectedPatchId).toBeUndefined();
  });
});

describe("store: receiveEvent with plan", () => {
  it("refreshes the plan when a run event arrives for the selected run", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    const plan = makePlan({ status: "running" });
    spire.runsPlanGet.mockResolvedValue(plan);
    await useAppStore.getState().receiveEvent({
      id: "evt-1",
      runId: "run-1",
      sequence: 1,
      timestamp: new Date().toISOString(),
      kind: "node.progress",
      phase: "running",
      message: "node started",
    });
    expect(spire.runsPlanGet).toHaveBeenCalledWith("run-1");
    expect(useAppStore.getState().plan?.status).toBe("running");
  });

  it("does not refetch plan when event run id differs", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    await useAppStore.getState().receiveEvent({
      id: "evt-1",
      runId: "other-run",
      sequence: 1,
      timestamp: new Date().toISOString(),
      kind: "run.lifecycle",
      phase: "stopped",
      message: "other run ended",
    });
    expect(spire.runsPlanGet).not.toHaveBeenCalled();
  });
});

describe("store: graph validation integration", () => {
  it("stores validation result that can be read by components", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    await useAppStore.setState({
      graph: undefined,
      selectedNodeId: undefined,
      plan: makePlan({ status: "running" }),
      nodeExecutions: [],
      messages: [],
      harnesses: [],
      harnessModels: {},
      selectedPatchId: undefined,
      planLoading: false,
      validationResult: undefined,
    });
    spire.graphsValidate.mockResolvedValue({ valid: true, issues: [] });
    await useAppStore.getState().validateGraph({ id: "x", nodes: [] });
    expect(useAppStore.getState().validationResult).toEqual({
      valid: true,
      issues: [],
    });
  });
});
