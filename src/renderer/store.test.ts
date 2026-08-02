// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  AppSnapshot,
  GraphDefinitionV2,
  GraphNode,
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

function snapshot(): AppSnapshot {
  return {
    onboardingComplete: true,
    openCode: { installed: true, compatible: true, connected: true },
    graphs: [],
    runs: [
      {
        id: "run-1",
        graphId: "graph-1",
        graphVersion: 1,
        repositoryPath: "/repo",
        goal: "test goal",
        status: "implementing",
        iteration: 0,
        startedAt: new Date().toISOString(),
        events: [],
      },
    ],
  };
}

function makeGraph(
  overrides: Partial<GraphDefinitionV2> = {},
): GraphDefinitionV2 {
  return {
    id: "graph-1",
    name: "Graph",
    version: 1,
    nodes: [
      {
        kind: "agent",
        id: "node-1",
        name: "Builder",
        job: "Build it",
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
    ...overrides,
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

function currentGraph(): GraphDefinitionV2 {
  const graph = useAppStore.getState().graph;
  if (!graph) throw new Error("A graph must be selected for this test.");
  return graph;
}

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
  Reflect.set(window, "spire", spire);
  useAppStore.setState({
    snapshot: undefined,
    graph: undefined,
    selectedNodeId: undefined,
    selectedRunId: undefined,
    plan: undefined,
    planLoading: false,
    planPatches: [],
    nodeExecutions: [],
    nodeExecutionsLoading: false,
    nodeExecutionsHasMore: false,
    nodeExecutionsCursor: undefined,
    messages: [],
    messagesLoading: false,
    messagesHasMore: false,
    messagesCursor: undefined,
    harnesses: [],
    harnessModels: {},
    selectedPatchId: undefined,
    validationResult: undefined,
    error: undefined,
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "spire");
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

describe("store: saveCurrentGraph", () => {
  it("does not save an invalid graph and exposes validation errors", async () => {
    useAppStore.setState({ graph: makeGraph(), error: undefined });
    spire.graphsValidate.mockResolvedValue({
      valid: false,
      issues: ["A graph needs an entry node."],
    });

    const saved = await useAppStore.getState().saveCurrentGraph();

    expect(saved).toBe(false);
    expect(spire.saveGraph).not.toHaveBeenCalled();
    expect(useAppStore.getState().validationResult).toEqual({
      valid: false,
      issues: ["A graph needs an entry node."],
    });
    expect(useAppStore.getState().error).toContain("A graph needs an entry node.");
  });

  it("validates before saving and selects the newest saved version", async () => {
    const selectedGraph = makeGraph();
    const savedGraph = makeGraph({ version: 2 });
    useAppStore.setState({
      graph: selectedGraph,
      selectedNodeId: "node-1",
      error: "old error",
    });
    spire.graphsValidate.mockResolvedValue({ valid: true, issues: [] });
    spire.saveGraph.mockResolvedValue(snapshotWithGraphs([selectedGraph, savedGraph]));

    const saved = await useAppStore.getState().saveCurrentGraph();

    expect(saved).toBe(true);
    expect(spire.graphsValidate).toHaveBeenCalledWith(selectedGraph);
    expect(spire.saveGraph).toHaveBeenCalledWith(selectedGraph);
    expect(useAppStore.getState().graph?.version).toBe(2);
    expect(useAppStore.getState().selectedNodeId).toBe("node-1");
    expect(useAppStore.getState().error).toBeUndefined();
  });
});

function snapshotWithGraphs(graphs: GraphDefinitionV2[]): AppSnapshot {
  return { ...snapshot(), graphs };
}

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
        messages: [makeMessage({ id: "msg-2", sequence: 2 })],
        nextCursor: null,
      });
    await useAppStore.getState().loadMessages();
    expect(useAppStore.getState().messagesHasMore).toBe(true);
    await useAppStore.getState().loadMessages();
    expect(useAppStore.getState().messages).toHaveLength(2);
    expect(useAppStore.getState().messagesHasMore).toBe(false);
  });

  it("does not fetch a page after pagination is exhausted", async () => {
    useAppStore.setState({ selectedRunId: "run-1" });
    spire.runsMessagesList.mockResolvedValue({
      messages: [makeMessage()],
      nextCursor: null,
    });

    await useAppStore.getState().loadMessages();
    await useAppStore.getState().loadMessages();

    expect(spire.runsMessagesList).toHaveBeenCalledTimes(1);
  });
});

describe("store: activateRun", () => {
  it("clears stale runtime state before loading the selected run", async () => {
    let resolvePlan: (plan: ExecutionPlan) => void = () => {};
    const pendingPlan = new Promise<ExecutionPlan>((resolve) => {
      resolvePlan = resolve;
    });
    spire.runsPlanGet.mockReturnValue(pendingPlan);
    spire.runsNodesList.mockReturnValue(new Promise(() => {}));
    spire.runsMessagesList.mockReturnValue(new Promise(() => {}));
    useAppStore.setState({
      selectedRunId: "run-1",
      plan: makePlan(),
      planPatches: [{
        id: "patch-1",
        baseRevision: 1,
        appliedRevision: 2,
        reason: "old",
        operations: [],
        actorNodeId: "planner",
        appliedAt: new Date().toISOString(),
      }],
      nodeExecutions: [makeNodeExecution()],
      nodeExecutionsCursor: "old-node-page",
      nodeExecutionsHasMore: true,
      messages: [makeMessage()],
      messagesCursor: "old-message-page",
      messagesHasMore: true,
      error: "old error",
    });

    void useAppStore.getState().activateRun("run-2");

    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe("run-2");
    expect(state.plan).toBeUndefined();
    expect(state.planPatches).toEqual([]);
    expect(state.nodeExecutions).toEqual([]);
    expect(state.nodeExecutionsCursor).toBeUndefined();
    expect(state.nodeExecutionsHasMore).toBe(false);
    expect(state.messages).toEqual([]);
    expect(state.messagesCursor).toBeUndefined();
    expect(state.messagesHasMore).toBe(false);
    expect(state.error).toBeUndefined();

    resolvePlan(makePlan({ runId: "run-2" }));
  });

  it("ignores an older activation response after a newer run is selected", async () => {
    let resolveOldPlan: (plan: ExecutionPlan) => void = () => {};
    let resolveOldNodes: (page: { nodes: NodeExecution[]; nextCursor: null }) => void = () => {};
    let resolveOldMessages: (page: { messages: CollaborationMessage[]; nextCursor: null }) => void = () => {};
    const oldPlan = new Promise<ExecutionPlan>((resolve) => {
      resolveOldPlan = resolve;
    });
    const oldNodes = new Promise<{ nodes: NodeExecution[]; nextCursor: null }>((resolve) => {
      resolveOldNodes = resolve;
    });
    const oldMessages = new Promise<{ messages: CollaborationMessage[]; nextCursor: null }>((resolve) => {
      resolveOldMessages = resolve;
    });
    spire.runsPlanGet.mockImplementation((runId: string) =>
      runId === "run-1" ? oldPlan : Promise.resolve(makePlan({ runId })),
    );
    spire.runsNodesList.mockImplementation((input: { runId: string }) =>
      input.runId === "run-1"
        ? oldNodes
        : Promise.resolve({
            nodes: [makeNodeExecution({ nodeId: "new-node" })],
            nextCursor: null,
          }),
    );
    spire.runsMessagesList.mockImplementation((input: { runId: string }) =>
      input.runId === "run-1"
        ? oldMessages
        : Promise.resolve({
            messages: [makeMessage({ id: "new-message", runId: input.runId })],
            nextCursor: null,
          }),
    );

    const oldActivation = useAppStore.getState().activateRun("run-1");
    await useAppStore.getState().activateRun("run-2");
    resolveOldPlan(makePlan({ runId: "run-1" }));
    resolveOldNodes({
      nodes: [makeNodeExecution({ nodeId: "old-node" })],
      nextCursor: null,
    });
    resolveOldMessages({
      messages: [makeMessage({ id: "old-message" })],
      nextCursor: null,
    });
    await oldActivation;

    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe("run-2");
    expect(state.plan?.runId).toBe("run-2");
    expect(state.nodeExecutions.map((node) => node.nodeId)).toEqual(["new-node"]);
    expect(state.messages.map((message) => message.id)).toEqual(["new-message"]);
  });

  it("deduplicates initial and event-refreshed runtime pages", async () => {
    const latestMessage = makeMessage({
      id: "message-1",
      sequence: 2,
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    spire.runsPlanGet.mockResolvedValue(makePlan());
    spire.runsNodesList.mockResolvedValue({
      nodes: [
        makeNodeExecution({ nodeId: "node-1", status: "queued" }),
        makeNodeExecution({ nodeId: "node-1", status: "running" }),
      ],
      nextCursor: null,
    });
    spire.runsMessagesList.mockResolvedValue({
      messages: [
        makeMessage({ id: "message-1", sequence: 1 }),
        latestMessage,
      ],
      nextCursor: null,
    });

    await useAppStore.getState().activateRun("run-1");
    await useAppStore.getState().receiveEvent({
      id: "event-1",
      runId: "run-1",
      sequence: 1,
      timestamp: new Date().toISOString(),
      kind: "node.progress",
      phase: "running",
      message: "updated",
    });

    expect(useAppStore.getState().nodeExecutions).toEqual([
      makeNodeExecution({ nodeId: "node-1", status: "running" }),
    ]);
    expect(useAppStore.getState().messages).toEqual([
      latestMessage,
    ]);
    expect(spire.runsNodesList).toHaveBeenCalledTimes(2);
    expect(spire.runsMessagesList).toHaveBeenCalledTimes(2);
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
      .loadHarnessModels("opencode");
    expect(spire.harnessesModels).toHaveBeenCalledWith("opencode");
    expect(result).toEqual(models);
    expect(useAppStore.getState().harnessModels["opencode"]).toEqual(models);
  });

  it("changes an agent harness and model together after loading its models", async () => {
    const graph = makeGraph();
    useAppStore.setState({ graph, error: undefined });
    spire.harnessesModels.mockResolvedValue([
      { id: "codex-mini", name: "Codex Mini" },
      { id: "codex-max", name: "Codex Max" },
    ]);

    await useAppStore.getState().changeNodeHarness("node-1", "codex");

    expect(spire.harnessesModels).toHaveBeenCalledWith("codex");
    expect(useAppStore.getState().graph?.nodes[0]).toMatchObject({
      id: "node-1",
      harnessId: "codex",
      modelId: "codex-mini",
    });
    expect(useAppStore.getState().error).toBeUndefined();
  });

  it("leaves a node unchanged and exposes an error when a harness has no models", async () => {
    const graph = makeGraph();
    useAppStore.setState({ graph, error: undefined });
    spire.harnessesModels.mockResolvedValue([]);

    await useAppStore.getState().changeNodeHarness("node-1", "codex");

    expect(useAppStore.getState().graph).toBe(graph);
    expect(useAppStore.getState().error).toContain("No models");
  });
});

describe("store: applySnapshot", () => {
  it("selects the latest version of the selected graph and preserves its selected node", () => {
    const v1 = makeGraph({ version: 1 });
    const v2 = makeGraph({ version: 2 });
    useAppStore.setState({ graph: v1, selectedNodeId: "node-1" });

    useAppStore.getState().applySnapshot(snapshotWithGraphs([v1, v2]));

    expect(useAppStore.getState().graph).toBe(v2);
    expect(useAppStore.getState().selectedNodeId).toBe("node-1");
  });

  it("clears the selected node when the latest graph no longer has it", () => {
    const v1 = makeGraph({ version: 1 });
    const v2 = makeGraph({ version: 2, nodes: [] });
    useAppStore.setState({ graph: v1, selectedNodeId: "node-1" });

    useAppStore.getState().applySnapshot(snapshotWithGraphs([v1, v2]));

    expect(useAppStore.getState().graph).toBe(v2);
    expect(useAppStore.getState().selectedNodeId).toBeUndefined();
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
    expect(currentGraph().nodes).toHaveLength(2);
    expect(currentGraph().nodes[1]?.id).toBe("d1");
  });

  it("removes a node and its connected edges", () => {
    useAppStore.getState().removeNode("a1");
    expect(currentGraph().nodes).toHaveLength(0);
  });

  it("updates a node field via updateNode", () => {
    useAppStore.getState().updateNode("a1", { name: "Renamed" });
    expect(
      currentGraph().nodes[0]?.name,
    ).toBe("Renamed");
  });

  it("adds and removes a group", () => {
    useAppStore.getState().addGroup({ id: "grp-1", name: "Team" });
    expect(
      currentGraph().groups,
    ).toHaveLength(1);
    useAppStore.getState().removeGroup("grp-1");
    expect(
      currentGraph().groups,
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
    expect(currentGraph().edges).toHaveLength(1);
    useAppStore.getState().removeEdge("e1");
    expect(currentGraph().edges).toHaveLength(0);
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
