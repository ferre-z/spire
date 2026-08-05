import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  LoggingMessageNotificationSchema,
  type LoggingMessageNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { expect, test } from "@playwright/test";
import { launchApp } from "./fixtures";
import { type FixtureHarnessConfig } from "./seed";
import type {
  AppliedPlanPatch,
  NodeExecution,
  NodeOutcome,
} from "../src/shared/execution";
import type {
  GraphDefinitionV2,
  HarnessId,
  RunRecord,
  StartRunInput,
} from "../src/shared/domain";
import type { PlanPatchInput } from "../src/shared/control";
import type { TraceEvent } from "../src/shared/trace";

const MCP_ENTRY = path.join(__dirname, "..", "mcp-dist", "mcp.js");

/** A fake API key embedded in fixture events to prove journal redaction. */
const SECRET = "sk-e2e-secret-abc123-def456-ghi789";

// ---------------------------------------------------------------------------
// MCP sidecar helpers (inlined so each spec is self-contained)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Generic test helpers
// ---------------------------------------------------------------------------

/** Poll an async probe until it returns a truthy value or times out. */
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  description: string,
  timeoutMs = 60_000,
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
    await new Promise((resolve) => setTimeout(resolve, 300));
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
    async () =>
      existsSync(socketPath) && existsSync(tokenPath) ? true : undefined,
    "the control socket",
  );
  return { socketPath, tokenPath };
}

/** Create a scratch git repository with one commit (for the run's working tree). */
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

/** Open the app's SQLite database in read-only mode. */
function openDb(userDataDir: string): Database.Database {
  return new Database(path.join(userDataDir, "spire.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
}

function runRow(db: Database.Database, runId: string): RunRecord {
  const row = db
    .prepare("SELECT json FROM runs WHERE id = ?")
    .get(runId) as { json: string } | undefined;
  expect(row, `run ${runId} should exist in runs table`).toBeDefined();
  return JSON.parse(row!.json) as RunRecord;
}

function nodeRows(db: Database.Database, runId: string): NodeExecution[] {
  const rows = db
    .prepare("SELECT json FROM node_executions WHERE run_id = ? ORDER BY node_id ASC")
    .all(runId) as { json: string }[];
  return rows.map((row) => JSON.parse(row.json) as NodeExecution);
}

function patchRows(
  db: Database.Database,
  runId: string,
): AppliedPlanPatch[] {
  const rows = db
    .prepare(
      "SELECT json FROM plan_patches WHERE run_id = ? ORDER BY applied_revision ASC",
    )
    .all(runId) as { json: string }[];
  return rows.map((row) => JSON.parse(row.json) as AppliedPlanPatch);
}

function traceEventPayloads(db: Database.Database, runId: string): string[] {
  return (
    db
      .prepare(
        "SELECT payload FROM trace_events WHERE run_id = ? ORDER BY sequence ASC",
      )
      .all(runId) as { payload: string | null }[]
  ).map((row) => row.payload ?? "");
}

function runRecordPayloads(db: Database.Database, runId: string): string[] {
  const record = runRow(db, runId);
  return record.events.map((event) =>
    event.payload ? JSON.stringify(event.payload) : "",
  );
}

/** Read every .md file under a directory (recursively) into { relativePath, content }. */
function readAllMarkdown(dir: string): { path: string; content: string }[] {
  const results: { path: string; content: string }[] = [];
  function walk(current: string) {
    if (!existsSync(current)) return;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        const rel = path.relative(dir, full);
        results.push({ path: rel, content: readFileSync(full, "utf8") });
      }
    }
  }
  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Graph + fixture builders
// ---------------------------------------------------------------------------

/**
 * 8-node corporate workflow graph: research → implement → review → gate →
 * checkpoint → (revise loop, unused) → deploy (retry) → finalize.
 *
 * Authoritates: n_deploy has graph-scoped `retry` authority; n_research has
 * self-scoped, no-actions authority (so any patch it proposes is rejected).
 */
function corporateGraph(): GraphDefinitionV2 {
  return {
    id: "corporate-workflow",
    name: "Corporate Workflow",
    version: 1,
    maxSteps: 100,
    createdAt: new Date().toISOString(),
    groups: [],
    nodes: [
      {
        kind: "agent",
        id: "n_research",
        name: "Research",
        roleLabel: "researcher",
        job: "Research the task and provide findings to the team.",
        harnessId: "opencode",
        modelId: "gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        thinkingEffort: "medium",
        skills: [],
        goal: "",
        subGoals: [],
        integrations: [],
        position: { x: 0, y: 0 },
      },
      {
        kind: "agent",
        id: "n_implement",
        name: "Implement",
        roleLabel: "implementer",
        job: "Implement the researched solution in the repository under src/.",
        harnessId: "codex",
        modelId: "gpt-5-codex",
        access: { mode: "workspace-write", writeScopes: ["src"] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        thinkingEffort: "medium",
        skills: [],
        goal: "",
        subGoals: [],
        integrations: [],
        position: { x: 200, y: 0 },
      },
      {
        kind: "agent",
        id: "n_review",
        name: "Review",
        roleLabel: "reviewer",
        job: "Review the implementation for correctness and quality.",
        harnessId: "claude-code",
        modelId: "gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        thinkingEffort: "medium",
        skills: [],
        goal: "",
        subGoals: [],
        integrations: [],
        position: { x: 400, y: 0 },
      },
      {
        kind: "decision",
        id: "n_gate",
        name: "Gate",
        roleLabel: "reviewer",
        job: "Decide whether to proceed to deployment or request revisions.",
        harnessId: "claude-code",
        modelId: "gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        thinkingEffort: "medium",
        skills: [],
        goal: "",
        subGoals: [],
        integrations: [],
        position: { x: 600, y: 0 },
      },
      {
        kind: "checkpoint",
        id: "n_checkpoint",
        name: "Checkpoint",
        mode: "automatic",
        position: { x: 600, y: 200 },
      },
      {
        kind: "agent",
        id: "n_revise",
        name: "Revise",
        roleLabel: "implementer",
        job: "Revise the implementation based on review feedback.",
        harnessId: "codex",
        modelId: "gpt-5-codex",
        access: { mode: "workspace-write", writeScopes: ["src"] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        thinkingEffort: "medium",
        skills: [],
        goal: "",
        subGoals: [],
        integrations: [],
        position: { x: 400, y: 200 },
      },
      {
        kind: "decision",
        id: "n_deploy",
        name: "Deploy",
        roleLabel: "deployer",
        job: "Deploy the application. On failure, retry once.",
        harnessId: "opencode",
        modelId: "gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "graph", actions: ["retry"] },
        activation: "all",
        maxVisits: 2,
        thinkingEffort: "medium",
        skills: [],
        goal: "",
        subGoals: [],
        integrations: [],
        position: { x: 800, y: 0 },
      },
      {
        kind: "agent",
        id: "n_finalize",
        name: "Finalize",
        roleLabel: "implementer",
        job: "Finalize and verify the deployment.",
        harnessId: "codex",
        modelId: "gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        thinkingEffort: "medium",
        skills: [],
        goal: "",
        subGoals: [],
        integrations: [],
        position: { x: 1000, y: 0 },
      },
    ],
    edges: [
      {
        id: "edge_research_implement",
        source: "n_research",
        target: "n_implement",
        kind: "handoff",
        when: "success",
        label: "Research findings",
      },
      {
        id: "edge_implement_review",
        source: "n_implement",
        target: "n_review",
        kind: "handoff",
        when: "success",
        label: "Implementation",
      },
      {
        id: "edge_review_gate",
        source: "n_review",
        target: "n_gate",
        kind: "review",
        when: "success",
        label: "Review complete",
      },
      {
        id: "edge_gate_checkpoint",
        source: "n_gate",
        target: "n_checkpoint",
        kind: "approval",
        when: "selected",
        label: "Proceed to deploy",
      },
      {
        id: "edge_gate_revise",
        source: "n_gate",
        target: "n_revise",
        kind: "escalation",
        when: "selected",
        label: "Needs revisions",
      },
      {
        id: "edge_revise_review",
        source: "n_revise",
        target: "n_review",
        kind: "handoff",
        when: "selected",
        label: "Revised implementation",
      },
      {
        id: "edge_checkpoint_deploy",
        source: "n_checkpoint",
        target: "n_deploy",
        kind: "handoff",
        when: "success",
        label: "Proceed to deploy",
      },
      {
        id: "edge_deploy_finalize",
        source: "n_deploy",
        target: "n_finalize",
        kind: "handoff",
        when: "selected",
        label: "Deployment succeeded",
      },
    ],
  };
}

/** Fixture harness configs for the corporate workflow, with the secret in n_research's tool_start event. */
function corporateFixtures(): Record<HarnessId, FixtureHarnessConfig> {
  return {
    opencode: {
      nodes: {
        n_research: [
          {
            output: {
              status: "succeeded" as const,
              summary:
                "Research complete: the auth login module needs a standard credential-check flow.",
              artifacts: [],
              messages: [
                {
                  recipient: { kind: "successors" as const },
                  kind: "handoff" as const,
                  subject: "Research findings",
                  body: "Initial research is complete. The task is to add an auth login module at src/auth/login.ts with a standard credential-check flow.",
                  artifactPaths: [],
                },
              ],
              selectedEdgeIds: [],
            } satisfies NodeOutcome,
            events: [
              {
                type: "tool_start" as const,
                tool: "shell",
                input: { api_key: SECRET, command: "echo researching" },
              },
            ],
          },
        ],
        n_deploy: [
          // Visit 0: fail and propose a retry patch.
          {
            output: {
              status: "failed" as const,
              summary:
                "Deployment failed on the first attempt due to a transient infrastructure error.",
              artifacts: [],
              messages: [
                {
                  recipient: { kind: "successors" as const },
                  kind: "report" as const,
                  subject: "Deploy attempt 1 failed",
                  body: "The first deployment attempt failed with a transient infrastructure error. Retrying.",
                  artifactPaths: [],
                },
              ],
              selectedEdgeIds: [],
              patch: {
                baseRevision: 0,
                reason: "Retry deployment after transient failure",
                operations: [
                  { action: "retry" as const, nodeId: "n_deploy" },
                ],
              },
            } satisfies NodeOutcome,
          },
          // Visit 1: succeed and route to finalize.
          {
            output: {
              status: "succeeded" as const,
              summary: "Deployment succeeded on the retry.",
              artifacts: [],
              messages: [],
              selectedEdgeIds: ["edge_deploy_finalize"],
            } satisfies NodeOutcome,
          },
        ],
      },
    },
    codex: {
      nodes: {
        n_implement: [
          {
            output: {
              status: "succeeded" as const,
              summary: "Implemented the auth login module at src/auth/login.ts.",
              artifacts: [
                {
                  name: "login",
                  path: "src/auth/login.ts",
                  mediaType: "text/x-typescript",
                },
              ],
              messages: [
                {
                  recipient: { kind: "successors" as const },
                  kind: "report" as const,
                  subject: "Implementation report",
                  body: "Implemented src/auth/login.ts with a standard credential-check flow.",
                  artifactPaths: ["src/auth/login.ts"],
                },
              ],
              selectedEdgeIds: [],
            } satisfies NodeOutcome,
            sideEffect: {
              writeFile: {
                path: "src/auth/login.ts",
                content: "// auth login module\nexport const login = () => {};\n",
              },
            },
          },
        ],
        n_finalize: [
          {
            output: {
              status: "succeeded" as const,
              summary: "Finalization complete: deployment verified.",
              artifacts: [],
              messages: [
                {
                  recipient: { kind: "successors" as const },
                  kind: "report" as const,
                  subject: "Finalization report",
                  body: "Deployment verified and finalized.",
                  artifactPaths: [],
                },
              ],
              selectedEdgeIds: [],
            } satisfies NodeOutcome,
          },
        ],
      },
    },
    "claude-code": {
      nodes: {
        n_review: [
          {
            output: {
              status: "succeeded" as const,
              summary: "Review passed with minor suggestions.",
              artifacts: [],
              messages: [
                {
                  recipient: { kind: "successors" as const },
                  kind: "handoff" as const,
                  subject: "Review findings",
                  body: "Code review passed. Minor suggestions for error handling.",
                  artifactPaths: [],
                },
              ],
              selectedEdgeIds: [],
            } satisfies NodeOutcome,
          },
        ],
        n_gate: [
          {
            output: {
              status: "succeeded" as const,
              summary: "Gate approved: proceed to deployment checkpoint.",
              artifacts: [],
              messages: [
                {
                  recipient: { kind: "successors" as const },
                  kind: "decision" as const,
                  subject: "Gate decision: proceed",
                  body: "Approved for deployment after review.",
                  artifactPaths: [],
                },
              ],
              selectedEdgeIds: ["edge_gate_checkpoint"],
            } satisfies NodeOutcome,
          },
        ],
      },
    },
  };
}

/** Corporate fixtures where n_implement writes out of its ["src"] scope. */
function scopeViolationFixtures(): Record<HarnessId, FixtureHarnessConfig> {
  const base = corporateFixtures();
  return {
    ...base,
    codex: {
      ...base.codex,
      nodes: {
        ...base.codex!.nodes,
        n_implement: [
          {
            output: {
              status: "succeeded" as const,
              summary: "Implemented documentation in docs/.",
              artifacts: [],
              messages: [],
              selectedEdgeIds: [],
            } satisfies NodeOutcome,
            sideEffect: {
              writeFile: {
                path: "docs/violation.md",
                content: "out of scope\n",
              },
            },
          },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal graph for the crash/resume test
// ---------------------------------------------------------------------------

/** 3-node graph: start → manual checkpoint → end. */
function restartGraph(): GraphDefinitionV2 {
  return {
    id: "restart-test",
    name: "Restart Test",
    version: 1,
    maxSteps: 100,
    createdAt: new Date().toISOString(),
    groups: [],
    nodes: [
      {
        kind: "agent",
        id: "n_start",
        name: "Start",
        job: "Begin the workflow.",
        harnessId: "opencode",
        modelId: "gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        thinkingEffort: "medium",
        skills: [],
        goal: "",
        subGoals: [],
        integrations: [],
        position: { x: 0, y: 0 },
      },
      {
        kind: "checkpoint",
        id: "n_manual_cp",
        name: "Manual Checkpoint",
        mode: "manual",
        position: { x: 200, y: 0 },
      },
      {
        kind: "agent",
        id: "n_end",
        name: "End",
        job: "Complete the workflow.",
        harnessId: "codex",
        modelId: "gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        thinkingEffort: "medium",
        skills: [],
        goal: "",
        subGoals: [],
        integrations: [],
        position: { x: 400, y: 0 },
      },
    ],
    edges: [
      {
        id: "e_start_cp",
        source: "n_start",
        target: "n_manual_cp",
        kind: "handoff",
        when: "success",
        label: "Proceed",
      },
      {
        id: "e_cp_end",
        source: "n_manual_cp",
        target: "n_end",
        kind: "handoff",
        when: "success",
        label: "Resume",
      },
    ],
  };
}

function restartFixtures(): Record<HarnessId, FixtureHarnessConfig> {
  return {
    opencode: {
      nodes: {
        n_start: [
          {
            output: {
              status: "succeeded" as const,
              summary: "Workflow started.",
              artifacts: [],
              messages: [],
              selectedEdgeIds: [],
            } satisfies NodeOutcome,
          },
        ],
      },
    },
    codex: {
      nodes: {
        n_end: [
          {
            output: {
              status: "succeeded" as const,
              summary: "Workflow completed.",
              artifacts: [],
              messages: [],
              selectedEdgeIds: [],
            } satisfies NodeOutcome,
          },
        ],
      },
    },
    "claude-code": { nodes: {} },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("graph-native corporate workflows", () => {
  test("completes a multi-harness workflow end to end", async () => {
    test.setTimeout(180_000);
    const repo = makeScratchRepo();
    const launched = await launchApp({
      harnessFixtures: corporateFixtures(),
    });
    try {
      await waitForControlSocket(launched.userDataDir);

      // Start the run with the corporate v2 graph.
      const snapshot = await launched.page.evaluate(async (input) => {
        return await window.spire.startRun(input);
      }, { graph: CORPORATE_GRAPH_REF, repositoryPath: repo, goal: "Build the auth login module." } as StartRunInput);
      const runId = snapshot.activeRunId!;
      expect(runId, "startRun should set an active run id").toBeTruthy();

      // Poll the plan until it reaches a terminal state.
      const plan = await waitFor(async () => {
        return await launched.page.evaluate(async (input) => {
          const plan = await window.spire.runsPlanGet(input.runId);
          return plan.status === "running" ? undefined : plan;
        }, { runId });
      }, "plan to reach terminal state");
      expect(plan.status).toBe("succeeded");

      // --- Verify node execution state via direct SQLite reads ---
      const db = openDb(launched.userDataDir);
      try {
        const nodes = nodeRows(db, runId!);
        const byId = new Map(nodes.map((n) => [n.nodeId, n]));

        // Every expected node exists.
        for (const id of [
          "n_research", "n_implement", "n_review", "n_gate",
          "n_checkpoint", "n_revise", "n_deploy", "n_finalize",
        ]) {
          expect(byId.has(id), `node ${id} should have a DB row`).toBe(true);
        }

        // Node statuses and visit counts.
        expect(byId.get("n_research")?.status).toBe("succeeded");
        expect(byId.get("n_research")?.visits).toBe(1);
        expect(byId.get("n_implement")?.status).toBe("succeeded");
        expect(byId.get("n_implement")?.visits).toBe(1);
        expect(byId.get("n_review")?.status).toBe("succeeded");
        expect(byId.get("n_revise")?.status).toBe("skipped");
        expect(byId.get("n_revise")?.visits).toBe(0);
        expect(byId.get("n_checkpoint")?.status).toBe("succeeded");
        expect(byId.get("n_deploy")?.status).toBe("succeeded");
        expect(byId.get("n_deploy")?.visits).toBe(2); // fail + retry
        expect(byId.get("n_finalize")?.status).toBe("succeeded");
        expect(byId.get("n_finalize")?.visits).toBe(1);
      } finally {
        db.close();
      }

      // --- Verify messages via the API ---
      const messagePage = await launched.page.evaluate(async (input) => {
        return await window.spire.runsMessagesList(input);
      }, { runId });
      expect(messagePage.messages.length).toBe(6);

      // --- Verify the retry patch is persisted ---
      const db2 = openDb(launched.userDataDir);
      try {
        const patches = patchRows(db2, runId!);
        expect(patches.length).toBe(1);
        expect(patches[0]!.actorNodeId).toBe("n_deploy");
        expect(patches[0]!.operations[0]).toMatchObject({
          action: "retry",
          nodeId: "n_deploy",
        });
      } finally {
        db2.close();
      }

      // --- Verify plan revision was bumped by the patch ---
      const finalPlan = await launched.page.evaluate(async (input) => {
        return await window.spire.runsPlanGet(input.runId);
      }, { runId });
      expect(finalPlan.revision).toBeGreaterThanOrEqual(1);
      expect(finalPlan.patches.length).toBe(1);
    } finally {
      await launched.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("resumes a paused checkpoint after crash", async () => {
    test.setTimeout(120_000);
    const repo = makeScratchRepo();
    let launched = await launchApp({
      harnessFixtures: restartFixtures(),
    });
    try {
      await waitForControlSocket(launched.userDataDir);

      // Start and run until the manual checkpoint pauses the plan.
      const snapshot = await launched.page.evaluate(async (input) => {
        return await window.spire.startRun(input);
      }, { graph: RESTART_GRAPH_REF, repositoryPath: repo, goal: "Test crash recovery." } as StartRunInput);
      const runId = snapshot.activeRunId!;
      expect(runId).toBeTruthy();

      const pausedPlan = await waitFor(async () => {
        return await launched.page.evaluate(async (input) => {
          const plan = await window.spire.runsPlanGet(input.runId);
          return plan.status === "paused" ? plan : undefined;
        }, { runId });
      }, "plan to pause at manual checkpoint");
      expect(pausedPlan.status).toBe("paused");

      // Crash the app WITHOUT deleting userDataDir (simulate a crash).
      // Use app.close() directly — NOT the launched.close() helper, which
      // would rm the userDataDir.
      const userDataDirBefore = launched.userDataDir;
      await launched.app.close();

      // Relaunch reusing the same userDataDir (DB preserved, run still paused).
      launched = await launchApp(
        { harnessFixtures: restartFixtures() },
        { userDataDir: userDataDirBefore },
      );
      try {
        await waitForControlSocket(launched.userDataDir);
        // The seed fixture is re-applied (harness fixtures reloaded); the
        // existing paused run is preserved.
        expect(launched.userDataDir).toBe(userDataDirBefore);

        // Verify the run is still paused in the DB.
        const db = openDb(launched.userDataDir);
        try {
          const nodes = nodeRows(db, runId!);
          const byId = new Map(nodes.map((n) => [n.nodeId, n]));
          expect(byId.get("n_start")?.status).toBe("succeeded");
          expect(byId.get("n_manual_cp")?.status).toBe("succeeded");
          expect(byId.get("n_end")?.status).toBe("waiting");
        } finally {
          db.close();
        }

        // Resume from the manual checkpoint.
        const resumed = await launched.page.evaluate(async (input) => {
          return await window.spire.runsCheckpointResume(input.runId);
        }, { runId });
        expect(resumed.status).toBe("running");

        // Poll until the run completes.
        const finalPlan = await waitFor(async () => {
          return await launched.page.evaluate(async (input) => {
            const plan = await window.spire.runsPlanGet(input.runId);
            return plan.status === "running" ? undefined : plan;
          }, { runId });
        }, "plan to reach terminal state after resume");
        expect(finalPlan.status).toBe("succeeded");

        // Verify n_end completed.
        const db2 = openDb(launched.userDataDir);
        try {
          const nodes = nodeRows(db2, runId!);
          const byId = new Map(nodes.map((n) => [n.nodeId, n]));
          expect(byId.get("n_end")?.status).toBe("succeeded");
          expect(byId.get("n_end")?.visits).toBe(1);
        } finally {
          db2.close();
        }
      } finally {
        await launched.close();
        rmSync(repo, { recursive: true, force: true });
      }
    } finally {
      await launched.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rejects an unauthorized plan patch from a read-only node", async () => {
    test.setTimeout(180_000);
    const repo = makeScratchRepo();
    const launched = await launchApp({
      harnessFixtures: corporateFixtures(),
    });
    try {
      await waitForControlSocket(launched.userDataDir);

      const snapshot = await launched.page.evaluate(async (input) => {
        return await window.spire.startRun(input);
      }, { graph: CORPORATE_GRAPH_REF, repositoryPath: repo, goal: "Unauthorized patch test." } as StartRunInput);
      const runId = snapshot.activeRunId!;
      expect(runId).toBeTruthy();

      // Wait for the run to finish.
      const plan = await waitFor(async () => {
        return await launched.page.evaluate(async (input) => {
          const plan = await window.spire.runsPlanGet(input.runId);
          return plan.status === "running" ? undefined : plan;
        }, { runId });
      }, "plan to reach terminal state");
      const revision = plan.revision;

      // n_research has authority { scope: "self", actions: [] } — it cannot
      // authorize a retry on n_implement (a different node).
      const result = await launched.page.evaluate(async (input) => {
        try {
          await window.spire.runsPlanPatch(input);
          return { error: "patch should have been rejected" };
        } catch (error: unknown) {
          return { error: String((error as { message?: string })?.message ?? error) };
        }
      }, {
        runId,
        actorNodeId: "n_research",
        draft: {
          baseRevision: revision,
          reason: "Unauthorized retry attempt",
          operations: [{ action: "retry", nodeId: "n_implement" }],
        },
      } as PlanPatchInput);

      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/authority|author|not.*authorized/i);
    } finally {
      await launched.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("fails a node on workspace scope violation", async () => {
    test.setTimeout(180_000);
    const repo = makeScratchRepo();
    const launched = await launchApp({
      harnessFixtures: scopeViolationFixtures(),
    });
    try {
      await waitForControlSocket(launched.userDataDir);

      const snapshot = await launched.page.evaluate(async (input) => {
        return await window.spire.startRun(input);
      }, { graph: CORPORATE_GRAPH_REF, repositoryPath: repo, goal: "Scope violation test." } as StartRunInput);
      const runId = snapshot.activeRunId!;
      expect(runId).toBeTruthy();

      // Wait for the plan to settle (it should fail, not succeed).
      const plan = await waitFor(async () => {
        return await launched.page.evaluate(async (input) => {
          const plan = await window.spire.runsPlanGet(input.runId);
          return plan.status === "running" ? undefined : plan;
        }, { runId });
      }, "plan to reach terminal state");

      expect(plan.status).toBe("failed");

      // n_implement should have failed with a scope violation error.
      const db = openDb(launched.userDataDir);
      try {
        const nodes = nodeRows(db, runId!);
        const byId = new Map(nodes.map((n) => [n.nodeId, n]));
        const impl = byId.get("n_implement");
        expect(impl?.status).toBe("failed");
        expect(impl?.error ?? "").toMatch(/scope|violation|outside/i);
      } finally {
        db.close();
      }
    } finally {
      await launched.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("redacts secrets from the trace journal and persisted events", async () => {
    test.setTimeout(180_000);
    const repo = makeScratchRepo();
    const launched = await launchApp({
      harnessFixtures: corporateFixtures(),
    });
    try {
      await waitForControlSocket(launched.userDataDir);

      const snapshot = await launched.page.evaluate(async (input) => {
        return await window.spire.startRun(input);
      }, { graph: CORPORATE_GRAPH_REF, repositoryPath: repo, goal: `Secret scan test.` } as StartRunInput);
      const runId = snapshot.activeRunId!;
      expect(runId).toBeTruthy();

      // Wait for the run to complete.
      await waitFor(async () => {
        return await launched.page.evaluate(async (input) => {
          const plan = await window.spire.runsPlanGet(input.runId);
          return plan.status === "running" ? undefined : plan;
        }, { runId });
      }, "plan to reach terminal state");

      // --- Verify via MCP sidecar (spire_traces_query) ---
      const session = await connectSidecar(launched.userDataDir);
      try {
        const traces = await callTool(session, "spire_traces_query", { runId });
        expect(traces.isError).toBeFalsy();
        const events = (
          traces.structuredContent as { events: TraceEvent[] }
        ).events;
        expect(events.length).toBeGreaterThan(0);
        const serialized = JSON.stringify(events);
        expect(serialized).not.toContain(SECRET);
        expect(serialized).toContain("[REDACTED]");

        // The per-run trace resource must also be redacted.
        const traceResource = await session.client.readResource({
          uri: `spire://traces/${runId}`,
        });
        const traceText = (
          traceResource.contents[0] as { text?: string }
        ).text ?? "";
        expect(traceText).not.toContain(SECRET);
        expect(traceText).toContain("[REDACTED]");
      } finally {
        await session.close();
      }

      // --- Verify via direct SQLite reads ---
      const db = openDb(launched.userDataDir);
      try {
        // trace_events table: payload is redacted JSON.
        const tracePayloads = traceEventPayloads(db, runId!);
        for (const payload of tracePayloads) {
          expect(payload).not.toContain(SECRET);
        }
        // At least one trace event payload should be redacted.
        const anyTraceRedacted = tracePayloads.some(
          (p) => p.includes("[REDACTED]"),
        );
        expect(anyTraceRedacted, "at least one trace event payload should be redacted").toBe(true);

        // runs table: RunEvent payloads use [redacted] (lowercase).
        const runPayloads = runRecordPayloads(db, runId!);
        for (const payload of runPayloads) {
          expect(payload).not.toContain(SECRET);
        }
        // At least one run event payload should contain [redacted] (lowercase).
        const anyRedacted = runPayloads.some(
          (p) => p.includes("[redacted]"),
        );
        expect(anyRedacted, "at least one run event payload should be redacted").toBe(true);
      } finally {
        db.close();
      }

      // --- Verify collaboration markdown files are clean ---
      const collabDir = path.join(
        launched.userDataDir,
        "runs",
        runId!,
        "collaboration",
      );
      const mdFiles = readAllMarkdown(collabDir);
      expect(mdFiles.length, "collaboration markdown files should exist").toBeGreaterThan(0);
      for (const file of mdFiles) {
        expect(file.content, `${file.path} should not contain the secret`).not.toContain(SECRET);
      }
    } finally {
      await launched.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// Module-level graph references for page.evaluate serialization.
// These are plain objects that Playwright will JSON-serialize into the page.
const CORPORATE_GRAPH_REF = corporateGraph();
const RESTART_GRAPH_REF = restartGraph();
