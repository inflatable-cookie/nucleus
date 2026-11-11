import { fakeAdapter, observeIdle } from './support/fakes';
import { queuedReason, taskWaitStateContext } from '../core/recovery/wait-context';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CURRENT_SCHEMA, Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { DISPATCH_HELD_REASON, dispatchBlocked } from "../core/dispatch/capacity";
import { holdPatch } from "../core/merge/merge-hold";
import { MERGE_HELD_REASON } from "../core/resolution";
import { DISPATCH_WAIT_REASON, taskStopRecord } from "../shared/task-stop";
import {
  deriveWaitState, CAPACITY_WAIT_PREFIX,
} from "../shared/wait-state";
import {
  submissionSchema, summarizeTask, taskHoldKind, holdsOf, sourcePromotionInputSchema,
  taskControlInputSchema, taskDetailView, taskNextSchema, taskStopKind, currentTaskStop, incidentSchema, type Profile, type Task,
  holdOwnerOf, TASK_OWNER_HOLD,
} from "../shared/contracts";
import type { Adapter } from "../core/host";

const head = "a".repeat(40);
const profile: Profile = { id: "worker", name: "Worker", provider: "test", model: "test", notes: "", available: true, problem: "", supportedThinking: [] };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-holds-"));
  const path = join(dir, "queue.sqlite");
  const store = new Store(path);
  const adapter: Adapter = fakeAdapter({
    profiles: async () => [profile], validate: async t => t.planningCommit,
    createWorkspace: async t => ({ id: `ws-${t.id}`, directory: "/fixture" }),
     verifyWorkspace: async t => t.branch,
    createAgent: async () => ({ id: "agent", workspaceId: "ws" }),
    observe: observeIdle("ws"),
    verifyPr: async () => ({ url: "https://github.com/example/repo/pull/1", head: "abc" }),
  });
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  function add(title = "Task", extra: Record<string, unknown> = {}) {
    return store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title, repoPath: "/repo", planningCommit: head, handoffPath: "handoff.md",
      originAgentId: "origin", ...extra,
    }), "host", "handoff", head);
  }
  return { dir, path, store, engine, add, close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("papercut 608903b6: a brief merge hold still allows a dispatch hold, and releasing dispatch leaves the merge fence", async () => {
  const f = fixture(); try {
    const submitted = f.add("Brief merge", { mergeHold: true, mergeHoldReason: "External receipt pending" });
    assert.equal(submitted.mergeHold, true);
    assert.ok(holdsOf(submitted).merge);
    assert.equal(holdsOf(submitted).dispatch, undefined);
    assert.equal(dispatchBlocked(submitted), false, "a brief merge hold never fences dispatch");
    const held = await f.engine.performTaskControl({
      taskId: submitted.id, version: submitted.version, action: "hold", reason: "Wait for staging",
    }) as Task;
    assert.ok(holdsOf(held).dispatch, "hold on a queued merge-held task places a dispatch fence");
    assert.ok(holdsOf(held).merge, "the brief merge hold stays");
    assert.equal(dispatchBlocked(held), true);
    assert.equal(held.mergeHold, true);
    await assert.rejects(
      f.engine.performTaskControl({ taskId: held.id, version: held.version, action: "hold", reason: "again" }),
      /already under a dispatch hold; use keep_hold to renew the dispatch hold/,
    );
    const released = await f.engine.performTaskControl({
      taskId: held.id, version: held.version, action: "release", kind: "dispatch",
    }) as Task;
    assert.equal(holdsOf(released).dispatch, undefined);
    assert.ok(holdsOf(released).merge);
    assert.equal(dispatchBlocked(released), false);
    assert.equal(released.mergeHold, true);
  } finally { await f.close(); }
});

test("papercut 35986a37: promote-task accepts an optional dispatch hold applied in the insert", async () => {
  const id = randomUUID();
  assert.equal(sourcePromotionInputSchema.safeParse({ id: "lead", hold: { reason: "Wait for staging" } }).success, true);
  assert.equal(sourcePromotionInputSchema.safeParse({ id: "lead", hold: { reason: "Until the target", until: id } }).success, true);
  assert.equal(sourcePromotionInputSchema.safeParse({ id: "lead", hold: { reason: "Until", until: "soon" } }).success, false);
  const f = fixture(); try {
    const initial = holdPatch({
      held: false, phase: "queued", mergeHold: false, holdOwner: null, holdReason: null, holdAt: null,
      holdGeneration: 0, holdUntil: null, holdBlocking: null, originAgentId: "operator", holds: {},
    }, "dispatch", "operator", "Wait for staging");
    const task = f.store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: "Promoted held", repoPath: "/repo", planningCommit: head,
      handoffPath: "handoff.md", originAgentId: "origin",
    }), "host", "handoff", head, initial);
    assert.equal(dispatchBlocked(task), true);
    assert.equal(taskHoldKind(task), "dispatch");
    assert.equal(holdsOf(task).dispatch?.reason, "Wait for staging");
    assert.equal(holdsOf(task).merge, undefined);
    assert.equal(task.held, true);
    assert.equal(task.mergeHold, false);
  } finally { await f.close(); }
});

test("papercut da6e1f89: keep_hold refreshes the reason of a queued dispatch hold", async () => {
  const f = fixture(); try {
    const queued = f.add();
    const held = await f.engine.performTaskControl({
      taskId: queued.id, version: queued.version, action: "hold", reason: "Waiting for design",
    }) as Task;
    assert.equal(holdsOf(held).dispatch?.reason, "Waiting for design");
    const kept = await f.engine.performTaskControl({
      taskId: held.id, version: held.version, action: "keep_hold", reason: "Design still open",
    }) as Task;
    assert.equal(holdsOf(kept).dispatch?.reason, "Design still open");
    assert.ok((holdsOf(kept).dispatch?.generation ?? 0) > (holdsOf(held).dispatch?.generation ?? 0));
    assert.equal(dispatchBlocked(kept), true);
    const mergeOnly = f.add("Merge only", { mergeHold: true, mergeHoldReason: "Receipt pending" });
    await assert.rejects(
      f.engine.performTaskControl({ taskId: mergeOnly.id, version: mergeOnly.version, action: "keep_hold", reason: "still" }),
      /Keep applies only to a dispatch hold; pass kind: "merge" to renew the merge hold, or use hold to place a dispatch hold/,
    );
    const refreshed = await f.engine.performTaskControl({
      taskId: mergeOnly.id, version: mergeOnly.version, action: "keep_hold", kind: "merge", reason: "Receipt still pending",
    }) as Task;
    assert.equal(holdsOf(refreshed).merge?.reason, "Receipt still pending");
    assert.equal(dispatchBlocked(refreshed), false);
  } finally { await f.close(); }
});

test("papercut 1918d67c: a merge-held task waiting for a slot shows the capacity wait", () => {
  const slot = `${CAPACITY_WAIT_PREFIX} Project concurrent task-slot limit reached`;
  const queuedMerge = deriveWaitState(
    { phase: "queued", reason: slot, holdKind: "merge", holdOwner: "origin", originAgentId: "origin", mergeHeld: true },
    { slotAdmissionReason: slot },
  );
  assert.equal(queuedMerge?.state, "waiting_capacity");
  const verifyingMerge = deriveWaitState(
    { phase: "verifying", reason: slot, holdKind: "merge", holdOwner: "origin", originAgentId: "origin", mergeHeld: true },
    { slotAdmissionReason: slot },
  );
  assert.equal(verifyingMerge?.state, "waiting_capacity", "capacity still outranks merge_hold at verifying");
  const ready = deriveWaitState(
    { phase: "verifying", reason: "", holdKind: "merge", holdOwner: "origin", originAgentId: "origin", mergeHeld: true },
  );
  assert.equal(ready?.state, "merge_hold");
});

test("schema 50 upgrade preserves independent and single holds", async () => {
  const f = fixture(); let upgraded: Store | undefined;
  try {
    const queued = f.add("Queued hold");
    const dispatched = f.add("Dispatched hold");
    const already = f.add("Already dual");
    const queuedUntil = { kind: "task" as const, taskId: dispatched.id };
    f.store.update(queued.id, holdPatch(f.store.task(queued.id), "dispatch", "operator", "Waiting for design", queuedUntil));
    f.store.update(dispatched.id, { phase: "blocked", ...holdPatch(f.store.task(dispatched.id), "merge", TASK_OWNER_HOLD, "not recorded") });
    const dual = holdPatch(f.store.task(already.id), "dispatch", "operator", "Stage first");
    const both = holdPatch({ ...f.store.task(already.id), ...dual }, "merge", "origin", "Receipt pending");
    f.store.update(already.id, both);
    const dualBefore = f.store.task(already.id);
    f.store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
    f.store.setMeta("schema", 50);
    upgraded = new Store(f.path);
    assert.equal(upgraded.getMeta("schema"), CURRENT_SCHEMA);
    const migratedQueued = upgraded.task(queued.id);
    assert.ok(migratedQueued.holds.dispatch);
    assert.equal(migratedQueued.holds.merge, undefined);
    assert.equal(migratedQueued.mergeHold, false);
    assert.equal(dispatchBlocked(migratedQueued), true);
    assert.equal(migratedQueued.holdReason, "Waiting for design");
    assert.deepEqual(migratedQueued.holds.dispatch?.until, queuedUntil);
    assert.deepEqual(migratedQueued.holdUntil, queuedUntil);
    const migratedDispatched = upgraded.task(dispatched.id);
    assert.ok(migratedDispatched.holds.merge);
    assert.equal(migratedDispatched.holds.dispatch, undefined);
    assert.equal(migratedDispatched.mergeHold, true);
    assert.equal(dispatchBlocked(migratedDispatched), false);
    assert.equal(migratedDispatched.holdOwner, TASK_OWNER_HOLD, "schema 50 marks the origin-owned hold as owner-placed");
    assert.equal(holdOwnerOf(migratedDispatched, migratedDispatched.holdOwner), "origin", "and it still answers to the task owner");
    assert.equal(migratedDispatched.holdReason, "not recorded");
    const migratedDual = upgraded.task(already.id);
    assert.ok(migratedDual.holds.dispatch);
    assert.ok(migratedDual.holds.merge);
    assert.equal(migratedDual.holds.dispatch?.reason, dualBefore.holds.dispatch?.reason);
    assert.equal(migratedDual.holds.merge?.reason, dualBefore.holds.merge?.reason);
  } finally { upgraded?.close(); await f.close(); }
});

test("a single ordinary hold still blocks dispatch, and a dispatched hold still does not", async () => {
  const f = fixture(); try {
    const queued = f.add();
    const held = await f.engine.performTaskControl({
      taskId: queued.id, version: queued.version, action: "hold", reason: "Waiting for design",
    }) as Task;
    assert.equal(taskHoldKind(held), "dispatch");
    assert.equal(dispatchBlocked(held), true);
    assert.equal(summarizeTask(held).holdKind, "dispatch");
    assert.ok(summarizeTask(held).holds?.dispatch);
    const dispatched = f.add("Dispatched");
    f.store.update(dispatched.id, { phase: "awaiting_review" });
    const merge = await f.engine.performTaskControl({
      taskId: dispatched.id, version: f.store.task(dispatched.id).version, action: "hold", reason: "Receipt pending", agentId: "origin",
    }) as Task;
    assert.equal(taskHoldKind(merge), "merge");
    assert.equal(dispatchBlocked(merge), false);
    assert.equal(merge.mergeHold, true);
    const kept = await f.engine.performTaskControl({
      taskId: merge.id, version: merge.version, action: "keep_hold", reason: "Receipt still pending", agentId: "origin",
    }) as Task;
    assert.equal(holdsOf(kept).merge?.reason, "Receipt still pending");
    assert.equal(dispatchBlocked(kept), false);
  } finally { await f.close(); }
});

test("hold, release and keep_hold refusals name the kind and the right control", async () => {
  const f = fixture(); try {
    const queued = f.add();
    await assert.rejects(
      f.engine.performTaskControl({ taskId: queued.id, version: queued.version, action: "release" }),
      /No dispatch hold to release$/,
    );
    await assert.rejects(
      f.engine.performTaskControl({ taskId: queued.id, version: queued.version, action: "keep_hold", reason: "x" }),
      /Keep applies only to a dispatch hold; use hold to place a dispatch hold/,
    );
    const mergeOnly = f.add("Merge", { mergeHold: true, mergeHoldReason: "Receipt" });
    await assert.rejects(
      f.engine.performTaskControl({ taskId: mergeOnly.id, version: mergeOnly.version, action: "release" }),
      /No dispatch hold to release; pass kind: "merge" to release the merge hold/,
    );
    assert.equal(taskControlInputSchema.safeParse({ taskId: "t", version: 1, action: "hold", kind: "dispatch", reason: "r" }).success, true);
    assert.equal(taskControlInputSchema.safeParse({ taskId: "t", version: 1, action: "cancel", kind: "dispatch" }).success, false);
  } finally { await f.close(); }
});

test("tests that set held and mergeHold without holds keep their meaning", async () => {
  const f = fixture(); try {
    const ordinary = f.add("ordinary");
    const merge = f.add("merge");
    const dispatched = f.add("dispatched");
    f.store.update(ordinary.id, { held: true, mergeHold: false, reason: "Waiting for a dispatch slot" });
    f.store.update(merge.id, { held: true, mergeHold: true, holdOwner: "agent-hold", reason: "Waiting for prerequisites" });
    f.store.update(dispatched.id, { phase: "working", held: true, mergeHold: false });
    assert.equal(taskHoldKind(f.store.task(ordinary.id)), "dispatch");
    assert.equal(dispatchBlocked(f.store.task(ordinary.id)), true);
    assert.equal(taskHoldKind(f.store.task(merge.id)), "merge");
    assert.equal(dispatchBlocked(f.store.task(merge.id)), false);
    assert.equal(taskHoldKind(f.store.task(dispatched.id)), "merge");
    assert.equal(dispatchBlocked(f.store.task(dispatched.id)), false);
  } finally { await f.close(); }
});

test("Project-C #089: a hold on a cancelled or merged task is always releasable; renewing it is not (2026-10-19)", async () => {
  const { ownerTaskNext, collectOwnerVerbFacts } = await import("../core/verbs/owner-verbs");
  for (const terminal of ["cancelled", "merged"] as const) {
    const f = fixture();
    try {
      const task = f.add(`Terminal ${terminal}`);
      const held = f.store.update(task.id, { ...holdPatch(task, "dispatch", "operator", "Preserve until reviewed"),
        ...(terminal === "cancelled" ? { phase: "cancelled" as const } : { phase: "done" as const, resolution: { ...task.resolution, mergedCommit: head } }) });
      const verbs = ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(held.id))).verbs;
      const release = verbs.find(verb => verb.verb === "release")!;
      assert.equal(release.available, true, `${terminal}: ${JSON.stringify(release)}`);
      assert.equal(verbs.find(verb => verb.verb === "keep_hold")!.available, false, terminal);
      await assert.rejects(f.engine.performTaskControl({ taskId: held.id, version: f.store.task(held.id).version, action: "keep_hold", kind: "dispatch", reason: "Renew" }), /only before the merge is requested/);
      const released = await f.engine.performTaskControl({ ...(release.args as Record<string, unknown>), taskId: held.id, version: f.store.task(held.id).version } as never);
      assert.equal(dispatchBlocked(released), false, terminal);
    } finally { await f.close(); }
  }
});

// Queue #371: a release retires the hold's own stop in the same write, and a
// held record with no fence left is history at every read boundary.
async function holdReads(f: ReturnType<typeof fixture>, id: string) {
  const { ownerTaskNext, collectOwnerVerbFacts } = await import("../core/verbs/owner-verbs");
  const task = f.store.task(id), runs = f.store.runs(id);
  return {
    task, kind: taskStopKind(task, runs), summary: summarizeTask(task, false, false, {}, runs),
    detail: taskDetailView(task), next: taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(f.store, task))),
  };
}
const recordHeldWait = (f: ReturnType<typeof fixture>, id: string, reason: string) => {
  const task = f.store.task(id);
  return f.store.update(id, { reason, resolution: { ...task.resolution, stop: taskStopRecord("held", reason) } }, "task_waiting", reason);
};

test("queue #371: releasing the last merge fence retires its held stop at once, while paused", async () => {
  const f = fixture(); try {
    f.store.setMeta("paused", true);
    const task = f.add("Merge held");
    f.store.update(task.id, { phase: "verifying", prHead: head, ...holdPatch(task, "merge", "owner-thread", "Owner verifies the format") });
    const waiting = recordHeldWait(f, task.id, MERGE_HELD_REASON);
    assert.equal((await holdReads(f, task.id)).next.stop?.kind, "hold");
    const released = await f.engine.performTaskControl({ taskId: task.id, version: waiting.version, action: "release", kind: "merge" }) as Task;
    assert.equal(released.version, waiting.version + 1, "one write, no intervening quantum");
    assert.equal(released.resolution.stop, null, "the release retires the stop it made obsolete");
    const reads = await holdReads(f, task.id);
    assert.equal(reads.next.version, released.version);
    assert.deepEqual(reads.next.holds, {});
    assert.equal(reads.next.stop, null);
    assert.equal(reads.kind, null);
    assert.equal(reads.summary.stop, undefined);
    assert.equal(reads.summary.stopRecord, undefined);
    assert.equal(reads.detail.resolution.stop, null);
    assert.equal(reads.detail.holdKind, undefined);
    assert.equal(reads.next.verbs.find(verb => verb.verb === "release")?.available ?? false, false);
  } finally { await f.close(); }
});

test("queue #371: releasing the last dispatch fence leaves a queued task waiting for dispatch, not held", async () => {
  const f = fixture(); try {
    f.store.setMeta("paused", true);
    const task = f.add("Dispatch held");
    const held = await f.engine.performTaskControl({ taskId: task.id, version: task.version, action: "hold", reason: "Wait for staging" }) as Task;
    // The dispatch pump's own hold text (engine) on a held queued task.
    f.store.update(held.id, { reason: DISPATCH_HELD_REASON });
    const before = f.store.task(task.id);
    assert.equal((await holdReads(f, task.id)).next.stop?.kind, "hold");
    const released = await f.engine.performTaskControl({ taskId: task.id, version: before.version, action: "release", kind: "dispatch" }) as Task;
    assert.equal(released.version, before.version + 1);
    assert.equal(released.reason, DISPATCH_WAIT_REASON);
    const reads = await holdReads(f, task.id);
    assert.equal(reads.next.stop?.kind, "wait");
    assert.equal(reads.next.stop?.reason, "capacity");
    assert.equal(reads.summary.stop, "wait");
    assert.equal(reads.detail.holdKind, undefined);
  } finally { await f.close(); }
});

test("queue #371: releasing one of two fences keeps the other's owner, generation, reason, date and held stop", async () => {
  for (const releaseKind of ["dispatch", "merge"] as const) {
    const f = fixture(); try {
      const task = f.add(`Dual ${releaseKind}`, { mergeHold: true, mergeHoldReason: "External receipt pending" });
      const dual = await f.engine.performTaskControl({ taskId: task.id, version: task.version, action: "hold", kind: "dispatch", reason: "Wait for staging" }) as Task;
      const waiting = recordHeldWait(f, dual.id, releaseKind === "merge" ? DISPATCH_HELD_REASON : MERGE_HELD_REASON);
      const kept = releaseKind === "dispatch" ? "merge" : "dispatch";
      const fence = holdsOf(waiting)[kept]!;
      const released = await f.engine.performTaskControl({ taskId: task.id, version: waiting.version, action: "release", kind: releaseKind }) as Task;
      assert.deepEqual(holdsOf(released)[kept], fence, `${releaseKind}: the other fence is untouched`);
      assert.deepEqual(released.resolution.stop, waiting.resolution.stop, `${releaseKind}: a fence remains, so its held stop stands`);
      const reads = await holdReads(f, task.id);
      assert.equal(reads.next.stop?.kind, "hold");
      assert.equal(reads.next.stop?.owner, holdOwnerOf(waiting, fence.owner), `${releaseKind}: the stop names the resolved hold owner`);
      assert.equal(reads.next.stop?.since, fence.at);
      assert.equal(reads.next.stop?.detail, fence.reason);
      assert.match(reads.next.stop?.evidence ?? "", new RegExp(`^${kept} hold generation ${fence.generation}`));
      assert.equal(reads.summary.stop, "hold");
      assert.deepEqual(reads.summary.stopRecord, waiting.resolution.stop);
      assert.equal(reads.detail.holdKind, kept);
    } finally { await f.close(); }
  }
});

test("queue #371: a held stop on a merged task goes with its released fence; a wrong-kind release changes nothing", async () => {
  const f = fixture(); try {
    const task = f.add("Merged");
    f.store.update(task.id, { ...holdPatch(task, "merge", "owner-thread", "Owner verifies"), phase: "done", resolution: { ...task.resolution, mergedCommit: head } });
    const waiting = recordHeldWait(f, task.id, MERGE_HELD_REASON);
    await assert.rejects(f.engine.performTaskControl({ taskId: task.id, version: waiting.version, action: "release", kind: "dispatch" }),
      /No dispatch hold to release; pass kind: "merge"/);
    assert.deepEqual(f.store.task(task.id), waiting, "a refused release writes nothing");
    const released = await f.engine.performTaskControl({ taskId: task.id, version: waiting.version, action: "release", kind: "merge" }) as Task;
    assert.equal(released.resolution.stop, null);
    assert.equal(released.phase, "done");
    const reads = await holdReads(f, task.id);
    assert.equal(reads.next.stop, null);
    assert.equal(reads.summary.stopRecord, undefined);
  } finally { await f.close(); }
});

test("queue #371: a stored held stop with no fence left is readable history, unchanged by reads", async () => {
  const f = fixture(); try {
    // The retained Project-A #3685 shape: the release cleared every fence before it
    // retired the stop, so the row carries held=false, holds={} and a held stop.
    const task = f.add("Released before #371");
    f.store.update(task.id, { phase: "verifying", prHead: head, reason: MERGE_HELD_REASON,
      resolution: { ...task.resolution, stop: taskStopRecord("held", MERGE_HELD_REASON) } });
    const stale = f.store.task(task.id);
    assert.equal(stale.held, false);
    assert.deepEqual(holdsOf(stale), {});
    assert.equal(stale.resolution.stop?.reason, "held");
    const reads = await holdReads(f, task.id);
    assert.equal(reads.next.version, stale.version);
    assert.equal(reads.next.stop, null, "a released fence is not a current hold");
    assert.equal(reads.kind, null);
    assert.equal(reads.summary.stop, undefined);
    assert.equal(reads.summary.stopRecord, undefined);
    assert.equal(reads.detail.resolution.stop, null);
    assert.deepEqual(f.store.task(task.id), stale, "reads never repair the row");
    // A stale held record never masks the stop that is actually there.
    f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution, incident: incidentSchema.parse({
      id: "incident-1", role: "worker", runId: "worker-run", fingerprint: "", attempt: 1, cause: "missing_callback",
      detail: "One bounded callback reminder issued", action: "callback_reminder", status: "reconciling",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }) } });
    let next = (await holdReads(f, task.id)).next;
    assert.equal(next.stop?.kind, "incident");
    assert.notEqual(next.stop?.reason, "held");
    f.store.update(task.id, { phase: "needs_attention", reason: MERGE_HELD_REASON, resolution: { ...f.store.task(task.id).resolution, incident: null, stop: taskStopRecord("held", MERGE_HELD_REASON) } });
    assert.equal((await holdReads(f, task.id)).next.stop?.kind, "attention");
    // A queued row still carrying the hold text waits for dispatch.
    f.store.update(task.id, { phase: "queued", reason: DISPATCH_HELD_REASON, resolution: { ...f.store.task(task.id).resolution, stop: taskStopRecord("held", DISPATCH_HELD_REASON) } });
    next = (await holdReads(f, task.id)).next;
    assert.equal(next.stop?.kind, "wait");
    assert.equal(next.stop?.reason, "capacity");
    const dependency = f.add("Dependency");
    f.store.update(task.id, { phase: "changes_requested", reason: MERGE_HELD_REASON });
    f.store.setPrerequisiteWait(f.store.task(task.id), [dependency.id], "Waits for the dependency");
    f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution, stop: taskStopRecord("held", DISPATCH_HELD_REASON) } });
    next = (await holdReads(f, task.id)).next;
    assert.equal(next.stop?.kind, "wait");
    assert.equal(next.stop?.reason, "prerequisite");
  } finally { await f.close(); }
});

test("queue #371: a legacy held row keeps its projected fence and held stop", async () => {
  const f = fixture(); try {
    const task = f.add("Legacy held");
    f.store.update(task.id, { phase: "verifying", reason: MERGE_HELD_REASON, resolution: { ...task.resolution, stop: taskStopRecord("held", MERGE_HELD_REASON) } });
    // Pre-schema-40 shape: the legacy fields alone, no stored `holds`.
    const row = { ...f.store.task(task.id), held: true, mergeHold: true, holdOwner: "owner-thread", holdReason: "Owner verifies", holdAt: "2026-10-19T19:13:18.373Z", holdGeneration: 1, holds: {} };
    assert.deepEqual(Object.keys(holdsOf(row)), ["merge"]);
    assert.equal(taskStopKind(row), "hold");
    assert.deepEqual(currentTaskStop(row), row.resolution.stop);
    const summary = summarizeTask(row);
    assert.equal(summary.stop, "hold");
    assert.deepEqual(summary.stopRecord, row.resolution.stop);
    assert.equal(taskDetailView(row).resolution.stop, row.resolution.stop);
  } finally { await f.close(); }
});

test("papercut 793a4382: when a prerequisite finishes, a held queued dependent's wait text is refreshed, not left naming the finished parent", async () => {
  const f = fixture(); try {
    const parent = f.add("Parent");
    const other = f.add("Other parent");
    const child = f.add("Child", { dependsOn: [parent.id] });
    const both = f.add("Both", { dependsOn: [parent.id, other.id] });
    for (const task of [child, both]) f.store.update(task.id, { reason: f.store.dependencyWait(f.store.task(task.id)) });
    const held = await f.engine.performTaskControl({ taskId: child.id, version: f.store.task(child.id).version, action: "hold", reason: "Wait for staging" }) as Task;
    assert.match(held.reason, /^Waiting for prerequisites: Parent/);
    await f.engine.performTaskControl({ taskId: both.id, version: f.store.task(both.id).version, action: "hold", reason: "Wait for staging" });
    const free = f.add("Free", { dependsOn: [parent.id] });
    f.store.update(free.id, { reason: f.store.dependencyWait(f.store.task(free.id)) });
    const childVersion = f.store.task(child.id).version;
    const childEvents = f.store.eventsAll(child.id).length;
    f.store.update(parent.id, { phase: "done", finishedAt: new Date().toISOString(), reason: "Merged" });
    const reason = (id: string) => { const task = f.store.task(id); return queuedReason(f.store, task, taskWaitStateContext(f.store, task, null)); };
    assert.equal(reason(child.id), DISPATCH_HELD_REASON);
    assert.match(reason(both.id), /^Waiting for prerequisites: Other parent/);
    assert.doesNotMatch(reason(both.id), /Parent \(/);
    assert.equal(f.store.task(child.id).version, childVersion, 'settlement writes no queued task');
    assert.equal(f.store.eventsAll(child.id).length, childEvents, 'settlement emits no queued event');
  } finally { await f.close(); }
});

test("dependent index follows changed prerequisites and projection rebuilds", async () => {
  const f = fixture(); try {
    const first = f.add("First");
    const second = f.add("Second");
    const child = f.add("Child", { dependsOn: [first.id] });
    f.store.update(child.id, { dependsOn: [second.id], reason: "Waiting for prerequisites: Second" });
    await f.engine.performTaskControl({ taskId: child.id, version: f.store.task(child.id).version, action: "hold", reason: "Wait" });
    // A direct write invalidates the projection, exercising the cold rebuild too.
    f.store.db.prepare("UPDATE tasks SET data=data WHERE id=?").run(child.id);
    f.store.update(first.id, { phase: "done" });
    assert.match(f.store.task(child.id).reason, /Second/);
    f.store.update(second.id, { phase: "done" });
    const current = f.store.task(child.id);
    assert.equal(queuedReason(f.store, current, taskWaitStateContext(f.store, current, null)), DISPATCH_HELD_REASON);
  } finally { await f.close(); }
});
