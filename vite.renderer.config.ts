import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)));

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: path.join(root, "index.html"),
        popout: path.join(root, "popout.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(root, "src/shared"),
      "@renderer": path.resolve(root, "src/renderer"),
    },
  },
});
