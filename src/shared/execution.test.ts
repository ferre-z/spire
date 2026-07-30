import { describe, expect, it } from "vitest";
import { collaborationMessageSchema } from "./collaboration";
import {
  appliedPlanPatchSchema,
  collaborationMessageDraftSchema,
  executionPlanSchema,
  nodeOutcomeSchema,
  planPatchDraftSchema,
} from "./execution";

const v2Agent = {
  kind: "agent" as const,
  id: "builder",
  name: "Builder",
  job: "Implement the feature.",
  harnessId: "opencode" as const,
  modelId: "openrouter/example",
  position: { x: 0, y: 0 },
};

const v2Edge = {
  id: "e1",
  source: "builder",
  target: "reviewer",
  kind: "handoff" as const,
  when: "success" as const,
  label: "review",
};

const draftMessage = {
  recipient: { kind: "node" as const, id: "reviewer" },
  kind: "handoff" as const,
  subject: "Ready for review",
  body: "The feature is implemented.",
  artifactPaths: ["artifacts/diff.patch"],
};

const outcome = {
  status: "succeeded" as const,
  summary: "Implemented the feature.",
  artifacts: [
    { name: "diff", path: "artifacts/diff.patch", mediaType: "text/x-diff" },
  ],
  messages: [draftMessage],
  selectedEdgeIds: ["e1"],
};

const patchDraft = {
  baseRevision: 1,
  reason: "Builder needs a retry.",
  operations: [{ action: "retry" as const, nodeId: "builder" }],
};

const appliedPatch = {
  ...patchDraft,
  id: "patch-1",
  actorNodeId: "reviewer",
  appliedRevision: 2,
  appliedAt: new Date().toISOString(),
};

const plan = {
  runId: "run-1",
  graphId: "graph-v2-1",
  graphVersion: 1,
  revision: 2,
  status: "running" as const,
  stepCount: 3,
  nodes: [
    {
      nodeId: "builder",
      status: "succeeded" as const,
      visits: 1,
      outcome,
    },
    { nodeId: "reviewer", status: "queued" as const, visits: 0 },
  ],
  edges: [v2Edge],
  patches: [appliedPatch],
  updatedAt: new Date().toISOString(),
};

describe("nodeOutcomeSchema", () => {
  it("accepts a strict success or failure outcome", () => {
    expect(nodeOutcomeSchema.parse(outcome).status).toBe("succeeded");
    expect(
      nodeOutcomeSchema.parse({ ...outcome, status: "failed" }).status,
    ).toBe("failed");
  });

  it("rejects non-terminal statuses and unknown keys", () => {
    expect(() =>
      nodeOutcomeSchema.parse({ ...outcome, status: "running" }),
    ).toThrow();
    expect(() =>
      nodeOutcomeSchema.parse({ ...outcome, log: "noise" }),
    ).toThrow();
  });

  it("rejects malformed embedded messages and patches", () => {
    expect(() =>
      nodeOutcomeSchema.parse({
        ...outcome,
        messages: [{ ...draftMessage, kind: "gossip" }],
      }),
    ).toThrow();
    expect(() =>
      nodeOutcomeSchema.parse({
        ...outcome,
        patch: { ...patchDraft, operations: [{ action: "teleport" }] },
      }),
    ).toThrow();
  });
});

describe("collaborationMessageDraftSchema", () => {
  it("accepts node, group, and successors recipients", () => {
    expect(
      collaborationMessageDraftSchema.parse(draftMessage).recipient,
    ).toEqual({ kind: "node", id: "reviewer" });
    expect(
      collaborationMessageDraftSchema.parse({
        ...draftMessage,
        recipient: { kind: "group", id: "reviewers" },
      }).recipient,
    ).toEqual({ kind: "group", id: "reviewers" });
    expect(
      collaborationMessageDraftSchema.parse({
        ...draftMessage,
        recipient: { kind: "successors" },
      }).recipient,
    ).toEqual({ kind: "successors" });
  });

  it("rejects unknown recipient kinds and unknown keys", () => {
    expect(() =>
      collaborationMessageDraftSchema.parse({
        ...draftMessage,
        recipient: { kind: "everyone" },
      }),
    ).toThrow();
    expect(() =>
      collaborationMessageDraftSchema.parse({ ...draftMessage, cc: "all" }),
    ).toThrow();
  });
});

describe("collaborationMessageSchema", () => {
  const persisted = {
    ...draftMessage,
    id: "msg-1",
    runId: "run-1",
    senderNodeId: "builder",
    sequence: 7,
    createdAt: new Date().toISOString(),
  };

  it("extends the draft with persistence metadata", () => {
    const parsed = collaborationMessageSchema.parse(persisted);
    expect(parsed.senderNodeId).toBe("builder");
    expect(parsed.sequence).toBe(7);
    expect(parsed.kind).toBe("handoff");
  });

  it("rejects malformed persistence metadata and unknown keys", () => {
    expect(() =>
      collaborationMessageSchema.parse({ ...persisted, sequence: -1 }),
    ).toThrow();
    expect(() =>
      collaborationMessageSchema.parse({ ...persisted, edited: true }),
    ).toThrow();
    const { createdAt: omitted, ...missingTimestamp } = persisted;
    expect(omitted).toBe(persisted.createdAt);
    expect(() =>
      collaborationMessageSchema.parse(missingTimestamp),
    ).toThrow();
  });
});

describe("planPatchDraftSchema", () => {
  it("accepts every mutation operation", () => {
    const operations = [
      { action: "retry", nodeId: "builder" },
      { action: "skip", nodeId: "builder" },
      { action: "remove", nodeId: "builder" },
      { action: "reorder", nodeId: "builder", beforeNodeId: "reviewer" },
      { action: "reroute", enableEdgeIds: ["e1"], disableEdgeIds: ["e2"] },
      { action: "pause", reason: "Waiting on credentials." },
      { action: "replace", nodeId: "builder", replacement: v2Agent },
      { action: "insert", node: v2Agent, edges: [v2Edge] },
      { action: "edit", nodeId: "builder", replacement: v2Agent },
    ];
    for (const operation of operations) {
      expect(() =>
        planPatchDraftSchema.parse({ ...patchDraft, operations: [operation] }),
      ).not.toThrow();
    }
  });

  it("rejects unknown actions and unknown keys", () => {
    expect(() =>
      planPatchDraftSchema.parse({
        ...patchDraft,
        operations: [{ action: "teleport", nodeId: "builder" }],
      }),
    ).toThrow();
    expect(() =>
      planPatchDraftSchema.parse({
        ...patchDraft,
        operations: [{ action: "retry", nodeId: "builder", extra: 1 }],
      }),
    ).toThrow();
  });
});

describe("appliedPlanPatchSchema", () => {
  it("accepts a patch applied at a later revision", () => {
    expect(appliedPlanPatchSchema.parse(appliedPatch).appliedRevision).toBe(2);
  });

  it("rejects stale patches whose base is at or after the applied revision", () => {
    expect(() =>
      appliedPlanPatchSchema.parse({ ...appliedPatch, baseRevision: 2 }),
    ).toThrow("Stale patch");
    expect(() =>
      appliedPlanPatchSchema.parse({ ...appliedPatch, baseRevision: 5 }),
    ).toThrow("Stale patch");
  });
});

describe("executionPlanSchema", () => {
  it("accepts a persisted execution plan", () => {
    const parsed = executionPlanSchema.parse(plan);
    expect(parsed.revision).toBe(2);
    expect(parsed.nodes.map((node) => node.status)).toEqual([
      "succeeded",
      "queued",
    ]);
  });

  it("rejects non-integer revisions", () => {
    expect(() =>
      executionPlanSchema.parse({ ...plan, revision: 1.5 }),
    ).toThrow();
  });

  it("rejects patches applied beyond the current revision", () => {
    expect(() =>
      executionPlanSchema.parse({
        ...plan,
        patches: [{ ...appliedPatch, appliedRevision: 9 }],
      }),
    ).toThrow("beyond the plan revision");
  });

  it("rejects unknown keys", () => {
    expect(() =>
      executionPlanSchema.parse({ ...plan, cursor: "abc" }),
    ).toThrow();
  });
});
