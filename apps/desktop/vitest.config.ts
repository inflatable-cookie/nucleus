import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ["browser"],
    preserveSymlinks: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.vitest.ts"],
  },
});
