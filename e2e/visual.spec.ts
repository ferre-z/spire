import { expect, test } from "@playwright/test";
import {
  launchApp,
  setWindowSize,
  tabButton,
  waitForLayoutSave,
  type LaunchedApp,
} from "./fixtures";
import { seedGraph, mockRun } from "./seed";

let launched: LaunchedApp;

test.afterEach(async () => {
  await launched?.close();
});

function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: number[], background: number[]): number {
  const [lighter, darker] = [
    Math.max(luminance(foreground), luminance(background)),
    Math.min(luminance(foreground), luminance(background)),
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

test.describe("visual regression", () => {
  test("onboarding screen", async () => {
    launched = await launchApp({ onboardingComplete: false, graphs: [] });
    const { page } = launched;
    await setWindowSize(launched.app, 1440, 900);
    await page.waitForSelector(".onboarding-card");
    await expect(page).toHaveScreenshot("onboarding.png", {
      animations: "disabled",
    });
  });

  test("default desktop workspace", async () => {
    launched = await launchApp();
    const { page } = launched;
    await setWindowSize(launched.app, 1440, 900);
    await page.waitForSelector('.workspace-dock[data-layout-mode="desktop"]');
    await expect(page).toHaveScreenshot("workspace-desktop.png", {
      animations: "disabled",
    });
  });

  test("compact workspace", async () => {
    launched = await launchApp();
    const { page } = launched;
    await setWindowSize(launched.app, 1024, 700);
    await page.waitForSelector('.workspace-dock[data-layout-mode="compact"]');
    await expect(page).toHaveScreenshot("workspace-compact.png", {
      animations: "disabled",
    });
  });

  test("active run state", async () => {
    const graph = seedGraph("graph-alpha", "Build & Review");
    launched = await launchApp({
      graphs: [graph],
      runs: [mockRun(graph)],
    });
    const { page } = launched;
    await setWindowSize(launched.app, 1440, 900);
    await page.waitForSelector('.workspace-dock[data-layout-mode="desktop"]');
    await page.waitForSelector(".event-row");
    await expect(page).toHaveScreenshot("workspace-active-run.png", {
      animations: "disabled",
    });
  });

  test("popout window", async () => {
    launched = await launchApp();
    const { app, page } = launched;
    await setWindowSize(app, 1440, 900);
    await page.waitForSelector('.workspace-dock[data-layout-mode="desktop"]');
    await tabButton(page, "Live Stream").click();
    await page.locator(".titlebar-view").click();
    await page.getByRole("menuitem", { name: "Pop out active pane" }).click();
    await test.expect.poll(() => app.windows().length).toBe(2);
    const popout = app
      .windows()
      .find((window) => window.url().includes("popout.html"))!;
    await popout.waitForSelector('[data-pane="live-stream"]');
    await waitForLayoutSave(page);
    await expect(popout).toHaveScreenshot("popout-window.png", {
      animations: "disabled",
      // The trace-backed Live Stream pane renders journaled control events
      // with random correlation ids and wall-clock timestamps; only the
      // pane chrome and filter bar are stable enough to compare.
      mask: [popout.locator(".event-stream"), popout.locator(".run-actions")],
    });
  });
});

test.describe("accessibility", () => {
  test("reduced-motion users get a static accent instead of the liquid border", async () => {
    launched = await launchApp();
    const { page } = launched;
    await setWindowSize(launched.app, 1440, 900);
    await page.waitForSelector(".agent-node");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const node = page.locator(".agent-node").first();
    await node.hover();
    const animationName = await node.evaluate((element) =>
      getComputedStyle(element, "::before").animationName,
    );
    expect(animationName).toBe("none");
  });

  test("key text pairs keep WCAG AA contrast", async () => {
    launched = await launchApp();
    const { page } = launched;
    await setWindowSize(launched.app, 1440, 900);
    await page.waitForSelector(".flexlayout__layout");

    const pairs = await page.evaluate(() => {
      const read = (selector: string, property: "color" | "backgroundColor") => {
        const value = getComputedStyle(
          document.querySelector(selector)!,
        )[property];
        return value.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
      };
      return {
        bodyText: [read("body", "color"), read("body", "backgroundColor")],
        paneText: [
          read('[data-pane="graph-library"]', "color"),
          read(".flexlayout__tab", "backgroundColor"),
        ],
        activeTab: [
          read(".flexlayout__tab_button--selected", "color"),
          read(".flexlayout__tab_button--selected", "backgroundColor"),
        ],
      };
    });
    expect(contrast(pairs.bodyText[0], pairs.bodyText[1])).toBeGreaterThan(7);
    expect(contrast(pairs.paneText[0], pairs.paneText[1])).toBeGreaterThan(4.5);
    expect(contrast(pairs.activeTab[0], pairs.activeTab[1])).toBeGreaterThan(4.5);
  });

  test("no document overflow at the minimum window size", async () => {
    launched = await launchApp();
    const { app, page } = launched;
    await setWindowSize(app, 800, 600);
    await page.waitForSelector('.workspace-dock[data-layout-mode="compact"]');
    const overflow = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth - window.innerWidth,
      vertical: document.documentElement.scrollHeight - window.innerHeight,
    }));
    expect(overflow.horizontal).toBeLessThanOrEqual(0);
    expect(overflow.vertical).toBeLessThanOrEqual(0);
  });
});
