import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  graphDefinitionSchema,
  runRecordSchema,
} from "../shared/domain";
import {
  nodeExecutionPageSchema,
} from "../shared/control";
import {
  controlResponseSchema,
  type ControlRequest,
} from "../shared/coordinator-protocol";
import { createFixtureHarnessRegistry } from "../main/harness/fixture";
import { startCoordinator } from "./index";

const executeFile = promisify(execFile);
const TOKEN = "desktop-independent-run-token";

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(path.join(tmpdir(), "spire-coordinator-e2e-"));
  await executeFile("git", ["init", repositoryPath]);
  await executeFile("git", ["-C", repositoryPath, "config", "user.email", "test@example.com"]);
  await executeFile("git", ["-C", repositoryPath, "config", "user.name", "Spire Test"]);
  await writeFile(path.join(repositoryPath, "README.md"), "# fixture repository\n");
  await executeFile("git", ["-C", repositoryPath, "add", "README.md"]);
  await executeFile("git", ["-C", repositoryPath, "commit", "-m", "fixture"]);
  return repositoryPath;
}

async function executeControl(
  baseUrl: string,
  request: ControlRequest,
): Promise<unknown> {
  const response = await fetch(`${baseUrl}/v1/control`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  expect(response.status).toBe(200);
  const body = controlResponseSchema.parse(await response.json());
  if (!body.ok) throw new Error(body.error);
  return body.output;
}

describe("coordinator desktop-independent execution", () => {
  it("continues a fixture-backed run after the initiating HTTP client disconnects", async () => {
    // Given: a real coordinator HTTP surface backed by a deterministic fixture harness.
    const dataRoot = await mkdtemp(path.join(tmpdir(), "spire-coordinator-data-"));
    const repositoryPath = await createRepository();
    let releaseExecution: () => void = () => undefined;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const registry = createFixtureHarnessRegistry({
      opencode: {
        nodes: {
          planner: [
            {
              output: {
                status: "succeeded",
                summary: "fixture plan complete",
                artifacts: [],
                messages: [],
                selectedEdgeIds: ["brief"],
              },
            },
            {
              output: {
                status: "succeeded",
                summary: "fixture review complete",
                artifacts: [],
                messages: [],
                selectedEdgeIds: [],
              },
            },
          ],
          implementer: [
            {
              output: {
                status: "succeeded",
                summary: "fixture implementation complete",
                artifacts: [],
                messages: [],
                selectedEdgeIds: [],
              },
            },
          ],
        },
      },
      codex: { nodes: {} },
      "claude-code": { nodes: {} },
    });
    const fixture = registry.adapter("opencode");
    const runFixture = fixture.run.bind(fixture);
    vi.spyOn(fixture, "run").mockImplementation(async (input) => {
      await executionGate;
      return runFixture(input);
    });
    const coordinator = await startCoordinator({
      dataRoot,
      registry,
      environment: { appVersion: "test", platform: "linux", isWayland: false },
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
    });
    const baseUrl = `http://${coordinator.address.host}:${coordinator.address.port}`;
    let eventReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const graph = graphDefinitionSchema.parse({
        id: "desktop-independent-graph",
        name: "Desktop-independent fixture graph",
        version: 1,
        maxIterations: 3,
        createdAt: "2026-08-05T00:00:00.000Z",
        nodes: [
          {
            id: "planner",
            type: "opencode",
            role: "planner",
            name: "Planner",
            instructions: "Create the fixture plan.",
            model: "fixture-model",
            position: { x: 0, y: 0 },
          },
          {
            id: "implementer",
            type: "opencode",
            role: "implementer",
            name: "Implementer",
            instructions: "Complete the fixture implementation.",
            model: "fixture-model",
            position: { x: 240, y: 0 },
          },
        ],
        edges: [
          {
            id: "brief",
            source: "planner",
            target: "implementer",
            condition: "always",
            label: "brief",
          },
          {
            id: "review",
            source: "implementer",
            target: "planner",
            condition: "always",
            label: "review",
          },
        ],
      });
      const savedGraph = graphDefinitionSchema.parse(
        await executeControl(baseUrl, { operation: "graphs.save", input: { graph } }),
      );

      // When: the start response is consumed and discarded before node execution is released.
      const initiatedRun = runRecordSchema.parse(
        await executeControl(baseUrl, {
          operation: "runs.start",
          input: {
            graph: savedGraph,
            repositoryPath,
            goal: "Exercise coordinator ownership after disconnect.",
          },
        }),
      );
      expect(initiatedRun.status).not.toBe("succeeded");
      releaseExecution();

      // Then: a fresh control client observes the terminal record and both node executions.
      const terminalRun = await vi.waitFor(async () => {
        const run = runRecordSchema.parse(
          await executeControl(baseUrl, {
            operation: "runs.get",
            input: { runId: initiatedRun.id },
          }),
        );
        expect(run.status).toBe("succeeded");
        return run;
      }, { timeout: 3_000, interval: 25 });
      const nodeExecutions = nodeExecutionPageSchema.parse(
        await executeControl(baseUrl, {
          operation: "runs.nodes.list",
          input: { runId: terminalRun.id },
        }),
      );
      expect(nodeExecutions.nodes).toHaveLength(2);
      expect(nodeExecutions.nodes.map((node) => node.nodeId)).toContain("planner");
      expect(nodeExecutions.nodes.map((node) => node.nodeId)).toContain("implementer");
      expect(nodeExecutions.nodes.every((node) => node.status === "succeeded")).toBe(true);

      const eventsResponse = await fetch(`${baseUrl}/v1/events`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Last-Event-ID": "0",
        },
      });
      eventReader = eventsResponse.body?.getReader();
      if (!eventReader) throw new Error("SSE response body is unavailable.");
      let history = "";
      for (let frameCount = 0; frameCount < 20; frameCount += 1) {
        const frame = await eventReader.read();
        if (frame.done || !frame.value) break;
        history += new TextDecoder().decode(frame.value);
        if (
          history.includes(`"runId":"${terminalRun.id}"`) &&
          history.includes('"phase":"succeeded"')
        ) {
          break;
        }
      }
      expect(eventsResponse.status).toBe(200);
      expect(history).toContain(`"runId":"${terminalRun.id}"`);
      expect(history).toContain('"phase":"succeeded"');
    } finally {
      if (eventReader) await eventReader.cancel();
      await coordinator.close();
    }
  });
});
