import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertIsolatedDataDir } from "../scripts/acceptance/bb-private";

/**
 * The proof must never touch the operator's live BB. The refusal is behaviour, so it
 * is tested here rather than trusted to a private run: a live data directory, a parent
 * of it, a child of it and a symlink into it are all refused, and a directory inside
 * this run's own scratch root is not.
 */
test("the proof refuses any data directory that is, contains or sits inside the live one", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-isolation-"));
  try {
    const proofRoot = join(root, "proof");
    const live = join(root, "home", ".bb");
    mkdirSync(proofRoot, { recursive: true });
    mkdirSync(live, { recursive: true });
    const link = join(root, "live-link");
    symlinkSync(live, link);

    const isolated = join(proofRoot, "bb-data");
    mkdirSync(isolated);
    assert.deepEqual(assertIsolatedDataDir({ requested: isolated, live, proofRoot }), { ok: true });

    for (const requested of [live, join(live, "plugins"), root, link]) {
      const verdict = assertIsolatedDataDir({ requested, live, proofRoot });
      assert.equal(verdict.ok, false, `${requested} must be refused`);
      if (verdict.ok) continue;
      assert.match(verdict.reason, /live BB data directory|outside this run's scratch root/);
    }

    const outside = join(root, "elsewhere");
    mkdirSync(outside);
    const refused = assertIsolatedDataDir({ requested: outside, live, proofRoot });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, /outside this run's scratch root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
