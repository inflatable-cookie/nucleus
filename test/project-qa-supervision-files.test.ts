import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectQaRun } from "../shared/contracts";
import {
  qaSupervisionPaths,
  readQaSupervision,
  readQaSupervisionPlan,
  readQaSupervisionPlanFile,
  readQaSupervisionStateFile,
  writeQaSupervision,
  writeQaSupervisionPlan,
  type QaSupervisionPlan,
  type QaSupervisionState,
} from "../core/qa/project-qa-supervision-files";
import { ProjectQaInspection } from "../core/qa/project-qa-inspection";

const root = () => mkdtempSync(join(tmpdir(), "qa-supervision-files-"));
const token = "0".repeat(32);

const plan = (runId: string): QaSupervisionPlan => ({
  schema: "queue.project-qa.plan.v1", schema_version: 1, runId, key: "repo-key",
  caller: "qa:test", base: "a".repeat(40), baseBranch: "main",
  startedAt: new Date().toISOString(), startedAtMs: Date.now(),
  checkoutPath: "/checkout", registeredPath: "/checkout", runRoot: "/run-root",
  argv: ["true"], timeoutMs: 1000, epoch: 1, runClass: "heavy",
  maxOutputBytes: 1024, terminationGraceMs: 1000, hookTimeoutMs: 1000, hookMaxOutputBytes: 1024,
  identityToken: token, links: [], mode: "full", attempt: 0, retry: null,
});

const state = (runId: string): QaSupervisionState => ({
  schema: "queue.project-qa.supervisor.v1", schema_version: 1, runId, key: "repo-key",
  pid: process.pid, identityToken: token, startedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(), inFlight: null, activeProcess: null,
  pendingProcessIdentity: null, steps: [], failedStep: null, logWriteErrors: [],
  detail: "", escapedDescendants: [], cancelReason: null, result: null,
});

const run = (runId: string): ProjectQaRun => ({
  id: runId, key: "repo-key", state: "running", startedAt: new Date().toISOString(),
  argv: ["true"], steps: [], failedStep: null, interruptedStep: null, pid: null,
} as unknown as ProjectQaRun);

test("a supervision record, a missing file and an unreadable one stay three different answers", (t) => {
  const directory = root();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runId = randomUUID();
  const paths = qaSupervisionPaths(directory, runId);

  assert.deepEqual(readQaSupervisionPlanFile(paths.planPath), { kind: "missing" }, "nothing written yet is an absence");
  writeQaSupervisionPlan(paths.planPath, plan(runId));
  writeQaSupervision(paths.statePath, state(runId));
  const readPlan = readQaSupervisionPlanFile(paths.planPath);
  assert.equal(readPlan.kind, "present");
  if (readPlan.kind === "present") assert.equal(readPlan.value.identityToken, token);
  const readState = readQaSupervisionStateFile(paths.statePath);
  assert.equal(readState.kind, "present");

  // Bytes that do not decode are a refusal with its reason, never an absence.
  writeFileSync(paths.planPath, "{\"schema\":", { mode: 0o600 });
  const corrupt = readQaSupervisionPlanFile(paths.planPath);
  assert.equal(corrupt.kind, "unreadable");
  if (corrupt.kind === "unreadable") assert.match(corrupt.reason, /could not be decoded/);
  assert.equal(readQaSupervisionPlan(paths.planPath), null, "the tolerant reader keeps its null");

  // A record another writer left world-readable is not this run's record.
  writeQaSupervision(paths.statePath, state(runId));
  chmodSync(paths.statePath, 0o644);
  const wrongMode = readQaSupervisionStateFile(paths.statePath);
  assert.equal(wrongMode.kind, "unreadable");
  if (wrongMode.kind === "unreadable") assert.match(wrongMode.reason, /mode 0644 instead of 0600/);
  assert.equal(readQaSupervision(paths.statePath), null, "the tolerant reader keeps its null");
});

test("an unreadable supervision record holds the run instead of reporting it never started", async (t) => {
  const directory = root();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runId = randomUUID();
  const paths = qaSupervisionPaths(directory, runId);
  const inspection = new ProjectQaInspection({ get: () => null }, () => directory);

  // No plan, no heartbeat: nothing carries this run's identity, so it never started.
  assert.equal((await inspection.inspectSupervisor(run(runId))).kind, "dead");

  // A plan that exists but cannot be decoded is not proof of that: hold it.
  writeFileSync(paths.planPath, "not json", { mode: 0o600 });
  const held = await inspection.inspectSupervisor(run(runId));
  assert.equal(held.kind, "running");
  assert.match(held.kind === "running" ? held.reason ?? "" : "", /supervision plan \(could not be decoded.*\) could not be read; the run is held/);
  assert.equal(readQaSupervisionPlan(paths.planPath), null, "the tolerant reader keeps its null");
});
