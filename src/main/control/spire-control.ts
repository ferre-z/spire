import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  CONTROL_CAPABILITIES,
  type ControlContext,
  type ControlOperationMap,
  type ControlOperationName,
  type Diagnostics,
  type GraphPage,
  type GraphRef,
  type HarnessStatus,
  type PageInput,
  type RepositoryValidation,
  type RunPage,
  type RunQuery,
} from "../../shared/control";
import type {
  AppSnapshot,
  GraphDefinition,
  ModelOption,
  OpenCodeStatus,
  ProviderInput,
  RunArtifacts,
  RunRecord,
  StartRunInput,
  UpdateGraphInput,
} from "../../shared/domain";
import type { TraceCursor, TraceFilter, TraceListener, TracePage } from "../../shared/trace";
import type { JsonValue, WorkspaceLayoutRecord } from "../../shared/workspace";
import { validateWorkspaceLayoutRecord } from "../../shared/workspace";
import type { SpireDatabase } from "../database";
import type { AgentHarness } from "../opencode";
import type { RunEngine } from "../run-engine";
import type { TraceJournal } from "../trace-journal";
import type { ExecutionBackend } from "../worktree";
import { createControlRegistry, type ControlRegistry } from "./capabilities";

/**
 * Headless control plane for Spire.
 *
 * `SpireControl` owns all app behavior behind the `ControlOperationMap`
 * contract. The Electron IPC adapter and the MCP stdio sidecar both call
 * `execute()`; every execution validates input, records start/success/failure
 * trace events under one generated correlation id (raw payloads go to the
 * trace journal, the single redaction path), validates output, and returns
 * typed data. It contains no Electron imports — native dialogs and window
 * management stay in the adapter layer.
 */

export type SpireControlEnvironment = {
  appVersion: string;
  platform: string;
  isWayland: boolean;
};

export type SpireControlDeps = {
  database: SpireDatabase;
  engine: RunEngine;
  harness: AgentHarness;
  backend: ExecutionBackend;
  journal: TraceJournal;
  environment?: SpireControlEnvironment;
};

const TRACE_SUBSYSTEM = "control";

function defaultEnvironment(): SpireControlEnvironment {
  return {
    // The Electron adapter (a later task) injects app.getVersion(); outside
    // the packaged app fall back to the npm lifecycle version or a placeholder.
    appVersion: process.env.npm_package_version ?? "0.0.0",
    platform: process.platform,
    isWayland:
      process.env.XDG_SESSION_TYPE === "wayland" ||
      Boolean(process.env.WAYLAND_DISPLAY),
  };
}

/** Run id carried by run-scoped operation inputs, when present. */
function inputRunId(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "runId" in input) {
    const value = (input as { runId?: unknown }).runId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Run id of a RunRecord-shaped operation output (e.g. runs.start). */
function outputRunId(output: unknown): string | undefined {
  if (
    typeof output === "object" &&
    output !== null &&
    "id" in output &&
    "graphId" in output
  ) {
    const value = (output as { id?: unknown }).id;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Normalize a payload to the JSON domain (drops `undefined` properties, which
 * the trace journal's `jsonValueSchema` rejects). This is not redaction — the
 * journal remains the only redaction path.
 */
function toJsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return String(value);
  }
}

function parseCursor(cursor: string | undefined): number {  if (cursor === undefined) return 0;
  const offset = Number.parseInt(cursor, 10);
  if (!Number.isInteger(offset) || offset < 0 || String(offset) !== cursor) {
    throw new Error("Invalid cursor.");
  }
  return offset;
}

function page<T>(
  items: T[],
  offset: number,
  limit: number | undefined,
): { items: T[]; nextCursor: string | null } {
  const effectiveLimit = limit ?? Math.max(items.length - offset, 0);
  const slice = items.slice(offset, offset + effectiveLimit);
  const nextOffset = offset + slice.length;
  return {
    items: slice,
    nextCursor: nextOffset < items.length ? String(nextOffset) : null,
  };
}

export class SpireControl {
  private readonly registry: ControlRegistry = createControlRegistry(this);
  private readonly environment: SpireControlEnvironment;
  private openCodeStatus: OpenCodeStatus = {
    installed: false,
    compatible: false,
    connected: false,
  };
  private modelsCache: ModelOption[] = [];

  constructor(private readonly deps: SpireControlDeps) {
    this.environment = deps.environment ?? defaultEnvironment();
  }

  /**
   * Execute a control operation: validate input, trace start/success/failure
   * under one correlation id, validate output, return typed data.
   *
   * Synchronous failures (invalid input, a sync handler throwing) throw
   * synchronously rather than returning a rejected promise, so fire-and-forget
   * IPC callers that do not await still surface validation errors. Async
   * handler failures reject the returned promise.
   */
  execute<Name extends ControlOperationName>(
    name: Name,
    rawInput?: unknown,
    context: Partial<ControlContext> = {},
  ): Promise<ControlOperationMap[Name]["output"]> {
    const operation: ControlRegistry[Name] = this.registry[name];
    const correlationId = context.correlationId ?? randomUUID();
    const input = rawInput ?? {};
    const runId = inputRunId(input);

    // Record the failure event, then rethrow via `throw` at each call site so
    // TypeScript's definite-assignment analysis sees the never-fall-through.
    const recordFailure = (error: unknown): unknown => {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.journal.append({
        correlationId,
        runId,
        kind: "control.failure",
        level: "error",
        subsystem: TRACE_SUBSYSTEM,
        message: `${name} failed: ${message}`,
        payload: { input: toJsonValue(input), error: message },
      });
      return error;
    };

    this.deps.journal.append({
      correlationId,
      runId,
      kind: "control.start",
      level: "info",
      subsystem: TRACE_SUBSYSTEM,
      message: `${name} started`,
      payload: { input: toJsonValue(input) },
    });

    let parsed: ControlOperationMap[Name]["input"];
    try {
      parsed = operation.inputSchema.parse(input);
    } catch (error) {
      throw recordFailure(error);
    }

    let output: Awaited<ReturnType<ControlRegistry[Name]["handler"]>>;
    try {
      output = operation.handler(parsed) as typeof output;
    } catch (error) {
      throw recordFailure(error);
    }

    return Promise.resolve(output).then((resolved) => {
      let validated: ControlOperationMap[Name]["output"];
      try {
        validated = operation.outputSchema.parse(resolved);
      } catch (error) {
        throw recordFailure(error);
      }
      this.deps.journal.append({
        correlationId,
        runId: runId ?? outputRunId(validated),
        kind: "control.success",
        level: "info",
        subsystem: TRACE_SUBSYSTEM,
        message: `${name} succeeded`,
        payload: { output: toJsonValue(validated) },
      });
      return validated;
    });
  }

  /** Subscribe to live trace events from the journal. */
  subscribe(listener: TraceListener): () => void {
    return this.deps.journal.subscribe(listener);
  }

  /** The capability registry shared with IPC and MCP adapters. */
  listCapabilities(): typeof CONTROL_CAPABILITIES {
    return CONTROL_CAPABILITIES;
  }

  // --- Facade support (not control operations) ---------------------------

  /** The renderer-facing snapshot; also the `state.get` handler body. */
  snapshot(): AppSnapshot {
    return {
      onboardingComplete:
        this.deps.database.getSetting("onboardingComplete") === "true",
      openCode: this.openCodeStatus,
      models: this.modelsCache,
      graphs: this.deps.database.listGraphs(),
      runs: this.deps.database.listRuns(),
      activeRunId: this.deps.engine.activeId,
    };
  }

  async detectOpenCode(): Promise<AppSnapshot> {
    this.openCodeStatus = await this.deps.harness.detect();
    return this.snapshot();
  }

  async connectOpenRouter(input: ProviderInput): Promise<AppSnapshot> {
    if (!input.apiKey.trim()) throw new Error("OpenRouter API key is required.");
    await this.deps.harness.connectOpenRouter(input.apiKey.trim());
    this.modelsCache = await this.deps.harness.models();
    if (this.modelsCache.length === 0) {
      throw new Error("OpenRouter connected, but no models were returned.");
    }
    this.openCodeStatus = {
      ...(await this.deps.harness.detect()),
      connected: true,
    };
    this.deps.database.setSetting("onboardingComplete", "true");
    if (this.deps.database.listGraphs().length === 0) {
      this.deps.database.saveGraph(this.defaultGraph(this.modelsCache[0].id));
    }
    return this.snapshot();
  }

  /** Synchronous run lookup for the IPC export flow. */
  getRun(runId: string): RunRecord | undefined {
    return this.deps.database.getRun(runId);
  }

  // --- Operation handlers (bound once in capabilities.ts) ----------------

  handleStateGet(): AppSnapshot {
    return this.snapshot();
  }

  handleDiagnosticsGet(): Diagnostics {
    return {
      appVersion: this.environment.appVersion,
      platform: this.environment.platform,
      isWayland: this.environment.isWayland,
      openCode: this.openCodeStatus,
      graphCount: this.deps.database.listGraphs().length,
      runCount: this.deps.database.listRuns().length,
    };
  }

  handleGraphsList(input: PageInput): GraphPage {
    const result = page(
      this.deps.database.listGraphs(),
      parseCursor(input.cursor),
      input.limit,
    );
    return { graphs: result.items, nextCursor: result.nextCursor };
  }

  handleGraphsGet(input: GraphRef): GraphDefinition {
    const versions = this.deps.database
      .listGraphs()
      .filter((item) => item.id === input.graphId);
    if (versions.length === 0) throw new Error("Graph not found.");
    if (input.version !== undefined) {
      const pinned = versions.find((item) => item.version === input.version);
      if (!pinned) throw new Error("Graph not found.");
      return pinned;
    }
    return versions.reduce((latest, item) =>
      item.version > latest.version ? item : latest,
    );
  }

  handleGraphsSave(input: UpdateGraphInput): GraphDefinition {
    const parsed = input.graph;
    const existing = this.deps.database
      .listGraphs()
      .filter((item) => item.id === parsed.id);
    const highestVersion = Math.max(0, ...existing.map((item) => item.version));
    const changed = existing.find((item) => item.version === parsed.version);
    const version = changed ? highestVersion + 1 : parsed.version;
    const saved: GraphDefinition = {
      ...parsed,
      version,
      createdAt: new Date().toISOString(),
    };
    this.deps.database.saveGraph(saved);
    return saved;
  }

  async handleRepositoriesValidate(input: {
    path: string;
  }): Promise<RepositoryValidation> {
    try {
      await access(input.path);
    } catch {
      return { path: input.path, ok: false, reason: "Path is not accessible." };
    }
    try {
      await access(path.join(input.path, ".git"));
    } catch {
      return {
        path: input.path,
        ok: false,
        reason: "Path is not a Git repository.",
      };
    }
    return { path: input.path, ok: true };
  }

  handleRunsList(query: RunQuery): RunPage {
    let runs = this.deps.database.listRuns();
    if (query.graphId !== undefined) {
      runs = runs.filter((run) => run.graphId === query.graphId);
    }
    if (query.repositoryPath !== undefined) {
      runs = runs.filter((run) => run.repositoryPath === query.repositoryPath);
    }
    if (query.status !== undefined) {
      runs = runs.filter((run) => run.status === query.status);
    }
    const result = page(runs, parseCursor(query.cursor), query.limit);
    return { runs: result.items, nextCursor: result.nextCursor };
  }

  handleRunsGet(input: { runId: string }): RunRecord {
    return this.requireRun(input.runId);
  }

  async handleRunsStart(input: StartRunInput): Promise<RunRecord> {
    const goal = input.goal.trim();
    if (!goal) throw new Error("A coding goal is required.");
    const repository = await this.handleRepositoriesValidate({
      path: input.repositoryPath,
    });
    if (!repository.ok) {
      throw new Error(repository.reason ?? "Repository is not accessible.");
    }
    return this.deps.engine.start({ ...input, goal });
  }

  async handleRunsStop(input: { runId: string }): Promise<RunRecord> {
    await this.deps.engine.stop(input.runId);
    return this.requireRun(input.runId);
  }

  handleRunsRetry(input: { runId: string }): Promise<RunRecord> {
    return this.deps.engine.retry(input.runId);
  }

  handleRunsArtifactsGet(input: { runId: string }): RunArtifacts {
    const run = this.requireRun(input.runId);
    if (!run.artifacts) {
      throw new Error("No artifacts are available for this run.");
    }
    return run.artifacts;
  }

  async handleWorktreesCleanup(input: { runId: string }): Promise<RunRecord> {
    const run = this.requireRun(input.runId);
    if (!run.artifacts?.worktreePath) throw new Error("Worktree not found.");
    await this.deps.backend.cleanup(
      run.artifacts.worktreePath,
      run.repositoryPath,
    );
    run.artifacts.worktreePath = "";
    this.deps.database.saveRun(run);
    return run;
  }

  handleLayoutsList(input: { graphId: string }): WorkspaceLayoutRecord[] {
    return this.deps.database.listWorkspaceLayouts(input.graphId);
  }

  handleLayoutsSave(input: WorkspaceLayoutRecord): { saved: true } {
    const validation = validateWorkspaceLayoutRecord(input);
    if (!validation.ok) {
      throw new Error(`Workspace layout rejected: ${validation.reason}`);
    }
    this.deps.database.saveWorkspaceLayout(validation.record);
    return { saved: true };
  }

  handleLayoutsReset(input: { graphId: string }): { reset: true } {
    this.deps.database.resetWorkspaceLayouts(input.graphId);
    return { reset: true };
  }

  async handleHarnessesList(): Promise<HarnessStatus[]> {
    this.openCodeStatus = await this.deps.harness.detect();
    return [{ id: "opencode", name: "OpenCode", status: this.openCodeStatus }];
  }

  async handleHarnessesModels(input: {
    harnessId: string;
  }): Promise<ModelOption[]> {
    if (input.harnessId !== "opencode") {
      throw new Error(`Unknown harness: ${input.harnessId}.`);
    }
    this.modelsCache = await this.deps.harness.models();
    return this.modelsCache;
  }

  handleTracesQuery(input: TraceFilter): TracePage {
    return this.deps.journal.query(input);
  }

  handleTracesTail(input: TraceCursor): TracePage {
    return this.deps.journal.query({ cursor: input });
  }

  // --- Internals -----------------------------------------------------------

  private requireRun(runId: string): RunRecord {
    const run = this.deps.database.getRun(runId);
    if (!run) throw new Error("Run not found.");
    return run;
  }

  private defaultGraph(model: string): GraphDefinition {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      name: "Build & Review",
      version: 1,
      maxIterations: 3,
      createdAt: now,
      nodes: [
        {
          id: "planner",
          type: "opencode",
          role: "planner",
          name: "Architect",
          model,
          instructions:
            "Turn coding goals into focused implementation briefs, then review the result with high standards.",
          position: { x: 160, y: 190 },
        },
        {
          id: "implementer",
          type: "opencode",
          role: "implementer",
          name: "Builder",
          model,
          instructions:
            "Implement the brief carefully, keep changes scoped, and validate the result before reporting.",
          position: { x: 570, y: 190 },
        },
      ],
      edges: [
        {
          id: "plan-build",
          source: "planner",
          target: "implementer",
          condition: "always",
          label: "task brief",
        },
        {
          id: "build-review",
          source: "implementer",
          target: "planner",
          condition: "always",
          label: "review",
        },
        {
          id: "revise",
          source: "planner",
          target: "implementer",
          condition: "needs_changes",
          label: "revise",
        },
      ],
    };
  }
}
