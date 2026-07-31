import { describe, expect, it } from "vitest";
import { graphDefinitionSchema, graphDefinitionV2Schema } from "./domain";

const graph = {
  id: "graph-1",
  name: "Build and Review",
  version: 1,
  maxIterations: 3,
  createdAt: new Date().toISOString(),
  nodes: [
    {
      id: "planner",
      type: "opencode" as const,
      role: "planner" as const,
      name: "Architect",
      instructions: "Plan and review.",
      model: "openrouter/example",
      position: { x: 0, y: 0 },
    },
    {
      id: "implementer",
      type: "opencode" as const,
      role: "implementer" as const,
      name: "Builder",
      instructions: "Implement and test.",
      model: "openrouter/example",
      position: { x: 300, y: 0 },
    },
  ],
  edges: [
    {
      id: "a",
      source: "planner",
      target: "implementer",
      condition: "always" as const,
      label: "brief",
    },
    {
      id: "b",
      source: "implementer",
      target: "planner",
      condition: "always" as const,
      label: "review",
    },
  ],
};

describe("graphDefinitionSchema", () => {
  it("accepts a bounded two-role graph", () => {
    expect(graphDefinitionSchema.parse(graph).maxIterations).toBe(3);
  });

  it("rejects duplicate roles", () => {
    const invalid = structuredClone(graph);
    invalid.nodes[1].role = "planner";
    expect(() => graphDefinitionSchema.parse(invalid)).toThrow(
      "one planner and one implementer",
    );
  });

  it("rejects edges to unknown nodes", () => {
    const invalid = structuredClone(graph);
    invalid.edges[0].target = "missing";
    expect(() => graphDefinitionSchema.parse(invalid)).toThrow(
      "unknown node",
    );
  });
});

const v2Agent: Record<string, unknown> = {
  kind: "agent" as const,
  id: "builder",
  name: "Builder",
  job: "Implement the feature.",
  harnessId: "opencode" as const,
  modelId: "openrouter/example",
  position: { x: 0, y: 0 },
};

const v2Graph: {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  groups: Record<string, unknown>[];
} = {
  id: "graph-v2-1",
  name: "Feature Pipeline",
  version: 1,
  createdAt: new Date().toISOString(),
  nodes: [v2Agent],
  edges: [],
  groups: [],
};

describe("graphDefinitionV2Schema", () => {
  it("accepts a one-node graph and applies defaults", () => {
    const parsed = graphDefinitionV2Schema.parse(v2Graph);
    expect(parsed.maxSteps).toBe(100);
    expect(parsed.nodes).toHaveLength(1);
    const node = parsed.nodes[0];
    expect(node.kind).toBe("agent");
    if (node.kind !== "agent") return;
    expect(node.activation).toBe("all");
    expect(node.maxVisits).toBe(3);
    expect(node.access).toEqual({ mode: "read-only", writeScopes: [] });
    expect(node.authority).toEqual({ scope: "self", actions: [] });
  });

  it("accepts mixed node kinds", () => {
    const mixed = structuredClone(v2Graph);
    mixed.nodes = [
      v2Agent,
      { ...v2Agent, kind: "decision" as const, id: "gate", name: "Gate" },
      {
        kind: "checkpoint" as const,
        id: "review-point",
        name: "Human Review",
        mode: "manual" as const,
        position: { x: 200, y: 0 },
      },
      {
        kind: "subgraph" as const,
        id: "child",
        name: "Child Pipeline",
        graphId: "graph-v2-2",
        graphVersion: 4,
        position: { x: 400, y: 0 },
      },
    ];
    const parsed = graphDefinitionV2Schema.parse(mixed);
    expect(parsed.nodes.map((node) => node.kind)).toEqual([
      "agent",
      "decision",
      "checkpoint",
      "subgraph",
    ]);
  });

  it("accepts nested visual groups", () => {
    const grouped = structuredClone(v2Graph);
    grouped.groups = [
      { id: "outer", name: "Outer" },
      { id: "inner", name: "Inner", parentGroupId: "outer" },
    ];
    grouped.nodes = [{ ...v2Agent, groupId: "inner" }];
    const parsed = graphDefinitionV2Schema.parse(grouped);
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.nodes[0].groupId).toBe("inner");
  });

  it("accepts cycles between nodes", () => {
    const cyclic = structuredClone(v2Graph);
    cyclic.nodes = [
      v2Agent,
      { ...v2Agent, id: "reviewer", name: "Reviewer" },
    ];
    cyclic.edges = [
      {
        id: "forward",
        source: "builder",
        target: "reviewer",
        kind: "handoff" as const,
        when: "success" as const,
        label: "review",
      },
      {
        id: "back",
        source: "reviewer",
        target: "builder",
        kind: "review" as const,
        when: "failure" as const,
        label: "rework",
      },
    ];
    expect(() => graphDefinitionV2Schema.parse(cyclic)).not.toThrow();
  });

  it("rejects subgraph nodes that reference their own graph", () => {
    const invalid = structuredClone(v2Graph);
    invalid.nodes = [
      {
        kind: "subgraph" as const,
        id: "self",
        name: "Self",
        graphId: "graph-v2-1",
        position: { x: 0, y: 0 },
      },
    ];
    expect(() => graphDefinitionV2Schema.parse(invalid)).toThrow(
      "own graph",
    );
  });

  it("supports all and any activation", () => {
    const anyGraph = structuredClone(v2Graph);
    anyGraph.nodes = [{ ...v2Agent, activation: "any" as const }];
    expect(graphDefinitionV2Schema.parse(anyGraph).nodes[0]).toMatchObject({
      activation: "any",
    });
    const invalid = structuredClone(v2Graph);
    invalid.nodes = [{ ...v2Agent, activation: "first" }];
    expect(() => graphDefinitionV2Schema.parse(invalid)).toThrow();
  });

  it("accepts typed success, failure, and selected edges", () => {
    const typed = structuredClone(v2Graph);
    typed.nodes = [v2Agent, { ...v2Agent, id: "reviewer", name: "Reviewer" }];
    typed.edges = [
      {
        id: "e1",
        source: "builder",
        target: "reviewer",
        kind: "approval" as const,
        when: "selected" as const,
        label: "approve",
      },
      {
        id: "e2",
        source: "reviewer",
        target: "builder",
        kind: "escalation" as const,
        when: "failure" as const,
        label: "escalate",
      },
      {
        id: "e3",
        source: "builder",
        target: "reviewer",
        kind: "dependency" as const,
        when: "always" as const,
        label: "blocks",
      },
    ];
    expect(graphDefinitionV2Schema.parse(typed).edges).toHaveLength(3);
  });

  it("rejects unknown edge kinds and conditions", () => {
    const invalid = structuredClone(v2Graph);
    invalid.nodes = [v2Agent, { ...v2Agent, id: "other", name: "Other" }];
    invalid.edges = [
      {
        id: "e1",
        source: "builder",
        target: "other",
        kind: "teleport",
        when: "success",
        label: "bad",
      },
    ];
    expect(() => graphDefinitionV2Schema.parse(invalid)).toThrow();
  });

  it("rejects duplicate node IDs", () => {
    const invalid = structuredClone(v2Graph);
    invalid.nodes = [v2Agent, { ...v2Agent, name: "Duplicate" }];
    expect(() => graphDefinitionV2Schema.parse(invalid)).toThrow(
      "Duplicate node id",
    );
  });

  it("rejects duplicate edge IDs", () => {
    const invalid = structuredClone(v2Graph);
    invalid.nodes = [v2Agent, { ...v2Agent, id: "other", name: "Other" }];
    const edge = {
      id: "dup",
      source: "builder",
      target: "other",
      kind: "handoff" as const,
      when: "always" as const,
      label: "go",
    };
    invalid.edges = [edge, { ...edge, label: "again" }];
    expect(() => graphDefinitionV2Schema.parse(invalid)).toThrow(
      "Duplicate edge id",
    );
  });

  it("rejects edges that reference unknown nodes", () => {
    const invalid = structuredClone(v2Graph);
    invalid.edges = [
      {
        id: "e1",
        source: "builder",
        target: "missing",
        kind: "handoff" as const,
        when: "always" as const,
        label: "go",
      },
    ];
    expect(() => graphDefinitionV2Schema.parse(invalid)).toThrow(
      "unknown node",
    );
  });

  it("rejects duplicate group IDs", () => {
    const invalid = structuredClone(v2Graph);
    invalid.groups = [
      { id: "dup", name: "First" },
      { id: "dup", name: "Second" },
    ];
    expect(() => graphDefinitionV2Schema.parse(invalid)).toThrow(
      "Duplicate group id",
    );
  });

  it("rejects invalid group references", () => {
    const badNodeGroup = structuredClone(v2Graph);
    badNodeGroup.nodes = [{ ...v2Agent, groupId: "missing" }];
    expect(() => graphDefinitionV2Schema.parse(badNodeGroup)).toThrow(
      "unknown group",
    );

    const badParent = structuredClone(v2Graph);
    badParent.groups = [
      { id: "inner", name: "Inner", parentGroupId: "missing" },
    ];
    expect(() => graphDefinitionV2Schema.parse(badParent)).toThrow(
      "unknown group",
    );
  });

  it("rejects invalid authority actions", () => {
    const invalid = structuredClone(v2Graph);
    invalid.nodes = [
      {
        ...v2Agent,
        authority: { scope: "graph", actions: ["retry", "teleport"] },
      },
    ];
    expect(() => graphDefinitionV2Schema.parse(invalid)).toThrow();
  });

  it("rejects unknown keys on nodes and graphs", () => {
    const badNode = structuredClone(v2Graph);
    badNode.nodes = [{ ...v2Agent, legacy: true }];
    expect(() => graphDefinitionV2Schema.parse(badNode)).toThrow();

    const badGraph = { ...structuredClone(v2Graph), maxIterations: 3 };
    expect(() => graphDefinitionV2Schema.parse(badGraph)).toThrow();
  });
});
