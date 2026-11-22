import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { HOST_OUTAGES_META_KEY } from "../shared/host-outage";
import { submissionSchema, summarizeTask } from "../shared/contracts";
import type { Profile, Task } from "../shared/contracts";
import type { Adapter } from "../core/host";
import { createTaskAgent, fakeAdapter } from "./support/fakes";
import {
  taskWaitStateContext,
  taskWithCurrentWait,
} from "../core/recovery/wait-context";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";

/**
 * Spec 069 §1 (Tom, 2026-11-22): "adding tasks to the queue is the most
 * rudimentary of crud actions and should have no effect on the scheduler until
 * the task becomes active". A queued, never-started task costs nothing until it
 * is admitted: submission writes the row, the admitter runs on events, and the
 * card and `next` work out the queued wait when they are read.
 *
 * Rows are written through the real Store and the submission runs the real
 * `performSubmit` against a real Git repository, so every field is real.
 */

const profile: Profile = {
  id: "worker",
  name: "Worker",
  provider: "test",
  model: "test",
  notes: "",
  available: true,
  problem: "",
  supportedThinking: ["low"],
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=synthetic@example.com", "-c", "user.name=Synthetic", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** A synthetic repository with a pushed main, the shape a brief submission validates. */
function repository(root: string) {
  const remote = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "-q", "--bare", remote);
  git(root, "clone", "-q", remote, repo);
  git(repo, "checkout", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "synthetic\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "Synthetic");
  git(repo, "push", "-q", "-u", "origin", "main");
  return { repo, head: git(repo, "rev-parse", "HEAD") };
}

function fixture(t: { after: (fn: () => unknown) => void }, globalLimit = 16, projectLimit = 2) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-inert-queue-")));
  const store = new Store(join(root, "queue.sqlite"));
  const adapter: Adapter = fakeAdapter({
    catalog: async () => ({ providers: [] }),
    validate: async (task) => task.planningCommit,
    createWorkspace: async (task) => ({ id: `ws-${task.id}`, directory: root }),
    verifyWorkspace: async (task) => task.branch,
    createAgent: createTaskAgent,
    observe: async (id) => ({
      id,
      workspaceId: `ws-${id.slice(6)}`,
      status: "running",
      active: true,
      permissions: false,
      error: "",
    }),
    archiveTaskWorkspace: async () => true,
    findOpenBranchPr: async () => [],
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [profile];
  engine.identifyOriginHost = async () => "host";
  store.setMeta("pool", [
    { profileId: profile.id, enabled: true, group: "test", weight: "default", scopes: ["general"] },
  ]);
  store.setMeta("paused", false);
  store.setMeta("globalLimit", globalLimit);
  store.setMeta("projectLimit", projectLimit);
  const passes: string[] = [];
  const dispatches: string[] = [];
  const quanta: string[] = [];
  const internals = engine as unknown as {
    dispatchQueued(repo?: string): Promise<void>;
    dispatchTask(id: string, held: boolean): Promise<void>;
    scheduleTaskQuantum(id: string): Promise<void>;
  };
  const dispatchQueued = internals.dispatchQueued.bind(engine);
  internals.dispatchQueued = (repo) => {
    passes.push(repo ?? "*");
    return dispatchQueued(repo);
  };
  const dispatchTask = internals.dispatchTask.bind(engine);
  internals.dispatchTask = (id, held) => {
    dispatches.push(id);
    return dispatchTask(id, held);
  };
  const scheduleTaskQuantum = internals.scheduleTaskQuantum.bind(engine);
  internals.scheduleTaskQuantum = (id) => {
    quanta.push(id);
    return scheduleTaskQuantum(id);
  };
  t.after(async () => {
    await engine.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const insert = (repoPath = "/project-a", extra: Record<string, unknown> = {}, hostId = "host") =>
    store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Task",
        repoPath,
        planningCommit: "a".repeat(40),
        handoffPath: "handoff.md",
        originAgentId: "origin",
        ...extra,
      }),
      hostId,
      "handoff",
      "a".repeat(40),
    );
  /** Let fire-and-forget wakes and their lanes run to rest. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await engine.quiesce();
    }
  };
  return { root, store, engine, insert, settle, passes, dispatches, quanta };
}

/** Fill the project's slots with running work, the shape a live worker leaves. */
function occupy(f: ReturnType<typeof fixture>, count: number, repoPath = "/project-a") {
  return Array.from({ length: count }, () => {
    const task = f.insert(repoPath);
    return f.store.update(task.id, {
      phase: "working",
      workspaceIntent: true,
      workspaceId: `ws-${task.id}`,
      agentIntent: true,
      agentId: `agent-${task.id}`,
      agentActive: true,
      runId: randomUUID(),
      profile,
    });
  });
}

const brief = (head: string, repo: string, title: string) =>
  submissionSchema.parse({
    submissionId: randomUUID(),
    title,
    repoPath: repo,
    planningCommit: head,
    originAgentId: "origin",
    baseBranch: "main",
    brief: { text: `## Outcome\n\n${title}\n`, mediaType: "text/markdown" },
  });

/** The board's own read: the admission snapshot and the external wait, as the board passes them. */
function card(f: ReturnType<typeof fixture>, task: Task) {
  const admission = f.engine.resolution.slotAdmissionReader(
    f.store.admissionCandidates(),
    f.store.pendingRuns(),
    true,
  );
  const context = taskWaitStateContext(f.store, task, null, admission);
  const display = taskWithCurrentWait(f.store, task, context, (candidate) =>
    f.engine.queuedExternalWait(candidate),
  );
  return {
    display,
    summary: summarizeTask(display, false, false, context, [], undefined, "host", f.store.eventsAll(task.id), null, Date.now(), {}),
  };
}

test("fifty submissions with no free slot run no dispatch pass, no quantum and write nothing beyond their rows", { timeout: 60_000 }, async (t) => {
  const f = fixture(t, 16, 1);
  const { repo, head } = repository(f.root);
  occupy(f, 1, repo);
  const outagesBefore = f.store.getMeta(HOST_OUTAGES_META_KEY);
  await f.settle();
  f.passes.length = 0;
  f.dispatches.length = 0;
  f.quanta.length = 0;
  const submitted: Task[] = [];
  const written = new Map<string, string[]>();
  const kindsOf = (id: string) => f.store.eventsAll(id).map((event) => `${event.id}:${event.kind}`);
  for (let i = 0; i < 50; i++) {
    const result = await f.engine.performSubmit(brief(head, repo, `Queued ${i}`), false, undefined, "host");
    submitted.push(f.store.task(result.taskId!));
    written.set(result.taskId!, kindsOf(result.taskId!));
  }
  await f.settle();
  assert.deepEqual(f.passes, [], "no dispatch pass ran");
  assert.deepEqual(f.dispatches, [], "no queued task was visited");
  assert.deepEqual(f.quanta, [], "no task quantum ran");
  for (const before of submitted) {
    const after = f.store.task(before.id);
    assert.equal(after.version, before.version, "the row is not written after submission");
    assert.equal(after.phase, "queued");
    assert.equal(after.resolution.stop, null, "no stop is stored");
    assert.equal(after.resolution.hostWait, null, "no host wait is stored");
    assert.equal(after.reason, before.reason, "no reason churn");
    assert.deepEqual(kindsOf(before.id), written.get(before.id), "no event follows the submission's own");
  }
  assert.deepEqual(f.store.getMeta(HOST_OUTAGES_META_KEY), outagesBefore, "no host state changes");
  // The card still names the wait, worked out when it is read.
  const last = card(f, f.store.task(submitted.at(-1)!.id));
  assert.match(last.display.reason, /^Waiting for a project slot/);
  assert.equal(last.summary.activity?.detail, "Waiting for capacity");
  assert.equal(last.summary.waitState?.state, "waiting_capacity");
});

test("a submission while its pool has a free slot is admitted at once", { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const { repo, head } = repository(f.root);
  const result = await f.engine.performSubmit(brief(head, repo, "Free slot"), false, undefined, "host");
  await f.settle();
  assert.deepEqual(f.passes, [repo], "one repository-scoped admission ran");
  assert.notEqual(f.store.task(result.taskId!).phase, "queued");
});

test("a freed slot admits exactly the next heads in fair order", async (t) => {
  const f = fixture(t, 2, 2);
  const running = occupy(f, 1, "/project-a");
  occupy(f, 1, "/project-b");
  const a1 = f.insert("/project-a");
  const b1 = f.insert("/project-b");
  const a2 = f.insert("/project-a");
  await f.engine.dispatchQueued();
  await f.settle();
  assert.deepEqual([a1, b1, a2].map((task) => f.store.task(task.id).phase), ["queued", "queued", "queued"],
    "the global limit holds every head");
  f.dispatches.length = 0;
  // The project-a worker finishes and gives its slot back.
  f.store.update(running[0].id, { phase: "done", agentActive: false, finishedAt: new Date().toISOString() });
  f.engine.wakeCapacityWaiter(running[0].id);
  await f.settle();
  assert.deepEqual(f.dispatches, [a1.id], "only the oldest fair head was visited");
  assert.notEqual(f.store.task(a1.id).phase, "queued");
  assert.equal(f.store.task(b1.id).phase, "queued");
  assert.equal(f.store.task(a2.id).phase, "queued");
});

test("a prerequisite reaching done admits its dependant", async (t) => {
  const f = fixture(t);
  const parent = occupy(f, 1, "/parent")[0];
  const child = f.insert("/project-a", { dependsOn: [parent.id] });
  await f.engine.dispatchQueued();
  await f.settle();
  assert.equal(f.store.task(child.id).phase, "queued");
  assert.equal(f.store.task(child.id).resolution.stop, null, "the prerequisite wait is not stored");
  assert.match(card(f, f.store.task(child.id)).display.reason, /^Waiting for prerequisites:/);
  f.store.update(parent.id, { phase: "done", agentActive: false, finishedAt: new Date().toISOString() });
  await f.settle();
  assert.notEqual(f.store.task(child.id).phase, "queued", "the release admitted the dependant");
});

test("a host coming online admits its waiting heads; while away they store nothing", async (t) => {
  const f = fixture(t);
  let online = false;
  f.engine.hostIds = () => ["host"];
  f.engine.hostAvailable = () => online;
  const first = f.insert();
  const second = f.insert();
  const versions = [first, second].map((task) => f.store.task(task.id).version);
  // The admitter alone: the sweep's own host-failure walk is Spec 069 batch 2's.
  await f.engine.dispatchQueued();
  await f.settle();
  for (const [index, task] of [first, second].entries()) {
    const current = f.store.task(task.id);
    assert.equal(current.phase, "queued");
    assert.equal(current.version, versions[index], "a head on an away host is not written");
    assert.equal(current.resolution.hostWait, null);
    assert.equal(current.resolution.stop, null);
  }
  assert.deepEqual(f.dispatches, [], "a head whose host is away takes no visit");
  // The card and `next` still say what it waits for, from the host's own state.
  f.engine.hostOutages.observe("host", false);
  const view = card(f, f.store.task(first.id));
  assert.match(view.display.reason, /^Waiting on Paseo host host since \d{4}-/);
  assert.equal(view.display.resolution.stop?.reason, "host_unavailable");
  assert.equal(view.summary.activity?.detail, "Waiting on the host");
  const next = ownerTaskNext({
    ...collectOwnerVerbFacts(f.store, f.store.task(first.id)),
    waitTask: view.display,
  });
  assert.equal(next.stop?.reason, "host_unavailable");
  // The host returns: the next admission starts both heads.
  online = true;
  await f.engine.sweepOnce();
  await f.settle();
  assert.notEqual(f.store.task(first.id).phase, "queued");
  assert.notEqual(f.store.task(second.id).phase, "queued");
});

test("a host wait an older pass stored on a queued row neither hides it nor survives admission", async (t) => {
  const f = fixture(t);
  const task = f.insert();
  // The shape the retired queued host-wait path stored.
  f.engine.hostOutages.observe("host", false, "2026-11-22T17:55:18.000Z");
  const stored = f.store.task(task.id);
  f.engine.resolution.update(stored, { hostWait: { hostId: "host", since: "2026-11-22T17:55:18.000Z" } }, {}, "host_outage_wait");
  f.engine.resolution.recordStop(f.store.task(task.id), "host_unavailable", "Waiting on Paseo host host since 2026-11-22T17:55:18.000Z");
  f.engine.hostOutages.observe("host", true);
  const view = card(f, f.store.task(task.id));
  assert.equal(view.display.resolution.stop, null, "the card does not believe the stale stop");
  assert.equal(view.display.resolution.hostWait, null);
  await f.engine.dispatchQueued();
  await f.settle();
  const admitted = f.store.task(task.id);
  assert.notEqual(admitted.phase, "queued");
  assert.equal(admitted.resolution.hostWait, null);
  assert.notEqual(admitted.resolution.stop?.reason, "host_unavailable");
});

test("an in-flight request ahead keeps the queued head waiting, and its card counts it at read time", async (t) => {
  const f = fixture(t, 2, 2);
  occupy(f, 1, "/project-a");
  const parked = f.insert("/project-a");
  f.store.update(parked.id, {
    phase: "changes_requested",
    workspaceIntent: true,
    workspaceId: `ws-${parked.id}`,
    agentIntent: true,
    agentId: `agent-${parked.id}`,
    agentActive: false,
    profile,
  });
  const queued = f.insert("/project-a");
  const version = f.store.task(queued.id).version;
  await f.engine.dispatchQueued();
  await f.settle();
  assert.equal(f.store.task(queued.id).phase, "queued");
  assert.equal(f.store.task(queued.id).version, version, "the waiting head is not written");
  const view = card(f, f.store.task(queued.id));
  assert.match(view.display.reason, /waiting behind 1 in-flight/);
  assert.equal(view.summary.activity?.detail, "Waiting for a project slot · 1 ahead");
});
