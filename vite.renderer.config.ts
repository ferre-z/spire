import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
        "src/shared",
      ),
      "@renderer": path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
        "src/renderer",
      ),
    },
  },
});
