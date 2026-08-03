import { describe, expect, it } from "vitest";
import type { NodeExecutionStatus } from "../../shared/execution";
import { nodeStatusMetadata } from "./AgentNode";

describe("nodeStatusMetadata", () => {
  it.each<[NodeExecutionStatus, string, string]>([
    ["succeeded", "success", "Succeeded"],
    ["waiting", "waiting", "Waiting"],
    ["failed", "failed", "Failed"],
    ["running", "running", "Running"],
  ])("maps %s to a semantic class and readable label", (status, tone, label) => {
    expect(nodeStatusMetadata(status)).toEqual({ tone, label });
  });
});
