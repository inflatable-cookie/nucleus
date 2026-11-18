import { overrideWorktreeAddSearch } from "../core/machine/process-identity";
/**
 * Task 1255: a milestone QA checkout that dies mid-creation is cleaned up
 * under the run's ownership proof and retried once, never left as an
 * uncertain checkout retained for reconciliation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionOutcome } from "../core/machine/process-exec";
import {
  QA_CHECKOUT_CREATION_RETRY_DELAY_MS,
  runProjectQaPipeline,
  type QaPipelineIo,
  type QaPipelineRun,
} from "../core/qa/project-qa-pipeline";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A registered checkout with one commit; its HEAD is the run's base. */
async function registeredRepo(
  t: any,
): Promise<{ root: string; repo: string; base: string }> {
  const root = await mkdtemp(join(tmpdir(), "nsq-pqa-retry-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  );
  const repo = join(root, "registered");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  await writeFile(join(repo, "README.md"), "# fixture\n");
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=Queue test",
    "-c",
    "user.email=queue@example.invalid",
    "commit",
    "-qm",
    "initial",
  );
  return { root, repo, base: git(repo, "rev-parse", "HEAD").trim() };
}

const passOutcome = (): ExecutionOutcome => ({
  pid: null,
  code: 0,
  signal: null,
  timedOut: false,
  stdoutExceeded: false,
  stderrExceeded: false,
  stdout: Buffer.from("ok\n"),
  stderr: Buffer.alloc(0),
  durationMs: 2,
});

function pipelineIo(attempts: number[], delayMs: number): QaPipelineIo {
  return {
    persist: () => {},
    now: () => Date.now(),
    log: () => ({ bytes: 0, error: null }),
    onCheckoutAttempt: (attempt) => {
      attempts.push(attempt);
    },
    checkoutRetryDelayMs: delayMs,
    command: async () => passOutcome(),
    hook: async () => passOutcome(),
  };
}

function pipelineRun(params: {
  registered: string;
  runRoot: string;
  checkoutPath: string;
  base: string;
  admission: () => void;
}): QaPipelineRun {
  return {
    runId: randomUUID(),
    key: "fixture-origin",
    caller: "fixture-caller",
    base: params.base,
    baseBranch: "main",
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    checkoutPath: params.checkoutPath,
    checkoutAdmission: params.admission,
    registeredPath: params.registered,
    runRoot: params.runRoot,
    argv: ["effigy", "qa"],
    stages: [{ name: "qa", argv: ["effigy", "qa"], timeoutMs: 1000 }],
    timeoutMs: 60_000,
    maxOutputBytes: 1024,
    terminationGraceMs: 1000,
    epoch: 1,
    runClass: "light",
    links: [],
  };
}

test("a checkout creation killed partway is cleaned up and retried once, and the run proceeds", async (t) => {
  const { root, repo, base } = await registeredRepo(t);
  const runRoot = join(root, "run-root");
  const checkoutPath = join(root, "project-qa", "deadbeef", "run-id");
  // This fixture writes the partial directory itself and serializes each git attempt.
  overrideWorktreeAddSearch((path) =>
    path === checkoutPath ? { state: "absent" } : { state: "unknown" },
  );
  t.after(() => overrideWorktreeAddSearch(null));
  // The partial directory a killed `git worktree add` leaves behind.
  await mkdir(checkoutPath, { recursive: true });
  await writeFile(join(checkoutPath, "partial.bin"), "half a clone\n");
  const attempts: number[] = [];
  const run = pipelineRun({
    registered: repo,
    runRoot,
    checkoutPath,
    base,
    admission: () => {
      assert.equal(
        run.checkoutPath,
        checkoutPath,
        "the run proves its own allocation",
      );
    },
  });
  const outcome = await runProjectQaPipeline(
    { pid: process.pid, identityToken: randomUUID() },
    run,
    pipelineIo(attempts, 5),
  );
  assert.deepEqual(attempts, [1, 2], "creation is attempted exactly twice");
  assert.equal(outcome.state, "passed", "the retried run proceeds");
  assert.match(
    outcome.detail,
    /attempt 1 of 2/,
    "the first failure is recorded",
  );
  assert.match(
    outcome.detail,
    /removed the partial checkout and retrying once/,
    "the cleanup is recorded",
  );
  assert.equal(
    outcome.checkoutCleanupPending,
    undefined,
    "no cleanup stays pending",
  );
  assert.equal(
    existsSync(checkoutPath),
    false,
    "the checkout is removed after the run",
  );
});

test("two checkout creation failures record a plain failure, not an uncertain retention", async (t) => {
  const { root, repo } = await registeredRepo(t);
  const runRoot = join(root, "run-root");
  const checkoutPath = join(root, "project-qa", "deadbeef", "run-id");
  // This fixture writes the partial directory itself and serializes each git attempt.
  overrideWorktreeAddSearch((path) =>
    path === checkoutPath ? { state: "absent" } : { state: "unknown" },
  );
  t.after(() => overrideWorktreeAddSearch(null));
  const attempts: number[] = [];
  const run = pipelineRun({
    registered: repo,
    runRoot,
    checkoutPath,
    base: "f".repeat(40),
    admission: () => {
      assert.equal(
        run.checkoutPath,
        checkoutPath,
        "the run proves its own allocation",
      );
    },
  });
  const outcome = await runProjectQaPipeline(
    { pid: process.pid, identityToken: randomUUID() },
    run,
    pipelineIo(attempts, 5),
  );
  assert.deepEqual(
    attempts,
    [1, 2],
    "creation is attempted exactly twice, never more",
  );
  assert.equal(
    outcome.state,
    "hold",
    "the run settles without QA having started",
  );
  assert.match(
    outcome.detail,
    /attempt 1 of 2/,
    "the first failure is recorded",
  );
  assert.doesNotMatch(
    outcome.detail,
    /uncertain/i,
    "no uncertain checkout language",
  );
  assert.doesNotMatch(
    outcome.detail,
    /reconciliation/i,
    "no reconciliation handoff",
  );
  assert.equal(
    outcome.checkoutCleanupPending,
    undefined,
    "no cleanup stays pending",
  );
  assert.equal(
    existsSync(checkoutPath),
    false,
    "no partial checkout is left behind",
  );
});

test("the checkout retry backoff stays bounded", () => {
  assert.ok(
    QA_CHECKOUT_CREATION_RETRY_DELAY_MS <= 5000,
    `the single retry delay stays bounded, got ${QA_CHECKOUT_CREATION_RETRY_DELAY_MS}ms`,
  );
});
