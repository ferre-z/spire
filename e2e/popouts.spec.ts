import { expect, test } from "@playwright/test";
import {
  launchApp,
  setWindowSize,
  tabButton,
  waitForLayoutSave,
  type LaunchedApp,
} from "./fixtures";

let launched: LaunchedApp;

test.afterEach(async () => {
  await launched?.close();
});

test.describe("native popouts", () => {
  test("pops out the active pane and docks it back", async () => {
    launched = await launchApp();
    const { app, page } = launched;
    await setWindowSize(app, 1440, 900);
    await page.waitForSelector('.workspace-dock[data-layout-mode="desktop"]');

    await tabButton(page, "Live Stream").click();
    await page.locator(".titlebar-view").click();
    await page.getByRole("menuitem", { name: "Pop out active pane" }).click();

    // A second Electron window hosts the popped-out pane.
    await test.expect
      .poll(() => app.windows().length, { timeout: 10_000 })
      .toBe(2);
    const popout = app
      .windows()
      .find((window) => window.url().includes("popout.html"));
    expect(popout).toBeDefined();
    await popout!.waitForSelector('[data-pane="live-stream"]', {
      timeout: 15_000,
    });

    // The pane leaves the main window while popped out.
    await expect(tabButton(page, "Live Stream")).toHaveCount(0);

    await page.locator(".titlebar-view").click();
    await page.getByRole("menuitem", { name: "Dock all popouts back" }).click();
    await test.expect.poll(() => app.windows().length).toBe(1);
    await expect(tabButton(page, "Live Stream")).toBeVisible();
  });

  test("restores saved popouts when the layout reloads", async () => {
    launched = await launchApp();
    const { app, page } = launched;
    await setWindowSize(app, 1440, 900);
    await page.waitForSelector('.workspace-dock[data-layout-mode="desktop"]');

    await tabButton(page, "Diff").click();
    await page.locator(".titlebar-view").click();
    await page.getByRole("menuitem", { name: "Pop out active pane" }).click();
    await test.expect.poll(() => app.windows().length).toBe(2);
    await waitForLayoutSave(page);

    // Restart the app against the same userData: the saved popout returns.
    const userDataDir = launched.userDataDir;
    await app.close();
    launched = await launchApp({}, { userDataDir });
    const { app: app2, page: page2 } = launched;
    await setWindowSize(app2, 1440, 900);
    await page2.waitForSelector('.workspace-dock[data-layout-mode="desktop"]');
    await test.expect
      .poll(() => app2.windows().length, { timeout: 15_000 })
      .toBe(2);
    const popout = app2
      .windows()
      .find((window) => window.url().includes("popout.html"));
    expect(popout).toBeDefined();
    await popout!.waitForSelector('[data-pane="diff"]', { timeout: 15_000 });
    // The main window no longer hosts the pane.
    await expect(tabButton(page2, "Diff")).toHaveCount(0);
  });
});

test.describe("window-open security", () => {
  test("denies external and cross-origin popups", async () => {
    launched = await launchApp();
    const { page } = launched;
    await page.waitForSelector(".flexlayout__layout");

    const results = await page.evaluate(() => ({
      external: window.open("https://example.com") === null,
      crossOrigin: window.open("http://localhost:3999/popout.html") === null,
      otherFile: window.open("file:///etc/passwd") === null,
      otherPage:
        window.open(
          new URL("index.html", window.location.href).toString(),
        ) === null,
    }));
    expect(results).toEqual({
      external: true,
      crossOrigin: true,
      otherFile: true,
      otherPage: true,
    });
  });
});
