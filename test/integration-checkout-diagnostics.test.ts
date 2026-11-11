import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_SLOW_TIMEOUT_MS, GitBulkCommandError, IntegrationCheckoutCleanupError, bulkGitFailure, cleanupIntegrationCheckout, command, git, withIntegrationCheckout } from "../core/git/index";
import type { Task } from "../shared/contracts";

/** Node's execFile error shape: `killed` marks a child Node terminated itself. */
const execFailure = (fields: Record<string, unknown>) => Object.assign(new Error("Command failed: git worktree add"), fields);
const add = ["worktree", "add", "/private/checkout", "release/v0.5"];

test("a timeout is witnessed by Node's killed flag and reports the slow budget", () => {
  const error = bulkGitFailure(add, GIT_SLOW_TIMEOUT_MS, 600012, execFailure({
    code: null, killed: true, signal: "SIGTERM", stdout: "", stderr: "Updating files:  86% (33012/38578)\r",
  }));
  assert.equal(error.timedOut, true);
  assert.equal(error.killed, true);
  assert.equal(error.exitCode, null);
  assert.equal(error.signal, "SIGTERM");
  assert.equal(error.budgetMs, 600000);
  assert.equal(error.message, "git worktree add timed out and was terminated by SIGTERM (budget 600000ms, elapsed 600012ms): Updating files:  86% (33012/38578)");
});

test("a git exit keeps its code and fatal line and is not labelled a timeout", () => {
  const error = bulkGitFailure(add, GIT_SLOW_TIMEOUT_MS, 412, execFailure({
    code: 128, killed: false, signal: null, stderr: "Preparing worktree\nfatal: '/private/checkout' already exists\n",
  }));
  assert.ok(error instanceof GitBulkCommandError);
  assert.equal(error.timedOut, false);
  assert.equal(error.killed, false);
  assert.equal(error.budgetMs, GIT_SLOW_TIMEOUT_MS);
  assert.equal(error.exitCode, 128);
  assert.equal(error.signal, null);
  assert.equal(error.stderr, "Preparing worktree\nfatal: '/private/checkout' already exists");
  assert.equal(error.message, "git worktree add exited with code 128 (budget 600000ms, elapsed 412ms): Preparing worktree\nfatal: '/private/checkout' already exists");
});

test("an external signal without Node's kill flag is not a timeout", () => {
  const error = bulkGitFailure(add, GIT_SLOW_TIMEOUT_MS, 9000, execFailure({ code: null, killed: false, signal: "SIGKILL" }));
  assert.equal(error.timedOut, false);
  assert.equal(error.killed, false);
  assert.equal(error.signal, "SIGKILL");
  assert.equal(error.message, "git worktree add was terminated by SIGKILL (budget 600000ms, elapsed 9000ms)");
});

test("an output overrun is distinct from a timeout even though Node kills the child", () => {
  const error = bulkGitFailure(add, GIT_SLOW_TIMEOUT_MS, 3000, execFailure({
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGTERM",
  }));
  assert.equal(error.timedOut, false);
  // Node's killed witness is kept even though an overrun is not a timeout.
  assert.equal(error.killed, true);
  assert.equal(error.message, "git worktree add exceeded its 8388608-byte output limit and was terminated by SIGTERM (budget 600000ms, elapsed 3000ms)");
});

test("a failure without exit evidence says so instead of guessing", () => {
  const error = bulkGitFailure(add, GIT_SLOW_TIMEOUT_MS, 5, execFailure({ code: "ENOENT" }));
  assert.equal(error.timedOut, false);
  assert.equal(error.exitCode, null);
  assert.equal(error.killed, false);
  assert.equal(error.message, "git worktree add failed without exit evidence (ENOENT) (budget 600000ms, elapsed 5ms)");
});

test("diagnostic output keeps the last lines, redacts URL credentials and caps length", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
  const credentialed = bulkGitFailure(add, GIT_SLOW_TIMEOUT_MS, 1, execFailure({
    code: 128, stderr: `${lines}\nfatal: https://oauth2:ghp_secret@github.com/o/r.git unreachable`,
  }));
  assert.doesNotMatch(credentialed.stderr, /ghp_secret/);
  assert.match(credentialed.stderr, /https:\/\/\*\*\*@github\.com\/o\/r\.git unreachable$/);
  assert.doesNotMatch(credentialed.stderr, /line 12\n/);
  assert.match(credentialed.stderr, /^line 13\n/);

  const long = bulkGitFailure(add, GIT_SLOW_TIMEOUT_MS, 1, execFailure({ code: 128, stderr: "x".repeat(5000) }));
  assert.ok(long.stderr.startsWith("…"));
  assert.ok(long.stderr.length <= 2001);
});

test("a real no-force remove refusal keeps git's exit code and preserves the dirty checkout", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nsq-bulk-git-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), checkout = join(root, "checkout");
  await command("git", ["init", "--initial-branch=main", repo], root);
  await git(repo, "config", "user.name", "Queue test");
  await git(repo, "config", "user.email", "queue@example.invalid");
  await writeFile(join(repo, "base.txt"), "base");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "base");
  await git(repo, "worktree", "add", "--detach", checkout);
  await writeFile(join(checkout, "dirty.txt"), "preserve");

  const error = await cleanupIntegrationCheckout(repo, root, checkout, true).then(() => assert.fail("dirty remove must refuse"), (failure: unknown) => failure);
  assert.ok(error instanceof GitBulkCommandError);
  assert.equal(error.budgetMs, GIT_SLOW_TIMEOUT_MS);
  assert.equal(error.timedOut, false);
  assert.equal(error.exitCode, 128);
  assert.match(error.stderr, /modified or untracked files/);
  assert.match(await git(repo, "worktree", "list", "--porcelain"), new RegExp(checkout));
  assert.equal(await git(checkout, "status", "--porcelain"), "?? dirty.txt");
});

async function releaseRepo(t: { after: (fn: () => unknown) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nsq-bulk-route-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await command("git", ["init", "--initial-branch=main", repo], root);
  await git(repo, "config", "user.name", "Queue test");
  await git(repo, "config", "user.email", "queue@example.invalid");
  await writeFile(join(repo, "base.txt"), "base");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "base");
  await git(repo, "branch", "release/v0.5");
  return { root, repo };
}

test("a selected-base add refused by Git routes through the slow budget and leaves main and the owner untouched", async t => {
  const { root, repo } = await releaseRepo(t);
  const owned = join(root, "owned");
  await git(repo, "worktree", "add", owned, "release/v0.5");
  const mainHead = await git(repo, "rev-parse", "HEAD");
  const task = { repoPath: repo, baseBranch: "release/v0.5", brief: { text: "brief" } } as Task;

  const error = await withIntegrationCheckout(task, async () => assert.fail("operation must not run after a refused add")).then(() => assert.fail("refused add must reject"), (failure: unknown) => failure);
  assert.ok(error instanceof GitBulkCommandError);
  assert.equal(error.args[0], "worktree");
  assert.equal(error.args[1], "add");
  assert.equal(error.budgetMs, GIT_SLOW_TIMEOUT_MS);
  assert.equal(error.timedOut, false);
  assert.equal(error.exitCode, 128);
  assert.match(error.stderr, /already.*(?:checked out|used)/);
  assert.match(error.message, /^git worktree add exited with code 128 \(budget 600000ms, elapsed \d+ms\): [^\n]*\nfatal: .*already/);
  // No private registration survives: the refused add was never a registered checkout.
  const listing = await git(repo, "worktree", "list", "--porcelain");
  assert.equal(listing.split("\n").filter(line => line.startsWith("worktree ")).length, 2);
  assert.equal(await git(repo, "branch", "--show-current"), "main");
  assert.equal(await git(repo, "rev-parse", "HEAD"), mainHead);
  assert.equal(await git(owned, "branch", "--show-current"), "release/v0.5");
});

test("a refused cleanup after a failed operation keeps both failures and the dirty checkout", async t => {
  const { root, repo } = await releaseRepo(t);
  const task = { repoPath: repo, baseBranch: "release/v0.5", brief: { text: "brief" } } as Task;
  let checkout = "";

  const error = await withIntegrationCheckout(task, async (path) => {
    checkout = path;
    await writeFile(join(path, "untracked.txt"), "preserve");
    throw new Error("operation failed after writing");
  }).then(() => assert.fail("operation failure must reject"), (failure: unknown) => failure);

  assert.ok(error instanceof IntegrationCheckoutCleanupError);
  assert.equal((error.operationError as Error).message, "operation failed after writing");
  assert.ok(error.cause instanceof GitBulkCommandError);
  assert.equal(error.cause.exitCode, 128);
  assert.equal(error.cause.timedOut, false);
  assert.match(error.cause.stderr, /modified or untracked files/);
  assert.match(error.message, /modified or untracked files.*the integration operation failed first: operation failed after writing$/s);
  assert.match(await git(repo, "worktree", "list", "--porcelain"), new RegExp(checkout));
  assert.equal(await git(checkout, "status", "--porcelain"), "?? untracked.txt");
});

test("a registered add that cleanup cannot prove absent is preserved with its root", async t => {
  const { root, repo } = await releaseRepo(t);
  const registered = join(root, "partial-checkout");
  await git(repo, "worktree", "add", "--detach", registered);

  const refusal = await cleanupIntegrationCheckout(repo, root, registered, false).then(() => assert.fail("registered checkout must be preserved"), (failure: unknown) => failure);
  assert.match((refusal as Error).message, /^Preserving uncertain private integration worktree: /);
  assert.equal((await stat(root)).isDirectory(), true);
  assert.match(await git(repo, "worktree", "list", "--porcelain"), new RegExp(registered));
});
