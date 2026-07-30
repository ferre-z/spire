import { describe, expect, it } from "vitest";
import {
  graphDefinitionV2Schema,
  type AgentNode,
  type GraphDefinition,
} from "../shared/domain";
import { migrateLegacyGraph, readGraphDefinition } from "./graph-migration";

const legacyGraph: GraphDefinition = {
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
      condition: "always",
      label: "review",
    },
    {
      id: "revise",
      source: "planner",
      target: "implementer",
      condition: "needs_changes",
      label: "revise",
    },
    {
      id: "accept",
      source: "implementer",
      target: "planner",
      condition: "accepted",
      label: "done",
    },
  ],
};

function agentNode(graph: unknown, id: string): AgentNode {
  const parsed = graphDefinitionV2Schema.parse(graph);
  const node = parsed.nodes.find((candidate) => candidate.id === id);
  if (!node || node.kind !== "agent") {
    throw new Error(`Expected agent node ${id}.`);
  }
  return node;
}

describe("migrateLegacyGraph", () => {
  it("preserves graph identity fields", () => {
    const migrated = migrateLegacyGraph(legacyGraph);
    expect(migrated.id).toBe("graph-1");
    expect(migrated.name).toBe("Build & Review");
    expect(migrated.version).toBe(2);
    expect(migrated.createdAt).toBe("2026-07-29T12:00:00.000Z");
    expect(migrated.groups).toEqual([]);
  });

  it("produces a graph that strictly validates as graph v2", () => {
    const migrated = migrateLegacyGraph(legacyGraph);
    expect(() => graphDefinitionV2Schema.parse(migrated)).not.toThrow();
  });

  it("preserves node ids, names, positions, and model IDs", () => {
    const migrated = migrateLegacyGraph(legacyGraph);
    const planner = agentNode(migrated, "planner");
    const implementer = agentNode(migrated, "implementer");
    expect(planner.name).toBe("Architect");
    expect(planner.position).toEqual({ x: 160, y: 190 });
    expect(planner.modelId).toBe("openai/gpt-5");
    expect(implementer.name).toBe("Builder");
    expect(implementer.position).toEqual({ x: 570, y: 190 });
    expect(implementer.modelId).toBe("anthropic/claude-sonnet");
  });

  it("maps instructions to job and keeps the OpenCode harness", () => {
    const migrated = migrateLegacyGraph(legacyGraph);
    const planner = agentNode(migrated, "planner");
    const implementer = agentNode(migrated, "implementer");
    expect(planner.kind).toBe("agent");
    expect(planner.job).toBe("Turn goals into briefs, then review the result.");
    expect(planner.harnessId).toBe("opencode");
    expect(implementer.job).toBe("Implement the brief and validate the result.");
    expect(implementer.harnessId).toBe("opencode");
  });

  it("keeps the legacy role as the role label", () => {
    const migrated = migrateLegacyGraph(legacyGraph);
    expect(agentNode(migrated, "planner").roleLabel).toBe("planner");
    expect(agentNode(migrated, "implementer").roleLabel).toBe("implementer");
  });

  it("makes the planner read-only and the implementer workspace-write", () => {
    const migrated = migrateLegacyGraph(legacyGraph);
    expect(agentNode(migrated, "planner").access).toEqual({
      mode: "read-only",
      writeScopes: [],
    });
    expect(agentNode(migrated, "implementer").access).toEqual({
      mode: "workspace-write",
      writeScopes: ["**/*"],
    });
  });

  it("applies default authority, activation, and maxVisits", () => {
    const migrated = migrateLegacyGraph(legacyGraph);
    for (const id of ["planner", "implementer"]) {
      const node = agentNode(migrated, id);
      expect(node.authority).toEqual({ scope: "self", actions: [] });
      expect(node.activation).toBe("all");
      expect(node.maxVisits).toBe(3);
    }
  });

  it("converts edge conditions without changing edge ids or labels", () => {
    const migrated = migrateLegacyGraph(legacyGraph);
    const byId = new Map(migrated.edges.map((edge) => [edge.id, edge]));
    expect(migrated.edges).toHaveLength(4);

    // planner -> implementer flow becomes a handoff.
    expect(byId.get("plan-build")).toMatchObject({
      source: "planner",
      target: "implementer",
      kind: "handoff",
      when: "always",
      label: "task brief",
    });
    // implementer -> planner flow becomes a review.
    expect(byId.get("build-review")).toMatchObject({
      source: "implementer",
      target: "planner",
      kind: "review",
      when: "always",
      label: "review",
    });
    // needs_changes maps to a failure route.
    expect(byId.get("revise")).toMatchObject({
      kind: "handoff",
      when: "failure",
      label: "revise",
    });
    // accepted maps to a success route.
    expect(byId.get("accept")).toMatchObject({
      kind: "review",
      when: "success",
      label: "done",
    });
  });

  it("maps maxIterations to the maxSteps safety bound", () => {
    const migrated = migrateLegacyGraph(legacyGraph);
    // Each legacy iteration is one implement + one review step.
    expect(migrated.maxSteps).toBe(legacyGraph.maxIterations * 2);
  });
});

describe("readGraphDefinition", () => {
  it("normalizes a legacy graph to graph v2", () => {
    const raw: unknown = JSON.parse(JSON.stringify(legacyGraph));
    const graph = readGraphDefinition(raw);
    expect(graph.nodes).toHaveLength(2);
    expect(agentNode(graph, "planner").access.mode).toBe("read-only");
    expect(agentNode(graph, "implementer").access.mode).toBe(
      "workspace-write",
    );
  });

  it("returns a v2 graph as-is", () => {
    const v2 = migrateLegacyGraph(legacyGraph);
    const raw: unknown = JSON.parse(JSON.stringify(v2));
    expect(readGraphDefinition(raw)).toEqual(v2);
  });

  it("throws a validation error for unknown shapes", () => {
    expect(() => readGraphDefinition({ id: "nope" })).toThrowError(
      /graph definition/i,
    );
    expect(() => readGraphDefinition(null)).toThrowError(/graph definition/i);
    expect(() => readGraphDefinition("graph-1")).toThrowError(
      /graph definition/i,
    );
  });
});
