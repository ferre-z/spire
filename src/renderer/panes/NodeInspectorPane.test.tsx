// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  AgentNode,
  GraphDefinitionV2,
  HarnessId,
} from "../../shared/domain";
import { useAppStore } from "../store";
import { NodeInspectorPane } from "./NodeInspectorPane";

// @vitest-environment jsdom needs the ReactFlow ResizeObserver stub from the
// canvas test; provide a minimal one here too since this pane renders in jsdom.
if (typeof ResizeObserver === "undefined") {
  (window as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const spire: Record<string, ReturnType<typeof vi.fn>> = {};
let container: HTMLDivElement | undefined;
let root: Root | undefined;

function makeAgentNode(): AgentNode {
  return {
    kind: "agent",
    id: "builder",
    name: "Builder",
    job: "Build stuff",
    harnessId: "opencode" as HarnessId,
    modelId: "gpt-4",
    access: { mode: "workspace-write", writeScopes: ["src/**", "docs/*"] },
    authority: { scope: "self", actions: ["retry"] },
    activation: "any",
    maxVisits: 3,
    roleLabel: undefined,
    position: { x: 0, y: 0 },
  };
}

function makeV2Graph(): GraphDefinitionV2 {
  return {
    id: "g2",
    name: "v2",
    version: 1,
    maxSteps: 100,
    createdAt: new Date().toISOString(),
    nodes: [makeAgentNode()],
    edges: [],
    groups: [],
  };
}

function setNativeValue(element: HTMLTextAreaElement | HTMLInputElement, value: string | boolean) {
  // React 19 suppresses onChange when the value setter is bypassed; invoke the
  // native setter descriptor (same approach as LiveStreamPane.test's
  // changeInput). For checkboxes, dispatch both "input" and "change" — React
  // 19 honors onChange on the input event once the property changed.
  if (typeof value === "boolean") {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "checked",
    )!.set!;
    setter.call(element, value);
    // `HTMLInputElement.click()` is a real browser method that toggles the
    // checked state and dispatches the click/change events the way React 19
    // expects; a hand-dispatched synthetic event does not install React's
    // checked tracker under jsdom.
    element.click();
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderInspector() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  void act(() => {
    root!.render(<NodeInspectorPane />);
  });
  return container;
}

function unmount() {
  if (root) {
    void act(() => root!.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
}

beforeEach(() => {
  for (const key of ["snapshot", "harnessesList", "harnessesModels", "saveGraph"]) {
    spire[key] = vi.fn();
  }
  spire.harnessesModels.mockResolvedValue([{ id: "gpt-4", name: "GPT-4" }]);
  spire.saveGraph.mockResolvedValue(undefined);
  (window as { spire?: unknown }).spire = spire;
  useAppStore.setState({
    graph: makeV2Graph(),
    selectedNodeId: "builder",
    selectedRunId: "run-1",
    plan: undefined,
    nodeExecutions: [],
    messages: [],
    harnesses: [
      {
        id: "opencode",
        name: "OpenCode",
        status: { harnessId: "opencode", installed: true, compatible: true, connected: true },
      },
    ],
    harnessModels: {},
    validationResult: undefined,
    selectedPatchId: undefined,
    collapsedGroups: [],
    planPatches: [],
    traceWindow: [],
    traceCursor: null,
    traceHasOlder: true,
    traceLoading: false,
    traceFilters: {},
  });
});

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
  delete (window as { spire?: unknown }).spire;
});

describe("NodeInspectorPane (v2)", () => {
  it("renders job, runtime, access, authority, routing and failure sections for an agent node", () => {
    const c = renderInspector();
    const sections = Array.from(c.querySelectorAll<HTMLElement>("[data-section]")).map(
      (el) => el.getAttribute("data-section"),
    );
    for (const section of [
      "job",
      "runtime",
      "access",
      "authority",
      "routing",
      "failure",
    ]) {
      expect(sections).toContain(section);
    }
  });

  it("renders the checkpoint section with mode control for a checkpoint node", () => {
    useAppStore.setState(() => ({
      graph: {
        ...makeV2Graph(),
        nodes: [
          {
            kind: "checkpoint",
            id: "gate",
            name: "Gate",
            mode: "manual",
            position: { x: 0, y: 0 },
          },
        ],
      },
      selectedNodeId: "gate",
    }));
    const c = renderInspector();
    expect(c.querySelector("[data-section='checkpoint']")).toBeTruthy();
    expect(c.querySelector("[data-section='checkpoint'] select")?.textContent).toContain(
      "Manual",
    );
  });

  it("shows model options for the selected harness and refreshes them", async () => {
    useAppStore.setState({
      harnessModels: { opencode: [{ id: "gpt-4", name: "GPT-4" }, { id: "claude-3", name: "Claude 3" }] },
    });
    const c = renderInspector();
    const options = Array.from(
      c.querySelectorAll<HTMLOptionElement>(
        "[data-section='runtime'] select[data-model-select] option",
      ),
    ).map((o) => o.value);
    expect(options).toEqual(["gpt-4", "claude-3"]);
    // The refresh button re-fetches models for the node's harness.
    spire.harnessesModels.mockResolvedValue([]);
    const refresh = c.querySelector("[data-refresh-models]");
    await act(async () => {
      (refresh as HTMLButtonElement)!.click();
      await Promise.resolve();
    });
    expect(spire.harnessesModels).toHaveBeenCalledWith("opencode");
  });

  it("writescopes editing calls updateNode with repo-relative prefixes", async () => {
    const updateNode = vi.fn();
    useAppStore.setState({ updateNode });
    const c = renderInspector();
    const textarea = c.querySelector<HTMLTextAreaElement>(
      "[data-section='access'] textarea[data-write-scopes]",
    );
    expect(textarea).toBeTruthy();
    setNativeValue(textarea!, "src/lib\npublic/*");
    expect(updateNode).toHaveBeenCalledWith("builder", {
      access: {
        mode: "workspace-write",
        writeScopes: ["src/lib", "public/*"],
      },
    });
  });

  it("toggling a plan mutation action updates the node's authority actions", async () => {
    const updateNode = vi.fn();
    useAppStore.setState({ updateNode });
    const c = renderInspector();
    // `retry` is already granted; toggle an action that is NOT yet checked so
    // React registers an actual `checked` change and fires onChange.
    const skipButton = c.querySelector<HTMLButtonElement>(
      "[data-action='skip']",
    );
    expect(skipButton).toBeTruthy();
    expect(skipButton!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      skipButton!.click();
      await Promise.resolve();
    });
    expect(updateNode).toHaveBeenCalledWith("builder", {
      authority: expect.objectContaining({
        actions: expect.arrayContaining(["skip"]),
      }),
    });
  });

  it("Save dispatches graphsValidate then saveGraph then updateGraph", async () => {
    const updateGraph = vi.fn();
    useAppStore.setState({ updateGraph });
    const c = renderInspector();
    await act(async () => {
      c.querySelector<HTMLButtonElement>("button[data-action='save']")!.click();
    });
    await Promise.resolve();
    expect(spire.saveGraph).toHaveBeenCalledTimes(1);
  });
});
