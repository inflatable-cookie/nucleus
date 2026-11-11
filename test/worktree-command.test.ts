import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readlinkSync, existsSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const command = resolve("bin/nucleus.mjs");
test("worktree setup uses the primary ledger without target dependencies", () => {
  const fixture = mkdtempSync(join(tmpdir(), "nucleus-worktree-"));
  const primary = join(fixture, "primary"), target = join(fixture, "lanes", "task"), library = join(fixture, "library"), home = join(fixture, "home"), bin = join(fixture, "bin");
  for (const dir of [primary, library, home, bin, join(fixture, "lanes")]) mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOME: home, PASEO_HOME: join(fixture, "paseo"), PATH: `${bin}:${process.env.PATH}`, LOG: join(fixture, "calls") };
  const run = (program: string, args: string[], cwd: string) => execFileSync(program, args, { cwd, env, encoding: "utf8" });
  run("git", ["init", "-b", "main"], primary);
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init"], primary);
  run("git", ["worktree", "add", "--detach", target], primary);
  const ledger = JSON.stringify({ schema: "effigy.deps.links.v1", schema_version: 1, links: [{ key: { manager: "cargo", library_path: library } }] });
  mkdirSync(join(primary, ".effigy/local"), { recursive: true });
  writeFileSync(join(primary, ".effigy/local/dependency-links.json"), ledger);
  writeFileSync(join(bin, "effigy"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LOG"\nprintf \'{"schema":"effigy.deps.%s.v1"}\\n\' "$3"\n', { mode: 0o755 });
  assert.equal(existsSync(join(target, "node_modules")), false);
  assert.match(run(process.execPath, [command, "worktree", "prepare"], target), /sources=1/);
  assert.equal(readlinkSync(join(fixture, "lanes", "library")), library);
  assert.match(run(process.execPath, [command, "worktree", "prepare"], target), /reuse/);
  assert.match(run(process.execPath, [command, "worktree", "link"], target), /links=1/);
  mkdirSync(join(target, ".effigy/local"), { recursive: true });
  writeFileSync(join(target, ".effigy/local/dependency-links.json"), ledger);
  assert.match(run(process.execPath, [command, "worktree", "unlink"], target), /links=1/);
  assert.equal(readFileSync(join(fixture, "calls"), "utf8"), `--json deps link cargo ${library}\n--json deps unlink cargo ${library}\n`);
  // A checkout copy of the CLI works even when it has no node_modules.
  const checkout = join(fixture, "checkout");
  mkdirSync(join(checkout, "bin"), { recursive: true });
  mkdirSync(join(checkout, "shared"), { recursive: true });
  cpSync(resolve("bin/nucleus.mjs"), join(checkout, "bin/nucleus.mjs"));
  cpSync(resolve("bin/worktree.mjs"), join(checkout, "bin/worktree.mjs"));
  cpSync(resolve("shared/data-home.mjs"), join(checkout, "shared/data-home.mjs"));
  assert.match(run(process.execPath, [join(checkout, "bin/nucleus.mjs"), "worktree", "prepare"], target), /reuse/);
});
