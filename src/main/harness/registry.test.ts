import { describe, expect, it, vi } from "vitest";
import type { HarnessId } from "../../shared/domain";
import type {
  HarnessAdapter,
  HarnessRunResult,
  HarnessStatus,
} from "../../shared/harness";
import { createHarnessRegistry } from "./registry";

function fakeAdapter(
  id: HarnessId,
  overrides: Partial<HarnessAdapter> = {},
): HarnessAdapter & { closeMock: ReturnType<typeof vi.fn> } {
  const closeMock = vi.fn(overrides.close ?? (async () => undefined));
  return {
    id,
    closeMock,
    probe: async (): Promise<HarnessStatus> => ({
      harnessId: id,
      installed: true,
      compatible: true,
      connected: false,
    }),
    listModels: async () => [],
    run: async (): Promise<HarnessRunResult> => {
      throw new Error("not implemented");
    },
    abort: async () => undefined,
    ...overrides,
    close: closeMock,
  };
}

describe("createHarnessRegistry", () => {
  it("returns registered adapters by id", () => {
    const opencode = fakeAdapter("opencode");
    const registry = createHarnessRegistry([opencode]);
    expect(registry.get("opencode")).toBe(opencode);
  });

  it("probes adapters in deterministic canonical order regardless of registration order", async () => {
    const registry = createHarnessRegistry([
      fakeAdapter("claude-code"),
      fakeAdapter("codex"),
      fakeAdapter("opencode"),
    ]);
    const statuses = await registry.probeAll();
    expect(statuses.map((status) => status.harnessId)).toEqual([
      "opencode",
      "codex",
      "claude-code",
    ]);
  });

  it("throws when two adapters share an id", () => {
    expect(() =>
      createHarnessRegistry([fakeAdapter("opencode"), fakeAdapter("opencode")]),
    ).toThrow(/[Dd]uplicate/);
  });

  it("throws when getting an unknown harness id", () => {
    const registry = createHarnessRegistry([fakeAdapter("opencode")]);
    expect(() => registry.get("codex")).toThrow(/[Uu]nknown harness/);
  });

  it("isolates a failing probe so other adapters still report", async () => {
    const failing = fakeAdapter("opencode", {
      probe: async () => {
        throw new Error("spawn blew up");
      },
    });
    const healthy = fakeAdapter("codex");
    const registry = createHarnessRegistry([failing, healthy]);
    const statuses = await registry.probeAll();
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({
      harnessId: "opencode",
      installed: false,
      compatible: false,
      connected: false,
      error: "spawn blew up",
    });
    expect(statuses[1]).toMatchObject({ harnessId: "codex", installed: true });
  });

  it("closes every adapter even when one close fails", async () => {
    const failing = fakeAdapter("opencode", {
      close: vi.fn(async () => {
        throw new Error("close failed");
      }),
    });
    const healthy = fakeAdapter("codex");
    const registry = createHarnessRegistry([failing, healthy]);
    await expect(registry.closeAll()).rejects.toThrow(/close failed/);
    expect(failing.closeMock).toHaveBeenCalledTimes(1);
    expect(healthy.closeMock).toHaveBeenCalledTimes(1);
  });
});
