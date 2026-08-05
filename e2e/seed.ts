import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  GraphDefinitionV2,
  HarnessId,
  RunRecord,
} from "../src/shared/domain";
import type { HarnessEvent } from "../src/shared/harness";
import type { ExecutionPlan } from "../src/shared/execution";

/**
 * Predetermined output for one node visit, optionally with fixture-emitted
 * harness events and a side-effect function descriptor (serialized as JSON
 * for the seed fixture).
 */
export type FixtureNodeConfig = {
  output: unknown;
  /** Optional harness events to emit via onEvent before the side effect runs. */
  events?: HarnessEvent[];
  /** Optional file-write side effect: { path: string; content: string }. */
  sideEffect?: { writeFile?: { path: string; content: string } };
};

/** Per-harness fixture config: node-id → ordered list of visit outputs. */
export type FixtureHarnessConfig = {
  nodes: Record<string, FixtureNodeConfig[]>;
};

/**
 * Deterministic fixtures for Electron UI tests. The harness writes a JSON
 * fixture that the packaged app applies on boot (SPIRE_SEED), so seeding
 * runs through the app's own database code and no test ever contacts
 * OpenRouter — the workspace renders entirely from stored records.
 *
 * `graphsV2` seeds graph-native v2 definitions and `harnessFixtures`
 * injects predetermined harness outputs so E2E suites can exercise the
 * full scheduler without installed CLI dependencies.
 */

export type SeedFixture = {
  settings?: Record<string, string>;
  graphsV2?: GraphDefinitionV2[];
  runs?: RunRecord[];
  plans?: ExecutionPlan[];
  harnessFixtures?: Record<HarnessId, FixtureHarnessConfig>;
};

export function seedGraph(
  id: string,
  name: string,
  version = 1,
): GraphDefinitionV2 {
  const now = new Date().toISOString();
  return {
    id,
    name,
    version,
    maxSteps: 12,
    createdAt: now,
    nodes: [
      {
        kind: "agent",
        id: "planner",
        name: "Architect",
        job: "Plan and review with high standards.",
        harnessId: "opencode",
        modelId: "openai/gpt-5-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        thinkingEffort: "medium",
        skills: [],
        goal: "",
        subGoals: [],
        integrations: [],
        position: { x: 160, y: 190 },
      },
      {
        kind: "agent",
        id: "implementer",
        name: "Builder",
        job: "Implement carefully and validate.",
        harnessId: "opencode",
        modelId: "openai/gpt-5-codex",
        access: { mode: "workspace-write", writeScopes: ["**/*"] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        thinkingEffort: "medium",
        skills: [],
        goal: "",
        subGoals: [],
        integrations: [],
        position: { x: 570, y: 190 },
      },
    ],
    edges: [
      {
        id: "plan-build",
        source: "planner",
        target: "implementer",
        kind: "handoff",
        when: "always",
        label: "task brief",
      },
      {
        id: "build-review",
        source: "implementer",
        target: "planner",
        kind: "review",
        when: "always",
        label: "review",
      },
      {
        id: "revise",
        source: "planner",
        target: "implementer",
        kind: "review",
        when: "failure",
        label: "revise",
      },
    ],
    groups: [],
  };
}

export function mockRun(
  graph: GraphDefinitionV2,
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

export function mockPlan(
  graph: GraphDefinitionV2,
  run: RunRecord,
): ExecutionPlan {
  return {
    runId: run.id,
    graphId: graph.id,
    graphVersion: graph.version,
    revision: 0,
    status: "running",
    stepCount: 1,
    nodes: graph.nodes.map((node) => ({
      nodeId: node.id,
      status: node.id === run.activeNodeId ? "running" : "waiting",
      visits: node.id === run.activeNodeId ? 1 : 0,
    })),
    edges: graph.edges,
    patches: [],
    updatedAt: run.startedAt,
  };
}

export type SeedOptions = {
  /** When false, the app boots into onboarding. Defaults to true. */
  onboardingComplete?: boolean;
  graphsV2?: GraphDefinitionV2[];
  runs?: RunRecord[];
  plans?: ExecutionPlan[];
  harnessFixtures?: Record<HarnessId, FixtureHarnessConfig>;
};

export function writeSeedFixture(dir: string, options: SeedOptions = {}): string {
  mkdirSync(dir, { recursive: true });
  const fixture: SeedFixture = {
    settings:
      (options.onboardingComplete ?? true)
        ? { onboardingComplete: "true" }
        : {},
    graphsV2: options.graphsV2 ?? [seedGraph("graph-alpha", "Build & Review")],
    runs: options.runs ?? [],
    plans: options.plans ?? [],
    harnessFixtures: options.harnessFixtures ?? {
      opencode: { nodes: {} },
      codex: { nodes: {} },
      "claude-code": { nodes: {} },
    },
  };
  const fixturePath = path.join(dir, "spire-seed.json");
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  return fixturePath;
}
