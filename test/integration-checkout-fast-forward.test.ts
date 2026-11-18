import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeIntegrationFastForward, fastForwardIntegrationBase, git, type IntegrationFastForwardObserver } from "../core/git/index";
import { integrationBaseGate } from "../core/forge/index";
import { HookCheckouts } from "../core/hooks/hook-checkouts";
import { RepositoryHooks } from "../core/hooks/hooks";
import { CheckEvidence } from "../core/merge/check-evidence";
import { observeForceMergeGate } from "../core/verbs/force";
import { Store } from "../core/store/store";
import { submissionSchema, type Task } from "../shared/contracts";
import type { ResolutionAdapter } from "../core/resolution";

/**
 * Real Git fixture: a bare origin and the registered integration clone on `main`.
 * `behind` commits land on origin after the registered clone was last synced.
 */
async function fixture(t: { after(fn: () => unknown): void }, behind: number) {
  const dir = await mkdtemp(join(tmpdir(), "nucleus-ff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const origin = join(dir, "origin.git"), root = join(dir, "registered"), writer = join(dir, "writer");
  await git(dir, "init", "--bare", "origin.git");
  await git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(dir, "clone", origin, "registered");
  await identify(root);
  await git(root, "checkout", "-b", "main");
  await writeFile(join(root, ".gitignore"), "local.env\n");
  await writeFile(join(root, "base.txt"), "a");
  await git(root, "add", ".gitignore", "base.txt");
  await git(root, "commit", "-m", "base");
  await git(root, "push", "-u", "origin", "main");
  await git(dir, "clone", origin, "writer");
  await identify(writer);
  for (let i = 0; i < behind; i++) await commit(writer, `remote-${i}.txt`, `remote ${i}`);
  if (behind) await git(writer, "push", "origin", "main");
  const before = await git(root, "rev-parse", "HEAD");
  const remote = await git(origin, "rev-parse", "main");
  return { dir, origin, root, writer, before, remote };
}

async function identify(cwd: string) {
  await git(cwd, "config", "user.name", "Queue test");
  await git(cwd, "config", "user.email", "queue@example.invalid");
}

async function commit(cwd: string, file: string, content: string): Promise<string> {
  await writeFile(join(cwd, file), content);
  await git(cwd, "add", file);
  await git(cwd, "commit", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

const gateTask = (root: string) => ({ repoPath: root, baseBranch: "main", directory: root }) as Task;
const moved = (f: { before: string; remote: string }) => [{ from: f.before, to: f.remote }];

test("a clean checkout behind origin fast-forwards inside the merge gate with one move and then proceeds", async t => {
  const f = await fixture(t, 2);
  const moves: { from: string; to: string }[] = [];
  const gate = await integrationBaseGate(gateTask(f.root), "unused", move => moves.push(move));
  assert.equal(gate.base, f.remote);
  assert.equal(gate.wait, "");
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.remote);
  assert.deepEqual(moves, moved(f));
  assert.equal(describeIntegrationFastForward("main", { from: f.before, to: f.remote }), `main: ${f.before} -> ${f.remote}`);
  assert.deepEqual(await integrationBaseGate(gateTask(f.root), "unused", move => moves.push(move)), { base: f.remote, wait: "" }, "a second pass finds the checkout current and moves nothing");
  assert.equal(moves.length, 1);
});

test("ignored files never block the fast-forward", async t => {
  const f = await fixture(t, 1);
  await writeFile(join(f.root, "local.env"), "SECRET=kept");
  const move = await fastForwardIntegrationBase(f.root, "main");
  assert.deepEqual(move, { from: f.before, to: f.remote });
  assert.equal(await readFile(join(f.root, "local.env"), "utf8"), "SECRET=kept");
});

test("concurrent gate passes move the checkout once and never double-act", async t => {
  const f = await fixture(t, 3);
  const moves: { from: string; to: string }[] = [];
  const observe: IntegrationFastForwardObserver = move => moves.push(move);
  const results = await Promise.all([integrationBaseGate(gateTask(f.root), "a", observe), integrationBaseGate(gateTask(f.root), "b", observe), integrationBaseGate(gateTask(f.root), "c", observe)]);
  assert.equal(moves.length, 1, "exactly one pass moved the checkout");
  assert.deepEqual(moves, moved(f));
  for (const result of results) assert.equal(result.base, f.remote);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.remote);
});

test("the prospective-merge base fast-forwards the same way and records one move", async t => {
  const f = await fixture(t, 1);
  const moves: { from: string; to: string }[] = [];
  const checkouts = new HookCheckouts({ store: { path: join(f.dir, "store.db") }, dataDir: join(f.dir, "data") });
  assert.equal(await checkouts.integrationBase(gateTask(f.root), undefined, move => moves.push(move)), f.remote);
  assert.equal(await checkouts.integrationBase(gateTask(f.root), undefined, move => moves.push(move)), f.remote);
  assert.deepEqual(moves, moved(f));
});

test("a stale-base renewal fast-forwards through its observer once", async t => {
  const f = await fixture(t, 1);
  const moves: { from: string; to: string }[] = [];
  const checkouts = new HookCheckouts({ store: { path: join(f.dir, "store.db") }, dataDir: join(f.dir, "data") });
  assert.equal(await checkouts.renewIntegrationBase(gateTask(f.root), () => true, move => moves.push(move)), f.remote);
  assert.equal(await checkouts.renewIntegrationBase(gateTask(f.root), () => true, move => moves.push(move)), f.remote);
  assert.deepEqual(moves, moved(f));
});

test("a dirty checkout is left untouched and named", async t => {
  const f = await fixture(t, 1);
  await writeFile(join(f.root, "base.txt"), "local edit");
  await assert.rejects(integrationBaseGate(gateTask(f.root), "x"), /Integration checkout is dirty at .*registered/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.before);
  assert.equal(await readFile(join(f.root, "base.txt"), "utf8"), "local edit");
});

test("an untracked file makes the checkout dirty and it is left untouched", async t => {
  const f = await fixture(t, 1);
  await writeFile(join(f.root, "scratch.txt"), "operator note");
  await assert.rejects(fastForwardIntegrationBase(f.root, "main"), /Integration checkout is dirty/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.before);
  assert.ok(existsSync(join(f.root, "scratch.txt")));
});

test("a checkout ahead of origin is refused by name and not moved", async t => {
  const f = await fixture(t, 0);
  const local = await commit(f.root, "local.txt", "local only");
  await assert.rejects(fastForwardIntegrationBase(f.root, "main"), /Local integration branch differs from origin: local main has commits that origin\/main does not/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), local);
});

test("a diverged checkout is refused by name and not moved", async t => {
  const f = await fixture(t, 1);
  const local = await commit(f.root, "local.txt", "local only");
  await assert.rejects(fastForwardIntegrationBase(f.root, "main"), /Local integration branch differs from origin: local main and origin\/main have diverged/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), local);
});

test("a checkout on another branch is refused by name and not moved", async t => {
  const f = await fixture(t, 1);
  await git(f.root, "checkout", "-b", "feature");
  await assert.rejects(fastForwardIntegrationBase(f.root, "main"), /Integration checkout is on a different branch \(feature\)/);
  await assert.rejects(integrationBaseGate(gateTask(f.root), "x"), /Integration checkout is on a different branch/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.before);
});

test("a detached checkout is refused by name and not moved", async t => {
  const f = await fixture(t, 1);
  await git(f.root, "checkout", "--detach");
  await assert.rejects(fastForwardIntegrationBase(f.root, "main"), /Integration checkout is on a different branch \(detached HEAD\)/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.before);
});

test("a checkout in the middle of a rebase is refused by its operation and not moved", async t => {
  const f = await fixture(t, 1);
  await git(f.root, "checkout", "-b", "topic");
  const topic = await commit(f.root, "conflict.txt", "topic");
  await git(f.root, "checkout", "main");
  await commit(f.root, "conflict.txt", "main");
  await git(f.root, "checkout", "topic");
  await assert.rejects(git(f.root, "rebase", "main"));
  // A conflicting rebase stops with HEAD at the onto commit, not at the topic commit.
  const stopped = await git(f.root, "rev-parse", "HEAD");
  assert.notEqual(stopped, topic);
  await assert.rejects(fastForwardIntegrationBase(f.root, "main"), /Integration checkout has an operation in progress \(rebase-(merge|apply)\)/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), stopped);
  await git(f.root, "rebase", "--abort");
});

test("a fast-forward through the prospective-merge base records one event on the task that moved it", async t => {
  const f = await fixture(t, 2);
  const store = new Store(join(f.dir, "queue.sqlite"));
  t.after(() => store.close());
  const task = store.insert(submissionSchema.parse({ submissionId: "ff-prospective", title: "prospective", repoPath: f.root, planningCommit: f.before, handoffPath: "ff.md", originAgentId: "origin" }), "host", "handoff", f.before);
  const hooks = new RepositoryHooks(store);
  assert.equal(await hooks.integrationBase(task), f.remote);
  assert.equal(await hooks.integrationBase(task), f.remote);
  const events = store.events(task.id).filter(event => event.kind === "integration_checkout_fast_forwarded");
  assert.deepEqual(events.map(event => event.detail), [describeIntegrationFastForward("main", { from: f.before, to: f.remote })]);
});

test("a merge-gate observation that moved the checkout records one event and a later observation records none", async t => {
  const f = await fixture(t, 2);
  const store = new Store(join(f.dir, "queue.sqlite"));
  t.after(() => store.close());
  const task = store.insert(submissionSchema.parse({ submissionId: "ff-gate", title: "gate", repoPath: f.root, planningCommit: f.before, handoffPath: "gate.md", originAgentId: "origin" }), "host", "handoff", f.before);
  // The adapter forwards the observer into integrationBaseGate, as the forge merge gate does.
  const adapter = {
    mergeGate: async (current: Task, _history: unknown, _reviewer: unknown, _policy: unknown, _runtime: unknown, observe?: IntegrationFastForwardObserver) => {
      const gate = await integrationBaseGate(current, "head", observe);
      return { head: "head", base: gate.base, wait: "" };
    },
  };
  const evidence = new CheckEvidence({ adapter, reviewerSetting: () => null, store } as unknown as ConstructorParameters<typeof CheckEvidence>[0]);
  const gated = { ...task, directory: f.root };
  assert.equal((await evidence.mergeGate(gated)).base, f.remote);
  assert.equal((await evidence.mergeGate(gated)).base, f.remote);
  const events = store.events(task.id).filter(event => event.kind === "integration_checkout_fast_forwarded");
  assert.deepEqual(events.map(event => event.detail), [describeIntegrationFastForward("main", { from: f.before, to: f.remote })]);
});

test("a forced merge gate records a fast-forward even when the gate then refuses", async t => {
  const f = await fixture(t, 1);
  const store = new Store(join(f.dir, "queue.sqlite"));
  t.after(() => store.close());
  const task = store.insert(submissionSchema.parse({ submissionId: "ff-force", title: "force", repoPath: f.root, planningCommit: f.before, handoffPath: "force.md", originAgentId: "origin" }), "host", "handoff", f.before);
  const gated = { ...task, directory: f.root };
  // The forced gate moves the checkout, then a later GitHub read in the same pass fails.
  const failingAfterMove = {
    mergeGate: async (current: Task, _history: unknown, _reviewer: unknown, _policy: unknown, _runtime: unknown, observe?: IntegrationFastForwardObserver) => {
      await integrationBaseGate(current, "head", observe);
      throw new Error("GitHub read failed after the checkout moved");
    },
  };
  await assert.rejects(observeForceMergeGate(failingAfterMove as unknown as Pick<ResolutionAdapter, "mergeGate">, store, gated, "all"), /GitHub read failed/);
  // A later forced observation finds the checkout current and records nothing more.
  const observing = {
    mergeGate: async (current: Task, _history: unknown, _reviewer: unknown, _policy: unknown, _runtime: unknown, observe?: IntegrationFastForwardObserver) => ({ head: "head", ...await integrationBaseGate(current, "head", observe) }),
  };
  await observeForceMergeGate(observing as unknown as Pick<ResolutionAdapter, "mergeGate">, store, gated, "required");
  const events = store.events(task.id).filter(event => event.kind === "integration_checkout_fast_forwarded");
  assert.deepEqual(events.map(event => event.detail), [describeIntegrationFastForward("main", { from: f.before, to: f.remote })]);
});
