import { observeIdle } from './support/fakes';
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { git, command } from "../core/git/index";
import {
  RuntimeRetirementService, configMarksEphemeral, parseScopeQuery, type EffigyAttempt, type EffigyInvoke,
} from "../core/runtime/runtime-retirement";
import { archiveUnusedWorkspace } from "../core/workspaces/unused-workspace";
import * as api from "../shared/contracts";
import { submissionSchema, type Profile } from "../shared/contracts";
import type { Adapter } from "../core/host";

const profile: Profile = { id: "worker", name: "Worker", provider: "test", model: "test", notes: "", available: true, problem: "", supportedThinking: ["low"] };
const ok = (output = ""): EffigyAttempt => ({ code: 0, timedOut: false, spawnError: "", output });
const failed = (code: number, output = ""): EffigyAttempt => ({ code, timedOut: false, spawnError: "", output });
const timedOut = (output = ""): EffigyAttempt => ({ code: null, timedOut: true, spawnError: "", output });

async function identity(repo: string) {
  await git(repo, "config", "user.name", "Queue test");
  await git(repo, "config", "user.email", "queue@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
}

async function gitInit(directory: string) {
  await command("git", ["init", "--initial-branch=main", directory], dirname(directory));
  await identity(directory);
  await writeFile(join(directory, "README.md"), "one\n");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "init");
  return git(directory, "rev-parse", "HEAD");
}

/** A primary checkout plus one linked worktree, each on its own branch. */
async function linkedWorktree(t: TestContext, base: string, branch = "ns-task") {
  const primary = join(base, `primary-${randomUUID().slice(0, 8)}`);
  const head = await gitInit(primary);
  const worktree = join(base, `worker-${randomUUID().slice(0, 8)}`);
  await git(primary, "worktree", "add", "-b", branch, worktree, head);
  const gitDir = await git(worktree, "rev-parse", "--absolute-git-dir");
  assert.notEqual(gitDir, await git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  return { primary, worktree, gitDir, head, branch };
}

function storeFor(t: TestContext, base: string) {
  const store = new Store(join(base, "queue.sqlite"));
  store.setMeta("paused", false);
  t.after(() => store.close());
  return store;
}

function fakeEffigy(handlers: { scope?: () => EffigyAttempt; retire?: () => EffigyAttempt } = {}) {
  const calls: string[][] = [];
  const invoke: EffigyInvoke = async args => {
    calls.push(args);
    if (args[1] === "scope") return handlers.scope ? handlers.scope() : failed(2, "error: unrecognized subcommand 'scope'");
    if (args[1] === "retire") return handlers.retire ? handlers.retire() : ok("[ok] runtime scope has no owned resources left");
    return failed(1, "unexpected command");
  };
  return { invoke, calls };
}

async function submit(store: Store, repoPath: string, planningCommit: string, title = "Task") {
  return store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title, repoPath, planningCommit, handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "handoff", planningCommit);
}

test("scope parsing and the ephemeral marker read only the documented shape", () => {
  assert.deepEqual(parseScopeQuery(JSON.stringify({ checkout: "/w", scope: { kind: "worktree", token: "c".repeat(32) } })), { kind: "worktree", token: "c".repeat(32) });
  assert.deepEqual(parseScopeQuery(JSON.stringify({ scope: { kind: "none", token: null } })), { kind: "none", token: null });
  assert.equal(parseScopeQuery("not json"), null);
  assert.equal(parseScopeQuery(JSON.stringify({ scope: { kind: "worktree", token: "short" } })), null);
  assert.equal(parseScopeQuery(JSON.stringify({ scope: { kind: "primary", token: null } }))?.kind, "none");
  assert.equal(configMarksEphemeral('[effigy]\n\truntimeScope = ephemeral\n'), true);
  assert.equal(configMarksEphemeral('[effigy "prod"]\n\truntimeScope = ephemeral\n'), false);
  assert.equal(configMarksEphemeral('[include]\n\tpath = other\n'), false);
  assert.equal(configMarksEphemeral('# [effigy]\n'), false);
});

test("a scoped worktree captures its token through effigy container scope --json and retires by scope", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-query-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const { primary, worktree, gitDir, head } = await linkedWorktree(t, base);
  await writeFile(join(gitDir, "effigy-runtime-scope"), "a".repeat(32));
  const queryToken = "c".repeat(32);
  const { invoke, calls } = fakeEffigy({
    scope: () => ok(JSON.stringify({ schema: "effigy.container.scope.v1", checkout: worktree, scope: { kind: "worktree", token: queryToken } })),
  });
  const store = storeFor(t, base);
  const task = await submit(store, primary, head);
  const service = new RuntimeRetirementService(store, invoke);

  const record = await service.capture(task.id, "ws", worktree);
  assert.deepEqual(record?.scope, { kind: "worktree", token: queryToken });
  assert.deepEqual(calls[0], ["container", "scope", "--json"]);
  await service.archived(task.id, "ws");
  assert.deepEqual(calls.at(-1), ["container", "retire", "--scope", queryToken, "--yes"]);
  const after = store.task(task.id).resolution.runtimeRetirements[0];
  assert.equal(after.state, "retired");
  assert.equal(api.runtimeRetirementFailure(store.task(task.id)), "");
});

test("without the scope query the token comes from the linked worktree's private Git directory", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-file-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const { primary, worktree, gitDir, head } = await linkedWorktree(t, base);
  const fileToken = "b".repeat(32);
  await writeFile(join(gitDir, "effigy-runtime-scope"), fileToken);
  const { invoke, calls } = fakeEffigy();
  const store = storeFor(t, base);
  const task = await submit(store, primary, head);
  const service = new RuntimeRetirementService(store, invoke);

  const record = await service.capture(task.id, "ws", worktree);
  assert.deepEqual(record?.scope, { kind: "worktree", token: fileToken });
  await service.archived(task.id, "ws");
  assert.deepEqual(calls.at(-1), ["container", "retire", "--scope", fileToken, "--yes"]);
  assert.equal(store.task(task.id).resolution.runtimeRetirements[0].state, "retired");
});

test("an unscoped checkout records no runtime scope and never calls retire", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-none-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const primary = join(base, "primary");
  const head = await gitInit(primary);
  const { invoke, calls } = fakeEffigy();
  const store = storeFor(t, base);
  const task = await submit(store, primary, head);
  const service = new RuntimeRetirementService(store, invoke);

  const record = await service.capture(task.id, "ws", primary);
  assert.equal(record?.state, "none");
  assert.equal(record?.scope, null);
  await service.archived(task.id, "ws");
  assert.equal(calls.some(args => args[1] === "retire"), false);
  assert.equal(store.task(task.id).resolution.runtimeRetirements[0].state, "none");
});

test("a marked ephemeral clone is captured from its own .git/effigy-runtime-scope", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-clone-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const origin = join(base, "origin");
  const head = await gitInit(origin);
  const clone = join(base, "clone");
  await command("git", ["clone", origin, clone], base);
  await git(clone, "config", "effigy.runtimeScope", "ephemeral");
  const token = "d".repeat(32);
  await writeFile(join(clone, ".git", "effigy-runtime-scope"), token);
  const { invoke } = fakeEffigy();
  const store = storeFor(t, base);
  const task = await submit(store, clone, head);
  const service = new RuntimeRetirementService(store, invoke);

  const record = await service.capture(task.id, "ws", clone);
  assert.deepEqual(record?.scope, { kind: "ephemeral-clone", token });
});

test("a non-zero retire flags the cleanup with its output tail and keeps the retry; success clears it", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-fail-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const { primary, worktree, gitDir, head } = await linkedWorktree(t, base);
  await writeFile(join(gitDir, "effigy-runtime-scope"), "e".repeat(32));
  let attempt = 0;
  const { invoke } = fakeEffigy({ retire: () => (++attempt === 1 ? failed(3, "[error] runtime scope still owns 1 resource(s)\nremaining container: web-abc") : ok()) });
  const store = storeFor(t, base);
  const task = await submit(store, primary, head);
  const service = new RuntimeRetirementService(store, invoke);

  await service.capture(task.id, "ws", worktree);
  await service.archived(task.id, "ws");
  const failedRecord = store.task(task.id).resolution.runtimeRetirements[0];
  assert.equal(failedRecord.state, "failed");
  assert.equal(failedRecord.attempts, 1);
  assert.match(failedRecord.error, /runtime retirement failed/);
  assert.match(failedRecord.outputTail, /remaining container: web-abc/);
  assert.ok(failedRecord.nextAttemptAt);
  assert.match(api.runtimeRetirementFailure(store.task(task.id)), /runtime retirement failed/);

  await service.retryNow(task.id);
  const retired = store.task(task.id).resolution.runtimeRetirements[0];
  assert.equal(retired.state, "retired");
  assert.equal(retired.attempts, 2);
  assert.equal(api.runtimeRetirementFailure(store.task(task.id)), "");
  assert.equal(store.task(task.id).resolution.cleanupReason, "");
});

test("a retire timeout is flagged", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-timeout-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const { primary, worktree, gitDir, head } = await linkedWorktree(t, base);
  await writeFile(join(gitDir, "effigy-runtime-scope"), "f".repeat(32));
  const { invoke } = fakeEffigy({ retire: () => timedOut("retiring ...") });
  const store = storeFor(t, base);
  const task = await submit(store, primary, head);
  const service = new RuntimeRetirementService(store, invoke);

  await service.capture(task.id, "ws", worktree);
  await service.archived(task.id, "ws");
  const record = store.task(task.id).resolution.runtimeRetirements[0];
  assert.equal(record.state, "failed");
  assert.match(record.error, /timed out/);
  assert.ok(record.nextAttemptAt);
});

test("a crash between archive and proof leaves a pending record the retry runs after restart", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-crash-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const { primary, worktree, gitDir, head } = await linkedWorktree(t, base);
  const token = "1".repeat(32);
  await writeFile(join(gitDir, "effigy-runtime-scope"), token);
  const first = fakeEffigy({ retire: () => { throw new Error("process crashed before proof"); } });
  const store = storeFor(t, base);
  const task = await submit(store, primary, head);
  let service = new RuntimeRetirementService(store, first.invoke);

  await service.capture(task.id, "ws", worktree);
  // The archive-success transaction flips the captured record to `pending`; the
  // process then dies before the proof runs.
  const captured = store.task(task.id);
  store.update(task.id, { resolution: { ...captured.resolution, archivedWorkspaceIds: ["ws"], runtimeRetirements: service.markArchived(captured, "ws") } });

  const restarted = fakeEffigy({ retire: () => ok("[ok] retired 2 owned runtime resource(s)") });
  service = new RuntimeRetirementService(store, restarted.invoke);
  await service.retryDue(task.id);

  assert.deepEqual(restarted.calls.at(-1), ["container", "retire", "--scope", token, "--yes"]);
  assert.equal(store.task(task.id).resolution.runtimeRetirements[0].state, "retired");
});

test("the done-task archive path captures the token and proves retirement", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-done-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const { primary, worktree, gitDir, head } = await linkedWorktree(t, base);
  const token = "2".repeat(32);
  await writeFile(join(gitDir, "effigy-runtime-scope"), token);
  const store = storeFor(t, base);
  const inserted = await submit(store, primary, head);
  const task = store.update(inserted.id, {
    phase: "done", workspaceId: "ws", directory: worktree, prHead: head, prUrl: "https://github.com/example/repo/pull/1",
    resolution: { ...inserted.resolution, mergedCommit: head, syncedCommit: head },
  });
  const { invoke, calls } = fakeEffigy();
  const adapter = {
    archiveTaskWorkspace: async (_task: unknown, _id: string, _dir: string, _head: string, allowed: () => boolean) => allowed(),
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0, () => true, new RuntimeRetirementService(store, invoke));
  t.after(() => engine.stop());

  engine.enqueueCleanup(task.id);
  await engine.drainCleanup();

  const after = store.task(task.id);
  assert.deepEqual(after.resolution.archivedWorkspaceIds, ["ws"]);
  assert.deepEqual(calls.at(-1), ["container", "retire", "--scope", token, "--yes"]);
  assert.equal(after.resolution.runtimeRetirements[0].state, "retired");
  assert.equal(api.runtimeRetirementFailure(after), "");
});

test("the cancelled-task archive path captures the token and proves retirement", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-cancel-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const origin = join(base, "origin.git");
  await command("git", ["init", "--bare", "--initial-branch=main", origin], base);
  const primary = join(base, "primary");
  await command("git", ["clone", origin, primary], base);
  await identity(primary);
  await writeFile(join(primary, "README.md"), "one\n");
  await git(primary, "add", "-A");
  await git(primary, "commit", "-m", "init");
  await git(primary, "push", "origin", "main");
  const head = await git(primary, "rev-parse", "HEAD");
  const store = storeFor(t, base);
  const inserted = await submit(store, primary, head);
  const worktree = join(base, "worker");
  await git(primary, "worktree", "add", "-b", inserted.branch, worktree, head);
  await git(worktree, "push", "-u", "origin", inserted.branch);
  const token = "3".repeat(32);
  const gitDir = await git(worktree, "rev-parse", "--absolute-git-dir");
  await writeFile(join(gitDir, "effigy-runtime-scope"), token);
  let archived = false;
  const adapter = {
    observe: observeIdle("ws", "agent"),
    archiveAgent: async () => {},
    archiveTaskWorkspace: async (_task: unknown, _id: string, _dir: string, _head: string, allowed: () => boolean, uncertain: boolean) => {
      if (uncertain) archived = true;
      return allowed();
    },
    taskWorkspaceArchived: async () => archived,
  } as unknown as Adapter;
  let failProof = true;
  const { invoke, calls } = fakeEffigy({ retire: () => failProof ? failed(1, "runtime remains") : ok() });
  const engine = new Engine(store, adapter, 0, () => true, new RuntimeRetirementService(store, invoke));
  t.after(() => engine.stop());
  store.setMeta("paused", false);
  const task = store.update(inserted.id, {
    phase: "working", workspaceIntent: true, workspaceId: "ws", directory: worktree, planningBase: head, runId: "run-1", reason: "Worker running",
  });

  await engine.disposeTask({ taskId: task.id, version: task.version, action: "cancel", reason: "Zero-work duplicate" });

  const after = store.task(task.id);
  assert.equal(after.phase, "cancelled");
  assert.deepEqual(calls.at(-1), ["container", "retire", "--scope", token, "--yes"]);
  assert.equal(after.disposition?.workspaceArchived, true);
  assert.equal(after.resolution.runtimeRetirements[0]?.state, "failed");
  failProof = false;
  await engine.retryRuntimeRetirement(task.id, after.version);
  assert.equal(store.task(task.id).resolution.runtimeRetirements[0]?.state, "retired");
});

test("the duplicate-cleanup archive path captures the token and proves retirement", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-dup-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const planningBase = await gitInit(repo);
  const store = storeFor(t, base);
  const inserted = await submit(store, repo, planningBase, "Unused");
  const old = join(base, "old");
  await git(repo, "worktree", "add", "-b", inserted.branch, old, planningBase);
  const token = "4".repeat(32);
  const gitDir = await git(old, "rev-parse", "--absolute-git-dir");
  await writeFile(join(gitDir, "effigy-runtime-scope"), token);
  await writeFile(join(repo, "later"), "later");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "advance");
  const task = store.update(inserted.id, {
    phase: "needs_attention", workspaceId: "retained", directory: join(base, "retained"), workspaceIntent: true,
    planningBase: await git(repo, "rev-parse", "HEAD"),
  });
  let visible = true;
  const adapter = {
    findWorkspaces: async () => (visible ? [{ id: "old", directory: old }] : []),
    archiveTaskWorkspace: async (_task: unknown, _id: string, _dir: string, _head: string, allowed: () => boolean, uncertain: boolean) => {
      if (uncertain) throw Error("Workspace archive outcome is uncertain; inspect before retrying");
      assert.equal(allowed(), true);
      visible = false;
      return true;
    },
  } as unknown as Adapter;
  const { invoke, calls } = fakeEffigy();

  await archiveUnusedWorkspace(store, adapter, {
    taskId: task.id, version: store.task(task.id).version, unusedWorkspaceId: "old",
  }, () => true, new RuntimeRetirementService(store, invoke));

  const after = store.task(task.id);
  assert.deepEqual(calls.at(-1), ["container", "retire", "--scope", token, "--yes"]);
  assert.equal(after.resolution.runtimeRetirements.find(record => record.workspaceId === "old")?.state, "retired");
  assert.equal(after.workspaceId, "retained");
});

test("an unused-workspace teardown failure records and retries its tokenless archive", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-unused-teardown-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const repo = join(base, "repo"), planningBase = await gitInit(repo);
  const store = storeFor(t, base), inserted = await submit(store, repo, planningBase, "Unused");
  const old = join(base, "old");
  await git(repo, "worktree", "add", "-b", inserted.branch, old, planningBase);
  await writeFile(join(repo, "later"), "later");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "advance");
  const task = store.update(inserted.id, {
    phase: "needs_attention", workspaceId: "retained", directory: join(base, "retained"), workspaceIntent: true,
    planningBase: await git(repo, "rev-parse", "HEAD"),
  });
  let visible = true, archives = 0;
  const adapter = {
    findWorkspaces: async () => visible ? [{ id: "old", directory: old }] : [],
    archiveTaskWorkspace: async (_task: unknown, _id: string, _dir: string, _head: string, allowed: () => boolean, uncertain: boolean) => {
      archives++;
      if (archives === 1) {
        visible = false;
        throw Error(`worktree.teardown failed: worktree directory remains after archive: ${old}`);
      }
      assert.equal(uncertain, true, "a prior archive intent is reconciled without repeating the archive");
      assert.equal(allowed(), true);
      return true;
    },
  } as unknown as Adapter;
  const { invoke } = fakeEffigy();
  const retirement = new RuntimeRetirementService(store, invoke);

  await assert.rejects(archiveUnusedWorkspace(store, adapter, {
    taskId: task.id, version: store.task(task.id).version, unusedWorkspaceId: "old",
  }, () => true, retirement), /worktree\.teardown failed/);
  const failedRecord = store.task(task.id).resolution.runtimeRetirements.find(record => record.workspaceId === "old");
  assert.equal(failedRecord?.state, "failed");
  assert.equal(failedRecord?.scope, null);
  assert.ok(failedRecord?.error.includes(old));

  await rm(old, { recursive: true, force: true });
  const engine = new Engine(store, adapter, 0, () => true, retirement);
  t.after(() => engine.stop());
  await engine.retryRuntimeRetirement(task.id, store.task(task.id).version);

  assert.equal(archives, 2);
  assert.equal(store.getMeta<{ status: string }>(`unusedWorkspaceArchive:${task.id}:old`)?.status, "archived");
  assert.equal(store.task(task.id).resolution.runtimeRetirements.find(record => record.workspaceId === "old")?.state, "none");
});

test("a teardown Paseo reports as failed flags the cleanup without recording a clean archive", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-teardown-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const { primary, worktree, gitDir, head } = await linkedWorktree(t, base);
  await writeFile(join(gitDir, "effigy-runtime-scope"), "5".repeat(32));
  const store = storeFor(t, base);
  const inserted = await submit(store, primary, head);
  const task = store.update(inserted.id, {
    phase: "done", workspaceId: "ws", directory: worktree, prHead: head, prUrl: "https://github.com/example/repo/pull/1",
    resolution: { ...inserted.resolution, mergedCommit: head, syncedCommit: head },
  });
  const adapter = {
    archiveTaskWorkspace: async (_task: unknown, _id: string, _dir: string, _head: string, allowed: () => boolean) => {
      assert.equal(allowed(), true);
      throw Error("worktree.teardown hook failed: runtime scope still owns resources");
    },
  } as unknown as Adapter;
  const { invoke } = fakeEffigy();
  const engine = new Engine(store, adapter, 0, () => true, new RuntimeRetirementService(store, invoke));
  t.after(() => engine.stop());

  engine.enqueueCleanup(task.id);
  await engine.drainCleanup();

  const after = store.task(task.id);
  assert.deepEqual(after.resolution.archivedWorkspaceIds, []);
  assert.equal(after.resolution.runtimeRetirements[0]?.state, "failed");
  assert.match(api.runtimeRetirementFailure(after), /runtime retirement failed/);
  assert.match(after.resolution.cleanupReason, /runtime retirement failed/);
});

test("a teardown failure without a captured token stays flagged until the archive retry succeeds", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-retire-teardown-unscoped-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const { primary, worktree, head } = await linkedWorktree(t, base);
  const store = storeFor(t, base);
  const inserted = await submit(store, primary, head);
  const task = store.update(inserted.id, {
    phase: "done", workspaceId: "ws", directory: worktree, prHead: head, prUrl: "https://github.com/example/repo/pull/1",
    resolution: { ...inserted.resolution, mergedCommit: head, syncedCommit: head },
  });
  let archives = 0;
  const adapter = {
    // The failed teardown records the archive intent before it throws, so the retry
    // must reconcile that intent: the workspace is still listed, so the archive re-runs.
    taskWorkspaceArchived: async () => false,
    archiveTaskWorkspace: async (_task: unknown, _id: string, _dir: string, _head: string, allowed: () => boolean) => {
      assert.equal(allowed(), true);
      archives++;
      if (archives === 1) throw Error(`worktree.teardown failed: worktree directory remains after archive: ${worktree}`);
      await rm(worktree, { recursive: true, force: true });
      return true;
    },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0, () => true, new RuntimeRetirementService(store, fakeEffigy().invoke));
  t.after(() => engine.stop());

  engine.enqueueCleanup(task.id);
  await engine.drainCleanup();

  const failedRecord = store.task(task.id).resolution.runtimeRetirements[0];
  assert.equal(failedRecord.state, "failed");
  assert.equal(failedRecord.scope, null);
  assert.match(failedRecord.error, /runtime retirement failed/);
  assert.ok(failedRecord.error.includes(worktree));
  assert.deepEqual(store.task(task.id).resolution.archivedWorkspaceIds, []);

  await engine.retryRuntimeRetirement(task.id, store.task(task.id).version);

  const after = store.task(task.id);
  assert.equal(archives, 2);
  assert.deepEqual(after.resolution.archivedWorkspaceIds, ["ws"]);
  assert.equal(after.resolution.runtimeRetirements[0].state, "none");
  assert.equal(api.runtimeRetirementFailure(after), "");
});

