import path from "node:path";
import type { RunEvent } from "../shared/domain";
import type { HarnessRegistry } from "../shared/harness";
import {
  SpireControl,
  type SpireControlEnvironment,
} from "../main/control/spire-control";
import { SpireDatabase } from "../main/database";
import { OpenCodeHarness } from "../main/harness/opencode";
import { createDefaultHarnessRegistry } from "../main/harness/registry";
import { RunEngine } from "../main/run-engine";
import { LocalWorktreeBackend } from "../main/worktree";

export type CoordinatorRuntimeOptions = {
  dataRoot: string;
  registry?: HarnessRegistry;
  environment?: SpireControlEnvironment;
  notify?: (event: RunEvent) => void;
};

export type CoordinatorRuntime = {
  control: SpireControl;
  close(): Promise<void>;
};

export async function createCoordinatorRuntime(
  options: CoordinatorRuntimeOptions,
): Promise<CoordinatorRuntime> {
  const database = new SpireDatabase(path.join(options.dataRoot, "spire.sqlite"));
  const registry = options.registry ?? createDefaultHarnessRegistry(options.dataRoot);
  const harness = new OpenCodeHarness();
  const backend = new LocalWorktreeBackend(path.join(options.dataRoot, "worktrees"));
  const journal = database.createTraceJournal();
  const engine = new RunEngine(
    database,
    registry,
    backend,
    options.notify ?? (() => {}),
    journal,
    options.dataRoot,
  );
  const control = new SpireControl({
    database,
    engine,
    harness,
    registry,
    backend,
    journal,
    environment: options.environment,
  });
  let closePromise: Promise<void> | undefined;

  return {
    control,
    close(): Promise<void> {
      closePromise ??= closeRuntime({ database, harness, registry });
      return closePromise;
    },
  };
}

type RuntimeResources = {
  database: SpireDatabase;
  harness: OpenCodeHarness;
  registry: HarnessRegistry;
};

async function closeRuntime(resources: RuntimeResources): Promise<void> {
  resources.harness.close();
  try {
    await resources.registry.closeAll();
  } finally {
    resources.database.close();
  }
}
