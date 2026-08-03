import { expect, test, type Page } from "@playwright/test";
import {
  launchApp,
  setWindowSize,
  type LaunchedApp,
} from "./fixtures";
import { mockPlan, mockRun, seedGraph } from "./seed";

const WIDE = { width: 1440, height: 900 } as const;

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

async function launchWide(
  options?: Parameters<typeof launchApp>[0],
): Promise<LaunchedApp> {
  launched = await launchApp(options);
  await setWindowSize(launched.app, WIDE.width, WIDE.height);
  await launched.page.locator(".workspace-shell").waitFor();
  return launched;
}

function canvasNode(page: Page, nodeId: string) {
  return page.locator(`.react-flow__node[data-id="${nodeId}"]`);
}

test.describe("fixed workspace shell", () => {
  test("completes onboarding from a discovered harness and model without credentials", async () => {
    launched = await launchApp({ onboardingComplete: false, graphsV2: [] });
    const { page } = launched;
    await expect(page.locator(".onboarding-panel")).toBeVisible();
    await expect(page.getByText(/API key|credential/i)).toHaveCount(0);
    await page.getByRole("radio", { name: /OpenCode/ }).click();
    await page.getByRole("radio", { name: /Fixture Model/ }).check();
    await page.getByRole("button", { name: "Enter Spire" }).click();
    await expect(page.locator(".workspace-shell")).toBeVisible();
    await expect(page.locator(".titlebar-context")).toContainText("Build & Review");
  });

  for (const size of [
    { width: 800, height: 600 },
    { width: 1024, height: 700 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    test(`fits fixed regions at ${size.width}x${size.height}`, async () => {
      launched = await launchApp();
      await setWindowSize(launched.app, size.width, size.height);
      const { page } = launched;
      await page.locator(".workspace-shell").waitFor();

      await expect(page.getByRole("navigation", { name: "Activity destinations" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Graph canvas" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Output utilities" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Launch graph" })).toBeVisible();
      await expect(page.getByLabel("Launch goal")).toBeVisible();

      const overflow = await page.evaluate(() => ({
        horizontal: document.documentElement.scrollWidth - window.innerWidth,
        vertical: document.documentElement.scrollHeight - window.innerHeight,
      }));
      expect(overflow).toEqual({ horizontal: 0, vertical: 0 });
    });
  }

  test("activates Run History and switches utility drawers", async () => {
    const graph = seedGraph("graph-alpha", "Build & Review");
    const run = mockRun(graph);
    const plan = mockPlan(graph, run);
    const { page } = await launchWide({
      graphsV2: [graph],
      runs: [run],
      plans: [plan],
    });

    await page.getByRole("button", { name: "Run History" }).click();
    const history = page.locator('[data-pane="run-history"]');
    await expect(history).toBeVisible();
    await history.getByRole("button", { name: new RegExp(run.goal) }).click();
    await expect(history.locator(".run-list-item.selected")).toContainText(run.goal);

    await page.getByRole("button", { name: "Diff" }).click();
    await expect(page.getByRole("dialog", { name: "Diff" })).toBeVisible();
    await page
      .getByRole("dialog", { name: "Diff" })
      .getByRole("button", { name: "Result", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "Result" })).toBeVisible();
    await page.getByRole("button", { name: "Close Result" }).click();
    await expect(page.getByRole("dialog", { name: "Result" })).toHaveCount(0);
  });

  test("retains live node edits across close and reopen, then saves a version", async () => {
    const { page } = await launchWide();
    const planner = canvasNode(page, "planner");
    await planner.click();
    const dialog = page.getByRole("dialog", { name: /Architect/ });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("Node name").fill("Architecture Lead");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await canvasNode(page, "planner").click();
    const reopened = page.getByRole("dialog", { name: /Architecture Lead/ });
    await expect(reopened.getByLabel("Node name")).toHaveValue("Architecture Lead");
    await reopened.getByRole("button", { name: "Save version" }).click();
    await expect(page.locator(".titlebar-context")).toContainText("v2");
  });

  test("shows canvas controls and minimap, selects a node, and persists a drag", async () => {
    const { page } = await launchWide();
    await expect(page.locator(".react-flow__controls")).toBeVisible();
    await expect(page.locator(".react-flow__minimap")).toBeVisible();

    const builder = canvasNode(page, "implementer");
    const before = await builder.boundingBox();
    expect(before).not.toBeNull();
    if (!before) return;

    await builder.click();
    await expect(builder.locator(".canvas-node")).toHaveClass(/is-selected/);
    await page.getByRole("button", { name: "Close", exact: true }).click();

    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 120, before.y + before.height / 2 + 70, {
      steps: 8,
    });
    await page.mouse.up();
    await expect.poll(async () => (await builder.boundingBox())?.x).toBeGreaterThan(before.x + 60);
  });

  test("supports command and major-region keyboard navigation with reduced motion", async () => {
    const { page } = await launchWide();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Spire commands" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.keyboard.press("F6");
    await expect(page.getByRole("navigation", { name: "Activity destinations" })).toBeFocused();
    await page.keyboard.press("F6");
    await expect(page.getByRole("complementary", { name: "Graph navigation" })).toBeFocused();
    await page.keyboard.press("Shift+F6");
    await expect(page.getByRole("navigation", { name: "Activity destinations" })).toBeFocused();

    await page.emulateMedia({ reducedMotion: "reduce" });
    const node = page.locator(".agent-node, .canvas-node").first();
    await node.hover();
    const animationName = await node.evaluate((element) =>
      getComputedStyle(element, "::before").animationName,
    );
    expect(animationName).toBe("none");
  });

  test("keeps external and cross-origin windows blocked", async () => {
    const { page } = await launchWide();
    const results = await page.evaluate(() => ({
      external: window.open("https://example.com") === null,
      crossOrigin: window.open("http://localhost:3999/index.html") === null,
      otherFile: window.open("file:///etc/passwd") === null,
      otherPage: window.open(new URL("index.html", window.location.href).toString()) === null,
    }));
    expect(results).toEqual({
      external: true,
      crossOrigin: true,
      otherFile: true,
      otherPage: true,
    });
  });
});
