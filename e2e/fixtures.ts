import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { writeSeedFixture, type SeedOptions } from "./seed";

const PACKAGE_DIR = path.join(
  __dirname,
  "..",
  "out",
  `Spire-${process.platform}-${process.arch}`,
);

export const EXECUTABLE = path.join(
  PACKAGE_DIR,
  process.platform === "win32" ? "spire.exe" : "spire",
);

export type LaunchedApp = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  close: () => Promise<void>;
};

/**
 * Launch the packaged Spire build against an isolated, pre-seeded userData
 * directory. The app under test is the production package so the file://
 * popout allowlist is exercised exactly as shipped.
 */
export async function launchApp(
  options: SeedOptions = {},
  reuse?: { userDataDir: string },
): Promise<LaunchedApp> {
  const userDataDir =
    reuse?.userDataDir ?? mkdtempSync(path.join(tmpdir(), "spire-e2e-"));
  const seedPath = writeSeedFixture(userDataDir, options);
  const app = await electron.launch({
    executablePath: EXECUTABLE,
    args: ["--no-sandbox", "--disable-gpu"],
    env: {
      ...process.env,
      SPIRE_USER_DATA: userDataDir,
      SPIRE_SEED: seedPath,
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".flexlayout__layout, .onboarding-shell", {
    timeout: 30_000,
  });
  return {
    app,
    page,
    userDataDir,
    close: async () => {
      await app.close().catch(() => undefined);
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

export async function setWindowSize(
  app: ElectronApplication,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(size.width, size.height);
    },
    { width, height },
  );
}

/** Wait out the 300ms debounced layout save plus IPC round trip. */
export async function waitForLayoutSave(page: Page): Promise<void> {
  await page.waitForTimeout(650);
}

export function tabButton(page: Page, title: string) {
  return page.locator(".flexlayout__tab_button", { hasText: title });
}

export function selectedTab(page: Page) {
  return page.locator(".flexlayout__tab_button--selected");
}
