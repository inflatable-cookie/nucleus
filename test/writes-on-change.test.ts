import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  get as httpGet,
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import {
  submissionSchema,
  uiBoardSchema,
  type Profile,
  type Run,
  type Task,
  type UiBoard,
} from "../shared/contracts";
import type { Adapter } from "../core/host/adapter";
import { createUiSnapshotFactsCache } from "../core/telemetry/ui-snapshot";
import { createTaskDetailCache } from "../core/telemetry/task-detail";
import { RuntimeBoard } from "../core/runtime/board";
import { hostOutageIntervals } from "../core/scheduling/host-outage";
import { taskBudget } from "../shared/task-budget";
import {
  endsStopOnReason,
  stopClearedPatch,
  TASK_PROGRESSING_REASON,
} from "../shared/task-stop";
import { DISPATCH_HELD_REASON } from "../core/dispatch/capacity";
import { WebBoard, type WebBoardHost } from "../service/web/web-board";

/**
 * Spec 069 §3 (Tom, 2026-11-22): the scheduler writes only when something
 * changes. A host going away or coming back costs one outage record, not a write
 * per task; every read works the wait and the budget pause out from that record.
 * A stop belongs to its writer, a meta write compares first and the board's live
 * channel coalesces a burst of revisions.
 *
 * Real Store, Engine and HostHealth. The sweep's own fleet steps are stubbed so a
 * pass is the host reading and the task visits; the board reads are the real
 * snapshot, detail and `next` read paths.
 */
const HOST = "t3code:synthetic-environment";
const OTHER = "t3code:synthetic-other";
const base = "b".repeat(40);
const profile: Profile = {
  id: "synthetic-profile",
  name: "Synthetic",
  provider: "synthetic-provider",
  model: "synthetic-model",
  available: true,
  problem: "",
  notes: "",
  supportedThinking: [],
};
type Loose = Record<string, any>;

function fixture(t: TestContext, options: { working?: number } = {}) {
  const store = new Store(":memory:");
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 0);
  const insert = (title: string) =>
    store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title,
        repoPath: "/synthetic/repo",
        planningCommit: base,
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      HOST,
      "handoff.md",
      base,
    );
  const working = Array.from({ length: options.working ?? 1 }, (_, index) =>
    store.update(
      insert(`Working task ${index}`).id,
      {
        phase: "working",
        workspaceIntent: true,
        agentIntent: true,
        workspaceId: `synthetic-workspace-${index}`,
        agentId: `synthetic-worker-${index}`,
        runId: "initial",
        directory: "/synthetic/repo",
        branch: `ns-synthetic-${index}`,
        baseBranch: "main",
        profile,
        workerModel: profile.model,
        workerModels: [profile.model],
      },
      "dispatched",
    ),
  );
  // Each worker has been running for an hour (its `agent_created` history), so
  // its wall-time budget has a real span to charge.
  const startedAt = new Date(Date.now() - 3_600_000).toISOString();
  const created = store.db.prepare(
    "INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)",
  );
  for (const task of working)
    created.run(task.id, startedAt, "agent_created", `synthetic-worker-${task.id}`);
  const engine = new Engine(store, { hostId: HOST } as unknown as Adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  const connection = { live: true, other: false };
  engine.hostIds = () => [HOST, OTHER];
  engine.hostAvailable = (id) =>
    id === HOST ? connection.live : id === OTHER && connection.other;
  const visited: string[] = [];
  engine.lastHookCleanupAt = Date.now();
  engine.migrateProjectOwnersToPlanners = async () => {};
  engine.clearRetiredInvalidations = () => {};
  engine.resumePausedStops = async () => {};
  engine.recoverExhaustedWorkers = async () => {};
  engine.archiveRetiredErroredAgents = async () => {};
  engine.applyDeferredOwnerVerbs = async () => {};
  engine.deliverPendingBriefAmendments = async () => {};
  engine.continueAwaitingReviewers = async () => {};
  engine.lifecycle.enqueuePass = async () => {};
  engine.resolution.origins.pass = async () => {};
  engine.resolution.observationTargets = () => [];
  engine.resolution.observe = async () => {};
  engine.scheduleTaskQuantum = async (taskId) => {
    visited.push(taskId);
  };
  engine.dispatchQueued = async () => {};
  for (const method of [
    "deliverNotices",
    "deliverQueuedMessages",
    "resumeAskQuestions",
    "raiseOperatorQuestions",
    "delegateNativeQuestions",
    "resumeResponsibleAnsweredQuestions",
    "deliverHoldNotices",
    "deliverDecisionNotices",
    "deliverDrainNotices",
    "deliverHostOutageNotices",
    "deliverRowHiddenNotices",
  ] as const)
    (engine.resolution as Loose)[method] = async () => {};
  const externalWait = (task: Task) => engine.currentExternalWait(task);
  const snapshot = createUiSnapshotFactsCache(
    store,
    (tasks, runs) => engine.resolution.slotAdmissionReader(tasks, runs, true),
    () => [],
    externalWait,
    () => engine.queuedWaitSignature(),
  );
  const board = new RuntimeBoard({
    store,
    engine,
    cachedTaskDetail: createTaskDetailCache(store, { externalWait }),
    cachedUiSnapshotFacts: snapshot,
    markStoreAccess: () => {},
  } as unknown as ConstructorParameters<typeof RuntimeBoard>[0]);
  return {
    store,
    engine,
    working,
    connection,
    visited,
    startedAt,
    snapshot,
    board,
    insert,
    pass: () => engine.auditPass(true),
    /** Rows the database wrote since it opened: every table, meta included. */
    changes: () =>
      Number(
        (store.db.prepare("SELECT total_changes() AS n").get() as { n: number })
          .n,
      ),
  };
}

const budgetPausedMs = (store: Store, task: Task) =>
  taskBudget(
    store.task(task.id),
    store.runs(task.id),
    Date.now(),
    store.eventsAll(task.id),
    null,
    hostOutageIntervals(store, task.hostId),
  ).wallMs.pausedMs;

/** Move the host's open outage back, as a long outage would be. */
function ageOutage(store: Store, minutes: number) {
  const outages = store.getMeta<Record<string, Loose>>("hostOutages")!;
  store.setMeta("hostOutages", {
    ...outages,
    [HOST]: {
      ...outages[HOST],
      since: new Date(Date.now() - minutes * 60_000).toISOString(),
    },
  });
}

test("200 in-flight tasks: a host going down writes O(1) records and every card and next shows the wait; its return writes O(1)", async (t) => {
  const f = fixture(t, { working: 200 });
  await f.pass();
  const versions = () =>
    f.working.map((task) => f.store.task(task.id).version).join(",");
  const before = versions();
  const visitedBefore = f.visited.length;

  f.connection.live = false;
  const down = f.changes();
  await f.pass();
  const outage = f.engine.hostOutages.current(HOST);
  assert.ok(outage, "the outage opens on the host's transition");
  const wrote = f.changes() - down;
  assert.ok(wrote <= 5, `the outage wrote ${wrote} rows for 200 tasks`);
  assert.equal(versions(), before, "no task row was written");
  assert.equal(
    f.visited.length,
    visitedBefore,
    "nothing is sent to a host that is down",
  );

  // Every card reads the wait, dated from the outage, beside no stored record.
  const cards = f.snapshot().summaries.filter((card) =>
    f.working.some((task) => task.id === card.id),
  );
  assert.equal(cards.length, 200);
  for (const card of cards) {
    assert.equal(card.stopRecord?.reason, "host_unavailable", card.reason);
    assert.equal(card.hostWait?.since, outage.since);
  }
  // `next` and task detail read the same wait.
  for (const task of f.working) {
    const next = f.board.taskNext({ taskId: task.id });
    assert.equal(next.stop?.reason, "host_unavailable");
    assert.match(next.reason, /^Waiting on T3Code host synthetic-environment since /);
  }
  const detail = f.board.detail({ taskId: f.working[0]!.id }).task;
  assert.equal(detail.resolution.stop?.reason, "host_unavailable");
  assert.equal(detail.resolution.hostWait?.since, outage.since);
  assert.equal(f.store.task(f.working[0]!.id).resolution.hostWait, null);

  // A second pass over the same outage writes nothing at all.
  const steady = f.changes();
  await f.pass();
  assert.equal(f.changes() - steady, 0, "an unchanged outage writes nothing");

  f.connection.live = true;
  const up = f.changes();
  await f.pass();
  const reconnect = f.changes() - up;
  assert.ok(reconnect <= 5, `the return wrote ${reconnect} rows for 200 tasks`);
  assert.equal(f.engine.hostOutages.current(HOST), null, "the outage closes");
  assert.equal(versions(), before, "still no task row was written");
  assert.equal(
    f.visited.length,
    visitedBefore + 200,
    "every task is visited again on the first connected pass",
  );
  const back = f.snapshot().summaries.find((card) => card.id === f.working[0]!.id)!;
  assert.equal(back.hostWait, undefined);
  assert.notEqual(back.stopRecord?.reason, "host_unavailable");
});

test("the wall-time budget pauses for an outage and keeps the closed outage off, with no per-task clock write", async (t) => {
  const f = fixture(t);
  const task = f.working[0]!;
  await f.pass();
  f.connection.live = false;
  await f.pass();
  ageOutage(f.store, 30);
  const paused = budgetPausedMs(f.store, task);
  assert.ok(paused >= 29 * 60_000, `the open outage pauses the clock: ${paused}`);
  assert.ok(
    !f.store.task(task.id).resolution.budgetClock?.since,
    "no clock interval is opened on the task",
  );
  // The board figure discounts the same outage.
  const card = f.snapshot().summaries.find((summary) => summary.id === task.id)!;
  assert.ok(card.budget, "the card carries the budget");
  const [, , , wallUsed] = card.budget!;
  assert.ok(wallUsed <= 31 * 60_000, `the card charges ${wallUsed} ms`);

  f.connection.live = true;
  await f.pass();
  assert.equal(f.engine.hostOutages.current(HOST), null);
  const history = hostOutageIntervals(f.store, HOST);
  assert.equal(history.length, 1, "the closed outage is kept on the host");
  assert.ok(history[0]!.until, "with the time the host came back");
  assert.ok(
    budgetPausedMs(f.store, task) >= 29 * 60_000,
    "the closed outage stays off the budget",
  );
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((event) => event.kind.startsWith("budget_clock_")).length,
    0,
    "no budget_clock event is written per task",
  );
});

test("a board read never moves a host or writes its outage; the tick and the sweep do", async (t) => {
  const f = fixture(t);
  await f.pass();
  f.connection.live = false;
  // Reads only: the wait shows, and nothing is written.
  assert.equal(f.engine.hostHealth.peek(HOST).state, "down");
  assert.match(
    f.engine.currentExternalWait(f.store.task(f.working[0]!.id)),
    /^Waiting on /,
  );
  f.engine.queuedWaitSignature();
  f.snapshot();
  f.board.taskNext({ taskId: f.working[0]!.id });
  const outages = () =>
    JSON.stringify(f.store.getMeta("hostOutages") ?? null);
  assert.equal(f.engine.hostOutages.current(HOST), null, "a read wrote no outage");
  const recorded = outages();
  f.snapshot();
  assert.equal(outages(), recorded, "nor does a second read");
  f.engine.observeHostHealth();
  assert.ok(f.engine.hostOutages.current(HOST), "the runtime tick's reading opens it");
});

test("the queued wait signature changes when a degraded host's in-flight launch starts or ends", (t) => {
  const f = fixture(t);
  const before = f.engine.queuedWaitSignature();
  f.engine.hostHealth.launchStarted(HOST, "synthetic-launch");
  const launching = f.engine.queuedWaitSignature();
  assert.notEqual(launching, before, "a launch in flight changes the board");
  f.engine.hostHealth.launchSettled("synthetic-launch");
  assert.equal(f.engine.queuedWaitSignature(), before);
});

test("a stop belongs to its writer: a reason-only write keeps it, and the writers that end it clear it explicitly", async (t) => {
  const f = fixture(t);
  const task = f.working[0]!;
  const stopped = f.engine.resolution.recordStop(
    f.store.task(task.id),
    "lifecycle",
    "Waiting for the integration turn",
  );
  assert.equal(stopped.resolution.stop?.reason, "lifecycle");

  // A reason-only funnel write by another writer keeps the stop and its time.
  f.store.update(task.id, { reason: "Another writer's progress note" });
  const kept = f.store.task(task.id);
  assert.equal(kept.resolution.stop?.reason, "lifecycle");
  assert.equal(kept.resolution.stop?.since, stopped.resolution.stop?.since);
  // The stop's owner re-observing the same stop does not rewrite its record.
  f.engine.resolution.recordStop(kept, "lifecycle", "Waiting for the integration turn");
  assert.equal(
    f.store.task(task.id).resolution.stop?.since,
    stopped.resolution.stop?.since,
    "no oscillation: the record keeps its first time",
  );

  // Settled-wait prose keeps whatever stop is current (nucleus#1437), now in the
  // funnel too.
  f.engine.resolution.waiting(f.store.task(task.id), TASK_PROGRESSING_REASON, "classify");
  assert.equal(f.store.task(task.id).resolution.stop?.reason, "lifecycle");

  // A former implicit-clear writer ends the stop explicitly: workspace creation
  // progress on a dispatching task.
  f.store.update(task.id, { phase: "dispatching" });
  f.engine.resolution.recordStop(f.store.task(task.id), "lifecycle", "Waiting for workspace admission");
  f.engine.adapter.workspaceCreationProgress?.(task.id, "create_worktree", "started");
  const progressed = f.store.task(task.id);
  assert.equal(progressed.reason, "Creating workspace: create worktree");
  assert.equal(progressed.resolution.stop, null, "the progress write clears the wait it ends");

  // The resolution owner's own update still clears the stop on a reason change.
  f.engine.resolution.recordStop(progressed, "lifecycle", "Waiting again");
  f.engine.resolution.update(f.store.task(task.id), {}, { reason: "Resolution owner moved on" });
  assert.equal(f.store.task(task.id).resolution.stop, null);

  // A phase change still ends the stop's episode.
  f.engine.resolution.recordStop(f.store.task(task.id), "lifecycle", "Waiting once more");
  f.store.update(task.id, { phase: "working" });
  assert.equal(f.store.task(task.id).resolution.stop, null);

  // So does an owner's lifecycle write to the phase the task is already in, when
  // it moves the reason (an owner `move work` on a changes_requested task).
  f.store.update(task.id, { phase: "changes_requested" });
  f.engine.resolution.recordStop(f.store.task(task.id), "operator_needed", "Prompt delivery is uncertain");
  f.store.update(task.id, {
    phase: "changes_requested",
    reason: "Owner moved the task to work",
  });
  assert.equal(
    f.store.task(task.id).resolution.stop,
    null,
    "naming the same phase with a new reason ends the answered stop",
  );
  // Re-asserting the same phase and reason changes nothing.
  const asserted = f.engine.resolution.recordStop(f.store.task(task.id), "lifecycle", "Waiting after the move");
  f.store.update(task.id, { phase: asserted.phase, reason: asserted.reason, title: "Retitled" });
  assert.equal(f.store.task(task.id).resolution.stop?.reason, "lifecycle");
});

test("a writer's explicit clear fires only when its reason really changes, so it never alternates with the stop's owner", (t) => {
  const f = fixture(t);
  const task = f.store.update(f.working[0]!.id, { phase: "dispatching" });
  const stopped = f.engine.resolution.recordStop(task, "lifecycle", "Creating workspace: create worktree");
  const versions = stopped.version;
  // The same progress text again: no clear, no write of the stop.
  f.engine.adapter.workspaceCreationProgress?.(task.id, "create_worktree", "started");
  assert.equal(f.store.task(task.id).resolution.stop?.reason, "lifecycle");
  assert.equal(f.store.task(task.id).version, versions, "re-asserting the same reason writes nothing");
  assert.deepEqual(stopClearedPatch(f.store.task(task.id), stopped.reason), {});
  assert.deepEqual(endsStopOnReason(f.store.task(task.id), stopped.reason), {});
  assert.deepEqual(endsStopOnReason(f.store.task(task.id), "Something else"), { stop: null });
  // A dispatch-held launch attempt is a note beside the hold's own stop.
  f.engine.resolution.recordStop(f.store.task(task.id), "held", DISPATCH_HELD_REASON);
  f.store.update(task.id, { reason: DISPATCH_HELD_REASON });
  assert.equal(f.store.task(task.id).resolution.stop?.reason, "held");
});

test("a dependency change clears the stop it supersedes, explicitly", (t) => {
  const f = fixture(t);
  const prerequisite = f.insert("Prerequisite");
  const queued = f.insert("Dependant");
  f.engine.resolution.recordStop(f.store.task(queued.id), "lifecycle", "Integration base advanced during the pre-dispatch gate; re-running it at the new base");
  f.store.updateDependencies(f.store.task(queued.id), [prerequisite.id], "synthetic-owner");
  const changed = f.store.task(queued.id);
  assert.deepEqual(changed.dependsOn, [prerequisite.id]);
  assert.equal(changed.resolution.stop, null);
});

test("an unchanged meta write writes nothing; a changed one writes once", (t) => {
  const f = fixture(t);
  f.store.setMeta("engineError", "");
  const start = f.changes();
  for (let pass = 0; pass < 50; pass++) f.store.setMeta("engineError", "");
  assert.equal(f.changes() - start, 0, "fifty resets of an empty diagnostic wrote nothing");
  f.store.setMeta("engineError", "synthetic fault");
  assert.equal(f.changes() - start, 1);
  assert.equal(f.store.getMeta("engineError"), "synthetic fault");
  f.store.setMeta("hostPassError", { host: HOST, error: "synthetic" });
  const object = f.changes();
  f.store.setMeta("hostPassError", { host: HOST, error: "synthetic" });
  assert.equal(f.changes() - object, 0, "an equal object is unchanged too");
});

test("a sweep pass with nothing changed resets its diagnostics without writing them", async (t) => {
  const f = fixture(t);
  await f.pass();
  const start = f.changes();
  await f.pass();
  assert.equal(f.changes() - start, 0, "a quiet pass writes nothing");
});

test("a dispatch pass's skipped hosts are read only by that pass and its own visits", async (t) => {
  const f = fixture(t);
  const admission = (f.engine.resolution as Loose).slotAdmission as {
    passSkipsHost(id: string): boolean;
  };
  const skips = (id: string) => admission.passSkipsHost(id);
  const first = new Set([HOST]);
  const second = new Set([OTHER]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const seen: Record<string, boolean> = {};
  const pass = f.engine.resolution.withDispatchPass(async () => {
    seen.inPass = skips(HOST);
    // A lane runs outside the pass's async context; the visit re-enters its set.
    seen.laneWithoutPass = await f.engine.cleanContext(async () => skips(HOST));
    seen.visit = await f.engine.cleanContext(async () =>
      f.engine.resolution.withPassHostSkips(first, () => skips(HOST)),
    );
    await held;
  }, first);
  const concurrent = f.engine.resolution.withDispatchPass(async () => {
    seen.otherPassSeesFirst = skips(HOST);
    seen.otherPassSeesOwn = skips(OTHER);
  }, second);
  await concurrent;
  release();
  await pass;
  assert.deepEqual(seen, {
    inPass: true,
    laneWithoutPass: false,
    visit: true,
    otherPassSeesFirst: false,
    otherPassSeesOwn: true,
  });
  assert.equal(skips(HOST), false, "no set outlives its pass");
});

test("a queued row whose only dispatch trace is a released run is bound to its own host in the head walk", (t) => {
  const f = fixture(t);
  const queued = f.insert("Released run, back in the queue");
  const released: Run = {
    id: "released-run",
    taskId: queued.id,
    hostId: HOST,
    role: "revision",
    generation: 1,
    head: base,
    base,
    agentId: "synthetic-old-worker",
    workspaceId: "synthetic-old-workspace",
    profile,
    profileGroup: "synthetic",
    status: "finished",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: null,
    idleSince: null,
    completion: null,
    released: true,
  };
  f.store.putRun(released);
  // Its own host is down; another host is up with a catalog that could take an
  // unbound first worker.
  f.connection.live = false;
  f.connection.other = true;
  f.engine.targetHostWait = () => null;
  f.engine.workerHostCatalogs = () =>
    [{ hostId: OTHER, profiles: [profile] }] as unknown as ReturnType<
      Engine["workerHostCatalogs"]
    >;
  const startable = (f.engine.dispatchOwner as unknown as {
    startableHead(
      attempted: ReadonlySet<string>,
      failed: ReadonlySet<string>,
    ): (task: Task) => boolean;
  }).startableHead(new Set(), new Set());
  assert.equal(
    startable(f.store.task(queued.id)),
    false,
    "the bound task waits for its own host, not another host's catalog",
  );
  // A truly unbound head may still take the other host.
  const fresh = f.insert("Never dispatched");
  assert.equal(startable(f.store.task(fresh.id)), true);
});

// --- The live channel coalesces a burst of board revisions -----------------

const uiBoard = (revision: number): UiBoard =>
  uiBoardSchema.parse({
    revision,
    connected: true,
    hostId: "host",
    paused: false,
    error: "",
    quiet: true,
    activeWorkers: 0,
    unsettled: 0,
    occupiedSlots: 0,
    globalLimit: 32,
    projectLimit: 5,
    tasks: [],
    profiles: [],
    pool: [],
    availability: [],
    assignments: {},
    recentAssignments: {},
    lanes: [],
    projects: [],
    prStates: {},
    stoppedThreads: 0,
    resumedThreads: 0,
  });

function send(port: number, path: string, headers: Record<string, string>, method = "GET") {
  return new Promise<{ status: number; cookie: string }>((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            cookie: String(response.headers["set-cookie"]?.[0] ?? "").split(";")[0]!,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("a burst of 100 board revisions reaches a live stream as a few boards, ending on the latest", async (t) => {
  let current = uiBoard(1);
  const listeners = new Set<() => void>();
  const host: WebBoardHost = {
    call: async () => {
      throw new Error("no catalogue calls");
    },
    board: () => current,
    unavailable: () => null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const web = new WebBoard({ host, bundleDir: null, port: 0 });
  const port = await web.listen();
  t.after(() => web.close());
  const token = new URLSearchParams(new URL(web.issueLink(5).url).hash.slice(1)).get("token")!;
  const paired = await send(port, "/api/pair", { authorization: `Bearer ${token}` }, "POST");
  assert.equal(paired.status, 200);
  let body = "";
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpGet(
      { host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}`, cookie: paired.cookie } },
      resolve,
    );
    request.on("error", reject);
    t.after(() => request.destroy());
  });
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    body += chunk;
  });
  const boards = () =>
    [...body.matchAll(/id: (\d+)\nevent: board\n/g)].map((match) => Number(match[1]));
  const until = async (ready: () => boolean, label: string) => {
    const deadline = Date.now() + 5_000;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await until(() => boards().includes(1), "the first board");
  // Let the first publication's window pass, so the burst starts after a quiet window.
  await new Promise((resolve) => setTimeout(resolve, 600));

  // One hundred task writes, each advancing the board revision and publishing.
  for (let revision = 2; revision <= 101; revision++) {
    current = uiBoard(revision);
    for (const listener of [...listeners]) listener();
  }
  await until(() => boards().includes(101), "the latest board");
  await new Promise((resolve) => setTimeout(resolve, 700));
  const burst = boards().filter((revision) => revision > 1);
  assert.ok(burst.length <= 3, `the burst reached the stream as ${burst.length} boards: ${burst.join(", ")}`);
  assert.equal(burst.at(-1), 101, "the stream ends on the latest revision");
});
