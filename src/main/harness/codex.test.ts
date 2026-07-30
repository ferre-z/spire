import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HarnessEvent,
  HarnessRunInput,
  HarnessSessionRef,
} from "../../shared/harness";
import { CodexAdapter } from "./codex";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

vi.mock("node:fs/promises", () => ({
  access: mocks.access,
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  rm: mocks.rm,
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
  path.join(__dirname, "fixtures", "codex-events.jsonl"),
  "utf8",
)
  .trim()
  .split("\n");

const DATA_DIR = "/tmp/spire-data";

function runInput(
  overrides: Partial<HarnessRunInput> = {},
): HarnessRunInput & { events: HarnessEvent[]; sessions: HarnessSessionRef[] } {
  const events: HarnessEvent[] = [];
  const sessions: HarnessSessionRef[] = [];
  return {
    runId: "run-1",
    nodeId: "node-1",
    directory: "/tmp/work",
    modelId: "gpt-5-codex",
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

function mockInstalledBinary(options: { loggedIn?: boolean } = {}) {
  mocks.access.mockResolvedValue(undefined);
  mocks.execFile.mockImplementation(
    (command: string, args: string[], callback: (...args: unknown[]) => void) => {
      if (command === "which") {
        callback(null, { stdout: "/mock/codex\n", stderr: "" });
      } else if (args[0] === "--version") {
        callback(null, { stdout: "codex-cli 0.55.0\n", stderr: "" });
      } else if (args[0] === "login") {
        if (options.loggedIn) {
          callback(null, { stdout: "Logged in using ChatGPT\n", stderr: "" });
        } else {
          callback(new Error("Not logged in"));
        }
      } else {
        callback(new Error(`unexpected command: ${args.join(" ")}`));
      }
    },
  );
}

async function startRun(adapter: CodexAdapter, input: HarnessRunInput) {
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

describe("CodexAdapter probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstalledBinary({ loggedIn: true });
  });

  it("reports installed, version, and login state from the CLI", async () => {
    const adapter = new CodexAdapter();
    await expect(adapter.probe()).resolves.toEqual({
      harnessId: "codex",
      installed: true,
      binaryPath: "/mock/codex",
      version: "0.55.0",
      compatible: true,
      connected: true,
    });
  });

  it("reports connected:false when codex login status fails", async () => {
    mockInstalledBinary({ loggedIn: false });
    const adapter = new CodexAdapter();
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
    const adapter = new CodexAdapter();
    await expect(adapter.probe()).resolves.toMatchObject({
      harnessId: "codex",
      installed: false,
      compatible: false,
      connected: false,
      error: "not found",
    });
  });
});

describe("CodexAdapter run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstalledBinary({ loggedIn: true });
    mocks.spawn.mockImplementation(() => fakeProcess());
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
  });

  it("spawns codex exec --json with an output schema, cwd, and sandbox", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR });
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
    expect(binary).toBe("/mock/codex");
    expect(Array.isArray(args)).toBe(true);
    expect(options).toMatchObject({ cwd: "/tmp/work" });
    expect(options.shell).toBeUndefined();
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    const schemaPath = args[args.indexOf("--output-schema") + 1];
    expect(schemaPath.startsWith(DATA_DIR)).toBe(true);
    expect(args[args.indexOf("--cd") + 1]).toBe("/tmp/work");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5-codex");
    expect(args[args.length - 1]).toContain("Do the thing");
    expect(args[args.length - 1]).toContain("Some context");
    expect(args.join(" ")).not.toMatch(/dangerously|yolo/);
  });

  it("writes the temporary schema with mode 0600 and cleans it up", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR });
    const { runPromise, proc } = await startRun(adapter, runInput());
    feedFixture(proc);
    proc.emit("exit", 0, null);
    await runPromise;

    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const [schemaPath, contents, options] = mocks.writeFile.mock.calls[0] as [
      string,
      string,
      { mode: number },
    ];
    expect(schemaPath.startsWith(DATA_DIR)).toBe(true);
    expect(JSON.parse(contents)).toEqual({
      type: "object",
      properties: { status: { type: "string" } },
    });
    expect(options.mode).toBe(0o600);
    expect(mocks.rm).toHaveBeenCalledWith(
      schemaPath,
      expect.objectContaining({ force: true }),
    );
  });

  it("emits the session ref and parses the structured agent message", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR });
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    feedFixture(proc);
    proc.emit("exit", 0, null);
    const result = await runPromise;

    const ref: HarnessSessionRef = {
      harnessId: "codex",
      sessionId: "thread-codex-1",
      directory: "/tmp/work",
    };
    expect(input.sessions).toEqual([ref]);
    expect(input.events[0]).toEqual({ type: "session", session: ref });
    expect(result.session).toEqual(ref);
    expect(result.output).toEqual({ status: "succeeded", summary: "done" });
  });

  it("translates item, reasoning, and token usage events", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR });
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    feedFixture(proc);
    proc.emit("exit", 0, null);
    await runPromise;

    expect(input.events).toContainEqual({
      type: "tool_start",
      tool: "command_execution",
      input: { command: "ls -la" },
    });
    expect(input.events).toContainEqual({
      type: "tool_result",
      tool: "command_execution",
      output: "total 0",
    });
    expect(input.events).toContainEqual({
      type: "reasoning",
      text: "Thinking about the task",
    });
    expect(input.events).toContainEqual({
      type: "assistant_text",
      text: '{"status":"succeeded","summary":"done"}',
    });
    expect(input.events).toContainEqual({
      type: "usage",
      tokens: { input: 200, output: 80, reasoning: 0, cacheRead: 50, cacheWrite: 0 },
    });
  });

  it("resumes a session with codex exec resume after the parent flags", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR });
    const session: HarnessSessionRef = {
      harnessId: "codex",
      sessionId: "thread-existing",
      directory: "/tmp/work",
    };
    const { runPromise, proc } = await startRun(adapter, runInput({ session }));
    feedFixture(proc);
    proc.emit("exit", 0, null);
    const result = await runPromise;

    const args = mocks.spawn.mock.calls[0][1] as string[];
    const resumeIndex = args.indexOf("resume");
    expect(resumeIndex).toBeGreaterThan(args.indexOf("--sandbox"));
    expect(args[resumeIndex + 1]).toBe("thread-existing");
    expect(args[resumeIndex + 2]).toContain("Do the thing");
    expect(result.session.sessionId).toBe("thread-codex-1");
  });

  it("selects the workspace-write sandbox for write-capable nodes", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR });
    const { runPromise, proc } = await startRun(
      adapter,
      runInput({ access: { mode: "workspace-write", writeScopes: [] } }),
    );
    feedFixture(proc);
    proc.emit("exit", 0, null);
    await runPromise;
    const args = mocks.spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  it("warns and continues on malformed output lines", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR });
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    proc.stdout.emit("data", Buffer.from("{broken json\n"));
    feedFixture(proc);
    proc.emit("exit", 0, null);
    const result = await runPromise;

    expect(input.events.some((event) => event.type === "warning")).toBe(true);
    expect(result.output).toEqual({ status: "succeeded", summary: "done" });
  });

  it("warns and skips lines over the 1 MiB cap", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR });
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    proc.stdout.emit("data", Buffer.from(`${"x".repeat(1024 * 1024 + 16)}\n`));
    feedFixture(proc);
    proc.emit("exit", 0, null);
    const result = await runPromise;

    expect(input.events.some((event) => event.type === "warning")).toBe(true);
    expect(result.output).toEqual({ status: "succeeded", summary: "done" });
  });

  it("emits an error and rejects on non-zero exit", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR });
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    feedFixture(proc);
    proc.emit("exit", 2, null);
    await expect(runPromise).rejects.toThrow(/exited/);
    expect(input.events.some((event) => event.type === "error")).toBe(true);
  });

  it("terminates the process and emits a timeout event when the run stalls", async () => {
    const adapter = new CodexAdapter({
      dataDir: DATA_DIR,
      timeoutMs: 25,
      killGraceMs: 5,
    });
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    await vi.waitFor(() => expect(proc.kill).toHaveBeenCalledWith("SIGTERM"));
    proc.emit("exit", null, "SIGTERM");
    await expect(runPromise).rejects.toThrow(/[Tt]imed out/);
    expect(input.events.some((event) => event.type === "timeout")).toBe(true);
  });

  it("escalates SIGTERM to SIGKILL on cancellation", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR, killGraceMs: 10 });
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    proc.stdout.emit("data", Buffer.from(`${fixtureLines[0]}\n`));
    await adapter.abort({
      harnessId: "codex",
      sessionId: "thread-codex-1",
      directory: "/tmp/work",
    });
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    // The process ignores SIGTERM; after the grace period it must be SIGKILLed.
    await vi.waitFor(() => expect(proc.kill).toHaveBeenCalledWith("SIGKILL"));
    proc.emit("exit", null, "SIGKILL");
    await expect(runPromise).rejects.toThrow(/[Cc]ancell/);
    expect(input.events).toContainEqual(
      expect.objectContaining({ type: "cancelled" }),
    );
  });

  it("does not escalate when the process exits promptly after SIGTERM", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR, killGraceMs: 50 });
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    proc.stdout.emit("data", Buffer.from(`${fixtureLines[0]}\n`));
    await adapter.abort({
      harnessId: "codex",
      sessionId: "thread-codex-1",
      directory: "/tmp/work",
    });
    proc.emit("exit", null, "SIGTERM");
    await expect(runPromise).rejects.toThrow(/[Cc]ancell/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(proc.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("redacts credential-looking strings from stderr events", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR });
    const input = runInput();
    const { runPromise, proc } = await startRun(adapter, input);
    proc.stderr.emit(
      "data",
      Buffer.from("request failed with api_key=sk-live-secretvalue999"),
    );
    feedFixture(proc);
    proc.emit("exit", 0, null);
    await runPromise;

    const stderrEvents = input.events.filter((event) => event.type === "stderr");
    expect(stderrEvents).toHaveLength(1);
    const text = stderrEvents[0].type === "stderr" ? stderrEvents[0].text : "";
    expect(text).not.toContain("sk-live-secretvalue999");
    expect(text).toContain("[redacted]");
  });

  it("returns no models (Codex has no non-interactive model listing)", async () => {
    const adapter = new CodexAdapter({ dataDir: DATA_DIR });
    await expect(adapter.listModels()).resolves.toEqual([]);
  });
});
