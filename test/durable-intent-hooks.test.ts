import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { git } from "../core/git/index";
import { discoverManifest } from "../core/hooks/hooks";
import { configuredClone, materializeSeed } from "./support/git-seed";
import {
  assertRetry,
  deferredRestart,
  intentFixture,
  lostReply,
  restartAfterIntent,
} from "./support/intent-restart";

const hook = {
  id: "ledger",
  events: ["task.closeout"],
  mode: "integration_write",
  delivery: "required",
  executable: ".paseo/hooks/ledger",
  argv: [],
  timeoutMs: 30000,
  maxOutputBytes: 65536,
  allowedPaths: ["ledger.txt"],
  commitSubject: { prefix: "fixture hook", maxBytes: 80 },
};
const prospective = {
  id: "gate",
  events: ["task.pre_merge"],
  mode: "read_only",
  target: "prospective_merge",
  delivery: "required",
  program: { kind: "repository", executable: ".paseo/hooks/ledger", argv: [] },
  timeoutMs: 30000,
  maxOutputBytes: 65536,
  allowedPaths: [],
  commitSubject: null,
};

async function repoFixture(t: TestContext, gate = false) {
  const f = intentFixture(t, {
    observe: async (id) => ({
      id,
      workspaceId: "ws",
      status: "running",
      active: true,
      permissions: false,
      error: "",
    }),
  });
  await materializeSeed(configuredClone, f.dir);
  const repo = join(f.dir, "repo");
  await mkdir(join(repo, ".paseo", "hooks"), { recursive: true });
  const executable = join(repo, ".paseo", "hooks", "ledger");
  const log = join(f.dir, "invocations");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const event = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, event.eventId + '\\n');
fs.writeFileSync('ledger.txt', event.eventId + '\\n');
process.stdout.write(JSON.stringify({ schema: 'paseo.queue.hook-result.v1', eventId: event.eventId,
  outcome: 'ok', summary: 'Fixture publish', metadata: {}, changedPaths: ['ledger.txt'], commitSubjectSuffix: null }));
`,
  );
  await chmod(executable, 0o755);
  await writeFile(
    join(repo, ".paseo", "queue.json"),
    JSON.stringify({
      schema: gate ? "paseo.queue.control.v4" : "paseo.queue.control.v1",
      hooks: [gate ? prospective : hook],
    }),
  );
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "Hook fixture");
  await git(repo, "push", "origin", "main");
  const base = await git(repo, "rev-parse", "HEAD");
  f.store.update(f.id, {
    repoPath: repo,
    directory: repo,
    planningBase: base,
    prHead: base,
  });
  const discovery = (await discoverManifest(repo, base))!;
  assert.ok(discovery);
  const context = { event: "task.closeout" as const, baseCommit: base };
  const hooks = f.engine.hooks;
  const emit = () => hooks.emit(context.event, f.task(), context);
  const record = () => f.store.hookEvents(f.id).at(-1)!;
  return { ...f, repo, base, log, hooks, discovery, context, emit, record };
}

type Fixture = Awaited<ReturnType<typeof repoFixture>>;

/** Fail at the real persistence boundary, after the write and before the next external operation. */
async function cutAtEvent(
  f: Fixture,
  kind: string,
  write: () => Promise<unknown>,
) {
  const event = f.store.event.bind(f.store);
  f.store.event = (...args) => {
    const id = event(...args);
    if (args[1] === kind) throw lostReply;
    return id;
  };
  try {
    await assert.rejects(write(), lostReply);
  } finally {
    f.store.event = event;
  }
}

test("hook_intent applies the pinned occurrence after a roll", async (t) => {
  const f = await repoFixture(t);
  await restartAfterIntent(
    f.engine,
    f.id,
    "hook_intent",
    async () => {
      await f.hooks["intent"](
        f.task(),
        f.discovery.manifest.hooks[0]!,
        f.discovery,
        f.context,
      );
      assert.equal(existsSync(f.log), false);
    },
    f.start,
    async (store, sweep) => {
      await sweep();
      assert.equal(store.hookEvents(f.id).at(-1)?.state, "published");
      const events = store.eventsAll(f.id);
      await sweep();
      assert.deepEqual(store.eventsAll(f.id), events);
      assert.equal(store.hookEvents(f.id).length, 1);
    },
  );
});

for (const state of [
  "workspace_intent",
  "commit_intent",
  "push_intent",
  "sync_intent",
  "cleanup_intent",
] as const) {
  const name =
    state === "workspace_intent"
      ? "hook_workspace_intent / workspace_intent"
      : state;
  test(`${name} restarts at the persisted Git publication boundary`, async (t) => {
    const f = await repoFixture(t);
    const occurrences = f.hooks["occurrences"];
    const save = occurrences.save.bind(occurrences);
    const count = (store: typeof f.store) =>
      store.hookEvents(f.id).filter((r) => r.state === state).length;
    await restartAfterIntent(
      f.engine,
      f.id,
      count,
      async () => {
        if (state === "workspace_intent") {
          await cutAtEvent(f, "hook_workspace_intent", f.emit);
          assert.equal(
            f.kinds().filter((kind) => kind === "hook_workspace_intent").length,
            1,
          );
        } else {
          occurrences.save = (...args) => {
            const next = save(...args);
            if (next.state === state) throw lostReply;
            return next;
          };
          try {
            await assert.rejects(f.emit(), lostReply);
          } finally {
            occurrences.save = save;
          }
        }
        assert.equal(f.record().state, state);
        if (state === "push_intent") {
          const { commit, workspace } = f.record();
          assert.ok(commit && workspace);
          // The remote accepted the commit before the acknowledgement was lost.
          await git(
            workspace.path,
            "push",
            "origin",
            `${commit}:refs/heads/main`,
          );
        }
      },
      f.start,
      async (store, sweep) => {
        await sweep();
        const record = store.hookEvents(f.id).at(-1)!;
        if (record.state !== "published")
          assertRetry(store, f.id, `hook.${record.eventId}`);
        else {
          assert.ok(record.commit);
          assert.equal(await git(f.repo, "rev-parse", "HEAD"), record.commit);
          assert.equal(
            await git(f.repo, "rev-list", "--count", `${f.base}..HEAD`),
            "1",
          );
        }
        const events = store.eventsAll(f.id);
        await sweep();
        assert.deepEqual(store.eventsAll(f.id), events);
        assert.equal(store.hookEvents(f.id).length, 1);
      },
    );
  });
}

test("hook_unpublished_checkout_discard_intent holds the exact operator disposal across a roll", async (t) => {
  const f = await repoFixture(t);
  f.store.update(f.id, { phase: "closing" });
  f.engine.resolution.update(f.task(), {
    syncedCommit: f.base,
    mergedCommit: f.base,
  });
  const record = await f.hooks["intent"](
    f.task(),
    f.discovery.manifest.hooks[0]!,
    f.discovery,
    f.context,
  );
  assert.ok(record.workspace);
  await mkdir(record.workspace.path, { recursive: true });
  f.hooks["occurrences"].uncertain(
    record,
    "Fixture stopped before isolated checkout creation",
  );
  await restartAfterIntent(
    f.engine,
    f.id,
    "hook_unpublished_checkout_discard_intent",
    async () => {
      await cutAtEvent(f, "hook_unpublished_checkout_discard_intent", () =>
        f.hooks.retry(f.task(), record.eventId, true, true),
      );
      f.store.update(f.id, { phase: "done", workspaceId: null });
    },
    f.start,
    async (store, sweep) => {
      await sweep();
      assertRetry(store, f.id, `hook.${record.eventId}`);
      assert.ok(existsSync(record.workspace!.path));
      const events = store.eventsAll(f.id);
      await sweep();
      assert.deepEqual(store.eventsAll(f.id), events);
    },
  );
});

test("hook_automatic_replay_intent records the replay ordinal before the replacement occurrence", async (t) => {
  const f = await repoFixture(t);
  f.store.update(f.id, { phase: "closing" });
  f.engine.resolution.update(f.task(), {
    syncedCommit: f.base,
    mergedCommit: f.base,
  });
  await git(f.repo, "commit", "--allow-empty", "-m", "Advance base");
  await git(f.repo, "push", "origin", "main");
  await f.emit();
  assert.equal(f.record().state, "blocked");
  const baseCommit = await git(f.repo, "rev-parse", "HEAD");
  const discovery = (await discoverManifest(f.repo, baseCommit))!;
  await deferredRestart(
    t,
    f,
    "hook_automatic_replay_intent",
    async () => {
      await cutAtEvent(f, "hook_automatic_replay_intent", () =>
        f.hooks["automaticReplay"](
          f.task(),
          discovery.manifest.hooks[0]!,
          discovery,
          baseCommit,
          { ...f.context, baseCommit },
        ),
      );
      f.store.update(f.id, { phase: "done", workspaceId: null });
    },
    "A terminal task has no applicable gate to consume the recorded replay ordinal",
    (store) => {
      assert.equal(
        store.hookEvents(f.id).filter((r) => r.replay?.ordinal === 1).length,
        1,
      );
    },
  );
});

test("pre_merge_candidate_intent precedes work on the exact candidate", async (t) => {
  const f = await repoFixture(t, true);
  const owner = f.hooks["prospectiveMerge"];
  owner.buildProspectiveCandidate = async () => {
    throw lostReply;
  };
  await deferredRestart(
    t,
    f,
    "pre_merge_candidate_intent",
    async () => {
      await assert.rejects(
        f.hooks.prospectiveMergeGate(f.task(), { head: f.base }),
        lostReply,
      );
      f.store.update(f.id, { phase: "done", workspaceId: null });
    },
    "The candidate writer is only reached through a live merge gate",
    (store) => {
      assert.ok(
        store
          .eventsAll(f.id)
          .some((e) => e.kind === "pre_merge_candidate_created"),
      );
    },
  );
});

for (const candidate of [true, false]) {
  const kind = candidate
    ? "project_validation_candidate_intent"
    : "project_validation_intent";
  test(`${kind} records the exact candidate before scheduler delivery`, async (t) => {
    const f = await repoFixture(t, true);
    await git(f.repo, "rm", ".paseo/queue.json");
    await git(
      f.repo,
      "commit",
      "-m",
      "Use project validation without a repository manifest",
    );
    await git(f.repo, "push", "origin", "main");
    const base = await git(f.repo, "rev-parse", "HEAD");
    f.store.update(f.id, { prHead: base });
    if (!candidate) {
      // Supply the exact Git proof so this case reaches the scheduler intent.
      const tree = await git(f.repo, "rev-parse", "HEAD^{tree}");
      f.hooks["buildProspectiveCandidate"] = async () => ({
        kind: "built",
        candidate: {
          integrationBase: base,
          reviewedHead: base,
          commit: base,
          tree,
        },
      });
    }
    const validate = () =>
      f.hooks.projectValidationGate(f.task(), base, {
        argv: ["effigy", "check"],
        timeoutMs: 30000,
        maxOutputBytes: 4096,
      });

    await deferredRestart(
      t,
      f,
      kind,
      async () => {
        if (candidate) await cutAtEvent(f, kind, validate);
        else {
          const update = f.store.update.bind(f.store);
          f.store.update = (...args) => {
            const task = update(...args);
            if (args[2] === kind) throw lostReply;
            return task;
          };
          try {
            await assert.rejects(validate(), lostReply);
          } finally {
            f.store.update = update;
          }
        }
        f.store.update(f.id, { phase: "done", workspaceId: null });
      },
      "A terminal task does not resume an interrupted project validation gate",
      (store) => {
        assertRetry(store, f.id, "project-validation.project-validation");
      },
    );
  });
}
