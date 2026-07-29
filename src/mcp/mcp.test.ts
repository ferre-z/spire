import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_CAPABILITIES,
  CONTROL_OPERATION_NAMES,
  runIdInputSchema,
  type ControlOperationMap,
  type ControlOperationName,
} from "../shared/control";
import type {
  GraphDefinition,
  ModelOption,
  RunArtifacts,
  RunRecord,
} from "../shared/domain";
import { runRecordSchema } from "../shared/domain";
import type { TraceEvent, TraceListener } from "../shared/trace";
import { ControlSocketServer } from "../main/control/socket-server";
import {
  ControlSocketClient,
  SpireNotRunningError,
  resolveControlPaths,
} from "./socket-client";
import {
  MCP_TOOLS,
  TOOL_NAMES,
  createSpireMcpServer,
  summarizeToolResult,
} from "./tool-registry";
import {
  SPIRE_RESOURCE_TEMPLATES,
  SPIRE_STATE_RESOURCE_URI,
  traceToLoggingParams,
} from "./resources";

const EXPECTED_TOOL_NAMES = [
  "spire_state_get",
  "spire_diagnostics_get",
  "spire_graphs_list",
  "spire_graphs_get",
  "spire_graphs_save",
  "spire_repositories_validate",
  "spire_runs_list",
  "spire_runs_get",
  "spire_runs_start",
  "spire_runs_stop",
  "spire_runs_retry",
  "spire_run_artifacts_get",
  "spire_worktrees_cleanup",
  "spire_layouts_list",
  "spire_layouts_save",
  "spire_layouts_reset",
  "spire_harnesses_list",
  "spire_harnesses_models",
  "spire_traces_query",
  "spire_traces_tail",
] as const;

const ARRAY_OUTPUT_TOOLS = [
  "spire_layouts_list",
  "spire_harnesses_list",
  "spire_harnesses_models",
] as const;

function makeGraph(): GraphDefinition {
  return {
    id: "graph-1",
    name: "Demo",
    version: 3,
    nodes: [
      {
        id: "plan",
        type: "opencode",
        role: "planner",
        name: "Planner",
        instructions: "Plan the work.",
        model: "m1",
        position: { x: 0, y: 0 },
      },
      {
        id: "impl",
        type: "opencode",
        role: "implementer",
        name: "Implementer",
        instructions: "Do the work.",
        model: "m1",
        position: { x: 200, y: 0 },
      },
    ],
    edges: [
      { id: "e1", source: "plan", target: "impl", condition: "always", label: "build" },
      { id: "e2", source: "impl", target: "plan", condition: "needs_changes", label: "revise" },
    ],
    maxIterations: 2,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    graphId: "graph-1",
    graphVersion: 3,
    repositoryPath: "/repo",
    goal: "Ship the feature.",
    status: "implementing",
    iteration: 1,
    startedAt: "2026-07-01T00:00:00.000Z",
    events: [],
    ...overrides,
  };
}

function makeArtifacts(): RunArtifacts {
  return {
    diff: "diff --git a/a.ts b/a.ts\n",
    changedFiles: ["a.ts", "b.ts"],
    worktreePath: "/wt/run-1",
    branch: "spire/run-1",
  };
}

/** content arrives as unknown through the compat result schema; narrow it. */
function firstContent(
  result: unknown,
): { type: string; text?: string } | undefined {
  return (result as { content?: { type: string; text?: string }[] })
    .content?.[0];
}

function makeTraceEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    sequence: 7,
    timestamp: "2026-07-01T00:00:00.000Z",
    correlationId: "corr-1",
    runId: "run-1",
    kind: "harness.request",
    level: "warn",
    subsystem: "harness",
    message: "slow response",
    ...overrides,
  };
}

/** In-memory control-plane stand-in behind a real socket server. */
class StubControl {
  readonly handlers = new Map<string, (input: unknown) => unknown>();
  readonly listeners = new Set<TraceListener>();

  execute<Name extends ControlOperationName>(
    name: Name,
    input?: unknown,
  ): Promise<ControlOperationMap[Name]["output"]> {
    const handler = this.handlers.get(name);
    if (!handler) return Promise.reject(new Error(`Unknown op: ${name}`));
    return Promise.resolve().then(
      () => handler(input) as ControlOperationMap[Name]["output"],
    );
  }

  subscribe(listener: TraceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: TraceEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Fake control channel for MCP-server-level tests (no socket). */
class FakeChannel {
  readonly executeSpy = vi.fn(
    (operation: ControlOperationName, input?: unknown): Promise<unknown> => {
      const handler = this.handlers.get(operation);
      if (!handler) return Promise.reject(new Error(`Unknown op: ${operation}`));
      return Promise.resolve().then(() => handler(input));
    },
  );
  readonly handlers = new Map<string, (input: unknown) => unknown>();
  traceListener: TraceListener | undefined;

  execute<Name extends ControlOperationName>(
    operation: Name,
    input?: ControlOperationMap[Name]["input"],
  ): Promise<ControlOperationMap[Name]["output"]> {
    return this.executeSpy(operation, input) as Promise<
      ControlOperationMap[Name]["output"]
    >;
  }

  subscribeTraces(listener: TraceListener): Promise<() => Promise<void>> {
    this.traceListener = listener;
    return Promise.resolve(async () => {
      this.traceListener = undefined;
    });
  }
}

describe("tool registry", () => {
  it("exposes exactly the 20 stable tool names in control order", () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    expect(TOOL_NAMES).toEqual({
      "state.get": "spire_state_get",
      "diagnostics.get": "spire_diagnostics_get",
      "graphs.list": "spire_graphs_list",
      "graphs.get": "spire_graphs_get",
      "graphs.save": "spire_graphs_save",
      "repositories.validate": "spire_repositories_validate",
      "runs.list": "spire_runs_list",
      "runs.get": "spire_runs_get",
      "runs.start": "spire_runs_start",
      "runs.stop": "spire_runs_stop",
      "runs.retry": "spire_runs_retry",
      "runs.artifacts.get": "spire_run_artifacts_get",
      "worktrees.cleanup": "spire_worktrees_cleanup",
      "layouts.list": "spire_layouts_list",
      "layouts.save": "spire_layouts_save",
      "layouts.reset": "spire_layouts_reset",
      "harnesses.list": "spire_harnesses_list",
      "harnesses.models": "spire_harnesses_models",
      "traces.query": "spire_traces_query",
      "traces.tail": "spire_traces_tail",
    });
  });

  it("covers every control capability exactly once", () => {
    expect(MCP_TOOLS).toHaveLength(CONTROL_OPERATION_NAMES.length);
    expect(CONTROL_OPERATION_NAMES.length).toBe(20);
    const mapped = new Set(MCP_TOOLS.map((tool) => tool.operation));
    for (const operation of CONTROL_OPERATION_NAMES) {
      expect(mapped.has(operation), `unmapped capability: ${operation}`).toBe(
        true,
      );
    }
  });

  it("derives annotations from capability metadata", () => {
    for (const tool of MCP_TOOLS) {
      const capability = CONTROL_CAPABILITIES[tool.operation];
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: capability.readOnly,
        destructiveHint: capability.destructive,
        idempotentHint: capability.idempotent,
        openWorldHint: false,
      });
    }
    // Spot-check the non-default flags so a metadata regression is visible.
    const byName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));
    expect(byName.get("spire_worktrees_cleanup")?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(byName.get("spire_runs_start")?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    });
    expect(byName.get("spire_layouts_reset")?.annotations).toMatchObject({
      destructiveHint: true,
    });
  });

  it("uses the capability Zod schemas verbatim for inputs", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema, tool.name).toBe(
        CONTROL_CAPABILITIES[tool.operation].inputSchema,
      );
    }
  });

  it("publishes object output schemas, wrapping array outputs as { items }", () => {
    for (const tool of MCP_TOOLS) {
      const capability = CONTROL_CAPABILITIES[tool.operation];
      if ((ARRAY_OUTPUT_TOOLS as readonly string[]).includes(tool.name)) {
        expect(
          z.toJSONSchema(tool.outputSchema),
          tool.name,
        ).toEqual(
          z.toJSONSchema(z.strictObject({ items: capability.outputSchema })),
        );
        expect(z.toJSONSchema(tool.outputSchema), tool.name).toMatchObject({
          type: "object",
          required: ["items"],
        });
      } else {
        expect(tool.outputSchema, tool.name).toBe(capability.outputSchema);
      }
    }
  });

  it("produces concise text summaries", () => {
    const graph = makeGraph();
    expect(
      summarizeToolResult("graphs.save", graph),
    ).toBe('Saved graph "Demo" v3.');
    expect(
      summarizeToolResult("runs.stop", makeRun({ status: "stopped" })),
    ).toBe("Stopped run run-1 (stopped).");
    expect(
      summarizeToolResult("traces.query", {
        events: [makeTraceEvent(), makeTraceEvent({ sequence: 8 })],
        nextCursor: null,
      }),
    ).toBe("2 trace events.");
    expect(
      summarizeToolResult("graphs.list", {
        graphs: [graph],
        nextCursor: "cursor-2",
      }),
    ).toBe("1 graph: Demo (more available).");
  });
});

describe("resource registry", () => {
  it("exposes the state resource and the four resource templates", () => {
    expect(SPIRE_STATE_RESOURCE_URI).toBe("spire://state");
    expect(SPIRE_RESOURCE_TEMPLATES.map((template) => template.uriTemplate)).toEqual([
      "spire://graphs/{graphId}",
      "spire://runs/{runId}",
      "spire://runs/{runId}/artifacts",
      "spire://traces/{runId}",
    ]);
  });

  it("maps trace levels to MCP logging levels", () => {
    expect(traceToLoggingParams(makeTraceEvent({ level: "debug" })).level).toBe(
      "debug",
    );
    expect(traceToLoggingParams(makeTraceEvent({ level: "info" })).level).toBe(
      "info",
    );
    expect(traceToLoggingParams(makeTraceEvent({ level: "warn" })).level).toBe(
      "warning",
    );
    expect(traceToLoggingParams(makeTraceEvent({ level: "error" })).level).toBe(
      "error",
    );
  });
});

describe("ControlSocketClient", () => {
  let baseDir: string;
  let control: StubControl;
  let server: ControlSocketServer | undefined;
  let client: ControlSocketClient | undefined;

  async function startServer(): Promise<void> {
    server = new ControlSocketServer({ control, baseDir });
    await server.start();
  }

  function makeClient(): ControlSocketClient {
    const paths = resolveControlPaths(baseDir);
    client = new ControlSocketClient(paths);
    return client;
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "spire-mcp-test-"));
    control = new StubControl();
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("resolves the socket and token beneath <base>/control", () => {
    const paths = resolveControlPaths("/data");
    expect(paths.socketPath).toBe(path.join("/data", "control", "control.sock"));
    expect(paths.tokenPath).toBe(path.join("/data", "control", "control.token"));
  });

  it("executes operations and returns outputs", async () => {
    await startServer();
    control.handlers.set("runs.get", (input) => {
      expect(input).toEqual({ runId: "run-1" });
      return makeRun();
    });
    const connected = makeClient();
    await connected.connect();
    const output = await connected.execute("runs.get", { runId: "run-1" });
    expect(output).toEqual(makeRun());
    expect(await connected.ping()).toBe(true);
  });

  it("rejects with the server error message on operation failure", async () => {
    await startServer();
    control.handlers.set("runs.get", () => {
      throw new Error("Run not found.");
    });
    const connected = makeClient();
    await connected.connect();
    await expect(
      connected.execute("runs.get", { runId: "missing" }),
    ).rejects.toThrow("Run not found.");
  });

  it("streams subscribed trace events until unsubscribe", async () => {
    await startServer();
    const connected = makeClient();
    await connected.connect();
    const events: TraceEvent[] = [];
    const unsubscribe = await connected.subscribeTraces((event) => {
      events.push(event);
    });
    expect(control.listeners.size).toBe(1);

    control.emit(makeTraceEvent());
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual(makeTraceEvent());

    await unsubscribe();
    expect(control.listeners.size).toBe(0);
  });

  it("reconnects after a server restart and restores subscriptions", async () => {
    await startServer();
    control.handlers.set("diagnostics.get", () => ({ marker: "diag" }));
    const connected = makeClient();
    await connected.connect();
    const events: TraceEvent[] = [];
    await connected.subscribeTraces((event) => {
      events.push(event);
    });

    // Simulate an app restart: the socket dies, a new server (and token)
    // comes up at the same location.
    await server?.close();
    await startServer();
    control.handlers.set("diagnostics.get", () => ({ marker: "diag-2" }));

    const output = await connected.execute("diagnostics.get", {});
    expect(output).toEqual({ marker: "diag-2" });
    await vi.waitFor(() => expect(control.listeners.size).toBe(1));
    control.emit(makeTraceEvent({ sequence: 9 }));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.sequence).toBe(9);
  });

  it("fails with one actionable error when Spire is not running", async () => {
    // No server: the token file and socket do not exist.
    const disconnected = makeClient();
    const failure = await disconnected.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SpireNotRunningError);
    const message = (failure as Error).message;
    expect(message).toContain(
      path.join(baseDir, "control", "control.sock"),
    );
    expect(message).toMatch(/launch spire/i);
  });

  it("never includes the token in error output", async () => {
    await startServer();
    const paths = resolveControlPaths(baseDir);
    const token = await readFile(paths.tokenPath, "utf8");
    // Token on disk but nothing listening: kill the server only.
    await server?.close();
    server = undefined;
    const disconnected = makeClient();
    const failure = await disconnected.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SpireNotRunningError);
    expect((failure as Error).message).not.toContain(token.trim());
  });
});

describe("MCP server", () => {
  let channel: FakeChannel;
  let mcpClient: Client;
  let logging: { level: string; logger?: string; data: unknown }[];

  beforeEach(async () => {
    channel = new FakeChannel();
    const server = createSpireMcpServer(channel);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    mcpClient = new Client({ name: "test-client", version: "0.0.0" });
    logging = [];
    mcpClient.setNotificationHandler(
      LoggingMessageNotificationSchema,
      (notification) => {
        logging.push(notification.params);
      },
    );
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  afterEach(async () => {
    await mcpClient.close();
  });

  it("lists exactly the 20 tools with annotations and object schemas", async () => {
    const { tools } = await mcpClient.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    for (const tool of tools) {
      const definition = MCP_TOOLS.find((entry) => entry.name === tool.name);
      expect(definition, tool.name).toBeDefined();
      expect(tool.annotations, tool.name).toEqual(definition?.annotations);
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.outputSchema?.type, tool.name).toBe("object");
    }
  });

  it("publishes the capability input schema for a representative tool", async () => {
    const { tools } = await mcpClient.listTools();
    const stop = tools.find((tool) => tool.name === "spire_runs_stop");
    expect(stop?.inputSchema).toEqual(
      z.toJSONSchema(runIdInputSchema, { target: "draft-7" }),
    );
    expect(stop?.outputSchema).toEqual(
      z.toJSONSchema(runRecordSchema, { target: "draft-7" }),
    );
  });

  it("returns structuredContent plus a text summary for object outputs", async () => {
    const run = makeRun({ status: "stopped" });
    channel.handlers.set("runs.stop", () => run);
    const result = await mcpClient.callTool(
      { name: "spire_runs_stop", arguments: { runId: "run-1" } },
      CallToolResultSchema,
    );
    expect(channel.executeSpy).toHaveBeenCalledWith("runs.stop", {
      runId: "run-1",
    });
    expect(result.structuredContent).toEqual(run);
    expect(result.isError).toBeUndefined();
    const text = firstContent(result);
    expect(text?.type).toBe("text");
    expect(text?.type === "text" && text.text).toBe(
      "Stopped run run-1 (stopped).",
    );
  });

  it("wraps array outputs as { items } in structuredContent", async () => {
    const models: ModelOption[] = [
      { id: "m1", name: "Model One" },
      { id: "m2", name: "Model Two" },
    ];
    channel.handlers.set("harnesses.models", () => models);
    const result = await mcpClient.callTool(
      { name: "spire_harnesses_models", arguments: { harnessId: "opencode" } },
      CallToolResultSchema,
    );
    expect(channel.executeSpy).toHaveBeenCalledWith("harnesses.models", {
      harnessId: "opencode",
    });
    expect(result.structuredContent).toEqual({ items: models });
    const text = firstContent(result);
    expect(text?.type === "text" && text.text).toBe(
      "2 models: Model One, Model Two.",
    );
  });

  it("supports zero-argument tools", async () => {
    const snapshot = {
      onboardingComplete: true,
      openCode: {
        installed: true,
        compatible: true,
        connected: true,
        version: "1.2.3",
      },
      models: [],
      graphs: [makeGraph()],
      runs: [makeRun()],
      activeRunId: "run-1",
    };
    channel.handlers.set("state.get", () => snapshot);
    const result = await mcpClient.callTool(
      { name: "spire_state_get", arguments: {} },
      CallToolResultSchema,
    );
    expect(result.structuredContent).toEqual(snapshot);
  });

  it("surfaces operation failures as tool errors", async () => {
    channel.handlers.set("runs.get", () => {
      throw new Error("Run not found.");
    });
    const result = await mcpClient.callTool(
      { name: "spire_runs_get", arguments: { runId: "missing" } },
      CallToolResultSchema,
    );
    expect(result.isError).toBe(true);
    const text = firstContent(result);
    expect(text?.type === "text" && text.text).toContain("Run not found.");
  });

  it("rejects inputs that fail the capability schema", async () => {
    const result = await mcpClient.callTool(
      { name: "spire_runs_stop", arguments: { runId: "" } },
      CallToolResultSchema,
    );
    expect(result.isError).toBe(true);
    expect(channel.executeSpy).not.toHaveBeenCalledWith(
      "runs.stop",
      expect.anything(),
    );
  });

  it("serves the state resource and resource templates", async () => {
    const { resources } = await mcpClient.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual([
      "spire://state",
    ]);

    const { resourceTemplates } = await mcpClient.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      "spire://graphs/{graphId}",
      "spire://runs/{runId}",
      "spire://runs/{runId}/artifacts",
      "spire://traces/{runId}",
    ]);
  });

  it("reads resources through control operations", async () => {
    const run = makeRun();
    const artifacts = makeArtifacts();
    channel.handlers.set("state.get", () => ({ marker: "state" }));
    channel.handlers.set("runs.get", () => run);
    channel.handlers.set("runs.artifacts.get", () => artifacts);
    channel.handlers.set("graphs.get", () => makeGraph());
    channel.handlers.set("traces.query", () => ({
      events: [makeTraceEvent()],
      nextCursor: null,
    }));

    const state = await mcpClient.readResource({ uri: "spire://state" });
    expect(JSON.parse((state.contents[0] as { text: string }).text)).toEqual({
      marker: "state",
    });

    const runRead = await mcpClient.readResource({
      uri: "spire://runs/run-1",
    });
    expect(channel.executeSpy).toHaveBeenCalledWith("runs.get", {
      runId: "run-1",
    });
    expect(JSON.parse((runRead.contents[0] as { text: string }).text)).toEqual(run);

    const artifactsRead = await mcpClient.readResource({
      uri: "spire://runs/run-1/artifacts",
    });
    expect(channel.executeSpy).toHaveBeenCalledWith("runs.artifacts.get", {
      runId: "run-1",
    });
    expect(JSON.parse((artifactsRead.contents[0] as { text: string }).text)).toEqual(
      artifacts,
    );

    const graphRead = await mcpClient.readResource({
      uri: "spire://graphs/graph-1",
    });
    expect(channel.executeSpy).toHaveBeenCalledWith("graphs.get", {
      graphId: "graph-1",
    });
    expect(graphRead.contents[0]?.mimeType).toBe("application/json");

    const tracesRead = await mcpClient.readResource({
      uri: "spire://traces/run-1",
    });
    expect(channel.executeSpy).toHaveBeenCalledWith("traces.query", {
      runId: "run-1",
    });
    expect(
      JSON.parse((tracesRead.contents[0] as { text: string }).text),
    ).toMatchObject({ nextCursor: null });
  });

  it("forwards trace events as MCP logging notifications", async () => {
    expect(channel.traceListener).toBeDefined();
    const event = makeTraceEvent({ level: "warn" });
    channel.traceListener?.(event);
    await vi.waitFor(() => expect(logging).toHaveLength(1));
    expect(logging[0]).toMatchObject({
      level: "warning",
      logger: "spire",
    });
    expect(logging[0]?.data).toMatchObject({
      sequence: 7,
      message: "slow response",
      runId: "run-1",
    });
  });
});
