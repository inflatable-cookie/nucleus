import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fixture stand-in for the BB CLI's `plugin build`, placed in a fixture home so
 * the runtime build finds it there and never the operator's installed BB. The
 * build only packages the plugin's built output and checks its identity, so the
 * stand-in writes exactly those files and nothing else.
 */
export function installFixtureBbCli(home: string): string {
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, "bb");
  writeFileSync(cli, [
    "#!/bin/sh",
    "# Fixture BB CLI: `bb plugin build <dir>` writes the built bundles the release build packages.",
    '[ "$1" = plugin ] && [ "$2" = build ] && [ -n "$3" ] || exit 2',
    'mkdir -p "$3/dist"',
    'printf "export {};\\n" > "$3/dist/server.js"',
    'printf "export {};\\n" > "$3/dist/app.js"',
    'printf "{\\"pluginId\\":\\"nucleus\\"}\\n" > "$3/dist/server.meta.json"',
    'printf "{}\\n" > "$3/dist/app.meta.json"',
    'printf "body{}\\n" > "$3/dist/app.css"',
    "",
  ].join("\n"));
  chmodSync(cli, 0o755);
  return cli;
}
