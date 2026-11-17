/**
 * Spec 064 P4 (qualification foundation, tranche 2): the one NQRAW001 combined
 * raw artifact, its real per-stream EOF/drain observations, its strict
 * durability evidence and the ordinary capture's unchanged shape.
 *
 * Every fixture is a fresh mktemp under the run's scratch. The process cases use
 * real child processes and real pipes; nothing here starts an executor, a proof
 * or a supervisor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  QUALIFICATION_RAW_HEADER_BYTES, QUALIFICATION_RAW_MAGIC, QUALIFICATION_RAW_MAX_DATA_BYTES,
  decodeQualificationRaw, openHostRunRetainedOutput, type OpenHostRunRetainedOutputOptions,
} from "../core/host-runs/host-run-retained-output";
import { hostRunSupervisorPaths, writeVerifiedOwnedFile } from "../core/host-runs/host-run-files";
import { HOST_RUN_RETAINED_OUTPUT_BYTES } from "../core/host-runs/host-run-endpoint-types";
import { executeHookProgram, type ExecutionOutcome } from "../core/machine/process-exec";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-qualification-raw-")));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root, stateDir,
    run: () => randomUUID(),
    capture(runId: string, options: OpenHostRunRetainedOutputOptions = { qualification: true }) {
      return openHostRunRetainedOutput(stateDir, runId, HOST_RUN_RETAINED_OUTPUT_BYTES, "fixture-secret", options);
    },
    artifact(runId: string) { return hostRunSupervisorPaths(stateDir, runId).qualificationRawPath; },
    runCommand(script: string) {
      const runId = randomUUID();
      const capture = this.capture(runId, { qualification: true });
      const scriptPath = join(root, `${runId}.mjs`);
      writeFileSync(scriptPath, script);
      const execution = executeHookProgram({
        root, executable: process.execPath, argv: [scriptPath], stdin: Buffer.alloc(0),
        timeoutMs: 30_000, maxOutputBytes: 64 * 1024, env: { PATH: process.env.PATH ?? "" },
        overflow: "tail", qualificationCapture: true,
        onOutput: (stream, chunk) => capture.write(stream, chunk),
        onStreamEof: stream => capture.markEof(stream),
        onStreamDrained: stream => capture.markDrained(stream),
      });
      return { runId, capture, execution };
    },
  };
}

// ---------------------------------------------------------------------------
// Acceptance 1: one combined artifact from a real child
// ---------------------------------------------------------------------------

test("a real child's interleaved streams and one empty stream decode to the exact bytes, with one EOF and one DRAIN each and the P4 size identity", async t => {
  const f = fixture(t);
  const big = "A".repeat(150_000);
  // One write larger than 64 KiB, interleaved with the other stream.
  const { runId, capture, execution } = f.runCommand(`
const big = "A".repeat(150000);
process.stdout.write("out-1\\n");
process.stderr.write("err-1\\n");
process.stdout.write(big);
process.stderr.write("err-2\\n");
process.stdout.write("out-2\\n");
`);
  const outcome = await execution;
  const closed = capture.close();
  const evidence = closed.qualification;
  assert.ok(evidence, "the qualification capture reports its artifact");
  assert.deepEqual(closed.faults, [], "a clean capture reports no fault");
  assert.equal(evidence.latched, false);
  assert.equal(evidence.sizeIdentityHolds, true, "the artifact is exactly 8 + B + 22 x (N + 4) bytes");
  assert.equal(outcome.captureFault, undefined, "a clean capture records no fault");
  assert.equal(outcome.streamTerminals?.stdout.eof, "observed");
  assert.equal(outcome.streamTerminals?.stdout.drained, "observed");
  assert.equal(outcome.streamTerminals?.stderr.eof, "observed");
  assert.equal(outcome.streamTerminals?.stderr.drained, "observed");
  for (const stream of ["stdout", "stderr"] as const) {
    assert.match(outcome.streamTerminals![stream].eofAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.match(outcome.streamTerminals![stream].drainedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  }

  const path = f.artifact(runId);
  assert.equal(statSync(path).mode & 0o777, 0o600, "the artifact is mode 0600");
  assert.equal(existsSync(hostRunSupervisorPaths(f.stateDir, runId).stdoutPath), false, "no stdout file exists");
  assert.equal(existsSync(hostRunSupervisorPaths(f.stateDir, runId).stderrPath), false, "no stderr file exists");

  const decoded = decodeQualificationRaw(readFileSync(path), { collectPayloads: true });
  assert.equal(decoded.summary.bytes, evidence.bytes);
  assert.equal(decoded.summary.frameCount, evidence.frameCount);
  assert.equal(decoded.summary.artifactSha256, evidence.artifactSha256);
  assert.equal(decoded.summary.dataFrameCount, evidence.dataFrameCount);
  assert.equal(decoded.summary.bytes, 8 + decoded.summary.payloadBytes + QUALIFICATION_RAW_HEADER_BYTES * (decoded.summary.dataFrameCount + 4));
  assert.equal(decoded.summary.bytes, statSync(path).size);
  assert.ok(decoded.frames.length > 0);
  assert.deepEqual(decoded.frames.map(frame => frame.sequence), decoded.frames.map((_, index) => index + 1), "global sequences are gap-free from 1");
  for (const frame of decoded.frames)
    assert.ok(frame.length <= QUALIFICATION_RAW_MAX_DATA_BYTES, "no DATA frame exceeds 65,536 bytes");

  const expectedStdout = Buffer.from(`out-1\n${big}out-2\n`);
  const expectedStderr = Buffer.from("err-1\nerr-2\n");
  assert.deepEqual(decoded.payloads!.stdout, expectedStdout, "stdout payload bytes are exact");
  assert.deepEqual(decoded.payloads!.stderr, expectedStderr, "stderr payload bytes are exact");
  assert.equal(decoded.summary.streams.stdout.payloadBytes, expectedStdout.length);
  assert.equal(decoded.summary.streams.stdout.payloadSha256, evidence.streams.stdout.payloadSha256);
  assert.equal(decoded.summary.streams.stderr.payloadBytes, expectedStderr.length);
  assert.equal(decoded.summary.streams.stderr.payloadSha256, evidence.streams.stderr.payloadSha256);

  // One EOF and one DRAIN per stream, at that stream's final offset.
  for (const stream of ["stdout", "stderr"] as const) {
    const finals = decoded.frames.filter(frame => frame.stream === stream && frame.kind !== "DATA");
    assert.deepEqual(finals.map(frame => frame.kind), ["EOF", "DRAIN"], `${stream} has exactly one EOF then one DRAIN`);
    assert.ok(finals.every(frame => frame.offset === decoded.summary.streams[stream].payloadBytes), `${stream}'s markers sit at its final offset`);
    assert.equal(evidence.streams[stream].eofSequence, finals[0].sequence);
    assert.equal(evidence.streams[stream].drainSequence, finals[1].sequence);
  }
});

test("an empty stream still gets its EOF and DRAIN at offset zero", async t => {
  const f = fixture(t);
  const { runId, capture, execution } = f.runCommand(`process.stdout.write("only-stdout\\n");`);
  await execution;
  const closed = capture.close();
  assert.deepEqual(closed.faults, []);
  const decoded = decodeQualificationRaw(readFileSync(f.artifact(runId)), { collectPayloads: true });
  assert.deepEqual(decoded.payloads!.stderr, Buffer.alloc(0), "the empty stream decoded to no payload bytes");
  assert.equal(decoded.summary.streams.stderr.payloadBytes, 0);
  assert.equal(decoded.summary.streams.stderr.dataFrames, 0);
  const stderrMarkers = decoded.frames.filter(frame => frame.stream === "stderr");
  assert.deepEqual(stderrMarkers.map(frame => frame.kind), ["EOF", "DRAIN"]);
  assert.ok(stderrMarkers.every(frame => frame.offset === 0), "both markers sit at offset zero");
  assert.ok(stderrMarkers[0].sequence < stderrMarkers[1].sequence);
});

test("one observed chunk larger than 64 KiB becomes consecutive bounded DATA frames", t => {
  const f = fixture(t);
  const runId = f.run();
  const capture = f.capture(runId);
  const payload = Buffer.alloc(QUALIFICATION_RAW_MAX_DATA_BYTES + 1_234, 0x62);
  capture.write("stdout", payload);
  capture.markEof("stdout");
  capture.markDrained("stdout");
  capture.markEof("stderr");
  capture.markDrained("stderr");
  const closed = capture.close();
  assert.deepEqual(closed.faults, []);
  const decoded = decodeQualificationRaw(readFileSync(f.artifact(runId)));
  assert.deepEqual(decoded.frames.slice(0, 2).map(frame => frame.length), [QUALIFICATION_RAW_MAX_DATA_BYTES, 1_234]);
  assert.deepEqual(decoded.frames.slice(0, 2).map(frame => frame.offset), [0, QUALIFICATION_RAW_MAX_DATA_BYTES]);
  assert.equal(decoded.frames.length, 6, "two DATA frames and four terminal markers");
});

// ---------------------------------------------------------------------------
// Acceptance 2: every rejection class
// ---------------------------------------------------------------------------

function rawFrame(kind: number, stream: number, sequence: number, offset: number, length = 0, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(QUALIFICATION_RAW_HEADER_BYTES);
  header.writeUInt8(kind, 0);
  header.writeUInt8(stream, 1);
  header.writeBigUInt64BE(BigInt(sequence), 2);
  header.writeBigUInt64BE(BigInt(offset), 10);
  header.writeUInt32BE(length, 18);
  return Buffer.concat([header, payload]);
}

const magic = Buffer.from(QUALIFICATION_RAW_MAGIC, "ascii");
const decode = (bytes: Buffer) => decodeQualificationRaw(bytes);
/** A complete, valid small artifact; each rejection case mutates one rule. */
const validArtifact = () => Buffer.concat([
  magic,
  rawFrame(1, 1, 1, 0, 3, Buffer.from("out")),
  rawFrame(2, 1, 2, 3),
  rawFrame(3, 1, 3, 3),
  rawFrame(1, 2, 4, 0, 3, Buffer.from("err")),
  rawFrame(2, 2, 5, 3),
  rawFrame(3, 2, 6, 3),
]);

test("the strict validator accepts the whole format and rejects every class the format forbids", () => {
  const accepted = decode(validArtifact());
  assert.equal(accepted.summary.frameCount, 6);
  assert.equal(accepted.summary.payloadBytes, 6);
  assert.equal(accepted.frames.at(-1)!.stream, "stderr");

  const cases: Array<[string, Buffer]> = [
    ["short-artifact", magic.subarray(0, 4)],
    ["bad-magic", Buffer.concat([Buffer.from("NQRAW000", "ascii"), validArtifact().subarray(8)])],
    ["partial-header", Buffer.concat([validArtifact(), Buffer.alloc(5)])],
    ["unknown-kind", Buffer.concat([magic, rawFrame(9, 1, 1, 0)])],
    ["unknown-stream", Buffer.concat([magic, rawFrame(1, 7, 1, 0, 3, Buffer.from("out"))])],
    ["sequence-gap", Buffer.concat([magic, rawFrame(1, 1, 1, 0, 3, Buffer.from("out")), rawFrame(2, 1, 3, 3)])],
    ["offset", Buffer.concat([magic, rawFrame(1, 2, 1, 1, 3, Buffer.from("err"))])],
    ["length", Buffer.concat([magic, rawFrame(1, 1, 1, 0, 0)])],
    ["length", Buffer.concat([magic, rawFrame(1, 1, 1, 0, QUALIFICATION_RAW_MAX_DATA_BYTES + 1)])],
    ["length", Buffer.concat([magic, rawFrame(2, 1, 1, 0, 3)])],
    ["data-after-eof", Buffer.concat([magic, rawFrame(2, 1, 1, 0), rawFrame(1, 1, 2, 0, 1, Buffer.from("x")), rawFrame(3, 1, 3, 0)])],
    ["drain-before-eof", Buffer.concat([magic, rawFrame(3, 1, 1, 0)])],
    ["duplicate-marker", Buffer.concat([magic, rawFrame(2, 1, 1, 0), rawFrame(2, 1, 2, 0)])],
    ["duplicate-marker", Buffer.concat([magic, rawFrame(2, 1, 1, 0), rawFrame(3, 1, 2, 0), rawFrame(3, 1, 3, 0)])],
    ["trailing-frame", Buffer.concat([magic, rawFrame(2, 1, 1, 0), rawFrame(3, 1, 2, 0), rawFrame(2, 1, 3, 0)])],
    ["trailing-frame", Buffer.concat([magic, rawFrame(2, 1, 1, 0), rawFrame(3, 1, 2, 0), rawFrame(1, 1, 3, 0, 1, Buffer.from("x"))])],
    ["missing-marker", Buffer.concat([magic, rawFrame(1, 1, 1, 0, 3, Buffer.from("out")), rawFrame(2, 2, 2, 0), rawFrame(3, 2, 3, 0)])],
    ["missing-marker", Buffer.concat([magic, rawFrame(1, 1, 1, 0, 3, Buffer.from("out")), rawFrame(2, 1, 2, 3), rawFrame(2, 2, 3, 0), rawFrame(3, 2, 4, 0)])],
    ["payload-truncated", Buffer.concat([magic, rawFrame(1, 1, 1, 0, 10, Buffer.from("abc"))])],
  ];
  for (const [code, bytes] of cases) {
    assert.throws(() => decode(bytes), (error: unknown) => {
      assert.equal((error as { code?: string }).code, code, `${error instanceof Error ? error.message : String(error)}`);
      return true;
    }, `the validator rejects ${code}`);
  }
});

// ---------------------------------------------------------------------------
// Acceptance 3: injected faults latch, stop, retain and report
// ---------------------------------------------------------------------------

test("an injected write fault latches, retains the complete frames before it, and is reported with the fsync faults that follow", t => {
  const f = fixture(t);
  const runId = f.run();
  let writes = 0;
  const capture = f.capture(runId, {
    qualification: true,
    hooks: { beforeWrite: () => { writes += 1; if (writes === 2) throw new Error("injected write fault"); } },
  });
  capture.write("stdout", Buffer.from("first"));
  assert.throws(() => capture.write("stdout", Buffer.from("second")), /injected write fault/);
  const closed = capture.close();
  assert.equal(closed.qualification?.latched, true);
  assert.equal(closed.qualification?.sizeIdentityHolds, false, "a faulted artifact never claims the size identity");
  assert.equal(closed.faults[0]?.kind, "write");
  assert.match(closed.faults[0]?.detail ?? "", /injected write fault/);
  assert.equal(closed.faults.length, 1, "a latched artifact is not accused again for the close that followed its fault");
  // Magic plus the one complete frame; the failed frame wrote nothing new.
  const retained = readFileSync(f.artifact(runId));
  assert.equal(retained.length, 8 + QUALIFICATION_RAW_HEADER_BYTES + 5);
  assert.throws(() => decodeQualificationRaw(retained), /missing-marker/);
});

test("injected fsync, close and directory faults are each reported, never swallowed", t => {
  const f = fixture(t);
  const runs = {
    fsync: f.run(), close: f.run(), directory: f.run(),
  } as const;
  const captures = {
    fsync: f.capture(runs.fsync, { qualification: true, hooks: { beforeFsync: () => { throw new Error("injected fsync fault"); } } }),
    close: f.capture(runs.close, { qualification: true, hooks: { beforeClose: () => { throw new Error("injected close fault"); } } }),
    directory: f.capture(runs.directory, { qualification: true, hooks: { beforeDirectorySync: () => { throw new Error("injected directory fault"); } } }),
  };
  for (const [name, capture] of Object.entries(captures)) {
    capture.write("stdout", Buffer.from("payload"));
    capture.markEof("stdout");
    capture.markDrained("stdout");
    capture.markEof("stderr");
    capture.markDrained("stderr");
    const closed = capture.close();
    assert.equal(closed.faults[0]?.kind, name, `${name} is the reported fault kind`);
    assert.match(closed.faults[0]?.detail ?? "", new RegExp(`injected ${name} fault`));
    assert.equal(closed.qualification?.latched, true);
    assert.equal(closed.qualification?.sizeIdentityHolds, false);
    // The artifact is retained exactly as written: complete, decodable, unremoved.
    const decoded = decodeQualificationRaw(readFileSync(f.artifact(runs[name as keyof typeof runs])));
    assert.equal(decoded.summary.payloadBytes, 7);
  }
});

test("a strict capture fault requests the P3 direct-command stop and rejects with what was observed", async t => {
  const f = fixture(t);
  const runId = f.run();
  const capture = f.capture(runId, {
    qualification: true,
    hooks: { beforeWrite: () => { throw new Error("injected capture write fault"); } },
  });
  const scriptPath = join(f.root, `${runId}.mjs`);
  writeFileSync(scriptPath, `process.stdout.write("partial-output\\n");\nsetInterval(() => {}, 1000);\n`);
  let pid: number | null = null;
  let rejected: unknown = null;
  try {
    await executeHookProgram({
      root: f.root, executable: process.execPath, argv: [scriptPath], stdin: Buffer.alloc(0),
      timeoutMs: 30_000, maxOutputBytes: 64 * 1024, env: { PATH: process.env.PATH ?? "" },
      overflow: "tail", qualificationCapture: true, stopMode: "qualification_direct",
      onSpawn: spawned => { pid = spawned; },
      onOutput: (stream, chunk) => capture.write(stream, chunk),
      onStreamEof: stream => capture.markEof(stream),
      onStreamDrained: stream => capture.markDrained(stream),
    });
    assert.fail("a strict capture fault must reject the step");
  } catch (error) { rejected = error; }
  const outcome = (rejected as { outcome?: ExecutionOutcome }).outcome;
  assert.ok(outcome, "the rejection carries what the step observed");
  assert.match(outcome!.captureFault ?? "", /injected capture write fault/);
  assert.equal(outcome!.qualificationStop?.mode, "qualification_direct");
  assert.equal(outcome!.qualificationStop?.cause, "overflow");
  assert.equal(outcome!.qualificationStop?.groupSignalled, false, "no group signal was sent");
  assert.equal(outcome!.qualificationStop?.killEscalated, false, "no KILL escalation happened");
  assert.ok(pid, "the child was spawned");
  assert.equal(alive(pid!), false, "the direct command is gone after the cooperative stop");
  const closed = capture.close();
  assert.equal(closed.faults[0]?.kind, "write");
  assert.equal(closed.qualification?.latched, true);
  assert.ok(existsSync(f.artifact(runId)), "the partial artifact is retained");
  assert.ok(readFileSync(f.artifact(runId)).length >= 8);
});

test("strict durability reports a directory-sync fault instead of treating the publication as durable", t => {
  const f = fixture(t);
  const parts = ["runs", "durable-run", "record.json"];
  const faulted = writeVerifiedOwnedFile(f.stateDir, parts, "{}", 0o600, {
    beforeDirectorySync: () => { throw new Error("injected directory sync fault"); },
  });
  assert.deepEqual(faulted.directorySync, { state: "faulted", reason: "injected directory sync fault" });
  assert.equal(faulted.fileSync, "durable");
  assert.equal(readFileSync(join(f.stateDir, ...parts), "utf8"), "{}", "the file itself was published and is readable");

  const synced = writeVerifiedOwnedFile(f.stateDir, ["runs", "durable-run", "second.json"], "{}", 0o600);
  assert.deepEqual(synced.directorySync, { state: "synced" });
  assert.equal(synced.bytes, 2);
});

// ---------------------------------------------------------------------------
// Acceptance 4: with the mode absent, the two-file capture and the cap are unchanged
// ---------------------------------------------------------------------------

test("with qualification mode absent the two-file capture, its redaction and the 8 MiB cap are unchanged", t => {
  const f = fixture(t);
  const runId = f.run();
  const capture = f.capture(runId, {});
  assert.equal(capture.mode, "streams");
  capture.write("stdout", Buffer.from("before fixture-secret after"));
  capture.write("stderr", Buffer.from("plain stderr"));
  const closed = capture.close();
  assert.equal(closed.qualification, null, "an ordinary capture reports no qualification artifact");
  assert.deepEqual(closed.faults, []);
  const paths = hostRunSupervisorPaths(f.stateDir, runId);
  assert.equal(readFileSync(paths.stdoutPath, "utf8"), "before [REDACTED] after", "the token is still redacted");
  assert.equal(readFileSync(paths.stderrPath, "utf8"), "plain stderr");
  assert.equal(existsSync(paths.qualificationRawPath), false, "no qualification artifact exists");
  assert.deepEqual(capture.truncation(), { stdout: null, stderr: null });

  // The cap is still 8 MiB, with one marker in the stream it truncated.
  const cappedRun = f.run();
  const capped = f.capture(cappedRun, {});
  capped.write("stdout", Buffer.alloc(HOST_RUN_RETAINED_OUTPUT_BYTES + 1_024, 0x78));
  assert.deepEqual(capped.truncation().stdout !== null, true, "the cap is reported as a truncation");
  capped.close();
  const cappedPaths = hostRunSupervisorPaths(f.stateDir, cappedRun);
  const retained = readFileSync(cappedPaths.stdoutPath, "utf8");
  assert.ok(Buffer.byteLength(retained) <= HOST_RUN_RETAINED_OUTPUT_BYTES + 1_024, "the retained stream stays at the cap");
  assert.match(retained, new RegExp(`cap=${HOST_RUN_RETAINED_OUTPUT_BYTES}`));
  assert.equal(existsSync(cappedPaths.qualificationRawPath), false, "a capped ordinary run still writes no qualification artifact");
});
