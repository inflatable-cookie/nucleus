/**
 * The private host-run server's restart entrypoint (Spec 035): `--supervise`
 * replaces the server process on SIGUSR2 the way a Queue roll does, on the same
 * isolated state directory and store, and prints the new authority line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readHostRunTokenKeys } from "../service/callbacks/host-run-endpoint";
import { settleStopDisposePrivateFixture, type OwnedPrivateRun } from "./support/host-run-private-fixture";

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

test("--supervise replaces the private server on SIGUSR2 over the same state and prints the new authority", { timeout: 120_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hrp-")));
  const stateDir = join(root, "s");
  const work = join(root, "w");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "run.cjs"), `const fs=require("node:fs");const d=process.argv[2];const tick=()=>{if(fs.existsSync(d+"/release"))process.exit(0);setTimeout(tick,50)};tick();`);
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
  // The admitted run survives restarts and may still own state after the
  // server exits, so teardown settles that exact run while the endpoint
  // answers, then stops the supervisor, and only then disposes the root.
  // A settle refusal fails the fixture instead of deleting state as success.
  let owned: OwnedPrivateRun | null = null;
  t.after(async () => {
    try { writeFileSync(join(work, "release"), ""); } catch { /* the work dir may already be gone */ }
    await settleStopDisposePrivateFixture(child, root, { owned });
  });

  await nextAuthority(1);
  const first = authorityLines[0];
  const keys = readHostRunTokenKeys(stateDir);
  const submitted = await request(first.endpoint, "submit", first.epoch, {
    clientRequestId: randomUUID(), caller: "effigy@restart-test", repository: "example/host-runs", cwd: work, selector: "restart:probe",
    argv: [process.execPath, join(work, "run.cjs"), work], class: "light", classSource: "manifest", priority: "validation",
    budgetFallback: { cpu: 1, memoryBytes: 100_000_000 }, capacityDeadlineMs: 1_800_000, runTimeoutMs: 3_600_000, env: {},
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const runId = submitted.body.runId as string;
  let before = (await request(first.endpoint, "status", first.epoch, { runId })).body;
  for (let attempt = 0; attempt < 100 && !(before.state === "running" && before.pid); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    before = (await request(first.endpoint, "status", first.epoch, { runId })).body;
  }
  assert.equal(before.state, "running");
  owned = { endpoint: first.endpoint, epoch: first.epoch, runId, pid: before.pid, startIdentity: before.startIdentity };

  child.kill("SIGUSR2");
  await nextAuthority(2);
  const second = authorityLines[1];
  assert.notEqual(second.pid, first.pid, "a different server process serves after the restart");
  assert.equal(second.epoch, first.epoch);
  assert.equal(second.endpoint, first.endpoint);
  assert.deepEqual(readHostRunTokenKeys(stateDir), keys, "the restart keeps the token keys");
  const after = (await request(second.endpoint, "status", second.epoch, { runId })).body;
  assert.equal(after.runId, runId);
  assert.equal(after.pid, before.pid, "the run's process is the one launched before the restart");
});
