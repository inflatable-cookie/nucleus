import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  resolve: {
    preserveSymlinks: true,
  },
  optimizeDeps: {
    exclude: [
      "@inflatable-cookie/longhorn-poodle-svelte",
      "@inflatable-cookie/longhorn-poodle-svelte/native-content",
      "@inflatable-cookie/longhorn/operation",
      "@inflatable-cookie/longhorn-poodle-svelte/operation/svelte",
      "@inflatable-cookie/longhorn-poodle-svelte/operation/poodle",
      "@inflatable-cookie/longhorn/notifications",
      "@inflatable-cookie/longhorn-poodle-svelte/notifications/svelte",
      "@inflatable-cookie/longhorn-poodle-svelte/notifications/poodle",
      "@inflatable-cookie/longhorn/commands",
      "@inflatable-cookie/longhorn-poodle-svelte/commands/svelte",
      "@inflatable-cookie/longhorn-poodle-svelte/commands/poodle",
      "@inflatable-cookie/longhorn/config",
      "@inflatable-cookie/longhorn-poodle-svelte/config/poodle",
      "@inflatable-cookie/longhorn/settings",
      "@inflatable-cookie/longhorn-poodle-svelte/settings/svelte",
      "@inflatable-cookie/longhorn-poodle-svelte/settings/poodle",
    ],
  },
  server: {
    strictPort: true,
    port: 1420,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    minify: false,
  },
});
