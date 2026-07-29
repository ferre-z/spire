import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

import { dialog, ipcMain, shell } from "electron";
import { IPC } from "../shared/api";
import type { ControlOperationName } from "../shared/control";
import type {
  GraphDefinition,
  OpenCodeStatus,
  RunRecord,
} from "../shared/domain";
import type { TraceEvent } from "../shared/trace";
import {
  WORKSPACE_LAYOUT_SCHEMA_VERSION,
  type WorkspaceLayoutRecord,
} from "../shared/workspace";
import { SpireControl } from "./control/spire-control";
import { SpireDatabase } from "./database";
import { registerIpc } from "./ipc";
import type {
  AgentHarness,
  HarnessPrompt,
  HarnessResponse,
} from "./opencode";
import { RunEngine } from "./run-engine";
import type { ExecutionBackend, PreparedWorkspace } from "./worktree";

class FakeHarness implements AgentHarness {
  private index = 0;
  modelsResult = [{ id: "openrouter/test-model", name: "Test Model" }];
  detectResult: OpenCodeStatus = {
    installed: true,
    binaryPath: "/usr/bin/opencode",
    version: "1.0.0",
    compatible: true,
    connected: true,
  };
  connectedApiKey?: string;

  constructor(private readonly answers: string[] = []) {}

  async detect(): Promise<OpenCodeStatus> {
    return this.detectResult;
  }
  async connectOpenRouter(apiKey: string): Promise<void> {
    this.connectedApiKey = apiKey;
  }
  async models() {
    return this.modelsResult;
  }
  async prompt(input: HarnessPrompt): Promise<HarnessResponse> {
    input.onSession?.(input.sessionId ?? `session-${this.index}`);
    input.onEvent("tool", "fake tool completed");
    return {
      sessionId: input.sessionId ?? `session-${this.index}`,
      text: this.answers[this.index++] ?? "{}",
    };
  }
  async abort() {}
  close() {}
}

class FakeBackend implements ExecutionBackend {
  cleanupCalls: { workspacePath: string; repositoryPath: string }[] = [];

  async prepare(): Promise<PreparedWorkspace> {
    return {
      path: "/tmp/spire-fake-worktree",
      branch: "spire/test",
      dirtySource: false,
    };
  }
  async inspect() {
    return {
      diff: "+export const value = 1;",
      changedFiles: ["src/value.ts"],
    };
  }
  async cleanup(workspacePath: string, repositoryPath: string): Promise<void> {
    this.cleanupCalls.push({ workspacePath, repositoryPath });
  }
  async exportPatch() {}
}

function graph(id = "graph", version = 1): GraphDefinition {
  return {
    id,
    name: "Build",
    version,
    maxIterations: 3,
    createdAt: new Date().toISOString(),
    nodes: [
      {
        id: "planner",
        type: "opencode",
        role: "planner",
        name: "Architect",
        instructions: "Plan",
        model: "openrouter/test",
        position: { x: 0, y: 0 },
      },
      {
        id: "implementer",
        type: "opencode",
        role: "implementer",
        name: "Builder",
        instructions: "Build",
        model: "openrouter/test",
        position: { x: 200, y: 0 },
      },
    ],
    edges: [
      {
        id: "a",
        source: "planner",
        target: "implementer",
        condition: "always",
        label: "brief",
      },
      {
        id: "b",
        source: "implementer",
        target: "planner",
        condition: "always",
        label: "review",
      },
    ],
  };
}

const brief = JSON.stringify({
  goal: "Add value",
  constraints: [],
  acceptanceChecks: ["value exists"],
  implementationNotes: [],
});
const implementation = JSON.stringify({
  summary: "Added value",
  changedFiles: ["src/value.ts"],
  validations: [{ command: "pnpm test", status: "passed" }],
  blockers: [],
});
const accepted = JSON.stringify({
  decision: "accepted",
  evidence: ["value exists"],
  feedback: [],
});

function layoutRecord(graphId = "graph"): WorkspaceLayoutRecord {
  return {
    graphId,
    mode: "desktop",
    schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
    model: {
      layout: {
        type: "row",
        children: [
          {
            type: "tabset",
            children: [{ type: "tab", id: "tab-1", component: "graph" }],
          },
        ],
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    graphId: "graph",
    graphVersion: 1,
    repositoryPath: "/tmp/repo",
    goal: "goal",
    status: "succeeded",
    iteration: 1,
    startedAt: new Date().toISOString(),
    events: [],
    ...overrides,
  };
}

function createControl(answers: string[] = []) {
  const database = new SpireDatabase(":memory:");
  const journal = database.createTraceJournal();
  const harness = new FakeHarness(answers);
  const backend = new FakeBackend();
  const engine = new RunEngine(database, harness, backend, () => undefined);
  const control = new SpireControl({
    database,
    engine,
    harness,
    backend,
    journal,
    environment: { appVersion: "1.2.3-test", platform: "linux", isWayland: false },
  });
  return { control, database, journal, harness, backend, engine };
}

async function makeRepository(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "spire-ipc-repo-"));
  await writeFile(path.join(directory, ".git"), "gitdir: elsewhere", "utf8");
  return directory;
}

// --- ipcMain.handle capture -------------------------------------------------

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const handlers = new Map<string, IpcHandler>();
const handleMock = ipcMain.handle as unknown as Mock;
const openDialogMock = dialog.showOpenDialog as unknown as Mock;
const saveDialogMock = dialog.showSaveDialog as unknown as Mock;
const openExternalMock = shell.openExternal as unknown as Mock;
const openPathMock = shell.openPath as unknown as Mock;

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  handleMock.mockImplementation((channel: string, handler: IpcHandler) => {
    handlers.set(channel, handler);
  });
  openPathMock.mockResolvedValue("");
});

/** Mirrors Electron semantics: sync handler throws reject the invoke promise. */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({}, ...args);
}

function setup(answers: string[] = []) {
  const deps = createControl(answers);
  const executeSpy = vi.spyOn(deps.control, "execute");
  const unregister = registerIpc(deps.control, () => null);
  return { ...deps, executeSpy, unregister };
}

/** Capability names passed to control.execute since the last mockClear. */
function executedCapabilities(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map((call) => call[0] as ControlOperationName);
}

describe("IPC adapter: renderer operation → control capability mapping", () => {
  it("maps snapshot to state.get", async () => {
    const { executeSpy } = setup();
    const snapshot = (await invoke(IPC.snapshot)) as Record<string, unknown>;
    expect(executedCapabilities(executeSpy)).toEqual(["state.get"]);
    expect(snapshot).toMatchObject({
      onboardingComplete: false,
      graphs: [],
      runs: [],
    });
  });

  it("maps detectOpenCode to harnesses.list and returns a snapshot", async () => {
    const { executeSpy } = setup();
    const snapshot = (await invoke(IPC.detectOpenCode)) as Record<
      string,
      unknown
    >;
    expect(executedCapabilities(executeSpy)).toEqual(["harnesses.list"]);
    expect(snapshot).toMatchObject({
      openCode: { installed: true, connected: true },
    });
  });

  it("maps connectOpenRouter through SpireControl (no capability bypass)", async () => {
    const { control, harness, executeSpy } = setup();
    const connectSpy = vi.spyOn(control, "connectOpenRouter");
    const snapshot = (await invoke(IPC.connectOpenRouter, {
      apiKey: "  key-1 ",
    })) as Record<string, unknown>;
    expect(connectSpy).toHaveBeenCalledWith({ apiKey: "  key-1 " });
    expect(harness.connectedApiKey).toBe("key-1");
    expect(snapshot).toMatchObject({ onboardingComplete: true });
    // Onboarding is a composed facade flow; it must not dispatch a capability
    // under the renderer's feet.
    expect(executedCapabilities(executeSpy)).toEqual([]);
  });

  it("maps saveGraph to graphs.save and returns the updated snapshot", async () => {
    const { executeSpy } = setup();
    const snapshot = (await invoke(IPC.saveGraph, graph())) as Record<
      string,
      unknown
    >;
    expect(executedCapabilities(executeSpy)).toEqual(["graphs.save"]);
    expect(executeSpy).toHaveBeenCalledWith("graphs.save", {
      graph: expect.objectContaining({ id: "graph" }),
    });
    expect(snapshot).toMatchObject({ graphs: [expect.objectContaining({ id: "graph" })] });
  });

  it("maps startRun/stopRun to runs.start/runs.stop with snapshots", async () => {
    const { executeSpy } = setup([brief, implementation, accepted]);
    const repositoryPath = await makeRepository();
    const started = (await invoke(IPC.startRun, {
      graph: graph(),
      repositoryPath,
      goal: "Add value",
    })) as { activeRunId?: string };
    expect(started.activeRunId).toBeDefined();
    const stopped = (await invoke(IPC.stopRun, started.activeRunId)) as Record<
      string,
      unknown
    >;
    expect(stopped).toMatchObject({ onboardingComplete: false });
    expect(executedCapabilities(executeSpy)).toEqual([
      "runs.start",
      "runs.stop",
    ]);
  });

  it("maps retryRun to runs.retry", async () => {
    const { database, executeSpy } = setup([brief, implementation, accepted]);
    database.saveGraph(graph());
    database.saveRun(
      runRecord({
        status: "stopped",
        artifacts: {
          diff: "+x",
          changedFiles: ["x.ts"],
          worktreePath: "/tmp/spire-fake-worktree",
          branch: "spire/test",
        },
      }),
    );
    const snapshot = (await invoke(IPC.retryRun, "run-1")) as {
      activeRunId?: string;
    };
    expect(snapshot.activeRunId).toBe("run-1");
    expect(executedCapabilities(executeSpy)).toEqual(["runs.retry"]);
  });

  it("maps cleanupWorktree to worktrees.cleanup", async () => {
    const { database, backend, executeSpy } = setup();
    database.saveRun(
      runRecord({
        artifacts: {
          diff: "+x",
          changedFiles: ["x.ts"],
          worktreePath: "/tmp/spire-fake-worktree",
          branch: "spire/test",
        },
      }),
    );
    await invoke(IPC.cleanupWorktree, "run-1");
    expect(executedCapabilities(executeSpy)).toEqual(["worktrees.cleanup"]);
    expect(backend.cleanupCalls).toEqual([
      { workspacePath: "/tmp/spire-fake-worktree", repositoryPath: "/tmp/repo" },
    ]);
  });

  it("maps workspace layout operations to layouts.* capabilities", async () => {
    const { executeSpy } = setup();
    await invoke(IPC.saveWorkspaceLayout, layoutRecord("g"));
    const layouts = await invoke(IPC.loadWorkspaceLayouts, "g");
    expect(layouts).toHaveLength(1);
    await invoke(IPC.resetWorkspaceLayouts, "g");
    expect(await invoke(IPC.loadWorkspaceLayouts, "g")).toHaveLength(0);
    expect(executedCapabilities(executeSpy)).toEqual([
      "layouts.save",
      "layouts.list",
      "layouts.reset",
      "layouts.list",
    ]);
  });
});

describe("IPC adapter: malformed payloads are rejected", () => {
  it("rejects an invalid graph payload", async () => {
    setup();
    await expect(invoke(IPC.saveGraph, { id: 42 })).rejects.toThrow();
  });

  it("rejects an invalid startRun payload", async () => {
    setup();
    await expect(
      invoke(IPC.startRun, { repositoryPath: 123 }),
    ).rejects.toThrow();
  });

  it("rejects a non-string runId", async () => {
    setup();
    await expect(invoke(IPC.stopRun, 123)).rejects.toThrow();
    await expect(invoke(IPC.retryRun, null)).rejects.toThrow();
    await expect(invoke(IPC.cleanupWorktree, {})).rejects.toThrow();
  });

  it("rejects a non-string graphId", async () => {
    setup();
    await expect(invoke(IPC.loadWorkspaceLayouts, 42)).rejects.toThrow();
  });

  it("rejects an invalid workspace layout record", async () => {
    setup();
    await expect(
      invoke(IPC.saveWorkspaceLayout, {
        ...layoutRecord("g"),
        schemaVersion: 99,
      }),
    ).rejects.toThrow(/Workspace layout rejected/);
  });

  it("rejects a malformed OpenRouter input", async () => {
    setup();
    await expect(invoke(IPC.connectOpenRouter, {})).rejects.toThrow();
    await expect(
      invoke(IPC.connectOpenRouter, { apiKey: "   " }),
    ).rejects.toThrow(/api key/i);
  });
});

describe("IPC adapter: Electron-only concerns stay in IPC", () => {
  it("chooseRepository shows the native dialog, then repositories.validate", async () => {
    const { executeSpy } = setup();
    const repositoryPath = await makeRepository();
    openDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: [repositoryPath],
    });
    const chosen = await invoke(IPC.chooseRepository);
    expect(openDialogMock).toHaveBeenCalledOnce();
    expect(executedCapabilities(executeSpy)).toEqual(["repositories.validate"]);
    expect(chosen).toBe(repositoryPath);
  });

  it("chooseRepository returns null when canceled or not a Git repository", async () => {
    const { executeSpy } = setup();
    openDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await invoke(IPC.chooseRepository)).toBeNull();
    // Canceled dialogs never reach the control plane.
    expect(executedCapabilities(executeSpy)).toEqual([]);

    const notARepo = await mkdtemp(path.join(tmpdir(), "spire-ipc-notrepo-"));
    openDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: [notARepo],
    });
    expect(await invoke(IPC.chooseRepository)).toBeNull();
    expect(executedCapabilities(executeSpy)).toEqual(["repositories.validate"]);
  });

  it("exportPatch fetches runs.artifacts.get, then shows a save dialog", async () => {
    const { database, executeSpy } = setup();
    database.saveRun(
      runRecord({
        artifacts: {
          diff: "+export const value = 1;",
          changedFiles: ["src/value.ts"],
          worktreePath: "/tmp/spire-fake-worktree",
          branch: "spire/test",
        },
      }),
    );
    const target = path.join(
      await mkdtemp(path.join(tmpdir(), "spire-ipc-export-")),
      "out.patch",
    );
    saveDialogMock.mockResolvedValue({ canceled: false, filePath: target });
    const written = await invoke(IPC.exportPatch, "run-1");
    expect(executedCapabilities(executeSpy)).toEqual(["runs.artifacts.get"]);
    expect(saveDialogMock).toHaveBeenCalledOnce();
    expect(written).toBe(target);
    expect(await readFile(target, "utf8")).toBe("+export const value = 1;");
  });

  it("exportPatch returns null when the save dialog is canceled", async () => {
    const { database, executeSpy } = setup();
    database.saveRun(
      runRecord({
        artifacts: {
          diff: "+x",
          changedFiles: ["x.ts"],
          worktreePath: "/tmp/wt",
          branch: "b",
        },
      }),
    );
    saveDialogMock.mockResolvedValue({ canceled: true });
    expect(await invoke(IPC.exportPatch, "run-1")).toBeNull();
    expect(executedCapabilities(executeSpy)).toEqual(["runs.artifacts.get"]);
  });

  it("exportPatch rejects when the run has no artifacts", async () => {
    const { database } = setup();
    database.saveRun(runRecord());
    await expect(invoke(IPC.exportPatch, "run-1")).rejects.toThrow(
      /artifacts/i,
    );
    expect(saveDialogMock).not.toHaveBeenCalled();
  });

  it("openExternal keeps the opencode.ai https allowlist", async () => {
    setup();
    await invoke(IPC.openExternal, "https://opencode.ai/docs");
    expect(openExternalMock).toHaveBeenCalledWith("https://opencode.ai/docs");
    await expect(
      invoke(IPC.openExternal, "https://evil.example.com"),
    ).rejects.toThrow(/not allowed/i);
    await expect(invoke(IPC.openExternal, "http://opencode.ai")).rejects.toThrow(
      /not allowed/i,
    );
    expect(openExternalMock).toHaveBeenCalledOnce();
  });

  it("revealPath surfaces shell errors", async () => {
    setup();
    await invoke(IPC.revealPath, "/tmp/repo");
    expect(openPathMock).toHaveBeenCalledWith("/tmp/repo");
    openPathMock.mockResolvedValue("No such file");
    await expect(invoke(IPC.revealPath, "/missing")).rejects.toThrow(
      "No such file",
    );
  });

  it("environment reports the platform shape", async () => {
    setup();
    const environment = (await invoke(IPC.environment)) as Record<
      string,
      unknown
    >;
    expect(environment).toHaveProperty("platform");
    expect(environment).toHaveProperty("isWayland");
  });
});

describe("IPC adapter: trace notifications", () => {
  function fakeWindow() {
    return {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
  }

  it("forwards trace events through the dedicated allowlisted channel", async () => {
    const { control } = createControl();
    const window = fakeWindow();
    const unregister = registerIpc(
      control,
      () => window as unknown as Electron.BrowserWindow,
    );
    await invoke(IPC.snapshot);
    const sends = window.webContents.send.mock.calls.filter(
      ([channel]) => channel === IPC.traceEvent,
    );
    expect(sends.length).toBeGreaterThan(0);
    const event = sends[0][1] as TraceEvent;
    expect(event).toMatchObject({
      kind: "control.start",
      subsystem: "control",
    });
    unregister();
  });

  it("stops forwarding after unsubscribe and skips destroyed windows", async () => {
    const { control } = createControl();
    const window = fakeWindow();
    const getWindow = vi.fn(
      () => window as unknown as Electron.BrowserWindow,
    );
    const unregister = registerIpc(control, getWindow);
    unregister();
    await invoke(IPC.snapshot);
    expect(window.webContents.send).not.toHaveBeenCalled();

    const destroyed = {
      isDestroyed: () => true,
      webContents: { send: vi.fn() },
    };
    registerIpc(control, () => destroyed as unknown as Electron.BrowserWindow);
    await invoke(IPC.snapshot);
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });
});

describe("IPC adapter: no bypass of SpireControl", () => {
  const ipcSource = readFileSync(
    new URL("./ipc.ts", import.meta.url),
    "utf8",
  );
  const preloadSource = readFileSync(
    new URL("../preload/index.ts", import.meta.url),
    "utf8",
  );
  const controlSource = readFileSync(
    new URL("./control/spire-control.ts", import.meta.url),
    "utf8",
  );

  it("ipc.ts depends on SpireControl, not on AppService or infrastructure", () => {
    expect(ipcSource).toMatch(/SpireControl/);
    expect(ipcSource).not.toMatch(/app-service|AppService/);
    for (const infra of [
      "SpireDatabase",
      "RunEngine",
      "OpenCodeHarness",
      "LocalWorktreeBackend",
      "./database",
      "./run-engine",
      "./opencode",
      "./worktree",
    ]) {
      expect(ipcSource).not.toContain(infra);
    }
  });

  it("keeps native dialogs in the IPC layer, not in SpireControl", () => {
    expect(ipcSource).toMatch(/dialog\.showOpenDialog/);
    expect(ipcSource).toMatch(/dialog\.showSaveDialog/);
    expect(controlSource).not.toContain("electron");
  });

  it("keeps the preload surface narrow: only named IPC constants", () => {
    const invokes = preloadSource.match(/ipcRenderer\.invoke\(/g) ?? [];
    const named = preloadSource.match(/ipcRenderer\.invoke\(IPC\./g) ?? [];
    expect(invokes.length).toBeGreaterThan(0);
    expect(invokes.length).toBe(named.length);
    // No generic passthrough that would allow arbitrary channel invocation.
    expect(preloadSource).not.toMatch(/invoke\(\s*channel\b/);
    expect(preloadSource).not.toMatch(/ipcRenderer\.on\(\s*channel\b/);
    // Trace subscription is allowlisted by channel name.
    expect(preloadSource).toContain("ipcRenderer.on(IPC.traceEvent");
    expect(IPC.traceEvent).toBe("spire:trace-event");
  });
});
