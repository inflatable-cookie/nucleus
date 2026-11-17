/**
 * Spec 064 P1 (qualification foundation, tranche 1): the authenticated proof
 * subject and submit, and Spec 064 P2's retained direct-command observation.
 *
 * Every fixture is a fresh mktemp under the run's scratch: a real git checkout
 * with a local origin, a real SQLite store, a real executor run row with its own
 * callback credential, and a real host-run endpoint. The supervisor spawn is
 * replaced so this file can prove that a refused qualification submit never
 * spawns anything, and the process cases use real child processes.
 *
 * Brief amendment (2026-11-16): until Spec 064 P4–P7 land their named
 * missing-input refusal, real qualification proof mode stays inaccessible. The
 * authenticated, matched submit below therefore resolves its full binding —
 * including the environment-value digest — and then refuses with
 * `qualification foundation incomplete` before any write or spawn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runSchema, type Run } from "../shared/schema/runs";
import { submissionSchema } from "../shared/contracts";
import {
  qualificationEnvironmentDigest, qualificationLaunchRefusal, qualificationProcessIdentity,
  qualificationSubjectDigest,
} from "../core/host-runs/qualification-binding";
import { PROCESS_START_IDENTITY_ENV } from "../core/machine/process-identity-search";
import { Store } from "../core/store/store";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { qualificationSubjectResolver } from "../core/host-runs/qualification-subject";
import {
  HostRunEndpoint,
  QUALIFICATION_FOUNDATION_INCOMPLETE,
  hostRunLaunchEnvironment,
  hostRunRunDir,
  hostRunSupervisorPaths,
  hostRunSupervisorPlanSchema,
  readHostRunCancelRequest,
  readHostRunTokenKeys,
  removeVerifiedOwnedFile,
  signRunToken,
  writeVerifiedOwnedFile,
} from "../service/callbacks/host-run-endpoint";
import { proofExecutionRecord } from "../core/qa/proof-records";
import { proofExecutionRequestSchema } from "../shared/schema/review/proof";
import { runHostRunSupervisorMain, supervisorSpawnIdentity } from "../service/executor/host-run-supervisor";
import { executeHookProgram } from "../core/machine/process-exec";
import { hostRunProcessStartIdentity } from "../core/machine/start-identity";

const selector = "effigy test unit -- test/proof-fixture.test.ts";
const inputs = [`sha256:${"e".repeat(64)}`];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms: number) => new Promise<void>(resolvePromise => setTimeout(resolvePromise, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

const capacity = () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] });

/**
 * One published subject: a bare origin, a repository and its task checkout, all
 * at the same head on the task branch, plus the store, task, executor run and
 * callback credential a qualification submit resolves through.
 */
function fixture(t: { after(fn: () => void | Promise<void>): void }, overrides: { subjectHeadDrift?: boolean; optIn?: boolean } = {}) {
  const optIn = overrides.optIn !== false;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-qualification-")));
  const origin = join(root, "origin.git"), repo = join(root, "repo"), checkout = join(root, "checkout");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Queue Fixture"); git(repo, "config", "user.email", "queue@example.test");
  writeFileSync(join(repo, "README.md"), "qualification subject\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "Qualification subject");
  const head = git(repo, "rev-parse", "HEAD");
  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  const branch = "ns-qualification-subject";
  git(repo, "branch", branch, head);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "origin", branch);
  git(repo, "worktree", "add", checkout, branch);
  assert.equal(git(checkout, "branch", "--show-current"), branch);

  const store = new Store(join(root, "queue.sqlite"));
  store.setMeta("paused", false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: "Qualification subject", repoPath: repo, baseBranch: "main",
    planningCommit: head, handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "# Qualification subject\n", head);
  store.update(inserted.id, { directory: checkout, branch, hostId: "host" });
  const task = store.task(inserted.id);

  // The proof declaration the brief would carry: qualification mode is opt-in.
  if (optIn) store.update(task.id, { proofExecution: { selector, inputs, role: "author" as const, qualification: true } });
  const runId = randomUUID();
  const token = `credential-${randomUUID()}`;
  const authorizedBy = { role: "queue_dispatch" as const, caller: null, note: null };
  const subject = {
    taskId: task.id, participantRunId: runId, operationId: null, briefVersion: null, briefDigest: null,
    // A drifted recorded subject must be refused, so one case records a different head.
    head: overrides.subjectHeadDrift ? "b".repeat(40) : head,
    tree, selector, inputs, authorizedBy,
  };
  const run: Run = runSchema.parse({
    id: runId, taskId: task.id, role: "executor", generation: 1, head, base: head,
    agentId: "executor-agent", workspaceId: "checkout-workspace", hostId: "host", profile: null,
    status: "running", createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null,
    completion: null, released: false,
    proofExecution: {
      selector, inputs, prNumber: null, tree, operationId: null, briefVersion: null, briefDigest: null,
      returnPhase: "awaiting_review", authorizedBy,
      // An ordinary proof execution records no qualification binding at all.
      ...(optIn ? { qualification: { subject, execution: null } } : {}),
    },
  });
  store.db.prepare("INSERT INTO runs VALUES(?,?,?)").run(run.id, run.taskId, JSON.stringify(run));
  store.setCredential(run.id, token);

  const stateDir = join(root, "hr");
  const scheduler = new HostRunScheduler(store, { capacity });
  let spawns = 0;
  const endpoint = new HostRunEndpoint(scheduler, {
    stateDir, env: process.env, qualification: qualificationSubjectResolver({ store }),
    supervisorSpawn: () => { spawns += 1; },
  });
  t.after(async () => {
    await endpoint.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, origin, repo, checkout, head, tree, branch, stateDir, store, scheduler, endpoint, task,
    executor: run, token, subject, subjectDigest: qualificationSubjectDigest(subject), optIn,
    spawnCount: () => spawns,
  };
}

const submitBody = (runId: string, overrides: Record<string, unknown> = {}) => ({
  clientRequestId: randomUUID(),
  caller: runId,
  repository: "example/qualification",
  cwd: overrides.cwd as string,
  selector,
  argv: [process.execPath, "-e", "process.exit(0)"],
  class: "heavy" as const,
  classSource: "manifest" as const,
  priority: "interactive" as const,
  budgetFallback: { cpu: 1, memoryBytes: 100_000_000 },
  capacityDeadlineMs: 1_800_000,
  runTimeoutMs: 3_600_000,
  env: { QUALIFICATION_FIXTURE: "value" },
});

test("a qualification submit refuses an unauthenticated caller, a host token and a mismatched subject before any write", async t => {
  const f = fixture(t);
  await f.endpoint.start();

  const qualified = async (credential: { runId: string; token: string }, submission: Record<string, unknown>) =>
    f.endpoint.submitQualification({ credential: { taskId: f.task.id, ...credential }, submission });

  // 1. A token that is not the executor run's credential authenticates nothing.
  const unknown = await qualified({ runId: f.executor.id, token: "not-a-run-credential" }, submitBody(f.executor.id, { cwd: f.checkout }));
  assert.equal(unknown.binding, null, "an unauthenticated submit resolves no binding");
  assert.equal(unknown.code, "not_permitted");
  assert.match(unknown.refusal, /did not authenticate/);

  // 2. A genuine host-run token signed by this very endpoint grants no proof authority.
  const keys = readHostRunTokenKeys(f.stateDir);
  assert.ok(keys, "the endpoint published its host-run token keys");
  const hostToken = signRunToken({
    runId: f.executor.id, epoch: f.scheduler.authority().epoch, class: "heavy",
    root: f.checkout, exp: Date.now() + 60_000,
  }, keys.current.keyB64);
  const viaHostToken = await qualified({ runId: f.executor.id, token: hostToken }, submitBody(f.executor.id, { cwd: f.checkout }));
  assert.equal(viaHostToken.binding, null, "a host token resolves no qualification binding");
  assert.match(viaHostToken.refusal, /did not authenticate/);

  // 3. A client-supplied caller is not an identity.
  const caller = await qualified({ runId: f.executor.id, token: f.token },
    { ...submitBody(f.executor.id, { cwd: f.checkout }), caller: "somebody-else" });
  assert.equal(caller.binding, null);
  assert.match(caller.refusal, /client-supplied caller grants no proof authority/);

  // 4. A submitted command that is not the bound subject's command is refused.
  const otherSelector = await qualified({ runId: f.executor.id, token: f.token },
    { ...submitBody(f.executor.id, { cwd: f.checkout }), selector: "effigy check" });
  assert.equal(otherSelector.binding, null);
  assert.match(otherSelector.refusal, /is not the bound subject's selector/);

  // 5. A cwd outside the subject's checkout is refused.
  const foreignRoot = await qualified({ runId: f.executor.id, token: f.token }, submitBody(f.executor.id, { cwd: f.repo }));
  assert.equal(foreignRoot.binding, null);
  assert.match(foreignRoot.refusal, /is not the subject's checkout/);

  // 6. A subject that no longer matches the run's recorded intent is refused.
  const drifted = fixture(t, { subjectHeadDrift: true });
  await drifted.endpoint.start();
  const mismatch = await drifted.endpoint.submitQualification({
    credential: { taskId: drifted.task.id, runId: drifted.executor.id, token: drifted.token },
    submission: submitBody(drifted.executor.id, { cwd: drifted.checkout }),
  });
  assert.equal(mismatch.binding, null);
  assert.match(mismatch.refusal, /is not the subject this run recorded/);

  // Nothing above wrote a submission, a run row, a plan or a spawned supervisor.
  assert.equal(f.scheduler.get(f.executor.id), null, "no run row was created for the executor's qualification ids");
  assert.equal(hostRunDirExists(f.stateDir, f.executor.id), false, "no run directory was written");
  assert.equal(drifted.scheduler.get(drifted.executor.id), null);
  assert.equal(hostRunDirExists(drifted.stateDir, drifted.executor.id), false);
  assert.equal(f.spawnCount(), 0, "no supervisor was spawned");
  assert.equal(drifted.spawnCount(), 0, "no supervisor was spawned");
});

test("an authenticated, matched submit resolves the full binding including the environment-value digest, then refuses the incomplete foundation", async t => {
  const f = fixture(t);
  await f.endpoint.start();
  const body = submitBody(f.executor.id, { cwd: f.checkout });
  const outcome = await f.endpoint.submitQualification({
    credential: { taskId: f.task.id, runId: f.executor.id, token: f.token }, submission: body,
  });

  assert.ok(outcome.binding, "the authenticated, matched subject resolves the full binding");
  const binding = outcome.binding;
  assert.equal(binding.subject.taskId, f.task.id);
  assert.equal(binding.subject.participantRunId, f.executor.id);
  assert.equal(binding.subject.head, f.head);
  assert.equal(binding.subject.tree, f.tree);
  assert.deepEqual(binding.subject.inputs, inputs, "the pinned inputs keep their declared order");
  assert.equal(binding.subject.authorizedBy.role, "queue_dispatch");
  assert.equal(qualificationSubjectDigest(binding.subject), f.subjectDigest, "the resolved subject is the run's recorded subject");

  const execution = binding.execution;
  assert.ok(execution, "the command identity is bound at the submit seam");
  assert.deepEqual(execution.argv, body.argv, "the literal argv rides with the binding");
  assert.equal(execution.cwd, f.checkout);
  assert.equal(execution.executable, realpathSync(process.execPath));
  assert.match(execution.executableDigest, /^sha256:[a-f0-9]{64}$/, "the executable's content digest is bound");
  // The digest covers every effective value the command receives. The one
  // per-launch secret is inside it; only its expiry is recorded, so the test
  // re-mints the same value from that expiry and the endpoint's own keys.
  const keys = readHostRunTokenKeys(f.stateDir);
  assert.ok(keys, "the endpoint published its host-run token keys");
  const launchToken = signRunToken({
    runId: execution.hostRunId, epoch: execution.hostEpoch, class: body.class,
    root: f.checkout, exp: execution.tokenExpiresAt,
  }, keys.current.keyB64);
  const effective = {
    ...hostRunLaunchEnvironment(body.env, { runId: execution.hostRunId, token: launchToken, env: process.env }),
    [PROCESS_START_IDENTITY_ENV]: qualificationProcessIdentity(binding.subject),
  };
  assert.deepEqual(execution.environmentKeys, Object.keys(effective).sort());
  assert.deepEqual(execution.environmentKeys,
    ["HOME", "HOST_RUN_ID", "HOST_RUN_TOKEN", "PATH", "QUALIFICATION_FIXTURE", PROCESS_START_IDENTITY_ENV].sort());
  assert.equal(effective[PROCESS_START_IDENTITY_ENV], qualificationProcessIdentity(f.subject),
    "the spawn marker is derived from the immutable subject, not chosen at spawn");
  assert.equal(execution.environmentDigest, qualificationEnvironmentDigest(effective),
    "the environment-value digest covers the full effective environment, including the per-launch secret and the start marker");
  // The launch owner re-checks the same environment, marker included, and refuses
  // any drift before the plan or the spawn exists.
  assert.equal(qualificationLaunchRefusal(
    hostRunLaunchEnvironment(body.env, { runId: execution.hostRunId, token: launchToken, env: process.env }), binding),
  null, "the launch accepts the resolved environment with the subject-derived marker");
  assert.match(String(qualificationLaunchRefusal(
    { ...hostRunLaunchEnvironment(body.env, { runId: execution.hostRunId, token: launchToken, env: process.env }), PATH: "/elsewhere" }, binding)),
  /values no longer match/);
  // The launch's own environment alone is not the bound execution: only the
  // subject-derived marker the spawn inherits completes it, so the wiring from
  // binding to spawn is what makes the digest true.
  assert.notEqual(
    qualificationEnvironmentDigest(hostRunLaunchEnvironment(body.env, { runId: execution.hostRunId, token: launchToken, env: process.env })),
    execution.environmentDigest,
    "the launch environment without the subject-derived marker is not the bound execution");
  // The spawn identity is the bound marker, not fresh entropy.
  const planIdentity = supervisorSpawnIdentity({ qualification: binding });
  assert.equal(planIdentity, qualificationProcessIdentity(binding.subject));
  assert.notEqual(supervisorSpawnIdentity({}), planIdentity, "an ordinary plan keeps a fresh random identity");
  assert.ok(execution.tokenExpiresAt > Date.now(), "the secret's expiry is recorded, never its value");
  assert.equal(execution.hostEpoch, f.scheduler.authority().epoch);

  // A different effective value is a different binding.
  const changed = await f.endpoint.submitQualification({
    credential: { taskId: f.task.id, runId: f.executor.id, token: f.token },
    submission: { ...body, env: { ...body.env, QUALIFICATION_FIXTURE: "another-value" } },
  });
  assert.ok(changed.binding?.execution);
  assert.equal(qualificationProcessIdentity(changed.binding.subject), qualificationProcessIdentity(binding.subject),
    "the subject-derived spawn marker is stable across resolutions");
  assert.notEqual(changed.binding.execution.environmentDigest, execution.environmentDigest);

  // The amendment's staged refusal: the binding resolved, and the mode is refused
  // before any write or spawn.
  assert.equal(outcome.code, "not_permitted");
  assert.ok(outcome.refusal.startsWith(QUALIFICATION_FOUNDATION_INCOMPLETE), outcome.refusal);
  const keyBefore = readFileSync(join(f.stateDir, "token.key"), "utf8");
  const again = await f.endpoint.submitQualification({
    credential: { taskId: f.task.id, runId: f.executor.id, token: f.token }, submission: body,
  });
  assert.ok(again.binding?.execution);
  assert.equal(readFileSync(join(f.stateDir, "token.key"), "utf8"), keyBefore, "a qualification resolve never rewrites the token key");
  assert.equal(f.scheduler.get(execution.hostRunId), null, "no run row was submitted");
  assert.equal(hostRunDirExists(f.stateDir, execution.hostRunId), false, "no submission or plan was written");
  assert.equal(f.spawnCount(), 0, "no supervisor was spawned");
});

test("a qualification plan is refused by the supervisor before its first effect", async t => {
  const f = fixture(t);
  await f.endpoint.start();
  const body = submitBody(f.executor.id, { cwd: f.checkout });
  const resolved = await f.endpoint.submitQualification({
    credential: { taskId: f.task.id, runId: f.executor.id, token: f.token }, submission: body,
  });
  assert.ok(resolved.binding);

  // A plan carrying the resolved binding and the qualification stop mode: the
  // exact shape tranche 3 would write.
  const runId = randomUUID();
  const plan = hostRunSupervisorPlanSchema.parse({
    format: "host.run.supervisor.plan", version: 1, stateDir: f.stateDir, runId, epoch: f.scheduler.authority().epoch,
    argv: [process.execPath, "-e", "process.exit(0)"], cwd: f.repo, envKeys: [],
    runTimeoutMs: 10_000, graceMs: 10, startedAt: new Date().toISOString(),
    stopMode: "qualification_direct", qualification: resolved.binding,
  });
  writeVerifiedOwnedFile(f.stateDir, ["runs", runId, "supervisor.plan.json"], JSON.stringify(plan), 0o600);

  await assert.rejects(runHostRunSupervisorMain([f.stateDir, runId]), /qualification foundation incomplete/);
  // No effect: the supervisor's own state record (its first write) is absent.
  assert.equal(hostRunDirExists(f.stateDir, runId, "supervisor.state.json"), false, "the refused plan wrote no supervisor state");
  assert.equal(f.scheduler.get(runId), null, "no run row was submitted for the refused plan");
});

test("the parent records its own direct-child exit observation, with both start identities, before settlement", async t => {
  const f = fixture(t);
  const observations: Array<{ childPid: number; observedAt: string }> = [];
  const outcome = await executeHookProgram({
    root: f.checkout, executable: process.execPath,
    argv: ["-e", "setTimeout(() => process.exit(3), 10)"],
    stdin: Buffer.alloc(0), timeoutMs: 20_000, maxOutputBytes: 10_000,
    env: { PATH: process.env.PATH ?? "" }, directChildWait: true,
    onChildExit: wait => observations.push({ childPid: wait.childPid, observedAt: wait.observedAt }),
  });
  const wait = outcome.directChildWait;
  assert.ok(wait, "the direct-command exit observation is recorded on the outcome");
  assert.equal(wait.source, "child-exit-event", "the observation is the parent's own child exit event");
  assert.equal(wait.state, "observed");
  assert.equal(wait.code, 3, "the child's own exit code is recorded");
  assert.equal(wait.signal, null);
  assert.equal(wait.parentPid, process.pid);
  assert.equal(wait.parentStartIdentity, hostRunProcessStartIdentity(process.pid), "the parent's start identity travels with it");
  assert.equal(wait.childPid, outcome.pid);
  assert.equal(wait.childStartIdentity, outcome.startIdentity, "the child's start identity travels with it");
  assert.equal(observations.length, 1, "the observation is made once, as the child exits");
  assert.equal(observations[0]!.childPid, outcome.pid);
  assert.ok(observations[0]!.observedAt <= new Date().toISOString(), "the observation tick was recorded before this assertion");
});

/** Whether one run's directory (or one named file inside it) exists on disk. */
function hostRunDirExists(stateDir: string, runId: string, file?: string): boolean {
  const directory = hostRunRunDir(stateDir, runId);
  return file ? existsSync(join(directory, file)) : existsSync(directory);
}

test("qualification metadata is opt-in: an ordinary proof execution records none and cannot be submitted as one", async t => {
  // The declaration's own opt-in: absent means the existing proof shape, unchanged.
  assert.equal('qualification' in proofExecutionRequestSchema.parse({ selector }), false);
  assert.equal(proofExecutionRequestSchema.parse({ selector, qualification: true }).qualification, true);

  const f = fixture(t, { optIn: false });
  await f.endpoint.start();
  assert.equal(f.executor.proofExecution?.qualification, undefined, "the ordinary executor run records no qualification binding");

  // An ordinary proof execution records the same proof receipt it always did.
  const ordinary = proofExecutionRecord(f.executor, f.task, { role: "queue_dispatch", caller: null, note: null }, null);
  assert.equal('qualification' in ordinary, false, "an ordinary proof receipt carries no qualification metadata");

  // And it can never be reinterpreted into a qualification submit.
  const refused = await f.endpoint.submitQualification({
    credential: { taskId: f.task.id, runId: f.executor.id, token: f.token },
    submission: submitBody(f.executor.id, { cwd: f.checkout }),
  });
  assert.equal(refused.binding, null);
  assert.match(refused.refusal, /did not opt into qualification mode/);
  assert.equal(f.spawnCount(), 0);
});

test("an opted-in proof receipt records the qualification reference and its subject digest", async t => {
  const f = fixture(t);
  const record = proofExecutionRecord(f.executor, f.task, { role: "queue_dispatch", caller: null, note: null }, null);
  assert.ok(record.qualification, "an opted-in receipt names its qualification");
  assert.equal(record.qualification.reference, `${f.task.id}/${f.executor.id}`);
  assert.equal(record.qualification.subjectDigest, f.subjectDigest);
  assert.equal(record.qualification.executionDigest, null, "no command is bound before a submit");
});

test("a qualification attempt's cancel persists its mode and never takes the group fallback", async t => {
  const f = fixture(t);
  await f.endpoint.start();
  const wire = f.endpoint as unknown as {
    onSubmit(id: string, body: unknown): { ok: boolean; body?: { runId: string } };
    onCancel(id: string, body: unknown): { ok: boolean; body?: { state: string }; error?: { code: string } };
  };

  // A resolved binding is what a qualification plan would carry.
  const resolved = await f.endpoint.submitQualification({
    credential: { taskId: f.task.id, runId: f.executor.id, token: f.token },
    submission: submitBody(f.executor.id, { cwd: f.checkout }),
  });
  assert.ok(resolved.binding);

  // Two ordinary host runs, one of which is turned into a qualification attempt by
  // its own plan; both lose their submission record, which is the shape that used
  // to fall through to a group signal.
  const ordinary = wire.onSubmit("q-ordinary", { ...submitBody("effigy@worker-stop", { cwd: f.repo }) });
  const qualifiedRun = wire.onSubmit("q-qualified", { ...submitBody("effigy@worker-stop-2", { cwd: f.repo }) });
  assert.equal(ordinary.ok, true); assert.equal(qualifiedRun.ok, true);
  const runningId = qualifiedRun.body!.runId;
  const ordinaryId = ordinary.body!.runId;

  const planPath = hostRunSupervisorPaths(f.stateDir, runningId).planPath;
  const plan = hostRunSupervisorPlanSchema.parse(JSON.parse(readFileSync(planPath, "utf8")));
  writeVerifiedOwnedFile(f.stateDir, ["runs", runningId, "supervisor.plan.json"], JSON.stringify(hostRunSupervisorPlanSchema.parse({
    ...plan, stopMode: "qualification_direct", qualification: resolved.binding,
  })), 0o600);
  for (const runId of [runningId, ordinaryId]) removeVerifiedOwnedFile(realpathSync(f.stateDir), ["runs", runId, "submission.json"]);

  // The qualification stop is written with its mode and the run is reported as
  // stopped-by-request; no process group is signalled.
  const cancelled = wire.onCancel("c-qualified", { runId: runningId, reason: "qualification fixture stop" });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(cancelled.body?.state, "running");
  const request = readHostRunCancelRequest(f.stateDir, runningId);
  assert.equal(request.state, "requested");
  assert.equal(request.state === "requested" ? request.reason : "", "qualification fixture stop");
  assert.equal(request.state === "requested" ? request.stopMode : undefined, "qualification_direct",
    "the durable cancel request persists the qualification stop mode");

  // The same shape without the mode keeps today's refusal: the group fallback is
  // never reached by a qualification attempt.
  const ordinaryCancel = wire.onCancel("c-ordinary", { runId: ordinaryId, reason: "ordinary fixture stop" });
  assert.equal(ordinaryCancel.ok, false);
  assert.equal(ordinaryCancel.error?.code, "not_permitted");
  assert.equal(readHostRunCancelRequest(f.stateDir, ordinaryId).state, "absent");
});

test("a refused qualification submit performs no token-key work before authentication", async t => {
  const f = fixture(t);
  await f.endpoint.start();
  // A second endpoint shares the scheduler's authority but has never synchronized
  // its own token keys. With the fix, no unauthenticated submit may write them.
  const freshState = join(f.root, "hr-fresh");
  // A rolled endpoint whose state root exists but whose token keys are gone.
  mkdirSync(freshState, { recursive: true, mode: 0o700 });
  const fresh = new HostRunEndpoint(f.scheduler, {
    stateDir: freshState, env: process.env, qualification: qualificationSubjectResolver({ store: f.store }),
    supervisorSpawn: () => { throw new Error("a refused qualification submit must never spawn"); },
  });
  t.after(async () => { await fresh.stop(); });
  const keyPath = join(freshState, "token.key");
  assert.equal(existsSync(keyPath), false, "the fresh endpoint holds no token keys yet");

  const refused = await fresh.submitQualification({
    credential: { taskId: f.task.id, runId: f.executor.id, token: "not-a-run-credential" },
    submission: submitBody(f.executor.id, { cwd: f.checkout }),
  });
  assert.equal(refused.binding, null);
  assert.match(refused.refusal, /did not authenticate/);
  assert.equal(existsSync(keyPath), false, "an unauthenticated submit wrote no token key");

  // The rule still holds for every other refusal that precedes the mint.
  const mismatched = await fresh.submitQualification({
    credential: { taskId: f.task.id, runId: f.executor.id, token: f.token },
    submission: { ...submitBody(f.executor.id, { cwd: f.checkout }), selector: "effigy check" },
  });
  assert.equal(mismatched.binding, null);
  assert.equal(existsSync(keyPath), false, "a mismatched subject wrote no token key");

  // An authenticated, matched submit still writes nothing: without a key it holds,
  // the endpoint refuses the execution identity instead of creating one. The mode
  // refusal must have no effect at all.
  const resolved = await fresh.submitQualification({
    credential: { taskId: f.task.id, runId: f.executor.id, token: f.token },
    submission: submitBody(f.executor.id, { cwd: f.checkout }),
  });
  assert.equal(resolved.binding, null);
  assert.match(resolved.refusal, /^qualification foundation incomplete:/);
  assert.match(resolved.refusal, /no host-run token key/);
  assert.equal(existsSync(keyPath), false, "an authenticated foundation refusal wrote no token key");
  assert.equal(f.spawnCount(), 0);
});

test("an unreadable plan keeps the cancel's closure unknown instead of becoming group mode", async t => {
  const f = fixture(t);
  await f.endpoint.start();
  const wire = f.endpoint as unknown as {
    onSubmit(id: string, body: unknown): { ok: boolean; body?: { runId: string } };
    onCancel(id: string, body: unknown): { ok: boolean; error?: { code: string } };
  };
  const first = wire.onSubmit("q-unknown-mode", { ...submitBody("effigy@worker-unknown", { cwd: f.repo }) });
  assert.equal(first.ok, true);
  const runId = first.body!.runId;
  removeVerifiedOwnedFile(realpathSync(f.stateDir), ["runs", runId, "submission.json"]);
  // The plan exists but cannot be read: the stop mode is unknown, never group.
  writeVerifiedOwnedFile(f.stateDir, ["runs", runId, "supervisor.plan.json"], "{\"format\":\"host.run.supervisor.plan\"} truncated", 0o600);

  const cancelled = wire.onCancel("c-unknown-mode", { runId, reason: "unknown-mode fixture stop" });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  const request = readHostRunCancelRequest(f.stateDir, runId);
  assert.equal(request.state, "requested");
  assert.equal(request.state === "requested" ? request.stopMode : "unexpected", undefined,
    "an unknown stop mode is recorded without claiming one, and no group signal was sent");

  // No plan at all keeps today's behaviour: the endpoint refuses to claim a stop.
  const second = wire.onSubmit("q-no-plan", { ...submitBody("effigy@worker-no-plan", { cwd: f.repo }) });
  const secondId = second.body!.runId;
  removeVerifiedOwnedFile(realpathSync(f.stateDir), ["runs", secondId, "submission.json"]);
  removeVerifiedOwnedFile(realpathSync(f.stateDir), ["runs", secondId, "supervisor.plan.json"]);
  const refused = wire.onCancel("c-no-plan", { runId: secondId, reason: "no-plan fixture stop" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, "not_permitted");
  assert.equal(readHostRunCancelRequest(f.stateDir, secondId).state, "absent");
});
