import { defineConfig } from "astro/config";

// @ts-check
import react from "@astrojs/react";

// https://astro.build/config
export default defineConfig({
  site: "https://spire.dev",
  integrations: [react()],
  vite: {
    ssr: {
      // gsap ScrollTrigger needs the window; keep it client/all island side.
      noExternal: ["gsap"],
    },
  },
});