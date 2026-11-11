import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Fixtures use the run-owned temporary directory, or an explicitly configured scratch root. */
export const SCRATCH_ROOT = process.env.TMPDIR || process.env.NUCLEUS_SCRATCH_ROOT || "";

export function scratchFixtureParent(): string {
  assert.ok(SCRATCH_ROOT && isAbsolute(SCRATCH_ROOT), "Set TMPDIR or NUCLEUS_SCRATCH_ROOT to an owned absolute scratch directory");
  assert.ok(existsSync(SCRATCH_ROOT), `Configured scratch root ${SCRATCH_ROOT} is absent`);
  const parent = resolve(SCRATCH_ROOT);
  process.env.TMPDIR = parent;
  process.env.TMP = parent;
  process.env.TEMP = parent;
  return parent;
}
