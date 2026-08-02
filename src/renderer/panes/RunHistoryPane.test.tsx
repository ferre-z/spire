// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import { RunHistoryPane } from "./RunHistoryPane";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

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
      runs: [
        {
          id: "run-1",
          graphId: "graph-1",
          graphVersion: 1,
          repositoryPath: "/work/spire",
          goal: "Verify run activation",
          status: "succeeded",
          iteration: 1,
          startedAt: new Date().toISOString(),
          events: [],
        },
      ],
    },
    selectedRunId: undefined,
    activateRun: vi.fn(async () => undefined),
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

describe("RunHistoryPane", () => {
  it("activates the selected run and its runtime data", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<RunHistoryPane />));

    await act(async () => {
      container?.querySelector<HTMLButtonElement>(".run-list-item")?.click();
    });

    expect(useAppStore.getState().activateRun).toHaveBeenCalledWith("run-1");
  });
});
