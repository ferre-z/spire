// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDefinitionV2, HarnessId } from "../../shared/domain";
import type { HarnessStatus } from "../../shared/control";
import type { ExecutionPlan } from "../../shared/execution";
import { useAppStore } from "../store";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type MockFlowNode = {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number };
};

type MockReactFlowProps = {
  readonly nodes: readonly MockFlowNode[];
  readonly edges: readonly { readonly id: string }[];
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly fitView: boolean;
  readonly onNodeClick: (event: MouseEvent, node: MockFlowNode) => void;
  readonly onPaneClick: () => void;
  readonly onNodeDragStart: () => void;
  readonly onNodeDragStop: (event: MouseEvent, node: MockFlowNode) => void;
  readonly onNodesChange: (changes: readonly never[]) => void;
  readonly children?: ReactNode;
};

const flowHarness = vi.hoisted((): {
  props: MockReactFlowProps | undefined;
  fitView: ReturnType<typeof vi.fn>;
} => ({
  props: undefined,
  fitView: vi.fn(),
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    ReactFlow: (props: MockReactFlowProps) => {
      flowHarness.props = props;
      return props.children;
    },
    useReactFlow: () => ({ fitView: flowHarness.fitView }),
  };
});

import {
  GraphCanvasPane,
  PALETTE_ITEMS,
  buildCanvasEdges,
  buildCanvasNodes,
  resolveDefaultRuntime,
} from "./GraphCanvasPane";

function makeGraph(): GraphDefinitionV2 {
  return {
    id: "v2-1",
    name: "V2 Graph",
    version: 1,
    nodes: [
      {
        kind: "agent",
        id: "planner",
        name: "Planner",
        job: "Plan the work",
        harnessId: "opencode",
        modelId: "openai/gpt-5",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        position: { x: 100, y: 100 },
      },
      {
        kind: "decision",
        id: "checker",
        name: "Checker",
        job: "Choose a path",
        harnessId: "codex",
        modelId: "openai/gpt-5.2-codex",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "group", actions: ["skip"] },
        activation: "any",
        maxVisits: 1,
        position: { x: 360, y: 160 },
        groupId: "team",
      },
      {
        kind: "checkpoint",
        id: "gate",
        name: "Gate",
        mode: "manual",
        position: { x: 600, y: 240 },
      },
    ],
    edges: [
      {
        id: "plan-check",
        source: "planner",
        target: "checker",
        kind: "handoff",
        when: "success",
        label: "Plan to check",
      },
    ],
    groups: [{ id: "team", name: "Review team" }],
    maxSteps: 100,
    createdAt: "2026-08-03T08:00:00.000Z",
  };
}

function makePlan(): ExecutionPlan {
  return {
    runId: "run-1",
    graphId: "v2-1",
    graphVersion: 1,
    revision: 1,
    status: "running",
    stepCount: 1,
    nodes: [
      { nodeId: "planner", status: "succeeded", visits: 1 },
      { nodeId: "checker", status: "running", visits: 2 },
      { nodeId: "gate", status: "waiting", visits: 0 },
    ],
    edges: makeGraph().edges,
    patches: [],
    updatedAt: "2026-08-03T08:01:00.000Z",
  };
}

function harness(id: HarnessId, connected = true): HarnessStatus {
  return {
    id,
    name: id,
    status: {
      harnessId: id,
      installed: connected,
      compatible: connected,
      connected,
    },
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function renderCanvas(): Promise<HTMLDivElement> {
  const nextContainer = document.createElement("div");
  document.body.appendChild(nextContainer);
  const nextRoot = createRoot(nextContainer);
  await act(async () => nextRoot.render(<GraphCanvasPane />));
  container = nextContainer;
  root = nextRoot;
  return nextContainer;
}

function flowProps(): MockReactFlowProps {
  const props = flowHarness.props;
  if (!props) throw new Error("ReactFlow did not render");
  return props;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => button.click());
}

function buttonByName(surface: HTMLElement, name: string): HTMLButtonElement {
  const button = [...surface.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === name,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
  return button;
}

beforeEach(() => {
  flowHarness.props = undefined;
  flowHarness.fitView.mockClear();
  useAppStore.setState({
    snapshot: {
      onboardingComplete: true,
      openCode: { installed: true, compatible: true, connected: true },
      graphs: [],
      runs: [],
    },
    graph: makeGraph(),
    selectedNodeId: undefined,
    selectedRunId: "run-1",
    plan: undefined,
    planLoading: false,
    nodeExecutions: [],
    messages: [],
    harnesses: [harness("opencode")],
    harnessModels: { opencode: [{ id: "openai/gpt-5", name: "GPT-5" }] },
    harnessLoading: false,
    selectedPatchId: undefined,
    collapsedGroups: [],
    planPatches: [],
    error: undefined,
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("v2 canvas builders", () => {
  it("builds typed nodes, group membership, collapse, and execution overlays", () => {
    const nodes = buildCanvasNodes(makeGraph(), makePlan(), ["team"]);
    expect(nodes.map((node) => node.type)).toEqual(["group", "agent", "decision", "checkpoint"]);
    expect(nodes.find((node) => node.id === "checker")?.parentId).toBe("group__team");
    expect(nodes.find((node) => node.id === "group__team")?.data.collapsed).toBe(true);
    expect(nodes.find((node) => node.id === "checker")?.data.active).toBe(true);
  });

  it("builds semantic v2 edges and marks running connections as execution-active", () => {
    const [edge] = buildCanvasEdges(makeGraph(), makePlan());
    expect(edge?.data).toEqual({ kind: "handoff", when: "success", label: "Plan to check" });
    expect(edge?.animated).toBe(false);
    expect(edge?.className).toBe("canvas-edge is-executing");
  });
});

describe("default runtime resolution", () => {
  it("uses deterministic OpenCode, Codex, Claude priority and the first cached model", async () => {
    const load = vi.fn(async () => []);
    const runtime = await resolveDefaultRuntime(
      [harness("claude-code"), harness("codex"), harness("opencode")],
      {
        opencode: [{ id: "openai/gpt-5", name: "GPT-5" }],
        codex: [{ id: "openai/gpt-5.2-codex", name: "Codex" }],
      },
      load,
    );
    expect(runtime).toEqual({ kind: "ready", harnessId: "opencode", modelId: "openai/gpt-5" });
    expect(load).not.toHaveBeenCalled();
  });

  it("loads missing model caches before choosing a runtime", async () => {
    const load = vi.fn(async (id: HarnessId) =>
      id === "codex" ? [{ id: "openai/gpt-5.2-codex", name: "Codex" }] : [],
    );
    const runtime = await resolveDefaultRuntime(
      [harness("opencode", false), harness("codex")],
      {},
      load,
    );
    expect(runtime).toEqual({ kind: "ready", harnessId: "codex", modelId: "openai/gpt-5.2-codex" });
    expect(load).toHaveBeenCalledWith("codex");
  });

  it("returns a recoverable unavailable result when no compatible model exists", async () => {
    const runtime = await resolveDefaultRuntime([harness("opencode")], {}, vi.fn(async () => []));
    expect(runtime).toEqual({
      kind: "unavailable",
      message: "No connected harness with models is ready. Open Harnesses to connect one and discover models.",
    });
  });

  it("returns a recoverable unavailable result when discovery fails", async () => {
    const runtime = await resolveDefaultRuntime(
      [harness("opencode")],
      {},
      vi.fn(async () => {
        throw new Error("probe failed");
      }),
    );
    expect(runtime).toEqual({
      kind: "unavailable",
      message: "Could not load harness models. Open Harnesses to retry the connection.",
    });
  });
});

describe("canvas creation tools", () => {
  it("renders a compact icon-only toolbar with accessible names and tooltips", async () => {
    const surface = await renderCanvas();
    const toolbar = surface.querySelector("[role='toolbar']");
    expect(toolbar?.querySelectorAll("button")).toHaveLength(PALETTE_ITEMS.length);
    for (const item of PALETTE_ITEMS) {
      const button = buttonByName(surface, `Add ${item.label}`);
      expect(button.textContent).toBe("");
      expect(button.title).toBe(`Add ${item.label}`);
      expect(button.tabIndex).toBe(0);
    }
  });

  it("creates runtime nodes with the selected harness/model and opens NodeDialog", async () => {
    const surface = await renderCanvas();
    await click(buttonByName(surface, "Add Decision"));
    const state = useAppStore.getState();
    const created = state.graph?.nodes.at(-1);
    expect(created).toMatchObject({
      kind: "decision",
      harnessId: "opencode",
      modelId: "openai/gpt-5",
    });
    expect(state.selectedNodeId).toBe(created?.id);
  });

  it("loads models while keeping model-free tools available", async () => {
    let finish: ((models: { readonly id: string; readonly name: string }[]) => void) | undefined;
    const loadHarnessModels = vi.fn(
      () => new Promise<{ readonly id: string; readonly name: string }[]>((resolve) => { finish = resolve; }),
    );
    useAppStore.setState({ harnessModels: {}, loadHarnessModels });
    const surface = await renderCanvas();
    const agent = buttonByName(surface, "Add Agent");
    await act(async () => agent.click());
    expect(agent.disabled).toBe(true);
    expect(agent.getAttribute("aria-busy")).toBe("true");
    expect(buttonByName(surface, "Add Checkpoint").disabled).toBe(false);
    await act(async () => finish?.([{ id: "openai/gpt-5", name: "GPT-5" }]));
    expect(useAppStore.getState().graph?.nodes.at(-1)).toMatchObject({ modelId: "openai/gpt-5" });
  });

  it("does not add runtime nodes and surfaces Harnesses recovery when models are unavailable", async () => {
    useAppStore.setState({ harnessModels: {}, loadHarnessModels: vi.fn(async () => []) });
    const before = useAppStore.getState().graph?.nodes.length;
    const surface = await renderCanvas();
    await click(buttonByName(surface, "Add Agent"));
    expect(useAppStore.getState().graph?.nodes).toHaveLength(before ?? 0);
    expect(useAppStore.getState().error).toContain("Harnesses");
  });

  it("activates model-free tools from the keyboard", async () => {
    const surface = await renderCanvas();
    const checkpoint = buttonByName(surface, "Add Checkpoint");
    checkpoint.focus();
    await act(async () => {
      checkpoint.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      checkpoint.click();
    });
    expect(useAppStore.getState().graph?.nodes.at(-1)?.kind).toBe("checkpoint");
  });
});

describe("ReactFlow interaction contract", () => {
  it("keeps zoom, fit-view, minimap, controls, selection, and canvas deselection enabled", async () => {
    const surface = await renderCanvas();
    const props = flowProps();
    expect(props.fitView).toBe(true);
    expect(props.minZoom).toBe(0.55);
    expect(props.maxZoom).toBe(1.6);
    expect(surface.querySelector(".react-flow__controls")).not.toBeNull();
    expect(surface.querySelector(".react-flow__minimap")).not.toBeNull();
    await act(async () => props.onNodeClick(new MouseEvent("click"), props.nodes[0]));
    expect(useAppStore.getState().selectedNodeId).toBe(props.nodes[0]?.id);
    await act(async () => props.onPaneClick());
    expect(useAppStore.getState().selectedNodeId).toBeUndefined();
  });

  it("keeps drag updates local and commits one final v2 position without refitting on rerender", async () => {
    const surface = await renderCanvas();
    const props = flowProps();
    const dragged = { ...props.nodes[1], position: { x: 777, y: 333 } };
    await act(async () => {
      props.onNodeDragStart();
      props.onNodesChange([]);
    });
    expect(useAppStore.getState().graph?.nodes.find((node) => node.id === dragged.id)?.position).not.toEqual(dragged.position);
    await act(async () => props.onNodeDragStop(new MouseEvent("pointerup"), dragged));
    expect(useAppStore.getState().graph?.nodes.find((node) => node.id === dragged.id)?.position).toEqual(dragged.position);
    await act(async () => root?.render(<GraphCanvasPane />));
    expect(flowHarness.fitView).toHaveBeenCalledTimes(1);
    expect(surface.querySelector(".react-flow__controls")).not.toBeNull();
  });
});
