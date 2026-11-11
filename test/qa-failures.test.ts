/**
 * Task 191: the milestone QA failures log keeps every `not ok` block with its
 * diagnostics plus the TAP summary apart from the output byte caps, and the
 * pipeline reaps only its own QA-worktree escapees by pid plus start identity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_QA_FAILURES_BYTES,
  StreamingTapFailures,
  detachedSupervisorIo,
  escapeeRootedInWorktree,
  qaSupervisionPlanSchema,
  reapQaWorktreeEscapees,
} from "../core/qa/project-qa-supervisor";

const buf = (text: string): Buffer => Buffer.from(text);

test("a passing TAP run extracts no failures log", () => {
  const stdout = buf(`TAP version 13\nok 1 - first\nok 2 - second\n1..2\n# tests 2\n# pass 2\n# fail 0\n`);
  assert.equal(extractTapFailures(stdout, buf("")), null);
});

test("TAP TODO failures are not counted or retained as failures", () => {
  const collector = new StreamingTapFailures();
  collector.push("TAP version 13\nnot ok 1 - planned test # TODO not implemented\n  ---\n  error: expected later\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 0\n# skipped 0\n# todo 1\n");
  assert.equal(collector.result(), null);
  assert.equal(collector.index(), null);
});

test("every not ok block keeps its diagnostics plus the summary", () => {
  const stdout = buf([
    "TAP version 13",
    "ok 1 - first",
    "not ok 2 - second",
    "  ---",
    "  duration_ms: 12",
    "  failureType: 'testCodeFailure'",
    "  error: |-",
    "    Expected values to be strictly equal",
    "  ...",
    "ok 3 - third",
    "not ok 4 - fourth",
    "  error: boom",
    "1..4",
    "# tests 4",
    "# pass 2",
    "# fail 2",
    "",
  ].join("\n"));
  const failures = extractTapFailures(stdout, buf(""));
  assert.ok(failures, "a failing run must produce a failures log");
  assert.ok(failures.includes("not ok 2 - second"), "every not ok block is kept");
  assert.ok(failures.includes("failureType: 'testCodeFailure'"), "diagnostics stay with their block");
  assert.ok(failures.includes("not ok 4 - fourth"), "a later failure is kept too");
  assert.ok(failures.includes("error: boom"), "short diagnostics are kept");
  assert.ok(failures.includes("# fail 2"), "the summary survives");
  assert.ok(!failures.includes("ok 1 - first"), "passing tests are not repeated");
});

test("a failing summary alone is kept when the blocks scrolled out of the cap", () => {
  const stdout = buf(`1..1683\n# tests 1683\n# pass 1682\n# fail 1\n`);
  const failures = extractTapFailures(stdout, buf(""));
  assert.ok(failures?.includes("# fail 1"), "the summary alone still names the failure");
});

test("non-TAP output such as a compile error extracts nothing", () => {
  const stdout = buf(`shared/change.ts(1,7): error TS2322: fixture type error\n`);
  assert.equal(extractTapFailures(stdout, buf("")), null);
});

test("failures from stderr are kept and the log is bounded", () => {
  const stderr = buf(`not ok 1 - stderr failure\n  detail: from stderr\n# fail 1\n`);
  const failures = extractTapFailures(buf(""), stderr);
  assert.ok(failures?.includes("not ok 1 - stderr failure"));
  assert.ok((failures?.length ?? 0) <= PROJECT_QA_FAILURES_BYTES);
});

test("an enormous failure list truncates blocks but keeps the summary", () => {
  const block = `not ok 1 - big\n${"  x".repeat(20_000)}\n`;
  const failures = extractTapFailures(buf(block), buf("# fail 1\n"));
  assert.ok(failures, "expected a failures log");
  assert.ok(failures.length <= PROJECT_QA_FAILURES_BYTES + 64, `bounded (got ${failures.length})`);
  assert.ok(failures.includes("# fail 1"), "the summary always survives truncation");
});

test("streaming chunks split mid-line still assemble every failure block", () => {
  const text = [
    "TAP version 13",
    "not ok 7 - split",
    "  failureType: 'testCodeFailure'",
    "  error: |- Eventually visible",
    "ok 8 - fine",
    "1..8",
    "# pass 7",
    "# fail 1",
    "",
  ].join("\n");
  const collector = new StreamingTapFailures();
  for (let at = 0; at < text.length; at += 7) collector.push(Buffer.from(text.slice(at, at + 7)));
  const failures = collector.result();
  assert.ok(failures?.includes("not ok 7 - split"), "a block split across chunks is kept");
  assert.ok(failures?.includes("Eventually visible"), "diagnostics split across chunks are kept");
  assert.ok(failures?.includes("# fail 1"), "the summary survives");
});

test("a huge first diagnostic cannot erase later compact failure and cancellation identities", () => {
  const lines = ["TAP version 13", "not ok 1 - first failure", `  error: ${"x".repeat(40_000)}`];
  for (let id = 2; id <= 35; id++) {
    lines.push(`not ok ${id} - later failure ${id}`, `  location: 'file:///repo/test-${id}.test.ts:${id}:7'`, "  error: later diagnostic");
  }
  lines.push("not ok 36 - cancelled case", "  failureType: 'cancelledByParent'", "1..36", "# tests 36", "# pass 0", "# fail 35", "# cancelled 1", "");
  const text = lines.join("\n");
  const collector = new StreamingTapFailures();
  for (let at = 0; at < text.length; at += 733) collector.push(text.slice(at, at + 733));

  const diagnostics = collector.result();
  const index = collector.index();
  assert.ok(diagnostics, "verbose TAP failures are retained");
  assert.ok(diagnostics.length <= PROJECT_QA_FAILURES_BYTES, "verbose failure output stays capped");
  assert.ok(diagnostics.includes("# fail 35") && diagnostics.includes("# cancelled 1"), "summary counts survive the diagnostic cap");
  assert.ok(index, "a compact index is produced");
  assert.equal(index.failed, 35);
  assert.equal(index.cancelled, 1);
  assert.equal(index.identities.length, 36);
  assert.equal(index.omittedIdentities, 0);
  assert.equal(index.truncated, false);
  assert.equal(index.diagnosticsTruncated, true);
  assert.equal(index.identities.at(-1)?.status, "cancelled");
  assert.equal(index.identities[1].location, "file:///repo/test-2.test.ts:2:7");
  for (let id = 1; id <= 36; id++) assert.ok(index.identities.some(identity => identity.id === id), `identity ${id} survives`);
});

test("long diagnostics retain every case in the log and index", () => {
  const collector = new StreamingTapFailures();
  for (let id = 1; id <= 60; id++) collector.push(`not ok ${id} - case ${id}\n  location: '/test-${id}.ts:1:2'\n  error: ${"x".repeat(2000)}\n`);
  collector.push("# fail 60\n");
  const log = collector.result()!;
  const index = collector.index()!;
  for (let id = 1; id <= 60; id++) {
    assert.ok(log.includes(`case ${id} (/test-${id}.ts:1:2)`));
    assert.equal(index.identities[id - 1].location, `/test-${id}.ts:1:2`);
  }
  assert.equal(index.truncated, false);
  assert.equal(index.diagnosticsTruncated, true);
  assert.match(log, /60 case\(s\) trimmed/);
});

test("trim accounting counts cases truncated before log budgeting", () => {
  const collector = new StreamingTapFailures();
  collector.push(`not ok 1 - long\n  error: ${"x".repeat(9000)}\nnot ok 2 - short\n  error: small\n# fail 2\n`);
  assert.match(collector.result()!, /1 case\(s\) trimmed/);
  assert.equal(collector.index()!.diagnosticsTruncated, true);
  const short = new StreamingTapFailures();
  short.push("not ok 1 - short\n  error: small\n# fail 1\n");
  assert.equal(short.index()!.diagnosticsTruncated, false);
  assert.doesNotMatch(short.result()!, /truncated/);
});

test("the index retains more than the former identity limit", () => {
  const lines = Array.from({ length: 300 }, (_, index) => `not ok ${index + 1} - failure ${index + 1}`);
  lines.push("# fail 300", "# cancelled 0");
  const collector = new StreamingTapFailures();
  collector.push(lines.join("\n"));
  const index = collector.index();
  assert.ok(index);
  assert.equal(index.identities.length, 300);
  assert.equal(index.omittedIdentities, 0);
  assert.equal(index.truncated, false);
  assert.equal(index.identities[0].id, 1);
});

test("task 191 incident shape: streaming keeps the early block the 64KiB tail evicts", () => {
  const lines = ["TAP version 13"];
  lines.push("not ok 2 - the one failure");
  lines.push("  failureType: 'testCodeFailure'");
  lines.push("  error: |- boom");
  for (let index = 3; index <= 1683; index++) lines.push(`ok ${index} - passing test number ${index} with padding xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`);
  lines.push("1..1683", "# tests 1683", "# pass 1682", "# fail 1", "");
  const full = Buffer.from(lines.join("\n"));
  assert.ok(full.length > 64 * 1024, `incident-shaped output must exceed the stage cap (got ${full.length})`);
  // What the executor delivers per chunk: everything, before its bounded retention.
  const streamed = new StreamingTapFailures();
  for (let at = 0; at < full.length; at += 997) streamed.push(full.subarray(at, at + 997));
  const kept = streamed.result();
  assert.ok(kept?.includes("not ok 2 - the one failure"), "streaming keeps the early block");
  assert.ok(kept?.includes("# fail 1"), "streaming keeps the summary");
  // What the retained 64KiB tail alone still names: the summary at best.
  const tailOnly = extractTapFailures(full.subarray(-64 * 1024), Buffer.alloc(0));
  assert.ok(!tailOnly?.includes("not ok 2 - the one failure"), "the tail alone loses the early block");
});

test("a relative script argv naming a file in the checkout proves rooting when cwd is unreadable", t => {
  const checkout = mkdtempSync(join(tmpdir(), "nsq-191-root-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  mkdirSync(join(checkout, "bin"), { recursive: true });
  writeFileSync(join(checkout, "bin", "queue-service.mjs"), "// fixture\n");
  const roots = { checkoutPath: checkout, runRoot: join(checkout, "run") };
  assert.equal(escapeeRootedInWorktree(
    { cwd: null, command: "node bin/queue-service.mjs", argv: ["node", "bin/queue-service.mjs"] }, roots), true);
  assert.equal(escapeeRootedInWorktree(
    { cwd: "/elsewhere", command: "node bin/queue-service.mjs", argv: ["node", "bin/queue-service.mjs"] }, roots), false,
    "a known-outside cwd disproves rooting even when the script name matches");
  assert.equal(escapeeRootedInWorktree(
    { cwd: null, command: "node bin/other.mjs", argv: ["node", "bin/other.mjs"] }, roots), false,
    "a relative script that exists nowhere in the worktree is not rooted");
});

test("the reap kills a relative-argv escapee whose script lives in the checkout", async t => {
  const checkout = mkdtempSync(join(tmpdir(), "nsq-191-reap-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  mkdirSync(join(checkout, "bin"), { recursive: true });
  writeFileSync(join(checkout, "bin", "queue-service.mjs"), "// fixture\n");
  let alive = true;
  const result = await reapQaWorktreeEscapees(
    [{ pid: 301, startIdentity: "301@boot:1" }],
    { checkoutPath: checkout, runRoot: join(checkout, "run") },
    {
      graceMs: 50,
      liveness: () => (alive ? "alive" : "dead"),
      cwd: () => null,
      command: () => "node bin/queue-service.mjs",
      argv: () => ["node", "bin/queue-service.mjs"],
      signal: () => { alive = false; },
      sleep: () => Promise.resolve(),
    },
  );
  assert.deepEqual(result.reaped.map(entry => entry.pid), [301]);
  assert.deepEqual(result.held, []);
});

test("worktree rooting uses cwd or argv, never a bare command name", () => {
  const roots = { checkoutPath: "/qa/checkout", runRoot: "/qa/root" };
  assert.equal(escapeeRootedInWorktree({ cwd: "/qa/checkout/sub", command: "node server.mjs" }, roots), true);
  assert.equal(escapeeRootedInWorktree({ cwd: "/other", command: "node /qa/checkout/bin/queue-service.mjs" }, roots), true);
  assert.equal(escapeeRootedInWorktree({ cwd: "/qa/checkout-evil", command: "node server.mjs" }, roots), false);
  assert.equal(escapeeRootedInWorktree({ cwd: null, command: "node bin/queue-service.mjs" }, roots), false);
  assert.equal(escapeeRootedInWorktree({ cwd: null, command: null }, roots), false);
});

test("the reap kills only live worktree-rooted escapees after proving identity", async () => {
  const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const alive = new Map<number, boolean>([[101, true], [102, true], [103, true], [104, false]]);
  const result = await reapQaWorktreeEscapees(
    [
      { pid: 101, startIdentity: "101@boot:1" },
      { pid: 102, startIdentity: "102@boot:2" },
      { pid: 103, startIdentity: "103@boot:3" },
      { pid: 104, startIdentity: "104@boot:4" },
    ],
    { checkoutPath: "/qa/checkout", runRoot: "/qa/root" },
    {
      graceMs: 50,
      liveness: (pid, identity) => {
        assert.match(identity, new RegExp(`^${pid}@`), "identity is always proven with its pid, never by pattern");
        return alive.get(pid) ? "alive" : "dead";
      },
      cwd: pid => (pid === 101 ? "/qa/checkout/sub" : pid === 102 ? "/other" : null),
      command: pid => (pid === 101 ? "node server.mjs" : pid === 102 ? "node server.mjs" : pid === 103 ? "node /qa/checkout/svc.mjs" : null),
      argv: pid => (pid === 101 ? ["node", "server.mjs"] : pid === 102 ? ["node", "server.mjs"] : pid === 103 ? ["node", "/qa/checkout/svc.mjs"] : null),
      signal: (pid, signal) => {
        signalled.push({ pid, signal });
        if (signal === "SIGTERM") alive.set(pid, false);
      },
      sleep: () => Promise.resolve(),
    },
  );
  assert.deepEqual(result.reaped.map(entry => entry.pid), [101, 103]);
  assert.deepEqual(result.held.map(entry => [entry.pid, entry.reason]), [[102, "outside the QA worktree"]]);
  assert.ok(signalled.every(entry => entry.pid === 101 || entry.pid === 103), "only rooted escapees are signalled");
  assert.ok(!signalled.some(entry => entry.pid === 104), "an already-dead escapee is never signalled");
});

test("an escapee that survives SIGKILL keeps its hold with a reason", async () => {
  const result = await reapQaWorktreeEscapees(
    [{ pid: 201, startIdentity: "201@boot:9" }],
    { checkoutPath: "/qa/checkout", runRoot: "/qa/root" },
    {
      graceMs: 10,
      liveness: () => "alive",
      cwd: () => "/qa/checkout",
      command: () => "node svc.mjs",
      signal: () => { /* the process ignores every signal */ },
      sleep: () => Promise.resolve(),
    },
  );
  assert.deepEqual(result.reaped, []);
  assert.equal(result.held.length, 1);
  assert.match(result.held[0]!.reason, /SIGKILL/);
});

/**
 * Task 590: the spec reporter's trailing `\u2716 failing tests:` section gets
 * the same bounded excerpts and identities as TAP, so a non-TAP milestone
 * failure still lands in failuresLog and failureIndexes.
 */
const specOutput = [
  "\u2714 first passes (0.403083ms)",
  "\u2716 second fails badly (0.706292ms)",
  "\u2714 third passes too (0.152792ms)",
  "\u2714 b passes (0.502625ms)",
  "\u2139 tests 4",
  "\u2139 suites 0",
  "\u2139 pass 3",
  "\u2139 fail 1",
  "\u2139 cancelled 0",
  "\u2139 skipped 0",
  "\u2139 todo 0",
  "\u2139 duration_ms 45.864416",
  "",
  "\u2716 failing tests:",
  "",
  "test at test-a.test.js:4:1",
  "\u2716 second fails badly (0.706292ms)",
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "  ",
  "  1 !== 2",
  "  ",
  "      at TestContext.<anonymous> (/repo/test-a.test.js:4:43)",
  "      at Test.runInAsyncScope (node:async_hooks:214:14)",
  "",
].join("\n");

test("a spec failing-tests section keeps excerpts, counts and one identity per test", () => {
  const failures = extractTapFailures(buf(specOutput), buf(""));
  assert.ok(failures, "a spec failure must produce a failures log");
  assert.ok(failures.includes("\u2716 second fails badly"), "the failing title is kept");
  assert.ok(failures.includes("AssertionError"), "diagnostics stay with their failure");
  assert.ok(failures.includes("\u2139 fail 1"), "the spec summary survives");
  assert.ok(!failures.includes("first passes"), "passing tests are not repeated");
  const collector = new StreamingTapFailures();
  collector.push(specOutput);
  const index = collector.index();
  assert.ok(index, "a compact index is produced");
  assert.equal(index.failed, 1);
  assert.equal(index.cancelled, 0);
  // The inline progress mark and the details entry name the same test: the
  // bare echo is dropped so the index holds one identity, not two.
  assert.equal(index.identities.length, 1);
  assert.equal(index.identities[0].title, "second fails badly (0.706292ms)");
  assert.equal(index.identities[0].status, "failed");
  assert.equal(index.identities[0].location, "/repo/test-a.test.js:4:43");
  assert.equal(index.omittedIdentities, 0);
});

test("spec chunks split mid-line still assemble every failure block", () => {
  const collector = new StreamingTapFailures();
  for (let at = 0; at < specOutput.length; at += 7) collector.push(Buffer.from(specOutput.slice(at, at + 7)));
  const failures = collector.result();
  assert.ok(failures?.includes("\u2716 second fails badly"), "a block split across chunks is kept");
  assert.ok(failures?.includes("AssertionError"), "diagnostics split across chunks are kept");
  assert.ok(failures?.includes("\u2139 fail 1"), "the summary survives");
});

test("a spec summary alone is kept when the details scrolled out of the cap", () => {
  const summary = buf(["\u2139 tests 1683", "\u2139 pass 1682", "\u2139 fail 1", ""].join("\n"));
  const failures = extractTapFailures(summary, buf(""));
  assert.ok(failures?.includes("\u2139 fail 1"), "the summary alone still names the failure");
});

test("spec failures redact the host-run token from the log and the index", () => {
  const token = "host-run-token-abcdef-12345678";
  const output = specOutput.replaceAll("/repo/test-a.test.js", `/repo/${token}/test-a.test.js`);
  const collector = new StreamingTapFailures(token);
  collector.push(output);
  const failures = collector.result();
  const index = collector.index();
  assert.ok(failures?.includes("[REDACTED]/test-a.test.js"));
  assert.ok(!failures?.includes(token), "the verbose log does not expose the token");
  assert.ok(!JSON.stringify(index).includes(token), "the compact index does not expose the token");
});

test("a mixed TAP and spec failure stream keeps both", () => {
  const mixed = [
    "TAP version 13",
    "not ok 1 - tap failure",
    "  error: tap boom",
    ...specOutput.split("\n"),
    "1..5",
    "# tests 5",
    "# fail 2",
    "",
  ].join("\n");
  const failures = extractTapFailures(buf(mixed), buf(""));
  assert.ok(failures?.includes("not ok 1 - tap failure"));
  assert.ok(failures?.includes("\u2716 second fails badly"));
  const collector = new StreamingTapFailures();
  collector.push(mixed);
  assert.equal(collector.index()?.identities.length, 2);
});

test("the supervisor syncs its lazily issued token onto the pipeline run", t => {
  const root = mkdtempSync(join(tmpdir(), "nsq-590-token-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = qaSupervisionPlanSchema.parse({
    schema: "queue.project-qa.plan.v1", schema_version: 1,
    runId: "run-590", key: "key-590", caller: "qa", base: "b".repeat(40), baseBranch: "main",
    startedAt: new Date().toISOString(), startedAtMs: Date.now(),
    checkoutPath: root, registeredPath: root, runRoot: root,
    argv: ["effigy", "qa"], timeoutMs: 60_000, epoch: 1,
    maxOutputBytes: 65_536, terminationGraceMs: 1_000,
    hookTimeoutMs: 60_000, hookMaxOutputBytes: 65_536,
    identityToken: "identity-token-0123456789abcdef", links: [],
    hostRunToken: "already-issued-token-0123456789abcdef",
  });
  const holder: { hostRunToken?: string } = {};
  const io = detachedSupervisorIo(plan, join(root, "supervisor.json"), holder);
  void io.environment?.("project-qa:run-590", root);
  assert.equal(holder.hostRunToken, "already-issued-token-0123456789abcdef",
    "the pipeline run sees the token the supervisor plan carries, so the streaming collector redacts it");
});

/** Feed complete fixture output through the same streaming collector. */
function extractTapFailures(stdout: Buffer, stderr: Buffer): string | null {
  const collector = new StreamingTapFailures();
  collector.push(stdout);
  collector.push(stderr);
  return collector.result();
}

test("overlong failure locations are bounded and marked", () => {
  const collector = new StreamingTapFailures();
  collector.push(`not ok 1 - long location\n  location: '${"x".repeat(4001)}'\n# fail 1\n`);
  const identity = collector.index()!.identities[0];
  assert.equal(identity.location?.length, 4000);
  assert.equal(identity.locationTrimmed, true);
});
