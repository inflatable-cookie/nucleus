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
      "@inflatable-cookie/longhorn/settings",
      "@inflatable-cookie/longhorn/operation",
      "@inflatable-cookie/longhorn/notifications",
      "@inflatable-cookie/longhorn/config",
      "@inflatable-cookie/poodle-core",
      "@inflatable-cookie/poodle-core/icons",
      "@inflatable-cookie/poodle-core/styles",
      "@inflatable-cookie/poodle-svelte",
      "@inflatable-cookie/poodle-core/tokens",
    ],
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.vitest.ts"],
  },
});
