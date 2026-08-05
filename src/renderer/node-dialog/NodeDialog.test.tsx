// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDefinitionV2, GraphNode } from "../../shared/domain";
import { useAppStore } from "../store";
import { NodeDialog } from "./NodeDialog";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const agent: GraphNode = {
  kind: "agent",
  id: "builder",
  name: "Builder",
  job: "Build it",
  harnessId: "opencode",
  modelId: "missing-model",
  access: { mode: "workspace-write", writeScopes: ["src/**"] },
  authority: { scope: "self", actions: ["retry"] },
  activation: "any",
  maxVisits: 3,
  thinkingEffort: "medium",
  skills: [],
  goal: "",
  subGoals: [],
  integrations: [],
  position: { x: 0, y: 0 },
};

function graphWith(node: GraphNode): GraphDefinitionV2 {
  return {
    id: "graph",
    name: "Graph",
    version: 7,
    maxSteps: 40,
    createdAt: "2026-08-03T10:00:00.000Z",
    nodes: [node],
    edges: [],
    groups: [],
  };
}

async function renderDialog(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<NodeDialog />));
}

function setSelect(label: string, value: string): void {
  const select = document.querySelector<HTMLSelectElement>(`select[aria-label='${label}']`);
  if (!select) throw new Error(`Missing ${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (!setter) throw new Error("Select value setter unavailable");
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const loadHarnesses = vi.fn(async () => undefined);
  const loadHarnessModels = vi.fn(async () => []);
  useAppStore.setState({
    graph: graphWith(agent),
    selectedNodeId: "builder",
    selectedRunId: "run",
    harnesses: [
      { id: "opencode", name: "OpenCode", status: { harnessId: "opencode", installed: true, compatible: true, connected: true } },
      { id: "codex", name: "Codex", status: { harnessId: "codex", installed: true, compatible: true, connected: true } },
    ],
    harnessModels: { opencode: [{ id: "available-model", name: "Available" }] },
    nodeExecutions: [],
    messages: [],
    error: undefined,
    validationResult: undefined,
    loadHarnesses,
    loadHarnessModels,
    changeNodeHarness: vi.fn(async () => undefined),
    saveCurrentGraph: vi.fn(async () => true),
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = undefined;
  container = undefined;
});

describe("NodeDialog", () => {
  it.each([
    ["agent", agent, "JOB"],
    ["decision", { ...agent, kind: "decision", id: "decision" }, "AUTHORITY"],
    ["checkpoint", { kind: "checkpoint", id: "gate", name: "Gate", mode: "manual", position: { x: 0, y: 0 } }, "CHECKPOINT"],
    ["subgraph", { kind: "subgraph", id: "child", name: "Child", graphId: "other", graphVersion: 2, position: { x: 0, y: 0 } }, "SUBGRAPH"],
  ] satisfies readonly (readonly [string, GraphNode, string])[])("renders %s settings", async (_kind, node, heading) => {
    useAppStore.setState({ graph: graphWith(node), selectedNodeId: node.id });

    await renderDialog();

    expect(document.querySelector("[role='dialog']")).toBeTruthy();
    expect(document.body.textContent).toContain(heading);
  });

  it("loads harnesses and models and preserves an unavailable current model", async () => {
    await renderDialog();

    expect(useAppStore.getState().loadHarnesses).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().loadHarnessModels).toHaveBeenCalledWith("opencode");
    expect(document.querySelector<HTMLInputElement>("input[aria-label='Model']")?.value).toBe("missing-model");
    expect(document.body.textContent).toContain("Unavailable — missing-model");
  });

  it("awaits the atomic harness change action", async () => {
    let finish: (() => void) | undefined;
    const changeNodeHarness = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    useAppStore.setState({ changeNodeHarness });
    await renderDialog();

    await act(async () => setSelect("Harness", "codex"));

    expect(changeNodeHarness).toHaveBeenCalledWith("builder", "codex");
    expect(document.querySelector<HTMLSelectElement>("select[aria-label='Harness']")?.disabled).toBe(true);
    await act(async () => finish?.());
    expect(document.querySelector<HTMLSelectElement>("select[aria-label='Harness']")?.disabled).toBe(false);
  });

  it("keeps live edits after close and reopen", async () => {
    await renderDialog();
    const name = document.querySelector<HTMLInputElement>("input[aria-label='Node name']");
    if (!name) throw new Error("Missing node name input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Input value setter unavailable");
    await act(async () => {
      setter.call(name, "Renamed");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>("button[aria-label='Close node dialog']")?.click());
    await act(async () => useAppStore.getState().selectNode("builder"));

    expect(document.querySelector<HTMLInputElement>("input[aria-label='Node name']")?.value).toBe("Renamed");
  });

  it("closes on Escape and restores focus to the prior canvas element", async () => {
    const canvasButton = document.createElement("button");
    canvasButton.textContent = "Canvas node";
    document.body.appendChild(canvasButton);
    canvasButton.focus();
    await renderDialog();

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    expect(useAppStore.getState().selectedNodeId).toBeUndefined();
    expect(document.activeElement).toBe(canvasButton);
  });

  it("defaults the responsive segmented navigation to Settings", async () => {
    await renderDialog();

    expect(document.querySelector("[data-node-dialog-section='settings']")?.getAttribute("data-active")).toBe("true");
    expect(document.querySelector("[aria-label='Node dialog section'] [aria-checked='true']")?.textContent).toContain("Settings");
  });

  it("moves compact section focus with arrow keys and wraps at the ends", async () => {
    await renderDialog();
    const radios = [...document.querySelectorAll<HTMLButtonElement>("[aria-label='Node dialog section'] [role='radio']")];
    const input = radios[0];
    const settings = radios[1];
    const output = radios[2];
    if (!input || !settings || !output) throw new Error("Missing node dialog section controls");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);

    settings.focus();
    await act(async () => settings.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(output);
    expect(output.getAttribute("aria-checked")).toBe("true");
    await act(async () => output.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-checked")).toBe("true");
  });

  it("moves compact section focus to boundaries with Home and End", async () => {
    await renderDialog();
    const radios = [...document.querySelectorAll<HTMLButtonElement>("[aria-label='Node dialog section'] [role='radio']")];
    const input = radios[0];
    const settings = radios[1];
    const output = radios[2];
    if (!input || !settings || !output) throw new Error("Missing node dialog section controls");

    settings.focus();
    await act(async () => settings.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(output);
    await act(async () => output.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(input);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(document.activeElement).toBe(output);
  });

  it("keeps the dialog open and shows inline validation after save", async () => {
    const saveCurrentGraph = vi.fn(async () => {
      useAppStore.setState({ validationResult: { valid: false, issues: ["Name is required"] } });
      return false;
    });
    useAppStore.setState({ saveCurrentGraph });
    await renderDialog();

    await act(async () => document.querySelector<HTMLButtonElement>("button[data-action='save-node-dialog']")?.click());

    expect(saveCurrentGraph).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[role='dialog']")).toBeTruthy();
    expect(document.querySelector("[role='alert']")?.textContent).toContain("Name is required");
  });
});
