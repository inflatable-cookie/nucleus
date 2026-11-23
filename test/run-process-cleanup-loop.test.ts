/**
 * Settled-run process cleanup finishes instead of looping (perf pass, 2026-11-23).
 *
 * The live service swept about once a second and wrote a deferral event on almost
 * every sweep: the quantum's process read landed on the unbound adapter, a
 * read-only folder in scratch refused retirement, and a deferral was re-written
 * whenever its reason flipped. These tests drive the stored shapes that loop.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixture,
  runningPid,
  wait,
} from "./support/run-process-cleanup-fixture";
import {
  claimRunProcessSweep,
  sweepSettledRunProcesses,
} from "../core/machine/run-process-cleanup";
import { terminateHostProcessTargets } from "../core/machine/host-process-reap";
import { LaneScheduler } from "../core/scheduling/lane-scheduler";
import {
  TaskQuantum,
  type TaskQuantumContext,
} from "../core/scheduling/task-quantum";
import { QueueRuntime } from "../service/runtime-owner";
import { formatAgentId } from "../shared/agent-identity";
import { submissionSchema, type Run } from "../shared/contracts";
import type { Adapter } from "../core/host/adapter";
import type { HostProcessFact } from "../core/host/types";

const HEAD = "a".repeat(40);
const T3 = "t3code:cleanup-loop";

type Intent = {
  pending?: boolean;
  uncertainty?: string;
  deferred?: string;
};
const intentOf = (f: ReturnType<typeof fixture>, run: Run) =>
  f.store.getMeta<Intent>(`runProcessCleanup:${run.id}`);
const deferrals = (f: ReturnType<typeof fixture>, run: Run) =>
  f.store
    .events(f.task.id)
    .filter(
      (event) =>
        event.kind === "run_process_cleanup_deferred" &&
        event.detail.includes(run.id),
    );
async function table(f: ReturnType<typeof fixture>) {
  const read = await f.listing();
  assert.equal(read.state, "listed");
  return read.state === "listed" ? read.processes : [];
}

test("the quantum's sweep reads the T3 host's own process reader", async (t: TestContext) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cleanup-loop-")));
  const reads: string[] = [];
  const t3 = {
    hostId: T3,
    isConnected: () => true,
    capabilities: () => ({
      reportingViaMcp: false,
      supportsCoordinatorRecovery: true,
    }),
    catalog: async () => ({ providers: [] }),
    profiles: async () => [],
    validate: async () => HEAD,
    findWorkspaces: async () => [],
    findAgents: async () => [],
    createWorkspace: async () => {
      throw new Error("fixtures do not create workspaces");
    },
    verifyWorkspace: async () => {},
    createAgent: async () => {
      throw new Error("fixtures do not create agents");
    },
    observe: async (id: string) => ({
      id,
      workspaceId: "t3-ws",
      status: "closed",
      active: false,
      permissions: false,
      error: "",
    }),
    archiveAgent: async () => {},
    verifyPr: async () => {
      throw new Error("not used");
    },
    hostProcessListing: async (): Promise<HostProcessFact[]> => {
      reads.push(T3);
      return [];
    },
  } as unknown as Adapter;
  const runtime = new QueueRuntime({
    dataDir: join(root, "data"),
    hostHome: join(root, "no-paseo"),
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.started;
  runtime.hostRegistry.connect(T3, "ws://127.0.0.1:3773/ws", {
    adapter: t3,
    admission: runtime.admission,
  });
  await runtime.ensureBootstrap();
  const unboundReads: string[] = [];
  runtime.engine.unboundPortRead = (port) => unboundReads.push(port);
  const store = runtime.store;
  const task = store.insert(
    submissionSchema.parse({
      submissionId: "cleanup-loop-1",
      title: "Settled T3 task",
      repoPath: join(root, "repo"),
      planningCommit: HEAD,
      handoffPath: "brief.md",
      originAgentId: formatAgentId(T3, "planner"),
    }),
    T3,
    "Brief",
    HEAD,
  );
  const run: Run = {
    id: "settled-t3-run",
    taskId: task.id,
    role: "revision",
    generation: 1,
    head: HEAD,
    base: HEAD,
    agentId: "t3-worker",
    workspaceId: "t3-ws",
    profile: null,
    status: "running",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
    hostId: T3,
  };
  store.putRun(run);
  store.update(task.id, { runId: run.id, agentId: run.agentId });
  store.putRun({ ...run, released: true, status: "finished", active: false });
  store.update(task.id, { phase: "done" });
  // The live record: every earlier sweep deferred it as unobserved.
  store.setMeta(`runProcessCleanup:${run.id}`, {
    ...store.getMeta<object>(`runProcessCleanup:${run.id}`),
    pending: true,
    uncertainty: JSON.stringify({
      reason: "process table observation is unavailable",
      processes: [],
    }),
  });

  // The bootstrap pass swept this host before the record existed; that window is past.
  claimRunProcessSweep(store, T3, { force: true, now: 0 });
  runtime.engine.taskQuantumOwner.scheduleRunProcessCleanup(task.id);
  const settled = () =>
    store.getMeta<Intent>(`runProcessCleanup:${run.id}`)?.pending === false;
  for (let deadline = Date.now() + 5_000; !settled() && Date.now() < deadline; )
    await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(reads, [T3], "the T3 adapter's reader answered the sweep");
  assert.deepEqual(unboundReads, [], "nothing read the unbound fallback");
  assert.equal(
    store.getMeta<Intent>(`runProcessCleanup:${run.id}`)?.pending,
    false,
    "the observed sweep settled the run's cleanup",
  );
});

test("a read-only folder a tool left in scratch is retired with the leaf", async () => {
  const f = fixture();
  const outside = join(f.root, "outside-read-only");
  try {
    const run = f.run();
    const scratch = run.temporaryDirectory!;
    const frozen = join(scratch, "copilot-acp-frozen-executable.Abc123");
    mkdirSync(join(frozen, "nested"), { recursive: true });
    writeFileSync(join(frozen, "copilot-executable.bin"), "binary");
    writeFileSync(join(frozen, "nested", "data"), "data");
    chmodSync(join(frozen, "copilot-executable.bin"), 0o400);
    chmodSync(join(frozen, "nested"), 0o500);
    chmodSync(frozen, 0o500);
    // A link out of the leaf is never followed: its target keeps its mode.
    mkdirSync(outside);
    chmodSync(outside, 0o500);
    symlinkSync(outside, join(scratch, "link-out"));
    f.release(run);

    await f.cleanup();

    assert.equal(existsSync(scratch), false, "the whole leaf is gone");
    assert.equal(intentOf(f, run)?.pending, false);
    assert.equal(deferrals(f, run).length, 0);
    assert.equal(
      statSync(outside).mode & 0o777,
      0o500,
      "the link's target outside the leaf was not touched",
    );
  } finally {
    if (existsSync(outside)) chmodSync(outside, 0o700);
    await f.close();
  }
});

test("repeated identical failures write one deferral event", async () => {
  const f = fixture();
  try {
    const run = f.run();
    f.release(run);
    // The live shape: retirement keeps refusing, and some sweeps cannot read the
    // process table at all.
    (
      f.store as unknown as { runScratchRemover: (d: string) => boolean }
    ).runScratchRemover = () => false;
    const facts = await table(f);
    const sweeps = 20;
    for (let index = 0; index < sweeps; index++)
      await sweepSettledRunProcesses(f.store, "fixture-host", {
        pendingOnly: true,
        readProcesses: async () => (index % 2 ? null : facts),
      });
    // Before this change the same 20 sweeps wrote 20 events: the reason flipped
    // between "unavailable" and "refused" on every sweep.
    assert.equal(
      deferrals(f, run).length,
      1,
      "one event for one unchanged failure",
    );
    const intent = intentOf(f, run)!;
    assert.equal(intent.pending, true);
    assert.match(
      intent.uncertainty ?? "",
      /scratch retirement was refused/,
      "an unobserved read never replaced what the sweep had observed",
    );
    // A different reason is news and is written once.
    (
      f.store as unknown as { runScratchRemover: (d: string) => boolean }
    ).runScratchRemover = () => true;
    await sweepSettledRunProcesses(f.store, "fixture-host", {
      pendingOnly: true,
      readProcesses: async () => facts,
    });
    assert.equal(intentOf(f, run)?.pending, false);
  } finally {
    await f.close();
  }
});

test("records that stay pending cost one sweep per pass, not one per quantum", async () => {
  const f = fixture();
  try {
    const run = f.run();
    f.release(run);
    (
      f.store as unknown as { runScratchRemover: (d: string) => boolean }
    ).runScratchRemover = () => false;
    const scheduler = new LaneScheduler(
      () => false,
      () => false,
      (work) => work(),
    );
    let sweeps = 0;
    const context = {
      stopped: false,
      store: f.store,
      adapter: {
        hostProcessListing: async () => table(f),
      },
      cleanContext: <T>(work: () => T) => work(),
      resolution: {
        onTaskHost: <T>(_owner: unknown, work: () => T) => work(),
      },
      scheduleLane: (
        key: string,
        priority: number,
        work: () => Promise<void> | void,
        options?: { coalesce?: string },
      ) =>
        scheduler.scheduleLane(
          key,
          priority,
          async () => {
            sweeps++;
            return work();
          },
          options,
        ),
    } as unknown as TaskQuantumContext;
    const quantum = new TaskQuantum(context);
    // Fifty quanta in one pass window, each settling and waiting in turn.
    for (let index = 0; index < 50; index++) {
      quantum.scheduleRunProcessCleanup(f.task.id);
      await scheduler.quiesce();
    }
    assert.equal(sweeps, 1, "one sweep for the whole window");
    assert.equal(deferrals(f, run).length, 1, "and one event");
    // The next pass window may sweep again.
    assert.equal(
      claimRunProcessSweep(f.store, "fixture-host", {
        now: Date.now() + 60_000,
      }),
      true,
    );
  } finally {
    await f.close();
  }
});

test("the kill-target proof signals only the settled run's own orphan", async () => {
  const f = fixture();
  try {
    const settled = f.run(),
      live = f.run();
    const own = f.orphan(settled, "command");
    // Another run that is still live, and a process with no run identity at all.
    const foreign = f.orphan(live, "scratch");
    const unowned = f.orphan(settled, "none");
    await wait(() =>
      [own, foreign, unowned].every((child) => existsSync(child.ready)),
    );
    f.release(settled);
    const signalled: number[] = [];

    await sweepSettledRunProcesses(f.store, "fixture-host", {
      graceMs: 100,
      readProcesses: async () => table(f),
      terminate: (targets, options) => {
        signalled.push(...targets.map((target) => target.pid));
        return terminateHostProcessTargets(targets, options);
      },
    });

    assert.deepEqual(signalled, [own.pid], "only the run's own orphan");
    await wait(() => !runningPid(own.pid));
    assert.ok(runningPid(foreign.pid), "the live run's process is untouched");
    assert.ok(runningPid(unowned.pid), "an unowned process is untouched");
  } finally {
    await f.close();
  }
});
