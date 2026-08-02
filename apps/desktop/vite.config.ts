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
      "@longhorn/svelte",
      "@longhorn/native-content-svelte",
      "@longhorn/operation",
      "@longhorn/operation/svelte",
      "@longhorn/operation/poodle",
      "@longhorn/notifications",
      "@longhorn/notifications/svelte",
      "@longhorn/notifications/poodle",
      "@longhorn/commands",
      "@longhorn/commands/svelte",
      "@longhorn/commands/poodle",
      "@longhorn/config",
      "@longhorn/config/poodle",
      "@longhorn/settings",
      "@longhorn/settings/svelte",
      "@longhorn/settings/poodle",
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
