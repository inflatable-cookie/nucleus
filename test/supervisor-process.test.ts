import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnDetachedSupervisor } from "../core/qa/supervisor-process";
import { hostRunProcessStartIdentity } from "../core/machine/start-identity";

/** Wait for one written file, so the detached child's own work is observed and not assumed. */
async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the detached supervisor's record");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("a retained launch returns the parent's own child exit for this supervisor, with both start identities", async t => {
  const directory = mkdtempSync(join(tmpdir(), "supervisor-process-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entry = join(directory, "entry.mjs");
  // Long enough that the live identity can be read before the child exits.
  writeFileSync(entry, "setTimeout(() => process.exit(7), 400);\n");
  const retained = spawnDetachedSupervisor({ entry, argv: ["ignored"], failureMessage: "the test supervisor could not start", retainChild: true });
  assert.ok(retained.pid > 0, "the retained launch still reports the supervisor's pid");
  const liveIdentity = hostRunProcessStartIdentity(retained.pid);
  const exit = await retained.exited;
  assert.equal(exit.state, "observed", "the parent observed its actual child's exit");
  assert.equal(exit.pid, retained.pid);
  assert.equal(exit.code, 7, "the child's own exit code is retained");
  assert.equal(exit.signal, null);
  assert.equal(exit.startIdentity, liveIdentity, "the retained start identity is the identity read while the child was alive");
  assert.equal(exit.source, "child-exit-event", "the wait is the parent's child exit event, not a census, EOF or poll");
});

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
