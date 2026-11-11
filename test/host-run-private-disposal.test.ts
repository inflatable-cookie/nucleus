/**
 * Disposal proof for the private host-run server fixture (Spec 035): the
 * admitted run survives restarts, so the root must not be removed until that
 * exact run's terminal settlement is observed. The first test restarts the
 * server around a run with a delayed final write and shows the writer is done
 * before disposal; the second shows an unknown or mismatched run refuses
 * settlement instead of deleting state as success. Both run against the real
 * supervised server and the real status wire, not a mirror of the helper.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  awaitOwnedPrivateSettlement,
  settleStopDisposePrivateFixture,
  type OwnedPrivateRun,
} from "./support/host-run-private-fixture";

const script = fileURLToPath(new URL("../bin/host-run-private-server.mjs", import.meta.url));

function request(path: string, method: string, epoch: number, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${method} timed out`)); }, 10_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { buffer += chunk; const index = buffer.indexOf("\n"); if (index >= 0) { clearTimeout(timer); socket.destroy(); resolve(JSON.parse(buffer.slice(0, index))); } });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
    socket.once("connect", () => socket.write(`${JSON.stringify({ v: 1, id: randomUUID(), method, epoch, body })}\n`));
  });
}

interface Started {
  child: ChildProcess;
  root: string;
  stateDir: string;
  work: string;
  authorityLines: Array<Record<string, any>>;
  nextAuthority: (count: number) => Promise<void>;
}

function startSupervised(): Started {
  const root = realpathSync(mkdtempSync("/tmp/hrpd-"));
  const stateDir = join(root, "s");
  const work = join(root, "w");
  mkdirSync(work, { recursive: true });
  const child = spawn(process.execPath, ["--import", "tsx", script, "--supervise", "--state-dir", stateDir], { env: { ...process.env, HOME: root }, stdio: ["ignore", "pipe", "inherit"] });
  const authorityLines: Array<Record<string, any>> = [];
  const waiters: Array<() => void> = [];
  let buffer = "";
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.startsWith("{")) { authorityLines.push(JSON.parse(line)); waiters.splice(0).forEach(wake => wake()); } }
  });
  const nextAuthority = (count: number) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no authority line ${count}`)), 60_000);
    const check = () => { if (authorityLines.length >= count) { clearTimeout(timer); resolve(); } else waiters.push(check); };
    check();
  });
  return { child, root, stateDir, work, authorityLines, nextAuthority };
}

async function submitHeldRun(endpoint: string, epoch: number, work: string, scriptBody: string, selector: string): Promise<string> {
  writeFileSync(join(work, "run.cjs"), scriptBody);
  const submitted = await request(endpoint, "submit", epoch, {
    clientRequestId: randomUUID(), caller: "effigy@disposal-test", repository: "example/host-runs", cwd: work, selector,
    argv: [process.execPath, join(work, "run.cjs"), work], class: "light", classSource: "manifest", priority: "validation",
    budgetFallback: { cpu: 1, memoryBytes: 100_000_000 }, capacityDeadlineMs: 1_800_000, runTimeoutMs: 3_600_000, env: {},
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  return submitted.body.runId as string;
}

async function waitRunning(endpoint: string, epoch: number, runId: string): Promise<Record<string, any>> {
  let view = (await request(endpoint, "status", epoch, { runId })).body;
  for (let attempt = 0; attempt < 100 && !(view.state === "running" && view.pid); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    view = (await request(endpoint, "status", epoch, { runId })).body;
  }
  assert.equal(view.state, "running");
  return view;
}

test("disposal observes the delayed terminal settlement across a restart before removing state", { timeout: 120_000 }, async t => {
  const started = startSupervised();
  const { child, root, work } = started;
  let owned: OwnedPrivateRun | null = null;
  let released = false;
  t.after(async () => {
    if (!released) {
      try { writeFileSync(join(work, "release"), ""); } catch { /* already gone */ }
    }
    await settleStopDisposePrivateFixture(child, root, { owned });
  });

  await started.nextAuthority(1);
  const first = started.authorityLines[0];
  // The final write lands 800 ms after the normal exit is requested: an
  // immediate remove of the root would race this writer (the original
  // ENOTEMPTY), so only an observed settlement proves disposal is safe.
  const runId = await submitHeldRun(first.endpoint, first.epoch, work,
    `const fs=require("node:fs");const d=process.argv[2];const tick=()=>{if(fs.existsSync(d+"/release")){setTimeout(()=>{fs.writeFileSync(d+"/final","done");process.exit(0);},800);}else setTimeout(tick,50);};tick();`,
    "disposal:delayed-write");
  const before = await waitRunning(first.endpoint, first.epoch, runId);
  owned = { endpoint: first.endpoint, epoch: first.epoch, runId, pid: before.pid, startIdentity: before.startIdentity };

  child.kill("SIGUSR2");
  await started.nextAuthority(2);
  const second = started.authorityLines[1];
  assert.notEqual(second.pid, first.pid, "a different server process serves after the restart");
  assert.equal(second.epoch, first.epoch);
  assert.equal(second.endpoint, first.endpoint);

  const releasedAt = Date.now();
  writeFileSync(join(work, "release"), "");
  released = true;
  const settled = await awaitOwnedPrivateSettlement(owned, { timeoutMs: 30_000 });
  assert.equal(settled.runId, runId);
  assert.equal(settled.epoch, first.epoch);
  assert.equal(settled.pid, before.pid, "the settlement names the original run process, not a relaunch");
  assert.equal(settled.startIdentity, before.startIdentity);
  assert.equal(settled.state, "settled");
  assert.ok(settled.settlement, "a settlement envelope arrived with the terminal status");
  assert.equal(settled.settlement.outcome, "passed");
  // The delayed writer finished before the settlement was observed, while the
  // endpoint still answers and before any stop or remove: disposal cannot race it.
  assert.equal(readFileSync(join(work, "final"), "utf8"), "done", "the delayed final write landed before disposal");
  assert.ok(Date.parse(settled.settledAt) >= releasedAt - 1_000, "the terminal settlement follows the normal-exit request");
  assert.ok(existsSync(join(root, "s", "queue.db")), "state is still present at settlement time, removed only by teardown after this");
});

test("an unknown or mismatched run refuses settlement instead of deleting state as success", { timeout: 120_000 }, async t => {
  const started = startSupervised();
  const { child, root, work } = started;
  let owned: OwnedPrivateRun | null = null;
  let released = false;
  t.after(async () => {
    if (!released) {
      try { writeFileSync(join(work, "release"), ""); } catch { /* already gone */ }
    }
    await settleStopDisposePrivateFixture(child, root, { owned });
  });

  await started.nextAuthority(1);
  const first = started.authorityLines[0];

  // A run that was never admitted must not settle: the helper refuses with
  // the endpoint's own unknown_run evidence.
  await assert.rejects(
    awaitOwnedPrivateSettlement({ endpoint: first.endpoint, epoch: first.epoch, runId: `never-admitted-${randomUUID()}` }, { timeoutMs: 5_000 }),
    /unknown_run/,
    "an unadmitted run refuses settlement",
  );

  const runId = await submitHeldRun(first.endpoint, first.epoch, work,
    `const fs=require("node:fs");const d=process.argv[2];const tick=()=>{if(fs.existsSync(d+"/release"))process.exit(0);setTimeout(tick,50)};tick();`,
    "disposal:identity-proof");
  const before = await waitRunning(first.endpoint, first.epoch, runId);

  // The same run under the wrong process identity must not settle either.
  await assert.rejects(
    awaitOwnedPrivateSettlement(
      { endpoint: first.endpoint, epoch: first.epoch, runId, pid: (before.pid as number) + 1_000_000, startIdentity: before.startIdentity },
      { timeoutMs: 5_000 },
    ),
    /process changed/,
    "a pid mismatch refuses settlement",
  );

  // The exact owned run still settles normally afterwards, so the refusals
  // above proved ownership without consuming or disposing anything.
  owned = { endpoint: first.endpoint, epoch: first.epoch, runId, pid: before.pid, startIdentity: before.startIdentity };
  writeFileSync(join(work, "release"), "");
  released = true;
  const settled = await awaitOwnedPrivateSettlement(owned, { timeoutMs: 30_000 });
  assert.equal(settled.runId, runId);
  assert.equal(settled.state, "settled");
  assert.ok(settled.settlement, "the owned run settles once its own identity is presented");
});
