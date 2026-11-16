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
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runSchema, type Run } from "../shared/schema/runs";
import { submissionSchema } from "../shared/contracts";
import { qualificationEnvironmentDigest, qualificationSubjectDigest } from "../shared/schema/review/proof";
import { Store } from "../core/store/store";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { qualificationSubjectResolver, QUALIFICATION_FOUNDATION_INCOMPLETE } from "../core/host-runs/qualification-subject";
import {
  HostRunEndpoint,
  hostRunRunDir,
  hostRunSupervisorPlanSchema,
  readHostRunTokenKeys,
  signRunToken,
  writeVerifiedOwnedFile,
} from "../service/callbacks/host-run-endpoint";
import { runHostRunSupervisorMain } from "../service/executor/host-run-supervisor";
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
function fixture(t: { after(fn: () => void | Promise<void>): void }, overrides: { subjectHeadDrift?: boolean } = {}) {
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
      returnPhase: "awaiting_review", authorizedBy, qualification: { subject, execution: null },
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
    executor: run, token, subject, subjectDigest: qualificationSubjectDigest(subject),
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
  const expectedEnvironment = qualificationEnvironmentDigest({
    ...body.env, PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
  });
  assert.equal(execution.environmentDigest, expectedEnvironment, "the environment-value digest is recorded, not only the names");
  assert.equal(execution.environmentDigest, qualificationEnvironmentDigest({
    QUALIFICATION_FIXTURE: "value", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
  }));
  assert.deepEqual(execution.environmentKeys, ["HOME", "PATH", "QUALIFICATION_FIXTURE"].sort());
  assert.equal(execution.hostEpoch, f.scheduler.authority().epoch);

  // The amendment's staged refusal: the binding resolved, and the mode is refused
  // before any write or spawn.
  assert.equal(outcome.code, "not_permitted");
  assert.ok(outcome.refusal.startsWith(QUALIFICATION_FOUNDATION_INCOMPLETE), outcome.refusal);
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
