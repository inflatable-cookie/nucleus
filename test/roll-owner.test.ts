/**
 * The host-independent main-channel roll owner (nucleus#1454): one owner per data
 * home, started by any starter, that exits on its own with no service and nothing
 * pending. Every spawn here is a fake; the rolls themselves are covered by the
 * roll suites, which now drive a `RollOwner` directly.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ensureRollOwner, RollOwner, ROLL_OWNER_FILE, ROLL_OWNER_LAUNCH_FILE } from "../service/roll/owner";
import { writeServiceRoll } from "../service/transport/identity";
import { backendSourceDigest } from "../shared/service/build";

function scratchRoot(prefix: string): string {
  const scratch = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  if (!scratch) throw new Error("the run scratch volume is required");
  return realpathSync(mkdtempSync(join(realpathSync(scratch), prefix)));
}

/** A fixture home and data home, so no test touches the operator's install base. */
function fixtureEnvironment(prefix: string, mainChannel: boolean) {
  const root = scratchRoot(prefix);
  const home = join(root, "home");
  const dataDir = join(root, "data");
  mkdirSync(join(home, ".local", "share", "nucleus"), { recursive: true });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (mainChannel) {
    writeFileSync(join(home, ".local", "share", "nucleus", "channel.json"), JSON.stringify({ channel: "main", repository: "/synthetic/repository" }));
  }
  return { root, home, dataDir };
}

/** A fixture source tree the owner can compute a backend identity for. */
function fixtureCheckout(root: string): string {
  const checkout = join(root, "checkout");
  for (const dir of ["core", "service", "shared", "hosts", "bin"]) mkdirSync(join(checkout, dir), { recursive: true });
  writeFileSync(join(checkout, "core", "entry.ts"), "export {};");
  writeFileSync(join(checkout, "shared", "entry.ts"), "export {};");
  writeFileSync(join(checkout, "bin", "queue-service.mjs"), "");
  return checkout;
}

function withHome<T>(home: string, body: () => T): T {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try { return body(); }
  finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
}

function fakeSpawn(pid = 4343) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnProcess = (command: string, args: string[]) => {
    calls.push({ command, args });
    return { pid, unref() {}, on() { return this; } } as unknown as ChildProcess;
  };
  return { calls, spawnProcess };
}

test("without a configured main channel, no owner is started", () => {
  const { home, dataDir, root } = fixtureEnvironment("owner-none-", false);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "queue-roll-owner.mjs"), "");
  const { calls, spawnProcess } = fakeSpawn();
  const launch = withHome(home, () => ensureRollOwner({ dataDir, root, spawnProcess, pidAlive: () => false }));
  assert.equal(launch.status, "no-main-channel");
  assert.equal(calls.length, 0);
});

test("a cold start spawns one owner, and concurrent starters share its launch claim and then its heartbeat", () => {
  const { home, dataDir, root } = fixtureEnvironment("owner-start-", true);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "queue-roll-owner.mjs"), "");
  const { calls, spawnProcess } = fakeSpawn(4343);
  const alive = (pid: number) => pid === 4343 || pid === process.pid;
  const options = { dataDir, root, spawnProcess, pidAlive: alive };
  const first = withHome(home, () => ensureRollOwner(options));
  assert.deepEqual(first, { status: "started", pid: 4343 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.args.includes(`--data-dir=${dataDir}`));
  assert.ok(calls[0]!.args.some(arg => arg.endsWith("queue-roll-owner.mjs")));
  assert.equal(JSON.parse(readFileSync(join(dataDir, ROLL_OWNER_LAUNCH_FILE), "utf8")).pid, 4343);

  // A second starter while the owner boots waits on its launch claim and spawns nothing.
  assert.deepEqual(withHome(home, () => ensureRollOwner(options)), { status: "claimed", pid: 4343 });
  assert.equal(calls.length, 1);

  // Once the owner has written its heartbeat, starters report it running.
  writeFileSync(join(dataDir, ROLL_OWNER_FILE), JSON.stringify({ pid: 4343, at: new Date().toISOString() }));
  assert.deepEqual(withHome(home, () => ensureRollOwner(options)), { status: "running", pid: 4343 });
  assert.equal(calls.length, 1);
});

test("a stale launch claim from a dead starter is reclaimed", () => {
  const { home, dataDir, root } = fixtureEnvironment("owner-stale-", true);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "queue-roll-owner.mjs"), "");
  writeFileSync(join(dataDir, ROLL_OWNER_LAUNCH_FILE), JSON.stringify({ pid: 999_999, at: new Date(0).toISOString() }));
  const { calls, spawnProcess } = fakeSpawn(4444);
  const launch = withHome(home, () => ensureRollOwner({ dataDir, root, spawnProcess, pidAlive: () => false }));
  assert.equal(launch.status, "started");
  assert.equal(calls.length, 1);
});

test("an owner with no service and nothing pending exits after its idle window and releases its heartbeat", async () => {
  const { home, dataDir, root } = fixtureEnvironment("owner-idle-", true);
  const checkout = fixtureCheckout(root);
  const owner = withHome(home, () => new RollOwner({ dataDir, sourcePath: checkout, rollCheckMs: 0, ownerIdleExitMs: 50 }));
  assert.equal(owner.pending(), false);
  const reason = await owner.run();
  assert.match(reason, /idle exit/);
  assert.equal(existsSync(join(dataDir, ROLL_OWNER_FILE)), false, "the heartbeat is released on exit");
});

test("an owner with an unfinished roll stays pending rather than exiting, and a second owner yields to a live heartbeat", async () => {
  const { home, dataDir, root } = fixtureEnvironment("owner-pending-", true);
  const checkout = fixtureCheckout(root);
  writeServiceRoll(dataDir, {
    status: "replacing", fromBuild: "a".repeat(16), toBuild: "b".repeat(16),
    digest: backendSourceDigest(checkout), at: new Date().toISOString(), detail: "Typecheck passed; replacing the service", deferrals: [],
  });
  const owner = withHome(home, () => new RollOwner({ dataDir, sourcePath: checkout, rollCheckMs: 0, ownerIdleExitMs: 50 }));
  assert.equal(owner.pending(), true, "a replacing record keeps the owner until it settles");

  // A live owner (this test's parent process) holds the heartbeat: a newcomer refuses to run beside it.
  writeFileSync(join(dataDir, ROLL_OWNER_FILE), JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
  const second = withHome(home, () => new RollOwner({ dataDir, sourcePath: checkout, rollCheckMs: 0, ownerIdleExitMs: 50 }));
  assert.match(await second.run(), /another roll owner/);
  assert.equal(JSON.parse(readFileSync(join(dataDir, ROLL_OWNER_FILE), "utf8")).pid, process.ppid, "the held heartbeat is not taken over");
});
