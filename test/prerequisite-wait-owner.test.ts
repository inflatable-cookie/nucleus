import { observeIdle } from './support/fakes';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import { submissionSchema, summarizeTask, taskDetailSchema, taskSummarySchema, taskDetailView, type Profile, type Task } from "../shared/contracts";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
import { createUiSnapshotFactsCache } from "../core/telemetry/ui-snapshot";
import { createTaskDetailCache } from "../core/telemetry/task-detail";
import { taskWaitStateContext } from "../core/recovery/wait-context";
import {
  PREREQUISITE_DEPENDENCY_ACTION, PREREQUISITE_WAIT_PREFIX, WAIT_OWNER_LIMIT, deriveWaitState, waitStateViewSchema,
} from "../shared/wait-state";
import { QueueService } from "../service/transport/server";
import { ServiceClient } from "../shared/service/client";
import { readServiceInfo } from "../service/transport/identity";
import { git } from "../core/git/index";

/**
 * Queue #486: a legitimate 13-dependency final-gate task joined every unfinished
 * prerequisite id into `waitState.owner`, which is bounded at 240 characters. The
 * durable wait projection then refused every board, detail and health publication.
 * The wait owner is now one bounded line; the dependency list, its identities and
 * the engine's gate are untouched.
 */

/** Prerequisite task ids in the shape `Store.dependencyWait` writes before its status. */
const prerequisiteIds = (count: number) => Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
/** The reason `Store.dependencyWait` writes for a fan-in of unfinished prerequisites. */
const dependencyWaitReason = (ids: string[]) => `${PREREQUISITE_WAIT_PREFIX} ${ids.map(id => `Prerequisite ${id} (${id}): running`).join("; ")}`;
/** A queued task with no other wait fact, so only the dependency context decides. */
const queuedTask = { phase: "queued", reason: "", holdKind: null, holdOwner: null, originAgentId: null } as const;

/** A bounded owner keeps whole identities plus a `+N more` count; nothing is sliced. */
function boundedOwner(owner: string, candidates: string[]) {
  const entries = owner.split(", ");
  const counted = entries.at(-1)?.match(/^\+(\d+) more$/);
  const kept = counted ? entries.slice(0, -1) : entries;
  return { kept, more: counted ? Number(counted[1]) : 0, whole: kept.every(entry => candidates.includes(entry)) };
}

/** One isolated Queue store whose tasks carry no repository work beyond these fixtures. */
function withStore(run: (store: Store, add: (submissionId: string, title: string, dependsOn?: string[]) => Task) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ns-prerequisite-owner-"));
  const store = new Store(join(dir, "queue.sqlite"));
  try {
    run(store, (submissionId, title, dependsOn = []) => store.insert(submissionSchema.parse({
      submissionId, title, repoPath: "/repo", planningCommit: "a".repeat(40),
      handoffPath: `docs/handoffs/${submissionId}.md`, originAgentId: "origin", dependsOn,
    }), "host", "handoff", "a".repeat(40)));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a large prerequisite fan-in publishes one bounded owner and keeps every prerequisite identity", () => {
  const ids = prerequisiteIds(13);
  const unbounded = ids.join(", ");
  assert.ok(unbounded.length > WAIT_OWNER_LIMIT, "the unbounded prerequisite join is what overran the owner projection");
  assert.equal(
    waitStateViewSchema.safeParse({ state: "waiting_prerequisite", owner: unbounded, nextAction: "Wait for the prerequisite to finish" }).success,
    false,
    "the durable wait projection refuses an owner past its bound, which is the publication failure this bounds",
  );

  const view = deriveWaitState(queuedTask, { dependencyWait: dependencyWaitReason(ids), prerequisiteOwner: unbounded });
  assert.equal(view?.state, "waiting_prerequisite");
  assert.ok(view!.owner.length <= WAIT_OWNER_LIMIT, "the wait owner stays one bounded board line");
  assert.equal(waitStateViewSchema.safeParse(view).success, true, "the bounded view is valid for the durable projection");
  const { kept, more, whole } = boundedOwner(view!.owner, ids);
  assert.equal(whole, true, "the owner never slices a prerequisite identity");
  assert.deepEqual(kept, ids.slice(0, kept.length), "kept prerequisites stay in declaration order");
  assert.equal(kept.length + more, ids.length, "every prerequisite is either named or counted");
  assert.ok(kept.length > 0 && more > 0, "a large fan-in still names leading prerequisites and counts the rest");
  assert.equal(view!.owner === unbounded, false);
});

test("a small prerequisite list keeps its exact owner identity", () => {
  const ids = prerequisiteIds(6);
  for (const count of [1, 2, 3, 6]) {
    const listed = ids.slice(0, count);
    const owner = listed.join(", ");
    assert.ok(owner.length <= WAIT_OWNER_LIMIT);
    const view = deriveWaitState(queuedTask, { dependencyWait: dependencyWaitReason(listed), prerequisiteOwner: owner });
    assert.equal(view?.owner, owner, `a ${count}-prerequisite wait is named in full, as before`);
  }
});

test("a prerequisite that can never finish still names the operator over a large list", () => {
  const ids = prerequisiteIds(13);
  for (const entry of [`${ids[4]}: missing`, `Prerequisite ${ids[4]} (${ids[4]}): cancelled`]) {
    const reason = `${dependencyWaitReason(ids)}; ${entry}`;
    const view = deriveWaitState(queuedTask, { dependencyWait: reason, prerequisiteOwner: ids.join(", ") });
    assert.equal(view?.state, "waiting_prerequisite");
    assert.equal(view?.owner, "operator", "an unclosable prerequisite is the operator's, not a bounded Queue list");
    assert.equal(view?.nextAction, PREREQUISITE_DEPENDENCY_ACTION);
  }
});

test("the real board and detail projections publish a 13-prerequisite fan-in and follow it as prerequisites finish", () => withStore((store, add) => {
  // #1001: the board carries five queued heads per repository, so running prerequisites keep the dependent a head.
  const prerequisites = Array.from({ length: 13 }, (_, index) => add(`fan-in-${index}`, `Prerequisite ${index}`));
  for (const prerequisite of prerequisites) store.update(prerequisite.id, { phase: "working" });
  const dependent = add("final-gate", "Final gate", prerequisites.map(task => task.id));
  const ids = prerequisites.map(task => task.id);

  // The production read boundary joins every unfinished prerequisite id; that raw
  // string is exactly what the durable wait projection used to refuse.
  const context = taskWaitStateContext(store, dependent, null);
  assert.ok((context.prerequisiteOwner ?? "").length > WAIT_OWNER_LIMIT);
  // The parent projection, reproduced from these real store facts: `7f20ca1b`
  // forwarded the raw join straight into `waitState.owner`, and both real contracts
  // refused the card. That refusal is why no board, detail or health served.
  const parentWaitState = { state: "waiting_prerequisite" as const, owner: context.prerequisiteOwner!, nextAction: "Wait for the prerequisite to finish" };
  const parentBoard = taskSummarySchema.safeParse({ ...summarizeTask(dependent, false, false, context), waitState: parentWaitState });
  assert.equal(parentBoard.success, false, "the parent board card is refused, exactly as at the reviewed head");
  assert.ok(!parentBoard.success && parentBoard.error.issues.some(issue => issue.path.join(".") === "waitState.owner"), "the refusal names the wait owner");
  assert.equal(
    taskDetailSchema.safeParse({ ...taskDetailView(dependent, context), waitState: parentWaitState }).success,
    false,
    "the parent detail projection is refused by the same bound",
  );

  const board = createUiSnapshotFactsCache(store)();
  const card = board.summaries.find(task => task.id === dependent.id)!;
  assert.equal(card.waitState?.state, "waiting_prerequisite");
  assert.ok(card.waitState!.owner.length <= WAIT_OWNER_LIMIT);
  assert.deepEqual(card.dependsOn, dependent.dependsOn, "the board keeps all 13 prerequisite ids");
  assert.equal(card.dependsOn.length, 13);

  const detail = taskDetailView(store.task(dependent.id), taskWaitStateContext(store, store.task(dependent.id), null));
  assert.deepEqual(detail.dependsOn, dependent.dependsOn, "detail keeps all 13 prerequisite ids");
  assert.equal(detail.waitState?.state, "waiting_prerequisite");
  assert.ok(detail.waitState!.owner.length <= WAIT_OWNER_LIMIT);
  const reason = store.dependencyWait(dependent);
  for (const id of ids) assert.ok(reason.includes(id), "the durable dependency-wait reason keeps every identity");

  // Occupant identities stay in task detail; the board keeps only a short summary.
  for (const finished of prerequisites.slice(0, 10)) store.update(finished.id, { phase: "done" });
  const remaining = createUiSnapshotFactsCache(store)().summaries.find(task => task.id === dependent.id)!;
  assert.equal(remaining.dependsOn.length, 13, "finishing prerequisites never rewrites the dependency list");
  assert.equal(remaining.waitState?.state, "waiting_prerequisite");
  const unfinished = dependent.dependsOn.filter(id => prerequisites.slice(10).some(task => task.id === id));
  assert.equal(unfinished.length, 3);
  assert.equal(remaining.waitState?.owner, "prerequisites", "the board does not repeat the occupant list");
  const remainingDetail = taskDetailView(store.task(dependent.id), taskWaitStateContext(store, store.task(dependent.id), null));
  assert.equal(remainingDetail.waitState?.owner, unfinished.join(", "), "task detail keeps the exact unfinished owners");

  for (const finished of prerequisites.slice(10)) store.update(finished.id, { phase: "done" });
  const released = createUiSnapshotFactsCache(store)().summaries.find(task => task.id === dependent.id)!;
  assert.equal(released.waitState, undefined, "the wait clears once every prerequisite is done");
  assert.equal(released.dependsOn.length, 13, "the finished dependency list stays on the task");
  assert.deepEqual(taskDetailView(store.task(dependent.id), taskWaitStateContext(store, store.task(dependent.id), null)).dependsOn, dependent.dependsOn);
}));

test("a retained prerequisite wait on a large fan-in keeps its reason in detail and a bounded owner on the board", () => withStore((store, add) => {
  const prerequisites = Array.from({ length: 13 }, (_, index) => add(`retained-${index}`, `Retained prerequisite ${index}`));
  const dispatched = add("retained-dependent", "Retained dependent");
  store.update(dispatched.id, { phase: "working", agentId: "agent", runId: "run" });
  const retainedReason = "Wait for the listed source capture";
  const waited = store.setPrerequisiteWait(store.task(dispatched.id), prerequisites.map(task => task.id), retainedReason);

  const card = createUiSnapshotFactsCache(store)().summaries.find(task => task.id === dispatched.id)!;
  assert.equal(card.waitState?.state, "waiting_prerequisite");
  assert.ok(card.waitState!.owner.length <= WAIT_OWNER_LIMIT, "the retained wait owner is bounded too");
  assert.equal("reason" in card.waitState!, false, "the compact board still omits the free-text reason");
  assert.deepEqual(card.dependsOn, waited.dependsOn);

  const detail = taskDetailView(store.task(dispatched.id), taskWaitStateContext(store, store.task(dispatched.id), null));
  assert.equal(detail.waitState?.state, "waiting_prerequisite");
  assert.ok(detail.waitState!.owner.length <= WAIT_OWNER_LIMIT);
  assert.equal(detail.waitState?.reason, retainedReason, "detail keeps the retained wait's own reason");
  assert.equal(detail.prerequisiteWait?.waitsFor.length, 13, "the durable retained wait keeps every prerequisite id");
}));

test("an unclosable prerequisite is the operator's wait over a large fan-in, and the supported maximum stays bounded", () => withStore((store, add) => {
  // Spec 013/043: only `done` satisfies a prerequisite. A cancelled one can never finish.
  const prerequisites = Array.from({ length: 13 }, (_, index) => add(`unclosable-${index}`, `Unclosable prerequisite ${index}`));
  for (const prerequisite of prerequisites) store.update(prerequisite.id, { phase: "working" });
  const dependent = add("unclosable-dependent", "Unclosable dependent", prerequisites.map(task => task.id));
  store.update(prerequisites[4]!.id, { phase: "cancelled" });
  const card = createUiSnapshotFactsCache(store)().summaries.find(task => task.id === dependent.id)!;
  assert.equal(card.waitState?.state, "waiting_prerequisite");
  assert.equal(card.waitState?.owner, "operator");
  assert.equal(card.waitState?.nextAction, "Correct the prerequisite list");
  assert.equal(card.dependsOn.length, 13, "the correction is the operator's; the dependency list is never reduced");

  // A prerequisite whose task row is gone reads as `missing` from the store itself.
  const missing = store.dependencyWait({ dependsOn: [prerequisiteIds(20)[19]!] });
  assert.match(missing, /: missing$/);
  const missingView = deriveWaitState(queuedTask, { dependencyWait: missing, prerequisiteOwner: prerequisiteIds(20)[19] });
  assert.equal(missingView?.owner, "operator");

  // `dependencyIdsSchema` accepts up to 100 prerequisites; that maximum stays bounded.
  const most = Array.from({ length: 100 }, (_, index) => add(`maximum-${index}`, `Maximum prerequisite ${index}`));
  for (const prerequisite of most) store.update(prerequisite.id, { phase: "working" });
  const maximum = add("maximum-dependent", "Maximum dependent", most.map(task => task.id));
  assert.equal(maximum.dependsOn.length, 100);
  const maximumCard = createUiSnapshotFactsCache(store)().summaries.find(task => task.id === maximum.id)!;
  assert.equal(maximumCard.waitState?.state, "waiting_prerequisite");
  assert.ok(maximumCard.waitState!.owner.length <= WAIT_OWNER_LIMIT);
  assert.equal(maximumCard.waitState!.owner, "prerequisites");
  assert.equal(maximumCard.dependsOn.length, 100);
}));

test("the real publication still refuses an over-bound wait owner instead of truncating it or serving a stale board", () => withStore((store, add) => {
  const held = add("over-bound-hold", "Over-bound merge hold");
  // A merge-hold owner is the one other derived owner a valid record can carry past
  // the bound; it stands in for the parent's over-bound value so the refusal is
  // reproduced by the real projection rather than by a hand-built schema parse.
  const holds = { merge: { owner: "o".repeat(300), reason: "Reproduce the parent refusal", at: new Date().toISOString(), generation: 1, until: null } };
  store.update(held.id, { phase: "verifying", holds });
  // The parent board publication failed at exactly this point: `summarizeTask` parsed
  // the card and `waitState.owner` (300 > 240) was refused. The real projection still
  // refuses it — the fix bounds the prerequisite derivation, it never swallows faults.
  assert.throws(() => createUiSnapshotFactsCache(store)(), (error: unknown) =>
    error instanceof ZodError && error.issues.some(issue => issue.path.join(".") === "waitState.owner" && issue.code === "too_big"));
  // Clearing the over-bound fact publishes again: nothing was dropped or truncated.
  store.update(held.id, { holds: {} });
  const card = createUiSnapshotFactsCache(store)().summaries.find(task => task.id === held.id)!;
  assert.equal(card.waitState, undefined, "a released hold leaves no wait instead of a shortened one");
}));

test("the engine refuses an otherwise dispatchable dependent while its fan-in is unfinished, then dispatches it", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nsq-prerequisite-gate-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const profile: Profile = { id: "fixture-worker", name: "Fixture worker", provider: "test", model: "test", notes: "", available: true, problem: "", supportedThinking: [] };
  const calls = { workspaces: 0, agents: 0 };
  const adapter = {
    profiles: async () => [profile],
    validate: async (task: Task) => task.planningCommit,
    createWorkspace: async (task: Task) => { calls.workspaces += 1; return { id: `ws-${task.id}`, directory: join(dir, `ws-${task.id}`) }; },
    findWorkspaces: async () => [],
    verifyWorkspace: async (task: Task) => task.branch,
    createAgent: async (task: Task) => { calls.agents += 1; return { id: `agent-${task.id}`, workspaceId: task.workspaceId }; },
    findAgents: async () => [],
    observe: observeIdle("ws"),
    archiveAgent: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  try {
    engine.profiles = [profile];
    store.setMeta("pool", [{ profileId: profile.id, enabled: true, group: "test", weight: 1, scopes: ["general"] }]);
    store.setMeta("paused", false);
    const add = (submissionId: string, title: string, dependsOn: string[] = []) => store.insert(submissionSchema.parse({
      submissionId, title, repoPath: "/repo", planningCommit: "a".repeat(40),
      handoffPath: `docs/handoffs/${submissionId}.md`, originAgentId: "origin", dependsOn,
    }), "host", "handoff", "a".repeat(40));
    const prerequisites = Array.from({ length: 13 }, (_, index) => add(`gate-${index}`, `Gate prerequisite ${index}`));
    const dependent = add("gate-dependent", "Gate dependent", prerequisites.map(task => task.id));

    // One reconciliation pass over an eligible pool: the prerequisites dispatch, the
    // dependent reaches its dispatch attempt and stops at the prerequisite gate.
    await engine.wake();
    assert.equal(store.task(prerequisites[0]!.id).workspaceIntent, true, "the fixture pool is genuinely dispatchable");
    const refused = store.task(dependent.id);
    assert.equal(refused.phase, "queued", "an eligible dependent is never dispatched while a prerequisite is unfinished");
    assert.equal(refused.workspaceIntent, false, "the engine created no workspace for it");
    assert.equal(refused.workspaceId, null);
    assert.equal(refused.agentId, null, "the engine launched no worker for it");
    // #1001: the wait is derived on read, and a dependent past the queue heads is in detail and the queued page.
    const refusedDetail = createTaskDetailCache(store)(dependent.id).task;
    assert.match(refusedDetail.reason, /^Waiting for prerequisites:/, "the engine's own refusal names the dependency gate");
    assert.equal(refused.dependsOn.length, 13, "the refusal keeps every prerequisite id");
    assert.equal(refusedDetail.waitState?.state, "waiting_prerequisite");
    assert.ok(refusedDetail.waitState!.owner.length <= WAIT_OWNER_LIMIT);

    // The same dependent, same engine and same eligibility, with the fan-in done.
    for (const prerequisite of prerequisites) store.update(prerequisite.id, { phase: "done" });
    const workspacesBefore = calls.workspaces, agentsBefore = calls.agents;
    await engine.wake();
    const dispatched = store.task(dependent.id);
    assert.equal(dispatched.workspaceIntent, true, "the dependency gate was the only thing refusing it");
    assert.ok(dispatched.agentId, "the engine dispatched it once every prerequisite was done");
    assert.equal(calls.workspaces, workspacesBefore + 1);
    assert.equal(calls.agents, agentsBefore + 1);
    assert.equal(dispatched.dependsOn.length, 13, "dispatch leaves the finished dependency list intact");
    assert.notEqual(createUiSnapshotFactsCache(store)().summaries.find(task => task.id === dependent.id)!.waitState?.state, "waiting_prerequisite");
  } finally {
    await engine.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the public service publishes a 13-prerequisite fan-in board, detail and health without dispatching it", { timeout: 120_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nsq")));
  // Keep the service socket below macOS's local path bound with the assigned TMPDIR.
  const dataDir = join(dir, "q");
  // A real pushed repository: `queue.submit` reads the tracked handoff, so the fixture
  // creates the prerequisites through the public submission path a consumer uses.
  const repoPath = join(dir, "repo");
  await git(dir, "init", "--bare", join(dir, "origin.git"));
  await git(dir, "clone", join(dir, "origin.git"), repoPath);
  await git(repoPath, "checkout", "-b", "main");
  await git(repoPath, "config", "user.name", "Queue test");
  await git(repoPath, "config", "user.email", "queue@example.invalid");
  mkdirSync(join(repoPath, "docs/handoffs"), { recursive: true });
  writeFileSync(join(repoPath, "docs/handoffs/fan-in.md"), "Fan-in fixture handoff\n");
  await git(repoPath, "add", ".");
  await git(repoPath, "commit", "-m", "Fan-in fixture");
  await git(repoPath, "push", "origin", "main");
  const planningCommit = await git(repoPath, "rev-parse", "HEAD");
  const service = new QueueService({ owner: { dataDir }, fixture: "fake", debug: true });
  await service.start();
  const info = readServiceInfo(dataDir);
  assert.ok(info, "the service publishes its owner-only identity file");
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  try {
    const submit = (submissionId: string, title: string, dependsOn: string[] = []) => client.request("queue.submit", {
      submissionId, title, repoPath, planningCommit, complexity: "low",
      handoffPath: "docs/handoffs/fan-in.md", originAgentId: "origin", baseBranch: "main", dependsOn,
    }) as Promise<{ id: string; dependsOn: string[]; phase: string }>;
    const prerequisites: Array<{ id: string }> = [];
    // Unpaused, so the service engine really considers each queued task rather than
    // leaving it at the initial dispatch wait.
    await client.request("queue.control", { paused: false });
    for (let index = 0; index < 13; index += 1) prerequisites.push(await submit(`fan-in-${index}`, `Fan-in prerequisite ${index}`));
    const dependent = await submit("final-gate", "Final gate", prerequisites.map(task => task.id));

    // One real engine pass over the service: the dependent reaches its dispatch attempt
    // and is refused by the prerequisite gate itself, before any route selection.
    await service.debug({ target: "engine", method: "wake" });

    // #1001: the board carries five queued heads; its count and the queued page account for the rest.
    const board = await client.request("queue.ui-snapshot", {}) as {
      revision: number;
      queuedCounts: Array<{ repoPath: string; count: number }>;
      tasks: Array<{ id: string; phase: string; dependsOn: string[]; waitState?: { state: string; owner: string; nextAction: string } }>;
    };
    assert.equal(board.queuedCounts.find(item => item.repoPath === repoPath)?.count, 14);
    const page = await client.request("queue.queued-page", { repoPath, offset: 0, limit: 100 }) as { tasks: typeof board.tasks; nextOffset: number | null };
    assert.equal(page.nextOffset, null);
    const card = page.tasks.find(task => task.id === dependent.id)!;
    assert.equal(card.phase, "queued");
    assert.deepEqual(card.dependsOn, dependent.dependsOn);
    assert.equal(card.dependsOn.length, 13);
    assert.equal(card.waitState?.state, "waiting_prerequisite");
    assert.ok(card.waitState!.owner.length <= WAIT_OWNER_LIMIT);
    assert.ok(card.waitState!.owner.length > 0);

    const health = await client.request("service.health", {}) as { service: string; ready: boolean; engineError: string };
    assert.equal(health.service, "nucleus");
    assert.equal(health.ready, true, "publication succeeded instead of failing closed");
    assert.equal(health.engineError, "");

    const detail = await client.request("queue.detail", { taskId: dependent.id }) as {
      task: { phase: string; reason: string; dependsOn: string[]; agentId: string | null; agentIntent: boolean; workspaceIntent: boolean; workspaceId: string | null; waitState?: { state: string; owner: string } };
    };
    assert.equal(detail.task.phase, "queued");
    assert.match(detail.task.reason, /^Waiting for prerequisites:/, "the engine's own dispatch attempt stopped at the dependency gate");
    assert.deepEqual(detail.task.dependsOn, dependent.dependsOn, "detail keeps all 13 prerequisite ids");
    assert.equal(detail.task.waitState?.state, "waiting_prerequisite");
    assert.ok(detail.task.waitState!.owner.length <= WAIT_OWNER_LIMIT);
    assert.equal(detail.task.workspaceIntent, false, "the engine created no workspace for a refused dependent");
    assert.equal(detail.task.workspaceId, null);
    assert.equal(detail.task.agentId, null, "the engine never dispatched a dependent with unfinished prerequisites");
    assert.equal(detail.task.agentIntent, false);

    // The gate follows the real durable facts as the fan-in settles.
    for (const prerequisite of prerequisites.slice(1)) await service.debug({ target: "store", method: "update", args: [prerequisite.id, { phase: "done" }] });
    const waiting = await client.request("queue.detail", { taskId: dependent.id }) as {
      task: { phase: string; dependsOn: string[]; waitState?: { state: string; owner: string } };
    };
    assert.equal(waiting.task.dependsOn.length, 13, "finished prerequisites stay in the dependency list");
    assert.equal(waiting.task.waitState?.state, "waiting_prerequisite");
    assert.equal(waiting.task.waitState?.owner, prerequisites[0]!.id, "the owner names the one unfinished prerequisite");

    await service.debug({ target: "store", method: "update", args: [prerequisites[0]!.id, { phase: "done" }] });
    const released = await client.request("queue.detail", { taskId: dependent.id }) as {
      task: { phase: string; dependsOn: string[]; waitState?: unknown };
    };
    assert.equal(released.task.dependsOn.length, 13);
    assert.equal(released.task.waitState, undefined, "the dependent leaves prerequisite wait once every prerequisite is done");

    // The parent's recorded symptom, reproduced through the real service rather than a
    // hand-built parse: an over-bound wait owner still withholds health and the board
    // instead of publishing a shortened or stale projection.
    const overBound = await submit("over-bound-hold", "Over-bound merge hold");
    const holds = { merge: { owner: "o".repeat(300), reason: "Reproduce the parent refusal", at: new Date().toISOString(), generation: 1, until: null } };
    await assert.rejects(
      () => service.debug({ target: "store", method: "update", args: [overBound.id, { phase: "verifying", holds }] }),
      /did not publish/,
      "the write commits and its publication reports the uncertainty, exactly as Spec 013 says",
    );
    await assert.rejects(() => client.request("queue.ui-snapshot", {}), /projection is not publishing.*withheld/s, "the board fails closed");
    await assert.rejects(() => client.request("service.health", {}), /projection is not publishing.*withheld/s, "health fails closed");
    await assert.rejects(() => client.request("queue.detail", { taskId: overBound.id }), /owner/i, "the over-bound task's own detail is refused, never shortened");

    // A successful fresh publication is the only thing that clears the fault.
    await service.debug({ target: "store", method: "update", args: [overBound.id, { holds: {} }] });
    const recovered = await client.request("queue.ui-snapshot", {}) as { tasks: Array<{ id: string; waitState?: { owner: string } }> };
    assert.ok(recovered.tasks.some(task => task.id === dependent.id), "the fan-in task publishes again once the fault clears");
    assert.equal((await client.request("service.health", {}))! !== null, true);
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
