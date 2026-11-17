// The vendored fork's own test runner (Spec 062, decision 5a): upstream's
// `vitest.config.ts`, with the fork's `@/*` mapping spelled out for Vite.
import { defineConfig } from "vitest/config";

// The copy root: the fork's tsconfig maps `@/*` here.
const root = new URL("./", import.meta.url).pathname;

export default defineConfig({
  // One runner, wherever it is started from: the config owns its root.
  root,
  // The board bundle is generated (`effigy bb:board-build`) and never built by this
  // runner: the plugin entry's import of it resolves to a no-op registration here.
  resolve: { alias: [{ find: /^\.\/board\/nucleus-board\.js$/, replacement: `${root}board/nucleus-board.stub.ts` }, { find: "@", replacement: root }] },
  test: {
    alias: [{ find: /^\.\/board\/nucleus-board\.js$/, replacement: `${root}board/nucleus-board.stub.ts` }, { find: "@", replacement: root }],
    silent: "passed-only",
    name: "bb-plugin-nucleus-sidebar",
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    setupFiles: ["./test-setup.ts"],
    include: ["sidebar/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "sidebar/**/node_modules/**"],
  },
});
