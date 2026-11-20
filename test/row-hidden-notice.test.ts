import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { submissionSchema } from "../shared/contracts";
import type { RowSnoozeVisibility } from "../core/host";
import type { Notice } from "../shared/contracts";
import { holdPatch, releasePatch } from "../core/merge/merge-hold";
import { noticeId } from "../core/questions/origin";
import {
  HOLD_ANSWER_MINUTES,
  HiddenRows,
  ROW_HIDDEN_HOLD_MINUTES,
  ROW_HIDDEN_MINUTES,
  rowHiddenHoldNoticeId,
  rowHiddenKey,
  rowHiddenNoticeId,
  type RowHiddenEpisode,
} from "../core/scheduling/hidden-row";
import { taskRowAttention } from "../core/workspaces/task-row-attention";
import { fakeAdapter } from "./support/fakes";

/**
 * A task hidden behind a Nucleus-owned T3 row snooze tells its planner
 * (nucleus#1417): once per continuous episode after thirty minutes, once per hold
 * generation after three hours, with the age, the wait, the last transition and a
 * supported action — and never a second time across sweeps, rolls or horizon
 * renewals. The clock is injected, the durable state is the real store and the
 * host's own record, and the notice takes the ordinary durable delivery path.
 */

const commit = "a".repeat(40);
const hostId = "host";
const MINUTE = 60_000;

type Delivered = { to: string; id: string; text: string };

async function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ns-row-hidden-")));
  const dbPath = join(dir, "queue.sqlite");
  let store = new Store(dbPath);
  const delivered: Delivered[] = [];
  const visibility = new Map<string, RowSnoozeVisibility>();
  const agents = new Map([
    ["planner", "planning"],
    ["successor", "planning-2"],
  ]);
  const states = new Map([
    ["planner", true],
    ["successor", true],
  ]);
  let notifyFails = false;
  const adapter = fakeAdapter({
    profiles: async () => [],
    validate: async () => commit,
    createWorkspace: async () => {
      throw new Error("unused");
    },
    verifyWorkspace: async () => "",
    createAgent: async () => {
      throw new Error("unused");
    },
    verifyPr: async () => {
      throw new Error("unused");
    },
    originAgent: async (id: string) =>
      agents.has(id)
        ? { id, workspaceId: agents.get(id)!, title: id, archived: false }
        : null,
    observe: async (id: string) => ({
      id,
      workspaceId: agents.get(id) ?? "planning",
      status: states.get(id) === false ? "running" : "idle",
      active: states.get(id) === false,
      permissions: false,
      error: "",
    }),
    notify: async (id: string, messageId: string, text: string) => {
      if (notifyFails) throw new Error("planner thread refused the message");
      delivered.push({ to: id, id: messageId, text });
    },
    rowSnoozeVisibility: async (taskId: string) =>
      visibility.get(taskId) ?? { kind: "clear" },
  });
  let engine = new Engine(store, adapter);
  t.after(async () => {
    await engine.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.setMeta("paused", false);
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: "hidden-row-task",
      title: "Synthetic hidden row",
      repoPath: "/repo",
      planningCommit: commit,
      handoffPath: "handoff.md",
      originAgentId: "planner",
    }),
    hostId,
    "handoff",
    commit,
    { originHostId: hostId, originWorkspaceId: "planning" },
  );
  store.event(inserted.id, "worker_launched", "synthetic worker launch");
  const hidden = (
    taskId: string,
    episodeStartedAt: string,
    kind: RowSnoozeVisibility["kind"] = "snoozed",
  ): RowSnoozeVisibility =>
    kind === "snoozed"
      ? {
          kind,
          threadId: `thread-${taskId}`,
          episodeStartedAt,
          cause: "Waiting on nucleus#1364",
        }
      : kind === "unknown"
        ? {
            kind,
            threadId: `thread-${taskId}`,
            episodeStartedAt,
            cause: "Waiting on nucleus#1364",
            reason: "T3Code could not read the row",
          }
        : { kind: "clear" };
  const observe = async () =>
    new HiddenRows({ store, adapter }).observe(hostId);
  const deliver = () => engine.resolution.deliverRowHiddenNotices();
  const notices = () => store.notices(inserted.id);
  const rowNotices = () =>
    notices().filter((notice) => notice.kind === "row_hidden");
  const record = () =>
    store.getMeta<RowHiddenEpisode>(rowHiddenKey(inserted.id));
  return {
    get store() {
      return store;
    },
    get engine() {
      return engine;
    },
    adapter,
    delivered,
    visibility,
    hidden,
    observe,
    deliver,
    notices,
    rowNotices,
    record,
    /** A restarted service process: the same database file, a fresh store and engine. */
    reopen: async () => {
      await engine.stop();
      store.close();
      store = new Store(dbPath);
      engine = new Engine(store, adapter);
      store.setMeta("paused", false);
    },
    task: () => store.task(inserted.id),
    setNotifyFails: (value: boolean) => {
      notifyFails = value;
    },
    setPlannerRunning: (running: boolean) => states.set("planner", !running),
  };
}

/** A clock the store's own timestamps read, so the durable record's age is the test's. */
function clock(t: TestContext, start = Date.parse("2026-11-20T00:00:00.000Z")) {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  return {
    start,
    at: (offsetMs: number) => t.mock.timers.setTime(start + offsetMs),
  };
}

test("a hidden row is reported once after thirty minutes, with age, wait, transition and action", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));

  await f.observe();
  c.at(ROW_HIDDEN_MINUTES * MINUTE - MINUTE);
  await f.observe();
  assert.equal(f.rowNotices().length, 0, "inside the bound nothing is raised");
  assert.equal(
    f.record()?.episode,
    episode,
    "the episode accrues from the recorded snooze start",
  );

  c.at(ROW_HIDDEN_MINUTES * MINUTE);
  await f.observe();
  const [notice] = f.rowNotices();
  assert.ok(notice, "the bound raises one notice");
  assert.equal(notice.id, rowHiddenNoticeId(f.task().id, episode));
  assert.equal(notice.status, "pending");
  assert.equal(notice.kind, "row_hidden");
  assert.match(notice.text, /Synthetic hidden row/);
  assert.match(notice.text, /Hidden for: 30 minutes/);
  assert.match(notice.text, /Wait reason: \S/);
  assert.match(notice.text, /Last transition: \w+ at \d{4}-/);
  assert.match(
    notice.text,
    /genuinely waits/,
    "a legitimate wait is named as one",
  );
  assert.match(
    notice.text,
    /task\.next/,
    "a supported inspection or owner action is named",
  );
  assert.equal(
    f.notices().some((other) => other.kind === "attention"),
    false,
  );

  await f.deliver();
  assert.deepEqual(
    f.delivered.map((message) => message.to),
    ["planner"],
  );
  assert.equal(f.delivered[0]!.id, notice.id);

  // Sweeps, renewals and a fresh pass change nothing: the episode is one notice.
  c.at(3 * 60 * MINUTE);
  await f.observe();
  await f.deliver();
  await f.observe();
  assert.equal(f.rowNotices().length, 1);
  assert.equal(f.delivered.length, 1);
});

test("a horizon renewal and a fresh pass resume the same episode instead of notifying again", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
  c.at(ROW_HIDDEN_MINUTES * MINUTE);
  await f.observe();
  await f.deliver();
  assert.equal(f.delivered.length, 1);
  const recorded = f.record();
  assert.ok(recorded?.noticeId);

  // Five hours later, on a fresh pass (a new owner object, the durable record the
  // same): the horizon was renewed in between, the episode did not restart.
  c.at(5 * 60 * MINUTE);
  await f.observe();
  await f.observe();
  await f.deliver();
  assert.equal(f.rowNotices().length, 1, "a renewal is not a new episode");
  assert.equal(f.delivered.length, 1, "the one notice is never repeated");
  assert.equal(
    f.record()?.since,
    recorded!.since,
    "the accrual anchor is unchanged",
  );
  assert.equal(
    f.record()?.noticeId,
    recorded!.noticeId,
    "the notice identity is durable",
  );
});

test("a restarted service over the same store resumes the episode and keeps one notice", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
  c.at(ROW_HIDDEN_MINUTES * MINUTE);
  await f.observe();
  await f.deliver();
  assert.equal(f.delivered.length, 1);
  const raised = f.rowNotices()[0]!;
  const recorded = f.record()!;

  // A restart: the same database file, a fresh store, engine and owner object. A
  // roll loses nothing durable, so the episode and its one notice survive it.
  await f.reopen();
  c.at(2 * 60 * MINUTE);
  await f.observe();
  await f.deliver();
  assert.deepEqual(
    f.record(),
    recorded,
    "the durable episode is unchanged across the restart",
  );
  assert.equal(f.rowNotices().length, 1, "the restart raises nothing new");
  assert.equal(f.rowNotices()[0]!.id, raised.id);
  assert.equal(f.delivered.length, 1, "the delivered notice is never repeated");
  assert.equal(f.rowNotices()[0]!.status, "delivered");
});

test("a confirmed wake, a terminal closeout and a new episode clear the timer", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const first = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, first));
  c.at(ROW_HIDDEN_MINUTES * MINUTE);
  await f.observe();
  assert.equal(f.rowNotices().length, 1);
  assert.ok(f.record());

  // Nothing was delivered yet: a confirmed wake supersedes the pending notice.
  f.visibility.set(f.task().id, { kind: "clear" });
  await f.observe();
  assert.equal(f.rowNotices()[0]!.status, "superseded");
  assert.equal(f.record(), undefined, "the episode is gone");
  await f.deliver();
  assert.equal(f.delivered.length, 0, "a superseded notice is never sent");

  // A genuinely new waiting episode starts its own clock and its own notice.
  const second = new Date(c.start + 60 * MINUTE).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, second));
  await f.observe();
  assert.equal(
    f.rowNotices().length,
    1,
    "a new episode is inside its own bound",
  );
  c.at(90 * MINUTE);
  await f.observe();
  assert.deepEqual(
    f
      .rowNotices()
      .map((notice) => notice.id)
      .sort(),
    [
      rowHiddenNoticeId(f.task().id, first),
      rowHiddenNoticeId(f.task().id, second),
    ].sort(),
  );

  // The terminal lane owns a finished task's row: no notice and no record.
  f.store.update(f.task().id, { phase: "done" });
  await f.observe();
  assert.equal(f.record(), undefined);
  assert.equal(
    f.rowNotices().filter((notice) => notice.status === "pending").length,
    0,
    "no pending notice survives closeout",
  );
});

test("an owner change re-points a pending notice and never reaches the old planner", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
  c.at(ROW_HIDDEN_MINUTES * MINUTE);
  await f.observe();

  f.store.update(f.task().id, { notificationAgentId: "successor" });
  await f.deliver();
  assert.equal(
    f.rowNotices()[0]!.agentId,
    "successor",
    "the pending notice follows the owner",
  );
  assert.equal(f.delivered.length, 0, "nothing is sent to the retired planner");

  await f.deliver();
  assert.deepEqual(
    f.delivered.map((message) => message.to),
    ["successor"],
  );
  assert.equal(
    f.rowNotices().length,
    1,
    "an owner change never creates a second notice",
  );
});

test("an undelivered notice stays visible while the planner is busy, and a refused send stays unknown", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
  c.at(ROW_HIDDEN_MINUTES * MINUTE);
  await f.observe();

  f.setPlannerRunning(true);
  await f.deliver();
  assert.equal(f.delivered.length, 0);
  const waiting = f.rowNotices()[0]!;
  assert.equal(
    waiting.status,
    "pending",
    "the notice stays pending and visible",
  );
  assert.match(waiting.error, /Waiting for the planner/);

  f.setPlannerRunning(false);
  await f.deliver();
  assert.equal(
    f.delivered.length,
    1,
    "the notice recovers through the ordinary delivery fence",
  );

  // A second episode's send fails: the outcome is unknown and never resent, and the
  // planner's next pass does not turn it into a second notice.
  f.store.update(f.task().id, { phase: "done" });
  const other = f.store.insert(
    submissionSchema.parse({
      submissionId: "hidden-row-task-2",
      title: "Second hidden row",
      repoPath: "/repo",
      planningCommit: commit,
      handoffPath: "handoff.md",
      originAgentId: "planner",
    }),
    hostId,
    "handoff",
    commit,
    { originHostId: hostId, originWorkspaceId: "planning" },
  );
  f.visibility.set(
    other.id,
    f.hidden(other.id, new Date(c.start + 120 * MINUTE).toISOString()),
  );
  c.at(180 * MINUTE);
  await f.observe();
  f.setNotifyFails(true);
  await f.deliver();
  const refused = f.store
    .notices(other.id)
    .find((notice) => notice.kind === "row_hidden")!;
  assert.equal(refused.status, "uncertain");
  assert.match(refused.error, /refused the message/);
  await f.observe();
  await f.deliver();
  assert.equal(
    f.store.notices(other.id).filter((notice) => notice.kind === "row_hidden")
      .length,
    1,
    "an unknown delivery is never turned into a second notice",
  );
});

test("a hidden row whose task needs attention never doubles the ordinary attention message", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
  const task = f.task();
  f.store.update(task.id, {
    resolution: { ...task.resolution, attention: true },
    reason: "A role stalled with nobody told",
  });
  // The ordinary attention delivery already reached this planner for this state.
  f.store.putNotice({
    id: noticeId(f.store.task(task.id)),
    taskId: task.id,
    agentId: "planner",
    recipientAgentId: "planner",
    workspaceId: "planning",
    sources: [],
    originEntry: true,
    kind: "attention",
    status: "delivered",
    error: "",
    text: "Nucleus needs attention",
  } satisfies Notice);

  c.at(ROW_HIDDEN_MINUTES * MINUTE);
  await f.observe();
  assert.equal(
    f.rowNotices().length,
    0,
    "the planner is not told the same thing twice",
  );
  const failure = f.store
    .events(task.id)
    .find((event) => event.kind === "row_hidden_visibility_failure");
  assert.ok(failure, "the visibility failure is recorded as evidence");
  assert.match(failure.detail, /30 minutes hidden behind a Nucleus snooze/);

  // A repeated pass records the evidence once.
  await f.observe();
  assert.equal(
    f.store
      .events(task.id)
      .filter((event) => event.kind === "row_hidden_visibility_failure").length,
    1,
  );

  // Without an attention notice the row's own notice is raised and says the row
  // should be visible: the missed-transition wording, not the waiting one.
  f.store.putNotice({
    ...f.notices().find((notice) => notice.kind === "attention")!,
    status: "superseded",
    error: "attention settled",
  });
  await f.observe();
  const [notice] = f.rowNotices();
  assert.ok(notice);
  assert.match(notice.text, /should be visible on T3 and still reads snoozed/);
  assert.match(notice.text, /needs a person/);
});

test("pending, intent or uncertain attention notices do not suppress the hidden-row notice", async (t) => {
  const c = clock(t);
  for (const status of ["pending", "intent", "uncertain"] as const) {
    c.at(0);
    const f = await fixture(t);
    const episode = new Date(c.start).toISOString();
    f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
    const task = f.task();
    f.store.update(task.id, {
      resolution: { ...task.resolution, attention: true },
      reason: "A role stalled with nobody told",
    });
    f.store.putNotice({
      id: noticeId(f.store.task(task.id)),
      taskId: task.id,
      agentId: "planner",
      recipientAgentId: "planner",
      workspaceId: "planning",
      sources: [],
      originEntry: true,
      kind: "attention",
      status,
      error: status === "uncertain" ? "delivery unknown" : "",
      text: "Nucleus needs attention",
    } satisfies Notice);

    c.at(ROW_HIDDEN_MINUTES * MINUTE);
    await f.observe();
    const [notice] = f.rowNotices();
    assert.ok(
      notice,
      `status=${status} attention notice must not suppress row_hidden`,
    );
    assert.equal(notice.status, "pending");
    assert.equal(f.record()?.noticeId, notice.id);
    assert.equal(
      f.store
        .events(task.id)
        .some((event) => event.kind === "row_hidden_visibility_failure"),
      false,
      `status=${status} must not record coalesced delivery`,
    );

    // Once the ordinary attention notice is confirmed delivered to the planner,
    // the pending row_hidden notice supersedes instead of double-notifying.
    f.store.putNotice({
      ...f.notices().find((n) => n.kind === "attention")!,
      status: "delivered",
      error: "",
    });
    await f.observe();
    assert.equal(f.rowNotices()[0]!.status, "superseded");
    assert.equal(f.record()?.noticeId, null);
    assert.ok(
      f.store
        .events(task.id)
        .some((event) => event.kind === "row_hidden_visibility_failure"),
      "confirmed delivery coalesces and records the visibility failure event",
    );
  }
});

test("a row left snoozed while a role is running is a missed transition, not a wait", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
  // Nucleus is running a role for this task, so its row must be shown.
  f.store.putRun({
    id: "synthetic-live-run",
    taskId: f.task().id,
    hostId,
    role: "revision",
    generation: 0,
    head: commit,
    base: commit,
    workspaceId: "planning",
    agentId: "agent-live",
    profile: null,
    status: "running",
    createdAt: new Date(c.start).toISOString(),
    lastObservedAt: null,
    active: true,
    idleSince: null,
    released: false,
    completion: null,
  });

  c.at(ROW_HIDDEN_MINUTES * MINUTE);
  await f.observe();
  const [notice] = f.rowNotices();
  assert.ok(notice, "a role running behind a hidden row is reported");
  assert.match(notice.text, /should be visible on T3 and still reads snoozed/);
  assert.match(notice.text, /has a role running/);
  assert.match(notice.text, /keeps sending the ordinary unsnooze every pass/);
  // The episode's own timer is what fired, not the newer projected state.
  assert.equal(
    f.record()?.since,
    episode,
    "the timer keeps the original episode start",
  );
});

test("an unreadable row is reported as unknown, never as clear", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode, "unknown"));
  c.at(ROW_HIDDEN_MINUTES * MINUTE);
  await f.observe();
  const [notice] = f.rowNotices();
  assert.ok(notice, "the recorded snooze is still an episode");
  assert.match(notice.text, /cannot be read/);
  assert.match(notice.text, /does not claim the row is clear/);
  assert.match(notice.text, /T3Code could not read the row/);
  assert.match(notice.text, /state cannot be read/);
  assert.equal(f.record()?.episode, episode, "the evidence is preserved");
  assert.equal(
    f.store
      .events(f.task().id)
      .some((event) => event.kind === "row_hidden_visibility_failure"),
    false,
    "an unreadable row is not recorded as a missed transition",
  );
});

test("an explicit hold uses its own three-hour nudge and excludes hold time from the wait rule", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const episode = new Date(c.start).toISOString();
  f.store.update(f.task().id, { phase: "verifying" });
  f.store.update(
    f.task().id,
    holdPatch(
      f.task(),
      "merge",
      "planner",
      "Waiting for the operator ruling",
      null,
    ),
  );
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));

  c.at(ROW_HIDDEN_MINUTES * MINUTE);
  await f.observe();
  assert.equal(
    f.rowNotices().length,
    0,
    "an explicit hold is excluded from the thirty-minute rule",
  );

  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE - MINUTE);
  await f.observe();
  assert.equal(
    f.rowNotices().length,
    0,
    "inside the hold bound nothing is raised",
  );

  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE);
  await f.observe();
  const [nudge] = f.rowNotices();
  assert.ok(
    nudge,
    "three hours of a continuous hold gives one informational nudge",
  );
  assert.equal(nudge.id, rowHiddenHoldNoticeId(f.task().id, "merge", 1));
  assert.match(nudge.text, /a hold still hides a task row/);
  assert.match(nudge.text, /Hold reason: Waiting for the operator ruling/);
  assert.match(nudge.text, /Release condition: none recorded/);
  assert.equal(f.record()?.held, true);

  c.at(6 * 60 * MINUTE);
  await f.observe();
  await f.deliver();
  assert.equal(f.rowNotices().length, 1, "one nudge per hold generation");
  assert.equal(f.delivered.length, 1);

  // Released: the row is still hidden, but hold time never accrues toward the wait
  // episode, so the thirty-minute clock starts at the release.
  f.store.update(f.task().id, releasePatch(f.task(), "merge"));
  const released = 6 * 60 * MINUTE;
  c.at(released);
  await f.observe();
  c.at(released + ROW_HIDDEN_MINUTES * MINUTE - MINUTE);
  await f.observe();
  assert.equal(
    f.rowNotices().filter((notice) => notice.status === "pending").length,
    0,
    "no implicit notice before the wait bound restarts at release",
  );
  c.at(released + ROW_HIDDEN_MINUTES * MINUTE);
  await f.observe();
  const wait = f
    .rowNotices()
    .find((notice) => notice.id === rowHiddenNoticeId(f.task().id, episode));
  assert.ok(wait, "after release the row gets the ordinary hidden-wait notice");
  assert.match(wait.text, /genuinely waits/);
});

test("the existing hold reminder for the same generation is reused, not repeated", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const episode = new Date(c.start).toISOString();
  f.store.update(f.task().id, { phase: "verifying" });
  f.store.update(
    f.task().id,
    holdPatch(
      f.task(),
      "merge",
      "planner",
      "Waiting for the operator ruling",
      null,
    ),
  );
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
  // Spec 040 already prompted this planner for this hold generation.
  f.store.event(
    f.task().id,
    "hold_ready_notified",
    "planner; head " + "b".repeat(40) + "; generation 1",
  );
  f.store.putNotice({
    id: "hold-already-delivered",
    taskId: f.task().id,
    agentId: "planner",
    recipientAgentId: "planner",
    workspaceId: "planning",
    sources: [],
    originEntry: false,
    kind: "hold",
    status: "delivered",
    error: "",
    text: "Nucleus: a merge hold is the only thing stopping a reviewed task",
  } satisfies Notice);

  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE);
  await f.observe();
  assert.equal(
    f.rowNotices().length,
    0,
    "the existing reminder is the planner nudge for this generation",
  );
  assert.equal(f.record()?.held, true);
});

/**
 * nucleus#1419: a planner's own hold parks the task, gets one nudge after three
 * hours, and needs its planner's answer inside the answer window. A released hold,
 * or a keep that starts a fresh generation, is the answer; a closed window with the
 * hold still in place shows the row again and never touches the hold itself.
 */

/** A planner's own manual hold, the shape a reviewed task waits behind for its owner. */
function planHold(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: "merge" | "dispatch" = "merge",
) {
  if (kind === "merge") f.store.update(f.task().id, { phase: "verifying" });
  f.store.update(
    f.task().id,
    holdPatch(f.task(), kind, "planner", "Effigy v0.15 upgrade day", null),
  );
  return () => f.task().holds?.[kind]?.plannerAnswer ?? null;
}

/** The one attention projection the board and a host row read. */
const taskRowState = (f: Awaited<ReturnType<typeof fixture>>) =>
  taskRowAttention(f.store, f.task()).state;

const escalated = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.store
    .events(f.task().id)
    .filter((event) => event.kind.startsWith("row_hidden_hold_"));

test("a planner's own hold is nudged once, and a release inside the answer window is the answer", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const answer = planHold(f);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));

  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE);
  await f.observe();
  const nudge = f.rowNotices()[0];
  assert.ok(nudge, "the hold bound raises the planner's nudge");
  assert.equal(nudge.id, rowHiddenHoldNoticeId(f.task().id, "merge", 1));
  assert.match(nudge.text, /Answer window/);
  assert.match(nudge.text, /within 30 minutes of this nudge/);
  assert.deepEqual(
    {
      since: answer()?.since,
      deliveredAt: answer()?.deliveredAt,
      unansweredAt: answer()?.unansweredAt,
    },
    {
      since: new Date(c.start).toISOString(),
      deliveredAt: null,
      unansweredAt: null,
    },
    "the fence records the nudge and owes the planner's answer",
  );

  await f.deliver();
  assert.equal(nudge.status, "pending");
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE + MINUTE);
  await f.observe();
  assert.ok(
    answer()?.deliveredAt,
    "the confirmed delivery starts the answer window",
  );
  // The planner releases the hold inside the window.
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE + 10 * MINUTE);
  f.store.update(f.task().id, releasePatch(f.task(), "merge"));
  await f.observe();
  assert.equal(
    escalated(f).length,
    0,
    "a timely release closes the answer cycle without an escalation",
  );
  assert.equal(f.task().holds?.merge, undefined);
  // The row is still hidden, and the ordinary wait episode owns it now.
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE + 40 * MINUTE);
  await f.observe();
  assert.equal(
    escalated(f).length,
    0,
    "hold time never escalates anything after the release",
  );
  assert.match(
    f.rowNotices().at(-1)!.text,
    /genuinely waits/,
    "the released row is back on the ordinary wait rule",
  );
});

test("a keep inside the answer window is a fresh generation, not an escalation", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const answer = planHold(f);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE);
  await f.observe();
  await f.deliver();
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE + MINUTE);
  await f.observe();

  const kept = (await f.engine.performTaskControl({
    taskId: f.task().id,
    version: f.task().version,
    action: "keep_hold",
    kind: "merge",
    reason: "Upgrade day moved to next week",
    agentId: "planner",
  })) as ReturnType<typeof f.task>;
  assert.equal(kept.holdGeneration, 2);
  assert.equal(answer(), null, "a fresh keep clears the previous answer cycle");
  await f.observe();
  assert.equal(
    escalated(f).length,
    0,
    "the keep answered the nudge for its generation",
  );
  assert.equal(taskRowState(f), "waiting", "the kept hold parks the row again");
  assert.equal(
    f
      .rowNotices()
      .filter(
        (notice) =>
          notice.id === rowHiddenHoldNoticeId(f.task().id, "merge", 1),
      ).length,
    1,
    "the answered generation keeps its one nudge",
  );
  // The fresh generation owes its own nudge, three hours from the keep.
  c.at(
    ROW_HIDDEN_HOLD_MINUTES * MINUTE +
      MINUTE +
      ROW_HIDDEN_HOLD_MINUTES * MINUTE -
      MINUTE,
  );
  await f.observe();
  assert.equal(
    escalated(f).length,
    0,
    "the fresh generation has not reached its own hold bound",
  );
});

test("an unanswered nudge shows the row again and touches no hold", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const answer = planHold(f);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE);
  await f.observe();
  await f.deliver();
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE + MINUTE);
  await f.observe();
  const deliveredAt = answer()!.deliveredAt!;

  // Ordinary reads, sweeps and unchanged state are not an answer.
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE + 20 * MINUTE);
  await f.observe();
  await f.observe();
  assert.equal(answer()?.unansweredAt, null, "unchanged state answers nothing");
  assert.equal(escalated(f).length, 0);

  c.at(Date.parse(deliveredAt) + 30 * MINUTE);
  await f.observe();
  assert.ok(answer()?.unansweredAt, "the closed answer window is recorded");
  assert.equal(answer()?.deliveryFault, "", "the nudge did reach the planner");
  const [event] = escalated(f);
  assert.ok(event, "the escalation is recorded once");
  assert.equal(event.kind, "row_hidden_hold_unanswered");
  assert.match(event.detail, /did not release or keep the hold/);
  assert.equal(
    taskRowState(f),
    "attention",
    "the task needs its planner again for this hold generation",
  );
  assert.deepEqual(
    {
      generation: f.task().holdGeneration,
      reason: f.task().holdReason,
      held: f.task().held,
    },
    { generation: 1, reason: "Effigy v0.15 upgrade day", held: true },
    "the hold itself is untouched",
  );

  // Further passes record nothing new, and the generation stays visible.
  c.at(Date.parse(deliveredAt) + 90 * MINUTE);
  await f.observe();
  assert.equal(escalated(f).length, 1, "one escalation per generation");
  assert.equal(taskRowState(f), "attention");
});

test("a nudge that never reaches the planner shows the task and the delivery fault", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const answer = planHold(f);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE);
  await f.observe();
  f.setNotifyFails(true);
  await f.deliver();
  const [nudge] = f.rowNotices();
  assert.equal(
    nudge!.status,
    "uncertain",
    "the failed send is unknown delivery",
  );
  assert.match(nudge!.error, /refused the message/);

  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE + HOLD_ANSWER_MINUTES * MINUTE);
  await f.observe();
  assert.equal(answer()?.deliveredAt, null, "delivery was never confirmed");
  assert.match(
    answer()?.deliveryFault ?? "",
    /refused the message/,
    "the fence keeps the delivery fault",
  );
  const [event] = escalated(f);
  assert.equal(event?.kind, "row_hidden_hold_undelivered");
  assert.match(event.detail, /was not delivered/);
  assert.match(event.detail, /refused the message/);
  const projection = taskRowAttention(f.store, f.task());
  assert.equal(projection.state, "attention");
  assert.match(
    projection.state === "attention" ? projection.cause : "",
    /not delivered to the planner/,
    "the visible reason names the delivery fault",
  );
});

test("an independent question keeps the row visible without consuming the answer window", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  planHold(f);
  // The task needs a person for its own reason: the row is shown, and a planner's
  // hold never hides that.
  f.store.update(f.task().id, {
    resolution: { ...f.task().resolution, attention: true },
  });
  assert.equal(
    taskRowState(f),
    "attention",
    "the row stays visible for the question",
  );
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE);
  await f.observe();
  assert.equal(
    f.rowNotices().filter((notice) => notice.kind === "row_hidden").length,
    0,
    "a visible row owes no hidden-row nudge",
  );
  assert.equal(taskRowState(f), "attention");
});

test("a restarted service resumes the same answer cycle and escalates once", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  const answer = planHold(f);
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE);
  await f.observe();
  await f.deliver();
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE + MINUTE);
  await f.observe();
  const deliveredAt = answer()!.deliveredAt!;
  await f.reopen();
  c.at(Date.parse(deliveredAt) + 30 * MINUTE);
  await f.observe();
  assert.equal(
    escalated(f).length,
    1,
    "the reopened service escalates the same cycle",
  );
  assert.equal(f.rowNotices().length, 1, "and raises no second nudge");
});

test("a hold another participant placed keeps its visibility and gets no planner nudge", async (t) => {
  const f = await fixture(t);
  const c = clock(t);
  // The task's planner is its owner ("planner"); this fence belongs to a reviewer
  // thread, so the row is not the planner's park and owes no answer window.
  f.store.update(f.task().id, { phase: "needs_attention" });
  f.store.update(
    f.task().id,
    holdPatch(
      f.task(),
      "dispatch",
      "reviewer-thread",
      "Receipt still pending",
      null,
    ),
  );
  const episode = new Date(c.start).toISOString();
  f.visibility.set(f.task().id, f.hidden(f.task().id, episode));
  assert.equal(
    taskRowState(f),
    "attention",
    "another participant's hold is visible",
  );
  c.at(ROW_HIDDEN_HOLD_MINUTES * MINUTE);
  await f.observe();
  // The 1417 hold report still names the hidden row, but it opens no answer window:
  // only the planner's own park does, because only the planner can answer it.
  const [report] = f.rowNotices();
  assert.ok(report, "the hidden row is still reported to the planner");
  assert.doesNotMatch(report.text, /Answer window/);
  assert.match(report.text, /once its condition no longer applies/);
  assert.equal(f.task().holds?.dispatch?.plannerAnswer ?? null, null);
  assert.equal(escalated(f).length, 0);
  assert.equal(
    taskRowState(f),
    "attention",
    "no escalation changes the visibility another holder owns",
  );
  assert.equal(
    f.task().holds?.dispatch?.owner,
    "reviewer-thread",
    "the fence keeps its own owner",
  );
});
