import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CollaborationMessage } from "../shared/collaboration";
import type { GraphDefinition } from "../shared/domain";
import type {
  AppliedPlanPatch,
  ExecutionPlan,
  NodeExecution,
} from "../shared/execution";
import type { HarnessSession } from "../shared/harness";
import {
  WORKSPACE_LAYOUT_SCHEMA_VERSION,
  type WorkspaceLayoutRecord,
} from "../shared/workspace";
import { SpireDatabase } from "./database";
import { migrateLegacyGraph } from "./graph-migration";

describe("SpireDatabase trace events", () => {
  let root: string;
  let database: SpireDatabase;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "spire-db-"));
    database = new SpireDatabase(path.join(root, "test.sqlite"));
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("creates the trace_events table alongside the existing tables", () => {
    const journal = database.createTraceJournal();
    journal.append({
      timestamp: new Date().toISOString(),
      correlationId: "corr-1",
      kind: "run.lifecycle",
      level: "info",
      subsystem: "run-engine",
      message: "stored in the same database file",
    });
    journal.close();
    expect(journal.query({}).events).toHaveLength(1);
  });
});

function record(
  graphId: string,
  mode: "desktop" | "compact",
  marker: string,
): WorkspaceLayoutRecord {
  return {
    graphId,
    mode,
    schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
    model: {
      layout: {
        type: "row",
        children: [
          {
            type: "tabset",
            children: [
              {
                type: "tab",
                id: "graph-canvas",
                name: marker,
                component: "graph-canvas",
              },
            ],
          },
        ],
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

describe("SpireDatabase workspace layouts", () => {
  let root: string;
  let database: SpireDatabase;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "spire-db-"));
    database = new SpireDatabase(path.join(root, "test.sqlite"));
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("saves and loads a layout round trip", () => {
    database.saveWorkspaceLayout(record("graph-1", "desktop", "saved"));
    const layouts = database.listWorkspaceLayouts("graph-1");
    expect(layouts).toHaveLength(1);
    expect(layouts[0].mode).toBe("desktop");
    expect(layouts[0].schemaVersion).toBe(WORKSPACE_LAYOUT_SCHEMA_VERSION);
    expect(JSON.stringify(layouts[0].model)).toContain("saved");
  });

  it("keeps desktop and compact layouts for one graph separate", () => {
    database.saveWorkspaceLayout(record("graph-1", "desktop", "wide"));
    database.saveWorkspaceLayout(record("graph-1", "compact", "narrow"));
    const layouts = database.listWorkspaceLayouts("graph-1");
    expect(layouts).toHaveLength(2);
    const desktop = layouts.find((item) => item.mode === "desktop");
    const compact = layouts.find((item) => item.mode === "compact");
    expect(JSON.stringify(desktop?.model)).toContain("wide");
    expect(JSON.stringify(compact?.model)).toContain("narrow");
  });

  it("keeps layouts for two graphs separate", () => {
    database.saveWorkspaceLayout(record("graph-1", "desktop", "one"));
    database.saveWorkspaceLayout(record("graph-2", "desktop", "two"));
    expect(database.listWorkspaceLayouts("graph-1")).toHaveLength(1);
    expect(database.listWorkspaceLayouts("graph-2")).toHaveLength(1);
    expect(
      JSON.stringify(database.listWorkspaceLayouts("graph-1")[0].model),
    ).toContain("one");
    expect(
      JSON.stringify(database.listWorkspaceLayouts("graph-2")[0].model),
    ).toContain("two");
  });

  it("shares one layout across every version of a graph", () => {
    const base = new Date().toISOString();
    const graph = {
      id: "graph-1",
      name: "Build & Review",
      maxIterations: 3,
      nodes: [],
      edges: [],
    };
    database.saveGraph({ ...graph, version: 1, createdAt: base } as never);
    database.saveWorkspaceLayout(record("graph-1", "desktop", "shared"));
    database.saveGraph({ ...graph, version: 2, createdAt: base } as never);
    database.saveGraph({ ...graph, version: 3, createdAt: base } as never);
    // Three stored versions, still a single layout keyed by the stable id.
    expect(database.listGraphs()).toHaveLength(3);
    expect(database.listWorkspaceLayouts("graph-1")).toHaveLength(1);
    expect(
      JSON.stringify(database.listWorkspaceLayouts("graph-1")[0].model),
    ).toContain("shared");
  });

  it("overwrites the layout for the same graph and mode", () => {
    database.saveWorkspaceLayout(record("graph-1", "desktop", "first"));
    database.saveWorkspaceLayout(record("graph-1", "desktop", "second"));
    const layouts = database.listWorkspaceLayouts("graph-1");
    expect(layouts).toHaveLength(1);
    expect(JSON.stringify(layouts[0].model)).toContain("second");
  });

  it("resets only the layouts of the given graph", () => {
    database.saveWorkspaceLayout(record("graph-1", "desktop", "one"));
    database.saveWorkspaceLayout(record("graph-1", "compact", "one-c"));
    database.saveWorkspaceLayout(record("graph-2", "desktop", "two"));
    database.resetWorkspaceLayouts("graph-1");
    expect(database.listWorkspaceLayouts("graph-1")).toHaveLength(0);
    expect(database.listWorkspaceLayouts("graph-2")).toHaveLength(1);
  });
});

const legacyGraphFixture: GraphDefinition = {
  id: "graph-1",
  name: "Build & Review",
  version: 2,
  maxIterations: 3,
  createdAt: "2026-07-29T12:00:00.000Z",
  nodes: [
    {
      id: "planner",
      type: "opencode",
      role: "planner",
      name: "Architect",
      instructions: "Turn goals into briefs, then review the result.",
      model: "openai/gpt-5",
      position: { x: 160, y: 190 },
    },
    {
      id: "implementer",
      type: "opencode",
      role: "implementer",
      name: "Builder",
      instructions: "Implement the brief and validate the result.",
      model: "anthropic/claude-sonnet",
      position: { x: 570, y: 190 },
    },
  ],
  edges: [
    {
      id: "plan-build",
      source: "planner",
      target: "implementer",
      condition: "always",
      label: "task brief",
    },
    {
      id: "build-review",
      source: "implementer",
      target: "planner",
      condition: "needs_changes",
      label: "revise",
    },
  ],
};

function planFixture(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    runId: "run-1",
    graphId: "graph-1",
    graphVersion: 2,
    revision: 1,
    status: "running",
    stepCount: 2,
    nodes: [
      { nodeId: "planner", status: "succeeded", visits: 1 },
      { nodeId: "implementer", status: "running", visits: 1 },
    ],
    edges: migrateLegacyGraph(legacyGraphFixture).edges,
    patches: [
      {
        id: "patch-1",
        actorNodeId: "planner",
        baseRevision: 0,
        appliedRevision: 1,
        appliedAt: "2026-07-30T10:00:00.000Z",
        reason: "Skip the redundant review pass.",
        operations: [{ action: "skip", nodeId: "planner" }],
      },
    ],
    updatedAt: "2026-07-30T10:05:00.000Z",
    ...overrides,
  };
}

function messageFixture(
  overrides: Partial<CollaborationMessage> = {},
): CollaborationMessage {
  return {
    id: "msg-1",
    runId: "run-1",
    senderNodeId: "planner",
    sequence: 0,
    createdAt: "2026-07-30T10:01:00.000Z",
    recipient: { kind: "node", id: "implementer" },
    kind: "handoff",
    subject: "Brief ready",
    body: "Implement the brief as scoped.",
    artifactPaths: ["briefs/run-1.md"],
    ...overrides,
  };
}

function patchFixture(
  overrides: Partial<AppliedPlanPatch> = {},
): AppliedPlanPatch {
  return {
    id: "patch-1",
    actorNodeId: "planner",
    baseRevision: 0,
    appliedRevision: 1,
    appliedAt: "2026-07-30T10:00:00.000Z",
    reason: "Skip the redundant review pass.",
    operations: [{ action: "skip", nodeId: "planner" }],
    ...overrides,
  };
}

function sessionFixture(
  overrides: Partial<HarnessSession> = {},
): HarnessSession {
  return {
    runId: "run-1",
    nodeId: "implementer",
    harnessId: "opencode",
    sessionId: "sess-abc",
    directory: "/tmp/work",
    updatedAt: "2026-07-30T10:02:00.000Z",
    ...overrides,
  };
}

describe("SpireDatabase graph v2", () => {
  let root: string;
  let database: SpireDatabase;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "spire-db-"));
    database = new SpireDatabase(path.join(root, "test.sqlite"));
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("saves and lists graph v2 definitions", () => {
    const graph = migrateLegacyGraph(legacyGraphFixture);
    database.saveGraphV2(graph);
    const graphs = database.listGraphsV2();
    expect(graphs).toHaveLength(1);
    expect(graphs[0]).toEqual(graph);
  });

  it("reads legacy rows back as normalized graph v2", () => {
    database.saveGraph(legacyGraphFixture);
    const graphs = database.listGraphsV2();
    expect(graphs).toHaveLength(1);
    expect(graphs[0]).toEqual(migrateLegacyGraph(legacyGraphFixture));
  });

  it("keeps the legacy-facing graph API unchanged", () => {
    database.saveGraph(legacyGraphFixture);
    expect(database.listGraphs()[0]).toEqual(legacyGraphFixture);
  });

  it("rejects invalid graph v2 payloads on write", () => {
    const broken = { ...migrateLegacyGraph(legacyGraphFixture), maxSteps: 0 };
    expect(() => database.saveGraphV2(broken as never)).toThrowError();
    expect(database.listGraphsV2()).toHaveLength(0);
  });
});

describe("SpireDatabase execution state", () => {
  let root: string;
  let databaseFile: string;
  let database: SpireDatabase;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "spire-db-"));
    databaseFile = path.join(root, "test.sqlite");
    database = new SpireDatabase(databaseFile);
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a complete execution plan", () => {
    const plan = planFixture();
    database.saveExecutionPlan(plan);
    expect(database.getExecutionPlan("run-1")).toEqual(plan);
    expect(database.getExecutionPlan("run-unknown")).toBeUndefined();
  });

  it("rejects invalid plans on write and on read", () => {
    expect(() =>
      database.saveExecutionPlan(planFixture({ revision: -1 })),
    ).toThrowError();
    expect(database.getExecutionPlan("run-1")).toBeUndefined();

    // A corrupt row written behind the schema's back must fail on read too.
    const raw = new Database(databaseFile);
    raw
      .prepare(
        `INSERT INTO execution_plans (run_id, revision, updated_at, json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        "run-corrupt",
        -1,
        new Date().toISOString(),
        JSON.stringify(planFixture({ runId: "run-corrupt", revision: -1 })),
      );
    raw.close();
    expect(() => database.getExecutionPlan("run-corrupt")).toThrowError();
  });

  it("round-trips node executions in stable node order", () => {
    const implementer: NodeExecution = {
      nodeId: "implementer",
      status: "running",
      visits: 1,
    };
    const planner: NodeExecution = {
      nodeId: "planner",
      status: "succeeded",
      visits: 2,
      outcome: {
        status: "succeeded",
        summary: "Brief approved.",
        artifacts: [{ name: "brief", path: "briefs/run-1.md" }],
        messages: [],
        selectedEdgeIds: ["plan-build"],
      },
    };
    database.saveNodeExecution("run-1", implementer);
    database.saveNodeExecution("run-1", planner);
    // Later state for the same node replaces the earlier row.
    database.saveNodeExecution("run-1", {
      ...implementer,
      status: "succeeded",
      visits: 2,
    });
    const nodes = database.listNodeExecutions("run-1");
    expect(nodes).toEqual([
      { ...implementer, status: "succeeded", visits: 2 },
      planner,
    ]);
    expect(database.listNodeExecutions("run-other")).toEqual([]);
  });

  it("round-trips collaboration messages ordered by sequence", () => {
    database.appendCollaborationMessage(
      messageFixture({
        id: "msg-2",
        sequence: 1,
        recipient: { kind: "successors" },
        kind: "report",
        subject: "Done",
      }),
    );
    database.appendCollaborationMessage(messageFixture());
    const messages = database.listCollaborationMessages("run-1");
    expect(messages.map((message) => message.id)).toEqual(["msg-1", "msg-2"]);
    expect(messages[0]).toEqual(messageFixture());
    expect(database.listCollaborationMessages("run-other")).toEqual([]);
  });

  it("round-trips applied plan patches ordered by revision", () => {
    database.savePlanPatch(
      "run-1",
      patchFixture({
        id: "patch-2",
        baseRevision: 1,
        appliedRevision: 2,
        appliedAt: "2026-07-30T10:03:00.000Z",
        reason: "Pause after the failed step.",
        operations: [{ action: "pause", reason: "needs human input" }],
      }),
    );
    database.savePlanPatch("run-1", patchFixture());
    const patches = database.listPlanPatches("run-1");
    expect(patches.map((patch) => patch.id)).toEqual(["patch-1", "patch-2"]);
    expect(patches[0]).toEqual(patchFixture());
    expect(database.listPlanPatches("run-other")).toEqual([]);
  });

  it("round-trips a node-scoped harness session", () => {
    database.saveHarnessSession(sessionFixture());
    expect(database.getHarnessSession("run-1", "implementer")).toEqual(
      sessionFixture(),
    );
    expect(database.getHarnessSession("run-1", "planner")).toBeUndefined();
    // Reconnecting a node replaces its session.
    database.saveHarnessSession(sessionFixture({ sessionId: "sess-def" }));
    expect(
      database.getHarnessSession("run-1", "implementer")?.sessionId,
    ).toBe("sess-def");
  });

  it("updates a plan and a node state in one transaction", () => {
    database.saveExecutionPlan(planFixture());
    const nextPlan = planFixture({
      revision: 2,
      stepCount: 3,
      updatedAt: "2026-07-30T10:06:00.000Z",
    });
    const node: NodeExecution = {
      nodeId: "implementer",
      status: "succeeded",
      visits: 2,
    };
    database.savePlanAndNodeExecution(nextPlan, node);
    expect(database.getExecutionPlan("run-1")).toEqual(nextPlan);
    expect(database.listNodeExecutions("run-1")).toEqual([node]);
  });

  it("rolls the plan back when the node update fails inside the transaction", () => {
    const original = planFixture();
    database.saveExecutionPlan(original);
    const invalidNode = {
      nodeId: "implementer",
      status: "not-a-status",
      visits: 2,
    };
    expect(() =>
      database.savePlanAndNodeExecution(
        planFixture({ revision: 2 }),
        invalidNode as never,
      ),
    ).toThrowError();
    // The plan write inside the same transaction must be rolled back.
    expect(database.getExecutionPlan("run-1")).toEqual(original);
    expect(database.listNodeExecutions("run-1")).toEqual([]);
  });

  it("survives a restart: close, reopen, and read execution state back", () => {
    const plan = planFixture();
    database.saveExecutionPlan(plan);
    database.saveNodeExecution("run-1", {
      nodeId: "planner",
      status: "succeeded",
      visits: 1,
    });
    database.appendCollaborationMessage(messageFixture());
    database.savePlanPatch("run-1", patchFixture());
    database.saveHarnessSession(sessionFixture());
    database.close();

    database = new SpireDatabase(databaseFile);
    expect(database.getExecutionPlan("run-1")).toEqual(plan);
    expect(database.listNodeExecutions("run-1")).toEqual([
      { nodeId: "planner", status: "succeeded", visits: 1 },
    ]);
    expect(database.listCollaborationMessages("run-1")).toEqual([
      messageFixture(),
    ]);
    expect(database.listPlanPatches("run-1")).toEqual([patchFixture()]);
    expect(database.getHarnessSession("run-1", "implementer")).toEqual(
      sessionFixture(),
    );
  });
});
