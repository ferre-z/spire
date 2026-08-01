import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessId } from "../../shared/domain";
import type { NodeOutcome } from "../../shared/execution";
import type {
  HarnessAdapter,
  HarnessEvent,
  HarnessProbeStatus,
  HarnessRunInput,
  HarnessRunResult,
  HarnessSessionRef,
} from "../../shared/harness";

/**
 * Predetermined output for a single node visit, optionally with a JSON-
 * serializable side effect that runs in the node's working directory.
 *
 * `sideEffect.writeFile` causes the fixture to write a file (used for
 * scope-violation tests in the E2E suite).
 */
export type FixtureNodeConfig = {
  output: unknown;
  /** Optional harness events to emit via onEvent after the assistant_text seed. */
  events?: HarnessEvent[];
  /** Optional file-write side effect descriptor (JSON-serializable). */
  sideEffect?: { writeFile?: { path: string; content: string } };
};

/** Maps node IDs to an ordered list of visit outputs. */
export type FixtureHarnessConfig = {
  nodes: Record<string, FixtureNodeConfig[]>;
};

/**
 * Test-only harness adapter that returns predetermined `NodeOutcome` values
 * keyed by node id, without spawning any CLI process. Used by the E2E
 * corporate-workflows suite so the full graph scheduler can execute end to
 * end with no installed harnesses and no paid model calls.
 */
export class FixtureHarnessAdapter implements HarnessAdapter {
  readonly calls: HarnessRunInput[] = [];
  readonly abortCalls: HarnessSessionRef[] = [];
  private readonly visitCount = new Map<string, number>();

  constructor(
    readonly id: HarnessId,
    private readonly config: FixtureHarnessConfig,
  ) {}

  async probe(): Promise<HarnessProbeStatus> {
    return {
      harnessId: this.id,
      installed: true,
      compatible: true,
      connected: true,
    };
  }

  async listModels(): Promise<{ id: string; name: string }[]> {
    return [{ id: "fixture-model", name: "Fixture Model" }];
  }

  run(input: HarnessRunInput): Promise<HarnessRunResult> {
    this.calls.push(input);
    const visit = this.visitCount.get(input.nodeId) ?? 0;
    this.visitCount.set(input.nodeId, visit + 1);

    const ref: HarnessSessionRef = {
      harnessId: this.id,
      sessionId:
        input.session?.sessionId ?? `${this.id}-session-${input.nodeId}-${visit}`,
      directory: input.directory,
    };
    input.onSession(ref);

    // Emit a minimal event sequence so the trace pipeline has something to render.
    input.onEvent({
      type: "assistant_text",
      text: `Fixture ${this.id} visiting ${input.nodeId}`,
    });

    const configs = this.config.nodes[input.nodeId];
    if (!configs || visit >= configs.length) {
      // No predetermined output — fail the node deterministically.
      const outcome: NodeOutcome = {
        status: "failed",
        summary: `No fixture output configured for node ${input.nodeId}`,
        artifacts: [],
        messages: [],
        selectedEdgeIds: [],
      };
      return Promise.resolve({ session: ref, output: outcome });
    }

    const entry = configs[visit]!;
    const output = entry.output;

    // Emit any fixture-configured harness events (e.g. tool_start with a
    // sensitive input, to exercise the trace journal's redaction pipeline).
    for (const event of entry.events ?? []) {
      input.onEvent(event);
    }

    // Run any configured side effect before returning.
    const sideEffect = entry.sideEffect;
    const result: HarnessRunResult = { session: ref, output };
    const writeFile = sideEffect?.writeFile;

    if (writeFile) {
      return Promise.resolve()
        .then(() => {
          try {
            writeSideEffect(input.directory, writeFile);
          } catch {
            // Best-effort side effect: a failed write must not mask the
            // predetermined NodeOutcome (scope enforcement happens upstream).
          }
        })
        .then(() => result);
    }
    return Promise.resolve(result);
  }

  async abort(session: HarnessSessionRef): Promise<void> {
    this.abortCalls.push(session);
  }

  async close(): Promise<void> {}
}

/** Execute a writeFile side effect inside the harness adapter scope. */
function writeSideEffect(
  directory: string,
  write: { path: string; content: string },
): void {
  // Resolve relative to the node's working directory.
  const target = join(directory, write.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, write.content, { mode: 0o644 });
}

/**
 * Build a fixture registry from a per-harness config map. Every harness listed
 * is registered; harnesses omitted from the config are not registered and a
 * `get()` for them will throw (matching the real registry's behavior).
 */
export function createFixtureHarnessRegistry(
  configs: Record<HarnessId, FixtureHarnessConfig>,
): import("../../shared/harness").HarnessRegistry & {
  adapter: (id: HarnessId) => FixtureHarnessAdapter;
} {
  const adapters = new Map<HarnessId, FixtureHarnessAdapter>();
  for (const [id, config] of Object.entries(configs)) {
    adapters.set(id as HarnessId, new FixtureHarnessAdapter(id as HarnessId, config));
  }

  const ordered = [...adapters.values()];
  return {
    get(id: HarnessId) {
      const adapter = adapters.get(id);
      if (!adapter) throw new Error(`Unknown harness: ${id}.`);
      return adapter;
    },
    async probeAll(): Promise<HarnessProbeStatus[]> {
      return Promise.all(ordered.map((adapter) => adapter.probe()));
    },
    async closeAll(): Promise<void> {
      await Promise.all(ordered.map((adapter) => adapter.close()));
    },
    adapter(id: HarnessId): FixtureHarnessAdapter {
      const a = adapters.get(id);
      if (!a) throw new Error(`Unknown harness: ${id}.`);
      return a;
    },
  };
}
