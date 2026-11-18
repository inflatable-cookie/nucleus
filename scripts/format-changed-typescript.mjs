#!/usr/bin/env node
/** Format whole changed TypeScript files, or check them without writing. */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedRegionsFromDiff } from "./format-changed-plan.mjs";

const root = process.cwd();
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const prettier = resolve(scriptDirectory, "../node_modules/prettier/bin/prettier.cjs");
const BUFFER_BYTES = 64 * 1024 * 1024;

// A clean review checkout still has committed changes relative to main.
const main = spawnSync("git", ["rev-parse", "--verify", "origin/main"], { cwd: root, stdio: "ignore" });
const base = main.status === 0
  ? execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: root, encoding: "utf8" }).trim()
  : "HEAD";
const diff = execFileSync(
  "git",
  ["diff", "--no-ext-diff", "--no-color", "--unified=0", base, "--", ":(glob)**/*.ts", ":(glob)**/*.tsx"],
  { cwd: root, encoding: "utf8", maxBuffer: BUFFER_BYTES }
);
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: BUFFER_BYTES })
  .split("\0")
  .filter(file => /\.(?:ts|tsx)$/.test(file));
const regionsByFile = changedRegionsFromDiff(diff);

function prettierText(absolute) {
  try {
    return execFileSync(process.execPath, [prettier, absolute], { cwd: root, encoding: "utf8", maxBuffer: BUFFER_BYTES });
  } catch (error) {
    const detail = [error.stderr, error.message].filter(part => part && part.trim().length > 0).join("\n");
    throw new Error(`prettier failed for ${absolute}:\n${detail}`);
  }
}

const check = process.argv.includes("--check");
let failed = false;
const files = new Set([...regionsByFile.keys(), ...untracked]);
for (const file of files) {
  const absolute = resolve(root, file);
  try {
    const current = readFileSync(absolute, "utf8");
    const formatted = prettierText(absolute);
    if (formatted === current) continue;
    if (check) {
      process.stderr.write(`fmt: formatting drift in ${file}\n`);
      failed = true;
    } else {
      writeFileSync(absolute, formatted);
      process.stdout.write(`Formatted ${file}.\n`);
    }
  } catch (error) {
    process.stderr.write(`fmt: ${error instanceof Error ? error.message : String(error)}\n`);
    failed = true;
  }
}
if (files.size === 0) process.stdout.write("No changed TypeScript files to format.\n");
if (failed) process.exitCode = 1;
