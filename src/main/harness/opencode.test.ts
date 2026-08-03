import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk";
import type {
  HarnessAdapter,
  HarnessEvent,
  HarnessRunInput,
  HarnessRunResult,
  HarnessSessionRef,
} from "../../shared/harness";
import { runHarnessStructured } from "./adapter";
import {
  OpenCodeAdapter,
  OpenCodeHarness,
  translateOpencodeEvent,
} from "./opencode";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  access: vi.fn(),
  createOpencodeClient: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

vi.mock("node:fs/promises", () => ({
  access: mocks.access,
}));

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: mocks.createOpencodeClient,
}));

type FakeServer = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function fakeServerProcess(exitOnTerminate = true): FakeServer {
  const proc = new EventEmitter() as FakeServer;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => {
    if (exitOnTerminate) {
      queueMicrotask(() => proc.emit("exit", 0, "SIGTERM"));
    }
    return true;
  });
  queueMicrotask(() => {
    proc.stdout.emit(
      "data",
      Buffer.from("opencode server listening at http://127.0.0.1:4096\n"),
    );
  });
  return proc;
}

type PromptRequest = {
  path: { id: string };
  body: {
    tools?: Record<string, boolean>;
    parts: Array<{ type: string; text: string }>;
  };
};

type PromptResponse = {
  data: { parts: Array<{ type: string; text: string }> };
};

function fakeClient() {
  return {
    auth: { set: vi.fn(async () => ({ data: undefined })) },
    provider: {
      list: vi.fn(async () => ({
        data: {
          all: [
            {
              id: "openrouter",
              models: {
                b: { id: "b-model", name: "B Model", status: "active" },
                a: { id: "a-model", name: "A Model", status: "active" },
                old: { id: "old", name: "Old", status: "deprecated" },
              },
            },
          ],
        },
      })),
    },
    session: {
      create: vi.fn(async () => ({ data: { id: "ses_new" } })),
      prompt: vi.fn<(request: PromptRequest) => Promise<PromptResponse>>(
        async () => ({
          data: { parts: [{ type: "text", text: '{"status":"succeeded"}' }] },
        }),
      ),
      abort: vi.fn(async () => ({ data: true })),
    },
    event: {
      subscribe: vi.fn(
        async (): Promise<{ stream: AsyncGenerator<unknown> }> => ({
          stream: (async function* () {})(),
        }),
      ),
    },
  };
}

type FakeClient = ReturnType<typeof fakeClient>;

function runInput(
  overrides: Partial<HarnessRunInput> = {},
): HarnessRunInput & { events: HarnessEvent[]; sessions: HarnessSessionRef[] } {
  const events: HarnessEvent[] = [];
  const sessions: HarnessSessionRef[] = [];
  return {
    runId: "run-1",
    nodeId: "node-1",
    directory: "/tmp/work",
    modelId: "openrouter/test-model",
    job: "Do the thing",
    context: "Some context",
    access: { mode: "read-only", writeScopes: [] },
    outputSchema: { type: "object", properties: { status: { type: "string" } } },
    events,
    sessions,
    onSession: (ref) => sessions.push(ref),
    onEvent: (event) => events.push(event),
    ...overrides,
  };
}

describe("OpenCodeAdapter", () => {
  let client: FakeClient;
  let server: FakeServer;

  beforeEach(() => {
    vi.clearAllMocks();
    client = fakeClient();
    mocks.createOpencodeClient.mockImplementation(() => client);
    mocks.spawn.mockImplementation(() => {
      server = fakeServerProcess();
      return server;
    });
    mocks.access.mockResolvedValue(undefined);
    mocks.execFile.mockImplementation(
      (command: string, _args: string[], callback: (...args: unknown[]) => void) => {
        if (command === "which") {
          callback(null, { stdout: "/mock/opencode\n", stderr: "" });
        } else {
          callback(null, { stdout: "1.2.3\n", stderr: "" });
        }
      },
    );
  });

  it("probes the CLI and reports a normalized harness status", async () => {
    const adapter = new OpenCodeAdapter();
    await expect(adapter.probe()).resolves.toEqual({
      harnessId: "opencode",
      installed: true,
      binaryPath: "/mock/opencode",
      version: "1.2.3",
      compatible: true,
      connected: false,
    });
  });

  it("reports a failed probe as a status instead of throwing", async () => {
    mocks.execFile.mockImplementation(
      (_command: string, _args: string[], callback: (...args: unknown[]) => void) => {
        callback(new Error("not found"));
      },
    );
    const adapter = new OpenCodeAdapter();
    await expect(adapter.probe()).resolves.toMatchObject({
      harnessId: "opencode",
      installed: false,
      compatible: false,
      connected: false,
      error: "not found",
    });
  });

  it("lists non-deprecated OpenRouter models sorted by name", async () => {
    const adapter = new OpenCodeAdapter();
    await expect(adapter.listModels()).resolves.toEqual([
      { id: "openrouter/a-model", name: "A Model" },
      { id: "openrouter/b-model", name: "B Model" },
    ]);
  });

  it("creates a session, emits the session ref immediately, and parses structured output", async () => {
    const adapter = new OpenCodeAdapter();
    const input = runInput();
    let sessionSeenBeforePromptReturned = false;
    client.session.prompt.mockImplementation(async () => {
      sessionSeenBeforePromptReturned = input.sessions.length === 1;
      return { data: { parts: [{ type: "text", text: '{"status":"succeeded"}' }] } };
    });
    const result = await adapter.run(input);
    expect(client.session.create).toHaveBeenCalledTimes(1);
    expect(sessionSeenBeforePromptReturned).toBe(true);
    const ref: HarnessSessionRef = {
      harnessId: "opencode",
      sessionId: "ses_new",
      directory: "/tmp/work",
    };
    expect(input.sessions).toEqual([ref]);
    expect(input.events[0]).toEqual({ type: "session", session: ref });
    expect(result.session).toEqual(ref);
    expect(result.output).toEqual({ status: "succeeded" });
  });

  it("reuses a provided session instead of creating one", async () => {
    const adapter = new OpenCodeAdapter();
    const session: HarnessSessionRef = {
      harnessId: "opencode",
      sessionId: "ses_existing",
      directory: "/tmp/work",
    };
    const input = runInput({ session });
    await adapter.run(input);
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "ses_existing" } }),
    );
  });

  it("embeds the requested output schema in the prompt", async () => {
    const adapter = new OpenCodeAdapter();
    const input = runInput();
    await adapter.run(input);
    const body = client.session.prompt.mock.calls[0][0].body;
    expect(body.parts[0].text).toContain('"status"');
    expect(body.parts[0].text).toContain("Do the thing");
    expect(body.parts[0].text).toContain("Some context");
  });

  it("disables write tools for read-only access and enables them for workspace-write", async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.run(runInput());
    expect(client.session.prompt.mock.calls[0][0].body.tools).toEqual({
      write: false,
      edit: false,
      patch: false,
      apply_patch: false,
      bash: false,
    });
    await adapter.run(
      runInput({ access: { mode: "workspace-write", writeScopes: [] } }),
    );
    expect(client.session.prompt.mock.calls[1][0].body.tools).toBeUndefined();
  });

  it("returns raw text when the model output is not JSON", async () => {
    client.session.prompt.mockResolvedValue({
      data: { parts: [{ type: "text", text: "plain answer" }] },
    });
    const adapter = new OpenCodeAdapter();
    const result = await adapter.run(runInput());
    expect(result.output).toBe("plain answer");
  });

  it("forwards translated SDK events to the run's onEvent", async () => {
    const events: unknown[] = [
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_1",
            sessionID: "ses_new",
            messageID: "msg_1",
            type: "tool",
            callID: "call_1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls" },
              output: "file.txt",
              title: "List files",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
        },
      },
      {
        type: "session.idle",
        properties: { sessionID: "ses_new" },
      },
    ];
    client.event.subscribe.mockResolvedValue({
      stream: (async function* () {
        for (const event of events) yield event;
      })(),
    });
    client.session.prompt.mockImplementation(async () => {
      await vi.waitFor(() => {
        expect(
          input.events.some((event) => event.type === "tool_result"),
        ).toBe(true);
      });
      return { data: { parts: [{ type: "text", text: "{}" }] } };
    });
    const adapter = new OpenCodeAdapter();
    const input = runInput();
    await adapter.run(input);
    expect(input.events).toContainEqual({
      type: "tool_result",
      tool: "bash",
      output: "file.txt",
    });
  });

  it("aborts a session through the scoped client", async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.run(runInput());
    await adapter.abort({
      harnessId: "opencode",
      sessionId: "ses_new",
      directory: "/tmp/work",
    });
    expect(client.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "ses_new" } }),
    );
  });

  it("kills the server process on close", async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.run(runInput());
    await adapter.close();
    expect(server.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("waits for process exit after force-killing an unresponsive server", async () => {
    let stubbornServer: FakeServer | undefined;
    mocks.spawn.mockImplementationOnce(() => {
      stubbornServer = fakeServerProcess(false);
      return stubbornServer;
    });
    const adapter = new OpenCodeAdapter();
    await adapter.run(runInput());
    if (!stubbornServer) throw new Error("Expected the OpenCode server to spawn.");

    let closed = false;
    const closing = adapter.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(stubbornServer.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(stubbornServer.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(closed).toBe(false);

    stubbornServer.emit("exit", null, "SIGKILL");
    await closing;
    expect(closed).toBe(true);
  });
});

describe("OpenCodeHarness legacy facade", () => {
  let client: FakeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = fakeClient();
    mocks.createOpencodeClient.mockImplementation(() => client);
    mocks.spawn.mockImplementation(() => fakeServerProcess());
    mocks.access.mockResolvedValue(undefined);
    mocks.execFile.mockImplementation(
      (command: string, _args: string[], callback: (...args: unknown[]) => void) => {
        if (command === "which") {
          callback(null, { stdout: "/mock/opencode\n", stderr: "" });
        } else {
          callback(null, { stdout: "1.2.3\n", stderr: "" });
        }
      },
    );
  });

  it("detects without a harnessId field (OpenCodeStatus shape)", async () => {
    const harness = new OpenCodeHarness();
    const status = await harness.detect();
    expect(status).toEqual({
      installed: true,
      binaryPath: "/mock/opencode",
      version: "1.2.3",
      compatible: true,
      connected: false,
    });
    expect("harnessId" in status).toBe(false);
  });

  it("maps normalized events back to legacy kinds and messages", async () => {
    const sdkEvents: unknown[] = [
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_1",
            sessionID: "ses_new",
            messageID: "msg_1",
            type: "tool",
            callID: "call_1",
            tool: "bash",
            state: {
              status: "completed",
              input: {},
              output: "done",
              title: "Run",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_2",
            sessionID: "ses_new",
            messageID: "msg_1",
            type: "text",
            text: "final answer",
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "ses_new" } },
    ];
    client.event.subscribe.mockResolvedValue({
      stream: (async function* () {
        for (const event of sdkEvents) yield event;
      })(),
    });
    const received: Array<{ kind: string; message: string; payload?: unknown }> =
      [];
    client.session.prompt.mockImplementation(async () => {
      await vi.waitFor(() => {
        expect(received.length).toBeGreaterThanOrEqual(3);
      });
      return { data: { parts: [{ type: "text", text: "final answer" }] } };
    });
    const harness = new OpenCodeHarness();
    const response = await harness.prompt({
      directory: "/tmp/work",
      title: "Test",
      model: "openrouter/test-model",
      system: "system",
      prompt: "prompt",
      readOnly: true,
      onEvent: (kind, message, payload) =>
        received.push({ kind, message, payload }),
    });
    expect(response).toEqual({ sessionId: "ses_new", text: "final answer" });
    expect(received).toContainEqual(
      expect.objectContaining({ kind: "tool", message: "bash completed" }),
    );
    expect(received).toContainEqual(
      expect.objectContaining({ kind: "message", message: "final answer" }),
    );
    expect(received).toContainEqual(
      expect.objectContaining({ kind: "status", message: "Agent finished" }),
    );
    const toolEvent = received.find((entry) => entry.kind === "tool");
    expect(toolEvent?.payload).toMatchObject({
      type: "message.part.updated",
    });
  });
});

describe("translateOpencodeEvent", () => {
  const directory = "/tmp/work";
  const translate = (event: unknown) =>
    translateOpencodeEvent(event as Event, directory);

  it("translates session.created into a session event with a full ref", () => {
    expect(
      translate({
        type: "session.created",
        properties: { info: { id: "ses_1" } },
      }),
    ).toEqual({
      type: "session",
      session: { harnessId: "opencode", sessionId: "ses_1", directory },
    });
  });

  it("translates assistant text parts", () => {
    expect(
      translate({
        type: "message.part.updated",
        properties: { part: { type: "text", text: "Hello" } },
      }),
    ).toEqual({ type: "assistant_text", text: "Hello" });
  });

  it("ignores empty text parts", () => {
    expect(
      translate({
        type: "message.part.updated",
        properties: { part: { type: "text", text: "   " } },
      }),
    ).toBeUndefined();
  });

  it("translates reasoning parts", () => {
    expect(
      translate({
        type: "message.part.updated",
        properties: { part: { type: "reasoning", text: "Thinking" } },
      }),
    ).toEqual({ type: "reasoning", text: "Thinking" });
  });

  it("translates a pending tool call into tool_start", () => {
    expect(
      translate({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "bash",
            state: { status: "pending", input: { command: "ls" }, raw: "" },
          },
        },
      }),
    ).toEqual({ type: "tool_start", tool: "bash", input: { command: "ls" } });
  });

  it("translates a running tool call into tool_progress", () => {
    expect(
      translate({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "bash",
            state: {
              status: "running",
              input: {},
              title: "Listing files",
              time: { start: 1 },
            },
          },
        },
      }),
    ).toEqual({ type: "tool_progress", tool: "bash", message: "Listing files" });
  });

  it("translates a completed tool call into tool_result with output", () => {
    expect(
      translate({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: {}, output: "file.txt" },
          },
        },
      }),
    ).toEqual({ type: "tool_result", tool: "bash", output: "file.txt" });
  });

  it("translates an errored tool call into tool_result with an error", () => {
    expect(
      translate({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "bash",
            state: { status: "error", input: {}, error: "exit 1" },
          },
        },
      }),
    ).toEqual({ type: "tool_result", tool: "bash", error: "exit 1" });
  });

  it("translates permission requests into approval events", () => {
    expect(
      translate({
        type: "permission.updated",
        properties: {
          id: "per_1",
          type: "bash",
          title: "Run ls",
          pattern: "ls *",
          sessionID: "ses_1",
          messageID: "msg_1",
          metadata: {},
          time: { created: 1 },
        },
      }),
    ).toEqual({
      type: "approval",
      id: "per_1",
      permission: "bash",
      title: "Run ls",
      pattern: "ls *",
    });
  });

  it("translates completed assistant messages into usage events", () => {
    expect(
      translate({
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            time: { created: 1, completed: 2 },
            cost: 0.002,
            tokens: {
              input: 100,
              output: 50,
              reasoning: 10,
              cache: { read: 5, write: 0 },
            },
          },
        },
      }),
    ).toEqual({
      type: "usage",
      tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 0 },
      cost: 0.002,
    });
  });

  it("ignores in-flight assistant messages", () => {
    expect(
      translate({
        type: "message.updated",
        properties: {
          info: { role: "assistant", time: { created: 1 } },
        },
      }),
    ).toBeUndefined();
  });

  it("translates session retries into warnings", () => {
    expect(
      translate({
        type: "session.status",
        properties: {
          sessionID: "ses_1",
          status: { type: "retry", attempt: 1, message: "Rate limited", next: 2 },
        },
      }),
    ).toEqual({ type: "warning", message: "Rate limited" });
  });

  it("translates session errors into error events", () => {
    expect(
      translate({
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          error: { name: "UnknownError", data: { message: "Boom" } },
        },
      }),
    ).toEqual({ type: "error", message: "Boom" });
  });

  it("translates aborted sessions into cancellation events", () => {
    expect(
      translate({
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      }),
    ).toEqual({ type: "cancelled", message: "Aborted" });
  });

  it("translates session.idle into a status event", () => {
    expect(
      translate({
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      }),
    ).toEqual({ type: "status", message: "Agent finished" });
  });

  it("ignores unrelated events", () => {
    expect(
      translate({
        type: "file.edited",
        properties: { file: "src/index.ts" },
      }),
    ).toBeUndefined();
  });
});

describe("runHarnessStructured", () => {
  function structuredFake(
    outputs: unknown[],
  ): HarnessAdapter & { calls: HarnessRunInput[] } {
    const calls: HarnessRunInput[] = [];
    let index = 0;
    return {
      id: "opencode",
      calls,
      probe: async () => ({
        harnessId: "opencode",
        installed: true,
        compatible: true,
        connected: true,
      }),
      listModels: async () => [],
      run: async (input) => {
        calls.push(input);
        const output = outputs[Math.min(index++, outputs.length - 1)];
        const session: HarnessSessionRef = {
          harnessId: "opencode",
          sessionId: "ses_1",
          directory: input.directory,
        };
        input.onSession(session);
        return { session, output } satisfies HarnessRunResult;
      },
      abort: async () => undefined,
      close: async () => undefined,
    };
  }

  const parseStatus = (value: unknown): { status: string } => {
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { status?: unknown }).status === "string"
    ) {
      return value as { status: string };
    }
    throw new Error("invalid output");
  };

  const baseInput = (): HarnessRunInput & { events: HarnessEvent[] } => {
    const events: HarnessEvent[] = [];
    return {
      runId: "run-1",
      nodeId: "node-1",
      directory: "/tmp/work",
      modelId: "openrouter/test",
      job: "Do it",
      context: "",
      access: { mode: "read-only", writeScopes: [] },
      outputSchema: {},
      events,
      onSession: () => undefined,
      onEvent: (event) => events.push(event),
    };
  };

  it("returns parsed output without a repair when the first attempt is valid", async () => {
    const adapter = structuredFake([{ status: "succeeded" }]);
    const result = await runHarnessStructured({
      adapter,
      input: baseInput(),
      parse: parseStatus,
      schemaName: "NodeOutcome",
    });
    expect(result.output).toEqual({ status: "succeeded" });
    expect(result.session.sessionId).toBe("ses_1");
    expect(adapter.calls).toHaveLength(1);
  });

  it("makes exactly one repair attempt on the same session after invalid output", async () => {
    const adapter = structuredFake(["not json", { status: "succeeded" }]);
    const input = baseInput();
    const result = await runHarnessStructured({
      adapter,
      input,
      parse: parseStatus,
      schemaName: "NodeOutcome",
    });
    expect(result.output).toEqual({ status: "succeeded" });
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1].session).toEqual({
      harnessId: "opencode",
      sessionId: "ses_1",
      directory: "/tmp/work",
    });
    expect(adapter.calls[1].job).toContain("NodeOutcome");
    expect(adapter.calls[1].job).toContain("not json");
    expect(input.events).toContainEqual(
      expect.objectContaining({ type: "warning" }),
    );
  });

  it("parses JSON text output from the first attempt", async () => {
    const adapter = structuredFake(['{"status":"succeeded"}']);
    const result = await runHarnessStructured({
      adapter,
      input: baseInput(),
      parse: parseStatus,
      schemaName: "NodeOutcome",
    });
    expect(result.output).toEqual({ status: "succeeded" });
    expect(adapter.calls).toHaveLength(1);
  });

  it("throws when the repair attempt still produces invalid output", async () => {
    const adapter = structuredFake(["garbage", "still garbage"]);
    await expect(
      runHarnessStructured({
        adapter,
        input: baseInput(),
        parse: parseStatus,
        schemaName: "NodeOutcome",
      }),
    ).rejects.toThrow();
    expect(adapter.calls).toHaveLength(2);
  });
});
