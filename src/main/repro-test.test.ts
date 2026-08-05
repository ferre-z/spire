import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import type {
  GraphDefinitionV2,
  HarnessId,
  StartRunInput,
} from "../shared/domain";
import { SpireDatabase } from "./database";
import { RunEngine } from "./run-engine";
import { LocalWorktreeBackend } from "./worktree";
import {
  createFixtureHarnessRegistry,
  type FixtureHarnessConfig,
} from "./harness/fixture";

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, stdio: "pipe" });
}

function makeScratchRepo(): string {
  const repo = path.join(tmpdir(), `spire-repro-repo-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"], repo);
  git(["config", "user.email", "e2e@spire.test"], repo);
  git(["config", "user.name", "Spire E2E"], repo);
  writeFileSync(path.join(repo, "README.md"), "# scratch\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

function corporateGraph(): GraphDefinitionV2 {
  return {
    id: "corporate-workflow",
    name: "Corporate Workflow",
    version: 1,
    maxSteps: 100,
    createdAt: new Date().toISOString(),
    groups: [],
    nodes: [
      { kind: "agent", id: "n_research", name: "Research", job: "Research",
        harnessId: "opencode", modelId: "gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all", maxVisits: 3, thinkingEffort: "medium", skills: [], goal: "", subGoals: [], integrations: [], position: { x: 0, y: 0 } },
      { kind: "agent", id: "n_implement", name: "Implement", job: "Implement",
        harnessId: "codex", modelId: "gpt-5-codex",
        access: { mode: "workspace-write", writeScopes: ["src"] },
        authority: { scope: "self", actions: [] },
        activation: "all", maxVisits: 3, thinkingEffort: "medium", skills: [], goal: "", subGoals: [], integrations: [], position: { x: 200, y: 0 } },
      { kind: "agent", id: "n_review", name: "Review", job: "Review",
        harnessId: "claude-code", modelId: "gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all", maxVisits: 3, thinkingEffort: "medium", skills: [], goal: "", subGoals: [], integrations: [], position: { x: 400, y: 0 } },
      { kind: "decision", id: "n_gate", name: "Gate", job: "Gate",
        harnessId: "claude-code", modelId: "gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all", maxVisits: 3, thinkingEffort: "medium", skills: [], goal: "", subGoals: [], integrations: [], position: { x: 600, y: 0 } },
      { kind: "checkpoint", id: "n_checkpoint", name: "Checkpoint",
        mode: "automatic", position: { x: 600, y: 200 } },
      { kind: "agent", id: "n_revise", name: "Revise", job: "Revise",
        harnessId: "codex", modelId: "gpt-5-codex",
        access: { mode: "workspace-write", writeScopes: ["src"] },
        authority: { scope: "self", actions: [] },
        activation: "all", maxVisits: 3, thinkingEffort: "medium", skills: [], goal: "", subGoals: [], integrations: [], position: { x: 400, y: 200 } },
      { kind: "decision", id: "n_deploy", name: "Deploy", job: "Deploy",
        harnessId: "opencode", modelId: "gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "graph", actions: ["retry"] },
        activation: "all", maxVisits: 2, thinkingEffort: "medium", skills: [], goal: "", subGoals: [], integrations: [], position: { x: 800, y: 0 } },
      { kind: "agent", id: "n_finalize", name: "Finalize", job: "Finalize",
        harnessId: "codex", modelId: "gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all", maxVisits: 3, thinkingEffort: "medium", skills: [], goal: "", subGoals: [], integrations: [], position: { x: 1000, y: 0 } },
    ],
    edges: [
      { id: "edge_research_implement", source: "n_research", target: "n_implement", kind: "handoff", when: "success", label: "Research findings" },
      { id: "edge_implement_review", source: "n_implement", target: "n_review", kind: "handoff", when: "success", label: "Implementation" },
      { id: "edge_review_gate", source: "n_review", target: "n_gate", kind: "review", when: "success", label: "Review complete" },
      { id: "edge_gate_checkpoint", source: "n_gate", target: "n_checkpoint", kind: "approval", when: "selected", label: "Proceed to deploy" },
      { id: "edge_gate_revise", source: "n_gate", target: "n_revise", kind: "escalation", when: "selected", label: "Needs revisions" },
      { id: "edge_revise_review", source: "n_revise", target: "n_review", kind: "handoff", when: "selected", label: "Revised implementation" },
      { id: "edge_checkpoint_deploy", source: "n_checkpoint", target: "n_deploy", kind: "handoff", when: "success", label: "Proceed to deploy" },
      { id: "edge_deploy_finalize", source: "n_deploy", target: "n_finalize", kind: "handoff", when: "selected", label: "Deployment succeeded" },
    ],
  };
}

const fixtures: Record<HarnessId, FixtureHarnessConfig> = {
  opencode: {
    nodes: {
      n_research: [
        { output: { status: "succeeded" as const, summary: "Research complete", artifacts: [], messages: [{ recipient: { kind: "successors" }, kind: "handoff", subject: "Findings", body: "research done", artifactPaths: [] }], selectedEdgeIds: [] } },
      ],
      n_deploy: [
        { output: { status: "failed" as const, summary: "Deploy failed", artifacts: [], messages: [], selectedEdgeIds: [], patch: { baseRevision: 0, reason: "Retry deployment after transient failure", operations: [{ action: "retry" as const, nodeId: "n_deploy" }] } } },
        { output: { status: "succeeded" as const, summary: "Deploy succeeded on retry", artifacts: [], messages: [], selectedEdgeIds: ["edge_deploy_finalize"] } },
      ],
    },
  },
  codex: {
    nodes: {
      n_implement: [
        { output: { status: "succeeded" as const, summary: "Implemented", artifacts: [{ name: "login", path: "src/auth/login.ts", mediaType: "text/x-typescript" }], messages: [{ recipient: { kind: "successors" }, kind: "report", subject: "Implementation report", body: "implemented", artifactPaths: ["src/auth/login.ts"] }], selectedEdgeIds: [] }, sideEffect: { writeFile: { path: "src/auth/login.ts", content: "// auth login module\n" } } },
      ],
      n_finalize: [
        { output: { status: "succeeded" as const, summary: "Finalized", artifacts: [], messages: [{ recipient: { kind: "successors" }, kind: "report", subject: "Finalization report", body: "finalized", artifactPaths: [] }], selectedEdgeIds: [] } },
      ],
    },
  },
  "claude-code": {
    nodes: {
      n_review: [
        { output: { status: "succeeded" as const, summary: "Reviewed", artifacts: [], messages: [{ recipient: { kind: "successors" }, kind: "handoff", subject: "Review findings", body: "passed", artifactPaths: [] }], selectedEdgeIds: [] } },
      ],
      n_gate: [
        { output: { status: "succeeded" as const, summary: "Gate approved", artifacts: [], messages: [{ recipient: { kind: "successors" }, kind: "decision", subject: "Gate decision: proceed", body: "approved", artifactPaths: [] }], selectedEdgeIds: ["edge_gate_checkpoint"] } },
      ],
    },
  },
};

describe("corporate workflow repro", () => {
  let cleanup: (() => void)[] = [];

  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it("completes successfully", async () => {
    const dbDir = path.join(tmpdir(), `spire-repro-db-${Date.now()}`);
    mkdirSync(dbDir, { recursive: true });
    const db = new SpireDatabase(path.join(dbDir, "test.sqlite"));
    const repo = makeScratchRepo();
    cleanup.push(() => {
      try { rmSync(dbDir, { recursive: true, force: true }); } catch {
        /* best-effort cleanup */
      }
      try { rmSync(repo, { recursive: true, force: true }); } catch {
        /* best-effort cleanup */
      }
    });

    const backend = new LocalWorktreeBackend(path.join(dbDir, "worktrees"));
    const registry = createFixtureHarnessRegistry(fixtures);

    const engine = new RunEngine(db, registry, backend, () => undefined, undefined, dbDir);

    db.saveGraphV2(corporateGraph());

    const run = await engine.start({
      graph: corporateGraph() as StartRunInput["graph"],
      repositoryPath: repo,
      goal: "Build auth module",
    });

    // Wait for the run to complete
    let runRecord = db.getRun(run.id);
    for (let i = 0; i < 50; i++) {
      runRecord = db.getRun(run.id);
      if (
        runRecord &&
        ("succeeded" === runRecord.status ||
          "failed" === runRecord.status ||
          "needs_attention" === runRecord.status)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const plan = db.getExecutionPlan(run.id);
    console.log("Run status:", runRecord?.status);
    console.log("Plan status:", plan?.status);
    console.log("Run error:", runRecord?.error);
    console.log("Plan nodes:", JSON.stringify(plan?.nodes.map(n => ({
      id: n.nodeId, status: n.status, visits: n.visits, error: n.error,
      outcome: n.outcome?.summary, selected: n.outcome?.selectedEdgeIds,
    })), null, 2));

    expect(plan?.status).toBe("succeeded");
  }, 15000);
});
