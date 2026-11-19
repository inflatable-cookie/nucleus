/**
 * #1393: a host run whose process group exits records its exit code or signal
 * and its output tail, and settles promptly, never as an unexplained `lost`.
 *
 * The executor publishes the direct child's exit the moment the kernel reports
 * it, the supervisor keeps that record beside the run ahead of its own step log,
 * and the service settles a run whose step group is empty but whose supervisor
 * wrote no settlement from that record — never from "nothing happened".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeHookProgram, type ChildExitFacts } from "../core/machine/process-exec";
import { minimalHookEnvironment } from "../core/hooks/hook-result";
import { hostRunProcessStartIdentity } from "../core/machine/start-identity";
import { overrideIdentityListing, processStartIdentityEnvironment } from "../core/machine/process-identity-search";
import { processGroupEmpty } from "../core/machine/process-group";
import { pidAlive } from "../core/machine/pid";
import {
  qaRunLiveOutputPath,
  qaStepExitSchema,
  qaSupervisionPaths,
  qaSupervisionPlanSchema,
  readQaStepExit,
  readQaSupervision,
  writeQaSupervision,
  writeQaSupervisionPlan,
  type QaStepExit,
} from "../core/qa/project-qa-supervision-files";
import { writeQaJsonAsync } from "../core/qa/project-qa-async-io";
import { detachedSupervisorIo } from "../core/qa/project-qa-detached-io";
import { runProjectQaPipeline, type QaPipelineRun } from "../core/qa/project-qa-pipeline";
import { ProjectQaInspection } from "../core/qa/project-qa-inspection";
import { projectQaRecovery, qaOutputPointerDetail } from "../core/qa/project-qa-recovery";
import { noCpuReads } from "./support/scoped-identity";

const executorEnv = () => minimalHookEnvironment("project-qa:step-exit");

test("the executor publishes the direct child's exit code and time before the step settles", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qa-step-exit-code-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exits: ChildExitFacts[] = [];
  const outcome = await executeHookProgram({
    root, executable: "/bin/sh", argv: ["-c", "printf 'some output\\n'; exit 7"],
    stdin: Buffer.alloc(0), timeoutMs: 10_000, maxOutputBytes: 4096, overflow: "tail",
    env: executorEnv(), settleOnProcessGroup: true, onChildExit: exit => exits.push(exit),
  });
  assert.equal(outcome.code, 7);
  assert.equal(exits.length, 1, "the exit is published exactly once");
  assert.equal(exits[0].exitCode, 7);
  assert.equal(exits[0].signal, null);
  assert.equal(exits[0].pid, outcome.pid);
  assert.ok(Number.isFinite(Date.parse(exits[0].exitedAt)), "the exit time is recorded");
});

test("a step group killed from outside publishes the signal that ended it", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qa-step-exit-signal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exits: ChildExitFacts[] = [];
  let group: number | null = null;
  const running = executeHookProgram({
    root, executable: "/bin/sh", argv: ["-c", "printf 'stage output\\n'; sleep 30"],
    stdin: Buffer.alloc(0), timeoutMs: 60_000, maxOutputBytes: 4096, overflow: "tail",
    env: executorEnv(), settleOnProcessGroup: true, onChildExit: exit => exits.push(exit),
    onSpawn: (pid, processGroupId) => { group = processGroupId ?? pid; },
  });
  t.after(() => { if (group) try { process.kill(-group, "SIGKILL"); } catch { /* already gone */ } });
  while (!group) await new Promise(resolve => setTimeout(resolve, 20));
  process.kill(-group, "SIGKILL");
  const outcome = await running;
  assert.equal(outcome.code, null);
  assert.equal(outcome.signal, "SIGKILL");
  assert.equal(exits.length, 1);
  assert.equal(exits[0].signal, "SIGKILL");
  assert.equal(exits[0].exitCode, null);
  assert.equal(outcome.stdout.toString("utf8").includes("stage output"), true, "output before the kill is kept");
});

/** One committed repository for the pipeline's checkout, under the test's own scratch. */
async function pipelineFixture(t: { after(fn: () => unknown): void }, stageArgv: string[]) {
  const root = await mkdtemp(join(tmpdir(), "qa-step-exit-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "registered");
  await mkdir(repo);
  const git = (...argv: string[]) => execFileSync("git", argv, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  await writeFile(join(repo, "README.md"), "fixture\n");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const runRoot = join(root, "runs");
  await mkdir(runRoot);
  const runId = randomUUID();
  const identityToken = randomUUID();
  const run: QaPipelineRun = {
    runId, key: "fixture", caller: "fixture", base: git("rev-parse", "HEAD"), baseBranch: "main",
    startedAt: new Date().toISOString(), startedAtMs: Date.now(),
    checkoutPath: join(runRoot, runId), registeredPath: repo, runRoot,
    argv: stageArgv,
    stages: [{ name: "qa", argv: stageArgv, timeoutMs: 30_000 }],
    timeoutMs: 60_000, maxOutputBytes: 4096, terminationGraceMs: 100, epoch: 1, links: [],
    hostRunToken: "synthetic-token", temporaryDirectory: root,
  };
  const plan = qaSupervisionPlanSchema.parse({
    ...run, schema: "queue.project-qa.plan.v1", schema_version: 1, identityToken,
    hookTimeoutMs: 10_000, hookMaxOutputBytes: 1024,
  });
  const paths = qaSupervisionPaths(runRoot, runId);
  return { run, plan, paths, io: detachedSupervisorIo(plan, paths.statePath, run, noCpuReads) };
}

test("a step exiting non-zero records its exit code on the step and on its own exit record", { skip: process.platform === "win32" }, async (t) => {
  const f = await pipelineFixture(t, ["/bin/sh", "-c", "printf 'some output\\n'; exit 7"]);
  const outcome = await runProjectQaPipeline({ pid: process.pid, identityToken: f.plan.identityToken }, f.run, f.io);
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.steps.find(step => step.name === "qa")!.exitCode, 7);
  const exit = readQaStepExit(f.paths.stepExitPath, { runId: f.run.runId, step: "qa" });
  assert.ok(exit, "the supervisor keeps the step's own exit beside the run");
  assert.equal(qaStepExitSchema.safeParse(exit).success, true);
  assert.equal(exit!.exitCode, 7);
  assert.equal(exit!.signal, null);
  assert.equal(exit!.processGroupId, exit!.pid, "a detached step leader's pid is its group id");
  assert.ok(Number.isFinite(Date.parse(exit!.exitedAt)));
});

test("a step group killed from outside settles the run failed with that signal and its output", { skip: process.platform === "win32" }, async (t) => {
  const f = await pipelineFixture(t, ["/bin/sh", "-c", "printf 'build output line\\n'; sleep 30"]);
  const running = runProjectQaPipeline({ pid: process.pid, identityToken: f.plan.identityToken }, f.run, f.io);
  // Kill the step's own process group once its output is being produced, so the
  // run's retained output and the settlement can be checked against real bytes.
  let group: number | null = null;
  const deadline = Date.now() + 20_000;
  while (!group && Date.now() < deadline) {
    group = readQaSupervision(f.paths.statePath)?.activeProcess?.processGroupId ?? null;
    if (!group) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(group, "the supervisor publishes the step's process group before it ends");
  await new Promise(resolve => setTimeout(resolve, 300));
  process.kill(-group, "SIGKILL");
  const outcome = await running;
  assert.equal(outcome.state, "failed", outcome.detail);
  const exited = outcome.steps.find(step => step.name === "qa")!;
  assert.equal(exited.signal, "SIGKILL");
  assert.equal(exited.exitCode, null);
  assert.equal(exited.processGroupId, group);
  assert.match(outcome.detail, /qa terminated by SIGKILL/);
  assert.match(`${exited.stdoutHead}${exited.stdoutTail}`, /build output line/, "the output produced before the kill is kept");
  const exit = readQaStepExit(f.paths.stepExitPath, { runId: f.run.runId, step: "qa" })!;
  assert.equal(exit.signal, "SIGKILL");
});

/**
 * One supervision record for the inspection decisions: a live process carrying
 * the run token is the supervisor, a pid whose group is already gone is the
 * step's own ended group, and a step-exit record names that exit.
 */
async function inspectionFixture(t: any, options: {
  /** Written to both the state and the separate heartbeat file; absent is fresh. */
  heartbeatAt?: string;
  boundMs?: number;
  /** The publication window: the record names only the pending step identity. */
  pendingOnly?: boolean;
  beforeStepStop?: (statePath: string) => void | Promise<void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "qa-step-exit-inspection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runRoot = join(root, "runs");
  await mkdir(runRoot);
  const runId = randomUUID();
  const identityToken = randomUUID();
  const supervisor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", identityToken],
    { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-supervisor.pid!, "SIGKILL"); } catch { /* already stopped */ } });
  overrideIdentityListing(identity => identity === identityToken ? { state: "absent" } : { state: "unknown" });
  t.after(() => overrideIdentityListing(null));
  const finished = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
  await new Promise(resolve => finished.on("exit", resolve));
  const endedGroup = finished.pid!;
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const heartbeatAt = options.heartbeatAt ?? new Date().toISOString();
  const paths = qaSupervisionPaths(runRoot, runId);
  writeQaSupervisionPlan(paths.planPath, qaSupervisionPlanSchema.parse({
    schema: "queue.project-qa.plan.v1", schema_version: 1, runId, key: "fixture", caller: "fixture",
    base: "a".repeat(40), baseBranch: "main", startedAt, startedAtMs: Date.parse(startedAt),
    checkoutPath: join(runRoot, runId), registeredPath: join(root, "registered"), runRoot,
    argv: ["true"], timeoutMs: 60_000, epoch: 1, runClass: "heavy", maxOutputBytes: 1024,
    terminationGraceMs: 1000, hookTimeoutMs: 1000, hookMaxOutputBytes: 1024,
    identityToken, links: [], mode: "full", attempt: 0, retry: null,
  }));
  const state = {
    schema: "queue.project-qa.supervisor.v1" as const, schema_version: 1 as const, runId, key: "fixture",
    pid: supervisor.pid!, supervisorStartIdentity: hostRunProcessStartIdentity(supervisor.pid!),
    identityToken, startedAt, heartbeatAt,
    inFlight: "qa" as const,
    pendingProcessIdentity: options.pendingOnly ? identityToken : null,
    steps: [], failedStep: null, logWriteErrors: [],
    activeProcess: options.pendingOnly ? null : {
      step: "qa", pid: endedGroup, processGroupId: endedGroup,
      startIdentity: hostRunProcessStartIdentity(endedGroup), leaderStartIdentity: identityToken,
      startedAt: new Date(Date.now() - 45_000).toISOString(),
    },
    detail: "build output line", failuresLog: "", failureIndexes: [], escapedDescendants: [],
    cancelReason: null, result: null,
  };
  writeQaSupervision(paths.statePath, state);
  if (options.heartbeatAt)
    await writeQaJsonAsync(paths.heartbeatPath,
      { runId, pid: supervisor.pid!, identityToken, heartbeatAt: options.heartbeatAt }, { durable: false });
  const exit: QaStepExit = {
    schema: "queue.project-qa.step-exit.v1", schema_version: 1, runId, step: "qa",
    pid: endedGroup, processGroupId: endedGroup, exitCode: null, signal: "SIGKILL",
    exitedAt: new Date(Date.now() - 40_000).toISOString(),
  };
  await writeQaJsonAsync(paths.stepExitPath, exit, { durable: false });
  await writeFile(qaRunLiveOutputPath(runRoot, runId), "first line\nbuild output line\n");
  const inspection = new ProjectQaInspection({ get: () => null }, () => runRoot, undefined, {
    ...(options.boundMs !== undefined ? { stepSettleBoundMs: options.boundMs } : {}),
    ...(options.beforeStepStop ? { beforeStepStop: options.beforeStepStop } : {}),
  });
  const run = { id: runId, key: "fixture", startedAt, argv: ["true"] } as any;
  return { root, runRoot, runId, identityToken, supervisor, endedGroup, startedAt, heartbeatAt, state, paths, run, inspection };
}

test("a supervisor that settles nothing after its step's group emptied hands the run over past the bound", { skip: process.platform === "win32" }, async (t) => {
  const f = await inspectionFixture(t, { boundMs: 100 });
  assert.equal((await f.inspection.inspectSupervisor(f.run)).kind, "running", "the first observation only starts the bound");
  let verdict = await f.inspection.inspectSupervisor(f.run);
  for (let attempt = 0; verdict.kind === "running" && attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    verdict = await f.inspection.inspectSupervisor(f.run);
  }
  assert.equal(verdict.kind, "step_ended", JSON.stringify(verdict));
  if (verdict.kind !== "step_ended") return;
  assert.equal(verdict.step, "qa");
  assert.equal(verdict.exit?.signal, "SIGKILL");
  assert.match(verdict.reason, /process group \d+ was empty for \d+ms/);
  assert.throws(() => process.kill(f.supervisor.pid!, 0), /ESRCH/, "the unresponsive supervisor was stopped with proof");
  assert.equal(readQaStepExit(f.paths.stepExitPath, { runId: f.runId, step: "qa" })?.signal, "SIGKILL");
});

test("a stale heartbeat does not discard a recorded step exit: the run settles from it instead of lost", { skip: process.platform === "win32" }, async (t) => {
  // The supervisor froze with a heartbeat older than the watchdog's threshold.
  const f = await inspectionFixture(t, { heartbeatAt: new Date(Date.now() - 240_000).toISOString() });
  assert.equal((await f.inspection.inspectSupervisor(f.run)).kind, "running", "the first stale observation only records a candidate");
  // The watchdog requires the same stale heartbeat across two checks 5s apart.
  await new Promise(resolve => setTimeout(resolve, 5_200));
  let verdict = await f.inspection.inspectSupervisor(f.run);
  for (let attempt = 0; verdict.kind === "running" && attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    verdict = await f.inspection.inspectSupervisor(f.run);
  }
  assert.equal(verdict.kind, "step_ended", `a recorded exit is never settled as lost: ${JSON.stringify(verdict)}`);
  if (verdict.kind !== "step_ended") return;
  assert.equal(verdict.exit?.signal, "SIGKILL");
  assert.match(verdict.reason, /heartbeat was stale for \d+ms/, "the stale stop is still named");
  assert.match(verdict.reason, /SIGKILL/, "and the step's own recorded exit travels with it");
  assert.throws(() => process.kill(f.supervisor.pid!, 0), /ESRCH/, "the stale supervisor was stopped");
});

test("a takeover sweeps the run's remaining token processes only after the supervisor is proven dead", { skip: process.platform === "win32" }, async (t) => {
  const f = await inspectionFixture(t, { boundMs: 0 });
  // A process carrying the run token outside the recorded step group: a step
  // whose record never landed, or an escaped descendant.
  const carrier = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    detached: true, stdio: "ignore",
    env: { ...process.env, ...processStartIdentityEnvironment(f.identityToken) },
  });
  t.after(() => { try { process.kill(-carrier.pid!, "SIGKILL"); } catch { /* already gone */ } });
  const listings: Array<{ found: boolean; supervisorDead: boolean }> = [];
  overrideIdentityListing(identity => {
    if (identity !== f.identityToken) return { state: "unknown" };
    const alive = pidAlive(carrier.pid!);
    listings.push({ found: alive, supervisorDead: !pidAlive(f.supervisor.pid!) });
    return alive
      ? { state: "found", processes: [{ pid: carrier.pid!, processGroupId: carrier.pid!,
        startIdentity: hostRunProcessStartIdentity(carrier.pid!) }] }
      : { state: "absent" };
  });
  const verdict = await f.inspection.inspectSupervisor(f.run);
  assert.equal(verdict.kind, "step_ended", JSON.stringify(verdict));
  assert.throws(() => process.kill(f.supervisor.pid!, 0), /ESRCH/, "the supervisor was stopped");
  assert.throws(() => process.kill(carrier.pid!, 0), /ESRCH/,
    "the takeover stopped the run's leftover token processes before settling");
  assert.ok(listings.length > 0, "the sweep listed the run token");
  assert.equal(listings.every(listing => listing.supervisorDead), true,
    "every token listing happened after the supervisor was proven dead");
});

test("a takeover holds the run instead of settling when the run token cannot be proven gone", { skip: process.platform === "win32" }, async (t) => {
  const f = await inspectionFixture(t, { boundMs: 0 });
  // A listing that cannot be read proves nothing about the run's processes.
  overrideIdentityListing(identity => identity === f.identityToken ? { state: "unknown" } : { state: "unknown" });
  const verdict = await f.inspection.inspectSupervisor(f.run);
  assert.equal(verdict.kind, "running", `an unproven sweep holds the run: ${JSON.stringify(verdict)}`);
});

test("a stale takeover sweeps the pending step whose record never landed", { skip: process.platform === "win32" }, async (t) => {
  // The publication window: the record names only the pending step identity, so
  // no group is recorded and only the run token can find the step's processes.
  const f = await inspectionFixture(t, { heartbeatAt: new Date(Date.now() - 240_000).toISOString(), pendingOnly: true });
  const carrier = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    detached: true, stdio: "ignore",
    env: { ...process.env, ...processStartIdentityEnvironment(f.identityToken) },
  });
  t.after(() => { try { process.kill(-carrier.pid!, "SIGKILL"); } catch { /* already gone */ } });
  overrideIdentityListing(identity => {
    if (identity !== f.identityToken) return { state: "unknown" };
    return pidAlive(carrier.pid!)
      ? { state: "found", processes: [{ pid: carrier.pid!, processGroupId: carrier.pid!,
        startIdentity: hostRunProcessStartIdentity(carrier.pid!) }] }
      : { state: "absent" };
  });
  assert.equal((await f.inspection.inspectSupervisor(f.run)).kind, "running", "the first stale observation only records a candidate");
  await new Promise(resolve => setTimeout(resolve, 5_200));
  let verdict = await f.inspection.inspectSupervisor(f.run);
  for (let attempt = 0; verdict.kind === "running" && attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    verdict = await f.inspection.inspectSupervisor(f.run);
  }
  assert.equal(verdict.kind, "dead", `a pending step is swept before the lost settlement: ${JSON.stringify(verdict)}`);
  assert.throws(() => process.kill(carrier.pid!, 0), /ESRCH/, "the pending step's process was stopped");
  assert.throws(() => process.kill(f.supervisor.pid!, 0), /ESRCH/, "the supervisor was stopped");
});

test("an unreadable recheck holds the run instead of taking it over", { skip: process.platform === "win32" }, async (t) => {
  let refused = 0;
  const f = await inspectionFixture(t, {
    boundMs: 0,
    beforeStepStop: statePath => {
      // The record can be read at the start of the inspection and not when the
      // stop is decided: that answer proves nothing about the running step.
      refused++;
      chmodSync(statePath, 0o644);
    },
  });
  const verdict = await f.inspection.inspectSupervisor(f.run);
  assert.equal(refused, 1, "the seam ran before the stop decision");
  assert.equal(verdict.kind, "running", `an unreadable recheck holds the run: ${JSON.stringify(verdict)}`);
  assert.equal(process.kill(f.supervisor.pid!, 0), true, "the supervisor was not stopped");
});

test("an outdated record never stops the later step the supervisor moved on to", { skip: process.platform === "win32" }, async (t) => {
  // A later step's process group that is genuinely live, so a stop would kill it.
  const later = spawn("/bin/sh", ["-c", "sleep 120"], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-later.pid!, "SIGKILL"); } catch { /* already gone */ } });
  let advanced = 0;
  const f = await inspectionFixture(t, {
    boundMs: 0,
    beforeStepStop: statePath => {
      // The supervisor wrote its next step between this inspection's read and
      // its stop decision: the record on disk now names a different group.
      advanced++;
      const recorded = f.state.activeProcess!;
      writeQaSupervision(statePath, {
        ...f.state,
        heartbeatAt: new Date().toISOString(),
        inFlight: "lint",
        activeProcess: {
          ...recorded, step: "lint", pid: later.pid!, processGroupId: later.pid!,
          startIdentity: hostRunProcessStartIdentity(later.pid!),
          startedAt: new Date().toISOString(),
        },
      });
    },
  });
  const verdict = await f.inspection.inspectSupervisor(f.run);
  assert.equal(advanced, 1, "the seam ran before the stop decision");
  assert.equal(verdict.kind, "running", `an advanced record cancels the verdict: ${JSON.stringify(verdict)}`);
  assert.equal(process.kill(f.supervisor.pid!, 0), true, "the supervisor is still alive");
  assert.equal(processGroupEmpty(later.pid!), false, "the later step's group was not signalled");
  // The next inspection reads the advance itself and starts the later step's bound.
  assert.equal((await f.inspection.inspectSupervisor(f.run)).kind, "running");
});

/** The recovery context the settlement needs, with the store and settle owner recorded instead of run. */
function recoveryFixture(run: any, state: any, runRoot: string) {
  const settled: any[] = [];
  const records: any[] = [];
  const context = {
    store: {
      qaRun: () => ({ ...run, state: "running" }),
      putQaRun: (record: any) => { records.push(record); return record; },
      transaction: (fn: () => void) => fn(),
    },
    qaRepositoryRootPath: () => runRoot,
    checkoutForRun: () => join(runRoot, "missing-checkout"),
    admitCheckout: () => {},
    retainedCheckoutIdentity: async () => {},
    runWorktreeHook: async () => { throw new Error("no teardown in this fixture"); },
    settle: async (_run: any, outcome: any) => { settled.push(outcome); return { ...run, ...outcome }; },
    applyTeardownRetry: () => run,
  } as any;
  // The runner's own members delegate through `this`, exactly as the service does.
  context.reconcileLostRun = (target: any, targetState: any, reason: string, escaped?: any) =>
    projectQaRecovery.reconcileLostRun.call(context, target, targetState, reason, escaped);
  context.settleAbandoned = (target: any, targetState: any, settlement: any, escaped?: any) =>
    projectQaRecovery.settleAbandoned.call(context, target, targetState, settlement, escaped);
  context.appendSettledOutputPointer = (target: any, output: string) =>
    projectQaRecovery.appendSettledOutputPointer.call(context, target, output);
  return { context, settled, records };
}

test("an ended step settles failed from its own exit, with the step, the signal and where output ended", { skip: process.platform === "win32" }, async (t) => {
  const runRoot = await mkdtemp(join(tmpdir(), "qa-step-exit-settle-"));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  const runId = randomUUID();
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  await writeFile(qaRunLiveOutputPath(runRoot, runId), "setup output\nstage line one\nstage line two");
  const run = {
    id: runId, key: "fixture", state: "running", startedAt, argv: ["effigy", "qa"],
    hostRunEpoch: 2, steps: [], failedStep: null, escapedDescendants: [], terminationGraceMs: 30_000,
    repository: { origin: null, path: runRoot }, outputTail: "", logWriteErrors: [],
    findings: undefined, checkoutPath: undefined,
  };
  const state = {
    activeProcess: {
      step: "qa", pid: 4242, processGroupId: 4242, startIdentity: "4242@2026-11-19T19:30:00Z",
      leaderStartIdentity: "a".repeat(32), startedAt: new Date(Date.now() - 90_000).toISOString(),
    },
    inFlight: "qa", steps: [], failedStep: null, logWriteErrors: [], escapedDescendants: [],
    detail: "setup output", escapedDescendantsOld: undefined, cancelReason: null,
  };
  const { context, settled } = recoveryFixture(run, state, runRoot);
  await projectQaRecovery.settleEndedStep.call(context as any, run as any, {
    kind: "step_ended", state: state as any, step: "qa", emptyForMs: 31_000, reason: "qa ended by SIGTERM",
    exit: { schema: "queue.project-qa.step-exit.v1", schema_version: 1, runId, step: "qa",
      pid: 4242, processGroupId: 4242, exitCode: null, signal: "SIGTERM",
      exitedAt: new Date(Date.now() - 30_000).toISOString() },
  });
  assert.equal(settled.length, 1);
  const outcome = settled[0];
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.exitCode, null, "a signalled step has no exit code");
  assert.equal(outcome.interruptedStep, "qa");
  assert.equal(outcome.failedStep, "qa");
  assert.equal(outcome.hostResult.signal, "SIGTERM");
  assert.equal(outcome.hostResult.exitCode, null);
  assert.equal(outcome.hostResult.pgid, 4242);
  assert.match(outcome.detail, /qa ended by SIGTERM/);
  assert.match(outcome.detail, /Live output log: .*\.live\.log at byte \d+/);
  assert.match(outcome.detail, /stage line two/, "the last output lines travel with the settlement");
  assert.match(outcome.detail, /settled this run failed/);
  assert.doesNotMatch(outcome.detail, /lost this QA run/);
  assert.equal(outcome.steps.find((step: any) => step.name === "qa")?.signal, "SIGTERM");
});

test("an ended group with no recorded exit is lost with its step and output pointer, never as nothing", { skip: process.platform === "win32" }, async (t) => {
  const runRoot = await mkdtemp(join(tmpdir(), "qa-step-exit-lost-"));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  const runId = randomUUID();
  await writeFile(qaRunLiveOutputPath(runRoot, runId), "last line before the fault");
  const run = {
    id: runId, key: "fixture", state: "running", startedAt: new Date(Date.now() - 120_000).toISOString(),
    argv: ["effigy", "qa"], steps: [], failedStep: null, escapedDescendants: [], logWriteErrors: [],
    repository: { origin: null, path: runRoot }, outputTail: "",
  };
  const state = {
    activeProcess: { step: "qa", pid: 4243, processGroupId: 4243, startIdentity: "4243@2026-11-19T19:30:00Z",
      leaderStartIdentity: "b".repeat(32), startedAt: new Date(Date.now() - 90_000).toISOString() },
    inFlight: "qa", steps: [], failedStep: null, logWriteErrors: [], escapedDescendants: [],
    detail: "", cancelReason: null,
  };
  const { context, settled, records } = recoveryFixture(run, state, runRoot);
  await projectQaRecovery.settleEndedStep.call(context as any, run as any, {
    kind: "step_ended", state: state as any, step: "qa", exit: null,
    emptyForMs: 45_000, reason: "qa left no process group and recorded no exit",
  });
  assert.equal(settled.length, 1);
  assert.equal(settled[0].state, "lost");
  assert.match(settled[0].detail, /qa left no process group and recorded no exit/);
  assert.match(settled[0].detail, /lost this QA run/);
  assert.ok(records.length >= 1, "the output pointer is added to the settled record");
  assert.ok(records.some(record => record.outputTail.includes("Live output log:")),
    "project.qa.get carries the pointer even when the outcome is genuinely unobservable");
});

test("the output pointer names the live log's byte offset and its last lines", { skip: process.platform === "win32" }, async (t) => {
  const runRoot = await mkdtemp(join(tmpdir(), "qa-step-exit-pointer-"));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  const runId = randomUUID();
  const text = "one\ntwo\nthree\n";
  await writeFile(qaRunLiveOutputPath(runRoot, runId), text);
  const detail = qaOutputPointerDetail(runRoot, runId, "qa");
  assert.match(detail, new RegExp(`at byte ${Buffer.byteLength(text)}`));
  assert.match(detail, /three/);
  assert.match(detail, /No step log for qa was written/);
  await rm(qaRunLiveOutputPath(runRoot, runId));
  assert.match(qaOutputPointerDetail(runRoot, runId, "qa"), /no readable live log/,
    "a missing log is not reported as zero bytes of output");
});
