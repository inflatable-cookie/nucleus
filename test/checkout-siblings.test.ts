import { fakeAdapter, createTaskAgent } from './support/fakes';
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, realpath, stat, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { workerPrompt } from "../core/dispatch/prompts";
import { git, command } from "../core/git/index";
import { discoverCheckoutSiblings, isQueueTaskWorktreeName, refreshCheckoutSiblings, worktreeRootFor } from "../core/workspaces/checkout-siblings";
import { siblingStorePathFor, siblingStoreRootFor } from "../core/store/sibling-store";
import { submissionSchema, type Profile } from "../shared/contracts";
import type { Adapter } from "../core/host";
import { HOOK_TEST_TIMEOUT_MS } from "./support/budgets";

const profile: Profile = { id: "worker", name: "Worker", provider: "test", model: "test", notes: "", available: true, problem: "", supportedThinking: ["low"] };

async function commit(repo: string, message: string, files: Record<string, string> = {}) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

async function identity(repo: string) {
  await git(repo, "config", "user.name", "Queue test");
  await git(repo, "config", "user.email", "queue@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
}

/** Bare origin plus a detached clone sitting in a Paseo-style worktree root. */
async function siblingRoot(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-checkout-sib-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const root = join(base, "worktrees");
  await mkdir(root);
  const bare = join(base, "library.git");
  await command("git", ["init", "--bare", "--initial-branch=main", bare], base);
  const seed = join(base, "seed");
  await command("git", ["clone", bare, seed], base);
  await identity(seed);
  const first = await commit(seed, "init", { "README.md": "one\n" });
  await git(seed, "push", "origin", "main");
  const sibling = join(root, "library");
  await command("git", ["clone", bare, sibling], base);
  await identity(sibling);
  await git(sibling, "remote", "set-head", "origin", "main");
  await git(sibling, "checkout", "--detach", "HEAD");
  return { base, root, bare, seed, sibling, first };
}

async function advanceOrigin(f: Awaited<ReturnType<typeof siblingRoot>>, message = "advance") {
  return commit(f.seed, message, { "README.md": `${message}\n` }).then(async head => {
    await git(f.seed, "push", "origin", "main");
    return head;
  });
}

function engineFor(t: TestContext, store: Store, root: string) {
  const adapter: Adapter = fakeAdapter({
    profiles: async () => [profile],
    validate: async task => task.planningCommit,
    createWorkspace: async task => {
      const directory = join(root, `ns-${task.id}`);
      await mkdir(directory, { recursive: true });
      return { id: `ws-${task.id}`, directory };
    },
    verifyWorkspace: async task => task.branch,
    createAgent: createTaskAgent,
    observe: async id => ({ id, workspaceId: store.tasks().find(task => task.agentId === id)?.workspaceId ?? null, status: "idle", active: false, permissions: false, error: "" }),
    archiveTaskWorkspace: async () => true,
    verifyPr: async () => ({ url: "https://github.com/example/repo/pull/1", head: "b".repeat(40) }),
    findOpenBranchPr: async () => [],
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [profile];
  t.after(() => engine.stop());
  store.setMeta("pool", [{ profileId: profile.id, enabled: true, group: "test", weight: 1, scopes: ["general"] }]);
  store.setMeta("paused", false);
  return engine;
}

function submit(store: Store, repoPath: string, title = "Task", extra: Record<string, unknown> = {}) {
  return store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title, repoPath, planningCommit: "a".repeat(40), handoffPath: "handoff.md", originAgentId: "origin", ...extra,
  }), "host", "handoff", "a".repeat(40));
}

test("queue worktree directory names include collision and closeout slugs", () => {
  const id = "03e81bf5-2bb4-465a-b081-5ffdec8b9fdb";
  assert.equal(isQueueTaskWorktreeName(`ns-${id}`), true);
  assert.equal(isQueueTaskWorktreeName(`ns-${id}-1`), true);
  assert.equal(isQueueTaskWorktreeName(`ns-closeout-${id}`), true);
  assert.equal(isQueueTaskWorktreeName("library"), false);
  assert.equal(isQueueTaskWorktreeName("ns-not-a-uuid"), false);
});

test("worktreeRootFor uses the task directory and never a filesystem root", () => {
  assert.equal(worktreeRootFor({ directory: "/tmp/root/ns-task", repoPath: "/repo" }, []), "/tmp/root");
  assert.equal(worktreeRootFor({ directory: "/fixture", repoPath: "/repo" }, []), null);
  assert.equal(worktreeRootFor({ directory: null, repoPath: "/repo" }, [{ directory: "/tmp/root/ns-other", repoPath: "/repo" }]), "/tmp/root");
  assert.equal(worktreeRootFor({ directory: null, repoPath: "/repo" }, [{ directory: "/tmp/root/ns-other", repoPath: "/other" }]), null);
});

test("Spec 028 #1 a clean detached sibling behind origin is fast-forwarded", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoot(t);
  const next = await advanceOrigin(f);
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), f.first);
  const result = await refreshCheckoutSiblings(f.root, join(f.root, "ns-task"));
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), next);
  assert.equal(await git(f.sibling, "branch", "--show-current"), "");
  assert.equal(result.forwarded.length, 1);
  assert.equal(result.forwarded[0].from, f.first);
  assert.equal(result.forwarded[0].to, next);
  assert.deepEqual(result.findings, []);
});

test("Spec 028 #3 a dirty sibling is reported and untouched", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoot(t);
  await advanceOrigin(f);
  await writeFile(join(f.sibling, "dirty.txt"), "keep\n");
  const result = await refreshCheckoutSiblings(f.root, null);
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), f.first);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].state, "dirty");
  assert.match(result.findings[0].detail, /library/);
  assert.equal(result.forwarded.length, 0);
});

test("Spec 028 #4 a sibling on a branch is reported and untouched", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoot(t);
  await git(f.sibling, "checkout", "main");
  await advanceOrigin(f);
  const result = await refreshCheckoutSiblings(f.root, null);
  assert.equal(await git(f.sibling, "branch", "--show-current"), "main");
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), f.first);
  assert.equal(result.findings[0]?.state, "branched");
  assert.equal(result.forwarded.length, 0);
});

test("Spec 028 #5 a diverged detached sibling is reported and untouched", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoot(t);
  await writeFile(join(f.sibling, "local.txt"), "side\n");
  const local = await commit(f.sibling, "local only", {});
  await advanceOrigin(f);
  const result = await refreshCheckoutSiblings(f.root, null);
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), local);
  assert.equal(result.findings[0]?.state, "diverged");
  assert.equal(result.forwarded.length, 0);
});

test("Spec 028 #6 a fetch failure is reported and dispatch would proceed", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoot(t);
  await git(f.sibling, "remote", "set-url", "origin", join(f.root, "missing.git"));
  const result = await refreshCheckoutSiblings(f.root, null);
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), f.first);
  assert.equal(result.findings[0]?.state, "fetch_failed");
  assert.equal(result.forwarded.length, 0);
});

test("Spec 028 #7 a Queue task worktree in the root is never treated as a sibling", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoot(t);
  const id = randomUUID();
  const other = join(f.root, `ns-${id}`);
  await command("git", ["clone", f.bare, other], f.root);
  await identity(other);
  await git(other, "checkout", "--detach", "HEAD");
  await advanceOrigin(f);
  const discovered = await discoverCheckoutSiblings(f.root, join(f.root, "ns-task"));
  assert.deepEqual(discovered, [f.sibling]);
  await refreshCheckoutSiblings(f.root, join(f.root, "ns-task"));
  assert.equal(await git(other, "rev-parse", "HEAD"), f.first);
  assert.notEqual(await git(f.sibling, "rev-parse", "HEAD"), f.first);
});

test("Spec 028 #1 worker creation fast-forwards a clean detached sibling and records the event", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoot(t);
  const next = await advanceOrigin(f);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nsq-cs-store-")));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "queue.sqlite"));
  t.after(() => store.close());
  const engine = engineFor(t, store, f.root);
  const task = submit(store, "/project-a", "Worker creation");
  await engine.wake();
  const current = store.task(task.id);
  assert.equal(current.phase, "working");
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), next);
  const event = store.events(task.id).find(item => item.kind === "checkout_sibling_fast_forwarded");
  assert.ok(event);
  assert.match(event!.detail, new RegExp(`${f.first} → ${next}`));
  assert.match(event!.detail, /worker_creation/);
  assert.deepEqual(current.checkoutSiblingFindings, []);
});

test("Spec 028 #2 prerequisite release fast-forwards using another live task's worktree root", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoot(t);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nsq-cs-prereq-")));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "queue.sqlite"));
  t.after(() => store.close());
  const engine = engineFor(t, store, f.root);
  store.setMeta("globalLimit", 1);
  const filler = submit(store, "/project-a", "Filler");
  await engine.wake();
  assert.equal(store.task(filler.id).phase, "working");
  const parent = submit(store, "/project-b", "Parent");
  const child = submit(store, "/project-a", "Child", { dependsOn: [parent.id] });
  await engine.wake();
  assert.match(store.dependencyWait(store.task(child.id)), /Waiting for prerequisites/);
  assert.equal(store.task(child.id).directory, null);
  const next = await advanceOrigin(f);
  store.update(parent.id, { phase: "done", reason: "Closed out" });
  store.update(filler.id, { phase: "done", agentActive: false, agentIntent: false });
  await engine.wake();
  const current = store.task(child.id);
  assert.notEqual(current.phase, "queued");
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), next);
  const event = store.events(child.id).find(item => item.kind === "checkout_sibling_fast_forwarded");
  assert.ok(event);
  assert.match(event!.detail, /prerequisite_release/);
  assert.match(event!.detail, new RegExp(`${f.first} → ${next}`));
});

test("Spec 028 #2 a held dependent released after its prerequisite settled still fast-forwards on release (#591 review)", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoot(t);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nsq-cs-prereq-")));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "queue.sqlite"));
  t.after(() => store.close());
  const engine = engineFor(t, store, f.root);
  store.setMeta("globalLimit", 1);
  const filler = submit(store, "/project-a", "Filler");
  await engine.wake();
  assert.equal(store.task(filler.id).phase, "working");
  const parent = submit(store, "/project-b", "Parent");
  const child = submit(store, "/project-a", "Child", { dependsOn: [parent.id] });
  await engine.wake();
  assert.match(store.dependencyWait(store.task(child.id)), /Waiting for prerequisites/);
  assert.equal(store.task(child.id).directory, null);
  const { holdPatch, releasePatch } = await import("../core/merge/merge-hold");
  store.update(child.id, holdPatch(store.task(child.id), "dispatch", "operator", "Wait for staging"));
  const next = await advanceOrigin(f);
  store.update(parent.id, { phase: "done", reason: "Closed out" });
  assert.equal(store.dependencyWait(store.task(child.id)), "", "the held child's wait is derived from the settled prerequisite");
  await engine.wake();
  assert.equal(store.task(child.id).phase, "queued");
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), next, "release refresh runs while dispatch remains held");
  assert.equal(store.eventsAll(child.id).filter(item => item.kind === "prerequisite_release_refreshed").length, 1);
  store.update(child.id, releasePatch(store.task(child.id), "dispatch"));
  store.update(filler.id, { phase: "done", agentActive: false, agentIntent: false });
  await engine.wake();
  const current = store.task(child.id);
  assert.notEqual(current.phase, "queued");
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), next);
  const event = store.events(child.id).find(item => item.kind === "checkout_sibling_fast_forwarded");
  assert.ok(event);
  assert.match(event!.detail, /prerequisite_release/);
  assert.match(event!.detail, new RegExp(`${f.first} → ${next}`));
  // The release refresh runs once: a later pass does not repeat it.
  await engine.wake();
  assert.equal(store.eventsAll(child.id).filter(item => item.kind === "prerequisite_release_refreshed").length, 1);
});

test("prerequisite release defers checkout refresh while paused", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoot(t);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = engineFor(t, store, f.root);
  const filler = submit(store, "/project-a", "Filler");
  await engine.wake();
  const parent = submit(store, "/project-b", "Parent");
  const child = submit(store, "/project-a", "Child", { dependsOn: [parent.id] });
  const { holdPatch } = await import("../core/merge/merge-hold");
  store.update(child.id, holdPatch(store.task(child.id), "dispatch", "operator", "Wait"));
  const next = await advanceOrigin(f);
  store.setMeta("paused", true);
  store.update(parent.id, { phase: "done" });
  await engine.wake();
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), f.first);
  assert.equal(store.eventsAll(child.id).some(event => event.kind === "prerequisite_release_refreshed"), false);
  store.setMeta("paused", false);
  await engine.wake();
  assert.equal(store.task(child.id).phase, "queued");
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), next);
  assert.equal(store.eventsAll(child.id).filter(event => event.kind === "prerequisite_release_refreshed").length, 1);
  assert.notEqual(store.task(filler.id).phase, "queued");
});

test("Spec 028 #6 fetch failure is a finding and worker creation still proceeds", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoot(t);
  await git(f.sibling, "remote", "set-url", "origin", join(f.root, "missing.git"));
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nsq-cs-fetch-")));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "queue.sqlite"));
  t.after(() => store.close());
  const engine = engineFor(t, store, f.root);
  const task = submit(store, "/project-a", "Fetch failure");
  await engine.wake();
  const current = store.task(task.id);
  assert.equal(current.phase, "working");
  assert.equal(current.checkoutSiblingFindings.length, 1);
  assert.equal(current.checkoutSiblingFindings[0].state, "fetch_failed");
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), f.first);
  const prompt = workerPrompt(current, true);
  assert.match(prompt, /Worktree-root sibling checkouts Nucleus did not fast-forward/);
  assert.match(prompt, /library/);
});

test("a worker prompt without checkout findings stays unchanged on that block", () => {
  const task = { id: "task", runId: "initial", title: "Build", originAgentId: "origin", coordinatorAgentId: null, dependsOn: [], branch: "ns-task", baseBranch: "main", handoffPath: "handoff.md", planningCommit: "a".repeat(40), retiredWorkers: [], resolution: {}, skipPRReview: false, checkoutSiblingFindings: [] } as never;
  assert.doesNotMatch(workerPrompt(task, true), /Worktree-root sibling checkouts/);
});

/** Spec 028 shared object store fixtures. */

function pseudoRandomBytes(size: number, seed: number): Buffer {
  const buffer = Buffer.alloc(size);
  let state = seed;
  for (let i = 0; i < size; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    buffer[i] = state & 0xff;
  }
  return buffer;
}

async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await treeBytes(path) : (await stat(path)).size;
  }
  return total;
}

const packCount = async (checkout: string) =>
  (await readdir(join(checkout, ".git", "objects", "pack")).catch(() => [] as string[])).filter(name => name.endsWith(".pack")).length;

const alternatesOf = async (checkout: string) =>
  (await readFile(join(checkout, ".git", "objects", "info", "alternates"), "utf8")).trim();

/** Full clones (real pack copies) of one bare origin in `count` Paseo-style worktree roots, all detached at the same head. */
async function siblingRoots(t: TestContext, count: number) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-checkout-store-")));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const bare = join(base, "library.git");
  await command("git", ["init", "--bare", "--initial-branch=main", bare], base);
  const seed = join(base, "seed");
  await command("git", ["clone", bare, seed], base);
  await identity(seed);
  await commit(seed, "init", { "README.md": "one\n" });
  // Real pack bytes, so the on-disk sharing measurement is not noise.
  for (const [name, bytes] of [["blob-1", pseudoRandomBytes(1536 * 1024, 7)], ["blob-2", pseudoRandomBytes(1536 * 1024, 11)]] as const) {
    await writeFile(join(seed, name), bytes);
    await git(seed, "add", "-A");
    await git(seed, "commit", "-m", name);
  }
  await git(seed, "push", "origin", "main");
  const first = await git(seed, "rev-parse", "HEAD");
  const roots: string[] = [];
  const siblings: string[] = [];
  for (let index = 0; index < count; index++) {
    const root = join(base, `worktrees-${index}`);
    await mkdir(root);
    const sibling = join(root, "library");
    await command("git", ["clone", "--no-local", bare, sibling], base);
    await identity(sibling);
    await git(sibling, "remote", "set-head", "origin", "main");
    await git(sibling, "checkout", "--detach", "HEAD");
    roots.push(root);
    siblings.push(sibling);
  }
  const storeDir = join(base, "queue-data", "sibling-store");
  return { base, bare, seed, first, roots, siblings, storeDir };
}

async function advanceSeed(seed: string, message: string, content: string) {
  await writeFile(join(seed, "README.md"), content);
  await git(seed, "add", "-A");
  await git(seed, "commit", "-m", message);
  const head = await git(seed, "rev-parse", "HEAD");
  await git(seed, "push", "origin", "main");
  return head;
}

test("sibling store keys normalise the origin and separate repositories", () => {
  const storeDir = "/data/sibling-store";
  assert.equal(siblingStorePathFor(storeDir, "https://example.com/library.git"), siblingStorePathFor(storeDir, "https://example.com/library"));
  assert.equal(siblingStorePathFor(storeDir, "https://example.com/library/"), siblingStorePathFor(storeDir, "https://example.com/library.git"));
  assert.notEqual(siblingStorePathFor(storeDir, "https://example.com/library"), siblingStorePathFor(storeDir, "https://example.com/other"));
  assert.match(siblingStorePathFor(storeDir, "origin"), /\/[0-9a-f]{64}\.git$/);
});

test("Spec 028 #8 two groups using the same sibling at the same head share its storage, measured on disk", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoots(t, 3);
  // Groups one and two share; group three's copy stays a full clone for the measurement.
  for (const root of f.roots.slice(0, 2)) await refreshCheckoutSiblings(root, null, { storeDir: f.storeDir });
  const [a, b] = f.siblings;
  const store = siblingStorePathFor(f.storeDir, f.bare);
  assert.equal(await alternatesOf(a), join(store, "objects"));
  assert.equal(await alternatesOf(b), join(store, "objects"));
  assert.equal(await packCount(a), 0);
  assert.equal(await packCount(b), 0);
  assert.ok((await readdir(join(store, "objects", "pack"))).some(name => name.endsWith(".pack")));
  for (const sibling of [a, b]) {
    assert.equal(await git(sibling, "rev-parse", "HEAD"), f.first);
    assert.equal(await git(sibling, "status", "--porcelain"), "");
    await git(sibling, "log", "--oneline");
  }
  // Measured on disk: both shared checkouts plus the store hold less than one full copy plus the store,
  // because each shared checkout holds none of the history pack.
  const shared = await treeBytes(join(a, ".git", "objects")) + await treeBytes(join(b, ".git", "objects"));
  const full = await treeBytes(join(f.siblings[2], ".git", "objects"));
  assert.ok(full > 0, "the unshared copy holds a real pack");
  assert.ok(shared < full, `${shared} bytes in two shared checkouts should be less than ${full} bytes in one full copy`);
});

test("Spec 028 #8 sharing preserves the recorded head and a second pass is a no-op", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoots(t, 1);
  const [sibling] = f.siblings;
  await refreshCheckoutSiblings(f.roots[0], null, { storeDir: f.storeDir });
  const head = await git(sibling, "rev-parse", "HEAD");
  const alternates = await alternatesOf(sibling);
  const second = await refreshCheckoutSiblings(f.roots[0], null, { storeDir: f.storeDir });
  assert.deepEqual(second.shared, []);
  assert.deepEqual(second.findings, []);
  assert.equal(await git(sibling, "rev-parse", "HEAD"), head);
  assert.equal(await alternatesOf(sibling), alternates);
});

test("Spec 028 #9 changing one group's sibling source never changes the other group's build inputs", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoots(t, 2);
  for (const root of f.roots) await refreshCheckoutSiblings(root, null, { storeDir: f.storeDir });
  const treeAtFirst = await git(f.seed, "rev-parse", "HEAD^{tree}");
  const next = await advanceSeed(f.seed, "advance", "changed build input\n");
  await refreshCheckoutSiblings(f.roots[0], null, { storeDir: f.storeDir });
  const [a, b] = f.siblings;
  assert.equal(await git(a, "rev-parse", "HEAD"), next);
  // The other group keeps its recorded head, its exact tree and its working tree.
  assert.equal(await git(b, "rev-parse", "HEAD"), f.first);
  assert.equal(await git(b, "rev-parse", "HEAD^{tree}"), treeAtFirst);
  assert.equal(await git(b, "show", "HEAD:README.md"), "one");
  await git(b, "log", "--oneline");
  await writeFile(join(a, "README.md"), "tampered in group A\n");
  assert.equal(await readFile(join(b, "README.md"), "utf8"), "one\n");
});

test("Spec 028 #10 a cold store is rebuilt from the sibling's origin and the checkout keeps working", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoots(t, 2);
  for (const root of f.roots) await refreshCheckoutSiblings(root, null, { storeDir: f.storeDir });
  const next = await advanceSeed(f.seed, "after loss", "rebuilt\n");
  await rm(f.storeDir, { recursive: true, force: true });
  const result = await refreshCheckoutSiblings(f.roots[1], null, { storeDir: f.storeDir });
  assert.deepEqual(result.findings, []);
  const sibling = f.siblings[1];
  assert.equal(await git(sibling, "rev-parse", "HEAD"), next);
  await git(sibling, "log", "--oneline");
  const store = siblingStorePathFor(f.storeDir, f.bare);
  // A small origin fetch unpacks loose instead of packing; any object entry proves the rebuild.
  assert.ok((await readdir(join(store, "objects"))).some(name => name !== "info"));
  // The other group's checkout, which this pass never touched, reads its objects through the rebuilt store again.
  await git(f.siblings[0], "log", "--oneline");
  assert.equal(await git(f.siblings[0], "rev-parse", "HEAD"), f.first);
});

test("Spec 028 #11 a dirty sibling and a foreign object store are never migrated", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoots(t, 1);
  const [sibling] = f.siblings;
  const foreign = join(f.base, "foreign.git");
  await command("git", ["init", "--bare", foreign], f.base);
  await mkdir(join(sibling, ".git", "objects", "info"), { recursive: true });
  await writeFile(join(sibling, ".git", "objects", "info", "alternates"), `${join(foreign, "objects")}\n`);
  const result = await refreshCheckoutSiblings(f.roots[0], null, { storeDir: f.storeDir });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.shared, []);
  assert.equal(await alternatesOf(sibling), join(foreign, "objects"));
  assert.equal(await packCount(sibling), 1);
  assert.equal(existsSync(siblingStorePathFor(f.storeDir, f.bare)), false);
  const second = await siblingRoots(t, 1);
  await writeFile(join(second.siblings[0], "dirty.txt"), "keep\n");
  const dirty = await refreshCheckoutSiblings(second.roots[0], null, { storeDir: second.storeDir });
  assert.equal(dirty.findings[0]?.state, "dirty");
  assert.equal(await packCount(second.siblings[0]), 1);
});

test("a store failure is a store_failed finding and leaves the sibling a full copy", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoots(t, 1);
  const [sibling] = f.siblings;
  await mkdir(dirname(f.storeDir), { recursive: true });
  await writeFile(f.storeDir, "not a directory\n");
  const result = await refreshCheckoutSiblings(f.roots[0], null, { storeDir: f.storeDir });
  assert.equal(result.findings[0]?.state, "store_failed");
  assert.match(result.findings[0]!.detail, /shared object store/);
  assert.equal(await packCount(sibling), 1);
  assert.equal(await git(sibling, "rev-parse", "HEAD"), f.first);
  assert.equal(await git(sibling, "status", "--porcelain"), "");
});

test("different origins in one root share nothing with each other", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoots(t, 1);
  const otherBare = join(f.base, "beta.git");
  await command("git", ["init", "--bare", "--initial-branch=main", otherBare], f.base);
  const betaSeed = join(f.base, "beta-seed");
  await command("git", ["init", "--initial-branch=main", betaSeed], f.base);
  await identity(betaSeed);
  await commit(betaSeed, "beta init", { "README.md": "beta\n" });
  await git(betaSeed, "push", otherBare, "main");
  const beta = join(f.roots[0], "beta");
  await command("git", ["clone", "--no-local", otherBare, beta], f.base);
  await identity(beta);
  await git(beta, "remote", "set-head", "origin", "main");
  await git(beta, "checkout", "--detach", "HEAD");
  const result = await refreshCheckoutSiblings(f.roots[0], null, { storeDir: f.storeDir });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.shared.map(share => share.name).sort(), ["beta", "library"]);
  const libraryStore = siblingStorePathFor(f.storeDir, f.bare);
  const betaStore = siblingStorePathFor(f.storeDir, otherBare);
  assert.notEqual(libraryStore, betaStore);
  assert.equal(await alternatesOf(f.siblings[0]), join(libraryStore, "objects"));
  assert.equal(await alternatesOf(beta), join(betaStore, "objects"));
});

test("worker creation shares the sibling through the engine's data directory", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoot(t);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nsq-cs-share-")));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "queue.sqlite"));
  t.after(() => store.close());
  const engine = engineFor(t, store, f.root);
  engine.siblingDataDir = dir;
  const task = submit(store, "/project-a", "Worker creation shares");
  await engine.wake();
  assert.equal(store.task(task.id).phase, "working");
  assert.ok(existsSync(siblingStoreRootFor(dir)));
  const share = store.events(task.id).find(item => item.kind === "checkout_sibling_shared");
  assert.ok(share);
  assert.match(share!.detail, /library shares .+ at /);
  assert.equal(await packCount(f.sibling), 0);
  assert.equal(await git(f.sibling, "rev-parse", "HEAD"), f.first);
});

/** A foreign bare store with real objects, so an alternates entry naming it exists on disk. */
async function foreignStore(base: string, name: string) {
  const bare = join(base, name);
  await command("git", ["init", "--bare", "--initial-branch=main", bare], base);
  const seed = join(base, `${name}-seed`);
  await command("git", ["init", "--initial-branch=main", seed], base);
  await identity(seed);
  await commit(seed, "foreign init", { "README.md": "foreign\n" });
  await git(seed, "push", bare, "main");
  return bare;
}

test("a relative foreign alternates entry is never treated as vanished and never rewritten", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoots(t, 1);
  const [sibling] = f.siblings;
  const foreign = await foreignStore(f.base, "foreign.git");
  const entry = relative(join(sibling, ".git", "objects"), join(foreign, "objects"));
  await mkdir(join(sibling, ".git", "objects", "info"), { recursive: true });
  await writeFile(join(sibling, ".git", "objects", "info", "alternates"), `${entry}\n`);
  const result = await refreshCheckoutSiblings(f.roots[0], null, { storeDir: f.storeDir });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.shared, []);
  assert.equal(await readFile(join(sibling, ".git", "objects", "info", "alternates"), "utf8"), `${entry}\n`);
  assert.equal(await packCount(sibling), 1);
  assert.equal(existsSync(siblingStorePathFor(f.storeDir, f.bare)), false);
});

test("a multi-line alternates file is foreign and no line is ever dropped", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoots(t, 1);
  const [sibling] = f.siblings;
  const foreign = await foreignStore(f.base, "foreign.git");
  const absolute = join(foreign, "objects");
  const entry = relative(join(sibling, ".git", "objects"), absolute);
  const file = `# another tool owns this file\n${absolute}\n${entry}\n`;
  await mkdir(join(sibling, ".git", "objects", "info"), { recursive: true });
  await writeFile(join(sibling, ".git", "objects", "info", "alternates"), file);
  const result = await refreshCheckoutSiblings(f.roots[0], null, { storeDir: f.storeDir });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.shared, []);
  assert.equal(await readFile(join(sibling, ".git", "objects", "info", "alternates"), "utf8"), file);
  assert.equal(await packCount(sibling), 1);
});

test("an already-linked sibling's packed increment is absorbed by the store", { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await siblingRoots(t, 1);
  const [sibling] = f.siblings;
  const store = siblingStorePathFor(f.storeDir, f.bare);
  await refreshCheckoutSiblings(f.roots[0], null, { storeDir: f.storeDir });
  const next = await advanceSeed(f.seed, "packed increment", "increment\n");
  await git(sibling, "fetch", "origin");
  await git(sibling, "repack", "--quiet");
  assert.ok(await packCount(sibling) >= 1, "the increment starts as a local pack");
  const result = await refreshCheckoutSiblings(f.roots[0], null, { storeDir: f.storeDir });
  assert.deepEqual(result.findings, []);
  assert.equal(await git(sibling, "rev-parse", "HEAD"), next);
  await command("git", ["-C", store, "cat-file", "-e", `${next}^{commit}`], f.base);
  assert.equal(await packCount(sibling), 0);
});
