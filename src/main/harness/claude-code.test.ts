import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HarnessEvent,
  HarnessRunInput,
  HarnessSessionRef,
} from "../../shared/harness";
import { ClaudeCodeAdapter } from "./claude-code";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  access: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

vi.mock("node:fs/promises", () => ({
  access: mocks.access,
}));

type FakeProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function fakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

const fixtureLines = readFileSync(
  path.join(__dirname, "fixtures", "claude-stream.jsonl"),
  "utf8",
)
  .trim()
  .split("\n");

function runInput(
  overrides: Partial<HarnessRunInput> = {},
): HarnessRunInput & { events: HarnessEvent[]; sessions: HarnessSessionRef[] } {
  const events: HarnessEvent[] = [];
  const sessions: HarnessSessionRef[] = [];
  return {
    runId: "run-1",
    nodeId: "node-1",
    directory: "/tmp/work",
    modelId: "sonnet",
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

function mockInstalledBinary() {
  mocks.access.mockResolvedValue(undefined);
  mocks.execFile.mockImplementation(
    (command: string, _args: string[], callback: (...args: unknown[]) => void) => {
      if (command === "which") {
        callback(null, { stdout: "/mock/claude\n", stderr: "" });
      } else {
        callback(null, { stdout: "2.1.205 (Claude Code)\n", stderr: "" });
      }
    },
  );
}

async function startRun(adapter: ClaudeCodeAdapter, input: HarnessRunInput) {
  const runPromise = adapter.run(input);
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
  const proc = mocks.spawn.mock.results[0].value as FakeProcess;
  return { runPromise, proc };
}

function feedFixture(proc: FakeProcess) {
  for (const line of fixtureLines) {
    proc.stdout.emit("data", Buffer.from(`${line}\n`));
  }
}

describe("ClaudeCodeAdapter probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    mockInstalledBinary();
  });

  it("reports installed, version, and auth state from the CLI", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const adapter = new ClaudeCodeAdapter();
    await expect(adapter.probe()).resolves.toEqual({
      harnessId: "claude-code",
      installed: true,
      binaryPath: "/mock/claude",
      version: "2.1.205",
      compatible: true,
      connected: true,
    });
  });

  it("reports connected:false when no credentials are present", async () => {
    const adapter = new ClaudeCodeAdapter();
    await expect(adapter.probe()).resolves.toMatchObject({
      installed: true,
      connected: false,
    });
  });

  it("reports installed:false instead of throwing when the binary is absent", async () => {
    mocks.execFile.mockImplementation(
      (_command: string, _args: string[], callback: (...args: unknown[]) => void) => {
        callback(new Error("not found"));
      },
    );
    const adapter = new ClaudeCodeAdapter();
    await expect(adapter.probe()).resolves.toMatchObject({
      harnessId: "claude-code",
      installed: false,
      compatible: false,
      connected: false,
      error: "not found",
    });
  });
});

describe("ClaudeCodeAdapter run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstalledBinary();
    mocks.spawn.mockImplementation(() => fakeProcess());
  });

  it("spawns print mode with stream JSON, a schema, and the working directory", async () => {
    const adapter = new ClaudeCodeAdapter();
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    feedFixture(proc);
    proc.emit("exit", 0, null);
    await runPromise;

    const [binary, args, options] = mocks.spawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(binary).toBe("/mock/claude");
    expect(Array.isArray(args)).toBe(true);
    expect(options).toMatchObject({ cwd: "/tmp/work" });
    expect(options.shell).toBeUndefined();
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--json-schema") + 1]).toBe(
      JSON.stringify(input.outputSchema),
    );
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.length - 1]).toContain("Do the thing");
    expect(args[args.length - 1]).toContain("Some context");
  });

  it("emits the session ref and parses structured output", async () => {
    const adapter = new ClaudeCodeAdapter();
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    feedFixture(proc);
    proc.emit("exit", 0, null);
    const result = await runPromise;

    const ref: HarnessSessionRef = {
      harnessId: "claude-code",
      sessionId: "sess-claude-1",
      directory: "/tmp/work",
    };
    expect(input.sessions).toEqual([ref]);
    expect(input.events[0]).toEqual({ type: "session", session: ref });
    expect(result.session).toEqual(ref);
    expect(result.output).toEqual({ status: "succeeded", summary: "done" });
  });

  it("translates assistant text, reasoning, tool, and usage events", async () => {
    const adapter = new ClaudeCodeAdapter();
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    feedFixture(proc);
    proc.emit("exit", 0, null);
    await runPromise;

    expect(input.events).toContainEqual({
      type: "reasoning",
      text: "Let me inspect the repository first.",
    });
    expect(input.events).toContainEqual({
      type: "assistant_text",
      text: "Looking at the files now.",
    });
    expect(input.events).toContainEqual({
      type: "tool_start",
      tool: "Grep",
      input: { pattern: "TODO", path: "/tmp/work" },
    });
    expect(input.events).toContainEqual({
      type: "tool_result",
      tool: "Grep",
      output: "src/a.ts:1: TODO",
    });
    expect(input.events).toContainEqual({
      type: "usage",
      tokens: { input: 120, output: 45, reasoning: 0, cacheRead: 30, cacheWrite: 10 },
      cost: 0.002,
    });
  });

  it("resumes an existing session with --resume instead of starting fresh", async () => {
    const adapter = new ClaudeCodeAdapter();
    const session: HarnessSessionRef = {
      harnessId: "claude-code",
      sessionId: "sess-existing",
      directory: "/tmp/work",
    };
    const { runPromise, proc } = await startRun(adapter, runInput({ session }));
    feedFixture(proc);
    proc.emit("exit", 0, null);
    const result = await runPromise;

    const args = mocks.spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-existing");
    expect(result.session.sessionId).toBe("sess-claude-1");
  });

  it("restricts tools for read-only access and allows edits for workspace-write", async () => {
    const adapter = new ClaudeCodeAdapter();
    const first = await startRun(adapter, runInput());
    feedFixture(first.proc);
    first.proc.emit("exit", 0, null);
    await first.runPromise;
    const readOnlyArgs = mocks.spawn.mock.calls[0][1] as string[];
    expect(readOnlyArgs[readOnlyArgs.indexOf("--tools") + 1]).toContain("Read");
    expect(readOnlyArgs).not.toContain("--permission-mode");

    mocks.spawn.mockClear();
    const second = await startRun(
      adapter,
      runInput({ access: { mode: "workspace-write", writeScopes: [] } }),
    );
    feedFixture(second.proc);
    second.proc.emit("exit", 0, null);
    await second.runPromise;
    const writeArgs = mocks.spawn.mock.calls[0][1] as string[];
    expect(writeArgs).not.toContain("--tools");
    expect(writeArgs[writeArgs.indexOf("--permission-mode") + 1]).toBe(
      "acceptEdits",
    );
    expect(writeArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("warns and continues on malformed output lines", async () => {
    const adapter = new ClaudeCodeAdapter();
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    proc.stdout.emit("data", Buffer.from("this is not json\n"));
    feedFixture(proc);
    proc.emit("exit", 0, null);
    const result = await runPromise;

    expect(input.events.some((event) => event.type === "warning")).toBe(true);
    expect(result.output).toEqual({ status: "succeeded", summary: "done" });
  });

  it("warns and skips lines over the 1 MiB cap", async () => {
    const adapter = new ClaudeCodeAdapter();
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    proc.stdout.emit(
      "data",
      Buffer.from(`${"x".repeat(1024 * 1024 + 16)}\n`),
    );
    feedFixture(proc);
    proc.emit("exit", 0, null);
    const result = await runPromise;

    expect(input.events.some((event) => event.type === "warning")).toBe(true);
    expect(result.output).toEqual({ status: "succeeded", summary: "done" });
  });

  it("emits an error and rejects on non-zero exit", async () => {
    const adapter = new ClaudeCodeAdapter();
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    feedFixture(proc);
    proc.emit("exit", 2, null);
    await expect(runPromise).rejects.toThrow(/exited/);
    expect(input.events.some((event) => event.type === "error")).toBe(true);
  });

  it("kills the process and emits a timeout event when the run stalls", async () => {
    const adapter = new ClaudeCodeAdapter({ timeoutMs: 25 });
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    await vi.waitFor(() => expect(proc.kill).toHaveBeenCalledWith("SIGTERM"));
    proc.emit("exit", null, "SIGTERM");
    await expect(runPromise).rejects.toThrow(/[Tt]imed out/);
    expect(input.events.some((event) => event.type === "timeout")).toBe(true);
  });

  it("kills the process and emits cancellation on abort", async () => {
    const adapter = new ClaudeCodeAdapter();
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    proc.stdout.emit("data", Buffer.from(`${fixtureLines[0]}\n`));
    await adapter.abort({
      harnessId: "claude-code",
      sessionId: "sess-claude-1",
      directory: "/tmp/work",
    });
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    proc.emit("exit", null, "SIGTERM");
    await expect(runPromise).rejects.toThrow(/[Cc]ancell/);
    expect(input.events).toContainEqual(
      expect.objectContaining({ type: "cancelled" }),
    );
  });

  it("redacts credential-looking strings from stderr events", async () => {
    const adapter = new ClaudeCodeAdapter();
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    proc.stderr.emit(
      "data",
      Buffer.from(
        "auth failed for sk-ant-api03-supersecretvalue123 and Bearer abc.def.ghi",
      ),
    );
    feedFixture(proc);
    proc.emit("exit", 0, null);
    await runPromise;

    const stderrEvents = input.events.filter((event) => event.type === "stderr");
    expect(stderrEvents).toHaveLength(1);
    const text = stderrEvents[0].type === "stderr" ? stderrEvents[0].text : "";
    expect(text).not.toContain("sk-ant-api03-supersecretvalue123");
    expect(text).not.toContain("abc.def.ghi");
    expect(text).toContain("[redacted]");
  });

  it("falls back to the result text when structured output is absent", async () => {
    const adapter = new ClaudeCodeAdapter();
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    proc.stdout.emit("data", Buffer.from(`${fixtureLines[0]}\n`));
    proc.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sess-claude-1",
          usage: { input_tokens: 1, output_tokens: 1 },
          result: "plain answer",
        })}\n`,
      ),
    );
    proc.emit("exit", 0, null);
    const result = await runPromise;
    expect(result.output).toBe("plain answer");
  });

  it("returns static model aliases", async () => {
    const adapter = new ClaudeCodeAdapter();
    const models = await adapter.listModels();
    expect(models.map((model) => model.id)).toContain("sonnet");
  });
});
