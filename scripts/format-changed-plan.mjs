/**
 * Planning helpers for scripts/format-changed-typescript.mjs.
 *
 * Prettier's range formatting only selects statement-level source elements:
 * any range that starts inside a class body — a member or its JSDoc — snaps
 * out to the enclosing class declaration and reprints every unrelated member.
 * Range tuning cannot fix that, so the formatter formats each changed file
 * whole in memory, applies only formatter hunks that overlap changed lines,
 * and reports other hunks as drift.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UNIFIED_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse the `@@ -oldStart,oldCount +newStart,newCount @@` headers of a unified diff. */
export function unifiedHunks(diffText) {
  const hunks = [];
  for (const line of diffText.split("\n")) {
    const match = UNIFIED_HUNK.exec(line);
    if (match) {
      hunks.push({
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
      });
    }
  }
  return hunks;
}

/** Changed regions on the new-file side of a `git diff HEAD` unified diff. */
export function changedRegionsFromDiff(diffText) {
  const regionsByFile = new Map();
  let currentFile;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      currentFile = /^\+\+\+ b\/(.+)$/.exec(line)?.[1];
      continue;
    }
    const hunk = UNIFIED_HUNK.exec(line);
    if (hunk && currentFile) {
      const regions = regionsByFile.get(currentFile) ?? [];
      regions.push({ line: Number(hunk[3]), count: hunk[4] === undefined ? 1 : Number(hunk[4]) });
      regionsByFile.set(currentFile, regions);
    }
  }
  return regionsByFile;
}

/**
 * Expand changed regions by `slack` lines on each side and merge overlapping
 * or adjacent results into 1-based inclusive line intervals.
 */
export function expandedIntervals(regions, slack) {
  const sorted = regions
    .map(region => ({
      start: Math.max(1, region.line - slack),
      end: region.line + region.count - 1 + slack,
    }))
    .sort((left, right) => left.start - right.start);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + 1) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** The hunk's extent on the old side, as a 1-based inclusive line interval. */
function hunkExtent(hunk) {
  const start = Math.max(1, hunk.oldStart);
  const end = Math.max(start, hunk.oldStart + Math.max(hunk.oldCount, 1) - 1);
  return { start, end };
}

/** True when a diff hunk's old-side extent lies inside one expanded interval. */
export function hunkIsContained(hunk, intervals) {
  const { start, end } = hunkExtent(hunk);
  return intervals.some(interval => start >= interval.start && end <= interval.end);
}

/** Unified diff of two in-memory texts, via `git diff --no-index` on temp copies. */
export function gitUnifiedDiff(left, right) {
  const directory = mkdtempSync(join(tmpdir(), "paseo-fmt-"));
  try {
    const leftPath = join(directory, "current");
    const rightPath = join(directory, "formatted");
    writeFileSync(leftPath, left);
    writeFileSync(rightPath, right);
    const result = spawnSync("git", ["diff", "--no-index", "--unified=0", "--no-color", leftPath, rightPath], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    // git diff exits 1 when the files differ; anything else is a failure.
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(result.stderr?.trim() || `git diff --no-index exited ${result.status}`);
    }
    return result.stdout;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Decide whether `formatted` may replace `current`. The write is safe only
 * when every unified-diff hunk between the two texts lies inside the changed
 * regions expanded by `slack` lines; anything wider is formatting drift that
 * must not be adopted silently.
 */
export function formattingPlan({ current, formatted, regions, slack, runUnifiedDiff }) {
  const intervals = expandedIntervals(regions, slack);
  let hunks;
  try {
    hunks = unifiedHunks(runUnifiedDiff(current, formatted));
  } catch (error) {
    return { safe: false, reason: "diff-failed", detail: String(error instanceof Error ? error.message : error) };
  }
  const selected = hunks.filter(hunk => {
    const { start, end } = hunkExtent(hunk);
    return intervals.some(interval => hunk.oldCount === 0
      ? start >= interval.start - 1 && start <= interval.end
      : start <= interval.end && end >= interval.start);
  });
  const drift = hunks.filter(hunk => !selected.includes(hunk));
  if (selected.length === 0) return { safe: true, text: current, drift: drift.map(hunk => hunkExtent(hunk).start) };

  const currentLines = current.split("\n");
  const formattedLines = formatted.split("\n");
  for (const hunk of [...selected].sort((a, b) => b.oldStart - a.oldStart)) {
    const start = Math.max(0, hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1);
    const replacementStart = Math.max(0, hunk.newStart - 1);
    currentLines.splice(start, hunk.oldCount, ...formattedLines.slice(replacementStart, replacementStart + hunk.newCount));
  }
  return { safe: true, text: currentLines.join("\n"), drift: drift.map(hunk => hunkExtent(hunk).start) };
}
