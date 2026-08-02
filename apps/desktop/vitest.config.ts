import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ["browser"],
    preserveSymlinks: true,
  },
  ssr: {
    noExternal: [
      "@longhorn/settings",
      "@longhorn/operation",
      "@longhorn/notifications",
      "@longhorn/config",
      "@poodle/headless",
      "@poodle/icons-lucide",
      "@poodle/styles",
      "@poodle/svelte",
      "@poodle/svelte-tokens",
    ],
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.vitest.ts"],
  },
});
