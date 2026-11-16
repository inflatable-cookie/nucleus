import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detachedSupervisorIo, SUPERVISOR_HEARTBEAT_MS } from "../core/qa/project-qa-detached-io";
import { writeQaStepLogAsync, writeQaJsonAsync, openQaLiveOutput } from "../core/qa/project-qa-async-io";
import { runProjectQaPipeline, type QaPipelineRun } from "../core/qa/project-qa-pipeline";
import { qaSupervisionPaths, qaSupervisionPlanSchema, qaStepLogPaths, readQaHeartbeat, readQaSupervision } from "../core/qa/project-qa-supervision-files";
import { ProjectQaInspection } from "../core/qa/project-qa-inspection";
import { LIVE_OUTPUT_BYTES } from "../core/machine/live-output";

async function until(predicate: () => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("timed out waiting for heartbeat proof");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("a real blocked step-log pipe cannot stop the supervisor heartbeat or regress its lifecycle state", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "qa-heartbeat-"));
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
    argv: ["/bin/sh", "-c", "printf pipe-proof"],
    stages: [{ name: "qa", argv: ["/bin/sh", "-c", "printf pipe-proof"], timeoutMs: 10_000 }],
    timeoutMs: 60_000, maxOutputBytes: 1024, terminationGraceMs: 100,
    epoch: 1, links: [], hostRunToken: "synthetic-token", temporaryDirectory: root,
  };
  const plan = qaSupervisionPlanSchema.parse({ ...run, schema: "queue.project-qa.plan.v1", schema_version: 1,
    identityToken, hookTimeoutMs: 10_000, hookMaxOutputBytes: 1024 });
  const paths = qaSupervisionPaths(runRoot, runId);
  const io = detachedSupervisorIo(plan, paths.statePath, run);
  const pipe = qaStepLogPaths(runRoot, runId, "qa").stdoutPath;
  execFileSync("mkfifo", ["-m", "600", pipe]);
  let entered = false, completed = false, settled = false;
  io.log = async (path, buffer) => {
    if (path === pipe) entered = true;
    const result = await writeQaStepLogAsync(path, buffer);
    if (path === pipe) completed = true;
    return result;
  };
  const pipeline = runProjectQaPipeline({ pid: process.pid, identityToken }, run, io).finally(() => { settled = true; });
  // Always unblock the pipe before teardown, including a failed assertion.
  let reader: Promise<Buffer> | undefined;
  try {
    await until(() => entered);
    assert.equal(completed, false, "the writer is waiting on a real FIFO reader");
    const before = readQaSupervision(paths.statePath)!;
    await until(() => Date.parse(readQaHeartbeat(paths.heartbeatPath, before)) > Date.parse(before.heartbeatAt));
    const first = readQaHeartbeat(paths.heartbeatPath, before);
    await until(() => Date.parse(readQaHeartbeat(paths.heartbeatPath, before)) > Date.parse(first));
    assert.equal(completed, false);
    assert.equal(settled, false, "the pipeline awaits its authoritative step log");
    assert.equal(readQaSupervision(paths.statePath)!.inFlight, "qa");
    const inspection = new ProjectQaInspection({ get: () => null }, () => runRoot);
    const observed = await inspection.inspectSupervisor({ id: runId, key: run.key, startedAt: run.startedAt } as any);
    assert.ok(Date.parse(observed.state!.heartbeatAt) >= Date.parse(first), "inspection reads the independent heartbeat even with a cached lifecycle file");
  } finally {
    reader = readFile(pipe);
    await pipeline;
    assert.equal((await reader).toString(), "pipe-proof");
  }
  assert.equal(completed, true);
  assert.equal(readQaSupervision(paths.statePath)!.result!.state, "passed");
  assert.equal(SUPERVISOR_HEARTBEAT_MS, 2_000, "the existing heartbeat cadence is preserved");
});

test("async live output bounds its pending tail and redacts split secrets", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "qa-live-async-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "live.log");
  const log = await openQaLiveOutput(path, "private-token");
  assert.ok(log);
  log.write(Buffer.from("private-"));
  log.write(Buffer.from("token\n"));
  await log.close();
  assert.equal(await readFile(path, "utf8"), "[REDACTED]\n");
  const bounded = await openQaLiveOutput(path);
  bounded!.write(Buffer.alloc(LIVE_OUTPUT_BYTES * 3, "x"));
  bounded!.write(Buffer.from("last line\n"));
  await bounded!.close();
  const output = await readFile(path, "utf8");
  assert.ok(output.length <= LIVE_OUTPUT_BYTES + 100);
  assert.ok(output.endsWith("last line\n"));
});

test("heartbeat freshness is accepted only from the same run, pid and private identity", async t => {
  const root = await mkdtemp(join(tmpdir(), "qa-heartbeat-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "heartbeat.json");
  const state = { runId: "run", pid: process.pid, identityToken: randomUUID(), heartbeatAt: "2026-11-16T00:00:00.000Z" } as any;
  const fresh = "2026-11-16T01:00:00.000Z";
  for (const mismatch of [{ runId: "other" }, { pid: process.pid + 1 }, { identityToken: randomUUID() }]) {
    await writeQaJsonAsync(path, { ...state, heartbeatAt: fresh, ...mismatch }, false);
    assert.equal(readQaHeartbeat(path, state), state.heartbeatAt);
  }
  await writeQaJsonAsync(path, { ...state, heartbeatAt: fresh }, false);
  assert.equal(readQaHeartbeat(path, state), fresh);
});
