import { defineConfig } from "vite";

// The MCP sidecar is a plain Node stdio process (no Electron). Build it as a
// self-contained CJS bundle so `spire:mcp` can run it with the system Node
// and Electron Forge can ship it as an extra resource.
export default defineConfig({
  // Bundle all runtime deps (zod, MCP SDK) so the shipped mcp.js runs
  // standalone, without node_modules, inside packaged builds.
  ssr: { noExternal: true },
  build: {
    // Separate from .vite/build: the forge Vite plugin empties that
    // directory when it builds the main/preload targets during packaging.
    outDir: ".vite/mcp",
    emptyOutDir: true,
    ssr: "src/mcp/index.ts",
    target: "node22",
    rollupOptions: {
      output: {
        format: "cjs",
        entryFileNames: "mcp.js",
        banner: "#!/usr/bin/env node",
      },
    },
  },
});
