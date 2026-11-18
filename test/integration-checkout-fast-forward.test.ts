import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeIntegrationFastForward, fastForwardIntegrationBase, git } from "../core/git/index";
import { integrationBaseGate } from "../core/forge/index";
import { HookCheckouts } from "../core/hooks/hook-checkouts";
import type { Task } from "../shared/contracts";

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

test("a clean checkout behind origin fast-forwards inside the merge gate with one move and then proceeds", async t => {
  const f = await fixture(t, 2);
  const gate = await integrationBaseGate(gateTask(f.root), "unused");
  assert.equal(gate.base, f.remote);
  assert.deepEqual(gate.fastForward, { from: f.before, to: f.remote });
  assert.equal(gate.wait, "");
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.remote);
  assert.equal(describeIntegrationFastForward("main", { from: f.before, to: f.remote }), `main: ${f.before} -> ${f.remote}`);
  const again = await integrationBaseGate(gateTask(f.root), "unused");
  assert.deepEqual(again, { base: f.remote, wait: "" }, "a second pass finds the checkout current and moves nothing");
});

test("ignored files never block the fast-forward", async t => {
  const f = await fixture(t, 1);
  await writeFile(join(f.root, "local.env"), "SECRET=kept");
  const moved = await fastForwardIntegrationBase(f.root, "main");
  assert.deepEqual(moved, { from: f.before, to: f.remote });
  assert.equal(await readFile(join(f.root, "local.env"), "utf8"), "SECRET=kept");
});

test("concurrent gate passes move the checkout once and never double-act", async t => {
  const f = await fixture(t, 3);
  const results = await Promise.all([integrationBaseGate(gateTask(f.root), "a"), integrationBaseGate(gateTask(f.root), "b"), integrationBaseGate(gateTask(f.root), "c")]);
  assert.equal(results.filter(result => result.fastForward).length, 1, "exactly one pass moved the checkout");
  for (const result of results) assert.equal(result.base, f.remote);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.remote);
});

test("the prospective-merge base fast-forwards the same way and records one move", async t => {
  const f = await fixture(t, 1);
  const moves: { from: string; to: string }[] = [];
  const checkouts = new HookCheckouts({ store: { path: join(f.dir, "store.db") }, dataDir: join(f.dir, "data") });
  assert.equal(await checkouts.integrationBase(gateTask(f.root), undefined, move => moves.push(move)), f.remote);
  assert.equal(await checkouts.integrationBase(gateTask(f.root), undefined, move => moves.push(move)), f.remote);
  assert.deepEqual(moves, [{ from: f.before, to: f.remote }]);
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
