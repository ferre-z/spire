import { defineConfig } from "@playwright/test";

/**
 * Electron UI tests. These drive the packaged production build
 * (`pnpm build` must run first — the test:e2e script chains it) under Xvfb.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    screenshot: "only-on-failure",
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
    },
  },
});
