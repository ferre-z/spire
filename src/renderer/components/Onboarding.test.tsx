// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessStatus } from "../../shared/control";
import type { ModelOption } from "../../shared/domain";
import { useAppStore } from "../store";
import { Onboarding } from "./Onboarding";

const connectedHarness: HarnessStatus = {
  id: "opencode",
  name: "OpenCode",
  status: {
    harnessId: "opencode",
    installed: true,
    compatible: true,
    connected: true,
  },
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name,
  );
}

async function renderOnboarding(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Onboarding />);
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  const loadHarnesses = vi.fn(async () => {
    useAppStore.setState({ harnesses: [connectedHarness], harnessLoading: false });
  });
  useAppStore.setState({
    snapshot: {
      onboardingComplete: false,
      openCode: { installed: false, compatible: false, connected: false },
      graphs: [],
      runs: [],
    },
    harnesses: [],
    harnessModels: {},
    harnessLoading: false,
    loadHarnesses,
    loadHarnessModels: vi.fn(async () => []),
    error: undefined,
  });
  (window as { spire?: unknown }).spire = {
    completeOnboarding: vi.fn(),
  };
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  delete (window as { spire?: unknown }).spire;
});

describe("Onboarding", () => {
  it("shows probe progress while the local harness scan is pending", async () => {
    let finishProbe: (() => void) | undefined;
    useAppStore.setState({
      loadHarnesses: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishProbe = resolve;
          }),
      ),
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Onboarding />));
    expect(document.querySelectorAll(".harness-skeleton")).toHaveLength(3);
    await act(async () => finishProbe?.());
  });

  it("probes local harnesses and exposes installed, compatible, and connected state", async () => {
    const loadHarnesses = useAppStore.getState().loadHarnesses;
    await renderOnboarding();

    expect(loadHarnesses).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("OpenCode");
    expect(document.body.textContent).toContain("Installed");
    expect(document.body.textContent).toContain("Compatible");
    expect(document.body.textContent).toContain("Connected");
    expect(document.body.textContent).not.toContain("API key");
  });

  it("keeps disconnected harnesses unavailable and offers a re-scan when none are ready", async () => {
    useAppStore.setState({
      loadHarnesses: vi.fn(async () => {
        useAppStore.setState({
          harnesses: [
            {
              id: "codex",
              name: "Codex",
              status: {
                harnessId: "codex",
                installed: true,
                compatible: true,
                connected: false,
              },
            },
          ],
          harnessLoading: false,
        });
      }),
    });
    await renderOnboarding();

    const radio = document.querySelector<HTMLInputElement>("input[value='codex']");
    expect(radio?.disabled).toBe(true);
    expect(buttonNamed("Re-scan harnesses")).toBeTruthy();
  });

  it("shows model loading while the harness model request is pending", async () => {
    useAppStore.setState({
      loadHarnessModels: vi.fn(
        () =>
          new Promise<ModelOption[]>(() => undefined),
      ),
    });
    await renderOnboarding();

    const harnessRadio = document.querySelector<HTMLInputElement>(
      "input[value='opencode']",
    );
    await act(async () => {
      harnessRadio?.click();
    });
    expect(document.body.textContent).toContain("Loading models");
  });

  it("shows an empty state when a connected harness has no models", async () => {
    useAppStore.setState({ loadHarnessModels: vi.fn(async () => []) });
    await renderOnboarding();
    await act(async () => {
      document.querySelector<HTMLInputElement>("input[value='opencode']")?.click();
    });
    expect(document.body.textContent).toContain("No models available");
  });

  it("shows the model registry error returned by the selected harness", async () => {
    useAppStore.setState({
      loadHarnessModels: vi.fn(async () => {
        throw new Error("Model registry unavailable");
      }),
    });
    await renderOnboarding();
    await act(async () => {
      document.querySelector<HTMLInputElement>("input[value='opencode']")?.click();
    });
    expect(document.body.textContent).toContain("Model registry unavailable");
  });

  it("completes onboarding only after a connected harness and model are selected", async () => {
    useAppStore.setState({
      loadHarnessModels: vi.fn(async () => [
        { id: "gpt-5", name: "GPT-5" },
      ]),
    });
    const completeOnboarding = vi.fn(async () => ({
      onboardingComplete: true,
      openCode: { installed: true, compatible: true, connected: true },
      graphs: [],
      runs: [],
    }));
    (window as { spire?: unknown }).spire = { completeOnboarding };
    await renderOnboarding();

    await act(async () => {
      document
        .querySelector<HTMLInputElement>("input[value='opencode']")
        ?.click();
    });
    const enter = buttonNamed("Enter Spire");
    expect(enter?.disabled).toBe(true);
    await act(async () => {
      document.querySelector<HTMLInputElement>("input[value='gpt-5']")?.click();
    });
    expect(enter?.disabled).toBe(false);
    await act(async () => {
      enter?.click();
    });
    expect(completeOnboarding).toHaveBeenCalledWith({
      harnessId: "opencode",
      modelId: "gpt-5",
    });
  });
});
