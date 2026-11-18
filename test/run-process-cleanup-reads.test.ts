import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  runningPid,
  wait,
} from "./support/run-process-cleanup-fixture";
import { existsSync } from "node:fs";
import { processParentPid } from "../core/machine/process-identity";
import {
  darwinBbThreadEnvironments,
  darwinBbThreadFromProcargs,
  runProcessEnvironments,
} from "../core/machine/run-process-identity";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { sweepSettledRunProcesses } from "../core/machine/run-process-cleanup";

test("process environment reads retain the BB thread binding and no unrelated fields", async () => {
  const environments = await runProcessEnvironments([123], {
    platform: "darwin",
    darwinRead: async () =>
      "  123 agent --session BB_THREAD_ID=thr_fixture SECRET=private TMPDIR=/scratch\n",
  });
  assert.deepEqual(environments.get(123), { TMPDIR: "/scratch" });
  const unreadable = await runProcessEnvironments([123], {
    platform: "darwin",
    darwinRead: async () => {
      throw Error("unreadable");
    },
  });
  assert.equal(unreadable.get(123), null);
  const spoofed = await runProcessEnvironments([123], {
    platform: "darwin",
    darwinRead: async () =>
      "  123 agent BB_THREAD_ID=thr_fixture SECRET=private\n",
  });
  assert.equal(spoofed.get(123)?.BB_THREAD_ID, undefined);
  const procargs = Buffer.concat([
    Buffer.from([1, 0, 0, 0]),
    Buffer.from(
      "/agent\0\0agent\0OTHER=x BB_THREAD_ID=wrong\0BB_THREAD_ID=right\0\0",
    ),
  ]);
  assert.equal(darwinBbThreadFromProcargs(procargs), "right");
  assert.equal(darwinBbThreadFromProcargs(procargs.subarray(0, -2)), null);
});

test(
  "Darwin kernel reader reads an actual child environment with entry boundaries",
  { skip: process.platform !== "darwin" },
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
      {
        env: {
          ...process.env,
          OTHER: "contains BB_THREAD_ID=wrong",
          BB_THREAD_ID: "thr_fixture",
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    try {
      await once(child.stdout!, "data");
      assert.equal(
        (await darwinBbThreadEnvironments([child.pid!])).get(child.pid!),
        "thr_fixture",
      );
    } finally {
      child.kill();
      await once(child, "exit");
    }
  },
);

test("unavailable scans retain intent and scratch; a surviving identity is recorded and retried", async () => {
  const f = fixture();
  try {
    const run = f.run();
    f.release(run);
    await sweepSettledRunProcesses(f.store, "fixture-host", {
      readProcesses: async () => null,
    });
    assert.ok(f.store.getMeta(`runProcessCleanup:${run.id}`));
    assert.ok(existsSync(run.temporaryDirectory!));
    const read = await f.listing();
    assert.equal(read.state, "listed");
    if (read.state !== "listed") return;
    const fact = {
      ...read.processes.find((item) => item.pid === process.pid)!,
      pid: 999999,
      ppid: 1,
      command: `node ${run.temporaryDirectory}/tool.cjs`,
    };
    await sweepSettledRunProcesses(f.store, "fixture-host", {
      readProcesses: async () => [fact],
      readEnvironments: async () => new Map([[fact.pid, {}]]),
      terminate: async (targets) => ({
        terminated: [],
        failed: targets.map((target) => ({
          ...target,
          reason: "still running after SIGKILL",
        })),
        skippedPaseo: [],
      }),
    });
    assert.match(
      f.store
        .events(f.task.id)
        .find((event) => event.kind === "run_process_cleanup")!.detail,
      /still running after SIGKILL/,
    );
    assert.ok(existsSync(run.temporaryDirectory!));
    await f.cleanup();
    assert.equal(existsSync(run.temporaryDirectory!), false);
  } finally {
    await f.close();
  }
});

for (const failure of ["one process", "Darwin chunk"] as const)
  test(`an unreadable ${failure} retains scratch and intent until ownership can be read`, async () => {
    const f = fixture();
    try {
      const run = f.run(),
        child = await f.hostTool(run),
        foreign = f.orphan(run, "none");
      await wait(() => existsSync(foreign.ready));
      await f.cleanup();
      f.release(run);
      const read = await f.listing();
      assert.equal(read.state, "listed");
      if (read.state !== "listed") return;
      // The snapshot keeps the agent host in it: ownership is decided on a table
      // whose ancestry is the real one.
      const facts = read.processes.filter((fact) =>
        [child.host, child.tool, foreign.pid].includes(fact.pid),
      );
      assert.equal(facts.length, 3);
      await sweepSettledRunProcesses(f.store, "fixture-host", {
        graceMs: 100,
        readProcesses: async () => facts,
        readEnvironments: async (pids) => {
          if (failure === "Darwin chunk")
            return runProcessEnvironments(pids, {
              platform: "darwin",
              darwinRead: async () => {
                throw Error("fixture ps chunk failed");
              },
            });
          const environments = await runProcessEnvironments(pids);
          environments.set(child.tool, null);
          return environments;
        },
      });
      assert.ok(runningPid(child.tool));
      assert.ok(runningPid(foreign.pid));
      assert.ok(existsSync(run.temporaryDirectory!));
      assert.equal(
        f.store.getMeta<{ pending: boolean }>(`runProcessCleanup:${run.id}`)
          ?.pending,
        true,
      );
      assert.match(
        f.store
          .events(f.task.id)
          .find((event) => event.kind === "run_process_cleanup_deferred")!
          .detail,
        /environment ownership is unreadable/,
      );
      // The host exits: the tool is an orphan the retried read can prove and stop.
      process.kill(child.host, "SIGKILL");
      process.kill(child.helper, "SIGKILL");
      await wait(
        () =>
          !runningPid(child.host) &&
          !runningPid(child.helper) &&
          processParentPid(child.tool) === 1,
      );
      await f.cleanup();
      await wait(() => !runningPid(child.tool));
      assert.ok(runningPid(foreign.pid));
      assert.equal(existsSync(run.temporaryDirectory!), false);
    } finally {
      await f.close();
    }
  });
