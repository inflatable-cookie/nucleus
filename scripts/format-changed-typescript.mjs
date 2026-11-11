#!/usr/bin/env node
/**
 * effigy fmt: format the TypeScript files this worktree changed.
 *
 * Prettier's range formatting only selects statement-level source elements,
 * so a range that starts inside a class body — a member or its JSDoc — snaps
 * out to the enclosing class declaration and reprints every unrelated member,
 * and per-hunk bottom-up runs then point later ranges at shifted offsets.
 * Instead, each changed file is formatted whole in memory, then only formatter
 * diff hunks that overlap the source change are applied. Unrelated formatting
 * drift is reported and left untouched.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedRegionsFromDiff, formattingPlan, gitUnifiedDiff } from "./format-changed-plan.mjs";

const root = process.cwd();
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const prettier = resolve(scriptDirectory, "../node_modules/prettier/bin/prettier.cjs");
const BUFFER_BYTES = 64 * 1024 * 1024;

const diff = execFileSync(
  "git",
  ["diff", "--no-ext-diff", "--no-color", "--unified=0", "HEAD", "--", ":(glob)**/*.ts", ":(glob)**/*.tsx"],
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

let skipped = 0;
let failed = false;
for (const [file, regions] of regionsByFile) {
  const absolute = resolve(root, file);
  let current;
  let formatted;
  try {
    current = readFileSync(absolute, "utf8");
    formatted = prettierText(absolute);
  } catch (error) {
    process.stderr.write(`fmt: ${error instanceof Error ? error.message : String(error)}\n`);
    failed = true;
    continue;
  }
  if (formatted === current) continue;
  const plan = formattingPlan({ current, formatted, regions, slack: 0, runUnifiedDiff: gitUnifiedDiff });
  if (plan.safe) {
    if (plan.text !== current) writeFileSync(absolute, plan.text);
    if (plan.drift.length) {
      process.stderr.write(`fmt: noted ${file}: formatting drift outside the changed hunks at line(s) ${plan.drift.join(", ")}; left unchanged.\n`);
    }
    if (plan.text === current) continue;
    process.stdout.write(`Formatted ${file} within the changed hunks.\n`);
  } else {
    skipped += 1;
    process.stderr.write(`fmt: skipped ${file}: the drift check failed (${plan.detail}); nothing was written.\n`);
  }
}

for (const file of untracked) {
  execFileSync(process.execPath, [prettier, "--write", resolve(root, file)], { cwd: root, stdio: "inherit" });
}

if (regionsByFile.size === 0 && untracked.length === 0) process.stdout.write("No changed TypeScript files to format.\n");
if (skipped > 0) process.stderr.write(`fmt: skipped ${skipped} changed file(s) because the diff could not be scoped safely.\n`);
if (failed) process.exitCode = 1;
