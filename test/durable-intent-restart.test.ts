import { restartAfterIntent } from "./support/intent-restart";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Engine } from "../core/engine";
import type { Store } from "../core/store/store";
import { git } from "../core/git/index";
import { RuntimeRetirementService } from "../core/runtime/runtime-retirement";
import { runSchema } from "../shared/contracts";
import { archiveFinishedThreads } from "../core/workspaces/thread-archive";
import type { ArchiveEffect } from "../core/workspaces/thread-archive-effect";
import {
  fakeAdapter,
  observeIdle,
  submission,
  tempStore,
} from "./support/fakes";
import { terminalArchiveFixture } from "./support/terminal-archive-fixture";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";

type Fixture = Awaited<ReturnType<typeof terminalArchiveFixture>>;

function startAfterRoll(f: Fixture, retentionHeld = false) {
  return (store: Store) => {
    const retirement = new RuntimeRetirementService(store, async () => ({
      code: 0,
      timedOut: false,
      spawnError: "",
      output: "{}",
    }));
    const engine = new Engine(store, f.adapter, 0, () => true, retirement);
    if (retentionHeld)
      engine.hooks.retentionGate = async () => {
        throw Error("consumer retention blocked");
      };
    return engine;
  };
}

function runCleanup(f: Fixture) {
  f.engine.enqueueCleanup(f.task().id);
  return f.engine.drainCleanup();
}

async function interruptBuildOutput(f: Fixture) {
  const archive = f.adapter.archiveTaskWorkspace.bind(f.adapter);
  f.adapter.archiveTaskWorkspace = async (
    task,
    id,
    directory,
    head,
    allowed,
    uncertain,
    options,
  ) => {
    const cleanup = options?.buildOutputCleanup;
    assert.ok(cleanup);
    return archive(task, id, directory, head, allowed, uncertain, {
      ...options,
      buildOutputCleanup: {
        ...cleanup,
        begin() {
          assert.equal(cleanup.begin(), "run");
          void f.engine.stop();
          return false;
        },
      },
    });
  };
  try {
    await runCleanup(f);
  } finally {
    f.adapter.archiveTaskWorkspace = archive;
  }
}

for (const shape of [
  "ordinary",
  "already-cleaned",
  "already-archived",
  "dirty",
  "unpublished",
  "live",
  "retention",
] as const) {
  test(`build_output_cleanup_intent survives a roll (${shape} workspace)`, async (t) => {
    const f = await terminalArchiveFixture(t);
    const { id, branch } = f.task();
    const output = join(f.directory, "node_modules");
    await writeFile(
      join(f.primary, ".git", "info", "exclude"),
      "node_modules/\n",
    );
    await mkdir(output);
    await writeFile(join(output, "generated.txt"), "generated");
    f.updateResolution({ workspaceArchiveRetries: [], cleanupReason: "" });
    f.remote.participant.status = "closed";

    await restartAfterIntent(
      f.engine,
      id,
      "build_output_cleanup_intent",
      async () => {
        await interruptBuildOutput(f);
        assert.equal(
          f.task().resolution.buildOutputCleanups[0]?.state,
          "intent",
        );
        assert.ok(existsSync(output));
        assert.deepEqual(f.remote.archives, []);
        if (shape === "already-cleaned") {
          await git(f.directory, "clean", "-fdx", "--", "node_modules");
        }
        if (shape === "already-archived") {
          f.remote.catalogued = false;
          await git(f.primary, "worktree", "remove", "--force", f.directory);
          // A prior sweep may already have recorded the archive without the cleanup result.
          f.updateResolution({ archivedWorkspaceIds: ["ws"] });
        }
        if (shape === "dirty")
          await writeFile(join(f.directory, "keep.txt"), "local files");
        if (shape === "unpublished")
          await git(f.primary, "push", "origin", "--delete", branch);
        if (shape === "live") f.remote.participant.active = true;
      },
      startAfterRoll(f, shape === "retention"),
      async (store, sweep) => {
        await sweep();
        const task = store.task(id);
        assert.equal(task.phase, "done");
        if (
          shape === "dirty" ||
          shape === "unpublished" ||
          shape === "live" ||
          shape === "retention"
        ) {
          assert.ok(
            existsSync(output),
            "the gate holds both cleanup and archive",
          );
          assert.deepEqual(f.remote.archives, []);
          assert.equal(task.resolution.buildOutputCleanups[0]?.state, "intent");
          const next = ownerTaskNext(collectOwnerVerbFacts(store, task));
          const retry = next.verbs.find(
            (verb) =>
              verb.verb === "retry_effect" &&
              verb.args?.effect === "workspace_archive.ws",
          );
          assert.equal(retry?.available, true);
          assert.match(
            String(retry?.args?.summary),
            {
              dirty: /uncommitted/,
              unpublished: /unpublished/,
              live: /participants to become idle/,
              retention: /consumer retention blocked/,
            }[shape],
          );
        } else {
          assert.equal(
            task.resolution.buildOutputCleanups[0]?.state,
            "complete",
          );
          if (shape === "already-cleaned")
            assert.match(
              task.resolution.buildOutputCleanups[0]?.detail ?? "",
              /No build output roots/,
            );
          assert.deepEqual(task.resolution.archivedWorkspaceIds, ["ws"]);
          assert.equal(
            f.remote.archives.length,
            shape === "already-archived" ? 0 : 1,
          );
          assert.equal(existsSync(f.directory), false);
          const events = store.eventsAll(id);
          assert.equal(
            events.filter(
              (event) => event.kind === "build_output_cleanup_complete",
            ).length,
            1,
          );
          assert.equal(
            events.filter((event) => event.kind === "workspace_archive_intent")
              .length,
            shape === "already-archived" ? 0 : 1,
          );
        }
        const events = store.eventsAll(id);
        const notices = store.notices(id);
        const sends = [...f.remote.archives];
        await sweep();
        assert.deepEqual(store.eventsAll(id), events);
        assert.deepEqual(store.notices(id), notices);
        assert.deepEqual(f.remote.archives, sends);
      },
    );
  });
}

test("workspace_archive_intent observes a delivered archive after a roll without sending it again", async (t) => {
  const f = await terminalArchiveFixture(t);
  const { id } = f.task();
  f.updateResolution({ workspaceArchiveRetries: [], cleanupReason: "" });
  f.remote.participant.status = "closed";
  const ref = f.api.workspaces.ref;
  f.api.workspaces.ref = () => {
    const workspace = ref();
    return {
      ...workspace,
      archive: async (requestId) => {
        await workspace.archive(requestId);
        await git(f.primary, "worktree", "remove", f.directory);
        void f.engine.stop();
        throw Error("The service stopped before recording the archive result");
      },
    };
  };

  await restartAfterIntent(
    f.engine,
    id,
    "workspace_archive_intent",
    async () => {
      await runCleanup(f);
      assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
      assert.equal(f.task().resolution.archiveIntentWorkspaceId, "ws");
      assert.equal(f.remote.archives.length, 1);
    },
    startAfterRoll(f),
    async (store, sweep) => {
      await sweep();
      assert.deepEqual(store.task(id).resolution.archivedWorkspaceIds, ["ws"]);
      assert.equal(store.task(id).resolution.archiveIntentWorkspaceId, null);
      const events = store.eventsAll(id);
      const notices = store.notices(id);
      assert.equal(
        events.filter((e) => e.kind === "workspace_archived").length,
        1,
      );
      await sweep();
      assert.deepEqual(store.eventsAll(id), events);
      assert.deepEqual(store.notices(id), notices);
      assert.equal(f.remote.archives.length, 1);
    },
  );
});

test("run_build_output_intent on a released run settles even after the task is done", async (t) => {
  const f = await terminalArchiveFixture(t);
  const { id } = f.task();
  const run = runSchema.parse({
    id: "revision-run",
    taskId: id,
    role: "revision",
    generation: 1,
    head: f.head,
    base: f.head,
    agentId: "worker",
    workspaceId: "ws",
    profile: null,
    status: "finished",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: false,
    idleSince: null,
    completion: null,
    released: true,
  });
  f.store.putRun(run);
  await restartAfterIntent(
    f.engine,
    id,
    "run_build_output_intent",
    async () => {
      f.engine.resolution.callbackIntake.completeBuildOutput(run, f.task());
      f.remote.catalogued = false;
      await git(f.primary, "worktree", "remove", f.directory);
      f.updateResolution({
        archivedWorkspaceIds: ["ws"],
        workspaceArchiveRetries: [],
      });
    },
    startAfterRoll(f),
    async (store, sweep) => {
      await sweep();
      const record = store
        .task(id)
        .resolution.buildOutputCleanups.find((item) => item.runId === run.id);
      assert.equal(record?.state, "complete");
      assert.equal(record?.detail, "directory absent; nothing to clean up");
      const events = store.eventsAll(id);
      assert.equal(
        events.filter((e) => e.kind === "run_build_output_complete").length,
        1,
      );
      await sweep();
      assert.deepEqual(store.eventsAll(id), events);
      assert.deepEqual(f.remote.archives, []);
    },
  );
});

test("brief_amendment_delivery_intent waits for a channel across a roll", async (t) => {
  const { store } = tempStore(t);
  store.setMeta("paused", false);
  store.setMeta("hostId", "host");
  const brief = "Write the initial report.";
  const initial = store.insert(
    submission({ brief: { text: brief, mediaType: "text/markdown" } }),
    "host",
    brief,
    "a".repeat(40),
  );
  const task = store.update(initial.id, {
    phase: "working",
    agentId: "worker",
    runId: "initial",
    workspaceId: "ws",
  });
  const sends: string[] = [];
  const adapter = fakeAdapter({});
  const engine = new Engine(store, adapter, 0);
  await restartAfterIntent(
    engine,
    task.id,
    "brief_amendment_delivery_intent",
    async () => {
      engine.amendBrief({
        taskId: task.id,
        version: task.version,
        brief: "Write the short report.",
        reason: "Narrowed scope",
      });
      assert.equal(
        store
          .eventsAll(task.id)
          .some((e) => e.kind === "brief_amendment_delivery_attempt"),
        false,
      );
      store.update(task.id, { phase: "done" });
    },
    (reopened) =>
      new Engine(
        reopened,
        fakeAdapter({
          enqueueMessage: async (_id: string, messageId: string) => {
            sends.push(messageId);
          },
        }),
        0,
      ),
    async (reopened, sweep) => {
      await sweep();
      assert.deepEqual(sends, [`ns-brief-amendment-${task.id}-v2-worker`]);
      const events = reopened.eventsAll(task.id);
      assert.equal(
        events.filter((e) => e.kind === "brief_amendment_delivered").length,
        1,
      );
      await sweep();
      assert.deepEqual(reopened.eventsAll(task.id), events);
      assert.equal(sends.length, 1);
    },
  );
});

for (const removal of [true, false]) {
  const skip = removal
    ? false
    : "The finished thread catch-up scan is limited to hosts that support deletion";
  test(`thread_archive_intent on a finished ${removal ? "deletion-capable" : "archive-only"} host observes a lost reply`, async (t) => {
    const { store } = tempStore(t);
    store.setMeta("paused", false);
    store.setMeta("hostId", "host");
    const initial = store.insert(
      submission(),
      "host",
      "handoff",
      "a".repeat(40),
    );
    const task = store.update(initial.id, {
      phase: "done",
      agentId: "worker",
      workspaceId: "ws",
      resolution: {
        ...initial.resolution,
        mergedCommit: "b".repeat(40),
        archivedWorkspaceIds: ["ws"],
      },
    });
    let archived = false;
    let sends = 0;
    const adapter = fakeAdapter({
      ...(removal
        ? {
            deleteAgent: async () => assert.fail("worker threads are archived"),
          }
        : {}),
      observe: async (id: string) => ({
        ...(await observeIdle("ws")(id)),
        labels: { "northstar.task": task.id },
      }),
      originAgent: async (id: string) => ({
        id,
        workspaceId: "ws",
        title: "",
        archived,
      }),
      archiveAgent: async () => {
        archived = true;
        sends++;
        throw Error("Reply lost after archive");
      },
    });
    const engine = new Engine(store, adapter, 0);
    const key = store.threadArchiveKey("worker", "host")!;
    await restartAfterIntent(
      engine,
      task.id,
      "thread_archive_intent",
      async () => {
        await archiveFinishedThreads(store, adapter, task.id);
        assert.equal(sends, 1);
        assert.equal(store.getMeta<ArchiveEffect>(key)?.status, "uncertain");
      },
      (reopened) => new Engine(reopened, adapter, 0),
      async (reopened, sweep) => {
        await sweep();
        await t.test(
          "thread_archive_intent restart outcome",
          { skip },
          async () => {
            assert.equal(
              reopened.getMeta<ArchiveEffect>(key)?.status,
              "archived",
            );
            const events = reopened.eventsAll(task.id);
            assert.equal(
              events.filter((e) => e.kind === "thread_archive_observed").length,
              1,
            );
            await sweep();
            assert.deepEqual(reopened.eventsAll(task.id), events);
            assert.equal(sends, 1);
          },
        );
      },
    );
  });
}

test("run_intent without delivery settles at the terminal transition after a roll", async (t) => {
  const { store } = tempStore(t);
  store.setMeta("paused", false);
  store.setMeta("hostId", "host");
  const initial = store.insert(submission(), "host", "handoff", "a".repeat(40));
  const task = store.update(initial.id, {
    phase: "closing",
    workspaceId: "ws",
    resolution: { ...initial.resolution, syncedCommit: "b".repeat(40) },
  });
  const adapter = fakeAdapter({
    findRunAgents: async () => assert.fail("A terminal task owes no creation"),
  });
  const engine = new Engine(store, adapter, 0);
  let runId: string | null = null;
  await restartAfterIntent(
    engine,
    task.id,
    "run_intent",
    async () => {
      engine.resolution.deliverLaunchRun = async (_task, _role, { run }) => {
        runId = run.id;
        // Stop before the adapter receives any part of this reservation.
        void engine.stop();
      };
      await engine.resolution.reserveLaunchRun(
        task,
        "closeout",
        {},
        {
          firstReviewEntryWorker: false,
          firstWorkerSelection: null,
          prePrWorkerResume: false,
          retainedPrePrHead: null,
          resumingUnpublished: false,
        },
        {
          agentId: null,
          group: null,
          workspaceId: "ws",
          profile: null,
          coordinatorRouteSwitch: null,
          replacingReviewer: false,
          orphanRuns: () => [],
          threadBusy: () => false,
        },
      );
      assert.ok(runId);
      assert.equal(store.run(runId)?.status, "intent");
      const current = store.task(task.id);
      store.update(task.id, {
        phase: "done",
        resolution: { ...current.resolution, archivedWorkspaceIds: ["ws"] },
      });
    },
    (reopened) => new Engine(reopened, adapter, 0),
    async (reopened, sweep) => {
      await sweep();
      assert.ok(runId);
      assert.equal(reopened.run(runId)?.released, true);
      assert.equal(reopened.task(task.id).resolution.currentRunId, null);
      const events = reopened.eventsAll(task.id);
      assert.equal(
        events.filter((event) => event.kind === "run_intent_abandoned").length,
        1,
      );
      await sweep();
      assert.deepEqual(reopened.eventsAll(task.id), events);
    },
  );
});

for (const stopped of [true, false]) {
  const kind = stopped ? "paused_stop_intent" : "paused_resume_intent";
  const skip = stopped
    ? "The sweep reads only the post-send paused-stop marker"
    : "The sweep can resend an uncertain continuation before confirming it";
  test(`${kind} settles an observed delivery across a roll`, async (t) => {
    const { store } = tempStore(t);
    store.setMeta("paused", true);
    store.setMeta("hostId", "host");
    const initial = store.insert(
      submission(),
      "host",
      "handoff",
      "a".repeat(40),
    );
    const task = store.update(initial.id, {
      phase: "working",
      agentId: "worker",
      runId: "run",
      workspaceId: "ws",
    });
    let active = true;
    let continuations = 0;
    let stops = 0;
    const adapter = fakeAdapter({
      observe: async (id: string) => ({
        ...(await observeIdle("ws")(id)),
        active,
        status: active ? ("running" as const) : ("idle" as const),
      }),
      stopAgentTurn: async () => {
        stops++;
        active = false;
        if (stopped) throw Error("Stop delivered, reply lost");
      },
      continueWorker: async () => {
        continuations++;
        active = true;
        if (!stopped && continuations === 1)
          throw Error("Continuation delivered, reply lost");
      },
    });
    const engine = new Engine(store, adapter, 0);
    await restartAfterIntent(
      engine,
      task.id,
      kind,
      async () => {
        if (stopped)
          await assert.rejects(
            engine.stopActiveThreads(),
            /Stop delivered, reply lost/,
          );
        else await engine.stopActiveThreads();
        store.setMeta("paused", false);
        if (!stopped) await engine.resumePausedStops();
        assert.equal(stops, 1);
        assert.equal(continuations, stopped ? 0 : 1);
      },
      (reopened) => new Engine(reopened, adapter, 0),
      async (reopened, sweep) => {
        await sweep();
        await t.test(`${kind} restart outcome`, { skip }, async () => {
          assert.equal(reopened.task(task.id).pausedStop, undefined);
          assert.equal(continuations, 1);
          assert.equal(stops, 1);
          const events = reopened.eventsAll(task.id);
          await sweep();
          assert.deepEqual(reopened.eventsAll(task.id), events);
          assert.equal(continuations, 1);
        });
      },
    );
  });
}
