import { expect, test } from "@playwright/test";
import { launchApp, setWindowSize, type LaunchedApp } from "./fixtures";
import { mockRun, seedGraph } from "./seed";

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test.describe("fixed workspace visual regression", () => {
  test("onboarding", async () => {
    launched = await launchApp({ onboardingComplete: false, graphsV2: [] });
    await setWindowSize(launched.app, 1440, 900);
    await launched.page.locator(".onboarding-card").waitFor();
    await expect(launched.page).toHaveScreenshot("onboarding.png", {
      animations: "disabled",
    });
  });

  test("wide workspace", async () => {
    launched = await launchApp();
    await setWindowSize(launched.app, 1440, 900);
    await launched.page.locator(".workspace-shell").waitFor();
    await expect(launched.page).toHaveScreenshot("workspace-desktop.png", {
      animations: "disabled",
    });
  });

  test("compact workspace", async () => {
    launched = await launchApp();
    await setWindowSize(launched.app, 1024, 700);
    await launched.page.locator(".workspace-shell").waitFor();
    await expect(launched.page).toHaveScreenshot("workspace-compact.png", {
      animations: "disabled",
    });
  });

  test("active run with history and result drawer", async () => {
    const graph = seedGraph("graph-alpha", "Build & Review");
    const run = mockRun(graph);
    launched = await launchApp({ graphsV2: [graph], runs: [run] });
    await setWindowSize(launched.app, 1440, 900);
    const { page } = launched;
    await page.getByRole("button", { name: "Run History" }).click();
    await page.locator('[data-pane="run-history"] .run-list-item').click();
    await page.getByRole("button", { name: "Result" }).click();
    await expect(page.getByRole("dialog", { name: "Result" })).toBeVisible();
    await expect(page).toHaveScreenshot("workspace-active-run.png", {
      animations: "disabled",
    });
  });

  test("node dialog", async () => {
    launched = await launchApp();
    await setWindowSize(launched.app, 1440, 900);
    const { page } = launched;
    await page.locator('.react-flow__node[data-id="planner"]').click();
    await expect(page.getByRole("dialog", { name: /Architect/ })).toBeVisible();
    await expect(page).toHaveScreenshot("workspace-node-dialog.png", {
      animations: "disabled",
    });
  });
});
