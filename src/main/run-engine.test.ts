import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { GraphDefinition } from "../shared/domain";
import { SpireDatabase } from "./database";
import type {
  AgentHarness,
  HarnessPrompt,
  HarnessResponse,
} from "./opencode";
import { RunEngine } from "./run-engine";
import { REDACTED, type TraceJournal } from "./trace-journal";
import type { ExecutionBackend, PreparedWorkspace } from "./worktree";

class FakeHarness implements AgentHarness {
  private index = 0;

  constructor(private readonly answers: string[]) {}

  async detect() {
    return {
      installed: true,
      compatible: true,
      connected: true,
    };
  }
  async connectOpenRouter() {}
  async models() {
    return [];
  }
  async prompt(input: HarnessPrompt): Promise<HarnessResponse> {
    input.onSession?.(input.sessionId ?? `session-${this.index}`);
    input.onEvent("tool", "fake tool completed");
    return {
      sessionId: input.sessionId ?? `session-${this.index}`,
      text: this.answers[this.index++],
    };
  }
  async abort() {}
  close() {}
}

class FakeBackend implements ExecutionBackend {
  async prepare(): Promise<PreparedWorkspace> {
    return { path: "/tmp/spire-fake", branch: "spire/test", dirtySource: false };
  }
  async inspect() {
    return { diff: "+export const value = 1;", changedFiles: ["src/value.ts"] };
  }
  async cleanup() {}
  async exportPatch() {}
}

function graph(maxIterations = 3): GraphDefinition {
  return {
    id: "graph",
    name: "Build",
    version: 1,
    maxIterations,
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

describe("RunEngine", () => {
  it("executes a review/revision cycle and succeeds", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "spire-engine-"));
    const database = new SpireDatabase(path.join(directory, "test.sqlite"));
    const harness = new FakeHarness([
      brief,
      implementation,
      JSON.stringify({
        decision: "needs_changes",
        evidence: ["missing docs"],
        feedback: ["add docs"],
      }),
      implementation,
      JSON.stringify({
        decision: "accepted",
        evidence: ["value exists"],
        feedback: [],
      }),
    ]);
    const events: string[] = [];
    const engine = new RunEngine(
      database,
      harness,
      new FakeBackend(),
      (event) => events.push(event.kind),
    );
    const run = await engine.start({
      graph: graph(),
      repositoryPath: "/tmp/repository",
      goal: "Add value",
    });

    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    const saved = database.getRun(run.id)!;
    expect(saved.iteration).toBe(2);
    expect(saved.artifacts?.changedFiles).toEqual(["src/value.ts"]);
    expect(events).toContain("transition");
    database.close();
  });

  it("stops at the iteration cap", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "spire-limit-"));
    const database = new SpireDatabase(path.join(directory, "test.sqlite"));
    const harness = new FakeHarness([
      brief,
      implementation,
      JSON.stringify({
        decision: "needs_changes",
        evidence: [],
        feedback: ["try again"],
      }),
    ]);
    const engine = new RunEngine(
      database,
      harness,
      new FakeBackend(),
      () => undefined,
    );
    const run = await engine.start({
      graph: graph(1),
      repositoryPath: "/tmp/repository",
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("needs_attention"),
      { timeout: 3000 },
    );
    expect(database.getRun(run.id)?.iteration).toBe(1);
    database.close();
  });
});

describe("RunEngine trace journaling", () => {
  it("journals transitions, prompts, responses, and tool activity", async () => {
    const database = new SpireDatabase(":memory:");
    const journal = database.createTraceJournal();
    const harness = new FakeHarness([
      brief,
      implementation,
      JSON.stringify({
        decision: "accepted",
        evidence: ["value exists"],
        feedback: [],
      }),
    ]);
    const engine = new RunEngine(
      database,
      harness,
      new FakeBackend(),
      () => undefined,
      journal,
    );
    const run = await engine.start({
      graph: graph(),
      repositoryPath: "/tmp/repository",
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );

    const events = journal.query({ runId: run.id }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.runId === run.id)).toBe(true);
    const kinds = new Set(events.map((event) => event.kind));
    expect(kinds).toContain("run.transition");
    expect(kinds).toContain("run.prompt");
    expect(kinds).toContain("run.response");
    expect(kinds).toContain("run.tool");

    const plannerPrompt = events.find(
      (event) => event.kind === "run.prompt" && event.nodeId === "planner",
    );
    expect(plannerPrompt).toBeDefined();
    expect(plannerPrompt?.payload).toMatchObject({
      prompt: expect.stringContaining("Add value"),
    });
    const implementerResponse = events.find(
      (event) => event.kind === "run.response" && event.nodeId === "implementer",
    );
    expect(implementerResponse).toBeDefined();
    expect(implementerResponse?.payload).toMatchObject({
      text: expect.stringContaining("Added value"),
    });
    const toolEvent = events.find((event) => event.kind === "run.tool");
    expect(toolEvent?.message).toBe("fake tool completed");
    database.close();
  });

  it("persists only redacted secrets from prompts and responses", async () => {
    const secret = "sk-abcdefghijklmnop";
    const database = new SpireDatabase(":memory:");
    const journal = database.createTraceJournal();
    const harness = new FakeHarness([
      brief,
      implementation,
      JSON.stringify({
        decision: "accepted",
        evidence: [`leaked ${secret}`],
        feedback: [],
      }),
    ]);
    const engine = new RunEngine(
      database,
      harness,
      new FakeBackend(),
      () => undefined,
      journal,
    );
    const run = await engine.start({
      graph: graph(),
      repositoryPath: "/tmp/repository",
      goal: `Add value with ${secret}`,
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );

    const events = journal.query({ runId: run.id }).events;
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(REDACTED);
    database.close();
  });

  it("keeps the run alive when the journal append throws", async () => {
    const database = new SpireDatabase(":memory:");
    const broken = {
      append: () => {
        throw new Error("journal down");
      },
    } as unknown as TraceJournal;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = new FakeHarness([
      brief,
      implementation,
      JSON.stringify({
        decision: "accepted",
        evidence: [],
        feedback: [],
      }),
    ]);
    const engine = new RunEngine(
      database,
      harness,
      new FakeBackend(),
      () => undefined,
      broken,
    );
    const run = await engine.start({
      graph: graph(),
      repositoryPath: "/tmp/repository",
      goal: "Add value",
    });
    await vi.waitFor(
      () => expect(database.getRun(run.id)?.status).toBe("succeeded"),
      { timeout: 3000 },
    );
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    database.close();
  });
});
