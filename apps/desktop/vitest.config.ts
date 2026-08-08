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
      "@inflatable-cookie/longhorn-settings",
      "@inflatable-cookie/longhorn-operation",
      "@inflatable-cookie/longhorn-notifications",
      "@inflatable-cookie/longhorn-config",
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
