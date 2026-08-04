import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureHarnessRegistry } from "../main/harness/fixture";
import type { HarnessRegistry } from "../shared/harness";
import { createCoordinatorRuntime } from "./runtime";

describe("createCoordinatorRuntime", () => {
  it("constructs and closes without Electron", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "spire-coordinator-"));
    const runtime = await createCoordinatorRuntime({
      dataRoot,
      registry: createFixtureHarnessRegistry({
        opencode: { nodes: {} },
        codex: { nodes: {} },
        "claude-code": { nodes: {} },
      }),
      environment: { appVersion: "test", platform: "linux", isWayland: false },
    });

    await expect(runtime.control.execute("state.get", {})).resolves.toMatchObject({
      graphs: [],
      runs: [],
    });
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("closes its harness adapters once", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "spire-coordinator-"));
    let closeCalls = 0;
    const registry: HarnessRegistry = {
      get() {
        throw new Error("No harnesses are configured for this test.");
      },
      async probeAll() {
        return [];
      },
      async closeAll() {
        closeCalls += 1;
      },
    };
    const runtime = await createCoordinatorRuntime({ dataRoot, registry });

    await runtime.close();
    await runtime.close();

    expect(closeCalls).toBe(1);
  });
});
