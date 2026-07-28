import { describe, expect, it } from "vitest";
import { graphDefinitionSchema } from "./domain";

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
