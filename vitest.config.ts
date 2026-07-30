import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Renderer component tests opt into jsdom via a per-file
    // `// @vitest-environment jsdom` pragma; everything else stays on node.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
