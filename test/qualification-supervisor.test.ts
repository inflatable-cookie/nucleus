/**
 * Spec 064 P4 (amended) / P5 / P6 (qualification foundation, tranche 3): the
 * supervisor's own qualification wiring.
 *
 * A real supervisor process runs a real command in qualification mode: one
 * combined `qualification.raw` with no cap and no per-stream file, real EOF and
 * DRAIN per stream, `not_applicable: unbuffered` as its flush fact, a charged
 * ledger entry, its own direct-child wait, and one observation it publishes before
 * it exits. The endpoint side of the handshake is played by this test: it reads the
 * observation, acknowledges that exact digest and observes S exit afterwards.
 *
 * Everything is a fresh mktemp under this run's TMPDIR.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUALIFICATION_REQUIRED_INPUTS, type QualificationReadiness } from "../shared/schema/review/proof";
import { qualificationReadiness } from "../core/host-runs/qualification-inputs";
import { establishFirstEffectClock } from "../core/host-runs/qualification-clock";
import { qualificationSubjectDigest } from "../core/host-runs/qualification-binding";
import { hostRunSupervisorPlanSchema, writeHostRunLaunchEnv } from "../core/host-runs/host-run-wire";
import { hostRunSupervisorPaths, writeVerifiedOwnedFile } from "../core/host-runs/host-run-files";
import { runHostRunSupervisorMain } from "../service/executor/host-run-supervisor";
import { readQualificationObservation } from "../core/host-runs/qualification-observation";
import { acknowledgeQualificationCapture, readQualificationAck } from "../core/host-runs/qualification-acceptance";
import { decodeQualificationRaw } from "../core/host-runs/host-run-retained-output";
import { hostRunResultSchema } from "../shared/contracts";

const sleep = (ms: number) => new Promise<void>(resolvePromise => setTimeout(resolvePromise, ms));
const MiB = 1024 * 1024;
const runId = "qualification-supervisor-run";
const subjectDigest = qualificationSubjectDigest({
  taskId: "task-supervisor", participantRunId: "executor-supervisor", operationId: null, briefVersion: null, briefDigest: null,
  head: "a".repeat(40), tree: "b".repeat(40), selector: "effigy check --plan", inputs: [],
  authorizedBy: { role: "queue_dispatch", caller: null, note: null },
});

function suppliedReadiness(): QualificationReadiness {
  return qualificationReadiness(QUALIFICATION_REQUIRED_INPUTS.map(required => ({
    id: required.id, state: "present" as const,
    evidence: { owner: "fixture supplier", source: `${required.id}-receipt`, digest: null, observedAt: new Date().toISOString() },
  })));
}

test("a qualification supervisor keeps one uncapped artifact, publishes its observation and exits after the ack", async t => {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "ns-qualification-supervisor-")));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const clock = establishFirstEffectClock(Date.now() - 1_000);
  // Nine MiB of stdout: past the ordinary 8 MiB per-stream cap, so the artifact
  // can only hold it if the qualification wiring really has no cap.
  const script = `process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 111)); process.stderr.write(Buffer.from("diagnostic\\n"));`;
  writeHostRunLaunchEnv(stateDir, runId, {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HOST_RUN_TOKEN: "fixture-token",
    [Object.keys(process.env).find(key => key.startsWith("PI_")) ?? "FIXTURE_EXTRA"]: "value",
  });
  const plan = hostRunSupervisorPlanSchema.parse({
    format: "host.run.supervisor.plan", version: 1, stateDir, runId, epoch: 3,
    argv: [process.execPath, "-e", script], cwd: stateDir,
    envKeys: ["HOME", "HOST_RUN_TOKEN", "PATH"],
    runTimeoutMs: 60_000, graceMs: 100, startedAt: new Date().toISOString(),
    stopMode: "qualification_direct", firstEffectClock: clock,
    qualification: {
      subject: {
        taskId: "task-supervisor", participantRunId: "executor-supervisor", operationId: null, briefVersion: null,
        briefDigest: null, head: "a".repeat(40), tree: "b".repeat(40), selector: "effigy check --plan", inputs: [],
        authorizedBy: { role: "queue_dispatch", caller: null, note: null },
      },
      execution: null, firstEffectClock: clock, readiness: suppliedReadiness(),
    },
  });
  writeVerifiedOwnedFile(stateDir, ["runs", runId, "supervisor.plan.json"], JSON.stringify(plan), 0o600);

  // The endpoint side: acknowledge the observation as soon as it is published, the
  // way the watch's own poll does.
  let acknowledged: string | null = null;
  const ackLoop = (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && acknowledged === null) {
      const observation = readQualificationObservation(stateDir, runId);
      if (observation.state === "present") {
        const outcome = acknowledgeQualificationCapture({
          stateDir, runId, epoch: 3, subjectDigest, clock, observation: observation.observation, nowMs: Date.now(),
        });
        if (outcome.state === "acknowledged") acknowledged = outcome.digest;
      } else await sleep(25);
    }
  })();

  const exitedAt = Date.now();
  await runHostRunSupervisorMain([stateDir, runId], { ledgerSampleMs: 50 });
  const elapsed = Date.now() - exitedAt;
  await ackLoop;
  assert.ok(acknowledged, "the endpoint acknowledged the observation the supervisor published");
  assert.ok(elapsed < 20_000, `S exited well inside the target once acknowledged (${elapsed} ms)`);

  const paths = hostRunSupervisorPaths(stateDir, runId);
  // One artifact, and never a per-stream file.
  assert.equal(existsSync(paths.qualificationRawPath), true, "the qualification artifact exists");
  assert.equal(existsSync(paths.stdoutPath), false, "no ordinary stdout file");
  assert.equal(existsSync(paths.stderrPath), false, "no ordinary stderr file");
  const raw = readFileSync(paths.qualificationRawPath);
  const decoded = decodeQualificationRaw(raw);
  assert.equal(decoded.summary.streams.stdout.payloadBytes, 9 * MiB, "the whole 9 MiB survived: qualification wiring has no output cap");
  assert.equal(decoded.summary.streams.stderr.payloadBytes, "diagnostic\n".length);
  assert.equal(decoded.summary.streams.stdout.eofSequence !== null, true, "stdout reached its real EOF");
  assert.equal(decoded.summary.streams.stdout.drainSequence !== null, true, "stdout drained");
  assert.equal(decoded.summary.streams.stderr.eofSequence !== null, true);
  assert.equal(decoded.summary.streams.stderr.drainSequence !== null, true);

  const observation = readQualificationObservation(stateDir, runId);
  assert.equal(observation.state, "present");
  const record = observation.state === "present" ? observation.observation : null;
  assert.ok(record);
  assert.equal(record!.subjectDigest, subjectDigest);
  assert.deepEqual(record!.clock, clock, "the observation carries the attempt's one clock");
  assert.equal(record!.directChildWait?.state, "observed", "S records its own direct-child wait");
  assert.equal(record!.directChildWait?.source, "child-exit-event");
  assert.equal(record!.parentWaits.length, 0, "S synthesizes no creator receipt it does not hold");
  assert.equal(record!.streamTerminals.stdout.eof, "observed");
  assert.equal(record!.streamTerminals.stderr.drained, "observed");
  assert.equal(record!.capture.artifactSha256, decoded.summary.artifactSha256);
  assert.equal(record!.capture.bytes, raw.length);
  assert.equal(record!.capture.sizeIdentityHolds, true);
  assert.equal(record!.capture.partialFrame, false);
  assert.deepEqual(record!.capture.flush, {
    state: "not_applicable",
    reason: "unbuffered: the writer uses writeSync and the artifact is fsynced, so there is no user-space flush to prove",
  });
  assert.ok(record!.ledger.entries.some(entry => entry.scope === "raw_capture"), "the artifact is charged in the ledger");
  assert.equal(record!.ledger.physicalPeak, "unknown", "the ledger claims no all-physical peak");
  assert.ok(record!.ledger.entries.every(entry => entry.physicalPeakClaimed === false));
  assert.equal(record!.faults.length, 0, "no capture, terminal or storage fault latched");

  const ack = readQualificationAck(stateDir, runId);
  assert.equal(ack.state, "present");
  assert.equal(ack.state === "present" ? ack.ack.observationDigest : null, record!.digest, "the ack binds this observation");
  assert.equal(ack.state === "present" ? ack.ack.withinTarget : null, true, "the acknowledgement landed inside the target");

  // The supervisor still wrote contract 010's own result for the run.
  const result = hostRunResultSchema.parse(JSON.parse(readFileSync(paths.resultPath, "utf8")));
  assert.equal(result.exitCode, 0);
  assert.equal(result.runId, runId);
  assert.equal(readdirSync(join(stateDir, "runs", runId)).includes("supervisor.state.json"), true);
});
