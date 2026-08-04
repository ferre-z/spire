/* global console, document, getComputedStyle, process, window */
import { _electron as electron } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const evidence = path.join(root, ".omo/evidence/fixed-workspace-shell-followup");
const executable = path.join(root, "out/Spire-linux-x64/spire");
const consoleErrors = [];

async function launch(name, seed) {
  const userData = path.join(evidence, `user-data-${name}`);
  await rm(userData, { recursive: true, force: true });
  await mkdir(userData, { recursive: true });
  const app = await electron.launch({
    executablePath: executable,
    args: ["--no-sandbox"],
    env: {
      ...process.env,
      SPIRE_USER_DATA: userData,
      SPIRE_SEED: path.join(evidence, seed),
    },
  });
  const page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${name}: ${message.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function metrics(page) {
  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    verticalOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    gridColumns: document.querySelector(".workspace-shell")
      ? getComputedStyle(document.querySelector(".workspace-shell")).gridTemplateColumns
      : undefined,
    regions: [...document.querySelectorAll("[data-major-region]")].map((element) => element.getAttribute("aria-label")),
  }));
}

const workspace = await launch("workspace", "workspace-seed.json");
const report = {};
try {
  const { page } = workspace;
  await page.locator(".workspace-shell").waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  report.desktop = await metrics(page);
  report.currentDestination = await page.locator('[aria-label="Graph Library"]').getAttribute("aria-current");
  await page.screenshot({ path: path.join(evidence, "workspace-1440.png") });

  const drawerOpener = page.locator('[aria-label="Diff"]');
  await drawerOpener.click();
  const drawer = page.getByRole("dialog", { name: "Diff" });
  await drawer.waitFor();
  report.drawerWidth = await drawer.evaluate((element) => getComputedStyle(element).width);
  const drawerButtons = drawer.locator("button");
  await drawerButtons.last().focus();
  await page.keyboard.press("Tab");
  report.drawerTabWrapped = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Close Diff");
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });
  report.drawerFocusRestored = await drawerOpener.evaluate((element) => document.activeElement === element);
  await drawerOpener.click();
  await drawer.waitFor();
  await page.screenshot({ path: path.join(evidence, "drawer-diff-1440.png") });
  await page.keyboard.press("Escape");

  const commandOpener = page.locator('[aria-label="Context"]');
  await commandOpener.focus();
  await page.keyboard.press("Control+k");
  const command = page.getByRole("dialog", { name: "Spire commands" });
  await command.waitFor();
  await page.keyboard.press("Shift+Tab");
  report.commandShiftTabWrapped = await command.locator("button").last().evaluate((element) => document.activeElement === element);
  await page.keyboard.press("Escape");
  await command.waitFor({ state: "detached" });
  report.commandFocusRestored = await commandOpener.evaluate((element) => document.activeElement === element);

  await page.setViewportSize({ width: 1024, height: 700 });
  await page.locator('[aria-label="Run History"]').click();
  await page.waitForTimeout(100);
  report.navigationOverlayVisible = await page.locator(".navigation-panel.is-open").isVisible();
  await page.screenshot({ path: path.join(evidence, "workspace-1024-navigation.png") });
  await page.locator('[aria-label="Context"]').click();
  await page.waitForTimeout(150);
  report.compact = await metrics(page);
  report.contextOverlayVisible = await page.locator(".context-panel.is-open").isVisible();
  await page.screenshot({ path: path.join(evidence, "workspace-1024-overlays.png") });

  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForTimeout(150);
  report.minimum = await metrics(page);
  await page.screenshot({ path: path.join(evidence, "workspace-800.png") });
} finally {
  await workspace.app.close();
}

const onboarding = await launch("onboarding", "onboarding-seed.json");
try {
  const { page } = onboarding;
  await page.setViewportSize({ width: 1024, height: 760 });
  await page.locator(".harness-choice").first().waitFor();
  await page.waitForTimeout(150);
  report.onboarding = {
    harnessRows: await page.locator(".harness-choice").count(),
    hasCredentialLanguage: /credential|api key|token/i.test(await page.locator("body").innerText()),
    ...(await metrics(page)),
  };
  await page.screenshot({ path: path.join(evidence, "onboarding-1024.png") });
} finally {
  await onboarding.app.close();
}

report.consoleErrors = consoleErrors;
const checks = {
  desktopNoOverflow: report.desktop.horizontalOverflow === 0 && report.desktop.verticalOverflow === 0,
  compactNoOverflow: report.compact.horizontalOverflow === 0 && report.compact.verticalOverflow === 0,
  minimumNoOverflow: report.minimum.horizontalOverflow === 0 && report.minimum.verticalOverflow === 0,
  onboardingNoOverflow: report.onboarding.horizontalOverflow === 0 && report.onboarding.verticalOverflow === 0,
  drawerWidth: report.drawerWidth === "440px",
  overlays: report.navigationOverlayVisible && report.contextOverlayVisible,
  currentDestination: report.currentDestination === "page",
  drawerFocus: report.drawerTabWrapped && report.drawerFocusRestored,
  commandFocus: report.commandShiftTabWrapped && report.commandFocusRestored,
  onboardingRows: report.onboarding.harnessRows === 3,
  onboardingCopy: !report.onboarding.hasCredentialLanguage,
  console: report.consoleErrors.length === 0,
};
report.checks = checks;
await writeFile(path.join(evidence, "manual-qa.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
