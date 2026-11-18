import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  fixture,
  runningPid,
  wait,
} from "./support/run-process-cleanup-fixture";
import {
  runProcessEnvironments,
  type RunProcessEnvironment,
} from "../core/machine/run-process-identity";
import { sweepSettledRunProcesses } from "../core/machine/run-process-cleanup";
import type { HostProcessFact } from "../core/host/types";

/**
 * nucleus#1306: one settled-run sweep takes one process-table snapshot and one
 * ownership read for every run it settles, a completed cleanup is not scanned
 * again at all, and a process read that never answers cannot hold the sweep.
 */

async function listing(
  f: ReturnType<typeof fixture>,
): Promise<HostProcessFact[]> {
  const read = await f.listing();
  assert.equal(read.state, "listed");
  return read.state === "listed" ? read.processes : [];
}

test("one process snapshot and one ownership read settle every run in a sweep", async () => {
  const f = fixture();
  try {
    const first = f.run(),
      second = f.run();
    const one = f.orphan(first, "command"),
      two = f.orphan(second, "command");
    await wait(() => existsSync(one.ready) && existsSync(two.ready));
    f.release(first);
    f.release(second);
    let snapshots = 0,
      ownership = 0;
    const facts = await listing(f);
    // Both runs are decided in one pass over the same table: each keeps its
    // owned process alive with a visible retry because ownership is unreadable.
    await sweepSettledRunProcesses(f.store, "fixture-host", {
      graceMs: 100,
      readProcesses: async () => {
        snapshots++;
        return facts;
      },
      readEnvironments: async (pids: readonly number[]) => {
        ownership++;
        return new Map(pids.map((pid) => [pid, null] as [number, null]));
      },
    });
    assert.equal(
      snapshots,
      1,
      "one process-table snapshot for the whole sweep",
    );
    assert.equal(ownership, 1, "one ownership read, shared by both runs");
    assert.ok(runningPid(one.pid));
    assert.ok(runningPid(two.pid));
    for (const run of [first, second]) {
      assert.equal(
        f.store.getMeta<{ pending: boolean }>(`runProcessCleanup:${run.id}`)
          ?.pending,
        true,
      );
      assert.ok(
        f.store
          .events(f.task.id)
          .some(
            (event) =>
              event.kind === "run_process_cleanup_deferred" &&
              event.detail.includes(run.id),
          ),
        "each run in the sweep answered for itself",
      );
    }
  } finally {
    await f.close();
  }
});

test("a settled run whose cleanup already completed is not scanned again", async () => {
  const f = fixture();
  try {
    const run = f.run(),
      child = f.orphan(run, "command");
    await wait(() => existsSync(child.ready));
    f.release(run);
    await f.cleanup();
    await wait(() => !runningPid(child.pid));
    assert.equal(
      f.store.getMeta<{ pending: boolean }>(`runProcessCleanup:${run.id}`)
        ?.pending,
      false,
      "the completed cleanup keeps its settled intent",
    );
    let snapshots = 0;
    await sweepSettledRunProcesses(f.store, "fixture-host", {
      readProcesses: async () => {
        snapshots++;
        return [];
      },
    });
    assert.equal(snapshots, 0, "a completed cleanup costs no process read");
  } finally {
    await f.close();
  }
});

test("a process read that never answers releases the sweep and retains its intent", async () => {
  const f = fixture();
  try {
    const run = f.run(),
      child = f.orphan(run, "command");
    await wait(() => existsSync(child.ready));
    f.release(run);
    const started = Date.now();
    await sweepSettledRunProcesses(f.store, "fixture-host", {
      readBoundMs: 60,
      readProcesses: () => new Promise<HostProcessFact[] | null>(() => {}),
    });
    assert.ok(
      Date.now() - started < 30_000,
      "the sweep answered instead of waiting for the read",
    );
    assert.ok(runningPid(child.pid), "nothing is signalled on an unread table");
    assert.ok(existsSync(run.temporaryDirectory!));
    assert.equal(
      f.store.getMeta<{ pending: boolean }>(`runProcessCleanup:${run.id}`)
        ?.pending,
      true,
    );
    // The retried read finds and stops it.
    await f.cleanup();
    await wait(() => !runningPid(child.pid));
    assert.equal(existsSync(run.temporaryDirectory!), false);
  } finally {
    await f.close();
  }
});

test("an ownership read that never answers leaves processes alive and the intent pending", async () => {
  const f = fixture();
  try {
    const run = f.run(),
      child = f.orphan(run, "command");
    await wait(() => existsSync(child.ready));
    f.release(run);
    const facts = await listing(f);
    await sweepSettledRunProcesses(f.store, "fixture-host", {
      graceMs: 100,
      readBoundMs: 60,
      readProcesses: async () => facts,
      readEnvironments: () =>
        new Promise<Map<number, RunProcessEnvironment | null>>(() => {}),
    });
    assert.ok(
      runningPid(child.pid),
      "the owned process is not signalled while its ownership is unknown",
    );
    assert.ok(existsSync(run.temporaryDirectory!));
    assert.match(
      f.store
        .events(f.task.id)
        .find((event) => event.kind === "run_process_cleanup_deferred")!.detail,
      /environment ownership is unreadable/,
    );
    await f.cleanup();
    await wait(() => !runningPid(child.pid));
  } finally {
    await f.close();
  }
});
