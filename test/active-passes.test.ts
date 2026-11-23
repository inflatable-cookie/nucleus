import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { enginePorts } from "../core/port-context";
import {
  FINISHED_CATCH_UP_PAGE,
  FRESH_FINISH_ATTEMPTS,
  HostPass,
  PAGE_ABORT_LIMIT,
  finishedCatchUpCursorKey,
} from "../core/scheduling/host-pass";
import type { Adapter } from "../core/host";
import type { Task } from "../shared/contracts";
import { fakeAdapter, submission } from "./support/fakes";
import { finishedThreadCleanupKey } from "../core/store/store-core";
import { HostOperationTimeoutError } from "../service/host-executor";

/**
 * Spec 069 §4 (Tom, 2026-11-22): a pass's cost grows with active work, never with
 * the retained history. Passes read indexed sets (live tasks per host, the active
 * set, owner stops) instead of copying every row; finished history is caught up a
 * page at a time on its own durable cursor.
 *
 * Everything here runs the real Store, Engine, sweep and host pass. Only the
 * task quantum is recorded instead of run, so a pass's own reads are what is
 * counted, and the adapter is a presentation host that counts every call.
 */

const HOST = "host-1";
const OTHER = "host-2";
type Loose = Record<string, any>;

function scratch(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ns-active-passes-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const insert = (store: Store, title: string, hostId = HOST) =>
  store.insert(submission({ title }), hostId, "handoff", "a".repeat(40));

/** A dispatched task: the workspace and worker a launch records. */
const launch = (store: Store, task: Task, active = true) =>
  store.update(
    task.id,
    {
      phase: "working",
      workspaceIntent: true,
      agentIntent: true,
      workspaceId: `ws-${task.id}`,
      agentId: `worker-${task.id}`,
      agentActive: active,
      runId: "initial",
    },
    "dispatched",
  );

/**
 * A merged closeout: done, its workspace archived, and the worker thread whose
 * cleanup the finished-thread catch-up still owes.
 */
const finish = (store: Store, task: Task) => {
  const current = store.task(task.id);
  return store.update(current.id, {
    phase: "done",
    agentActive: false,
    finishedAt: new Date().toISOString(),
    resolution: {
      ...current.resolution,
      mergedCommit: "c".repeat(40),
      archivedWorkspaceIds: current.workspaceId ? [current.workspaceId] : [],
    },
  });
};

function populate(store: Store, active: number, finished: number) {
  store.transaction(() => {
    for (let i = 0; i < finished; i++)
      finish(store, launch(store, insert(store, `Finished ${i}`), false));
    for (let i = 0; i < active; i++)
      launch(store, insert(store, `Active ${i}`));
  });
}

/**
 * Retained history at the live database's scale, quickly: one merged closeout is
 * written through the real funnels, and its stored row is copied under fresh
 * identities (task, submission, workspace and worker). Every copy is the exact
 * stored shape of a real closeout; the next open parses them into the projection.
 * Its thread cleanup is complete, as settled history's is (unless `owing`), and its
 * identities sort before any fresh task's, so a cursor page over it never reaches a
 * fresh finish.
 */
function retainHistory(
  store: Store,
  count: number,
  options: { owing?: boolean } = {},
) {
  if (!count) return;
  const template = finish(
    store,
    launch(store, insert(store, "Finished 0"), false),
  );
  const copy = store.db.prepare(
    `INSERT INTO tasks(id, submission, input_hash, data)
     SELECT ?, ?, input_hash, json_set(data, '$.id', ?, '$.submissionId', ?,
       '$.title', ?, '$.workspaceId', ?, '$.agentId', ?,
       '$.resolution.archivedWorkspaceIds', json_array(?))
     FROM tasks WHERE id=?`,
  );
  const cleaned = store.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)");
  if (!options.owing)
    store.setMeta(
      finishedThreadCleanupKey(template.id),
      new Date().toISOString(),
    );
  store.db.exec("BEGIN");
  for (let i = 1; i < count; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const submissionId = randomUUID();
    if (!options.owing)
      cleaned.run(
        finishedThreadCleanupKey(id),
        JSON.stringify(new Date().toISOString()),
      );
    copy.run(
      id,
      submissionId,
      id,
      submissionId,
      `Finished ${i}`,
      `ws-${id}`,
      `worker-${id}`,
      `ws-${id}`,
      template.id,
    );
  }
  store.db.exec("COMMIT");
}

/** A presentation host whose every call is counted, by method. */
function countingAdapter(calls: Record<string, number>, seen?: Loose) {
  const bump = (key: string, by = 1) => (calls[key] = (calls[key] ?? 0) + by);
  const adapter = fakeAdapter({
    hostId: HOST,
    observe: async (id: string) => ({
      id,
      workspaceId: null,
      status: "running" as const,
      active: true,
      permissions: false,
      error: "",
    }),
    beginHostPass: (tasks: readonly Task[]) =>
      void bump("beginHostPass.tasks", tasks.length),
    endHostPass: () => {},
    reconcileTaskRow: async () => {
      if (seen?.abortOnce) {
        seen.abortOnce = false;
        throw new HostOperationTimeoutError(
          "thread.observe",
          25,
          new Promise(() => {}),
        );
      }
    },
    rowSnoozeVisibility: async () => ({ kind: "clear" as const }),
    reconcileThreadTitles: async (tasks: readonly Task[]) =>
      void bump("reconcileThreadTitles.tasks", tasks.length),
    reconcileFinishedParents: async (
      tasks: readonly Task[],
      lookup?: (taskId: string) => Task | null,
    ) => {
      bump("reconcileFinishedParents.tasks", tasks.length);
      seen?.parents?.push(tasks.map((task) => task.id));
      // The host's own open bindings, resolved through the pass's lookup.
      seen?.resolved?.push(
        [...(seen.bindings ?? [])].filter((taskId: string) =>
          ["done", "cancelled"].includes(lookup?.(taskId)?.phase ?? ""),
        ),
      );
      return [];
    },
  }) as Loose;
  for (const key of Object.keys(adapter)) {
    const method = adapter[key];
    if (typeof method !== "function" || key === "isConnected") continue;
    adapter[key] = function (this: unknown, ...args: unknown[]) {
      bump(`call:${key}`);
      return method.apply(this, args);
    };
  }
  return adapter as unknown as Adapter;
}

/** A real engine over the store; the quantum is recorded, never run. */
function engineFor(
  t: TestContext,
  store: Store,
  adapter: Adapter,
  live = { up: true },
) {
  const engine = new Engine(store, adapter, 60_000);
  engine.hostIds = () => [HOST];
  engine.hostAvailable = (id) => id === HOST && live.up;
  const visited: string[] = [];
  engine.scheduleTaskQuantum = async (taskId) => {
    visited.push(taskId);
  };
  t.after(() => engine.stop());
  return { engine, visited };
}

function hostPassFor(engine: Engine) {
  return new HostPass(
    enginePorts(
      engine,
      [
        "adapter",
        "host",
        "inventoryHostMatches",
        "observeRetiredWorkers",
        "retiredObservationKey",
        "retiredObservationPlan",
        "scheduleLane",
        "stopped",
        "store",
      ],
      ["observationTargets"],
    ),
  );
}

/** Count the store's whole-history read and its per-task runs read on this instance. */
function countStoreReads(store: Store, calls: Record<string, number>) {
  const tasks = store.tasks.bind(store);
  store.tasks = () => {
    calls["store.tasks"] = (calls["store.tasks"] ?? 0) + 1;
    return tasks();
  };
  const runs = store.runs.bind(store);
  store.runs = (taskId: string) => {
    calls["store.runs"] = (calls["store.runs"] ?? 0) + 1;
    return runs(taskId);
  };
}

/**
 * One audit pass's reads and host calls over a store with `active` running tasks
 * and `finished` merged ones, after a service restart (the sets are rebuilt from
 * the projection on open, and no finished task is a fresh hint).
 */
async function passCost(t: TestContext, active: number, finished: number) {
  const path = join(scratch(t), "queue.sqlite");
  const seed = new Store(path);
  seed.setMeta("paused", false);
  seed.setMeta("globalLimit", 0);
  retainHistory(seed, finished);
  populate(seed, active, 0);
  seed.close();
  const store = new Store(path);
  t.after(() => store.close());
  const calls: Record<string, number> = {};
  const { engine } = engineFor(t, store, countingAdapter(calls));
  // The first pass reads the host's health; the measured pass is a steady one.
  await engine.auditPass(true);
  countStoreReads(store, calls);
  for (const key of Object.keys(calls)) delete calls[key];
  await engine.auditPass(true);
  assert.equal(store.getMeta("engineError"), "", "the pass ran clean");
  return { ...calls };
}

test("a pass over 2,000 finished tasks costs what it costs over 200, and history adds at most one page over none", async (t) => {
  const none = await passCost(t, 20, 0);
  const some = await passCost(t, 20, 200);
  const many = await passCost(t, 20, 2000);
  assert.deepEqual(
    many,
    some,
    "every read and host call is the same at 200 and 2,000 retained finished tasks",
  );
  assert.equal(many["store.tasks"], undefined, "no pass step copies every row");
  assert.equal(
    many["beginHostPass.tasks"],
    20,
    "observation reads the live set",
  );
  for (const key of new Set([...Object.keys(none), ...Object.keys(many)])) {
    const extra = (many[key] ?? 0) - (none[key] ?? 0);
    assert.ok(
      extra >= 0 && extra <= FINISHED_CATCH_UP_PAGE,
      `${key}: ${extra} more over 2,000 finished tasks than over none, within one catch-up page`,
    );
  }
  assert.equal(
    many["reconcileFinishedParents.tasks"],
    FINISHED_CATCH_UP_PAGE,
    "the parent archive reads one page of history",
  );
});

test("the slow cursor visits all finished history a page at a time, persists across a restart, and never skips a page on an aborted pass", async (t) => {
  const path = join(scratch(t), "queue.sqlite");
  const total = 2 * FINISHED_CATCH_UP_PAGE + 10;
  const seed = new Store(path);
  seed.setMeta("paused", false);
  populate(seed, 3, total);
  const expected = seed
    .tasks()
    .filter((task) => task.phase === "done")
    .map((task) => task.id)
    .sort();
  // Settled history: its thread cleanup is complete, so nothing here is a fresh hint.
  for (const id of expected)
    seed.setMeta(finishedThreadCleanupKey(id), new Date().toISOString());
  seed.close();

  const open = () => {
    const store = new Store(path);
    t.after(() => {
      try {
        store.close();
      } catch {
        /* closed by the roll below */
      }
    });
    const seen: Loose = { parents: [] as string[][] };
    const { engine } = engineFor(t, store, countingAdapter({}, seen));
    const pass = hostPassFor(engine);
    const run = () => engine.withHost(HOST, () => pass.run(HOST));
    return { store, engine, seen, run };
  };
  const cursor = (store: Store) =>
    store.getMeta(finishedCatchUpCursorKey(HOST));

  let service = open();
  await service.run();
  assert.deepEqual(
    service.seen.parents[0],
    expected.slice(0, FINISHED_CATCH_UP_PAGE),
    "the first page, in identity order",
  );
  assert.equal(
    cursor(service.store),
    expected[FINISHED_CATCH_UP_PAGE - 1],
    "the cursor's position is durable",
  );

  // A pass that a hung step aborts after reading its page does not move the cursor.
  service.seen.abortOnce = true;
  await service.run();
  assert.equal(service.seen.abortOnce, false, "the row step aborted the pass");
  assert.equal(cursor(service.store), expected[FINISHED_CATCH_UP_PAGE - 1]);

  // A service roll resumes from the recorded position, not from the start.
  await service.engine.stop();
  service.store.close();
  service = open();
  await service.run();
  assert.deepEqual(
    service.seen.parents[0],
    expected.slice(FINISHED_CATCH_UP_PAGE, 2 * FINISHED_CATCH_UP_PAGE),
    "the page the aborted pass read is the one read again",
  );
  await service.run();
  assert.deepEqual(
    service.seen.parents[1],
    expected.slice(2 * FINISHED_CATCH_UP_PAGE),
  );
  assert.equal(cursor(service.store), "", "the last page wraps the cursor");
  await service.run();
  assert.deepEqual(
    service.seen.parents[2],
    expected.slice(0, FINISHED_CATCH_UP_PAGE),
    "and the next pass starts over",
  );

  // A task that finishes now is caught up on the very next pass, beside the page.
  const running = service.store
    .tasks()
    .find((task) => task.phase === "working")!;
  finish(service.store, running);
  const fresh = await service.run();
  const after = expected[FINISHED_CATCH_UP_PAGE - 1]!;
  const page = [...expected, running.id]
    .sort()
    .filter((id) => id > after)
    .slice(0, FINISHED_CATCH_UP_PAGE);
  assert.deepEqual(
    new Set(service.seen.parents[3]),
    new Set([running.id, ...page]),
    "the fresh finish, then the cursor's next page",
  );
  assert.deepEqual(
    [...fresh.finishedCatchUp.keys()],
    [running.id],
    "only the fresh finish still owes thread cleanup",
  );
});

test("fresh finishes keep a prompt catch-up across an aborted pass and a restart, and parents come from the host's open bindings", async (t) => {
  const path = join(scratch(t), "queue.sqlite");
  const seed = new Store(path);
  seed.setMeta("paused", false);
  // Settled history whose identities sort before every fresh task: no cursor page
  // in this test reaches a fresh finish, so only its hint can.
  retainHistory(seed, 200);
  const [a, b, c] = ["A", "B", "C"].map((title) =>
    launch(seed, insert(seed, title)),
  ) as [Task, Task, Task];
  // A finishes just before the service rolls.
  finish(seed, a);
  seed.close();

  const store = new Store(path);
  t.after(() => store.close());
  const seen: Loose = {
    parents: [] as string[][],
    resolved: [] as string[][],
    bindings: new Set([a.id, b.id, c.id]),
  };
  const { engine } = engineFor(t, store, countingAdapter({}, seen));
  const pass = hostPassFor(engine);
  const run = () => engine.withHost(HOST, () => pass.run(HOST));

  const first = await run();
  assert.ok(
    first.finishedCatchUp.has(a.id),
    "a finish from before the roll still gets its thread cleanup on the first pass",
  );
  assert.deepEqual(
    seen.resolved[0],
    [a.id],
    "its parent is found from the host's own binding, whatever the pass listed",
  );

  // B finishes, and the next pass is aborted by a hung step after reading its hints.
  finish(store, b);
  seen.abortOnce = true;
  const aborted = await run();
  assert.equal(seen.abortOnce, false, "the row step aborted the pass");
  assert.equal(
    aborted.finishedCatchUp.size,
    0,
    "the aborted pass selected nothing",
  );
  const next = await run();
  assert.ok(
    next.finishedCatchUp.has(b.id),
    "the hint survived the aborted pass",
  );
  assert.deepEqual(new Set(seen.resolved.at(-1)), new Set([a.id, b.id]));

  // B's cleanup completes, so it leaves at once. A's never does: it keeps its prompt
  // place for its attempts (two completed passes so far), then waits for the cursor.
  store.setMeta(finishedThreadCleanupKey(b.id), new Date().toISOString());
  const later = [];
  for (let i = 0; i < 3; i++) later.push(await run());
  assert.deepEqual(
    later.map((result) => result.finishedCatchUp.has(a.id)),
    Array.from({ length: 3 }, (_, i) => i < FRESH_FINISH_ATTEMPTS - 2),
    "A's hint is spent after its attempts",
  );
  assert.ok(
    later.every((result) => !result.finishedCatchUp.has(b.id)),
    "a completed cleanup is never selected again",
  );
  assert.deepEqual(
    new Set(seen.resolved.at(-1)),
    new Set([a.id, b.id]),
    "both parents stay owed from the bindings whatever the hints say",
  );
});

test("after a restart behind 200 owed cleanups, a new finish is in the next pass and the last one before the roll is in the first", async (t) => {
  const path = join(scratch(t), "queue.sqlite");
  const seed = new Store(path);
  seed.setMeta("paused", false);
  // History whose thread cleanup is still owed, all seeded at start-up.
  retainHistory(seed, 200, { owing: true });
  const [before, after] = ["Before", "After"].map((title) =>
    launch(seed, insert(seed, title)),
  ) as [Task, Task];
  finish(seed, before);
  seed.close();

  const store = new Store(path);
  t.after(() => store.close());
  const { engine } = engineFor(t, store, countingAdapter({}));
  const pass = hostPassFor(engine);
  const run = () => engine.withHost(HOST, () => pass.run(HOST));

  const first = await run();
  assert.ok(
    first.finishedCatchUp.has(before.id),
    "the finish just before the roll heads the start-up backlog",
  );
  assert.ok(first.finishedCatchUp.size <= 2 * FINISHED_CATCH_UP_PAGE);
  finish(store, after);
  const next = await run();
  assert.ok(
    next.finishedCatchUp.has(after.id),
    "a finish after the roll goes ahead of the backlog",
  );
});

test("the slow cursor moves past a page that aborted its pass three times in a row", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("paused", false);
  retainHistory(store, 4 * FINISHED_CATCH_UP_PAGE);
  // The template closeout's own finish is a hint; take it so only the cursor reads.
  store.takeRecentlyFinishedHostTasks(HOST, Number.MAX_SAFE_INTEGER);
  const ids = store
    .tasks()
    .filter((task) => task.phase === "done")
    .map((task) => task.id)
    .sort();
  const seen: Loose = { parents: [] as string[][] };
  const { engine } = engineFor(t, store, countingAdapter({}, seen));
  const pass = hostPassFor(engine);
  const run = () => engine.withHost(HOST, () => pass.run(HOST));
  const page = (n: number) =>
    ids.slice(n * FINISHED_CATCH_UP_PAGE, (n + 1) * FINISHED_CATCH_UP_PAGE);

  await run();
  assert.deepEqual(seen.parents[0], page(0));
  for (let abort = 0; abort < PAGE_ABORT_LIMIT; abort++) {
    seen.abortOnce = true;
    await run();
    assert.equal(seen.abortOnce, false, "the row step aborted the pass");
    assert.deepEqual(
      seen.parents.at(-1),
      page(1),
      "the same page is read again",
    );
  }
  await run();
  assert.deepEqual(
    seen.parents.at(-1),
    page(2),
    "after the limit the cursor moves on instead of pinning on the hanging page",
  );
  assert.equal(store.getMeta(finishedCatchUpCursorKey(HOST)), page(2).at(-1));
});

test("the live, finished and owner-stop sets follow every write and are rebuilt on open", async (t) => {
  const path = join(scratch(t), "queue.sqlite");
  let store = new Store(path);
  const check = (label: string) => {
    const rows = store.tasks();
    for (const host of [HOST, OTHER]) {
      assert.deepEqual(
        store.liveHostTasks(host).map((task) => task.id),
        rows
          .filter(
            (task) =>
              task.hostId === host &&
              !["done", "cancelled"].includes(task.phase),
          )
          .map((task) => task.id),
        `${label}: live tasks on ${host}, newest first`,
      );
      const finished: string[] = [];
      for (let after: string | null = null; ; ) {
        const page = store.finishedHostTaskPage(host, after, 2);
        finished.push(...page.tasks.map((task) => task.id));
        if (!page.next) break;
        after = page.next;
      }
      assert.deepEqual(
        finished,
        rows
          .filter(
            (task) =>
              task.hostId === host &&
              ["done", "cancelled"].includes(task.phase),
          )
          .map((task) => task.id)
          .sort(),
        `${label}: finished tasks on ${host}, in identity order`,
      );
    }
    assert.deepEqual(
      store.taskHostIds().sort(),
      [...new Set(rows.map((task) => task.hostId!))].sort(),
      `${label}: hosts`,
    );
    assert.deepEqual(
      store.ownerStopTasks().map((task) => task.id),
      rows.filter((task) => task.resolution.ownerStop).map((task) => task.id),
      `${label}: owner stops`,
    );
  };

  const a = insert(store, "A");
  const b = insert(store, "B");
  const c = insert(store, "C", OTHER);
  const d = insert(store, "D");
  check("insert");
  launch(store, a);
  launch(store, b);
  check("phase change");
  finish(store, a);
  check("closeout");
  assert.deepEqual(
    store.takeRecentlyFinishedHostTasks(HOST, 10).map((task) => task.id),
    [a.id],
    "the closeout is a fresh hint for its host",
  );
  assert.deepEqual(
    store.takeRecentlyFinishedHostTasks(HOST, 10),
    [],
    "taken once",
  );
  store.update(c.id, { phase: "cancelled" });
  check("cancel");
  // A never-started task moved to its worker profile's host (the one host change an
  // update allows) moves between the hosts' sets.
  const e = insert(store, "E");
  check("insert again");
  store.update(
    e.id,
    {
      hostId: OTHER,
      hostSelection: { hostId: OTHER, basis: "worker_profile" },
    },
    "worker_host_moved",
  );
  check("host change");
  assert.equal(store.task(e.id).hostId, OTHER);
  store.update(d.id, {
    resolution: {
      ...store.task(d.id).resolution,
      ownerStop: {
        operationId: null,
        taskVersion: store.task(d.id).version,
        role: null,
        reason: "Owner stop",
        caller: null,
        targetRunIds: [],
        hadIntegrationTurn: false,
        mergeRequested: false,
        mergeHead: null,
        mergeRequestedAt: null,
        executorContinues: [],
        nonTransientIssue: null,
        cancellations: [],
        recordedAt: new Date().toISOString(),
      },
    },
  });
  check("owner stop");
  store.update(d.id, {
    resolution: { ...store.task(d.id).resolution, ownerStop: null },
  });
  check("owner stop cleared");
  store.update(c.id, { removedAt: new Date().toISOString() });
  check("removal");
  // A write that rolls back leaves every set as it was.
  assert.throws(() =>
    store.transaction(() => {
      finish(store, store.task(b.id));
      throw new Error("rolled back");
    }),
  );
  check("rollback");
  assert.equal(store.task(b.id).phase, "working");

  // A service restart rebuilds the sets from the projection; no hint survives.
  const before = {
    live: store.liveHostTasks(HOST).map((task) => task.id),
    other: store.liveHostTasks(OTHER).map((task) => task.id),
  };
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  check("restart");
  assert.deepEqual(
    {
      live: store.liveHostTasks(HOST).map((task) => task.id),
      other: store.liveHostTasks(OTHER).map((task) => task.id),
    },
    before,
  );
  assert.deepEqual(store.takeRecentlyFinishedHostTasks(OTHER, 10), []);
});

test("every live task is visited within bounded window passes, and finished history never is", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 0);
  populate(store, 60, 0);
  retainHistory(store, 500);
  const { engine, visited } = engineFor(t, store, countingAdapter({}));
  const live = new Set(store.liveHostTasks(HOST).map((task) => task.id));
  // Three windows of 25 cover 60 tasks; the fourth wraps to the start.
  for (let pass = 0; pass < 3; pass++) await engine.auditPass(false);
  assert.equal(visited.length, 60, "each live task once");
  assert.deepEqual(
    new Set(visited),
    live,
    "every live task, and only live ones",
  );
  visited.length = 0;
  await engine.auditPass(false);
  assert.equal(visited.length, 25, "the next window starts the fleet again");
  assert.ok(visited.every((id) => live.has(id)));
});

test("a host that is down is not walked again: its passes read nothing from it", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 0);
  populate(store, 5, 0);
  retainHistory(store, 200);
  const calls: Record<string, number> = {};
  const live = { up: false };
  const { engine } = engineFor(t, store, countingAdapter(calls), live);
  await engine.auditPass(true);
  assert.equal(engine.hostHealth.read(HOST).state, "down");
  for (const key of Object.keys(calls)) delete calls[key];
  for (let pass = 0; pass < 3; pass++) await engine.auditPass(true);
  assert.deepEqual(
    calls,
    {},
    "no host call, row, title or parent read while it is down",
  );
});
