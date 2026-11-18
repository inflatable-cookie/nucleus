import { HostOperationTimeoutError } from "../service/host-executor";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import {
  createBbHostAdapter,
  recordBbPresentationParentChange,
} from "../service/bb-host";
import { bbFake, bbWire, BB_STAMP } from "./support/bb-fake";
import {
  HostOperationError,
  type HostOperationName,
} from "../hosts/bb/plugin/operations";
import { formatAgentId } from "../shared/agent-identity";
import { submissionSchema, taskControlInputSchema } from "../shared/contracts";
import { wireLabels } from "../shared/wire-labels";
import type { HostAgentSpec } from "../shared/host";
import type { Adapter } from "../core/host";
import type { BbWorkspaceRecord } from "../hosts/bb/threads";

/**
 * Spec 062 + nucleus#1313 (Tom, 2026-11-17): "If a task is dispatched from a
 * planner in BB then the task is nested under the planner thread, otherwise it
 * should be standalone in the sidebar" and "We will also need the ability to
 * detach a worker thread from a planner in case the planner needs replacing".
 *
 * Every call crosses the real operation executor and the recorded BB 0.49 DTOs
 * (`support/bb-fake.ts`): the parent link is the wire's `parentThreadId`, read
 * back through `threads.get`, and a standalone task is one with no parent at all.
 */
const bbHost = "bb:0123456789abcdef0123456789abcdef";
const t3Host = "t3code:fedcba9876543210fedcba9876543210";
const paseoHost = "paseo";
const handle = `bb-worktree-${"b".repeat(40)}`;
const commit = "a".repeat(40);

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ns-bb-presentation-"));
  const store = new Store(join(directory, "queue.sqlite"));
  store.setMeta("paused", false);
  store.setMeta("hostRegistry", [
    { id: bbHost, endpoint: "fixture" },
    { id: t3Host, endpoint: "fixture" },
  ]);
  const fake = bbFake();
  const notSent = (error: unknown) =>
    error instanceof HostOperationError &&
    (error.code === "invalid_input" || error.code === "refused");
  // The channel maps a plugin's own unclassified failure to `internal`, which is
  // unknown delivery; the executor's typed refusals stay typed.
  const operation = async (op: HostOperationName, input: unknown) => {
    try {
      return await fake.operations.execute(op, input);
    } catch (error) {
      if (
        error instanceof HostOperationError ||
        error instanceof HostOperationTimeoutError
      )
        throw error;
      throw new HostOperationError(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  store.setMeta("bbWorkspaces", {
    [handle]: {
      id: handle,
      directory: "/synthetic/worktree",
      projectId: "proj_synthetic",
      repositoryRoot: "/synthetic/repo",
      title: "Synthetic",
    } satisfies BbWorkspaceRecord,
  });
  const adapter = createBbHostAdapter(
    bbHost,
    () => true,
    directory,
    store,
    operation,
  ) as Adapter & {
    guardedNativeAgentCreate(
      spec: HostAgentSpec,
      mcp: boolean,
      retry: boolean,
    ): Promise<{ id: string; workspaceId: string | null }>;
  };
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "BB presentation",
      repoPath: "/synthetic/repo",
      planningCommit: commit,
      handoffPath: "/synthetic/handoff.md",
      originAgentId: "origin",
    }),
    bbHost,
    "/synthetic/handoff.md",
    commit,
  );
  store.update(task.id, {
    phase: "working",
    workspaceId: handle,
    directory: "/synthetic/worktree",
  });
  const profile = {
    id: "synthetic-profile",
    name: "Synthetic profile",
    provider: "codex",
    model: "synthetic-model",
    notes: "",
    available: true,
    problem: "",
    supportedThinking: ["high"],
    thinkingOptionId: "high",
  };
  const spec = (run: string, role = "worker"): HostAgentSpec => ({
    workspaceId: handle,
    taskNumber: 1313,
    title: role === "worker" ? "Synthetic task" : `${role}: Synthetic task`,
    profile,
    mcpBindingPath: null,
    attempt: () => ({
      requestId: `ns-${run}`,
      labels: wireLabels({ task: task.id, run, role }),
      environment: {},
      prompt: "Synthetic prompt.",
    }),
  });
  /** The planner thread a reparent names must be a live host thread. */
  const livePlanner = (threadId: string) =>
    fake.rows.set(
      threadId,
      bbWire("list", {
        id: threadId,
        projectId: "proj_synthetic",
        environmentId: "env_planner",
        environmentPath: "/synthetic/planner",
        parentThreadId: null,
        hasPendingInteraction: false,
        archivedAt: null,
      }),
    );
  const plannerId = (hostId: string, native: string) =>
    formatAgentId(hostId, native);
  const spawns = () =>
    fake.calls.filter((call) => call.method === "threads.spawn");
  const updates = () =>
    fake.calls.filter(
      (call) =>
        call.method === "threads.update" &&
        call.args.parentThreadId !== undefined,
    );
  const reconcile = async () =>
    adapter.reconcileThreadTitles!([store.task(task.id)]);
  return {
    directory,
    store,
    fake,
    adapter,
    task: () => store.task(task.id),
    spec,
    livePlanner,
    plannerId,
    spawns,
    updates,
    reconcile,
    engine: () => new Engine(store, adapter, 0),
    close: async (engine?: Engine) => {
      try {
        await engine?.stop();
      } catch {
        /* the fixture's engine owns no timers */
      }
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("BB presentation: a planner on this BB nests the group; T3, Paseo or no planner is standalone and dispatch still succeeds", async () => {
  const f = fixture();
  try {
    // 1. The planner thread lives on this BB host: the task group nests under it.
    f.store.update(f.task().id, {
      plannerAgentId: f.plannerId(bbHost, "thr_planner"),
    });
    const nested = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_nested", "worker"),
      false,
      false,
    );
    const nestedSpawn = f.spawns().at(-1)!.args;
    assert.equal(nestedSpawn.parentThreadId, "thr_planner");
    assert.equal(f.fake.rows.get(nested.id)!.parentThreadId, "thr_planner");

    // 2. A project planner on T3: dispatch succeeds, and the group is standalone.
    f.store.update(f.task().id, { plannerAgentId: null });
    f.store.setProjectPlanner({
      key: f.store.projectFor(
        "/synthetic/repo",
        f.task().repository ?? undefined,
      )!.key,
      agentId: f.plannerId(t3Host, "thr_t3_planner"),
      setBy: "operator (board)",
    });
    const standalone = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_t3", "worker"),
      false,
      false,
    );
    const t3Spawn = f.spawns().at(-1)!.args;
    assert.equal(
      Object.hasOwn(t3Spawn, "parentThreadId"),
      false,
      "a T3 planner names no BB parent at all",
    );
    assert.equal(
      f.fake.rows.get(standalone.id)!.parentThreadId,
      null,
      "the task group is a top-level group",
    );

    // 3. A planner on Paseo, named on the task itself: also standalone.
    f.store.setProjectPlanner({
      key: f.store.projectFor(
        "/synthetic/repo",
        f.task().repository ?? undefined,
      )!.key,
      agentId: null,
      setBy: "operator (board)",
    });
    f.store.update(f.task().id, {
      plannerAgentId: f.plannerId(paseoHost, "thr_paseo_planner"),
    });
    const paseo = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_paseo", "worker"),
      false,
      false,
    );
    assert.equal(f.fake.rows.get(paseo.id)!.parentThreadId, null);

    // 4. No planner at all: standalone too, and dispatch is never refused.
    f.store.update(f.task().id, { plannerAgentId: null });
    const alone = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_alone", "worker"),
      false,
      false,
    );
    assert.equal(f.fake.rows.get(alone.id)!.parentThreadId, null);
    // Every role thread of the task is recorded against the same task, and the
    // hundreds of recorded spawns each carry a real BB row.
    assert.equal(f.spawns().length, 4);
    for (const call of f.spawns())
      assert.equal(call.args.parentNotifications, "off");
  } finally {
    await f.close();
  }
});

test("BB presentation: reparent to a BB planner re-nests, reparent elsewhere or an explicit detach makes the group standalone", async () => {
  const f = fixture();
  const engine = f.engine();
  try {
    engine.identifyOriginHost = async (id: string) => parseHostOf(id);
    f.store.update(f.task().id, {
      plannerAgentId: f.plannerId(bbHost, "thr_planner"),
    });
    f.livePlanner("thr_planner");
    const worker = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_worker", "worker"),
      false,
      false,
    );
    const reviewer = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_reviewer", "reviewer"),
      false,
      false,
    );
    // Dispatch binds the task's worker, which is the record the presentation pass reads.
    f.store.update(f.task().id, { agentId: worker.id });
    assert.equal(f.fake.rows.get(worker.id)!.parentThreadId, "thr_planner");

    // A reparent to another planner on this BB host re-nests every role thread.
    f.livePlanner("thr_successor");
    await engine.reparent({
      toAgentId: f.plannerId(bbHost, "thr_successor"),
      caller: "operator (board)",
      reason: "Planner replaced",
      taskIds: [f.task().id],
    });
    assert.equal(
      f.task().plannerAgentId,
      null,
      "a reparent moves the planner with the owner",
    );
    assert.equal(
      f.task().notificationAgentId,
      f.plannerId(bbHost, "thr_successor"),
    );
    await f.reconcile();
    for (const id of [worker.id, reviewer.id])
      assert.equal(f.fake.rows.get(id)!.parentThreadId, "thr_successor");
    assert.equal(
      f.updates().filter((call) => call.args.parentThreadId === "thr_successor")
        .length,
      2,
    );

    // A planner elsewhere makes the group standalone: the parent link is cleared,
    // not moved to a thread this host does not have.
    f.store.update(f.task().id, {
      plannerAgentId: f.plannerId(t3Host, "thr_t3_planner"),
    });
    await f.reconcile();
    for (const id of [worker.id, reviewer.id])
      assert.equal(f.fake.rows.get(id)!.parentThreadId, null);
    assert.equal(
      f.updates().filter((call) => call.args.parentThreadId === null).length,
      2,
    );

    // Back to a BB planner: it re-nests, observation-first and once per thread.
    f.store.update(f.task().id, {
      plannerAgentId: f.plannerId(bbHost, "thr_successor"),
    });
    await f.reconcile();
    for (const id of [worker.id, reviewer.id])
      assert.equal(f.fake.rows.get(id)!.parentThreadId, "thr_successor");
    await f.reconcile();
    assert.equal(
      f.updates().filter((call) => call.args.parentThreadId === "thr_successor")
        .length,
      4,
      "each thread is written once; the second pass reads the link it wrote",
    );

    // An explicit detach records "no planner thread for presentation": the group
    // becomes standalone without naming a new planner, and the planner is unchanged.
    const detached = await engine.performTaskControl(
      taskControlInputSchema.parse({
        action: "detach",
        taskId: f.task().id,
        version: f.task().version,
        caller: "operator (board)",
      }),
    );
    assert.equal(detached.presentationDetached?.by, "operator (board)");
    assert.equal(
      detached.plannerAgentId,
      f.plannerId(bbHost, "thr_successor"),
      "detach names no new planner",
    );
    assert.equal(
      detached.notificationAgentId,
      f.task().notificationAgentId,
      "detach changes no owner",
    );
    await f.reconcile();
    for (const id of [worker.id, reviewer.id])
      assert.equal(f.fake.rows.get(id)!.parentThreadId, null);

    // A reparent that names a planner clears the detach record and nests again.
    f.livePlanner("thr_replacement");
    await engine.reparent({
      toAgentId: f.plannerId(bbHost, "thr_replacement"),
      caller: "operator (board)",
      reason: "Planner replaced",
      taskIds: [f.task().id],
    });
    assert.equal(
      f.task().presentationDetached,
      null,
      "naming a planner clears the detach record",
    );
    await f.reconcile();
    for (const id of [worker.id, reviewer.id])
      assert.equal(f.fake.rows.get(id)!.parentThreadId, "thr_replacement");
  } finally {
    await f.close(engine);
  }
});

test("BB parentChanged: detaching and re-nesting any task thread moves the whole presentation group and later spawns follow it", async () => {
  const f = fixture();
  try {
    f.store.update(f.task().id, {
      plannerAgentId: f.plannerId(bbHost, "thr_planner"),
    });
    const worker = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_worker_move", "worker"),
      false,
      false,
    );
    const reviewer = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_reviewer_move", "reviewer"),
      false,
      false,
    );
    f.store.update(f.task().id, { agentId: worker.id });
    assert.equal(f.fake.rows.get(worker.id)!.parentThreadId, "thr_planner");
    assert.equal(f.fake.rows.get(reviewer.id)!.parentThreadId, "thr_planner");

    // This is the service's real persistence handler for BB parentChanged. A
    // thread dragged out records a standalone presentation without changing planner ownership.
    const at = new Date().toISOString();
    assert.equal(
      recordBbPresentationParentChange(f.store, bbHost, worker.id, null, at),
      f.task().id,
    );
    await f.reconcile();
    assert.equal(f.task().plannerAgentId, f.plannerId(bbHost, "thr_planner"));
    for (const id of [worker.id, reviewer.id])
      assert.equal(f.fake.rows.get(id)!.parentThreadId, null);

    // Re-nesting by dropping just the reviewer under a different thread moves
    // the entire task group and a later reviewer spawn uses that same parent.
    f.livePlanner("thr_new_parent");
    assert.equal(
      recordBbPresentationParentChange(
        f.store,
        bbHost,
        reviewer.id,
        "thr_new_parent",
        at,
      ),
      f.task().id,
    );
    await f.reconcile();
    const nextReviewer = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_reviewer_later", "reviewer"),
      false,
      false,
    );
    for (const id of [worker.id, reviewer.id, nextReviewer.id])
      assert.equal(f.fake.rows.get(id)!.parentThreadId, "thr_new_parent");
    assert.equal(f.task().plannerAgentId, f.plannerId(bbHost, "thr_planner"));

    // No later Nucleus pass reverts the operator's choice back to the planner.
    await f.reconcile();
    for (const id of [worker.id, reviewer.id, nextReviewer.id])
      assert.equal(f.fake.rows.get(id)!.parentThreadId, "thr_new_parent");
    // The group's other threads report the same parent again: one record, no new version.
    const version = f.task().version;
    assert.equal(
      recordBbPresentationParentChange(
        f.store,
        bbHost,
        worker.id,
        "thr_new_parent",
        at,
      ),
      f.task().id,
    );
    assert.equal(f.task().version, version);
    // A drop under one of the task's own threads cannot nest the group under itself.
    assert.equal(
      recordBbPresentationParentChange(
        f.store,
        bbHost,
        worker.id,
        reviewer.id,
        at,
      ),
      null,
    );
    assert.equal(f.task().presentationParent?.parentThreadId, "thr_new_parent");
    // A thread Nucleus did not create (the planner itself) records nothing.
    assert.equal(
      recordBbPresentationParentChange(
        f.store,
        bbHost,
        "thr_planner",
        null,
        at,
      ),
      null,
    );
  } finally {
    await f.close();
  }
});

test("BB presentation: titles name the repository and the role once the container holds a second participant", async () => {
  const f = fixture();
  try {
    f.store.update(f.task().id, {
      plannerAgentId: f.plannerId(bbHost, "thr_planner"),
    });
    f.livePlanner("thr_planner");
    const worker = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_worker", "worker"),
      false,
      false,
    );
    f.store.update(f.task().id, { agentId: worker.id });
    const number = f.task().number!;
    const reference = `repo#${number}`;

    // Every spawn names the repository reference, never a bare padded number.
    const workerSpawn = f.spawns().at(-1)!.args as { title: string };
    assert.match(workerSpawn.title, new RegExp(`^${reference} `));
    assert.doesNotMatch(workerSpawn.title, /#0\d/);

    // The lone worker keeps the phase-prefixed title, now naming the reference.
    const titles = (id: string) =>
      f.fake.calls
        .filter(
          (call) =>
            call.method === "threads.update" &&
            call.args.threadId === id &&
            call.args.title !== undefined,
        )
        .map((call) => String(call.args.title));
    await f.reconcile();
    const lone = titles(worker.id).at(-1)!;
    assert.match(
      lone,
      new RegExp(`^[^:]+: ${reference} `),
      "Working: repo#29 <title>",
    );
    assert.match(
      f.fake.rows.get(worker.id)!.title,
      new RegExp(`^[^:]+: ${reference} `),
    );

    // A second participant joins: the worker is named by role like the reviewer, and
    // its phase is no longer in the title.
    const reviewer = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_reviewer", "reviewer"),
      false,
      false,
    );
    const reviewerSpawn = f.spawns().at(-1)!.args as { title: string };
    assert.equal(reviewerSpawn.title, `${reference} reviewer: Synthetic task`);
    await f.reconcile();
    const grouped = titles(worker.id).at(-1)!;
    assert.match(
      grouped,
      new RegExp(`^${reference} worker: `),
      "repo#29 worker: <title>",
    );
    assert.doesNotMatch(grouped, /^(Working|Reviewing|Merging):/);
    assert.equal(f.fake.rows.get(reviewer.id)!.title, reviewerSpawn.title);

    // A support thread names the same reference (the decider is a container member too).
    const decider = await f.adapter.runDecider!(f.store.task(f.task().id), {
      profile: f.spec("x").profile,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      decisionId: "dec_1",
    });
    const deciderSpawn = f.spawns().at(-1)!.args as { title: string };
    assert.equal(deciderSpawn.title, `${reference} decider: BB presentation`);

    // Item 12 archives the superseded participants; an archived thread is no longer
    // a container member, so a now-lone live worker returns to its phase-prefixed
    // title rather than keeping the grouped role-named one (review finding).
    f.fake.rows.get(reviewer.id)!.archivedAt = BB_STAMP;
    f.fake.rows.get(decider.agentId)!.archivedAt = BB_STAMP;
    await f.reconcile();
    const loneAgain = titles(worker.id).at(-1)!;
    assert.match(
      loneAgain,
      new RegExp(`^[^:]+: ${reference} `),
      "Working: repo#N <title> again",
    );
    assert.doesNotMatch(loneAgain, / worker: /);
  } finally {
    await f.close();
  }
});

test("BB presentation: a superseded participant leaves the container, while a live or bound one stays", async () => {
  const f = fixture();
  try {
    f.store.update(f.task().id, {
      plannerAgentId: f.plannerId(bbHost, "thr_planner"),
    });
    f.livePlanner("thr_planner");
    const worker = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_worker", "worker"),
      false,
      false,
    );
    f.store.update(f.task().id, { agentId: worker.id });
    const firstReviewer = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_reviewer_1", "reviewer"),
      false,
      false,
    );
    const secondReviewer = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_reviewer_2", "reviewer"),
      false,
      false,
    );
    const recovery = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_recovery", "recovery"),
      false,
      false,
    );
    const pending = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_reviewer_pending", "reviewer"),
      false,
      false,
    );

    // Runs as Nucleus records them: the first reviewer and the recovery run settled
    // and unbound, the second reviewer retained, the last one holding a question.
    const at = new Date().toISOString();
    const run = (
      id: string,
      role: "reviewer" | "recovery",
      agentId: string,
      released: boolean,
    ) => ({
      id,
      taskId: f.task().id,
      hostId: bbHost,
      role,
      generation: 0,
      head: "b".repeat(40),
      base: "a".repeat(40),
      agentId,
      workspaceId: handle,
      profile: f.spec("x").profile,
      profileGroup: null,
      status: "finished" as const,
      createdAt: at,
      lastObservedAt: at,
      active: false,
      idleSince: at,
      completion: null,
      released,
    });
    f.store.putRun(run("run_reviewer_1", "reviewer", firstReviewer.id, true));
    f.store.putRun(run("run_reviewer_2", "reviewer", secondReviewer.id, false));
    f.store.putRun(run("run_recovery", "recovery", recovery.id, true));
    f.store.putRun(run("run_reviewer_pending", "reviewer", pending.id, true));
    const bound = f.store.task(f.task().id);
    f.store.update(f.task().id, {
      resolution: {
        ...bound.resolution,
        reviewerAgentId: secondReviewer.id,
        currentRunId: "run_reviewer_2",
      },
    });
    f.fake.rows.get(pending.id)!.hasPendingInteraction = true;

    await f.adapter.reconcileThreadTitles!([f.store.task(f.task().id)]);

    assert.notEqual(
      f.fake.rows.get(firstReviewer.id)!.archivedAt,
      null,
      "the replaced reviewer is archived",
    );
    assert.equal(
      f.fake.rows.get(recovery.id)!.archivedAt !== null,
      true,
      "the settled recovery thread is archived",
    );
    assert.equal(
      f.fake.rows.get(worker.id)!.archivedAt,
      null,
      "the current worker stays",
    );
    assert.equal(
      f.fake.rows.get(secondReviewer.id)!.archivedAt,
      null,
      "the retained reviewer stays",
    );
    assert.equal(
      f.fake.rows.get(pending.id)!.archivedAt,
      null,
      "a thread with a pending interaction is never archived",
    );
    assert.equal(
      f.fake.rows.get("thr_planner")!.archivedAt,
      null,
      "the planner is never touched",
    );
    // The archive is the plugin's own recorded-thread archive, with its cascade proof.
    for (const id of [firstReviewer.id, recovery.id])
      assert.equal(
        f.fake.calls.some(
          (call) =>
            call.method === "threads.archive" && call.args.threadId === id,
        ),
        true,
      );
  } finally {
    await f.close();
  }
});

test("BB presentation: archiving the old planner leaves the task threads intact, and Nucleus never sets a lifecycle owner", async () => {
  const f = fixture();
  try {
    f.store.update(f.task().id, {
      plannerAgentId: f.plannerId(bbHost, "thr_planner"),
    });
    f.livePlanner("thr_planner");
    const worker = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_worker", "worker"),
      false,
      false,
    );
    const reviewer = await f.adapter.guardedNativeAgentCreate(
      f.spec("run_reviewer", "reviewer"),
      false,
      false,
    );
    f.store.update(f.task().id, { agentId: worker.id });

    // The guarantee: no spawn and no update ever names a lifecycle owner, so BB's
    // archive cascade has no relation to walk from the planner into the task.
    for (const call of [
      ...f.spawns(),
      ...f.fake.calls.filter((call) => call.method === "threads.update"),
    ])
      assert.equal(
        Object.hasOwn(call.args, "lifecycleOwnerThreadId"),
        false,
        `${call.method} never sets a lifecycle owner`,
      );

    // The operator archives the old planner in BB: the planner's own row closes and
    // nothing depends on it. Nucleus never archives the planner itself.
    f.fake.rows.get("thr_planner")!.archivedAt = BB_STAMP;
    for (const id of [worker.id, reviewer.id]) {
      const row = f.fake.rows.get(id)!;
      assert.equal(row.archivedAt, null, "the task thread stays live");
      assert.equal(row.parentThreadId, "thr_planner");
      const observed = await f.adapter.observe(id);
      assert.notEqual(observed.status, "closed");
    }
    assert.equal(
      f.fake.calls.filter((call) => call.method === "threads.archive").length,
      0,
    );
    // Nucleus refuses to archive a thread it did not create: the planner is never its to retire.
    await assert.rejects(
      f.adapter.archiveAgent("thr_planner"),
      /only accepts a Nucleus-created thread/,
    );

    // The detached/reparented task keeps working with its old planner archived.
    f.store.update(f.task().id, {
      presentationDetached: {
        at: new Date().toISOString(),
        by: "operator (board)",
      },
    });
    await f.adapter.reconcileThreadTitles!([f.store.task(f.task().id)]);
    for (const id of [worker.id, reviewer.id])
      assert.equal(f.fake.rows.get(id)!.parentThreadId, null);
    for (const id of [worker.id, reviewer.id])
      assert.equal(f.fake.rows.get(id)!.archivedAt, null);
  } finally {
    await f.close();
  }
});

/** The host a qualified identity belongs to; the adapters in this fixture are keyed by it. */
function parseHostOf(id: string): string | undefined {
  try {
    const value = JSON.parse(id.slice("nucleus-agent:v1:".length)) as unknown;
    return Array.isArray(value) && typeof value[0] === "string"
      ? value[0]
      : undefined;
  } catch {
    return undefined;
  }
}

test("BB presentation and inventory propagate host request timeouts", async () => {
  const f = fixture();
  try {
    const worker = await f.adapter.guardedNativeAgentCreate(
      f.spec("worker-timeout"),
      false,
      false,
    );
    f.store.update(f.task().id, { agentId: worker.id });
    let calls = 0;
    f.fake.operations.execute = async (op: HostOperationName) => {
      calls++;
      throw new HostOperationTimeoutError(op, 10, new Promise(() => {}));
    };
    await assert.rejects(f.reconcile(), HostOperationTimeoutError);
    assert.equal(calls, 1, "the pass stops at the first failed request");
    await assert.rejects(
      f.adapter.observationInventory!([worker.id]),
      HostOperationTimeoutError,
    );
  } finally {
    await f.close();
  }
});

test("BB stops participant reads when the host hangs after answering earlier reads", async () => {
  const f = fixture();
  try {
    const worker = await f.adapter.guardedNativeAgentCreate(
      f.spec("worker-midpass"),
      false,
      false,
    );
    await f.adapter.guardedNativeAgentCreate(
      f.spec("reviewer-midpass", "reviewer"),
      false,
      false,
    );
    f.store.update(f.task().id, { agentId: worker.id });
    const original = f.fake.operations.execute;
    let calls = 0;
    f.fake.operations.execute = async (op, input) => {
      if (op === "thread.observe" && ++calls === 3)
        throw new HostOperationTimeoutError(op, 10, new Promise(() => {}));
      return original(op, input);
    };
    await assert.rejects(
      f.adapter.setTaskWorkspaceTitle!(f.task(), "title", "request", false),
      HostOperationTimeoutError,
    );
    assert.equal(calls, 3);
  } finally {
    await f.close();
  }
});
