import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fixture, runningPid, wait } from "./support/run-process-cleanup-fixture";
import { readHostUidProcesses } from "../core/machine/host-process-listing";
import { pidAlive } from "../core/machine/pid";
import { sweepSettledRunProcesses } from "../core/machine/run-process-cleanup";
import { listedProcessLiveness, runProcessLivenessAsync, type RunProcessEnvironment } from "../core/machine/run-process-identity";
import type { HostProcessFact } from "../core/host/types";

/**
 * nucleus#1329: a settled-run sweep answers every liveness and identity check
 * from the one process table it read. The profile's dominant stack was
 * `sweep → runProcessLiveness → processStartIdentityLiveness → startLine →
 * spawnSync`, so the test counts both the listing and every synchronous child.
 */

/** Record every synchronous child a block spawns, by command. */
function syncSpawns() {
  const childProcess = createRequire(import.meta.url)("node:child_process") as {
    spawnSync: (...args: unknown[]) => unknown;
  };
  const original = childProcess.spawnSync;
  const commands: string[] = [];
  childProcess.spawnSync = (...args: unknown[]) => { commands.push(String(args[0])); return original(...args); };
  return { commands, restore: () => { childProcess.spawnSync = original; } };
}

async function hostTable(): Promise<HostProcessFact[]> {
  const read = await readHostUidProcesses();
  assert.equal(read.state, "listed");
  return read.state === "listed" ? read.processes : [];
}

test("one listing answers every liveness check in a sweep, and the sweep spawns nothing synchronously", async () => {
  const f = fixture();
  try {
    const first = f.run(), second = f.run();
    const one = f.orphan(first, "command"), two = f.orphan(second, "command");
    await wait(() => existsSync(one.ready) && existsSync(two.ready));
    f.release(first); f.release(second);
    const facts = await hostTable();
    let listings = 0;
    const spawned = syncSpawns();
    try {
      // Ownership is unreadable, so every process in the table is judged by a
      // liveness read: the shape that used to spawn one `ps` per fact.
      await sweepSettledRunProcesses(f.store, "fixture-host", { graceMs: 100,
        readProcesses: async () => { listings++; return facts; },
        readEnvironments: async (pids: readonly number[]) =>
          new Map(pids.map(pid => [pid, null] as [number, RunProcessEnvironment | null])) });
    } finally { spawned.restore(); }
    assert.equal(listings, 1, "one process listing for the whole sweep");
    assert.deepEqual(spawned.commands.filter(command => command === "ps"), [],
      "no liveness or identity read spawns a synchronous ps");
    assert.ok(runningPid(one.pid)); assert.ok(runningPid(two.pid));
    for (const run of [first, second]) {
      assert.equal(f.store.getMeta<{ pending: boolean }>(`runProcessCleanup:${run.id}`)?.pending, true);
      assert.match(f.store.events(f.task.id).find(event => event.kind === "run_process_cleanup_deferred")!.detail,
        /environment ownership is unreadable/);
    }
  } finally { await f.close(); }
});

test("a sweep that stops a run's leftover still spawns no synchronous ps, and re-reads only its own round", async () => {
  const f = fixture();
  try {
    const run = f.run(), live = f.run();
    const leftover = f.orphan(run, "command"), active = f.orphan(live, "scratch"), unowned = f.orphan(run, "none");
    await wait(() => [leftover, active, unowned].every(child => existsSync(child.ready)));
    f.release(run);
    const rounds: number[] = [];
    const spawned = syncSpawns();
    try {
      // Each round reads the table the host has now, exactly as a host pass does.
      await sweepSettledRunProcesses(f.store, "fixture-host", { graceMs: 100,
        readProcesses: async () => { rounds.push(Date.now()); return hostTable(); } });
    } finally { spawned.restore(); }
    assert.deepEqual(spawned.commands.filter(command => command === "ps"), [],
      "the whole sweep, including its stop round, spawns no synchronous ps");
    // A round that stopped something re-reads the table before deleting scratch
    // (#1306); each round is still exactly one listing.
    assert.ok(rounds.length >= 1 && rounds.length <= 2, `one listing per round: ${rounds.length}`);
    await wait(() => !runningPid(leftover.pid));
    assert.ok(runningPid(active.pid), "a live run's process is untouched");
    assert.ok(runningPid(unowned.pid), "an unowned process is untouched");
    assert.equal(existsSync(run.temporaryDirectory!), false);
    assert.ok(existsSync(live.temporaryDirectory!));
  } finally { await f.close(); }
});

test("the table's liveness answer equals a fresh identity read for the real stored run shapes", async () => {
  const f = fixture();
  try {
    const run = f.run();
    const child = f.orphan(run, "none");
    await wait(() => existsSync(child.ready));
    const facts = await hostTable();
    const table = listedProcessLiveness(facts);
    const identityOf = (pid: number) => facts.find(fact => fact.pid === pid)?.startIdentity ?? `${pid}@unknown`;
    const agree = async (pid: number, identity: string, expected: string) => {
      assert.equal(table(pid, identity), expected, `table ${pid}`);
      assert.equal(await runProcessLivenessAsync(pid, identity), expected, `fresh read ${pid}`);
    };
    // A live process this sweep is running inside, with its own recorded identity.
    await agree(process.pid, identityOf(process.pid), "alive");
    await agree(child.pid, identityOf(child.pid), "alive");
    // A recorded identity that no longer belongs to that pid.
    const recycled = identityOf(child.pid).replace(/^(\d+)@/, (_match, pid: string) => `${pid}@2026-11-18T00:00:00Z`);
    await agree(child.pid, recycled, "dead");
    // A pid nothing holds: only the kernel proves it gone, and both readers do.
    let absent = Math.max(...facts.map(fact => fact.pid)) + 1;
    for (let step = 0; step < 64 && pidAlive(absent); step += 1) absent += 1;
    assert.equal(pidAlive(absent), false, "the fixture found a pid nothing holds");
    await agree(absent, `${absent}@${identityOf(child.pid).split("@")[1] ?? "unknown"}`, "dead");
    // A malformed recorded identity is never a proof either way.
    assert.equal(table(child.pid, "not-an-identity"), "unknown");
  } finally { await f.close(); }
});
