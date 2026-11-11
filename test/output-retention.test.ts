/**
 * Task 388: bounded QA diagnostics stay honest across the output cap.
 *
 * The executor used to keep only the tail of a long stream and drop its
 * beginning without a word; a QA step then re-split that tail as if its first
 * bytes were the beginning of the output. These cases pin the corrected shape:
 * a bounded beginning and end inside the same stream cap, a marker and byte
 * counts on the physical log and on the step excerpts, no raised budget, no
 * silent cap on the shared output tail, byte safety across chunk and character
 * boundaries, and secret redaction preserved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeHookProgram } from "../core/hooks/hooks";
import { openLiveOutputLog } from "../core/machine/live-output";
import { BoundedStreamRetention, FAILURE_FIRST_RETENTION_NOTE, FailureFirstStreamRetention, boundedHeadTail, classifyFailureFirstLine, headTailWithMarker, streamTruncationMarker, tailWithTruncationMarker, wasTruncated } from "../core/machine/output-retention";
import { PROJECT_QA_STEP_OUTPUT_BYTES, StreamingTapFailures, streamHeadTail, writeQaStepLog } from "../core/qa/project-qa-supervisor";
import { redactHostRunToken } from "../service/callbacks/host-run-endpoint";

const markerPattern = /\[queue: output truncated: observed=(\d+) retained=(\d+) omitted=(\d+)(?: cap=(\d+))?; beginning and end kept\]/;

function markerCounts(text: string): { observed: number; retained: number; omitted: number } {
  const match = markerPattern.exec(text);
  assert.ok(match, `a truncated stream names its counts: ${text.slice(0, 240)}`);
  return { observed: Number(match[1]), retained: Number(match[2]), omitted: Number(match[3]) };
}

function retentionOf(chunks: Buffer[], cap: number, keepEnd = true): { rendered: Buffer; retention: BoundedStreamRetention } {
  const retention = new BoundedStreamRetention(cap, keepEnd);
  for (const chunk of chunks) retention.push(chunk);
  return { rendered: retention.render(), retention };
}

test("a stream inside its cap is retained byte for byte and carries no marker", () => {
  const payload = Buffer.from("first line\nsecond line\n");
  const { rendered, retention } = retentionOf([payload], 4096);
  assert.deepEqual(rendered, payload, "an uncapped stream is unchanged");
  assert.equal(retention.observedBytes, payload.length);
  assert.equal(retention.omittedBytes, 0);
  assert.equal(retention.exceeded, false);
  assert.doesNotMatch(rendered.toString("utf8"), /output truncated/);
});

test("a stream at exactly its cap is still whole", () => {
  const payload = Buffer.alloc(512, 0x61);
  const { rendered, retention } = retentionOf([payload], payload.length);
  assert.deepEqual(rendered, payload, "the cap is inclusive: nothing was dropped");
  assert.equal(retention.omittedBytes, 0);
  assert.equal(retention.exceeded, false);
});

test("a stream past its cap keeps its beginning and end and names what the cap dropped", () => {
  const cap = 4096;
  const payload = Buffer.from(`BEGIN-MARKER\n${"middle line of ordinary output\n".repeat(500)}END-MARKER\n`);
  assert.ok(payload.length > cap, "the fixture is past the cap");
  const { rendered, retention } = retentionOf([payload], cap);
  assert.ok(rendered.length <= cap, `retained bytes stay inside the cap, got ${rendered.length}`);
  const text = rendered.toString("utf8");
  assert.ok(text.startsWith("BEGIN-MARKER"), "the beginning is kept, not only the tail");
  assert.ok(text.trimEnd().endsWith("END-MARKER"), "the end is kept");
  const counts = markerCounts(text);
  assert.equal(counts.observed, payload.length, "the observed count is the whole stream");
  assert.equal(counts.retained + counts.omitted, counts.observed, "retained and omitted account for the stream");
  assert.ok(counts.omitted > 0, "the dropped bytes are stated, never inferred");
  assert.equal(text.split("[queue: output truncated:").length, 2, "one marker, not one per chunk");
  assert.equal(retention.observedBytes, payload.length);
  assert.equal(retention.omittedBytes, counts.omitted);
});

test("chunk boundaries do not move the retained beginning or end", () => {
  const cap = 300;
  const body = Array.from({ length: 400 }, (_, index) => `line-${String(index).padStart(4, "0")}`);
  const payload = Buffer.from(`${body.join("\n")}\n`);
  // One-byte chunks: every possible chunk split, including inside the retained window.
  const { rendered } = retentionOf(Array.from(payload, byte => Buffer.from([byte])), cap);
  const text = rendered.toString("utf8");
  assert.ok(text.startsWith("line-0000"), "the beginning is the stream's first bytes");
  assert.ok(text.trimEnd().endsWith("line-0399"), "the end is the stream's last bytes");
  assert.ok(rendered.length <= cap, `retained bytes stay inside the cap, got ${rendered.length}`);
  markerCounts(text);
});

test("a cut through a multibyte character never yields a replacement character", () => {
  const cap = 202; // an odd cap, so the retained windows end mid-character
  const payload = Buffer.from("🙂".repeat(200));
  const { rendered } = retentionOf(Array.from(payload, byte => Buffer.from([byte])), cap);
  const text = rendered.toString("utf8");
  assert.doesNotMatch(text, /\uFFFD/, "no byte sequence was split into a replacement character");
  assert.ok(rendered.length <= cap, `retained bytes stay inside the cap, got ${rendered.length}`);
  assert.ok(text.includes("🙂"), "multibyte content is still readable");
  markerCounts(text);
});

test("a bounded head and tail excerpt carries the marker inside the existing field bound", () => {
  const cap = 8192;
  const payload = Buffer.from(`${"start of output\n"}${"ordinary diagnostic line\n".repeat(400)}the failing assertion\n`);
  const { rendered, retention } = retentionOf([payload], cap);
  const excerpt = boundedHeadTail(rendered, PROJECT_QA_STEP_OUTPUT_BYTES, { observedBytes: retention.observedBytes, omittedBytes: retention.omittedBytes });
  assert.ok(excerpt.head.startsWith("start of output"), "the head names the beginning");
  assert.match(excerpt.head, /output truncated/, "the head says the stream was cut");
  assert.ok(excerpt.tail.endsWith("the failing assertion\n"), "the tail keeps the late failure");
  assert.match(excerpt.tail, /output truncated/, "the tail says the stream was cut");
  assert.ok(Buffer.byteLength(excerpt.head) <= PROJECT_QA_STEP_OUTPUT_BYTES, "the head stays inside its bound");
  assert.ok(Buffer.byteLength(excerpt.tail) <= PROJECT_QA_STEP_OUTPUT_BYTES, "the tail stays inside its bound");
  const counts = markerCounts(excerpt.tail);
  assert.equal(counts.observed, payload.length);
  assert.equal(counts.retained + counts.omitted, payload.length);
  // The step projection is the same helper the pipeline records.
  assert.deepEqual(streamHeadTail(rendered, PROJECT_QA_STEP_OUTPUT_BYTES,
    { observedBytes: retention.observedBytes, omittedBytes: retention.omittedBytes }), excerpt);
});

test("an uncapped stream's excerpts are unchanged: no marker and no counts", () => {
  const payload = Buffer.from("compiled\n");
  const excerpt = boundedHeadTail(payload, PROJECT_QA_STEP_OUTPUT_BYTES);
  assert.deepEqual(excerpt, { head: "compiled\n", tail: "" });
  assert.equal(wasTruncated(null), false);
});

test("the shared output tail marks its own cut instead of reading as the whole output", () => {
  const detail = `${"earlier stage output\n".repeat(400)}the failing stage said no\n`;
  const tail = tailWithTruncationMarker(detail, 2000);
  assert.ok(tail.length <= 2000, `the bounded tail keeps its bound, got ${tail.length}`);
  assert.match(tail, /^\[queue: output truncated: \d+ earlier characters omitted\]/, "the cut is stated up front");
  assert.ok(tail.trimEnd().endsWith("the failing stage said no"), "the end of the detail is kept");
  assert.equal(tailWithTruncationMarker("short detail", 2000), "short detail", "a detail inside the bound is untouched");
});

test("a redacted secret leaves the truncation evidence intact", () => {
  const cap = 4096;
  const token = "queue-run-token-0123456789";
  const payload = Buffer.from(`${token}\n${"ordinary output line\n".repeat(400)}${token}\nthe real failure\n`);
  const { rendered, retention } = retentionOf([payload], cap);
  const redacted = redactHostRunToken(rendered.toString("utf8"), token);
  assert.doesNotMatch(redacted, new RegExp(token), "the credential never reaches the retained evidence");
  assert.match(redacted, /\[REDACTED\]/, "redaction is recorded where the bytes were removed");
  assert.match(redacted, /output truncated/, "redaction never hides that the stream was cut");
  assert.ok(redacted.trimEnd().endsWith("the real failure"), "the end of the stream survives redaction");
  assert.ok(retention.omittedBytes > 0);
});

test("a real capped stream records its beginning, end, marker and counts", async () => {
  const cap = 2048;
  const payload = `${"BEGIN-NOTICE\n"}${"compile warning that is not the failure\n".repeat(300)}FAILURE-AT-THE-END\n`;
  const outcome = await executeHookProgram({
    root: tmpdir(), executable: process.execPath,
    argv: ["-e", `process.stdout.write(${JSON.stringify(payload)})`],
    stdin: Buffer.alloc(0), timeoutMs: 20_000, maxOutputBytes: cap, overflow: "tail",
    env: {},
  });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdoutExceeded, true);
  assert.ok(outcome.stdout.length <= cap, `the retained stream stays inside the cap, got ${outcome.stdout.length}`);
  const text = outcome.stdout.toString("utf8");
  assert.ok(text.startsWith("BEGIN-NOTICE"), "the beginning of a real stream is retained");
  assert.ok(text.trimEnd().endsWith("FAILURE-AT-THE-END"), "a late failure line is retained");
  const counts = markerCounts(text);
  assert.equal(counts.observed, Buffer.byteLength(payload), "the observed count is the whole stream");
  assert.equal(outcome.stdoutObservedBytes, Buffer.byteLength(payload));
  assert.equal(outcome.stdoutOmittedBytes, counts.omitted);
  assert.ok(counts.omitted > 0);
  assert.equal(outcome.stderr.length, 0, "stdout and stderr stay separate");
  assert.equal(outcome.stderrOmittedBytes, 0);
});

test("a real stream inside its cap is unchanged and carries no marker", async () => {
  const outcome = await executeHookProgram({
    root: tmpdir(), executable: process.execPath,
    argv: ["-e", 'process.stdout.write("first\\nsecond\\n"); process.stderr.write("notice\\n")'],
    stdin: Buffer.alloc(0), timeoutMs: 20_000, maxOutputBytes: 4096, overflow: "tail", env: {},
  });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout.toString("utf8"), "first\nsecond\n");
  assert.equal(outcome.stderr.toString("utf8"), "notice\n");
  assert.equal(outcome.stdoutExceeded, false);
  assert.equal(outcome.stdoutOmittedBytes, 0);
});

test("a timed-out step keeps its late stderr text and states the cap", async () => {
  const cap = 1024;
  const noisy = "progress line that pushes past the cap\n".repeat(200);
  const outcome = await executeHookProgram({
    root: tmpdir(), executable: process.execPath,
    argv: ["-e", `process.stderr.write(${JSON.stringify(noisy)}); process.stderr.write("late stderr failure after the cap\\n"); setTimeout(() => {}, 60_000)`],
    stdin: Buffer.alloc(0), timeoutMs: 3_000, maxOutputBytes: cap, overflow: "tail",
    terminationGraceMs: 200, env: {},
  });
  assert.equal(outcome.timedOut, true);
  assert.ok(outcome.stderr.length <= cap, `the retained stderr stays inside the cap, got ${outcome.stderr.length}`);
  const text = outcome.stderr.toString("utf8");
  assert.ok(text.trimEnd().endsWith("late stderr failure after the cap"), "text written after the cap is still the end");
  assert.ok(text.startsWith("progress line"), "the beginning of the stream is retained too");
  const counts = markerCounts(text);
  assert.equal(counts.observed, Buffer.byteLength(noisy) + Buffer.byteLength("late stderr failure after the cap\n"));
  assert.ok(counts.omitted > 0);
  assert.equal(outcome.stderrObservedBytes, counts.observed);
});

test("a hook's output-limit kill keeps its contiguous prefix and invents no marker", async () => {
  const cap = 512;
  const payload = "A".repeat(cap * 3);
  const outcome = await executeHookProgram({
    root: tmpdir(), executable: process.execPath,
    argv: ["-e", `process.stdout.write(${JSON.stringify(payload)}); setTimeout(() => {}, 60_000)`],
    stdin: Buffer.alloc(0), timeoutMs: 10_000, maxOutputBytes: cap, overflow: "terminate",
    terminationGraceMs: 200, env: {},
  });
  assert.equal(outcome.stdoutExceeded, true);
  assert.ok(outcome.stdout.length <= cap, "an output-limit kill never keeps more than the cap");
  assert.doesNotMatch(outcome.stdout.toString("utf8"), /output truncated/,
    "a rejected hook result gains no diagnostic marker: its output is never accepted as a result");
});

test("the step's full-output log holds the marked beginning and end, not a silent tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "nsq-388-log-"));
  try {
    const cap = 2048;
    const payload = `LOG-BEGIN\n${"step output line\n".repeat(300)}LOG-FAILURE\n`;
    const outcome = await executeHookProgram({
      root: tmpdir(), executable: process.execPath,
      argv: ["-e", `process.stdout.write(${JSON.stringify(payload)})`],
      stdin: Buffer.alloc(0), timeoutMs: 20_000, maxOutputBytes: cap, overflow: "tail", env: {},
    });
    const path = join(root, "step.stdout.log");
    const written = writeQaStepLog(path, outcome.stdout);
    assert.equal(written.error, null);
    assert.equal(written.bytes, outcome.stdout.length);
    assert.ok(written.bytes! <= cap, "the log stays inside the step's cap");
    const logged = readFileSync(path, "utf8");
    assert.ok(logged.startsWith("LOG-BEGIN"), "the log keeps the step's beginning");
    assert.ok(logged.trimEnd().endsWith("LOG-FAILURE"), "the log keeps the step's end");
    assert.match(logged, markerPattern, "the log states that it is not the complete output");
    const counts = markerCounts(logged);
    assert.equal(counts.observed, Buffer.byteLength(payload), "the log names the observed byte count");
    assert.ok(counts.retained < counts.observed, "the log never claims to retain the whole stream");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a durable finding keeps a bounded beginning and end around the marker", () => {
  const text = `VALIDATION-BEGIN\n${"compile noise\n".repeat(1200)}VALIDATION-END\n`;
  const finding = headTailWithMarker(text, 2000, { observedBytes: 40_000, omittedBytes: 35_000 });
  assert.ok(finding.length <= 2000, `the finding keeps its character bound, got ${finding.length}`);
  assert.ok(finding.startsWith("VALIDATION-BEGIN"), "the beginning reaches the only durable finding");
  assert.ok(finding.endsWith("VALIDATION-END\n"), "the end is kept too");
  const counts = markerCounts(finding);
  assert.equal(counts.observed, 40_000);
  assert.ok(counts.omitted > 0, "the finding says the cap dropped bytes");
  assert.equal(headTailWithMarker("short finding", 2000, { observedBytes: 10, omittedBytes: 10 }), "short finding",
    "text that fits the bound is untouched apart from its stream's own marker");
  // The split must never cut a surrogate pair: the two halves are whole text.
  const emoji = "🙂".repeat(3000);
  const bounded = headTailWithMarker(emoji, 201, { observedBytes: emoji.length, omittedBytes: emoji.length - 100 });
  assert.ok(bounded.length <= 201);
  const [head, rest] = bounded.split("\n[queue: output truncated:");
  const tailText = rest.slice(rest.indexOf("]\n") + 2);
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.doesNotMatch(head, loneSurrogate, "the kept beginning ends on a character boundary");
  assert.doesNotMatch(tailText, loneSurrogate, "the kept end starts on a character boundary");
});

test("a truncated marker's counts are exact for one line and independent of the stream's shape", () => {
  assert.equal(streamTruncationMarker({ observedBytes: 10, omittedBytes: 0 }),
    "[queue: output truncated: observed=10 retained=10 omitted=0; beginning and end kept]");
  assert.equal(streamTruncationMarker({ observedBytes: 100, omittedBytes: 40 }, 64),
    "[queue: output truncated: observed=100 retained=60 omitted=40 cap=64; beginning and end kept]");
  assert.equal(streamTruncationMarker({ observedBytes: 100, omittedBytes: 40 }, 64, FAILURE_FIRST_RETENTION_NOTE),
    "[queue: output truncated: observed=100 retained=60 omitted=40 cap=64; passing output trimmed first]");
});

/**
 * Task 590: a capped milestone QA step trims passing output before failure
 * lines, so the retained log keeps what failed instead of whichever passing
 * output surrounded it. Unknown lines are never passing: an unrecognized
 * format degrades to head-and-tail rather than dropping lines it cannot name.
 */
function failureFirstOf(chunks: Buffer[], cap: number): { rendered: Buffer; retention: FailureFirstStreamRetention } {
  const retention = new FailureFirstStreamRetention(cap);
  for (const chunk of chunks) retention.push(chunk);
  return { rendered: retention.render(), retention };
}

const failureCountsPattern = /\[queue: output truncated: observed=(\d+) retained=(\d+) omitted=(\d+)(?: cap=(\d+))?; ([^\]]+)\]/;

function failureFirstCounts(text: string): { observed: number; retained: number; omitted: number; shape: string } {
  const match = failureCountsPattern.exec(text);
  assert.ok(match, `a trimmed stream names its counts and shape: ${text.slice(0, 240)}`);
  return { observed: Number(match[1]), retained: Number(match[2]), omitted: Number(match[3]), shape: match[5]! };
}

test("a fitting failure-first stream is returned byte-identical", () => {
  const payload = Buffer.from("TAP version 13\nok 1 - first\nnot ok 2 - second\n  error: boom\n");
  const { rendered, retention } = failureFirstOf([payload], 4096);
  assert.deepEqual(rendered, payload, "nothing trimmed, nothing reordered");
  assert.equal(retention.omittedBytes, 0);
  assert.equal(retention.exceeded, false);
});

test("failure-first trimming keeps the failure and the framing, not the passing middle", () => {
  const cap = 2048;
  const lines = ["EFFIGY header line\n", "TAP version 13\n"];
  lines.push("not ok 1 - the early failure\n", "  error: the thing that broke\n");
  for (let id = 2; id <= 140; id++) lines.push(`ok ${id} - passing test ${id} with padding xxxxxxxxxxxxxxxxxxxxxxxxxxxx\n`);
  lines.push("1..140\n", "# tests 140\n", "# fail 1\n");
  const payload = Buffer.from(lines.join(""));
  assert.ok(payload.length > cap * 2, `the fixture must exceed the cap (got ${payload.length})`);
  const { rendered, retention } = failureFirstOf([payload], cap);
  assert.ok(rendered.length <= cap, `retained bytes stay inside the cap, got ${rendered.length}`);
  const text = rendered.toString("utf8");
  assert.ok(text.includes("not ok 1 - the early failure"), "the early failure survives the passing flood");
  assert.ok(text.includes("error: the thing that broke"), "failure diagnostics survive");
  assert.ok(text.includes("EFFIGY header line"), "the framing head survives");
  assert.ok(text.includes("# fail 1"), "the summary tail survives");
  assert.ok(!text.includes("passing test 30"), "passing middle lines are trimmed first");
  const counts = failureFirstCounts(text);
  assert.match(counts.shape, /passing output trimmed first/, "the marker names the trimming shape");
  assert.equal(counts.observed, payload.length);
  assert.ok(counts.omitted > 0, "the marker says the cap dropped bytes");
  assert.equal(counts.observed - counts.omitted, counts.retained);
});

test("spec failure sections are protected while spec progress is trimmed", () => {
  const cap = 1024;
  const lines = ["\u2714 first passes (0.4ms)\n", "\u2716 second fails badly (0.7ms)\n"];
  for (let id = 0; id < 60; id++) lines.push(`\u2714 passing test ${id} (0.1ms)\n`);
  lines.push("\u2139 tests 62\n", "\u2139 fail 1\n", "\n", "\u2716 failing tests:\n", "\n");
  lines.push("\u2716 second fails badly (0.7ms)\n", "  AssertionError: boom\n");
  const payload = Buffer.from(lines.join(""));
  assert.ok(payload.length > cap, "the fixture must exceed the cap");
  const { rendered } = failureFirstOf([payload], cap);
  const text = rendered.toString("utf8");
  assert.ok(text.includes("AssertionError: boom"), "spec failure diagnostics survive");
  assert.ok(text.includes("\u2139 fail 1"), "the spec summary survives");
});

test("chunks split mid-line and mid-character still classify whole lines", () => {
  const cap = 512;
  const payload = Buffer.from("ok 1 - caf\u00e9 pass\nnot ok 2 - caf\u00e9 fail\n  error: boom\nok 3 - tail\n");
  const retention = new FailureFirstStreamRetention(cap);
  for (let at = 0; at < payload.length; at += 3) retention.push(payload.subarray(at, at + 3));
  const text = retention.render().toString("utf8");
  assert.ok(text.includes("not ok 2 - caf\u00e9 fail"), "a split failure line is kept whole");
});

test("an unterminated line cannot hold more than the cap in memory", () => {
  const cap = 2048;
  const retention = new FailureFirstStreamRetention(cap);
  const chunk = Buffer.alloc(512, 0x78);
  for (let at = 1; at <= 40; at++) {
    retention.push(chunk);
    assert.ok(retention.pendingBytes <= cap, `the unterminated line held ${retention.pendingBytes} bytes after push ${at}`);
  }
  assert.equal(retention.observedBytes, 40 * 512, "every byte is still accounted for");
  assert.ok(retention.exceeded, "the cap was exceeded and must be reported");
  const rendered = retention.render();
  assert.ok(rendered.length <= cap, `rendered bytes stay inside the cap, got ${rendered.length}`);
  const text = rendered.toString("utf8");
  const markerEnd = text.indexOf("\n") + 1;
  const kept = rendered.length - Buffer.byteLength(text.slice(0, markerEnd));
  assert.equal(retention.omittedBytes, retention.observedBytes - kept,
    "the marker's omitted count covers every un-retained byte");
});

test("a large stream of short ordinary lines trims its tail without quadratic shifts", () => {
  const retention = new FailureFirstStreamRetention(64 * 1024);
  const line = Buffer.from("unclassified diagnostic output\n");
  const started = Date.now();
  for (let index = 0; index < 50_000; index++) retention.push(line);
  const rendered = retention.render();
  assert.ok(Date.now() - started < 3_000, "short-line tail eviction stays bounded as line count grows");
  assert.ok(rendered.length <= 64 * 1024);
  assert.equal(retention.observedBytes, line.length * 50_000);
  assert.ok(retention.omittedBytes > 0);
});

test("a draining QA stream with split redaction and a final partial line settles within the bound", async t => {
  const root = mkdtempSync(join(tmpdir(), "nsq-qa-stream-drain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const token = "host-run-token-0123456789-abcdefghijklmnopqrstuvwxyz";
  const passing = Array.from({ length: 5_595 }, (_, index) =>
    `ok ${index + 1} - ordinary diagnostic output with padding ${"x".repeat(10)}\n`).join("");
  const output = `TAP version 13\n${passing}not ok 5596 - ${token}\n  error: final unterminated diagnostic`;
  const script = [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', () => { for (let at = 0; at < input.length; at += 997) process.stdout.write(input.slice(at, at + 997)); });",
  ].join("\n");
  const live = openLiveOutputLog(join(root, "live.log"), token)!;
  t.after(() => live.close());
  const failures = new StreamingTapFailures(token);
  const started = Date.now();
  const outcome = await executeHookProgram({
    root: tmpdir(), executable: process.execPath, argv: ["-e", script], stdin: Buffer.from(output),
    timeoutMs: 30_000, maxOutputBytes: 64 * 1024, overflow: "tail", trimPassingFirst: true,
    settleOnProcessGroup: true, terminationGraceMs: 100, env: { PATH: process.env.PATH ?? "" },
    onOutput: (_stream, chunk) => {
      // Model fragmented pipe reads so both streaming redactors carry a token
      // that crosses chunk boundaries while the child exits and the pipes drain.
      for (let at = 0; at < chunk.length; at += 17) {
        const piece = chunk.subarray(at, at + 17);
        failures.push(piece);
        live.write(piece);
      }
    },
  });
  live.close();
  const failureLog = failures.result();
  const liveText = readFileSync(join(root, "live.log"), "utf8");
  assert.equal(outcome.code, 0);
  assert.equal(outcome.processGroupEmpty, true, "exit-while-draining still proves the child group empty");
  assert.equal(outcome.stdoutObservedBytes, Buffer.byteLength(output), "every child byte is drained");
  assert.ok(Date.now() - started < 10_000, "the evidence-shaped stream completes in bounded time");
  assert.ok(failureLog?.includes("not ok 5596"), "the streamed TAP failure survives the passing flood");
  assert.ok(failureLog?.includes("final unterminated diagnostic"), "the final partial line is flushed");
  assert.ok(!failureLog?.includes(token) && !liveText.includes(token), "redaction carry keeps the token out of both records");
  assert.ok(liveText.endsWith("final unterminated diagnostic"), "the live output log flushes its final partial bytes");
});

test("one chunk larger than the cap without a newline is also held only in cap-sized pieces", () => {
  const retention = new FailureFirstStreamRetention(2048);
  retention.push(Buffer.alloc(8192, 0x79));
  assert.ok(retention.pendingBytes <= 2048, `a single huge chunk held ${retention.pendingBytes} bytes`);
  const rendered = retention.render();
  assert.ok(rendered.length <= 2048, `rendered bytes stay inside the cap, got ${rendered.length}`);
  assert.equal(retention.observedBytes, 8192);
  assert.ok(retention.omittedBytes > 0);
});

test("a fitting stream without newlines is still returned byte-identical", () => {
  const payload = Buffer.from("x".repeat(1500));
  const retention = new FailureFirstStreamRetention(4096);
  for (let at = 0; at < payload.length; at += 100) retention.push(payload.subarray(at, at + 100));
  assert.deepEqual(retention.render(), payload, "no newline, no trimming, no reordering");
  assert.equal(retention.omittedBytes, 0);
});

test("an unterminated line's continuation pieces keep the opener's classification", () => {
  const cap = 2048;
  const bytes = Buffer.from(`ok 1 - verbose ${"z".repeat(6000)}\n`);
  const retention = new FailureFirstStreamRetention(cap);
  for (let at = 0; at < bytes.length; at += 512) {
    retention.push(bytes.subarray(at, at + 512));
    assert.ok(retention.pendingBytes <= cap, `the unterminated line held ${retention.pendingBytes} bytes`);
  }
  retention.push(Buffer.from("not ok 2 - real failure\n  error: boom\n"));
  const text = retention.render().toString("utf8");
  const counts = failureFirstCounts(text);
  assert.match(counts.shape, /^passing output trimmed first$/,
    `mid-line pieces trim as passing, not as re-classified other output: ${counts.shape}`);
  assert.ok(text.includes("not ok 2 - real failure"), "the later real failure survives");
  assert.ok(text.includes("error: boom"), "its diagnostics survive");
});

test("stored lines are copies, not views of the caller's chunk", () => {
  const retention = new FailureFirstStreamRetention(4096);
  const chunk = Buffer.from("not ok 1 - failure\n  error: boom\nok 2 - pass\n");
  retention.push(chunk);
  chunk.fill(0x78); // the caller reuses its buffer once the chunk is delivered
  const text = retention.render().toString("utf8");
  assert.match(text, /not ok 1 - failure/, "a pooled line survives the caller's buffer reuse");
  assert.match(text, /error: boom/, "its diagnostics survive the reuse");
  assert.doesNotMatch(text, /xx/, "no stored byte reads through the caller's buffer");
});

test("the pending partial line is a copy, not a view of the caller's chunk", () => {
  const retention = new FailureFirstStreamRetention(4096);
  const first = Buffer.from("not ok 1 - ");
  retention.push(first);
  first.fill(0x78); // the caller reuses its buffer before the line completes
  retention.push(Buffer.from("boom\n"));
  const text = retention.render().toString("utf8");
  assert.match(text, /not ok 1 - boom/, "the partial line keeps the bytes it was given");
  assert.doesNotMatch(text, /xx/, "no pending byte reads through the caller's buffer");
});

test("the classifier keeps unknown output and never mistakes it for passing", () => {
  assert.deepEqual(classifyFailureFirstLine("not ok 3 - bad", "normal").kind, "failure");
  assert.deepEqual(classifyFailureFirstLine("  error: boom", "failure").kind, "failure");
  assert.deepEqual(classifyFailureFirstLine("ok 1 - good", "normal").kind, "passing");
  assert.deepEqual(classifyFailureFirstLine("  duration_ms: 3", "passing").kind, "passing");
  assert.deepEqual(classifyFailureFirstLine("\u2716 name (0.1ms)", "normal").kind, "failure");
  assert.deepEqual(classifyFailureFirstLine("\u2714 name (0.1ms)", "normal").kind, "passing");
  assert.deepEqual(classifyFailureFirstLine("\u2716 failing tests:", "normal").kind, "other");
  assert.deepEqual(classifyFailureFirstLine("error TS2322: fixture type error", "normal").kind, "other");
  assert.deepEqual(classifyFailureFirstLine("smoke test output", "normal").kind, "other");
  assert.deepEqual(classifyFailureFirstLine("# fail 1", "failure").kind, "other");
});

test("a QA stage executor trims passing output before failure diagnostics", async () => {
  const script = [
    "console.log('TAP version 13');",
    "console.log('not ok 1 - the early failure');",
    "console.log('  error: the thing that broke');",
    "for (let id = 2; id <= 400; id++) console.log(`ok ${id} - passing test ${id} with padding xxxxxxxxxxxxxxxxxxxx`);",
    "console.log('1..400'); console.log('# tests 400'); console.log('# fail 1');",
  ].join("\n");
  const outcome = await executeHookProgram({ root: process.cwd(), executable: process.execPath, argv: ["-e", script],
    stdin: Buffer.alloc(0), timeoutMs: 30_000, maxOutputBytes: 2048, overflow: "tail", trimPassingFirst: true,
    env: { PATH: process.env.PATH ?? "" } });
  assert.equal(outcome.code, 0);
  const text = outcome.stdout.toString("utf8");
  assert.ok(outcome.stdout.length <= 2048, `the stream stays inside its cap, got ${outcome.stdout.length}`);
  assert.ok(text.includes("not ok 1 - the early failure"), "the failure survives its passing flood");
  assert.ok(text.includes("error: the thing that broke"), "failure diagnostics survive");
  assert.ok(text.includes("# fail 1"), "the summary survives");
  const counts = failureFirstCounts(text);
  assert.match(counts.shape, /passing output trimmed first/);
  assert.equal(counts.observed, outcome.stdoutObservedBytes);
  assert.equal(outcome.stdoutOmittedBytes, counts.observed - counts.retained);
  assert.ok((outcome.stdoutOmittedBytes ?? 0) > 0, "the executor reports the trimmed bytes");
});

test("step excerpts can name the failure-first shape", () => {
  const buffer = Buffer.from("not ok 1 - bad\n");
  const truncated = boundedHeadTail(buffer, 4, { observedBytes: 100, omittedBytes: 90 }, FAILURE_FIRST_RETENTION_NOTE);
  assert.match(truncated.head, /passing output trimmed first/);
  const plain = boundedHeadTail(buffer, 4, { observedBytes: 100, omittedBytes: 90 });
  assert.match(plain.head, /beginning and end kept/);
});
