// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDefinitionV2, GraphNode } from "../../shared/domain";
import { useAppStore } from "../store";
import { BrainTab } from "./BrainTab";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const agent: GraphNode = {
  kind: "agent",
  id: "builder",
  name: "Builder",
  job: "Build it",
  harnessId: "opencode",
  modelId: "model-a",
  access: { mode: "workspace-write", writeScopes: ["src/**"] },
  authority: { scope: "self", actions: ["retry"] },
  activation: "any",
  maxVisits: 3,
  thinkingEffort: "medium",
  skills: ["typescript"],
  goal: "",
  subGoals: [],
  integrations: [],
  position: { x: 0, y: 0 },
};

const MODELS = [
  { id: "model-a", name: "Alpha Model" },
  { id: "model-b", name: "Beta Model" },
];

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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Input value setter unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (!setter) throw new Error("Select value setter unavailable");
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function currentNode(): Extract<GraphNode, { readonly kind: "agent" | "decision" }> | undefined {
  const node = useAppStore.getState().graph?.nodes.find((item) => item.id === agent.id);
  return node && (node.kind === "agent" || node.kind === "decision") ? node : undefined;
}

function Harness({ node }: { readonly node: GraphNode }) {
  const liveNode = useAppStore((state) => state.graph?.nodes.find((item) => item.id === node.id));
  return liveNode ? <BrainTab node={liveNode} /> : null;
}

async function renderTab(node: GraphNode = agent): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<Harness node={node} />));
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const loadHarnessModels = vi.fn(async () => MODELS);
  useAppStore.setState({
    graph: graphWith(agent),
    selectedNodeId: "builder",
    selectedRunId: "run",
    harnesses: [
      { id: "opencode", name: "OpenCode", status: { harnessId: "opencode", installed: true, compatible: true, connected: true } },
      { id: "codex", name: "Codex", status: { harnessId: "codex", installed: true, compatible: true, connected: true } },
    ],
    harnessModels: { opencode: MODELS },
    nodeExecutions: [],
    messages: [],
    error: undefined,
    validationResult: undefined,
    loadHarnesses: vi.fn(async () => undefined),
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

describe("BrainTab", () => {
  it("renders a no-op guard for non-agent/decision nodes", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const checkpoint = { kind: "checkpoint", id: "gate", name: "Gate", mode: "manual", position: { x: 0, y: 0 } } as GraphNode;
    await act(async () => root?.render(<BrainTab node={checkpoint} />));

    expect(document.querySelector(".node-dialog-empty")?.textContent).toContain("Only agent and decision nodes have a brain.");
    expect(document.querySelector("[data-model-search]")).toBeNull();
  });

  it("lists harnesses with connected/offline state and disables offline ones", async () => {
    useAppStore.setState({
      harnesses: [
        { id: "opencode", name: "OpenCode", status: { harnessId: "opencode", installed: true, compatible: true, connected: true } },
        { id: "codex", name: "Codex", status: { harnessId: "codex", installed: true, compatible: true, connected: false } },
      ],
    });
    await renderTab();

    const harness = document.querySelector<HTMLSelectElement>("select[aria-label='Harness']");
    expect(harness?.textContent).toContain("OpenCode · connected");
    const options = [...document.querySelectorAll<HTMLOptionElement>("select[aria-label='Harness'] option")];
    expect(options[0]?.disabled).toBe(false);
    expect(options[1]?.disabled).toBe(true);
  });

  it("typing in the search input filters model options case-insensitively on name or id", async () => {
    await renderTab();
    const search = document.querySelector<HTMLInputElement>("[data-model-search]");
    if (!search) throw new Error("Missing model search input");
    expect(search.value).toBe("Alpha Model");

    await act(async () => setInputValue(search, "BETA"));
    let options = [...document.querySelectorAll<HTMLButtonElement>("[data-model-option]")];
    expect(options.map((option) => option.textContent)).toEqual(["Beta Modelmodel-b"]);

    await act(async () => setInputValue(search, "model-a"));
    options = [...document.querySelectorAll<HTMLButtonElement>("[data-model-option]")];
    expect(options.map((option) => option.textContent)).toEqual(["Alpha Modelmodel-a"]);
  });

  it("selecting an option calls updateNode with the model id and fills the input", async () => {
    await renderTab();
    const search = document.querySelector<HTMLInputElement>("[data-model-search]");
    if (!search) throw new Error("Missing model search input");

    await act(async () => setInputValue(search, "BETA"));
    const option = document.querySelector<HTMLButtonElement>("[data-model-option]");
    if (!option) throw new Error("Missing model option");
    await act(async () => option.click());

    expect(currentNode()?.modelId).toBe("model-b");
    expect(search.value).toBe("Beta Model");
  });

  it("supports keyboard highlight and Enter selection", async () => {
    await renderTab();
    const search = document.querySelector<HTMLInputElement>("[data-model-search]");
    if (!search) throw new Error("Missing model search input");

    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.querySelector<HTMLButtonElement>("[data-model-option][data-highlighted='true']")?.textContent).toContain("Alpha Model");
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

    expect(currentNode()?.modelId).toBe("model-a");
  });

  it("shows the empty row and refresh button when no models are loaded", async () => {
    useAppStore.setState({ harnessModels: {} });
    const loadHarnessModels = vi.fn(async () => []);
    useAppStore.setState({ loadHarnessModels });
    await renderTab();

    const search = document.querySelector<HTMLInputElement>("[data-model-search]");
    if (!search) throw new Error("Missing model search input");
    await act(async () => search.dispatchEvent(new Event("focusin", { bubbles: true })));

    expect(document.querySelector("[data-model-empty]")?.textContent).toContain("No models — refresh");
    await act(async () => document.querySelector<HTMLButtonElement>("button[aria-label='Refresh models']")?.click());
    expect(loadHarnessModels).toHaveBeenCalledWith("opencode");
  });

  it("moves the thinking effort slider to high", async () => {
    await renderTab();
    const slider = document.querySelector<HTMLInputElement>("[data-thinking-effort]");
    if (!slider) throw new Error("Missing thinking effort slider");
    expect(slider.value).toBe("1");

    await act(async () => setInputValue(slider, "2"));
    expect(currentNode()?.thinkingEffort).toBe("high");
    expect(document.querySelector("[data-thinking-effort]")?.getAttribute("value")).toBe("2");
  });

  it("adds, removes, and dedupes skills", async () => {
    await renderTab();
    const input = document.querySelector<HTMLInputElement>("[data-skill-input]");
    if (!input) throw new Error("Missing skill input");

    await act(async () => setInputValue(input, "  testing  "));
    await act(async () => document.querySelector<HTMLButtonElement>("[data-skill-add]")?.click());
    expect(currentNode()?.skills).toEqual(["typescript", "testing"]);

    await act(async () => setInputValue(input, "TESTING"));
    await act(async () => document.querySelector<HTMLButtonElement>("[data-skill-add]")?.click());
    expect(currentNode()?.skills).toEqual(["typescript", "testing"]);

    await act(async () => setInputValue(input, "   "));
    await act(async () => document.querySelector<HTMLButtonElement>("[data-skill-add]")?.click());
    expect(currentNode()?.skills).toEqual(["typescript", "testing"]);

    const rows = [...document.querySelectorAll<HTMLElement>("[data-skill-row]")];
    expect(rows.map((row) => row.textContent)).toEqual(["typescript", "testing"]);
    await act(async () => rows[0]?.querySelector<HTMLButtonElement>("[data-skill-remove]")?.click());
    expect(currentNode()?.skills).toEqual(["testing"]);
  });

  it("adds a skill with Enter in the input", async () => {
    await renderTab();
    const input = document.querySelector<HTMLInputElement>("[data-skill-input]");
    if (!input) throw new Error("Missing skill input");

    await act(async () => setInputValue(input, "debugging"));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(currentNode()?.skills).toEqual(["typescript", "debugging"]);
  });

  it("writes activation and maxVisits through updateNode", async () => {
    await renderTab();

    const activation = document.querySelector<HTMLSelectElement>("select[aria-label='Activation']");
    if (!activation) throw new Error("Missing activation select");
    await act(async () => setSelectValue(activation, "all"));
    expect(currentNode()?.activation).toBe("all");

    const maxVisits = document.querySelector<HTMLInputElement>("input[aria-label='Max visits']");
    if (!maxVisits) throw new Error("Missing max visits input");
    await act(async () => setInputValue(maxVisits, "5"));
    expect(currentNode()?.maxVisits).toBe(5);
  });

  it("switches harness through changeNodeHarness", async () => {
    await renderTab();
    const harness = document.querySelector<HTMLSelectElement>("select[aria-label='Harness']");
    if (!harness) throw new Error("Missing harness select");

    await act(async () => setSelectValue(harness, "codex"));
    expect(useAppStore.getState().changeNodeHarness).toHaveBeenCalledWith("builder", "codex");
  });
});
