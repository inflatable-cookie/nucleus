/**
 * nucleus#1475: managed milestone QA launch and its schedule are retired, and
 * milestone QA is an ordinary report-only task. These fixtures cover the four
 * states a cutover must keep honest: a fresh launch (refused with the recipe),
 * a fresh or replaced schedule (refused, clearable), old history (still
 * readable) and an existing obligation (never orphaned or settled by the
 * refusal). They never touch a live run, schedule or store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  projectQaRunSchema,
  QA_MANAGED_LAUNCH_RETIRED,
  QA_SCHEDULE_RETIRED,
  submissionSchema,
} from "../shared/contracts";
import { QueueRuntime } from "../service/runtime-owner";
import { Store } from "../core/store/store";
import { ProjectQaRunner } from "./project-qa-runner-fixture";
import {
  ProjectQaSchedules,
  qaScheduleStateKey,
} from "../core/qa/project-qa-schedule";
import { command, git } from "../core/git/index";

/** One registered repository with a GitHub origin, plus a private runtime store. */
async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nsq-qa-retired-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await command(
    "git",
    ["init", "--bare", "--initial-branch=main", join(root, "origin.git")],
    root,
  );
  await command(
    "git",
    ["clone", join(root, "origin.git"), join(root, "repo")],
    root,
  );
  const repo = join(root, "repo");
  await git(
    repo,
    "remote",
    "set-url",
    "origin",
    "https://github.com/acme/app.git",
  );
  const dataDir = join(root, "data");
  const runtime = new QueueRuntime({ dataDir, timers: false });
  t.after(() => runtime.stop());
  return { root, repo, origin: "acme/app", runtime };
}

const run = (id: string, overrides: Record<string, unknown> = {}) =>
  projectQaRunSchema.parse({
    id,
    key: "acme/app",
    repository: { origin: "acme/app", path: "/repository" },
    state: "failed",
    baseBranch: "main",
    base: "a".repeat(40),
    argv: ["effigy", "qa"],
    digest: "b".repeat(64),
    capacityWait: null,
    capacityUnavailable: false,
    exitCode: 1,
    durationMs: 1200,
    outputTail: "1 failing test",
    startedAt: "2026-11-01T00:00:00.000Z",
    submittedAt: "2026-11-01T00:00:00.000Z",
    finishedAt: "2026-11-01T00:01:00.000Z",
    pid: null,
    ...overrides,
  });

test("a fresh milestone QA launch refuses with the recipe and the history reads that still answer", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () => f.runtime.runProjectQa({ repository: f.origin }),
    (error: Error) => {
      assert.equal(error.message, QA_MANAGED_LAUNCH_RETIRED);
      assert.match(error.message, /report-only/);
      assert.match(error.message, /milestone-qa\.md/);
      for (const verb of [
        "project.qa.get",
        "project.qa.list",
        "project.qa.cancel",
        "project.qa.dismiss",
        "project.qa.retry-teardown",
      ])
        assert.ok(error.message.includes(verb), `the refusal names ${verb}`);
      return true;
    },
    "the launch entry point is retired for every caller, including --wait",
  );
  await assert.rejects(
    () => f.runtime.runProjectQa({ repository: f.origin, wait: true }),
    { message: QA_MANAGED_LAUNCH_RETIRED },
  );
  assert.deepEqual(
    (await f.runtime.listProjectQa()).filter((item) => item.key === f.origin),
    [],
    "a refused launch creates no run, so no checkout, request identity or capacity is spent",
  );
});

test("a schedule can be cleared but never enabled or replaced", async (t) => {
  const f = await fixture(t);
  const configured = await f.runtime.setRepository({
    repository: f.origin,
    qa: { argv: ["effigy", "qa"], timeoutMs: 60_000 },
  });
  assert.deepEqual(configured.qa?.argv, ["effigy", "qa"]);
  await assert.rejects(
    () =>
      f.runtime.setRepository({
        repository: f.origin,
        qa: {
          argv: ["effigy", "qa"],
          timeoutMs: 60_000,
          schedule: { afterMerges: 5 },
        },
      }),
    { message: QA_SCHEDULE_RETIRED },
    "enabling a schedule is the retired entry point",
  );
  const cleared = await f.runtime.setRepository({
    repository: f.origin,
    qa: { argv: ["effigy", "qa"], timeoutMs: 60_000, schedule: null },
  });
  assert.equal(
    cleared.qa?.schedule ?? null,
    null,
    "clearing a leftover schedule stays the exit",
  );
});

test("old history stays readable and an unsettled run is not orphaned by the refusal", async (t) => {
  const f = await fixture(t);
  const settled = run("retained-failure");
  const live = run("still-running", {
    state: "running",
    exitCode: null,
    finishedAt: null,
    startedAt: "2026-11-01T00:00:00.000Z",
  });
  const queued = run("waiting", {
    state: "queued",
    exitCode: null,
    finishedAt: null,
    submittedAt: "2026-11-01T00:00:00.000Z",
  });
  for (const record of [settled, live, queued])
    f.runtime.store.putQaRun(record);

  await assert.rejects(() => f.runtime.runProjectQa({ repository: f.origin }), {
    message: QA_MANAGED_LAUNCH_RETIRED,
  });

  assert.deepEqual(
    await f.runtime.getProjectQa({ id: settled.id }),
    settled,
    "a settled run is history, read exactly as recorded",
  );
  assert.deepEqual(
    (await f.runtime.listProjectQa()).map((item) => item.id),
    ["waiting"],
    "the board list still answers the repository's latest run, admitted before the cutover",
  );
  assert.equal(
    f.runtime.store.qaRun(live.id)?.state,
    "running",
    "an admitted run keeps its own state; the cutover never settles or replays it",
  );
  assert.equal(
    f.runtime.store.qaRun(queued.id)?.state,
    "queued",
    "a queued run keeps its admission",
  );
});

test("a leftover schedule records one migration notice and admits nothing", async (t) => {
  const f = await fixture(t);
  const dir = await realpath(await mkdtemp(join(f.root, "schedule-")));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  const runner = new ProjectQaRunner(store, {
    dataDir: dir,
    hostRunStateDir: join(dir, "hosts"),
  });
  let launched = 0;
  runner.run = (async () => {
    launched++;
    throw new Error("a retired schedule must never call the runner");
  }) as never;
  const internal = runner as unknown as Record<string, unknown>;
  internal.resolveRepository = async () => ({
    key: "acme/app",
    origin: "acme/app",
    path: dir,
    checkoutPath: dir,
  });
  internal.reconcile = async () => {};
  internal.integrationHead = async () => "a".repeat(40);
  t.after(() => {
    runner.hostRuns.stop();
    store.close();
  });

  store.patchRepository(
    { origin: "acme/app", path: dir },
    {
      qa: {
        argv: ["effigy", "qa"],
        timeoutMs: 60_000,
        schedule: { afterMerges: 1, maxIntervalHours: 24 },
      },
    },
  );
  const project = store.projectFor(dir, "acme/app")!;
  store.setProjectPlanner({
    key: project.key,
    agentId: "planner",
    setBy: "test",
  });
  let at = Date.parse("2026-11-01T00:00:00Z");
  const merged = store.insert(
    submissionSchema.parse({
      submissionId: "merge-1",
      title: "merge 1",
      repoPath: dir,
      planningCommit: "a".repeat(40),
      handoffPath: "h.md",
      originAgentId: "author",
      baseBranch: "main",
    }),
    "host",
    "brief",
    "a".repeat(40),
    {},
    undefined,
    "acme/app",
  );
  store.update(
    merged.id,
    {
      phase: "done",
      resolution: { ...merged.resolution, mergedCommit: "c".repeat(40) },
    },
    "fixture",
  );
  const outcome = store.outcome(merged.id)!;
  store.db
    .prepare("UPDATE outcomes SET finished_at=?,data=? WHERE taskId=?")
    .run(
      new Date(at).toISOString(),
      JSON.stringify({ ...outcome, finishedAt: new Date(at).toISOString() }),
      merged.id,
    );
  const schedules = new ProjectQaSchedules(store, runner, {
    clock: () => at,
    includes: async () => true,
  });

  await schedules.tick();
  const notices = store.notices("qa:acme/app");
  assert.equal(notices.length, 1, "one durable notice, not a silent stop");
  assert.ok(
    notices[0].text.includes(QA_MANAGED_LAUNCH_RETIRED),
    "the notice carries the recipe and the exit",
  );
  assert.equal(
    store.notices("qa:acme/app").length,
    1,
    "a repeated pass does not duplicate the notice",
  );
  assert.equal(
    store.getMeta<{ pending?: unknown }>(qaScheduleStateKey("acme/app"))
      ?.pending ?? null,
    null,
    "no request identity is minted, so nothing can be replayed later",
  );
  assert.equal(launched, 0, "no managed run was launched");

  at += 48 * 3_600_000;
  await schedules.tick();
  assert.equal(launched, 0, "the interval passing still admits nothing");
  store.patchRepository(
    { origin: "acme/app", path: dir },
    { qa: { ...store.repositoryFor("acme/app")!.qa!, schedule: null } },
  );
  await schedules.tick();
  assert.equal(
    store.getMeta<{ pending?: unknown }>(qaScheduleStateKey("acme/app"))
      ?.pending ?? null,
    null,
  );
});
