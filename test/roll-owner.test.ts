/**
 * The host-independent main-channel roll owner (nucleus#1454): one owner per data
 * home, started by any starter, that exits on its own with no service and nothing
 * pending. Every spawn here is a fake; the rolls themselves are covered by the
 * roll suites, which now drive a `RollOwner` directly.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureRollOwner,
  RollOwner,
  ROLL_OWNER_FILE,
  ROLL_OWNER_LAUNCH_FILE,
} from "../service/roll/owner";
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
    writeFileSync(
      join(home, ".local", "share", "nucleus", "channel.json"),
      JSON.stringify({ channel: "main", repository: "/synthetic/repository" }),
    );
  }
  return { root, home, dataDir };
}

/** A fixture source tree the owner can compute a backend identity for. */
function fixtureCheckout(root: string): string {
  const checkout = join(root, "checkout");
  for (const dir of ["core", "service", "shared", "hosts", "bin"])
    mkdirSync(join(checkout, dir), { recursive: true });
  writeFileSync(join(checkout, "core", "entry.ts"), "export {};");
  writeFileSync(join(checkout, "shared", "entry.ts"), "export {};");
  writeFileSync(join(checkout, "bin", "queue-service.mjs"), "");
  return checkout;
}

function withHome<T>(home: string, body: () => T): T {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

function fakeSpawn(pid = 4343) {
  const calls: Array<{
    command: string;
    args: string[];
    options?: { cwd?: string };
  }> = [];
  const spawnProcess = (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    calls.push({ command, args, options });
    return {
      pid,
      unref() {},
      on() {
        return this;
      },
    } as unknown as ChildProcess;
  };
  return { calls, spawnProcess };
}

test("without a configured main channel, no owner is started", () => {
  const { home, dataDir, root } = fixtureEnvironment("owner-none-", false);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "queue-roll-owner.mjs"), "");
  const { calls, spawnProcess } = fakeSpawn();
  const launch = withHome(home, () =>
    ensureRollOwner({ dataDir, root, spawnProcess, pidAlive: () => false }),
  );
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
  assert.ok(calls[0]!.args.some((arg) => arg.endsWith("queue-roll-owner.mjs")));
  // A checkout root is never pruned and stays the cwd so `--import tsx`
  // resolves (nucleus#1566).
  assert.equal(calls[0]!.options?.cwd, root);
  assert.equal(
    JSON.parse(readFileSync(join(dataDir, ROLL_OWNER_LAUNCH_FILE), "utf8")).pid,
    4343,
  );

  // A second starter while the owner boots waits on its launch claim and spawns nothing.
  assert.deepEqual(
    withHome(home, () => ensureRollOwner(options)),
    { status: "claimed", pid: 4343 },
  );
  assert.equal(calls.length, 1);

  // Once the owner has written its heartbeat, starters report it running.
  writeFileSync(
    join(dataDir, ROLL_OWNER_FILE),
    JSON.stringify({ pid: 4343, at: new Date().toISOString() }),
  );
  assert.deepEqual(
    withHome(home, () => ensureRollOwner(options)),
    { status: "running", pid: 4343 },
  );
  assert.equal(calls.length, 1);
});

test("an installed root spawns the owner on the stable data home", () => {
  const { home, dataDir, root } = fixtureEnvironment("owner-installed-", true);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "queue-roll-owner.mjs"), "");
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ format: "nucleus-package-v1", files: {} }));
  const { calls, spawnProcess } = fakeSpawn(4343);
  const launch = withHome(home, () =>
    ensureRollOwner({ dataDir, root, spawnProcess, pidAlive: () => false }),
  );
  assert.deepEqual(launch, { status: "started", pid: 4343 });
  assert.equal(calls.length, 1);
  // A version folder is pruned by retention, so an installed owner never
  // keeps it as its working directory (nucleus#1566).
  assert.equal(calls[0]!.options?.cwd, dataDir);
});

test("a stale launch claim from a dead starter is reclaimed", () => {
  const { home, dataDir, root } = fixtureEnvironment("owner-stale-", true);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "queue-roll-owner.mjs"), "");
  writeFileSync(
    join(dataDir, ROLL_OWNER_LAUNCH_FILE),
    JSON.stringify({ pid: 999_999, at: new Date(0).toISOString() }),
  );
  const { calls, spawnProcess } = fakeSpawn(4444);
  const launch = withHome(home, () =>
    ensureRollOwner({ dataDir, root, spawnProcess, pidAlive: () => false }),
  );
  assert.equal(launch.status, "started");
  assert.equal(calls.length, 1);
});

test("an owner with no service and nothing pending exits after its idle window and releases its heartbeat", async () => {
  const { home, dataDir, root } = fixtureEnvironment("owner-idle-", true);
  const checkout = fixtureCheckout(root);
  const owner = withHome(
    home,
    () =>
      new RollOwner({
        dataDir,
        sourcePath: checkout,
        rollCheckMs: 0,
        ownerIdleExitMs: 50,
      }),
  );
  assert.equal(owner.pending(), false);
  const reason = await owner.run();
  assert.match(reason, /idle exit/);
  assert.equal(
    existsSync(join(dataDir, ROLL_OWNER_FILE)),
    false,
    "the heartbeat is released on exit",
  );
});

test("an owner with an unfinished roll stays pending rather than exiting, and a second owner yields to a live heartbeat", async () => {
  const { home, dataDir, root } = fixtureEnvironment("owner-pending-", true);
  const checkout = fixtureCheckout(root);
  writeServiceRoll(dataDir, {
    status: "replacing",
    fromBuild: "a".repeat(16),
    toBuild: "b".repeat(16),
    digest: backendSourceDigest(checkout),
    at: new Date().toISOString(),
    detail: "Typecheck passed; replacing the service",
    deferrals: [],
  });
  const owner = withHome(
    home,
    () =>
      new RollOwner({
        dataDir,
        sourcePath: checkout,
        rollCheckMs: 0,
        ownerIdleExitMs: 50,
      }),
  );
  assert.equal(
    owner.pending(),
    true,
    "a replacing record keeps the owner until it settles",
  );

  // A live owner (this test's parent process) holds the heartbeat: a newcomer refuses to run beside it.
  writeFileSync(
    join(dataDir, ROLL_OWNER_FILE),
    JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }),
  );
  const second = withHome(
    home,
    () =>
      new RollOwner({
        dataDir,
        sourcePath: checkout,
        rollCheckMs: 0,
        ownerIdleExitMs: 50,
      }),
  );
  assert.match(await second.run(), /another roll owner/);
  assert.equal(
    JSON.parse(readFileSync(join(dataDir, ROLL_OWNER_FILE), "utf8")).pid,
    process.ppid,
    "the held heartbeat is not taken over",
  );
});

test("starter death between spawn and launch-claim transfer cannot produce two active roll owners", async () => {
  const { home, dataDir, root } = fixtureEnvironment(
    "owner-crash-window-",
    true,
  );
  const checkout = fixtureCheckout(root);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "queue-roll-owner.mjs"), "");

  // Simulate starter 1 having claimed the launch file, spawned owner 1, and died
  // before overwriting the launch claim with owner 1's PID.
  const deadStarterPid = 999_998;
  writeFileSync(
    join(dataDir, ROLL_OWNER_LAUNCH_FILE),
    JSON.stringify({ pid: deadStarterPid, at: new Date().toISOString() }),
  );

  // Starter 2 arrives before owner 1 claims the heartbeat, reclaims the dead starter's
  // launch file, and spawns owner 2.
  const { calls, spawnProcess } = fakeSpawn(4545);
  const launch2 = withHome(home, () =>
    ensureRollOwner({
      dataDir,
      root,
      spawnProcess,
      pidAlive: (pid) => pid === 4545,
    }),
  );
  assert.deepEqual(launch2, { status: "started", pid: 4545 });
  assert.equal(calls.length, 1);

  // Both owner 1 and owner 2 start on the same data home. Exactly one acquires
  // ROLL_OWNER_FILE exclusively and runs; the loser exits immediately without
  // overwriting or releasing the winner's claim.
  const owner1 = withHome(
    home,
    () =>
      new RollOwner({
        dataDir,
        sourcePath: checkout,
        rollCheckMs: 0,
        ownerIdleExitMs: 120,
      }),
  );
  const owner2 = withHome(
    home,
    () =>
      new RollOwner({
        dataDir,
        sourcePath: checkout,
        rollCheckMs: 0,
        ownerIdleExitMs: 120,
      }),
  );
  const [reason1, reason2] = await Promise.all([owner1.run(), owner2.run()]);
  const reasons = [reason1, reason2];
  assert.equal(
    reasons.filter((r) => /another roll owner/.test(r)).length,
    1,
    `expected one owner to yield, got: ${reasons.join(" | ")}`,
  );
  assert.equal(
    reasons.filter((r) => /idle exit/.test(r)).length,
    1,
    `expected one owner to run until idle exit, got: ${reasons.join(" | ")}`,
  );
  assert.equal(
    existsSync(join(dataDir, ROLL_OWNER_FILE)),
    false,
    "winner releases heartbeat on exit",
  );
});

test("stale heartbeat from a dead owner is reclaimed by exactly one concurrent newcomer", async () => {
  const { home, dataDir, root } = fixtureEnvironment(
    "owner-stale-reclaim-",
    true,
  );
  const checkout = fixtureCheckout(root);
  writeFileSync(
    join(dataDir, ROLL_OWNER_FILE),
    JSON.stringify({
      pid: 999_997,
      at: new Date(0).toISOString(),
      token: "dead-owner",
    }),
  );

  const owner1 = withHome(
    home,
    () =>
      new RollOwner({
        dataDir,
        sourcePath: checkout,
        rollCheckMs: 0,
        ownerIdleExitMs: 120,
      }),
  );
  const owner2 = withHome(
    home,
    () =>
      new RollOwner({
        dataDir,
        sourcePath: checkout,
        rollCheckMs: 0,
        ownerIdleExitMs: 120,
      }),
  );
  const [reason1, reason2] = await Promise.all([owner1.run(), owner2.run()]);
  const reasons = [reason1, reason2];
  assert.equal(
    reasons.filter((r) => /another roll owner/.test(r)).length,
    1,
    `expected one newcomer to yield, got: ${reasons.join(" | ")}`,
  );
  assert.equal(
    reasons.filter((r) => /idle exit/.test(r)).length,
    1,
    `expected one newcomer to reclaim and run, got: ${reasons.join(" | ")}`,
  );
  assert.equal(
    existsSync(join(dataDir, ROLL_OWNER_FILE)),
    false,
    "reclaimed heartbeat is released on exit",
  );
});
