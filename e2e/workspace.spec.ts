import { expect, test } from "@playwright/test";
import {
  launchApp,
  setWindowSize,
  tabButton,
  waitForLayoutSave,
  type LaunchedApp,
} from "./fixtures";
import { seedGraph } from "./seed";

const DESKTOP = { width: 1440, height: 900 };
const COMPACT = { width: 1024, height: 700 };

let launched: LaunchedApp;

test.afterEach(async () => {
  await launched?.close();
});

async function launchDesktop(options?: Parameters<typeof launchApp>[0]) {
  launched = await launchApp(options);
  await setWindowSize(launched.app, DESKTOP.width, DESKTOP.height);
  await launched.page.waitForSelector('.workspace-dock[data-layout-mode="desktop"]');
  return launched;
}

test.describe("window sizes", () => {
  const sizes = [
    { width: 800, height: 600, mode: "compact" },
    { width: 1024, height: 700, mode: "compact" },
    { width: 1440, height: 900, mode: "desktop" },
    { width: 1920, height: 1080, mode: "desktop" },
  ];

  for (const size of sizes) {
    test(`renders the ${size.mode} workspace at ${size.width}x${size.height}`, async () => {
      launched = await launchApp();
      await setWindowSize(launched.app, size.width, size.height);
      const { page } = launched;
      await page.waitForSelector(
        `.workspace-dock[data-layout-mode="${size.mode}"]`,
      );
      // All ten panes are present as tabs in both modes.
      for (const title of [
        "Graph Library",
        "Run History",
        "Graph Canvas",
        "Task Launcher",
        "Graph Settings",
        "Node Inspector",
        "Runtime Policy",
        "Live Stream",
        "Diff",
        "Result",
      ]) {
        await expect(tabButton(page, title)).toBeVisible();
      }
      // Canvas pane content is rendered and fits the viewport.
      const canvas = page.locator('[data-pane="graph-canvas"]');
      await expect(canvas).toBeVisible();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(100);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
    });
  }
});

test.describe("pane management", () => {
  test("closes and reopens a pane through the View menu", async () => {
    const { page } = await launchDesktop();
    const result = tabButton(page, "Result");
    await result.hover();
    await result.locator(".flexlayout__tab_button_trailing").click();
    await expect(tabButton(page, "Result")).toHaveCount(0);

    await page.locator(".titlebar-view").click();
    await page.getByRole("menuitem", { name: "Result" }).click();
    await expect(tabButton(page, "Result")).toBeVisible();
  });

  test("reopens a pane through the command menu with the keyboard", async () => {
    const { page } = await launchDesktop();
    const diff = tabButton(page, "Diff");
    await diff.hover();
    await diff.locator(".flexlayout__tab_button_trailing").click();
    await expect(tabButton(page, "Diff")).toHaveCount(0);

    await page.keyboard.press("Control+k");
    await expect(page.locator(".command-menu")).toBeVisible();
    await page.keyboard.type("Reopen Diff");
    await page.keyboard.press("Enter");
    await expect(tabButton(page, "Diff")).toBeVisible();
    await expect(page.locator(".command-menu")).toHaveCount(0);
  });

  test("maximizes and restores the active pane", async () => {
    const { page } = await launchDesktop();
    await tabButton(page, "Graph Canvas").click();
    await page.locator(".titlebar-view").click();
    await page.getByRole("menuitem", { name: "Maximize" }).click();
    await expect(page.locator(".flexlayout__tabset-maximized")).toHaveCount(1);
    await page.locator(".titlebar-view").click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await expect(page.locator(".flexlayout__tabset-maximized")).toHaveCount(0);
  });

  test("moves the active pane into another tab group", async () => {
    const { page } = await launchDesktop();
    await tabButton(page, "Diff").click();
    await page.locator(".titlebar-view").click();
    await page.getByRole("menuitem", { name: "Move up" }).click();
    // Diff now shares the upper-right tabset with the config panes.
    await tabButton(page, "Node Inspector").click();
    await expect(tabButton(page, "Diff")).toBeVisible();
    const diffBox = await tabButton(page, "Diff").boundingBox();
    const inspectorBox = await tabButton(page, "Node Inspector").boundingBox();
    expect(Math.abs(diffBox!.y - inspectorBox!.y)).toBeLessThan(4);
  });

  test("resets the layout to defaults", async () => {
    const { page } = await launchDesktop();
    const result = tabButton(page, "Result");
    await result.hover();
    await result.locator(".flexlayout__tab_button_trailing").click();
    await expect(tabButton(page, "Result")).toHaveCount(0);
    await waitForLayoutSave(page);

    await page.locator(".titlebar-view").click();
    await page.getByRole("menuitem", { name: "Reset layout" }).click();
    await expect(tabButton(page, "Result")).toBeVisible();
  });

  test("cycles panes with F6 and Shift+F6", async () => {
    const { page } = await launchDesktop();
    // Make the config tabset active with Node Inspector selected.
    await tabButton(page, "Node Inspector").click();
    // F6 moves to the next pane in model order (Runtime Policy).
    await page.keyboard.press("F6");
    await expect(tabButton(page, "Runtime Policy")).toHaveClass(
      /flexlayout__tab_button--selected/,
    );
    // Shift+F6 cycles back.
    await page.keyboard.press("Shift+F6");
    await expect(tabButton(page, "Node Inspector")).toHaveClass(
      /flexlayout__tab_button--selected/,
    );
  });
});

test.describe("layout persistence", () => {
  test("keeps compact and desktop layouts independent across the breakpoint", async () => {
    const { app, page } = await launchDesktop();
    // Close Result in desktop mode and let the save flush.
    const result = tabButton(page, "Result");
    await result.hover();
    await result.locator(".flexlayout__tab_button_trailing").click();
    await expect(tabButton(page, "Result")).toHaveCount(0);
    await waitForLayoutSave(page);

    // Cross into compact: Result is still open there.
    await setWindowSize(app, COMPACT.width, COMPACT.height);
    await page.waitForSelector('.workspace-dock[data-layout-mode="compact"]');
    await expect(tabButton(page, "Result")).toBeVisible();

    // Close Result in compact too, then go back to desktop: still closed.
    const compactResult = tabButton(page, "Result");
    await compactResult.hover();
    await compactResult.locator(".flexlayout__tab_button_trailing").click();
    await waitForLayoutSave(page);
    await setWindowSize(app, DESKTOP.width, DESKTOP.height);
    await page.waitForSelector('.workspace-dock[data-layout-mode="desktop"]');
    await expect(tabButton(page, "Result")).toHaveCount(0);
    await expect(tabButton(page, "Graph Canvas")).toBeVisible();
  });

  test("persists layouts per graph across graph switches", async () => {
    const alpha = seedGraph("graph-alpha", "Alpha Graph");
    const beta = seedGraph("graph-beta", "Beta Graph");
    const { page } = await launchDesktop({ graphs: [alpha, beta] });

    // Close Result in the first graph, then switch graphs.
    const result = tabButton(page, "Result");
    await result.hover();
    await result.locator(".flexlayout__tab_button_trailing").click();
    await expect(tabButton(page, "Result")).toHaveCount(0);
    await waitForLayoutSave(page);

    await page.getByRole("button", { name: /Beta Graph/ }).click();
    await expect(page.locator(".titlebar-context")).toContainText("Beta Graph");
    // Beta has its own default layout with Result open.
    await expect(tabButton(page, "Result")).toBeVisible();

    await page.getByRole("button", { name: /Alpha Graph/ }).click();
    await expect(page.locator(".titlebar-context")).toContainText("Alpha Graph");
    // Alpha's layout was restored without Result.
    await expect(tabButton(page, "Result")).toHaveCount(0);
  });
});
