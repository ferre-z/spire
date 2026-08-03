// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "../store";
import { CollaborationPane } from "./CollaborationPane";

const spire: Record<string, ReturnType<typeof vi.fn>> = {};
let container: HTMLDivElement | undefined;
let root: Root | undefined;

function renderPane() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  void act(() => {
    root!.render(<CollaborationPane />);
  });
  return container;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
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
    selectedRunId: "run-1",
    selectedNodeId: "builder",
    messages: [
      {
        id: "run-1:0",
        runId: "run-1",
        senderNodeId: "planner",
        sequence: 0,
        createdAt: new Date().toISOString(),
        recipient: { kind: "node", id: "builder" },
        kind: "handoff",
        subject: "Here is the brief",
        body: "Build feature X.",
        artifactPaths: [],
      },
    ],
    messagesHasMore: false,
    messagesLoading: false,
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

describe("CollaborationPane (v2)", () => {
  it("renders the run's messages", () => {
    const c = renderPane();
    expect(c.querySelector("[data-pane='collaboration']")).toBeTruthy();
    expect(c.textContent).toContain("Here is the brief");
    expect(c.textContent).toContain("planner");
  });

  it("sends a message through the store", async () => {
    const sendMessage = vi.fn();
    useAppStore.setState({ sendMessage });
    const c = renderPane();
    const subject = c.querySelector<HTMLInputElement>("[data-message-subject]")!;
    const body = c.querySelector<HTMLTextAreaElement>("[data-message-body]")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(subject, "Update");
    subject.dispatchEvent(new Event("input", { bubbles: true }));
    const taSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    taSetter.call(body, "Status");
    body.dispatchEvent(new Event("input", { bubbles: true }));
    await act(async () => {
      (c.querySelector("button[type='submit']") as HTMLElement)!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledWith({
      recipient: { kind: "node", id: "builder" },
      kind: "handoff",
      subject: "Update",
      body: "Status",
      artifactPaths: [],
    });
  });

  it("shows an empty state when no run is selected", () => {
    useAppStore.setState({ selectedRunId: undefined });
    const c = renderPane();
    expect(c.textContent).toContain("No run selected");
  });
});
