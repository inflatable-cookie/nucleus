/**
 * #1408: Post-exit, pre-step-log supervisor settlement and recovery.
 *
 * Exercises the actual supervised execution and recovery paths for:
 * - bounded, attributable post-exit phases (descendant scan, pipe drain, live
 *   output flush, spawn persistence, phase writes and step-log writes);
 * - clean step exits advancing through later required stages and teardown;
 * - nonzero exits settling failed with the failing step and teardown;
 * - separating a genuine step failure (`failed`) from an interrupted clean exit
 *   (`hold`) without certifying skipped stages or teardown;
 * - clearing prior terminal receipts through normal follow-up runs without
 *   rewriting historical run rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeHookProgram } from "../core/machine/process-exec";
import { minimalHookEnvironment } from "../core/hooks/hook-result";
import { overrideIdentityListing } from "../core/machine/process-identity-search";
import { hostRunProcessStartIdentity } from "../core/machine/start-identity";
import { ProjectQaRunner } from "../core/qa/project-qa";
import { ProjectQaInspection } from "../core/qa/project-qa-inspection";
import { detachedSupervisorIo, type DetachedSupervisorIoOptions } from "../core/qa/project-qa-detached-io";
import { runProjectQaPipeline, type QaPipelineRun } from "../core/qa/project-qa-pipeline";
import { ProjectQaSchedules, qaScheduleStateKey } from "../core/qa/project-qa-schedule";
import { boardQaRuns } from "../core/qa/qa-board";
import {
  qaRunLiveOutputPath,
  qaStepLogPaths,
  qaSupervisionPaths,
  qaSupervisionPlanSchema,
  readQaPhase,
  writeQaSupervision,
  writeQaSupervisionPlan,
  type QaStepExit,
} from "../core/qa/project-qa-supervision-files";
import { writeQaJsonAsync } from "../core/qa/project-qa-async-io";
import { Store, digest } from "../core/store/store";
import { projectQaRunSchema, type ProjectQaStage } from "../shared/contracts";
import { scopedQaFixture } from "./support/scoped-qa";
import { noCpuReads } from "./support/scoped-identity";
import { waitFor } from "./support/budgets";

async function gitRepoFixture(t: { after(fn: () => unknown): void }, hooks?: { setup?: string; teardown?: string }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qa-post-exit-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  await mkdir(origin, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin], { encoding: "utf8" });
  execFileSync("git", ["clone", "-q", origin, repo], { encoding: "utf8" });
  const git = (...argv: string[]) => execFileSync("git", argv, { cwd: repo, encoding: "utf8" }).trim();
  git("checkout", "-q", "-B", "main");
  await writeFile(join(repo, "README.md"), "fixture\n");
  if (hooks) {
    await writeFile(join(repo, "paseo.json"), JSON.stringify({ worktree: hooks }, null, 2));
  }
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "init");
  git("push", "-q", "-u", "origin", "main");
  const hostRunStateDir = join(dataDir, "host-run");
  await mkdir(hostRunStateDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(hostRunStateDir, "token.key"),
    JSON.stringify({
      format: "host.run.keys",
      version: 1,
      current: { epoch: 1, keyB64: Buffer.alloc(32, 0x51).toString("base64") },
    }),
    { mode: 0o600 },
  );
  const head = git("rev-parse", "HEAD");
  return { root, repo, dataDir, hostRunStateDir, head, git };
}

async function pipelineRunFor(
  f: { root: string; repo: string; head: string },
  stages: ProjectQaStage[],
  ioOptions?: DetachedSupervisorIoOptions,
) {
  const runRoot = join(f.root, "runs");
  await mkdir(runRoot, { recursive: true });
  const runId = randomUUID();
  const identityToken = randomUUID();
  const run: QaPipelineRun = {
    runId,
    key: "fixture",
    caller: "fixture",
    base: f.head,
    baseBranch: "main",
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    checkoutPath: join(runRoot, runId),
    registeredPath: f.repo,
    runRoot,
    argv: stages[0].argv,
    stages,
    timeoutMs: 60_000,
    maxOutputBytes: 8192,
    terminationGraceMs: 100,
    epoch: 1,
    links: [],
    hostRunToken: "synthetic-host-run-token-36-chars-01",
    temporaryDirectory: f.root,
  };
  const plan = qaSupervisionPlanSchema.parse({
    ...run,
    schema: "queue.project-qa.plan.v1",
    schema_version: 1,
    identityToken,
    hookTimeoutMs: 10_000,
    hookMaxOutputBytes: 4096,
  });
  const paths = qaSupervisionPaths(runRoot, runId);
  const io = detachedSupervisorIo(plan, paths.statePath, run, noCpuReads, ioOptions);
  return { runRoot, runId, identityToken, run, plan, paths, io };
}

test("a stalled post-exit descendant scan is attributed, bounded and lets clean stages and teardown pass", { skip: process.platform === "win32" }, async (t) => {
  const f = await gitRepoFixture(t, { teardown: "echo teardown-ok" });
  const phases: string[] = [];
  const stalled = new Promise<never>(() => { /* intentionally unsettled until bound fires */ });

  // Shape matching the Praxis Rust2 run: 96 leaves complete, trailing partial
  // line shorter than the token, direct exit 0, followed by a required stage.
  const leafScript = [
    "for (let i = 1; i <= 96; i++) console.log(`ok ${i} - leaf-${i}`);",
    "process.stdout.write('all 96 leaves tail');",
  ].join(" ");
  const { run, plan, paths, io } = await pipelineRunFor(
    f,
    [
      { name: "rust2", argv: [process.execPath, "-e", leafScript], timeoutMs: 30_000 },
      { name: "after", argv: [process.execPath, "-e", "console.log('after-stage-ok')"], timeoutMs: 30_000 },
    ],
    {
      postExitObservationTimeoutMs: 60,
      observeEscapedDescendants: () => stalled,
    },
  );
  const originalPhase = io.phase!;
  const wrappedIo = {
    ...io,
    phase: (next: string) => {
      phases.push(next);
      return originalPhase(next);
    },
  };

  const started = Date.now();
  const outcome = await runProjectQaPipeline({ pid: process.pid, identityToken: plan.identityToken }, run, wrappedIo);
  const elapsedMs = Date.now() - started;

  assert.ok(elapsedMs < 10_000, `bounded post-exit scan finished promptly (${elapsedMs}ms)`);
  assert.equal(outcome.state, "passed", outcome.detail);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.failedStep, null);
  assert.deepEqual(outcome.steps.map(step => step.name), ["rust2", "after", "teardown"]);
  assert.ok(phases.includes("step-exit-descendants"), `attributed descendant scan phase: ${phases.join(", ")}`);
  assert.ok(phases.includes("step-spawn-persist"), `attributed spawn persist phase: ${phases.join(", ")}`);
  assert.ok(phases.includes("step-logs"), `attributed step-logs phase: ${phases.join(", ")}`);
  assert.match(outcome.detail, /escaped-descendant observation for step rust2 was unknown/i);

  const logs = qaStepLogPaths(run.runRoot, run.runId, "rust2");
  const stdoutLog = await readFile(logs.stdoutPath, "utf8");
  assert.match(stdoutLog, /ok 96 - leaf-96/);
  assert.match(stdoutLog, /all 96 leaves tail$/);
  const live = await readFile(qaRunLiveOutputPath(run.runRoot, run.runId), "utf8");
  assert.match(live, /all 96 leaves tail/);
  assert.match(live, /after-stage-ok/);
  assert.equal(readQaPhase(paths.phasePath, run.runId), "live-output-close");
});

test("bounded pipe drain, spawn persistence, phase writes and step-log writes never block a clean step result", { skip: process.platform === "win32" }, async (t) => {
  const f = await gitRepoFixture(t, { teardown: "echo teardown-ok" });
  const descendantPidFile = join(f.root, "pipe-holder.json");
  t.after(async () => {
    try {
      const { pid } = JSON.parse(await readFile(descendantPidFile, "utf8")) as { pid: number };
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  });

  // Leader exits 0 while a setsid descendant holds stdout open; meanwhile
  // spawnPersistence rejects, phase writes stall, and step-log write stalls.
  const innerScript = `require('fs').writeFileSync(${JSON.stringify(descendantPidFile)}, JSON.stringify({pid:process.pid})); setTimeout(()=>{}, 15000);`;
  const holderScript = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const c = spawn(process.execPath, ['-e', ${JSON.stringify(innerScript)}], { detached: true, stdio: ['ignore', 1, 2] });`,
    "c.unref();",
    `const waitReady = () => fs.existsSync(${JSON.stringify(descendantPidFile)}) ? (process.stdout.write('mid-line-output'), process.exit(0)) : setTimeout(waitReady, 20);`,
    "c.on('spawn', waitReady);",
  ].join(" ");

  const { run, plan, io } = await pipelineRunFor(
    f,
    [
      { name: "rust2", argv: [process.execPath, "-e", holderScript], timeoutMs: 30_000 },
      { name: "after", argv: [process.execPath, "-e", "console.log('after-ok')"], timeoutMs: 30_000 },
    ],
    {
      postExitPipeDrainTimeoutMs: 60,
      phaseTimeoutMs: 40,
      spawnPersistTimeoutMs: 40,
      logWriteTimeoutMs: 40,
    },
  );

  let persistCalls = 0;
  const wrappedIo = {
    ...io,
    phase: () => new Promise<void>(() => { /* stalled phase write */ }),
    persist: (state: Parameters<typeof io.persist>[0]) => {
      persistCalls++;
      if (persistCalls === 3) return Promise.reject(new Error("simulated spawn persist EIO"));
      return io.persist(state);
    },
    log: () => new Promise<{ bytes: null; error: string }>(() => { /* stalled step log write */ }),
  };

  const started = Date.now();
  const outcome = await runProjectQaPipeline({ pid: process.pid, identityToken: plan.identityToken }, run, wrappedIo);
  assert.ok(Date.now() - started < 10_000, "all stalled post-exit edges are bounded");
  assert.equal(outcome.state, "passed", outcome.detail);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.steps.map(step => step.name), ["rust2", "after", "teardown"]);
  assert.match(outcome.detail, /Spawn-state persistence for step rust2 failed: simulated spawn persist EIO/);
  assert.match(outcome.detail, /output pipe drain for step rust2 hit its bound/);
  assert.ok((outcome.logWriteErrors?.length ?? 0) >= 2, "stalled step-log writes are reported");
  const live = await readFile(qaRunLiveOutputPath(run.runRoot, run.runId), "utf8");
  assert.match(live, /mid-line-output/);
  assert.match(live, /after-ok/);
});

test("a real detached supervisor flushes mid-line output, runs a later required stage and settles passed on clean exit", { skip: process.platform === "win32" }, async (t) => {
  const f = await gitRepoFixture(t, { setup: "echo setup-ok", teardown: "echo teardown-ok" });
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("paused", false);
  const scope = scopedQaFixture(t, [f.root, f.dataDir]);

  store.putRepository({ origin: null, path: f.repo }, null, "", null, null, {
    stages: [
      // Unterminated short tail (< UUID token length) tests per-step live-output flush.
      { name: "rust2", argv: [process.execPath, "-e", "process.stdout.write('ok 1 - leaf\\ntail-no-nl')"], timeoutMs: 30_000 },
      { name: "verify", argv: [process.execPath, "-e", "console.log('verify-stage-passed')"], timeoutMs: 30_000 },
    ],
    maxOutputBytes: 4096,
    terminationGraceMs: 100,
  });

  const runner = new ProjectQaRunner(store, { dataDir: f.dataDir, hostRunStateDir: f.hostRunStateDir, supervisionPollMs: 25 });
  t.after(() => runner.hostRuns.stop());
  scope(runner);
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !["queued", "running"].includes(store.qaRun(started.id)?.state ?? ""), 30_000, "clean multi-stage run to settle");
  const settled = store.qaRun(started.id)!;

  assert.equal(settled.state, "passed", settled.outputTail);
  assert.equal(settled.exitCode, 0);
  assert.equal(settled.failedStep, null);
  assert.deepEqual(settled.steps.map(step => step.name), ["setup", "rust2", "verify", "teardown"]);
  assert.equal(settled.hostSettlement?.outcome, "passed");
  const runRoot = join(await realpath(f.dataDir), "project-qa", digest(started.key).slice(0, 24));
  const live = await readFile(qaRunLiveOutputPath(runRoot, started.id), "utf8");
  assert.match(live, /tail-no-nlverify-stage-passed/);
  await runner.attachSupervisor(started.id, started.key);
});

test("a real detached supervisor settles failed when a later required stage exits nonzero", { skip: process.platform === "win32" }, async (t) => {
  const f = await gitRepoFixture(t, { teardown: "echo teardown-after-fail" });
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("paused", false);
  const scope = scopedQaFixture(t, [f.root, f.dataDir]);

  store.putRepository({ origin: null, path: f.repo }, null, "", null, null, {
    stages: [
      { name: "rust2", argv: [process.execPath, "-e", "console.log('rust2-ok')"], timeoutMs: 30_000 },
      { name: "verify", argv: [process.execPath, "-e", "console.error('verify-failed'); process.exit(7)"], timeoutMs: 30_000 },
    ],
    maxOutputBytes: 4096,
    terminationGraceMs: 100,
  });

  const runner = new ProjectQaRunner(store, { dataDir: f.dataDir, hostRunStateDir: f.hostRunStateDir, supervisionPollMs: 25 });
  t.after(() => runner.hostRuns.stop());
  scope(runner);
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !["queued", "running"].includes(store.qaRun(started.id)?.state ?? ""), 30_000, "nonzero multi-stage run to settle");
  const settled = store.qaRun(started.id)!;

  assert.equal(settled.state, "failed", settled.outputTail);
  assert.equal(settled.exitCode, 7);
  assert.equal(settled.failedStep, "verify");
  assert.deepEqual(settled.steps.map(step => step.name), ["rust2", "verify", "teardown"]);
  assert.equal(settled.steps.find(step => step.name === "rust2")?.exitCode, 0);
  assert.equal(settled.steps.find(step => step.name === "verify")?.exitCode, 7);
  assert.equal(settled.steps.find(step => step.name === "teardown")?.exitCode, 0);
  assert.equal(settled.hostSettlement?.outcome, "failed");
  await runner.attachSupervisor(started.id, started.key);
});

test("settleOnEscapedDescendants custody and cancellation remain strict under unknown descendant scans", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qa-strict-custody-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childPidFile = join(root, "escaped.json");
  t.after(async () => {
    try {
      const { pid } = JSON.parse(await readFile(childPidFile, "utf8")) as { pid: number };
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  });

  overrideIdentityListing({ state: "unknown" });
  t.after(() => overrideIdentityListing(null));

  let cancelText: string | null = null;
  const childProg = `require('fs').writeFileSync(${JSON.stringify(childPidFile)}, JSON.stringify({pid:process.pid})); setTimeout(()=>{}, 15000);`;
  const parentScript = [
    "const { spawn } = require('node:child_process');",
    `const c = spawn(process.execPath, ['-e', ${JSON.stringify(childProg)}], { detached: true, stdio: 'ignore' });`,
    "c.unref();",
    "c.on('spawn', () => setTimeout(() => process.exit(0), 100));",
  ].join(" ");

  let settled = false;
  const running = executeHookProgram({
    root,
    executable: process.execPath,
    argv: ["-e", parentScript],
    stdin: Buffer.alloc(0),
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    overflow: "tail",
    terminationGraceMs: 100,
    settleOnProcessGroup: true,
    settleOnEscapedDescendants: true,
    postExitObservationTimeoutMs: 20,
    cancelReason: () => cancelText,
    env: minimalHookEnvironment("project-qa:strict-custody"),
  }).then(outcome => {
    settled = true;
    return outcome;
  });

  await waitFor(() => existsSync(childPidFile), 5_000, "escaped child to start");
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(settled, false, "unknown listing must not settle a live escaped child under settleOnEscapedDescendants");

  overrideIdentityListing(null);
  cancelText = "operator cancel during unknown custody";
  const outcome = await running;
  assert.equal(outcome.cancelled, true);
});

test("recovery separates an interrupted clean exit 0 (hold) from a genuine failure and preserves teardown state across retries", { skip: process.platform === "win32" }, async (t) => {
  const f = await gitRepoFixture(t, { teardown: "test -f .allow-teardown" });
  const store = new Store(":memory:");
  t.after(() => store.close());

  const runRoot = join(f.dataDir, "project-qa", digest(f.repo).slice(0, 24));
  await mkdir(runRoot, { recursive: true });
  const runId = randomUUID();
  const checkoutPath = join(runRoot, runId);
  execFileSync("git", ["worktree", "add", "--detach", checkoutPath, f.head], { cwd: f.repo, encoding: "utf8" });

  // Synthetic stalled supervisor process + empty exited step group + exit 0 + mid-line live log.
  const identityToken = randomUUID();
  const supervisor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", identityToken], {
    detached: true, stdio: "ignore", cwd: f.root,
  });
  t.after(() => { try { process.kill(-supervisor.pid!, "SIGKILL"); } catch { /* already stopped */ } });

  const finished = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
  await new Promise(resolve => finished.on("exit", resolve));
  const endedGroup = finished.pid!;

  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const paths = qaSupervisionPaths(runRoot, runId);
  const run = store.putQaRun(projectQaRunSchema.parse({
    id: runId,
    repository: { origin: null, path: f.repo },
    key: f.repo,
    state: "running",
    baseBranch: "main",
    base: f.head,
    argv: ["effigy", "rust2"],
    stages: [
      { name: "rust2", argv: ["effigy", "rust2"], timeoutMs: 30_000, maxOutputBytes: 4096 },
      { name: "later-required", argv: ["effigy", "later"], timeoutMs: 30_000, maxOutputBytes: 4096 },
    ],
    digest: "a".repeat(64),
    terminationGraceMs: 100,
    exitCode: null,
    durationMs: 0,
    outputTail: "",
    startedAt,
    finishedAt: null,
    pid: supervisor.pid!,
    capacityWait: null,
    capacityUnavailable: false,
    hostRunEpoch: 1,
  }));

  writeQaSupervisionPlan(paths.planPath, qaSupervisionPlanSchema.parse({
    schema: "queue.project-qa.plan.v1",
    schema_version: 1,
    runId,
    key: f.repo,
    caller: "fixture",
    base: f.head,
    baseBranch: "main",
    startedAt,
    startedAtMs: Date.parse(startedAt),
    checkoutPath,
    registeredPath: f.repo,
    runRoot,
    argv: run.argv,
    stages: run.stages,
    timeoutMs: 60_000,
    epoch: 1,
    runClass: "heavy",
    maxOutputBytes: 4096,
    terminationGraceMs: 100,
    hookTimeoutMs: 10_000,
    hookMaxOutputBytes: 4096,
    identityToken,
    links: [],
    mode: "full",
    attempt: 0,
    retry: null,
  }));
  writeQaSupervision(paths.statePath, {
    schema: "queue.project-qa.supervisor.v1",
    schema_version: 1,
    runId,
    key: f.repo,
    pid: supervisor.pid!,
    supervisorStartIdentity: hostRunProcessStartIdentity(supervisor.pid!),
    identityToken,
    startedAt,
    heartbeatAt: new Date().toISOString(),
    inFlight: "rust2",
    activeProcess: {
      step: "rust2",
      pid: endedGroup,
      processGroupId: endedGroup,
      startIdentity: hostRunProcessStartIdentity(endedGroup),
      leaderStartIdentity: identityToken,
      startedAt,
    },
    pendingProcessIdentity: null,
    steps: [],
    failedStep: null,
    logWriteErrors: [],
    detail: "",
    failuresLog: "",
    failureIndexes: [],
    escapedDescendants: [],
    cancelReason: null,
    result: null,
  });
  await writeQaJsonAsync(paths.phasePath, { runId, phase: "step-exit-descendants" }, { durable: false });
  const exitRecord: QaStepExit = {
    schema: "queue.project-qa.step-exit.v1",
    schema_version: 1,
    runId,
    step: "rust2",
    pid: endedGroup,
    processGroupId: endedGroup,
    exitCode: 0,
    signal: null,
    exitedAt: new Date(Date.now() - 35_000).toISOString(),
  };
  await writeQaJsonAsync(paths.stepExitPath, exitRecord, { durable: false });
  await writeFile(qaRunLiveOutputPath(runRoot, runId), "ok 96 - leaf\npartial mid-line");

  overrideIdentityListing(identity => identity === identityToken ? { state: "absent" } : { state: "unknown" });
  t.after(() => overrideIdentityListing(null));

  const runner = new ProjectQaRunner(store, { dataDir: f.dataDir, hostRunStateDir: f.hostRunStateDir, supervisionPollMs: 25 });
  t.after(() => runner.hostRuns.stop());
  const inspection = new ProjectQaInspection({ get: () => null }, () => runRoot, undefined, { stepSettleBoundMs: 50 });
  assert.equal((await inspection.inspectSupervisor(run)).kind, "running");
  let verdict = await inspection.inspectSupervisor(run);
  for (let attempt = 0; verdict.kind === "running" && attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    verdict = await inspection.inspectSupervisor(run);
  }
  assert.equal(verdict.kind, "step_ended", JSON.stringify(verdict));
  if (verdict.kind !== "step_ended") return;

  await runner.settleEndedStep(run, verdict);
  const settled = store.qaRun(runId)!;
  assert.equal(settled.state, "hold", settled.outputTail);
  assert.equal(settled.exitCode, 0, "preserves direct exit 0");
  assert.equal(settled.interruptedStep, "rust2");
  assert.equal(settled.failedStep, "teardown", "only teardown failed; clean exit 0 step is not blamed");
  const rust2Step = settled.steps.find(step => step.name === "rust2")!;
  assert.equal(rust2Step.exitCode, 0);
  assert.equal(rust2Step.signal, null);
  assert.equal(settled.steps.some(step => step.name === "later-required"), false, "unrun later stage is not certified");
  assert.match(settled.outputTail, /Last supervisor phase: step-exit-descendants/);
  assert.match(settled.outputTail, /Live output log: .*\.live\.log at byte \d+/);
  assert.match(settled.outputTail, /Teardown state: failed during recovery; checkout retained/);
  assert.match(settled.outputTail, /infrastructure interruption, not a step failure/);
  assert.equal(existsSync(checkoutPath), true, "retained checkout stays for teardown retry");

  // Even after teardown succeeds on retry, the unproved pipeline stays `hold` (never `passed`).
  await writeFile(join(checkoutPath, ".allow-teardown"), "ok\n");
  const scope = scopedQaFixture(t, [f.root, f.dataDir]);
  scope(runner);
  await runner.retryTeardown({ id: runId, reason: "retry teardown after interrupted clean exit" });
  await waitFor(() => !["queued", "running"].includes(store.qaRun(runId)?.state ?? ""), 30_000, "teardown retry to settle");
  await runner.attachSupervisor(runId, f.repo);
  const afterRetry = store.qaRun(runId)!;
  assert.equal(afterRetry.state, "hold", "a clean step exit never certifies skipped stages even after teardown retry");
  assert.equal(afterRetry.failedStep, null);
  assert.equal(afterRetry.interruptedStep, "rust2");
  assert.equal(existsSync(checkoutPath), false, "successful teardown retry removes the retained checkout");
});

test("a dead supervisor with a recorded step exit preserves the direct exit and partial log instead of settling lost", { skip: process.platform === "win32" }, async (t) => {
  const f = await gitRepoFixture(t);
  const store = new Store(":memory:");
  t.after(() => store.close());

  const runRoot = join(f.dataDir, "project-qa", digest("fixture").slice(0, 24));
  await mkdir(runRoot, { recursive: true });
  const runId = randomUUID();
  const identityToken = randomUUID();
  const deadSupervisor = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
  await new Promise(resolve => deadSupervisor.on("exit", resolve));
  const finished = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
  await new Promise(resolve => finished.on("exit", resolve));

  overrideIdentityListing(identity => identity === identityToken ? { state: "absent" } : { state: "unknown" });
  t.after(() => overrideIdentityListing(null));

  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const paths = qaSupervisionPaths(runRoot, runId);
  const run = store.putQaRun(projectQaRunSchema.parse({
    id: runId,
    repository: { origin: null, path: f.repo },
    key: "fixture",
    state: "running",
    baseBranch: "main",
    base: f.head,
    argv: ["effigy", "qa"],
    digest: "b".repeat(64),
    exitCode: null,
    durationMs: 0,
    outputTail: "",
    startedAt,
    finishedAt: null,
    pid: deadSupervisor.pid!,
    capacityWait: null,
    capacityUnavailable: false,
  }));
  writeQaSupervisionPlan(paths.planPath, qaSupervisionPlanSchema.parse({
    schema: "queue.project-qa.plan.v1",
    schema_version: 1,
    runId,
    key: "fixture",
    caller: "fixture",
    base: f.head,
    baseBranch: "main",
    startedAt,
    startedAtMs: Date.parse(startedAt),
    checkoutPath: join(runRoot, runId),
    registeredPath: f.repo,
    runRoot,
    argv: run.argv,
    timeoutMs: 60_000,
    epoch: 1,
    runClass: "heavy",
    maxOutputBytes: 4096,
    terminationGraceMs: 100,
    hookTimeoutMs: 10_000,
    hookMaxOutputBytes: 4096,
    identityToken,
    links: [],
    mode: "full",
    attempt: 0,
    retry: null,
  }));
  writeQaSupervision(paths.statePath, {
    schema: "queue.project-qa.supervisor.v1",
    schema_version: 1,
    runId,
    key: "fixture",
    pid: deadSupervisor.pid!,
    supervisorStartIdentity: hostRunProcessStartIdentity(deadSupervisor.pid!),
    identityToken,
    startedAt,
    heartbeatAt: new Date().toISOString(),
    inFlight: "qa",
    activeProcess: {
      step: "qa",
      pid: finished.pid!,
      processGroupId: finished.pid!,
      startIdentity: hostRunProcessStartIdentity(finished.pid!),
      leaderStartIdentity: identityToken,
      startedAt,
    },
    pendingProcessIdentity: null,
    steps: [],
    failedStep: null,
    logWriteErrors: [],
    detail: "",
    failuresLog: "",
    failureIndexes: [],
    escapedDescendants: [],
    cancelReason: null,
    result: null,
  });
  await writeQaJsonAsync(paths.stepExitPath, {
    schema: "queue.project-qa.step-exit.v1",
    schema_version: 1,
    runId,
    step: "qa",
    pid: finished.pid!,
    processGroupId: finished.pid!,
    exitCode: 0,
    signal: null,
    exitedAt: new Date().toISOString(),
  }, { durable: false });
  await writeFile(qaRunLiveOutputPath(runRoot, runId), "partial log before supervisor exit");

  const inspection = new ProjectQaInspection({ get: () => null }, () => runRoot);
  const verdict = await inspection.inspectSupervisor(run);
  assert.equal(verdict.kind, "step_ended", JSON.stringify(verdict));
  if (verdict.kind !== "step_ended") return;

  const runner = new ProjectQaRunner(store, { dataDir: f.dataDir, hostRunStateDir: f.hostRunStateDir });
  t.after(() => runner.hostRuns.stop());
  await runner.settleEndedStep(run, verdict);
  const settled = store.qaRun(runId)!;
  assert.equal(settled.state, "hold");
  assert.equal(settled.exitCode, 0);
  assert.equal(settled.failedStep, null);
  assert.equal(settled.interruptedStep, "qa");
  assert.match(settled.outputTail, /partial log before supervisor exit/);
  assert.match(settled.outputTail, /Teardown state: not run \(checkout absent\)/);
});

test("normal follow-up runs clear existing terminal receipts and board/schedule state without rewriting historical runs", { skip: process.platform === "win32" }, async (t) => {
  const f = await gitRepoFixture(t);
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("paused", false);
  const scope = scopedQaFixture(t, [f.root, f.dataDir]);

  const historicalId = "historical-praxis-run";
  const historical = store.putQaRun(projectQaRunSchema.parse({
    id: historicalId,
    repository: { origin: null, path: f.repo },
    key: f.repo,
    state: "failed",
    baseBranch: "main",
    base: f.head,
    argv: [process.execPath, "-e", "console.log('pass')"],
    digest: "c".repeat(64),
    exitCode: 0,
    durationMs: 3_234_013,
    outputTail: "settled failed despite exit 0 under prior release",
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    finishedAt: new Date(Date.now() - 60_000).toISOString(),
    pid: null,
    capacityWait: null,
    capacityUnavailable: false,
    failedStep: "qa",
    interruptedStep: "qa",
  }));
  const historicalSnapshot = JSON.stringify(historical);

  store.putRepository({ origin: null, path: f.repo }, null, "", null, null, {
    stages: [{ name: "qa", argv: [process.execPath, "-e", "console.log('follow-up-ok')"], timeoutMs: 30_000 }],
    maxOutputBytes: 4096,
    terminationGraceMs: 100,
    schedule: { afterMerges: 1, maxIntervalHours: 24 },
  });
  const project = store.projectFor(f.repo, null)!;
  store.setProjectPlanner({ key: project.key, agentId: "planner-1", setBy: "test" });

  // Record a red episode against the historical terminal receipt.
  store.setMeta(qaScheduleStateKey(f.repo), {
    enabledAt: new Date(Date.now() - 180_000).toISOString(),
    requestGeneration: 0,
    pending: null,
    lastSignature: null,
    observedRun: historicalId,
    redSince: new Date(Date.now() - 60_000).toISOString(),
    lastReminderAt: new Date(Date.now() - 60_000).toISOString(),
    decisionId: null,
    diagnostic: "",
  });

  const runner = new ProjectQaRunner(store, { dataDir: f.dataDir, hostRunStateDir: f.hostRunStateDir, supervisionPollMs: 25 });
  t.after(() => runner.hostRuns.stop());
  scope(runner);
  const followUp = await runner.run({ repository: f.repo });
  await waitFor(() => !["queued", "running"].includes(store.qaRun(followUp.id)?.state ?? ""), 30_000, "follow-up run to pass");

  const schedules = new ProjectQaSchedules(store, runner);
  await schedules.tick();

  assert.equal(JSON.stringify(store.qaRun(historicalId)), historicalSnapshot, "historical run row is never rewritten");
  const latest = store.latestQaRun(f.repo)!;
  assert.equal(latest.id, followUp.id);
  assert.equal(latest.state, "passed");
  const cards = boardQaRuns(store.latestQaRuns(), Date.now());
  assert.equal(cards.find(card => card.key === f.repo)?.state, "passed");
  const scheduleState = store.getMeta<{ observedRun: string | null; redSince: string | null }>(qaScheduleStateKey(f.repo))!;
  assert.equal(scheduleState.observedRun, followUp.id);
  assert.equal(scheduleState.redSince, null, "passing follow-up clears the red episode");
  await runner.attachSupervisor(followUp.id, followUp.key);
});
