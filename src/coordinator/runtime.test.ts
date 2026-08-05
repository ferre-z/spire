import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFixtureHarnessRegistry } from "../main/harness/fixture";
import { OpenCodeHarness } from "../main/harness/opencode";
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

  it("closes adapters and database when legacy harness shutdown fails", async () => {
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
    const closeHarness = vi
      .spyOn(OpenCodeHarness.prototype, "close")
      .mockImplementation(() => {
        throw new Error("Legacy harness close failed.");
      });
    const runtime = await createCoordinatorRuntime({ dataRoot, registry });

    try {
      await expect(runtime.close()).rejects.toThrow("Legacy harness close failed.");
      expect(closeCalls).toBe(1);
      expect(() => runtime.control.execute("state.get", {})).toThrow();
    } finally {
      closeHarness.mockRestore();
    }
  });
});
