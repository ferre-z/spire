import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  LoggingMessageNotificationSchema,
  type LoggingMessageNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { _electron as electron, expect, test } from "@playwright/test";
import { EXECUTABLE, launchApp, type LaunchedApp } from "./fixtures";
import { seedGraph, writeSeedFixture, type SeedOptions } from "./seed";
import { CONTROL_OPERATION_NAMES } from "../src/shared/control";
import { TOOL_NAMES } from "../src/mcp/tool-registry";
import type { TraceEvent } from "../src/shared/trace";

/**
 * End-to-end MCP control-plane tests.
 *
 * Each test launches the packaged app against an isolated, seeded userData
 * directory (same harness as the UI specs), then spawns the compiled MCP
 * stdio sidecar (`mcp-dist/mcp.js`) as a real MCP client over the SDK's
 * stdio transport. The sidecar talks to the app exclusively through the
 * authenticated Unix control socket at `<userData>/control/`.
 *
 * The run-lifecycle test launches the app with a shimmed PATH that resolves
 * `git` and `which` but not `opencode`, so harness prompts fail immediately
 * and deterministically ("A compatible OpenCode CLI was not found.") instead
 * of spawning a real agent server — the control operations under test
 * (start/stop/retry/traces/artifacts/cleanup) all run for real.
 */

const MCP_ENTRY = path.join(__dirname, "..", "mcp-dist", "mcp.js");

/** A fake API key shaped like a real one, to prove journal redaction. */
const FAKE_SECRET = "sk-e2eFAKEsecret0123456789abcd";

type ToolResult = {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
};

type McpSession = {
  client: Client;
  logs: LoggingMessageNotification[];
  close: () => Promise<void>;
};

/** Spawn the compiled sidecar and connect an MCP client over stdio. */
async function connectSidecar(userDataDir: string): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    env: { PATH: process.env.PATH ?? "", SPIRE_USER_DATA: userDataDir },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "spire-e2e", version: "0.0.0" });
  const logs: LoggingMessageNotification[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (note) => {
    logs.push(note);
  });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(
      `Sidecar connect failed: ${String(error)}\nsidecar stderr: ${stderr}`,
    );
  }
  return {
    client,
    logs,
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

async function callTool(
  session: McpSession,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await session.client.callTool({ name, arguments: args })) as ToolResult;
}

/** Poll an async probe until it returns a truthy value or time out. */
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  description: string,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out waiting for ${description}` +
      (lastError ? ` (last error: ${String(lastError)})` : ""),
  );
}

/** The control socket appears once the app's socket server has started. */
async function waitForControlSocket(userDataDir: string): Promise<{
  socketPath: string;
  tokenPath: string;
}> {
  const socketPath = path.join(userDataDir, "control", "control.sock");
  const tokenPath = path.join(userDataDir, "control", "control.token");
  await waitFor(
    async () => (existsSync(socketPath) && existsSync(tokenPath) ? true : undefined),
    "the control socket",
  );
  return { socketPath, tokenPath };
}

/** A PATH shim that resolves git/which but hides opencode. */
function makePathShim(): string {
  const shim = mkdtempSync(path.join(tmpdir(), "spire-e2e-bin-"));
  for (const binary of ["git", "which"]) {
    symlinkSync(execFileSync("which", [binary]).toString().trim(), path.join(shim, binary));
  }
  return shim;
}

/** Create a scratch git repository with one commit. */
function makeScratchRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "spire-e2e-repo-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "e2e@spire.test"]);
  git(["config", "user.name", "Spire E2E"]);
  writeFileSync(path.join(repo, "README.md"), "# scratch\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return repo;
}

/**
 * Launch the packaged app with an overridden PATH (used to hide opencode so
 * run prompts fail fast and deterministically). Mirrors fixtures.launchApp.
 */
async function launchAppWithPath(
  shimPath: string,
  options: SeedOptions = {},
): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "spire-e2e-"));
  const seedPath = writeSeedFixture(userDataDir, options);
  const app = await electron.launch({
    executablePath: EXECUTABLE,
    args: ["--no-sandbox", "--disable-gpu"],
    env: {
      ...process.env,
      PATH: shimPath,
      SPIRE_USER_DATA: userDataDir,
      SPIRE_SEED: seedPath,
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".workspace-shell, .onboarding-shell", {
    timeout: 30_000,
  });
  return {
    app,
    page,
    userDataDir,
    close: async () => {
      await app.close().catch(() => undefined);
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

function traceEvents(page: unknown): TraceEvent[] {
  return (page as { events: TraceEvent[] }).events;
}

/** Text of the first resource content item (resources here are text/JSON). */
function resourceText(result: unknown): string {
  const contents = (result as { contents: { text?: unknown }[] }).contents;
  const text = contents[0]?.text;
  if (typeof text !== "string") throw new Error("Expected a text resource.");
  return text;
}

let launched: LaunchedApp | undefined;
let session: McpSession | undefined;

test.afterEach(async () => {
  await session?.close();
  session = undefined;
  await launched?.close();
  launched = undefined;
});

test("enumerates every tool and resource against a running app", async () => {
  launched = await launchApp();
  await waitForControlSocket(launched.userDataDir);
  session = await connectSidecar(launched.userDataDir);

  // Inspector-equivalent enumeration: every control capability maps to
  // exactly one spire_* tool, and all of them are served.
  const { tools } = await session.client.listTools();
  const served = tools.map((tool) => tool.name).sort();
  const expected = Object.values(TOOL_NAMES).sort();
  expect(served).toEqual(expected);
  expect(Object.keys(TOOL_NAMES).sort()).toEqual(
    [...CONTROL_OPERATION_NAMES].sort(),
  );
  for (const tool of tools) {
    expect(tool.description, `${tool.name} description`).toBeTruthy();
  }

  const { resources } = await session.client.listResources();
  expect(resources.map((resource) => resource.uri)).toContain("spire://state");

  const { resourceTemplates } = await session.client.listResourceTemplates();
  expect(resourceTemplates.map((template) => template.uriTemplate).sort())
    .toEqual([
      "spire://graphs/{graphId}",
      "spire://runs/{runId}",
      "spire://runs/{runId}/artifacts",
      "spire://traces/{runId}",
    ]);

  // The state resource serves the live snapshot.
  const state = await session.client.readResource({ uri: "spire://state" });
  const snapshot = JSON.parse(resourceText(state)) as {
    graphs: { id: string }[];
    runs: unknown[];
  };
  expect(snapshot.graphs.map((graph) => graph.id)).toContain("graph-alpha");
  expect(snapshot.runs).toEqual([]);
});

test("performs the graph lifecycle over MCP", async () => {
  launched = await launchApp();
  await waitForControlSocket(launched.userDataDir);
  session = await connectSidecar(launched.userDataDir);

  const state = await callTool(session, "spire_state_get");
  expect(state.isError).toBeFalsy();
  expect(
    (state.structuredContent!.graphs as { id: string }[]).map((g) => g.id),
  ).toContain("graph-alpha");

  const diagnostics = await callTool(session, "spire_diagnostics_get");
  expect(diagnostics.isError).toBeFalsy();
  expect(diagnostics.structuredContent!.graphCount).toBe(1);

  const list = await callTool(session, "spire_graphs_list");
  expect(list.isError).toBeFalsy();

  const got = await callTool(session, "spire_graphs_get", {
    graphId: "graph-alpha",
  });
  expect(got.isError).toBeFalsy();
  const graph = got.structuredContent as unknown as { name: string; version: number };

  // Save a modified graph: the version bumps and the read-back sees it.
  const renamed = { ...(graph as object), name: "Renamed by MCP" };
  const saved = await callTool(session, "spire_graphs_save", { graph: renamed });
  expect(saved.isError).toBeFalsy();
  expect(saved.structuredContent!.name).toBe("Renamed by MCP");
  expect(saved.structuredContent!.version).toBe(graph.version + 1);

  const reread = await callTool(session, "spire_graphs_get", {
    graphId: "graph-alpha",
  });
  expect(reread.structuredContent!.name).toBe("Renamed by MCP");

  const resource = await session.client.readResource({
    uri: "spire://graphs/graph-alpha",
  });
  const fromResource = JSON.parse(resourceText(resource)) as {
    name: string;
  };
  expect(fromResource.name).toBe("Renamed by MCP");

  const validation = await callTool(session, "spire_repositories_validate", {
    path: "/definitely/not/a/repo",
  });
  expect(validation.isError).toBeFalsy();
  expect(validation.structuredContent!.ok).toBe(false);
});

test("drives a full run lifecycle: start, traces, stop, retry, artifacts, cleanup", async () => {
  test.setTimeout(180_000);
  const shim = makePathShim();
  const repo = makeScratchRepo();
  try {
    launched = await launchAppWithPath(shim, {
      graphsV2: [seedGraph("graph-alpha", "Build & Review")],
    });
    await waitForControlSocket(launched.userDataDir);
    session = await connectSidecar(launched.userDataDir);

    const got = await callTool(session, "spire_graphs_get", {
      graphId: "graph-alpha",
    });
    const graph = got.structuredContent as Record<string, unknown>;

    // Start a run. The goal embeds a fake API key so the trace assertions
    // below prove the journal redacts secrets before anything leaves the app.
    const started = await callTool(session, "spire_runs_start", {
      graph,
      repositoryPath: repo,
      goal: `Add retry backoff to the runner (fixture key ${FAKE_SECRET})`,
    });
    expect(started.isError, started.content[0]?.text).toBeFalsy();
    const runId = started.structuredContent!.id as string;
    expect(started.structuredContent!.status).toBe("preparing");

    // The run fails fast: the shimmed PATH hides opencode, so the harness
    // cannot prompt. The worktree was already prepared for real.
    const failed = await waitFor(async () => {
      const result = await callTool(session!, "spire_runs_get", { runId });
      return result.structuredContent!.status === "failed"
        ? result.structuredContent!
        : undefined;
    }, "the run to fail without OpenCode");
    expect(String(failed.error)).toContain("OpenCode");

    // The run resource agrees with the tool.
    const runResource = await session.client.readResource({
      uri: `spire://runs/${runId}`,
    });
    const runFromResource = JSON.parse(
      resourceText(runResource),
    ) as { status: string };
    expect(runFromResource.status).toBe("failed");

    // Trace journal: the control operations are journaled and redacted.
    const traces = await callTool(session, "spire_traces_query", { runId });
    expect(traces.isError).toBeFalsy();
    const events = traceEvents(traces.structuredContent);
    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(FAKE_SECRET);
    expect(serialized).toContain("[REDACTED]");
    expect(events.some((event) => event.kind === "control.start")).toBe(true);

    // Tail from the beginning returns the same journal via the cursor API.
    const tail = await callTool(session, "spire_traces_tail", {
      afterSequence: 0,
    });
    expect(traceEvents(tail.structuredContent).length).toBeGreaterThan(0);

    // The per-run trace resource serves the same redacted journal.
    const traceResource = await session.client.readResource({
      uri: `spire://traces/${runId}`,
    });
    expect(resourceText(traceResource)).not.toContain(FAKE_SECRET);

    // Live trace attachment: the sidecar forwards journal events as MCP
    // logging notifications while we operate.
    await waitFor(
      async () => (session!.logs.length > 0 ? true : undefined),
      "live trace logging notifications",
    );
    const note = session.logs[0];
    expect(note.params.logger).toBe("spire");
    expect(JSON.stringify(note.params.data)).not.toContain(FAKE_SECRET);

    // Stop, then retry (which fails again without OpenCode), then inspect
    // artifacts and clean the managed worktree.
    const stopped = await callTool(session, "spire_runs_stop", { runId });
    expect(stopped.isError).toBeFalsy();
    expect(stopped.structuredContent!.status).toBe("stopped");

    const retried = await callTool(session, "spire_runs_retry", { runId });
    expect(retried.isError).toBeFalsy();
    await waitFor(async () => {
      const result = await callTool(session!, "spire_runs_get", { runId });
      return result.structuredContent!.status === "failed"
        ? result.structuredContent!
        : undefined;
    }, "the retried run to fail again");

    const artifacts = await callTool(session, "spire_run_artifacts_get", {
      runId,
    });
    expect(artifacts.isError).toBeFalsy();
    const worktreePath = artifacts.structuredContent!.worktreePath as string;
    expect(worktreePath).toContain(
      path.join(launched.userDataDir, "worktrees"),
    );
    expect(existsSync(worktreePath)).toBe(true);

    const artifactsResource = await session.client.readResource({
      uri: `spire://runs/${runId}/artifacts`,
    });
    expect(resourceText(artifactsResource)).toContain(
      worktreePath,
    );

    const cleaned = await callTool(session, "spire_worktrees_cleanup", {
      runId,
    });
    expect(cleaned.isError, cleaned.content[0]?.text).toBeFalsy();
    expect(
      (cleaned.structuredContent!.artifacts as { worktreePath: string })
        .worktreePath,
    ).toBe("");
    expect(existsSync(worktreePath)).toBe(false);

    // A reconnecting client sees the full journaled history (live
    // attachment re-established on a fresh sidecar).
    const second = await connectSidecar(launched.userDataDir);
    try {
      const history = await callTool(second, "spire_traces_query", { runId });
      expect(traceEvents(history.structuredContent).length).toBeGreaterThan(0);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(shim, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rejects an invalid token and protects the token file", async () => {
  launched = await launchApp();
  const { socketPath, tokenPath } = await waitForControlSocket(
    launched.userDataDir,
  );

  // The token file is owner-only.
  expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

  // A frame with a wrong token is rejected and the connection is closed.
  const rejection = await new Promise<{ frames: unknown[]; closed: boolean }>(
    (resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const frames: unknown[] = [];
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Timed out waiting for the auth rejection"));
      }, 10_000);
      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({ type: "ping", id: "bad-1", token: "wrong-token" })}\n`,
        );
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          frames.push(JSON.parse(buffer.slice(0, newline)));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("close", () => {
        clearTimeout(timer);
        resolve({ frames, closed: true });
      });
      socket.on("error", () => undefined); // close follows
    },
  );
  expect(rejection.closed).toBe(true);
  expect(rejection.frames).toEqual([
    { type: "response", id: "bad-1", ok: false, error: "unauthenticated" },
  ]);

  // The real token still works, and the app was unaffected by the probe.
  const token = readFileSync(tokenPath, "utf8").trim();
  const pong = await new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for pong"));
    }, 10_000);
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ type: "ping", id: "ok-1", token })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      clearTimeout(timer);
      const line = chunk.toString().split("\n")[0];
      socket.destroy();
      resolve(JSON.parse(line));
    });
    socket.on("error", reject);
  });
  expect(pong).toMatchObject({ type: "response", id: "ok-1", ok: true });
});

test("fails with an actionable error when the app is not running", async () => {
  const emptyUserData = mkdtempSync(path.join(tmpdir(), "spire-e2e-absent-"));
  try {
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [MCP_ENTRY], {
        env: { PATH: process.env.PATH ?? "", SPIRE_USER_DATA: emptyUserData },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Sidecar did not exit against an absent app"));
      }, 20_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    const expectedSocket = path.join(
      emptyUserData,
      "control",
      "control.sock",
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Spire is not running");
    expect(result.stderr).toContain(expectedSocket);
    expect(result.stderr).toContain("pnpm start");
    // stdout is the MCP transport: it must stay clean JSON-RPC (empty here).
    expect(result.stdout).toBe("");
  } finally {
    rmSync(emptyUserData, { recursive: true, force: true });
  }
});
