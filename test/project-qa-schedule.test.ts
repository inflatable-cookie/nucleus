import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../core/store/store";
import { ProjectQaRunner } from "./project-qa-runner-fixture";
import {
  ProjectQaSchedules,
  qaScheduleStateKey,
  qaScheduleNoticeOwner,
} from "../core/qa/project-qa-schedule";
import {
  projectQaScheduleSchema,
  projectQaRunSchema,
  QA_MANAGED_LAUNCH_RETIRED,
  submissionSchema,
} from "../shared/contracts";
import { command, git } from "../core/git/index";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
const key = "owner/repo",
  head = "a".repeat(40),
  hour = 3_600_000;

async function fixture(t: any, afterMerges = 2) {
  const dir = await mkdtemp(join(tmpdir(), "qa-schedule-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  const runner = new ProjectQaRunner(store, {
    dataDir: dir,
    hostRunStateDir: join(dir, "hosts"),
  });
  let at = Date.parse("2026-10-09T00:00:00Z"),
    launched = 0,
    serial = 0;
  const row = () => store.repositoryFor(key)!;
  store.patchRepository(
    { origin: key, path: dir },
    {
      qa: {
        argv: ["effigy", "qa"],
        timeoutMs: 1000,
        schedule: { afterMerges, maxIntervalHours: 24 },
      },
    },
  );
  const project = store.projectFor(dir, key)!;
  store.setProjectPlanner({
    key: project.key,
    agentId: "planner",
    setBy: "test",
  });
  const internal = runner as any;
  internal.resolveRepository = async () => ({
    key,
    origin: key,
    path: dir,
    checkoutPath: dir,
  });
  internal.reconcile = async () => {};
  internal.integrationHead = async () => head;
  internal.submitToHostScheduler = () => {
    launched++;
  };
  internal.attachQueued = () => {};
  const includes = new Map<string, boolean>();
  const schedules = new ProjectQaSchedules(store, runner, {
    clock: () => at,
    includes: async (_row, merge) => includes.get(merge.taskId) ?? true,
  });
  const merge = (
    branch = "main",
    outcome = "done",
    finishedAt = new Date(at).toISOString(),
    commit?: string,
  ) => {
    const task = store.insert(
      submissionSchema.parse({
        submissionId: `merge-${++serial}`,
        title: `merge ${serial}`,
        repoPath: dir,
        planningCommit: head,
        handoffPath: "h.md",
        originAgentId: "author",
        baseBranch: branch,
      }),
      "host",
      "brief",
      head,
      {},
      undefined,
      key,
    );
    store.update(
      task.id,
      {
        phase: outcome as "done" | "cancelled",
        resolution: {
          ...task.resolution,
          mergedCommit:
            outcome === "done"
              ? (commit ?? serial.toString(16).padStart(40, "0"))
              : null,
        },
      },
      "fixture",
    );
    // Timing is controlled on the immutable fixture outcome before the schedule sees it.
    const record = store.outcome(task.id)!;
    store.db
      .prepare("UPDATE outcomes SET finished_at=?,data=? WHERE taskId=?")
      .run(finishedAt, JSON.stringify({ ...record, finishedAt }), task.id);
    return task.id;
  };
  const run = (
    state: "passed" | "failed" | "queued",
    branch = "main",
    id = `manual-${++serial}`,
  ) =>
    store.putQaRun(
      projectQaRunSchema.parse({
        id,
        key,
        repository: { origin: key, path: dir },
        state,
        baseBranch: branch,
        base: head,
        argv: ["effigy", "qa"],
        digest: "b".repeat(64),
        capacityWait: null,
        capacityUnavailable: false,
        exitCode: state === "passed" ? 0 : state === "failed" ? 1 : null,
        durationMs: 0,
        outputTail: state,
        startedAt: new Date(at).toISOString(),
        submittedAt: new Date(at).toISOString(),
        finishedAt: state === "queued" ? null : new Date(at).toISOString(),
        pid: null,
      }),
    );
  t.after(async () => {
    runner.hostRuns.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    store,
    runner,
    schedules,
    row,
    merge,
    run,
    project,
    includes,
    internal,
    launched: () => launched,
    time: (hours: number) => {
      at += hours * hour;
    },
    at: () => at,
  };
}

test("schedule is explicit, bounded and defaults to daily; settings patches preserve QA stages", async (t) => {
  assert.deepEqual(projectQaScheduleSchema.parse({ afterMerges: 5 }), {
    afterMerges: 5,
    maxIntervalHours: 24,
  });
  for (const input of [
    { afterMerges: 0 },
    { afterMerges: 2, maxIntervalHours: 0 },
    { afterMerges: 1001 },
    { afterMerges: 1, maxIntervalHours: 25 },
  ])
    assert.equal(projectQaScheduleSchema.safeParse(input).success, false);
  const f = await fixture(t);
  f.store.patchRepository(f.row().repository, {
    qa: {
      stages: [
        { name: "root", argv: ["effigy", "qa"], timeoutMs: 1000 },
        { name: "silo", argv: ["effigy", "silo/qa"], timeoutMs: 1000 },
      ],
      schedule: { afterMerges: 5, maxIntervalHours: 24 },
    },
  });
  const before = f.row().qa;
  f.store.patchRepository(f.row().repository, { note: "policy" });
  assert.deepEqual(f.row().qa, before);
  f.store.patchRepository(f.row().repository, {
    qa: { ...f.row().qa!, schedule: null },
  });
  f.merge();
  f.merge();
  f.time(48);
  await f.schedules.tick();
  assert.equal(f.launched(), 0);
});

test("green clears only actual ancestor merges, regardless of timestamps; late outcomes reconcile", async (t) => {
  const f = await fixture(t, 10);
  const included = f.merge(),
    absent = f.merge();
  f.includes.set(absent, false);
  const green = f.run("passed");
  await f.schedules.tick();
  assert.deepEqual(
    f.store.qaScheduleMerges(key).map((m) => m.taskId),
    [absent],
  );
  const late = f.merge("main", "done", "2026-10-08T00:00:00Z");
  await f.schedules.tick();
  assert.deepEqual(
    f.store.qaScheduleMerges(key).map((m) => m.taskId),
    [absent],
  );
  assert.equal(
    f.store.db
      .prepare("SELECT coveredRun FROM qa_schedule_merges WHERE taskId=?")
      .get(late)?.coveredRun,
    green.id,
  );
  assert.ok(f.store.outcome(included));
});

test("red owner result/reminder and one operator decision survive restart; green ends the episode", async (t) => {
  const f = await fixture(t);
  f.merge();
  const red = f.run("failed");
  await f.schedules.tick();
  let notices = f.store.notices(`qa:${key}`);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /Merges not yet covered.*\(1\)/);
  assert.match(notices[0].text, new RegExp(red.id));
  f.time(24);
  await f.schedules.tick();
  assert.equal(f.store.notices(`qa:${key}`).length, 2);
  const state = f.store.getMeta<any>(qaScheduleStateKey(key));
  assert.ok(state.decisionId);
  assert.equal(f.store.decision(state.decisionId).status, "open");
  await new ProjectQaSchedules(f.store, f.runner, {
    clock: () => f.at(),
    includes: async () => true,
  }).tick();
  assert.equal(
    f.store.getMeta<any>(qaScheduleStateKey(key)).decisionId,
    state.decisionId,
  );
  f.run("passed");
  await f.schedules.tick();
  assert.equal(f.store.decision(state.decisionId).status, "withdrawn");
  assert.equal(f.store.getMeta<any>(qaScheduleStateKey(key)).redSince, null);
  assert.equal(
    qaScheduleNoticeOwner(
      f.store,
      f.store
        .notices(`qa:${key}`)
        .find((n) => n.id.startsWith("qa-reminder:"))!,
    ),
    null,
  );
});

test("owner delivery respects idle, pause, transfer and uncertain delivery fences", async (t) => {
  const f = await fixture(t);
  f.merge();
  f.run("failed");
  await f.schedules.tick();
  let active = true,
    sends = 0;
  const targets: string[] = [];
  const adapter = {
    hostId: "host",
    listLiveAgents: async () => [
      {
        id: f.store.projectByKey(f.project.key)!.planner!.agentId,
        title: "Planner",
        workspaceId: null,
      },
    ],
    observe: async (id: string) => ({
      id,
      status: active ? "running" : "idle",
      active,
      permissions: false,
      error: "",
    }),
    notify: async (id: string) => {
      sends++;
      targets.push(id);
    },
    profiles: async () => [],
  } as unknown as Adapter;
  // Queue #912: planner notices route to the one registered host, which this fixture names.
  f.store.setMeta("hostId", "host");
  const engine = new Engine(f.store, adapter, 0);
  t.after(() => engine.stop());
  await engine.resolution.deliverDrainNotices();
  assert.equal(sends, 0);
  f.store.setProjectPlanner({
    key: f.project.key,
    agentId: "new-planner",
    setBy: "test",
  });
  active = false;
  f.store.setMeta("paused", true);
  await engine.resolution.deliverDrainNotices();
  assert.equal(sends, 0);
  f.store.setMeta("paused", false);
  await engine.resolution.deliverDrainNotices();
  assert.deepEqual(targets, ["new-planner"]);
  await engine.resolution.deliverDrainNotices();
  assert.equal(sends, 1);
});

test("schedule merge accounting survives task purge", async (t) => {
  const f = await fixture(t, 1);
  const taskId = f.merge();
  f.store.db.prepare("DELETE FROM tasks WHERE id=?").run(taskId);
  assert.equal(f.store.qaScheduleMerges(key).length, 1);
  assert.ok(f.store.outcome(taskId));
  await f.schedules.tick();
  assert.equal(f.launched(), 0);
});

test("coverage uses actual Git ancestry, not matching time or equal branch names", async (t) => {
  const f = await fixture(t, 10);
  await command("git", ["init", "--initial-branch=main", f.dir], f.dir);
  await git(f.dir, "config", "user.name", "Fixture");
  await git(f.dir, "config", "user.email", "fixture@example.invalid");
  await git(
    f.dir,
    "remote",
    "add",
    "origin",
    "https://github.com/owner/repo.git",
  );
  await writeFile(join(f.dir, "source.txt"), "first");
  await git(f.dir, "add", "source.txt");
  await git(f.dir, "commit", "-m", "first");
  const first = await git(f.dir, "rev-parse", "HEAD");
  await writeFile(join(f.dir, "source.txt"), "second");
  await git(f.dir, "add", "source.txt");
  await git(f.dir, "commit", "-m", "second");
  const second = await git(f.dir, "rev-parse", "HEAD");
  const a = f.merge("main", "done", new Date(f.at()).toISOString(), first);
  const b = f.merge("main", "done", "2026-10-08T00:00:00Z", second);
  const green = f.run("passed");
  f.store.putQaRun({ ...green, base: first });
  await new ProjectQaSchedules(f.store, f.runner, {
    clock: () => f.at(),
  }).tick();
  assert.deepEqual(
    f.store.qaScheduleMerges(key).map((m) => m.taskId),
    [b],
  );
  assert.ok(f.store.outcome(a));
});

test("schema 50 upgrade preserves QA schedule and retained outcomes", async (t) => {
  const f = await fixture(t);
  const retained = f.merge(),
    purged = f.merge(),
    release = f.merge("release/v1");
  f.store.db.prepare("DELETE FROM tasks WHERE id=?").run(purged);
  const before = f.store.qaScheduleMerges(key);
  f.store.db.exec(
    "CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)",
  );
  f.store.setMeta("schema", 50);
  const reopened = new Store(join(f.dir, "queue.sqlite"));
  t.after(() => reopened.close());
  assert.deepEqual(reopened.qaScheduleMerges(key), before);
  assert.ok(reopened.outcome(retained));
  assert.ok(reopened.outcome(purged));
  assert.ok(reopened.outcome(release));
});

test("owner changes while observe awaits cannot deliver to the old owner; uncertain send is never replayed", async (t) => {
  const f = await fixture(t);
  f.merge();
  f.run("failed");
  await f.schedules.tick();
  let release!: () => void,
    sends = 0;
  let first = true;
  const adapter = {
    hostId: "host",
    listLiveAgents: async () => [
      {
        id: f.store.projectByKey(f.project.key)!.planner!.agentId,
        title: "Planner",
        workspaceId: null,
      },
    ],
    originAgent: async (id: string) => ({
      id,
      title: "Planner",
      workspaceId: null,
    }),
    observe: async (id: string) => {
      if (first) {
        first = false;
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return {
        id,
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      };
    },
    notify: async () => {
      sends++;
      throw Error("transport lost after send");
    },
    profiles: async () => [],
  } as unknown as Adapter;
  // Queue #912: planner notices route to the one registered host, which this fixture names.
  f.store.setMeta("hostId", "host");
  const engine = new Engine(f.store, adapter, 0);
  t.after(() => engine.stop());
  const delivery = engine.resolution.deliverDrainNotices();
  while (!release) await new Promise((r) => setImmediate(r));
  f.store.setProjectPlanner({
    key: f.project.key,
    agentId: "new-planner",
    setBy: "test",
  });
  release();
  await delivery;
  assert.equal(sends, 0);
  await engine.resolution.deliverDrainNotices();
  assert.equal(sends, 1);
  assert.equal(f.store.notices(`qa:${key}`)[0].status, "uncertain");
  await engine.resolution.deliverDrainNotices();
  assert.equal(sends, 1);
});

test("persistent coverage failure is visible and escalates without a blind QA launch", async (t) => {
  const f = await fixture(t);
  f.merge();
  f.run("passed");
  const schedules = new ProjectQaSchedules(f.store, f.runner, {
    clock: () => f.at(),
    includes: async () => {
      throw Error("Git object unavailable");
    },
  });
  await schedules.tick();
  assert.equal(f.launched(), 0);
  assert.match(
    f.store.notices(`qa:${key}`)[0].text,
    /inventory\/coverage could not be established/,
  );
  f.time(24);
  await schedules.tick();
  const state = f.store.getMeta<any>(qaScheduleStateKey(key));
  assert.equal(f.store.decision(state.decisionId).status, "open");
  assert.equal(f.launched(), 0);
});

test("passed notice distinguishes verified batch from the actual remaining uncovered merges", async (t) => {
  const f = await fixture(t, 10);
  const verified = f.merge(),
    remaining = f.merge();
  f.includes.set(remaining, false);
  const green = f.run("passed");
  await f.schedules.tick();
  const text = f.store
    .notices(`qa:${key}`)
    .find((n) => n.id === `qa-result:${green.id}`)!.text;
  assert.match(text, /Merges covered since the previous green main run \(1\)/);
  const residual = text.split(
    "Merges not yet covered by a green main run (1):",
  )[1];
  assert.ok(residual.includes(remaining));
  assert.equal(residual.includes(verified), false);
});

/**
 * nucleus#1475: the schedule is a retired launch entry point. A due batch keeps
 * the accounting and notice behaviour that serves old history, and records the
 * report-only recipe instead of admitting a managed run.
 */
test("a due batch records the retirement recipe instead of admitting a run", async (t) => {
  const f = await fixture(t, 1);
  f.merge();
  await f.schedules.tick();
  assert.equal(f.launched(), 0, "no managed run is launched");
  const notices = f.store.notices(`qa:${key}`);
  assert.equal(notices.length, 1, "one durable notice, never a silent stop");
  assert.ok(
    notices[0].text.includes(QA_MANAGED_LAUNCH_RETIRED),
    "the notice carries the recipe and the exit",
  );
  assert.equal(
    f.store.getMeta<any>(qaScheduleStateKey(key)).pending,
    null,
    "no request identity is minted",
  );
  await f.schedules.tick();
  f.time(48);
  await f.schedules.tick();
  assert.equal(
    f.launched(),
    0,
    "a later pass and a passed interval still admit nothing",
  );
  assert.equal(
    f.store.notices(`qa:${key}`).length,
    1,
    "the notice is not repeated",
  );
});

test("a pre-cutover pending admission or admitted run is never replayed or relabelled", async (t) => {
  const f = await fixture(t, 1);
  const live = f.run("queued");
  const state = f.store.getMeta<any>(qaScheduleStateKey(key)) ?? {};
  f.store.setMeta(qaScheduleStateKey(key), {
    ...state,
    pending: { id: "scheduled-qa:pre-cutover", signature: "pre" },
  });
  f.merge();
  await f.schedules.tick();
  assert.equal(
    f.launched(),
    0,
    "an unresolved pre-cutover identity is not replayed",
  );
  assert.equal(
    f.store.qaRun(live.id)?.state,
    "queued",
    "the admitted run keeps its own state",
  );
  assert.deepEqual(
    f.store.getMeta<any>(qaScheduleStateKey(key)).pending,
    { id: "scheduled-qa:pre-cutover", signature: "pre" },
    "the recorded identity stays as the obligation it is",
  );
});
