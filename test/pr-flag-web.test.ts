import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { build, type Plugin } from "esbuild";

/**
 * nucleus#1515 review: the row's PR flag must open the pull request from the keyboard
 * on the web board. react-native-web leaves a link role's Enter to the element's
 * native click, which a `div` never has, so the flag renders as a real anchor there.
 * This bundles the badge the way the deployed board does (`react-native` resolved to
 * `react-native-web`) and reads the markup it emits.
 */

const root = resolve(import.meta.dirname, "..");
/** The board shell's host hooks, as inert stand-ins: the badge only draws an icon. */
const shellStub: Plugin = {
  name: "pr-flag-shell",
  setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)shell(?:\/index)?$/ }, (args) =>
      resolve(args.resolveDir, args.path) === join(root, "client/shell")
        ? { path: "shell", namespace: "pr-flag-shell" }
        : undefined,
    );
    builder.onLoad({ filter: /.*/, namespace: "pr-flag-shell" }, () => ({
      contents:
        "export const Icon = () => null; export const useRpc = () => null; export const useWorkspace = () => null;",
      loader: "js",
    }));
  },
};

async function webBadges() {
  const result = await build({
    entryPoints: [join(root, "client/board/badges.tsx")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    jsx: "automatic",
    logLevel: "silent",
    plugins: [shellStub],
    external: ["react", "react/jsx-runtime", "react-dom", "react-native-web"],
    alias: { "react-native": "react-native-web" },
  });
  const compiled = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", result.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports,
  );
  return compiled.exports as {
    PullRequestBadge: (props: unknown) => React.ReactElement | null;
  };
}

const dark = {
  accent: "#1f6feb",
  accentForeground: "#ffffff",
  surface0: "#0d1117",
  surface1: "#161b22",
  surface2: "#30363d",
  border: "#30363d",
  foreground: "#f0f6fc",
  foregroundMuted: "#8b949e",
  statusWarning: "#f0883e",
  statusDanger: "#f85149",
};

test("the web board renders the PR flag as a keyboard-activatable anchor to the pull request", async () => {
  const { PullRequestBadge } = await webBadges();
  const url = "https://github.com/owner/app/pull/41";
  const html = renderToStaticMarkup(
    React.createElement(
      PullRequestBadge as never,
      {
        task: {
          id: "task",
          prUrl: url,
          phase: "reviewing",
          held: false,
          reason: "",
          resolution: {},
        },
        c: dark,
        small: true,
        flag: true,
      } as never,
    ),
  );
  const anchor = html.match(/<a\b[^>]*>/)?.[0];
  assert.ok(
    anchor,
    `the flag is an anchor, so Enter activates it natively: ${html}`,
  );
  assert.match(
    anchor!,
    new RegExp(`href="${url}"`),
    "it links to the pull request",
  );
  assert.match(anchor!, /target="_blank"/, "it opens beside the board");
  assert.match(anchor!, /rel="noopener noreferrer"/);
  assert.match(anchor!, /aria-label="Pull request #41, [^"]*, open on GitHub"/);
  assert.match(html, />#41</, "the flag still reads its number");
});
