// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// @xyflow/react constructs a ResizeObserver in an effect; jsdom doesn't ship
// one. A no-op class is sufficient for the canvas's crash-only component tests
// (real resize sizing is not asserted here).
if (typeof ResizeObserver === "undefined") {
  (window as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// @xyflow/react constructs a ResizeObserver in its effect; jsdom doesn't ship
// one. A no-op stub is sufficient for the crash-only component tests here (the
// canvas's own fitView fallback handles the absence of real resize events).
if (typeof ResizeObserver === "undefined") {
  (window as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
import type {
  GraphDefinition,
  GraphDefinitionV2,
} from "../../shared/domain";
import type { ExecutionPlan } from "../../shared/execution";
import { useAppStore } from "../store";

// These are the functions we expect GraphCanvasPane to export.
// They don't exist yet — tests will fail (RED).
import {
  PALETTE_ITEMS,
  buildCanvasNodes,
  buildCanvasEdges,
  GraphCanvasPane,
} from "./GraphCanvasPane";

function makeLegacyGraph(): GraphDefinition {
  return {
    id: "legacy-1",
    name: "Legacy Graph",
    version: 1,
    nodes: [
      {
        id: "planner",
        type: "opencode",
        role: "planner",
        name: "Architect",
        instructions: "Plan.",
        model: "gpt-4",
        position: { x: 100, y: 100 },
      },
      {
        id: "implementer",
        type: "opencode",
        role: "implementer",
        name: "Builder",
        instructions: "Build.",
        model: "gpt-4",
        position: { x: 400, y: 100 },
      },
    ],
    edges: [
      {
        id: "build-review",
        source: "implementer",
        target: "planner",
        condition: "always",
        label: "Build → Review",
      },
      {
        id: "revise",
        source: "planner",
        target: "implementer",
        condition: "accepted",
        label: "Revise → Implement",
      },
    ],
    maxIterations: 3,
    createdAt: new Date().toISOString(),
  };
}

function makeV2Graph(): GraphDefinitionV2 {
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
        modelId: "gpt-4",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "self", actions: [] },
        activation: "all",
        maxVisits: 3,
        position: { x: 100, y: 100 },
      },
      {
        kind: "agent",
        id: "builder",
        name: "Builder",
        job: "Build the work",
        harnessId: "opencode",
        modelId: "gpt-4",
        access: { mode: "workspace-write", writeScopes: ["src"] },
        authority: { scope: "self", actions: ["edit"] },
        activation: "all",
        maxVisits: 3,
        position: { x: 400, y: 100 },
      },
      {
        kind: "decision",
        id: "checker",
        name: "Checker",
        job: "Decide",
        harnessId: "opencode",
        modelId: "gpt-4",
        access: { mode: "read-only", writeScopes: [] },
        authority: { scope: "group", actions: ["skip"] },
        activation: "any",
        maxVisits: 1,
        position: { x: 250, y: 250 },
      },
      {
        kind: "checkpoint",
        id: "gate",
        name: "Gate",
        mode: "manual",
        position: { x: 500, y: 200 },
      },
      {
        kind: "subgraph",
        id: "sub",
        name: "Sub-flow",
        graphId: "v2-1-sub",
        position: { x: 300, y: 400 },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "planner",
        target: "checker",
        kind: "handoff",
        when: "success",
        label: "Plan → Check",
      },
      {
        id: "e2",
        source: "checker",
        target: "builder",
        kind: "handoff",
        when: "success",
        label: "Check → Build",
      },
      {
        id: "e3",
        source: "builder",
        target: "gate",
        kind: "review",
        when: "success",
        label: "Build → Gate",
      },
    ],
    groups: [{ id: "grp-1", name: "Team A" }],
    maxSteps: 100,
    createdAt: new Date().toISOString(),
  };
}

function makePlanForV2(): ExecutionPlan {
  return {
    runId: "run-1",
    graphId: "v2-1",
    graphVersion: 1,
    revision: 1,
    status: "running",
    stepCount: 3,
    nodes: [
      { nodeId: "planner", status: "succeeded", visits: 1 },
      { nodeId: "checker", status: "running", visits: 2 },
      {
        nodeId: "builder",
        status: "waiting",
        visits: 0,
      },
      { nodeId: "gate", status: "queued", visits: 0 },
      { nodeId: "sub", status: "queued", visits: 0 },
    ],
    edges: makeV2Graph().edges,
    patches: [],
    updatedAt: new Date().toISOString(),
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function renderCanvas() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<GraphCanvasPane />);
  });
}

async function unmountCanvas() {
  if (!root) return;
  await act(async () => {
    root!.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
}

const spire = {
  snapshot: vi.fn(),
  harnessesList: vi.fn(),
  harnessesModels: vi.fn(),
  graphsValidate: vi.fn(),
};

beforeEach(() => {
  (window as { spire?: unknown }).spire = spire;
  useAppStore.setState({
    snapshot: {
      onboardingComplete: true,
      openCode: { installed: true, compatible: true, connected: true },
      models: [{ id: "gpt-4", name: "GPT-4" }],
      graphs: [],
      runs: [],
    },
    graph: undefined,
    selectedNodeId: undefined,
    selectedRunId: "run-1",
    plan: undefined,
    planLoading: false,
    nodeExecutions: [],
    messages: [],
    harnesses: [],
    harnessModels: {},
    selectedPatchId: undefined,
    collapsedGroups: [],
    planPatches: [],
  });
});

afterEach(async () => {
  await unmountCanvas();
  document.body.innerHTML = "";
  delete (window as { spire?: unknown }).spire;
});

describe("PALETTE_ITEMS", () => {
  it("exposes all five v2 block kinds", () => {
    const kinds = PALETTE_ITEMS.map((item) => item.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "agent",
        "decision",
        "checkpoint",
        "subgraph",
        "group",
      ]),
    );
    expect(kinds).toHaveLength(5);
  });

  it("provides a label and icon key for each kind", () => {
    for (const item of PALETTE_ITEMS) {
      expect(item.label).toMatch(/\S/);
      expect(item.icon).toBeDefined();
    }
  });
});

describe("buildCanvasNodes (legacy v1)", () => {
  it("renders two legacy agent nodes", () => {
    const graph = makeLegacyGraph();
    const nodes = buildCanvasNodes(graph);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.type)).toEqual(["legacy-agent", "legacy-agent"]);
    expect(nodes[0].id).toBe("planner");
    expect(nodes[1].id).toBe("implementer");
  });

  it("positions nodes from the graph definition", () => {
    const graph = makeLegacyGraph();
    const nodes = buildCanvasNodes(graph);
    expect(nodes[0].position).toEqual(graph.nodes[0].position);
    expect(nodes[1].position).toEqual(graph.nodes[1].position);
  });
});

describe("buildCanvasNodes (v2)", () => {
  it("renders a node for every v2 graph node with the matching kind type", () => {
    const graph = makeV2Graph();
    const nodes = buildCanvasNodes(graph);
    const byType = nodes.map((n) => n.type).sort();
    expect(byType).toEqual(
      expect.arrayContaining([
        "agent",
        "agent",
        "decision",
        "checkpoint",
        "subgraph",
      ]),
    );
    // 5 graph nodes + 1 group node
    expect(nodes).toHaveLength(6);
  });

  it("does not render group placeholder nodes when no groups exist", () => {
    const graph = makeV2Graph();
    // Remove the group
    const graphNoGroups = { ...graph, groups: [] };
    const nodes = buildCanvasNodes(graphNoGroups);
    expect(nodes.every((n) => n.type !== "group")).toBe(true);
  });

  it("renders group nodes for each defined group", () => {
    const graph = makeV2Graph();
    const nodes = buildCanvasNodes(graph);
    const groupNodes = nodes.filter((n) => n.type === "group");
    expect(groupNodes).toHaveLength(1);
    expect(groupNodes[0].id).toBe("group__grp-1");
  });

  it("sets collapsed=true on group nodes for collapsed group ids", () => {
    const graph = makeV2Graph();
    const nodes = buildCanvasNodes(graph, undefined, ["grp-1"]);
    const groupNode = nodes.find((n) => n.type === "group");
    expect(groupNode?.collapsed).toBe(true);
  });

  it("sets collapsed=false on group nodes when not in collapsed list", () => {
    const graph = makeV2Graph();
    const nodes = buildCanvasNodes(graph, undefined, []);
    const groupNode = nodes.find((n) => n.type === "group");
    expect(groupNode?.collapsed).toBe(false);
  });

  it("attaches execution status from the plan to node data", () => {
    const graph = makeV2Graph();
    const plan = makePlanForV2();
    const nodes = buildCanvasNodes(graph, plan);
    const checker = nodes.find((n) => n.id === "checker");
    expect(checker?.data?.execution?.status).toBe("running");
    expect(checker?.data?.execution?.visits).toBe(2);
  });

  it("marks nodes as active when the plan status is running", () => {
    const graph = makeV2Graph();
    const plan = makePlanForV2();
    const nodes = buildCanvasNodes(graph, plan);
    const checker = nodes.find((n) => n.id === "checker");
    expect(checker?.data?.active).toBe(true);
    const planner = nodes.find((n) => n.id === "planner");
    expect(planner?.data?.active).toBe(false);
  });

  it("wraps child nodes under their group parent", () => {
    const graph = makeV2Graph();
    const nodes = buildCanvasNodes(graph, undefined, []);
    const planner = nodes.find((n) => n.id === "planner");
    // No group membership in this fixture — planner should have no parent
    expect(planner?.parentId).toBeUndefined();
  });
});

describe("buildCanvasEdges (legacy v1)", () => {
  it("renders two legacy edges", () => {
    const graph = makeLegacyGraph();
    const edges = buildCanvasEdges(graph);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.id).sort()).toEqual(["build-review", "revise"]);
  });
});

describe("buildCanvasEdges (v2)", () => {
  it("renders an edge for every v2 graph edge with kind and when preserved", () => {
    const graph = makeV2Graph();
    const edges = buildCanvasEdges(graph);
    expect(edges).toHaveLength(3);
    const e1 = edges.find((e) => e.id === "e1")!;
    expect(e1.source).toBe("planner");
    expect(e1.target).toBe("checker");
    expect(e1).toHaveProperty("data");
  });

  it("animates edges whose source or target is running", () => {
    const graph = makeV2Graph();
    const plan = makePlanForV2();
    const edges = buildCanvasEdges(graph, plan);
    // checker is running → edge e1 (planner→checker) should be animated
    const e1 = edges.find((e) => e.id === "e1")!;
    expect(e1.animated).toBe(true);
    // gate is queued → edge e3 (builder→gate) should NOT be animated
    const e3 = edges.find((e) => e.id === "e3")!;
    expect(e3.animated).toBe(false);
  });
});

describe("GraphCanvasPane (component)", () => {
  it("renders without crashing for a legacy v1 graph", async () => {
    useAppStore.setState({ graph: makeLegacyGraph() });
    await renderCanvas();
    expect(container).toBeDefined();
    expect(container!.querySelector("[data-pane='graph-canvas']")).toBeDefined();
  });

  it("renders without crashing for a v2 graph", async () => {
    useAppStore.setState({ graph: makeV2Graph() });
    await renderCanvas();
    expect(container).toBeDefined();
  });

  it("renders the palette with five block buttons", async () => {
    useAppStore.setState({ graph: makeV2Graph() });
    await renderCanvas();
    const palette = container!.querySelector("[data-palette='node-palette']");
    expect(palette).toBeDefined();
    const buttons = palette!.querySelectorAll("button");
    expect(buttons).toHaveLength(5);
  });

  it("clicking a palette entry adds a node via the store", async () => {
    useAppStore.setState({ graph: makeV2Graph() });
    const addNode = vi.fn();
    useAppStore.setState({ addNode } as unknown as never);
    await renderCanvas();
    const buttons = container!.querySelectorAll("[data-palette] button");
    const decisionButton = Array.from(buttons).find(
      (b) => b.textContent?.includes("Decision"),
    );
    expect(decisionButton).toBeDefined();
    await act(async () => {
      decisionButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(addNode).toHaveBeenCalledTimes(1);
    expect(addNode).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "decision" }),
    );
  });

  it("renders coordinate banner", async () => {
    useAppStore.setState({ graph: makeLegacyGraph() });
    await renderCanvas();
    expect(container!.textContent).toContain("LOCAL / WORKTREE ISOLATED");
  });
});
