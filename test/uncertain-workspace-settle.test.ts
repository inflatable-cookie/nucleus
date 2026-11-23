import { after as restoreEnvironmentAfterTests, test } from "node:test";
const previousWorkRoot = process.env.NUCLEUS_WORK_ROOT;
const previousWorkVolumeId = process.env.NUCLEUS_WORK_VOLUME_ID;
process.env.NUCLEUS_WORK_ROOT = "/fixture/work";
process.env.NUCLEUS_WORK_VOLUME_ID = "";
restoreEnvironmentAfterTests(() => {
  if (previousWorkRoot === undefined) delete process.env.NUCLEUS_WORK_ROOT;
  else process.env.NUCLEUS_WORK_ROOT = previousWorkRoot;
  if (previousWorkVolumeId === undefined)
    delete process.env.NUCLEUS_WORK_VOLUME_ID;
  else process.env.NUCLEUS_WORK_VOLUME_ID = previousWorkVolumeId;
});
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fakeAdapter, observeIdle } from "./support/fakes";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { PaseoAdapter } from "../service/paseo-composition";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";
import { resolveExplicitly } from "../core/verbs/explicit-resolution";
import {
  WORKSPACE_INTENT_RELEASED,
  WORKSPACE_RELEASE_ATTEMPTS,
} from "../core/recovery/workspace-lookup";
import {
  OPERATOR_BOARD_CALLER,
  submissionSchema,
  type Profile,
  type Task,
} from "../shared/contracts";
import { explicitResolutionSchema } from "../shared/schema/task-control";
import type { Adapter } from "../core/host";

/**
 * Spec 068 batch A for workspaces: a first dispatch that recorded its workspace
 * intent and never bound a workspace settles by lookup. The stored shape is the
 * 2026-11-23 incident's: `workspaceIntent` with no workspace, no worker intent,
 * agent or run, phase `dispatching`, the populate started and never finished,
 * and the old generic lifecycle wait (fact `worker_lookup`) on the stop.
 */

const profile: Profile = {
  id: "worker",
  name: "worker",
  provider: "test",
  model: "test",
  notes: "",
  available: true,
  problem: "",
  supportedThinking: [],
};

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ns-ws-settle-repo-"));
  const run = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      {
        cwd: dir,
        encoding: "utf8",
      },
    ).trim();
  run("init", "-q", "-b", "main");
  run("commit", "-q", "--allow-empty", "-m", "base");
  return { dir, run, base: run("rev-parse", "HEAD") };
}

function fixture(options: { graceMs?: number; realInspection?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ns-ws-settle-"));
  const repo = gitRepo();
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  store.setMeta("pool", [
    {
      profileId: profile.id,
      enabled: true,
      group: "author",
      roles: ["worker"],
      weight: "default",
      scopes: ["general"],
    },
  ]);
  const calls = { workspaces: 0, agents: 0 };
  // The host's own worktree inspection over a real repository: the expected
  // directory, `git worktree list`, the branch locally and on remotes.
  const host = new PaseoAdapter(
    "ws://127.0.0.1:1",
    join(dir, "cb.sock"),
    join(dir, "report.mjs"),
  );
  host.scanForWorktreeAdd = () => ({ state: "absent" });
  const adapter: Adapter = fakeAdapter({
    profiles: async () => [profile],
    validate: async (t) => t.planningCommit,
    createWorkspace: async (t) => {
      calls.workspaces++;
      return { id: `ws-${t.id}`, directory: `/worktree/${t.id}` };
    },
    findWorkspaces: async () => [],
    verifyWorkspace: async (t) => t.branch,
    createAgent: async (t) => {
      calls.agents++;
      return { id: `agent-${t.runId}`, workspaceId: t.workspaceId };
    },
    observe: observeIdle("workspace"),
    verifyPr: async () => ({
      url: "https://example.invalid/pr/1",
      head: "a".repeat(40),
    }),
    ...(options.realInspection === false
      ? {}
      : {
          inspectWorkspaceCreation: (task: Task) =>
            host.inspectWorkspaceCreation(task),
          removeOrphanWorkspace: (
            task: Task,
            orphan: Parameters<
              NonNullable<Adapter["removeOrphanWorkspace"]>
            >[1],
          ) => host.removeOrphanWorkspace(task, orphan),
        }),
  });
  const engine = new Engine(store, adapter, options.graceMs ?? 0);
  engine.profiles = [profile];
  /** The incident's stored row, on a synthetic task. */
  const incidentShape = () => {
    const submitted = store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Task",
        repoPath: repo.dir,
        baseBranch: "main",
        planningCommit: repo.base,
        handoffPath: "docs/handoff.md",
        originAgentId: "origin",
      }),
      "host",
      "handoff",
      repo.base,
    );
    store.event(submitted.id, "dispatch_intent", profile.name);
    store.event(
      submitted.id,
      "workspace_populate_started",
      JSON.stringify({ budgetMs: 600000, branch: submitted.branch }),
    );
    const since = new Date().toISOString();
    const detail =
      "Workspace creation is uncertain; inspect the host and resolve explicitly";
    return store.update(submitted.id, {
      phase: "dispatching",
      planningBase: repo.base,
      workspaceIntent: true,
      workspaceId: null,
      directory: null,
      workspaceAllocation: null,
      agentIntent: false,
      agentId: null,
      runId: null,
      profile,
      profileGroup: "author",
      reason: detail,
      resolution: {
        ...store.task(submitted.id).resolution,
        stop: {
          reason: "lifecycle",
          detail,
          since,
          suggestedVerbs: [],
          fact: { code: "worker_lookup" },
        },
      },
    });
  };
  const events = (id: string, kind: string) =>
    store.eventsAll(id).filter((event) => event.kind === kind);
  return {
    store,
    engine,
    adapter,
    calls,
    repo,
    incidentShape,
    events,
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    },
  };
}

test("the incident shape with nothing on the host recovers to a fresh dispatch on its own", async () => {
  const f = fixture();
  try {
    const task = f.incidentShape();
    await f.engine.wake();
    await f.engine.wake();
    const released = f.events(task.id, WORKSPACE_INTENT_RELEASED);
    assert.equal(released.length, 1);
    assert.deepEqual(JSON.parse(released[0]!.detail), {
      automatic: true,
      branch: task.branch,
      found: "nothing",
    });
    const intents = f.events(task.id, "dispatch_intent");
    assert.equal(intents.length, 2, "ordinary dispatch ran again");
    assert.ok(intents[1]!.id > released[0]!.id);
    const current = f.store.task(task.id);
    assert.equal(f.calls.workspaces, 1);
    assert.equal(current.workspaceId, `ws-${task.id}`);
    assert.notEqual(current.resolution.stop?.fact?.code, "worker_lookup");
    assert.doesNotMatch(current.reason, /Workspace creation is uncertain/);
  } finally {
    await f.close();
  }
});

test("an empty unpublished leftover branch is removed, then the task dispatches fresh", async () => {
  const f = fixture();
  try {
    const task = f.incidentShape();
    f.repo.run("branch", task.branch);
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(f.repo.run("branch", "--list", task.branch), "");
    const removed = f.events(task.id, "orphan_workspace_removed");
    assert.equal(removed.length, 1);
    assert.equal(JSON.parse(removed[0]!.detail).automatic, true);
    const released = f.events(task.id, WORKSPACE_INTENT_RELEASED);
    assert.equal(JSON.parse(released[0]!.detail).found, "empty_branch");
    assert.equal(f.calls.workspaces, 1);
  } finally {
    await f.close();
  }
});

test("a task branch with commits or a pushed ref is never touched", async () => {
  for (const shape of ["commits", "pushed"] as const) {
    const f = fixture();
    const remote = mkdtempSync(join(tmpdir(), "ns-ws-settle-remote-"));
    try {
      const task = f.incidentShape();
      if (shape === "commits") {
        f.repo.run("checkout", "-q", "-b", task.branch);
        f.repo.run("commit", "-q", "--allow-empty", "-m", "work");
        f.repo.run("checkout", "-q", "main");
      } else {
        execFileSync("git", ["init", "-q", "--bare", remote]);
        f.repo.run("remote", "add", "origin", remote);
        f.repo.run("branch", task.branch);
        f.repo.run("push", "-q", "origin", task.branch);
      }
      const head = f.repo.run("rev-parse", task.branch);
      await f.engine.wake();
      await f.engine.wake();
      assert.equal(f.repo.run("rev-parse", task.branch), head, shape);
      const current = f.store.task(task.id);
      assert.equal(current.workspaceIntent, true, shape);
      assert.equal(current.phase, "needs_attention", shape);
      assert.match(
        current.reason,
        shape === "commits" ? /commits beyond base/ : /exists on a remote/,
      );
      assert.equal(f.events(task.id, WORKSPACE_INTENT_RELEASED).length, 0);
      assert.equal(f.events(task.id, "orphan_workspace_removed").length, 0);
      assert.equal(f.calls.workspaces, 0);
    } finally {
      await f.close();
      rmSync(remote, { recursive: true, force: true });
    }
  }
});

test("a partial or failed read, a running create or an unfinished grace waits with a named reason", async () => {
  const cases: {
    name: string;
    graceMs?: number;
    setup: (adapter: Adapter) => void;
    reason: RegExp;
  }[] = [
    {
      name: "partial read",
      setup: (adapter) => {
        adapter.inspectWorkspaceCreation = async () => ({
          kind: "unknown",
          evidence: "Git worktree inventory could not be read",
        });
      },
      reason:
        /host read was partial \(Git worktree inventory could not be read\)/,
    },
    {
      name: "failed inventory",
      setup: (adapter) => {
        adapter.findWorkspaces = async () => {
          throw new Error("inventory timed out");
        };
      },
      reason: /workspace inventory could not be read \(inventory timed out\)/,
    },
    {
      name: "running create",
      setup: (adapter) => {
        adapter.inspectWorkspaceCreation = async () => ({
          kind: "still_running",
          evidence: "git worktree add is live at pid 4242",
        });
      },
      reason: /create is still running/,
    },
    {
      name: "grace",
      graceMs: 60_000,
      setup: () => {},
      reason: /grace period ends at/,
    },
  ];
  for (const item of cases) {
    const f = fixture({ graceMs: item.graceMs });
    try {
      item.setup(f.adapter);
      const task = f.incidentShape();
      await f.engine.wake();
      const current = f.store.task(task.id);
      assert.equal(current.workspaceIntent, true, item.name);
      assert.equal(current.phase, "dispatching", item.name);
      assert.equal(current.resolution.stop?.reason, "lifecycle", item.name);
      assert.deepEqual(
        current.resolution.stop?.fact,
        { code: "workspace_lookup", subject: task.branch },
        item.name,
      );
      assert.match(current.reason, item.reason, item.name);
      assert.match(current.reason, /record\.clear kind=workspace_intent/);
      assert.equal(f.events(task.id, WORKSPACE_INTENT_RELEASED).length, 0);
      assert.equal(f.calls.workspaces, 0, item.name);
    } finally {
      await f.close();
    }
  }
});

test("a workspace the host lists is bound, not recreated", async () => {
  const f = fixture();
  try {
    const task = f.incidentShape();
    f.adapter.findWorkspaces = async () => [
      { id: "ws-listed", directory: "/worktree/listed" },
    ];
    await f.engine.wake();
    const current = f.store.task(task.id);
    assert.equal(current.workspaceId, "ws-listed");
    assert.equal(f.events(task.id, "workspace_recovered").length, 1);
    assert.equal(f.events(task.id, WORKSPACE_INTENT_RELEASED).length, 0);
    assert.equal(f.calls.workspaces, 0);
  } finally {
    await f.close();
  }
});

test("past the release bound the task records a typed stop whose explicit command releases it", async () => {
  const f = fixture();
  try {
    const task = f.incidentShape();
    for (let i = 0; i < WORKSPACE_RELEASE_ATTEMPTS; i++)
      f.store.event(
        task.id,
        WORKSPACE_INTENT_RELEASED,
        JSON.stringify({
          automatic: true,
          branch: task.branch,
          found: "nothing",
        }),
      );
    await f.engine.wake();
    const stopped = f.store.task(task.id);
    assert.equal(stopped.workspaceIntent, true);
    assert.equal(stopped.resolution.stop?.reason, "operator_needed");
    assert.deepEqual(stopped.resolution.stop?.fact, {
      code: "workspace_lookup",
      subject: task.branch,
    });
    assert.match(
      stopped.reason,
      new RegExp(`record\\.clear kind=workspace_intent id=${task.branch}`),
    );
    assert.equal(
      f.events(task.id, WORKSPACE_INTENT_RELEASED).length,
      WORKSPACE_RELEASE_ATTEMPTS,
      "no fourth automatic release",
    );

    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, stopped));
    const offered = next.explicitCommands?.find(
      (command) =>
        command.action === "record.clear" &&
        command.args.kind === "workspace_intent",
    );
    assert.ok(offered, "next lists the explicit release");
    assert.equal(offered!.args.id, task.branch);
    assert.deepEqual(offered!.warnings, ["workspace_may_exist"]);

    const input = {
      action: "record.clear",
      taskId: task.id,
      version: stopped.version,
      kind: "workspace_intent",
      id: task.branch,
      reason: "Host checked: no branch, worktree or remote ref",
      caller: OPERATOR_BOARD_CALLER,
    };
    const warned = await resolveExplicitly(
      f.engine,
      explicitResolutionSchema.parse(input),
      () => "",
    );
    assert.equal(warned.explicitResolution?.status, "warnings");
    assert.deepEqual(
      warned.explicitResolution?.warnings.map((warning) => warning.id),
      ["workspace_may_exist"],
    );
    assert.equal(f.store.task(task.id).workspaceIntent, true);
    const applied = await resolveExplicitly(
      f.engine,
      explicitResolutionSchema.parse({
        ...input,
        accept: ["workspace_may_exist"],
      }),
      () => "",
    );
    assert.equal(applied.explicitResolution?.status, "applied");
    const released = f.store.task(task.id);
    assert.equal(released.workspaceIntent, false);
    assert.equal(released.phase, "queued");
    assert.equal(released.resolution.stop, null);
    const explicit = f.events(task.id, WORKSPACE_INTENT_RELEASED).at(-1)!;
    assert.equal(JSON.parse(explicit.detail).automatic, false);

    // The explicit release resets the bound, and ordinary dispatch runs again.
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(f.calls.workspaces, 1);
    assert.equal(f.store.task(task.id).workspaceId, `ws-${task.id}`);
  } finally {
    await f.close();
  }
});

test("record.clear kind=workspace_intent refuses a task with nothing uncertain", async () => {
  const f = fixture();
  try {
    const task = f.incidentShape();
    f.store.update(task.id, {
      workspaceId: "ws-bound",
      directory: "/worktree/bound",
    });
    const current = f.store.task(task.id);
    await assert.rejects(
      () =>
        resolveExplicitly(
          f.engine,
          explicitResolutionSchema.parse({
            action: "record.clear",
            taskId: task.id,
            version: current.version,
            kind: "workspace_intent",
            id: task.branch,
            reason: "Nothing to release",
            accept: ["workspace_may_exist"],
            caller: OPERATOR_BOARD_CALLER,
          }),
          () => "",
        ),
      /No current workspace_intent/,
    );
    assert.equal(f.store.task(task.id).workspaceIntent, true);
  } finally {
    await f.close();
  }
});
