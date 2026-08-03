import { describe, expect, it } from "vitest";
import type { CollaborationMessage } from "../../shared/collaboration";
import type { GraphDefinitionV2 } from "../../shared/domain";
import type { NodeExecution } from "../../shared/execution";
import {
  deduplicateById,
  projectExecution,
  projectMessages,
  projectTopology,
} from "./selectors";

const graph: GraphDefinitionV2 = {
  id: "graph",
  name: "Graph",
  version: 1,
  maxSteps: 20,
  createdAt: "2026-08-03T10:00:00.000Z",
  groups: [],
  nodes: [
    { kind: "checkpoint", id: "source", name: "Source gate", mode: "manual", position: { x: 0, y: 0 } },
    { kind: "checkpoint", id: "selected", name: "Selected gate", mode: "manual", position: { x: 100, y: 0 } },
    { kind: "subgraph", id: "target", name: "Target graph", graphId: "child", position: { x: 200, y: 0 } },
  ],
  edges: [
    { id: "in", source: "source", target: "selected", kind: "approval", when: "success", label: "approved" },
    { id: "out", source: "selected", target: "target", kind: "handoff", when: "always", label: "continue" },
  ],
};

function message(id: string, senderNodeId: string, recipientId: string): CollaborationMessage {
  return {
    id,
    runId: "run",
    senderNodeId,
    recipient: { kind: "node", id: recipientId },
    kind: "handoff",
    subject: id,
    body: "body",
    artifactPaths: [],
    sequence: 1,
    createdAt: "2026-08-03T10:00:00.000Z",
  };
}

describe("NodeDialog selectors", () => {
  it("projects incoming and outgoing edges with resolved endpoint names", () => {
    const projection = projectTopology(graph, "selected");

    expect(projection.incoming).toEqual([
      expect.objectContaining({ id: "in", endpointName: "Source gate" }),
    ]);
    expect(projection.outgoing).toEqual([
      expect.objectContaining({ id: "out", endpointName: "Target graph" }),
    ]);
  });

  it("projects received and authored messages and removes duplicate ids", () => {
    const projection = projectMessages([
      message("received", "source", "selected"),
      message("authored", "selected", "target"),
      { ...message("received", "source", "selected"), body: "latest" },
    ], "selected");

    expect(projection.received).toHaveLength(1);
    expect(projection.received[0]?.body).toBe("latest");
    expect(projection.authored.map((item) => item.id)).toEqual(["authored"]);
  });

  it("returns the latest selected-node execution projection", () => {
    const executions: readonly NodeExecution[] = [
      { nodeId: "selected", status: "running", visits: 1 },
      {
        nodeId: "selected",
        status: "failed",
        visits: 2,
        error: "boom",
        outcome: {
          status: "failed",
          summary: "Could not continue",
          artifacts: [{ name: "log", path: "logs/run.txt" }],
          messages: [],
          selectedEdgeIds: [],
        },
      },
    ];

    expect(projectExecution(executions, "selected")).toEqual(
      expect.objectContaining({ status: "failed", visits: 2, error: "boom" }),
    );
  });

  it("deduplicates in stable first-seen order while retaining the latest value", () => {
    expect(deduplicateById([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
      { id: "a", value: 3 },
    ])).toEqual([{ id: "a", value: 3 }, { id: "b", value: 2 }]);
  });
});
