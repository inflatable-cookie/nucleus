import { test } from "./support/sharded-test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Engine } from "../core/engine";
import { Lifecycle } from "../core/closeout/workspace-lifecycle";
import { terminalBranchCandidates } from "../core/closeout/branch-cleanup";
import type { Adapter } from "../core/host/adapter";
import { HOOK_TEST_TIMEOUT_MS } from "./support/budgets";
import {
  archiverFor,
  engineAdapter,
  git,
  preservedFixture,
  setup,
} from "./support/preserved-retirement-fixture";

/**
 * nucleus#1548: closeout deletes the branch Nucleus created for a verified merge,
 * locally and on the forge, once the task worktree is removed. These tests drive
 * the real terminal cleanup pass over a real bare remote; only the forge PR read
 * is stubbed, because no test talks to GitHub.
 */

type Fixture = Awaited<ReturnType<typeof setup>>;

const localHead = (f: Fixture, branch: string) =>
  git(f.repo, "branch", "--list", branch);
const forgeHead = (f: Fixture, branch: string) =>
  git(f.repo, "ls-remote", "origin", `refs/heads/${branch}`);

function engineFor(
  f: Fixture,
  options: {
    openPrs?: { number: number; url: string }[];
    archiveWorkspace?: Adapter["archiveTaskWorkspace"];
    archived?: boolean;
  } = {},
) {
  const { adapter: archiver } = archiverFor(f);
  const adapter: Adapter = {
    ...engineAdapter(
      options.archiveWorkspace ??
        ((...args) => archiver.archiveTaskWorkspace!(...args)),
    ),
    taskWorkspaceArchived: async () => options.archived ?? false,
    findAnyOpenBranchPr: async () => options.openPrs ?? [],
  };
  const engine = new Engine(f.store, adapter, 0);
  return { engine, archiver, adapter };
}

const branchRecord = (f: Fixture) =>
  f.store
    .task(f.task.id)
    .resolution.branchCleanups.find((record) => record.branch === f.task.branch);

test(
  "a verified merge deletes the task branch locally and on the forge once the worktree is removed",
  { timeout: HOOK_TEST_TIMEOUT_MS },
  async (t) => {
    const f = await setup(t, true);
    const { engine } = engineFor(f);
    t.after(() => engine.stop());
    try {
      assert.match(forgeHead(f, f.task.branch), /refs\/heads\//, "the fixture published the branch first");
      assert.match(localHead(f, f.task.branch), new RegExp(f.task.branch));

      await new Lifecycle(engine).archive(f.store.task(f.task.id));

      assert.equal(existsSync(f.directory), false, "the task worktree is removed first");
      assert.equal(forgeHead(f, f.task.branch), "", "the forge branch is deleted");
      assert.equal(localHead(f, f.task.branch), "", "the local branch is deleted");
      const record = branchRecord(f);
      assert.equal(record?.state, "deleted");
      assert.equal(record?.head, f.head);
      const task = f.store.task(f.task.id);
      assert.equal(task.phase, "done");
      assert.ok(f.store.events(f.task.id).some((event) => event.kind === "task_branch_deleted"));
    } finally {
      f.store.close();
    }
  },
);

test(
  "a branch with another open PR is kept and nothing is deleted",
  { timeout: HOOK_TEST_TIMEOUT_MS },
  async (t) => {
    const f = await setup(t, true);
    const { engine } = engineFor(f, { openPrs: [{ number: 77, url: "https://example.invalid/77" }] });
    t.after(() => engine.stop());
    try {
      await new Lifecycle(engine).archive(f.store.task(f.task.id));
      assert.match(forgeHead(f, f.task.branch), /refs\/heads\//);
      assert.match(localHead(f, f.task.branch), new RegExp(f.task.branch));
      const record = branchRecord(f);
      assert.equal(record?.state, "kept");
      assert.match(record?.detail ?? "", /#77/);
      assert.equal(f.store.task(f.task.id).phase, "done");
    } finally {
      f.store.close();
    }
  },
);

test(
  "the repository default branch is never deleted",
  { timeout: HOOK_TEST_TIMEOUT_MS },
  async (t) => {
    const f = await setup(t, true);
    // The forge itself advertises the task branch as its default branch, and the
    // clone carries no cached origin/HEAD, so the cleanup reads that fresh answer.
    git(f.remote, "symbolic-ref", "HEAD", `refs/heads/${f.task.branch}`);
    try {
      git(f.repo, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
    } catch {
      /* A clone without a cached origin/HEAD already forces the forge read. */
    }
    const { engine } = engineFor(f);
    t.after(() => engine.stop());
    try {
      await new Lifecycle(engine).archive(f.store.task(f.task.id));
      assert.match(forgeHead(f, f.task.branch), /refs\/heads\//);
      assert.match(localHead(f, f.task.branch), new RegExp(f.task.branch));
      const record = branchRecord(f);
      assert.equal(record?.state, "kept");
      assert.match(record?.detail ?? "", /default branch/);
    } finally {
      f.store.close();
    }
  },
);

test(
  "a cancelled task keeps its branch because its work may be the only copy",
  { timeout: HOOK_TEST_TIMEOUT_MS },
  async (t) => {
    const f = await preservedFixture(t);
    try {
      assert.equal(f.cancelled.phase, "cancelled");
      // Even with merge evidence the candidate rule leaves a cancelled task alone.
      assert.deepEqual(
        terminalBranchCandidates(
          { ...f.store.task(f.task.id), phase: "cancelled" },
          f.store.runs(f.task.id),
        ),
        [],
      );
      await f.engine.lifecycle.archive(f.store.task(f.task.id));
      assert.match(forgeHead(f, f.task.branch), /refs\/heads\//);
      assert.match(localHead(f, f.task.branch), new RegExp(f.task.branch));
      assert.equal(f.store.task(f.task.id).resolution.branchCleanups.length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "a failed forge delete is recorded and retried without blocking done",
  { timeout: HOOK_TEST_TIMEOUT_MS },
  async (t) => {
    const f = await setup(t, true);
    // A real remote-side refusal: this bare remote rejects every ref deletion until
    // the hook is removed, so the first pass fails after a real delivery attempt.
    await mkdir(join(f.remote, "hooks"), { recursive: true });
    const rejectingHook = join(f.remote, "hooks", "pre-receive");
    await writeFile(
      rejectingHook,
      '#!/bin/sh\nwhile read old new ref; do\n  if [ "$new" = "0000000000000000000000000000000000000000" ]; then\n    echo "deletion refused by the remote" >&2\n    exit 1\n  fi\ndone\nexit 0\n',
    );
    await chmod(rejectingHook, 0o755);
    const { engine } = engineFor(f);
    t.after(() => engine.stop());
    try {
      await new Lifecycle(engine).archive(f.store.task(f.task.id));
      const failed = f.store.task(f.task.id);
      assert.equal(failed.phase, "done", "a branch cleanup never blocks closeout");
      assert.equal(failed.resolution.attention, false);
      assert.equal(failed.resolution.stop, null);
      const record = branchRecord(f);
      assert.equal(record?.state, "wait");
      assert.match(record?.detail ?? "", /deletion refused by the remote/);
      assert.ok(record?.nextAttemptAt, "the retry names its deadline");
      assert.match(forgeHead(f, f.task.branch), /refs\/heads\//, "the forge still holds it");

      // The cause clears; the recorded deadline passes and the same cleanup retries.
      await rm(rejectingHook);
      const current = f.store.task(f.task.id);
      f.store.update(
        current.id,
        {
          resolution: {
            ...current.resolution,
            branchCleanups: current.resolution.branchCleanups.map((item) =>
              item.branch === f.task.branch
                ? { ...item, nextAttemptAt: new Date(Date.now() - 1000).toISOString() }
                : item,
            ),
          },
        },
        "test_branch_cleanup_due",
        "the recorded deadline passed",
      );
      await new Lifecycle(engine).archive(f.store.task(f.task.id));

      assert.equal(forgeHead(f, f.task.branch), "");
      assert.equal(localHead(f, f.task.branch), "");
      assert.equal(branchRecord(f)?.state, "deleted");
    } finally {
      f.store.close();
    }
  },
);
