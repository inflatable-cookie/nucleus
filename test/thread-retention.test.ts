import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Store } from "../core/store/store";
import {
  THREAD_RETENTION_BATCH,
  THREAD_RETENTION_META_KEY,
  retentionScope,
  runThreadRetention,
  runThreadRetentionPass,
  threadRetentionDays,
  threadRetentionHealth,
} from "../core/workspaces/thread-retention";
import { CapacityChangeJournal } from "../core/dispatch/capacity-changes";
import { submissionSchema } from "../shared/contracts";
import type { Adapter } from "../core/host";
import { wireLabels } from "../shared/wire-labels";

/**
 * Orchestration contract, "Archived thread retention" (nucleus#1367): one
 * service-scheduled pass removes the threads Nucleus created for a finished task
 * once they have stayed archived past the retention window, and nothing else.
 * These cases are the scope rules, the batch cap, the unknown-delivery fence and
 * the pass record `service.health` reads.
 */
const HOST = "paseo:fixture";
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const OLD = new Date(NOW - 9 * DAY).toISOString();

type Row = {
  archivedAt: string | null;
  labels: Record<string, string>;
  deleted: boolean;
};

/** One host's archived threads: what a walk lists is set apart from what a fresh read answers. */
function hostFixture() {
  const live = new Map<string, Row>();
  const calls = {
    listed: 0,
    deleted: [] as string[],
    forgotten: [] as string[],
  };
  /** Ids the walk answers; null derives them from this host's archived rows. */
  let listed: string[] | null = null;
  /** A queued failure per thread, spent one per delete attempt. */
  const failures = new Map<string, Error[]>();
  const adapter = {
    archivedThreads: async () => {
      calls.listed++;
      const ids =
        listed ??
        [...live]
          .filter(([, row]) => !row.deleted && row.archivedAt)
          .map(([id]) => id);
      // An explicit list is the walk's own snapshot: a row may be gone by the fresh read.
      if (listed)
        return ids.flatMap((id) => {
          const row = live.get(id) ?? {
            archivedAt: null,
            labels: {},
            deleted: false,
          };
          return [
            {
              id,
              workspaceId: null,
              archivedAt: row.archivedAt ?? OLD,
              labels: row.labels,
            },
          ];
        });
      return ids.flatMap((id) => {
        const row = live.get(id);
        return row && !row.deleted && row.archivedAt
          ? [
              {
                id,
                workspaceId: null,
                archivedAt: row.archivedAt,
                labels: row.labels,
              },
            ]
          : [];
      });
    },
    threadArchiveState: async (id: string) => {
      const row = live.get(id);
      return !row || row.deleted
        ? null
        : { archivedAt: row.archivedAt, deleted: false };
    },
    deleteAgent: async (id: string) => {
      calls.deleted.push(id);
      const queued = failures.get(id)?.shift();
      if (queued) throw queued;
      const row = live.get(id);
      if (row) {
        row.deleted = true;
        row.archivedAt = null;
      }
    },
    forgetThreads: (ids: readonly string[]) => {
      calls.forgotten.push(...ids);
    },
  } as unknown as Adapter;
  return {
    live,
    calls,
    adapter,
    add(
      id: string,
      labels: Record<string, string>,
      archivedAt: string | null = OLD,
    ) {
      live.set(id, { archivedAt, labels, deleted: false });
    },
    fail(ids: string[], error: Error) {
      for (const id of ids)
        failures.set(id, [...(failures.get(id) ?? []), error]);
    },
    list(ids: string[] | null) {
      listed = ids;
    },
  };
}

function fixture(t: { after(fn: () => void): void }) {
  const OLD = new Date(NOW - 9 * DAY).toISOString();
  const directory = mkdtempSync(join(tmpdir(), "ns-thread-retention-"));
  const store = new Store(join(directory, "queue.sqlite"));
  store.setMeta("paused", false);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const create = (
    title: string,
    phase: "queued" | "working" | "done" | "cancelled" = "done",
  ) => {
    const submitted = store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title,
        repoPath: "/repo",
        planningCommit: "a".repeat(40),
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      HOST,
      "handoff",
      "a".repeat(40),
    );
    return store.update(submitted.id, { phase });
  };
  const taskLabels = (taskId: string, role?: string) =>
    wireLabels({ task: taskId, ...(role ? { role } : {}) });
  return { store, create, taskLabels };
}

test("an archived role thread of a done task past the window is removed once and read back absent", async (t) => {
  const f = fixture(t),
    host = hostFixture();
  const task = f.create("Finished task", "done");
  host.add(
    "reviewer-1",
    f.taskLabels(task.id, "reviewer"),
    new Date(NOW - 7 * DAY).toISOString(),
  );
  host.add(
    "worker-1",
    f.taskLabels(task.id, "worker"),
    new Date(NOW - 9 * DAY).toISOString(),
  );

  const fact = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW,
  });

  assert.equal(fact.supported, true);
  assert.equal(fact.error, "");
  assert.equal(
    fact.deleted,
    2,
    "both archived threads of the finished task are removed",
  );
  assert.equal(fact.remaining, 0);
  assert.equal(fact.eligible, 2);
  assert.deepEqual(
    host.calls.deleted,
    ["worker-1", "reviewer-1"],
    "oldest stamp first",
  );
  assert.deepEqual(
    host.calls.forgotten.sort(),
    ["reviewer-1", "worker-1"],
    "the adapter forgets the threads it removed",
  );
  assert.equal(
    host.live.get("reviewer-1")!.deleted,
    true,
    "the host proved the thread absent",
  );
  assert.equal(
    f.store.getMeta("threadRetentionIntents"),
    undefined,
    "a completed removal leaves no fence behind",
  );

  // A second pass reads the same host and finds nothing left to remove.
  const again = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW + 60_000,
  });
  assert.equal(again.deleted, 0);
  assert.equal(again.eligible, 0);
  assert.deepEqual(
    host.calls.deleted,
    ["worker-1", "reviewer-1"],
    "a removed thread is never removed twice",
  );
});

test("a planner thread, an unarchived thread, an unfinished task and a recent archive are all left alone", async (t) => {
  const f = fixture(t),
    host = hostFixture();
  const done = f.create("Finished task", "done");
  const open = f.create("Open task", "queued");
  const cancelled = f.create("Cancelled task", "cancelled");
  // A planner thread carries no task label: it is the operator's thread.
  host.add("planner-1", wireLabels({ role: "planner" }));
  // The task's thread was read archived by the walk and unarchived before the fresh read.
  host.add("reviewer-unarchived", f.taskLabels(done.id, "reviewer"), OLD);
  // A decider thread belongs to a decision, which may still be open.
  host.add("decider-1", {
    ...f.taskLabels(done.id, "decider"),
    "nucleus.decider": "d1",
  });
  // An unfinished task's thread is live work.
  host.add("worker-open", f.taskLabels(open.id, "worker"));
  // A finished task's thread that has not yet reached the retention window.
  host.add(
    "worker-recent",
    f.taskLabels(done.id, "worker"),
    new Date(NOW - DAY).toISOString(),
  );
  host.add("worker-cancelled", f.taskLabels(cancelled.id, "worker"));
  // A finished task's thread that an unfinished task now owns as its coordinator:
  // its launch label is history, the live binding is the fact that keeps it.
  const liveBinding = f.create("Another open task", "queued");
  f.store.update(liveBinding.id, {
    coordinatorAgentId: "coordinator-remapped",
  });
  host.add("coordinator-remapped", f.taskLabels(done.id, "recovery"));

  host.list([
    "planner-1",
    "reviewer-unarchived",
    "decider-1",
    "worker-open",
    "worker-recent",
    "worker-cancelled",
    "coordinator-remapped",
  ]);
  host.live.get("reviewer-unarchived")!.archivedAt = null;

  const fact = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW,
  });

  assert.deepEqual(
    host.calls.deleted,
    ["worker-cancelled"],
    "only the cancelled task's archived thread is in scope",
  );
  assert.equal(fact.deleted, 1);
  // The walk counts old candidates; the fresh read drops the unarchived one.
  assert.equal(fact.eligible, 2);
  for (const id of [
    "planner-1",
    "reviewer-unarchived",
    "decider-1",
    "worker-open",
    "worker-recent",
    "coordinator-remapped",
  ])
    assert.equal(host.live.get(id)!.deleted, false, `${id} must survive`);
});

test("the scope rule names why each archived thread outside the window is kept", async (t) => {
  const f = fixture(t),
    host = hostFixture();
  const done = f.create("Finished task", "done");
  const open = f.create("Open task", "queued");
  const protect = new Set(["named-planner"]);
  const scope = (id: string, labels: Record<string, string>) =>
    retentionScope(f.store, { id, labels }, NOW - 3 * DAY, protect).rule;

  assert.equal(
    scope("named-planner", f.taskLabels(done.id, "worker")),
    "named-agent-thread",
  );
  assert.equal(
    scope("p", wireLabels({ role: "planner" })),
    "not-a-task-thread",
  );
  assert.equal(scope("d", f.taskLabels(done.id, "decider")), "decision-thread");
  assert.equal(scope("o", f.taskLabels(open.id, "worker")), "task-unfinished");
  assert.equal(
    scope("u", f.taskLabels(randomUUID(), "worker")),
    "task-unknown",
  );
  assert.equal(
    scope("a", { "nucleus.task": done.id, "northstar.task": randomUUID() }),
    "ambiguous-labels",
  );
  assert.equal(
    scope("e", f.taskLabels(done.id, "worker")),
    "archived-finished-task",
  );
});

test("a task whose history was purged is still a finished task: its tombstone is the proof", async (t) => {
  const f = fixture(t),
    host = hostFixture();
  const task = f.create("Purged task", "done");
  // The purge keeps a tombstone for the task it took; the thread's task label survives on the host.
  f.store.purgeOldTasks(NOW + 30 * DAY);
  assert.equal(f.store.taskOrNull(task.id), null, "the task row is gone");
  assert.equal(f.store.purgedTask(task.id), true);
  host.add("reviewer-purged", f.taskLabels(task.id, "reviewer"));

  const fact = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW,
  });
  assert.equal(fact.deleted, 1);
});

test("the batch cap bounds one pass and reports what it left for the next", async (t) => {
  const f = fixture(t),
    host = hostFixture();
  const task = f.create("Finished task", "done");
  for (let i = 0; i < 5; i++)
    host.add(
      `thread-${i}`,
      f.taskLabels(task.id, "worker"),
      new Date(NOW - (10 - i) * DAY).toISOString(),
    );

  host.add(
    "recent",
    f.taskLabels(task.id, "worker"),
    new Date(NOW - DAY).toISOString(),
  );
  host.add(
    "boundary",
    f.taskLabels(task.id, "worker"),
    new Date(NOW - 3 * DAY).toISOString(),
  );

  const fact = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW,
    batch: 2,
  });

  assert.equal(fact.deleted, 2, "no more than the cap is removed");
  assert.equal(
    fact.eligible,
    6,
    "recent archives are not yet eligible; the cutoff is inclusive",
  );
  assert.equal(
    fact.remaining,
    4,
    "only old candidates left by the cap are reported",
  );
  assert.deepEqual(
    host.calls.deleted,
    ["thread-0", "thread-1"],
    "the oldest two go first",
  );

  const next = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW + 60_000,
    batch: THREAD_RETENTION_BATCH,
  });
  assert.equal(next.deleted, 4);
  assert.equal(next.remaining, 0);
});

test("an unknown delivery is fenced, never retried in the same pass, and retried only after a fresh read", async (t) => {
  const f = fixture(t),
    host = hostFixture();
  const task = f.create("Finished task", "done");
  host.add("reviewer-1", f.taskLabels(task.id, "reviewer"));
  host.fail(["reviewer-1"], new Error("socket closed after the write"));

  const first = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW,
  });
  assert.equal(first.deleted, 0);
  assert.equal(first.failed, 1, "the failed removal is this pass's failure");
  assert.match(first.error, /socket closed/);
  assert.deepEqual(host.calls.deleted, ["reviewer-1"], "one attempt only");
  const intents = f.store.getMeta<
    Record<string, Record<string, { status: string; retries: number }>>
  >("threadRetentionIntents")!;
  assert.equal(
    intents[HOST]!["reviewer-1"]!.status,
    "uncertain",
    "the unknown outcome is recorded, not forgotten",
  );
  assert.equal(host.live.get("reviewer-1")!.deleted, false);

  // The next pass reads the thread fresh; it is still archived, so one guarded resend is allowed.
  const second = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW + 60_000,
  });
  assert.equal(second.deleted, 1);
  assert.deepEqual(host.calls.deleted, ["reviewer-1", "reviewer-1"]);
  assert.equal(f.store.getMeta("threadRetentionIntents"), undefined);
});

test("a thread the host already reports absent is counted done without a removal", async (t) => {
  const f = fixture(t),
    host = hostFixture();
  const task = f.create("Finished task", "done");
  host.add("reviewer-1", f.taskLabels(task.id, "reviewer"));
  host.list(["reviewer-1"]);
  host.live.get("reviewer-1")!.deleted = true;

  const fact = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW,
  });
  assert.equal(fact.absent, 1);
  assert.equal(fact.deleted, 0);
  assert.deepEqual(host.calls.deleted, []);
});

test("an unfinished walk prunes nothing and is recorded as truncated", async (t) => {
  const f = fixture(t),
    host = hostFixture();
  const task = f.create("Finished task", "done");
  host.add("reviewer-1", f.taskLabels(task.id, "reviewer"));
  host.adapter.archivedThreads = (async () =>
    null) as Adapter["archivedThreads"];

  const fact = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW,
  });
  assert.equal(fact.truncated, true);
  assert.equal(fact.deleted, 0);
  assert.match(fact.error, /did not reach its end/);
  assert.deepEqual(host.calls.deleted, []);
});

test("the retention window is the one Settings value, three days by default", async (t) => {
  const f = fixture(t),
    host = hostFixture();
  const task = f.create("Finished task", "done");
  host.add(
    "reviewer-1",
    f.taskLabels(task.id, "reviewer"),
    new Date(NOW - 2 * DAY).toISOString(),
  );

  assert.equal(
    threadRetentionDays(f.store),
    3,
    "three days before anyone sets one",
  );
  const kept = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW,
  });
  assert.equal(kept.deleted, 0, "two days is inside the default window");

  new CapacityChangeJournal(f.store).apply({ threadRetentionDays: 1 });
  assert.equal(threadRetentionDays(f.store), 1);
  const pruned = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW,
  });
  assert.equal(
    pruned.deleted,
    1,
    "one day puts the same thread past the window",
  );
});

test("a host without the retention capability is reported as unsupported, not as an empty pass", async (t) => {
  const f = fixture(t);
  const fact = await runThreadRetentionPass({
    store: f.store,
    adapter: {} as Adapter,
    hostId: HOST,
    at: NOW,
  });
  assert.equal(fact.supported, false);
  assert.equal(fact.deleted, 0);
});

test("the service pass records each host's last run, count and failures for service.health", async (t) => {
  const f = fixture(t),
    host = hostFixture();
  const task = f.create("Finished task", "done");
  host.add("reviewer-1", f.taskLabels(task.id, "reviewer"));
  host.add("reviewer-2", f.taskLabels(task.id, "reviewer"));
  host.fail(["reviewer-2"], new Error("host refused the removal"));
  let awayRead = false;

  const health = await runThreadRetention({
    store: f.store,
    hostIds: [HOST, "t3code:away"],
    hostAvailable: (hostId) => hostId === HOST,
    withHost: (_hostId, work) => work(),
    adapter: host.adapter,
    at: NOW,
  });

  assert.equal(health.days, 3);
  assert.equal(health.batch, THREAD_RETENTION_BATCH);
  const fact = health.hosts.find((entry) => entry.hostId === HOST)!;
  assert.equal(fact.at, new Date(NOW).toISOString());
  assert.equal(fact.deleted, 1);
  assert.equal(fact.failed, 1);
  assert.match(fact.error, /refused the removal/);
  const away = health.hosts.find((entry) => entry.hostId === "t3code:away")!;
  assert.match(away.error, /away/);
  assert.equal(awayRead, false, "an away host is never read");
  assert.deepEqual(
    threadRetentionHealth(f.store),
    health,
    "the record is the one service.health reads",
  );
  assert.deepEqual(f.store.getMeta(THREAD_RETENTION_META_KEY), health);
});

// nucleus#1369: a connected secondary host is read in its own host context, a host
// that returns is read on the next pass, and a host that lists but cannot remove a
// thread is counted and named, never pruned or reported clean.
test("a secondary host is read in its own host context and is scanned on the first pass after it returns", async (t) => {
  const f = fixture(t);
  const SECOND = "t3code:fixture";
  const primary = hostFixture(),
    secondary = hostFixture();
  const task = f.create("Finished task", "done");
  secondary.add(
    "worker-b",
    f.taskLabels(task.id, "worker"),
    new Date(NOW - 9 * DAY).toISOString(),
  );
  // The engine's routing: each adapter call runs against the host the async context names.
  const context = new AsyncLocalStorage<string>();
  const online = new Set<string>([HOST]);
  const byHost: Record<string, ReturnType<typeof hostFixture>> = {
    [HOST]: primary,
    [SECOND]: secondary,
  };
  const routed = new Proxy(
    {},
    {
      get: (_target, property) => {
        const host = byHost[context.getStore() ?? ""];
        if (!host) return undefined;
        const value = (host.adapter as unknown as Record<PropertyKey, unknown>)[
          property
        ];
        return typeof value === "function" ? value.bind(host.adapter) : value;
      },
    },
  ) as unknown as Adapter;
  const pass = () =>
    runThreadRetention({
      store: f.store,
      hostIds: [HOST, SECOND],
      // The engine's answer depends on the ambient host: unscoped, a secondary host reads away.
      hostAvailable: (hostId) =>
        context.getStore() === hostId && online.has(hostId),
      withHost: (hostId, work) => context.run(hostId, work),
      adapter: routed,
      at: NOW,
    });

  online.delete(SECOND);
  const away = (await pass()).hosts.find((fact) => fact.hostId === SECOND)!;
  assert.match(away.error, /away/);
  assert.equal(away.at, null, "a host never read keeps no read time");
  assert.equal(
    away.checkedAt,
    new Date(NOW).toISOString(),
    "an away host carries the timestamp of the pass that found it away",
  );
  assert.equal(secondary.calls.listed, 0, "an away host is never read");

  online.add(SECOND);
  const back = (await pass()).hosts.find((fact) => fact.hostId === SECOND)!;
  assert.equal(back.error, "");
  assert.equal(back.supported, true);
  assert.equal(back.at, new Date(NOW).toISOString());
  assert.equal(back.scanned, 1);
  assert.equal(back.deleted, 1);
  assert.equal(secondary.calls.listed, 1);
  assert.deepEqual(secondary.calls.deleted, ["worker-b"]);
});

test("a host that lists archived threads but cannot remove one is counted at its pass and never pruned", async (t) => {
  const f = fixture(t);
  const task = f.create("Finished task", "done");
  const row = {
    id: "bb-worker",
    workspaceId: null,
    archivedAt: new Date(NOW - 9 * DAY).toISOString(),
    labels: f.taskLabels(task.id, "worker"),
  };
  const adapter = {
    archivedThreads: async () => [row],
  } as unknown as Adapter;

  const fact = await runThreadRetentionPass({
    store: f.store,
    adapter,
    hostId: "bb:fixture",
    at: NOW,
  });

  assert.equal(fact.supported, false);
  assert.equal(fact.at, new Date(NOW).toISOString());
  assert.equal(fact.scanned, 1);
  assert.equal(fact.eligible, 1);
  assert.equal(fact.deleted, 0);
  assert.match(
    fact.error,
    /cannot remove an archived thread, so 1 eligible thread\(s\) were counted and none were removed/,
  );
});

test("a stopped engine ends the pass before its next removal", async (t) => {
  const f = fixture(t);
  const host = hostFixture();
  const task = f.create("Finished task", "done");
  host.add(
    "worker-1",
    f.taskLabels(task.id, "worker"),
    new Date(NOW - 9 * DAY).toISOString(),
  );

  const fact = await runThreadRetentionPass({
    store: f.store,
    adapter: host.adapter,
    hostId: HOST,
    at: NOW,
    stopped: () => true,
  });

  assert.equal(fact.deleted, 0);
  assert.deepEqual(host.calls.deleted, [], "no removal is sent after a stop");
  assert.equal(
    fact.remaining,
    1,
    "the eligible thread is left for the next pass",
  );
});
