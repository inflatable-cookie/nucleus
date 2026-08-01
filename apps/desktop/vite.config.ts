import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  resolve: {
    preserveSymlinks: true,
  },
  optimizeDeps: {
    exclude: ["@longhorn/svelte", "@longhorn/native-content-svelte"],
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
