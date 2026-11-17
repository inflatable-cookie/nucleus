/**
 * Spec 064 P5/P6 (qualification foundation, tranche 3): refusal before effects,
 * and the absent mode's unchanged ordinary behaviour.
 *
 * The first part proves real qualification proof mode refuses before *any* effect
 * when a single external input is missing, naming it, and never synthesizes the
 * clock, provider evidence, waits or closure. The second part proves that with the
 * mode absent an ordinary host run keeps exactly the files, the cap and the
 * result it always had, and writes no qualification evidence at all.
 *
 * Every fixture is a fresh mktemp under this run's TMPDIR with a real supervisor
 * process and real files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostRunResultSchema } from "../shared/contracts";
import { QUALIFICATION_REQUIRED_INPUTS, type QualificationReadiness } from "../shared/schema/review/proof";
import { qualificationReadiness, qualificationReadinessRefusal } from "../core/host-runs/qualification-inputs";
import { establishFirstEffectClock } from "../core/host-runs/qualification-clock";
import { hostRunSupervisorPlanSchema, writeHostRunLaunchEnv } from "../core/host-runs/host-run-wire";
import { hostRunSupervisorPaths, writeVerifiedOwnedFile } from "../core/host-runs/host-run-files";
import { runHostRunSupervisorMain } from "../service/executor/host-run-supervisor";
import { openHostRunRetainedOutput } from "../core/host-runs/host-run-retained-output";
import { qualificationModeRefusal } from "../core/qa/proof-admission";
import type { Task } from "../shared/contracts";

const now = () => Date.now();

function scratch(t: { after(fn: () => void): void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-qualification-mode-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function suppliedReadiness(): QualificationReadiness {
  return qualificationReadiness(QUALIFICATION_REQUIRED_INPUTS.map(required => ({
    id: required.id, state: "present" as const,
    evidence: { owner: "fixture supplier", source: `${required.id}-receipt`, digest: null, observedAt: new Date().toISOString() },
  })));
}

/** Write one plan and its launch environment, the way the endpoint does before it spawns S. */
function writePlan(stateDir: string, runId: string, options: { qualification?: boolean; readiness?: QualificationReadiness; script?: string } = {}) {
  const clock = establishFirstEffectClock(now());
  writeHostRunLaunchEnv(stateDir, runId, { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HOST_RUN_TOKEN: "fixture-token" });
  const argv = [process.execPath, "-e", options.script ?? "process.stdout.write('ordinary output\\n')"];
  const plan = hostRunSupervisorPlanSchema.parse({
    format: "host.run.supervisor.plan", version: 1, stateDir, runId, epoch: 1,
    argv, cwd: stateDir, envKeys: ["HOME", "HOST_RUN_TOKEN", "PATH"],
    runTimeoutMs: 20_000, graceMs: 100, startedAt: new Date().toISOString(),
    ...(options.qualification ? {
      stopMode: "qualification_direct",
      firstEffectClock: clock,
      qualification: {
        subject: {
          taskId: "task-mode", participantRunId: "executor-mode", operationId: null, briefVersion: null, briefDigest: null,
          head: "a".repeat(40), tree: "b".repeat(40), selector: "effigy check --plan", inputs: [],
          authorizedBy: { role: "queue_dispatch" as const, caller: null, note: null },
        },
        execution: null,
        firstEffectClock: clock,
        ...(options.readiness ? { readiness: options.readiness } : {}),
      },
    } : {}),
  });
  writeVerifiedOwnedFile(stateDir, ["runs", runId, "supervisor.plan.json"], JSON.stringify(plan), 0o600);
  return plan;
}

const runDir = (stateDir: string, runId: string) => join(stateDir, "runs", runId);

test("real proof mode refuses before any effect when one external input is missing, and names it", async t => {
  const stateDir = scratch(t);
  // Every input present except the census owner's, which is what a partial
  // supplier would look like.
  const almost = qualificationReadiness(QUALIFICATION_REQUIRED_INPUTS
    .filter(required => required.id !== "final_census")
    .map(required => ({
      id: required.id, state: "present" as const,
      evidence: { owner: "fixture supplier", source: `${required.id}-receipt`, digest: null, observedAt: new Date().toISOString() },
    })));
  const refusal = qualificationReadinessRefusal(almost, "real qualification proof mode");
  assert.ok(refusal);
  assert.match(refusal!, /^qualification proof mode is refused before any effect:/);
  assert.match(refusal!, /1 missing \(final_census\)/);
  assert.doesNotMatch(refusal!, /effigy_admission/);

  // The supervisor refuses that plan before its first write or spawn.
  const runId = "qualification-partial";
  writePlan(stateDir, runId, { qualification: true, readiness: almost });
  const paths = hostRunSupervisorPaths(stateDir, runId);
  await assert.rejects(runHostRunSupervisorMain([stateDir, runId]), /qualification proof mode is refused before any effect/);
  const leaves = readdirSync(runDir(stateDir, runId));
  assert.deepEqual(leaves, ["supervisor.plan.json"], "the refused plan wrote nothing but the plan the endpoint had already written");
  assert.equal(existsSync(paths.statePath), false, "no supervisor state");
  assert.equal(existsSync(paths.qualificationRawPath), false, "no artifact");
  assert.equal(existsSync(paths.stdoutPath), false, "no ordinary stream either");
  assert.equal(existsSync(paths.qualificationObservationPath), false, "no observation");

  // A plan with no readiness set at all is refused the same way, naming the mode's
  // whole required set rather than one opaque reason.
  const bare = "qualification-bare";
  writePlan(stateDir, bare, { qualification: true });
  await assert.rejects(runHostRunSupervisorMain([stateDir, bare]), (error: Error) => {
    assert.match(error.message, /^qualification proof mode is refused before any effect:/);
    for (const required of QUALIFICATION_REQUIRED_INPUTS) assert.match(error.message, new RegExp(required.id));
    return true;
  });
  assert.deepEqual(readdirSync(runDir(stateDir, bare)), ["supervisor.plan.json"]);

  // A qualification plan without its clock refuses as well: the cumulative target
  // is never synthesized.
  const clockless = "qualification-clockless";
  const plan = writePlan(stateDir, clockless, { qualification: true, readiness: suppliedReadiness() });
  const { firstEffectClock: _clock, ...withoutClock } = plan;
  writeVerifiedOwnedFile(stateDir, ["runs", clockless, "supervisor.plan.json"], JSON.stringify(withoutClock), 0o600);
  // The plan owner refuses it first: a qualification plan must carry the clock.
  await assert.rejects(runHostRunSupervisorMain([stateDir, clockless]), (error: Error) => {
    assert.match(error.message, /first-effect clock/);
    return true;
  });
  assert.deepEqual(readdirSync(runDir(stateDir, clockless)), ["supervisor.plan.json"]);
});

test("with the mode absent, the dispatch entry has nothing to refuse", () => {
  const ordinary = { id: "t", proofExecution: { selector: "effigy check --plan", inputs: [] } } as unknown as Task;
  assert.equal(qualificationModeRefusal(ordinary), null, "an ordinary proof declaration carries no qualification mode");
  assert.equal(qualificationModeRefusal({ id: "t" } as unknown as Task), null, "a task with no proof declaration is untouched");
  assert.equal(qualificationModeRefusal({ id: "t", proofExecution: { selector: "s", inputs: [], qualification: false } } as unknown as Task), null);
  const declared = { id: "t", proofExecution: { selector: "effigy check --plan", inputs: [], qualification: true } } as unknown as Task;
  const refusal = qualificationModeRefusal(declared);
  assert.ok(refusal);
  assert.match(refusal!, /^qualification proof mode is refused before any effect:/);
});

test("with the mode absent, an ordinary host run keeps its two streams, its cap and its result", async t => {
  const stateDir = scratch(t);
  const runId = "ordinary-run";
  writePlan(stateDir, runId, { script: "process.stdout.write('ordinary stdout\\n'); process.stderr.write('ordinary stderr\\n')" });
  await runHostRunSupervisorMain([stateDir, runId]);

  const paths = hostRunSupervisorPaths(stateDir, runId);
  assert.equal(existsSync(paths.stdoutPath), true, "the ordinary capture keeps stdout");
  assert.equal(existsSync(paths.stderrPath), true, "the ordinary capture keeps stderr");
  assert.equal(readFileSync(paths.stdoutPath, "utf8"), "ordinary stdout\n");
  assert.equal(readFileSync(paths.stderrPath, "utf8"), "ordinary stderr\n");
  // No qualification evidence of any kind was created.
  assert.equal(existsSync(paths.qualificationRawPath), false);
  assert.equal(existsSync(paths.qualificationObservationPath), false);
  assert.equal(existsSync(paths.qualificationAckPath), false);
  assert.equal(existsSync(paths.qualificationSettlementPath), false);
  const result = hostRunResultSchema.parse(JSON.parse(readFileSync(paths.resultPath, "utf8")));
  assert.equal(result.exitCode, 0);
  assert.equal(result.runId, runId);
  // The plan itself carries no qualification half.
  const plan = hostRunSupervisorPlanSchema.parse(JSON.parse(readFileSync(paths.planPath, "utf8")));
  assert.equal("qualification" in plan, false);
  assert.equal("firstEffectClock" in plan, false);
});

test("the ordinary capture still opens exactly its two files and never the qualification artifact", async t => {
  const stateDir = scratch(t);
  const runId = "ordinary-capture";
  const output = openHostRunRetainedOutput(stateDir, runId, 8 * 1024 * 1024, undefined);
  assert.equal(output.mode, "streams");
  output.write("stdout", Buffer.from("captured\n"));
  output.markEof("stdout");
  output.markDrained("stdout");
  const closed = output.close();
  assert.equal(closed.qualification, null, "an ordinary capture proves no qualification artifact");
  assert.deepEqual(closed.faults, []);
  const leaves = readdirSync(runDir(stateDir, runId)).sort();
  assert.deepEqual(leaves, ["stderr", "stdout"]);
  assert.equal(existsSync(join(runDir(stateDir, runId), "qualification.raw")), false);
});

test("an ordinary plan with no launch environment is still refused for its own reason", async t => {
  const stateDir = scratch(t);
  mkdirSync(join(stateDir, "runs", "no-env"), { recursive: true, mode: 0o700 });
  await assert.rejects(runHostRunSupervisorMain([stateDir, "no-env"]), /plan is missing|launch env is missing|failed the owned-subtree checks/i);
});
