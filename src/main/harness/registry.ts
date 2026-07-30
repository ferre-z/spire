import type { HarnessId } from "../../shared/domain";
import type {
  HarnessAdapter,
  HarnessRegistry,
  HarnessStatus,
} from "../../shared/harness";
import { ClaudeCodeAdapter } from "./claude-code";
import { CodexAdapter } from "./codex";
import { OpenCodeAdapter } from "./opencode";

/**
 * Canonical adapter order: the order probeAll reports in, regardless of
 * registration order. New harnesses (codex, claude-code) slot in after
 * opencode; unknown future ids sort after the known ones by id.
 */
const CANONICAL_ORDER: HarnessId[] = ["opencode", "codex", "claude-code"];

function orderOf(id: HarnessId): number {
  const index = CANONICAL_ORDER.indexOf(id);
  return index === -1 ? CANONICAL_ORDER.length : index;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createHarnessRegistry(
  adapters: HarnessAdapter[],
): HarnessRegistry {
  const byId = new Map<HarnessId, HarnessAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) {
      throw new Error(`Duplicate harness adapter: ${adapter.id}.`);
    }
    byId.set(adapter.id, adapter);
  }
  const ordered = [...byId.values()].sort(
    (a, b) => orderOf(a.id) - orderOf(b.id) || a.id.localeCompare(b.id),
  );
  return {
    get(id) {
      const adapter = byId.get(id);
      if (!adapter) throw new Error(`Unknown harness: ${id}.`);
      return adapter;
    },
    async probeAll() {
      return Promise.all(
        ordered.map(async (adapter): Promise<HarnessStatus> => {
          try {
            return await adapter.probe();
          } catch (error) {
            return {
              harnessId: adapter.id,
              installed: false,
              compatible: false,
              connected: false,
              error: errorMessage(error),
            };
          }
        }),
      );
    },
    async closeAll() {
      const failures: string[] = [];
      for (const adapter of ordered) {
        try {
          await adapter.close();
        } catch (error) {
          failures.push(`${adapter.id}: ${errorMessage(error)}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`Failed to close harness adapter(s) — ${failures.join("; ")}`);
      }
    },
  };
}

/**
 * Registry with every built-in adapter in canonical order:
 * opencode → codex → claude-code.
 *
 * `dataDir` is the Spire run-data root (the caller resolves
 * `process.env.SPIRE_USER_DATA ?? app.getPath("userData")`); the Codex
 * adapter writes its temporary output-schema files beneath it.
 */
export function createDefaultHarnessRegistry(dataDir: string): HarnessRegistry {
  return createHarnessRegistry([
    new OpenCodeAdapter(),
    new CodexAdapter({ dataDir }),
    new ClaudeCodeAdapter(),
  ]);
}
