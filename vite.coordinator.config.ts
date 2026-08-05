import { defineConfig } from "vite";

export default defineConfig({
  ssr: { noExternal: true },
  build: {
    outDir: "coordinator-dist",
    emptyOutDir: true,
    ssr: "src/coordinator/index.ts",
    target: "node22",
    rollupOptions: {
      external: ["better-sqlite3"],
      output: {
        format: "cjs",
        entryFileNames: "coordinator.js",
        banner: "#!/usr/bin/env node",
      },
    },
  },
});
