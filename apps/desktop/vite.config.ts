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
      "@inflatable-cookie/longhorn-svelte",
      "@inflatable-cookie/longhorn-native-content-svelte",
      "@inflatable-cookie/longhorn-operation",
      "@inflatable-cookie/longhorn-operation/svelte",
      "@inflatable-cookie/longhorn-operation/poodle",
      "@inflatable-cookie/longhorn-notifications",
      "@inflatable-cookie/longhorn-notifications/svelte",
      "@inflatable-cookie/longhorn-notifications/poodle",
      "@inflatable-cookie/longhorn-commands",
      "@inflatable-cookie/longhorn-commands/svelte",
      "@inflatable-cookie/longhorn-commands/poodle",
      "@inflatable-cookie/longhorn-config",
      "@inflatable-cookie/longhorn-config/poodle",
      "@inflatable-cookie/longhorn-settings",
      "@inflatable-cookie/longhorn-settings/svelte",
      "@inflatable-cookie/longhorn-settings/poodle",
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
