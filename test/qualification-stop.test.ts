/**
 * Spec 064 P3 (qualification foundation, tranche 1): the direct-command stop.
 *
 * In `qualification_direct` mode every timeout, cancel, failure and exception
 * sends TERM to the one still-held direct command and nothing else — no process
 * group, no escaped descendant, no SIGKILL escalation. These cases use real
 * process groups with a surviving grandchild, and compare the same command in
 * the unchanged default mode so the two stops are distinguishable by observation
 * rather than by reading the code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeHookProgram, type ExecutionOutcome } from "../core/machine/process-exec";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise<void>(resolvePromise => setTimeout(resolvePromise, ms));

/** Kill one process this test started, and wait until it is gone. */
async function killAndWait(pid: number, timeoutMs = 5_000): Promise<void> {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await sleep(20);
}

/**
 * A direct command that starts one grandchild in its own process group and then
 * waits forever. The grandchild's pid is printed, so a test can observe who the
 * stop actually reached.
 */
const directCommandScript = `
const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdout.write('grandchild=' + grandchild.pid + '\\n');
if (process.env.QUALIFICATION_FIXTURE_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-qualification-stop-")));
  const started: number[] = [];
  t.after(async () => {
    for (const pid of started.splice(0)) await killAndWait(pid);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, started };
}

function grandchildOf(outcome: ExecutionOutcome, started: number[]): number {
  const match = /grandchild=(\d+)/.exec(outcome.stdout.toString("utf8"));
  assert.ok(match, `the direct command named its grandchild's pid: ${outcome.stdout.toString("utf8").slice(0, 200)}`);
  const pid = Number(match[1]);
  started.push(pid);
  return pid;
}

function run(input: { root: string; timeoutMs: number; stopMode?: "group" | "qualification_direct";
  env?: Record<string, string>; cancelAfterMs?: number; settleOnProcessGroup?: boolean;
  onSpawn?: (pid: number) => void }): Promise<ExecutionOutcome> {
  const cancelAt = input.cancelAfterMs === undefined ? null : Date.now() + input.cancelAfterMs;
  return executeHookProgram({
    root: input.root, executable: process.execPath, argv: ["-e", directCommandScript],
    stdin: Buffer.alloc(0), timeoutMs: input.timeoutMs, maxOutputBytes: 100_000, overflow: "tail",
    env: { PATH: process.env.PATH ?? "", ...(input.env ?? {}) },
    ...(input.stopMode ? { stopMode: input.stopMode } : {}),
    ...(input.settleOnProcessGroup ? { settleOnProcessGroup: true } : {}),
    ...(input.onSpawn ? { onSpawn: input.onSpawn } : {}),
    ...(cancelAt === null ? {} : { cancelReason: () => Date.now() >= cancelAt ? "qualification fixture cancel" : null }),
  });
}

test("in qualification_direct mode a timeout TERMs only the direct command and the grandchild survives", async t => {
  const f = fixture(t);
  const outcome = await run({ root: f.root, timeoutMs: 400, stopMode: "qualification_direct" });
  const grandchild = grandchildOf(outcome, f.started);

  assert.equal(outcome.timedOut, true, "the timeout is recorded");
  assert.equal(outcome.terminationSignal, "SIGTERM", "the direct command received TERM");
  const stop = outcome.qualificationStop;
  assert.ok(stop, "the qualification stop is recorded on the outcome");
  assert.equal(stop.mode, "qualification_direct");
  assert.equal(stop.cause, "timeout");
  assert.equal(stop.signal, "SIGTERM");
  assert.equal(stop.groupSignalled, false, "no process-group signal was sent");
  assert.equal(stop.escapedDescendantSignalled, false, "no escaped-descendant signal was sent");
  assert.equal(stop.killEscalated, false, "no SIGKILL escalation was sent");
  assert.equal(outcome.processGroupEmpty, null, "the group was never signalled or awaited as a stop condition");
  assert.equal(alive(grandchild), true, "the grandchild survives a stop that never reaches the group");
});

test("in qualification_direct mode a cancel TERMs only the direct command and the grandchild survives", async t => {
  const f = fixture(t);
  const outcome = await run({ root: f.root, timeoutMs: 30_000, stopMode: "qualification_direct", cancelAfterMs: 350 });
  const grandchild = grandchildOf(outcome, f.started);

  assert.equal(outcome.cancelled, true, "the cancel is recorded");
  assert.equal(outcome.terminationSignal, "SIGTERM");
  const stop = outcome.qualificationStop;
  assert.ok(stop);
  assert.equal(stop.cause, "cancel");
  assert.equal(stop.signal, "SIGTERM");
  assert.equal(stop.groupSignalled, false);
  assert.equal(stop.escapedDescendantSignalled, false);
  assert.equal(stop.killEscalated, false);
  assert.equal(alive(grandchild), true, "the grandchild survives the cancel");
});

test("in qualification_direct mode a command that ignores TERM is never killed and never escalates", async t => {
  const f = fixture(t);
  let directPid = 0;
  const pending = run({
    root: f.root, timeoutMs: 30_000, stopMode: "qualification_direct", cancelAfterMs: 250,
    env: { QUALIFICATION_FIXTURE_IGNORE_TERM: "1" }, onSpawn: pid => { directPid = pid; },
  });
  // The stop has been requested and TERM was sent; the command ignores it.
  await sleep(900);
  assert.ok(directPid > 0, "the direct command's pid was observed");
  assert.equal(alive(directPid), true, "the direct command survives: no SIGKILL escalation is available in this mode");

  // End the fixture ourselves; the stop record still says what the mode did.
  await killAndWait(directPid);
  const outcome = await pending;
  const grandchild = grandchildOf(outcome, f.started);
  assert.equal(outcome.qualificationStop?.signal, "SIGTERM");
  assert.equal(outcome.qualificationStop?.killEscalated, false);
  assert.equal(outcome.terminationSignal, "SIGTERM");
  assert.equal(alive(grandchild), true, "the grandchild was never signalled by the stop");
});

test("with the mode absent the ordinary group stop still reaches the whole group and capture is unchanged", async t => {
  const f = fixture(t);
  const outcome = await run({ root: f.root, timeoutMs: 400, settleOnProcessGroup: true });
  const grandchild = grandchildOf(outcome, f.started);

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.terminationSignal, "SIGTERM", "the group's TERM stage is recorded as before");
  assert.equal(outcome.processGroupEmpty, true, "the group is empty, as Contract 010's settlement requires");
  assert.equal(outcome.qualificationStop, undefined, "no qualification stop is recorded when the mode is absent");
  // The group signal reached the grandchild, which is the explicit comparison with
  // the qualification cases above.
  assert.equal(alive(grandchild), false, "the ordinary group stop still reaches the grandchild");
  assert.match(outcome.stdout.toString("utf8"), /grandchild=\d+/, "stream capture is unchanged");
});
