import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCpuProfile } from "../core/telemetry/cpu-profile";

test("captureCpuProfile writes a bounded owner-only profile of the calling thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nsq-prof-"));
  try {
    const busy = setInterval(() => { let x = 0; for (let i = 0; i < 2e5; i++) x += i; return x; }, 5);
    const result = await captureCpuProfile(join(dir, "profiles"), 1);
    clearInterval(busy);
    assert.equal(result.seconds, 1);
    assert.ok(result.nodes > 0);
    const profile = JSON.parse(readFileSync(result.path, "utf8")) as { nodes: unknown[]; samples: unknown[] };
    assert.ok(profile.nodes.length > 0 && profile.samples.length > 0);
    assert.equal(statSync(result.path).mode & 0o777, 0o600);
    assert.equal((await captureCpuProfile(join(dir, "profiles"), 0.2)).seconds, 1, "seconds are clamped to at least 1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
