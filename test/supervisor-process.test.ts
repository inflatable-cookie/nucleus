import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnDetachedSupervisor } from "../core/qa/supervisor-process";

/** Wait for one written file, so the detached child's own work is observed and not assumed. */
async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the detached supervisor's record");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("a detached supervisor launch carries the entry's argv, its token last, and the repository root as cwd", async t => {
  const directory = mkdtempSync(join(tmpdir(), "supervisor-process-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const record = join(directory, "launch.json");
  const entry = join(directory, "entry.mjs");
  writeFileSync(entry, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
`);
  const pid = spawnDetachedSupervisor({
    entry, argv: ["/plan.json", "identity-token"], failureMessage: "the test supervisor could not start",
  });
  assert.ok(pid > 0, "the launch reports the detached supervisor's pid");
  await until(() => existsSync(record));
  const observed = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; cwd: string };
  assert.deepEqual(observed.argv, ["/plan.json", "identity-token"], "the entry's own arguments, the run token last");
  assert.equal(observed.cwd.replace(/\/$/, ""), fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""),
    "the supervisor runs from the repository root, as the entries expect");
});
