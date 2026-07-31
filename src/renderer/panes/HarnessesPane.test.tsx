// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "../store";
import { HarnessesPane } from "./HarnessesPane";

const spire: Record<string, ReturnType<typeof vi.fn>> = {};
let container: HTMLDivElement | undefined;
let root: Root | undefined;

function renderPane() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  void act(() => {
    root!.render(<HarnessesPane />);
  });
  return container;
}

beforeEach(() => {
  for (const key of [
    "snapshot",
    "graphsValidate",
    "runsPlanGet",
    "runsNodesList",
    "runsMessagesList",
    "runsMessagesSend",
    "runsPlanPatch",
    "runsPlanRollback",
    "runsCheckpointResume",
    "runsPlanPromote",
    "harnessesList",
    "harnessesModels",
    "saveGraph",
  ]) {
    spire[key] = vi.fn();
  }
  (window as { spire?: unknown }).spire = spire;
  useAppStore.setState({
    harnesses: [
      {
        id: "opencode",
        name: "OpenCode",
        status: { harnessId: "opencode", installed: true, compatible: true, connected: true },
      },
      {
        id: "codex",
        name: "Codex",
        status: { harnessId: "codex", installed: false, compatible: false, connected: false },
      },
    ],
    harnessModels: { opencode: [{ id: "gpt-4", name: "GPT-4" }] },
    harnessLoading: false,
  });
});

afterEach(() => {
  if (root) {
    void act(() => root!.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
  delete (window as { spire?: unknown }).spire;
});

describe("HarnessesPane (v2)", () => {
  it("renders every harness with its connection state", () => {
    const c = renderPane();
    expect(c.querySelector("[data-pane='harnesses']")).toBeTruthy();
    expect(c.textContent).toContain("OpenCode");
    expect(c.textContent).toContain("Codex");
    expect(c.textContent).toContain("ready");
    expect(c.textContent).toContain("not installed");
  });

  it("lists cached models per harness", () => {
    const c = renderPane();
    expect(c.textContent).toContain("GPT-4");
    expect(c.textContent).toContain("Models (1)");
  });

  it("refresh button re-probes all harnesses", async () => {
    const loadHarnesses = vi.fn();
    useAppStore.setState({ loadHarnesses });
    const c = renderPane();
    await act(async () => {
      (c.querySelector("[title='Re-probe all harnesses']") as HTMLElement)!.click();
      await Promise.resolve();
    });
    expect(loadHarnesses).toHaveBeenCalledTimes(1);
  });
});
