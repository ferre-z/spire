// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import { WorkspaceShell } from "./WorkspaceShell";
import { useWorkspaceUiStore } from "./workspaceUiStore";

vi.mock("../panes/GraphCanvasPane", () => ({
  GraphCanvasPane: () => <div>Graph canvas</div>,
}));
vi.mock("../panes/GraphLibraryPane", () => ({
  GraphLibraryPane: () => <div>Graph library</div>,
}));
vi.mock("../panes/RunHistoryPane", () => ({
  RunHistoryPane: () => <div>Run history</div>,
}));
vi.mock("../panes/HarnessesPane", () => ({
  HarnessesPane: () => <div>Harnesses</div>,
}));
vi.mock("../panes/CollaborationPane", () => ({
  CollaborationPane: () => <div>Collaboration</div>,
}));
vi.mock("../panes/GraphSettingsPane", () => ({
  GraphSettingsPane: () => <div>Graph settings</div>,
}));
vi.mock("../panes/RuntimePolicyPane", () => ({
  RuntimePolicyPane: () => <div>Runtime policy</div>,
}));
vi.mock("../panes/LiveStreamPane", () => ({
  LiveStreamPane: () => <div>Live stream</div>,
}));
vi.mock("../panes/DiffPane", () => ({
  DiffPane: () => <div>Diff output</div>,
}));
vi.mock("../panes/ResultPane", () => ({
  ResultPane: () => <div>Result output</div>,
}));
vi.mock("../panes/TaskLauncherPane", () => ({
  TaskLauncherPane: () => <input aria-label="Launch goal" />,
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function renderShell(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<WorkspaceShell />);
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  useAppStore.setState({
    snapshot: {
      onboardingComplete: true,
      openCode: { installed: true, compatible: true, connected: true },
      graphs: [],
      runs: [],
    },
    graph: {
      id: "graph-1",
      name: "Build graph",
      version: 2,
      nodes: [
        {
          kind: "checkpoint",
          id: "gate",
          name: "Gate",
          mode: "manual",
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      groups: [],
      maxSteps: 12,
      createdAt: new Date().toISOString(),
    },
    selectedNodeId: undefined,
    selectedRunId: undefined,
    saveCurrentGraph: vi.fn(async () => true),
  });
  useWorkspaceUiStore.setState({
    activeNavigation: "graph-library",
    navigationOpen: false,
    contextOpen: false,
    drawer: undefined,
    commandMenuOpen: false,
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
});

describe("WorkspaceShell", () => {
  it("renders fixed major regions and the persistent launch dock", async () => {
    await renderShell();
    expect(document.querySelector("[aria-label='Activity destinations']")).toBeTruthy();
    expect(document.querySelector("[aria-label='Graph navigation']")).toBeTruthy();
    expect(document.querySelector("[aria-label='Graph canvas']")).toBeTruthy();
    expect(document.querySelector("[aria-label='Graph context']")).toBeTruthy();
    expect(document.querySelector("[aria-label='Output utilities']")).toBeTruthy();
    expect(document.querySelector("[aria-label='Launch graph']")).toBeTruthy();
  });

  it("mounts the node dialog whenever a selected node resolves", async () => {
    useAppStore.setState({ selectedNodeId: "gate" });

    await renderShell();

    expect(document.querySelector("[role='dialog']")?.textContent).toContain("Gate");
  });

  it("switches fixed navigation destinations and opens output drawers", async () => {
    await renderShell();
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[aria-label='Run History']")?.click();
    });
    expect(document.body.textContent).toContain("Run history");

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[aria-label='Diff']")?.click();
    });
    expect(document.querySelector("[role='dialog'][aria-label='Diff']")).toBeTruthy();
    expect(document.body.textContent).toContain("Diff output");
  });

  it("marks only the current activity destination", async () => {
    await renderShell();
    const graphLibrary = document.querySelector<HTMLButtonElement>(
      "[aria-label='Graph Library']",
    );
    const runHistory = document.querySelector<HTMLButtonElement>(
      "[aria-label='Run History']",
    );
    expect(graphLibrary?.getAttribute("aria-current")).toBe("page");
    expect(runHistory?.hasAttribute("aria-current")).toBe(false);

    await act(async () => runHistory?.click());
    expect(graphLibrary?.hasAttribute("aria-current")).toBe(false);
    expect(runHistory?.getAttribute("aria-current")).toBe("page");
  });

  it("traps focus in the drawer and restores its rail opener", async () => {
    await renderShell();
    const opener = document.querySelector<HTMLButtonElement>("[aria-label='Diff']");
    opener?.focus();
    await act(async () => opener?.click());
    const dialog = document.querySelector<HTMLElement>(
      "[role='dialog'][aria-label='Diff']",
    );
    const focusable = [...(dialog?.querySelectorAll<HTMLElement>("button") ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    expect(document.activeElement).toBe(first);

    last?.focus();
    await act(async () => {
      last?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(first);

    await act(async () => {
      first?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector("[role='dialog'][aria-label='Diff']")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("opens command menu with destination, launch, save, and output commands", async () => {
    await renderShell();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = document.querySelector("[role='dialog'][aria-label='Spire commands']");
    expect(dialog?.textContent).toContain("Open Graph Library");
    expect(dialog?.textContent).toContain("Focus launch goal");
    expect(dialog?.textContent).toContain("Save graph version");
    expect(dialog?.textContent).toContain("Open Live Stream");
  });

  it("traps command focus and restores the focused opener on Escape", async () => {
    await renderShell();
    const opener = document.querySelector<HTMLButtonElement>(
      "[aria-label='Graph Library']",
    );
    opener?.focus();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = document.querySelector<HTMLElement>(
      "[role='dialog'][aria-label='Spire commands']",
    );
    const input = dialog?.querySelector<HTMLInputElement>("input");
    const focusable = [
      ...(dialog?.querySelectorAll<HTMLElement>("input, button") ?? []),
    ];
    const last = focusable.at(-1);
    expect(document.activeElement).toBe(input);

    input?.focus();
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(last);

    await act(async () => {
      last?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector("[aria-label='Spire commands']")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("cycles major regions with F6 and Shift+F6", async () => {
    await renderShell();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F6" }));
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Activity destinations",
    );
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F6", shiftKey: true }),
      );
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Launch graph",
    );
  });
});
