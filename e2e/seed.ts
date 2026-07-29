import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GraphDefinition, RunRecord } from "../src/shared/domain";

/**
 * Deterministic fixtures for Electron UI tests. The harness writes a JSON
 * fixture that the packaged app applies on boot (SPIRE_SEED), so seeding
 * runs through the app's own database code and no test ever contacts
 * OpenRouter — the workspace renders entirely from stored records.
 */

export type SeedFixture = {
  settings?: Record<string, string>;
  graphs?: GraphDefinition[];
  runs?: RunRecord[];
};

export function seedGraph(
  id: string,
  name: string,
  version = 1,
): GraphDefinition {
  const now = new Date().toISOString();
  return {
    id,
    name,
    version,
    maxIterations: 3,
    createdAt: now,
    nodes: [
      {
        id: "planner",
        type: "opencode",
        role: "planner",
        name: "Architect",
        model: "openai/gpt-5-codex",
        instructions: "Plan and review with high standards.",
        position: { x: 160, y: 190 },
      },
      {
        id: "implementer",
        type: "opencode",
        role: "implementer",
        name: "Builder",
        model: "openai/gpt-5-codex",
        instructions: "Implement carefully and validate.",
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

export function mockRun(
  graph: GraphDefinition,
  overrides: Partial<RunRecord> = {},
): RunRecord {
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const id = `run-${graph.id.slice(0, 6)}`;
  return {
    id,
    graphId: graph.id,
    graphVersion: graph.version,
    repositoryPath: "/home/ubuntu/spire",
    goal: "Add retry backoff to the task runner",
    status: "implementing",
    iteration: 1,
    startedAt,
    activeNodeId: "implementer",
    events: [
      {
        id: "evt-1",
        runId: id,
        sequence: 0,
        timestamp: startedAt,
        nodeId: "planner",
        kind: "phase",
        phase: "planning",
        message: "Planner drafted the implementation brief.",
      },
      {
        id: "evt-2",
        runId: id,
        sequence: 1,
        timestamp: startedAt,
        nodeId: "implementer",
        kind: "tool",
        phase: "implementing",
        message: "Editing src/runner.ts with exponential backoff.",
      },
    ],
    artifacts: {
      diff: "diff --git a/src/runner.ts b/src/runner.ts\n+const delay = 2 ** attempt * 100;",
      changedFiles: ["src/runner.ts"],
      worktreePath: "/tmp/spire-worktree",
      branch: "spire/run-fixture",
      implementation: {
        summary: "Added exponential backoff with jitter to the retry loop.",
        changedFiles: ["src/runner.ts"],
        validations: [{ command: "pnpm test", status: "passed" }],
        blockers: [],
      },
      verdict: {
        decision: "needs_changes",
        evidence: ["Backoff is unbounded on the final attempt."],
        feedback: ["Cap the delay at 30s."],
      },
    },
    ...overrides,
  };
}

export type SeedOptions = {
  /** When false, the app boots into onboarding. Defaults to true. */
  onboardingComplete?: boolean;
  graphs?: GraphDefinition[];
  runs?: RunRecord[];
};

export function writeSeedFixture(dir: string, options: SeedOptions = {}): string {
  mkdirSync(dir, { recursive: true });
  const fixture: SeedFixture = {
    settings:
      (options.onboardingComplete ?? true)
        ? { onboardingComplete: "true" }
        : {},
    graphs: options.graphs ?? [seedGraph("graph-alpha", "Build & Review")],
    runs: options.runs ?? [],
  };
  const fixturePath = path.join(dir, "spire-seed.json");
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  return fixturePath;
}
