/**
 * Spec 064 P4 amendment 1 (qualification foundation, tranche 3): the strict
 * capture's EOF wait is bounded by the attempt's own first-effect deadline, not by
 * a fresh span counted from when the wait starts.
 *
 * A direct command hands its stdout to a grandchild that outlives it and keeps the
 * pipe open, so the strict capture can never see that stream's real EOF. The
 * deadline is the attempt's `originTick + targetMs`: whatever remains of the target
 * at the moment the wait begins is all it may spend. When it expires the stream
 * stays `unknown`, the step settles, and nothing manufactures EOF, signals the
 * group or grants extra cleanup time.
 *
 * Every fixture is a fresh mktemp under this run's TMPDIR and every process this
 * test starts is killed by pid, never by pattern.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeHookProgram, type ExecutionOutcome } from "../core/machine/process-exec";

const sleep = (ms: number) => new Promise<void>(resolvePromise => setTimeout(resolvePromise, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function killAndWait(pid: number, timeoutMs = 5_000): Promise<void> {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await sleep(20);
}

/**
 * A direct command that writes a line, then hands its own stdout descriptor to a
 * detached grandchild which holds it open forever. The pipe therefore never
 * reaches EOF, which is exactly the shape the amendment bounds.
 */
const pipeHoldScript = `
const { spawn } = require('node:child_process');
process.stdout.write('direct payload\\n');
const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
process.stdout.write('holder=' + holder.pid + '\\n');
holder.unref();
`;

function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-qualification-eof-")));
  const started: number[] = [];
  t.after(async () => {
    for (const pid of started.splice(0)) await killAndWait(pid);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, started };
}

function pipeHolderOf(outcome: ExecutionOutcome, started: number[]): number {
  const match = /holder=(\d+)/.exec(outcome.stdout.toString("utf8"));
  assert.ok(match, `the direct command named the process holding its pipe: ${outcome.stdout.toString("utf8").slice(0, 200)}`);
  const pid = Number(match[1]);
  started.push(pid);
  return pid;
}

async function run(input: { root: string; eofWaitDeadlineMs: number }): Promise<{ outcome: ExecutionOutcome; eofs: string[] }> {
  const eofs: string[] = [];
  const outcome = await executeHookProgram({
    root: input.root, executable: process.execPath, argv: ["-e", pipeHoldScript],
    stdin: Buffer.alloc(0), timeoutMs: 60_000, maxOutputBytes: Number.MAX_SAFE_INTEGER, overflow: "tail",
    env: { PATH: process.env.PATH ?? "" },
    qualificationCapture: true,
    eofWaitDeadlineMs: input.eofWaitDeadlineMs,
    onStreamEof: stream => eofs.push(`eof:${stream}`),
    onStreamDrained: stream => eofs.push(`drained:${stream}`),
  });
  return { outcome, eofs };
}

test("a pipe held open outside the group settles at the attempt's deadline, not a fresh full target", async t => {
  const f = fixture(t);
  const startedAt = Date.now();
  // The attempt's origin is `targetMs` ago, so ~400 ms of it is left: the wait may
  // spend only that. A fresh full-target wait would hang here for ten minutes.
  const deadline = Date.now() + 400;
  const { outcome, eofs } = await run({ root: f.root, eofWaitDeadlineMs: deadline });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 15_000, `the strict capture settled instead of waiting for the holder (${elapsed} ms)`);
  assert.ok(elapsed >= 250, `the wait really did spend the remaining target (${elapsed} ms)`);
  assert.equal(outcome.eofWaitTimedOut, true, "the EOF wait hitting its bound is recorded");
  assert.equal(outcome.streamTerminals?.stdout.eof, "unknown", "an unobserved EOF stays unknown, never manufactured");
  assert.equal(outcome.streamTerminals?.stdout.drained, "unknown", "an unobserved drain stays unknown too");
  // A stream whose pipe never closed reports no EOF event, and no group signal was
  // sent for it: the holder is still running and is killed here, by pid.
  // stderr really ended (the holder inherits only stdout); the held-open stdout
  // stream produced no terminal event at all, which is the whole point.
  assert.deepEqual(eofs.filter(event => event.endsWith("stdout")), [], "no EOF or drain event was invented for the held-open stream");
  assert.deepEqual(eofs, ["eof:stderr", "drained:stderr"], "the stream that really ended keeps its own events");
  const holder = pipeHolderOf(outcome, f.started);
  assert.equal(alive(holder), true, "the step never signalled a process outside its custody");
  assert.equal(outcome.terminationSignal, null, "no stop signal was sent for a capture that only ran out of time");
});

test("a deadline already past settles at once instead of opening a new target window", async t => {
  const f = fixture(t);
  const startedAt = Date.now();
  const { outcome, eofs } = await run({ root: f.root, eofWaitDeadlineMs: Date.now() - 1_000 });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 10_000, `an expired deadline settles instead of granting time (${elapsed} ms)`);
  assert.equal(outcome.eofWaitTimedOut, true);
  assert.equal(outcome.streamTerminals?.stdout.eof, "unknown");
  assert.deepEqual(eofs.filter(event => event.endsWith("stdout")), [], "an already-expired deadline invents nothing either");
  const holder = pipeHolderOf(outcome, f.started);
  assert.equal(alive(holder), true, "still no signal to anything outside the direct command");
});

test("a stream that really ends keeps its observed EOF and drain", async t => {
  const f = fixture(t);
  const eofs: string[] = [];
  const outcome = await executeHookProgram({
    root: f.root, executable: process.execPath,
    argv: ["-e", "process.stdout.write('complete\\n')"],
    stdin: Buffer.alloc(0), timeoutMs: 60_000, maxOutputBytes: Number.MAX_SAFE_INTEGER, overflow: "tail",
    env: { PATH: process.env.PATH ?? "" },
    qualificationCapture: true,
    eofWaitDeadlineMs: Date.now() + 60_000,
    onStreamEof: stream => eofs.push(`eof:${stream}`),
    onStreamDrained: stream => eofs.push(`drained:${stream}`),
  });
  assert.equal(outcome.eofWaitTimedOut ?? false, false, "a completed stream never trips the bound");
  assert.equal(outcome.streamTerminals?.stdout.eof, "observed");
  assert.equal(outcome.streamTerminals?.stdout.drained, "observed");
  assert.deepEqual([...eofs].sort(), ["drained:stderr", "drained:stdout", "eof:stderr", "eof:stdout"],
    "each stream reports its own real terminal events");
});
