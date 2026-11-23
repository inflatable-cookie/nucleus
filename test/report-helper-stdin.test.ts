import { observeIdle } from "./support/fakes";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCallbacks, workerHelper } from "../service/callbacks/callback";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
import { completionRefusal } from "../core/intake/report-shape";
import type { Completion, Run, Task } from "../shared/contracts";

// Reviewer threads ran `nucleus helper report --help` after a refused report. The
// helper read stdin unconditionally, an agent shell's stdin is a pipe that never
// closes, and the call hung for hours with no output. These run the exact bytes
// the service writes into the data home.

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const CLI = fileURLToPath(new URL("../bin/nucleus.mjs", import.meta.url));

type Outcome = { code: number | null; stdout: string; stderr: string; ms: number };

/**
 * Run a command whose stdin stays open and silent unless `input` is given, like an
 * agent shell's pipe. A run still alive after `killAfterMs` is killed and fails.
 */
function run(
  args: string[],
  { input, env = {}, killAfterMs = 15_000 }: { input?: string; env?: Record<string, string>; killAfterMs?: number } = {},
) {
  return new Promise<Outcome>((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const killer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      if (signal) reject(Error(`still waiting after ${killAfterMs} ms (${signal}); stderr: ${stderr}`));
      else resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function fixtureDir(name: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `ns-${name}-`)));
  const helper = join(dir, "worker-report.mjs");
  writeFileSync(helper, workerHelper);
  return { dir, helper };
}

test("report helper --help prints the report shape and exits without reading stdin", async () => {
  const { dir, helper } = fixtureDir("helper-help");
  try {
    const ticket = join(dir, "ticket.json");
    writeFileSync(ticket, JSON.stringify({ socketPath: join(dir, "s"), token: "fixture-secret", taskId: "t", runId: "r" }));
    // The helper itself, with and without a ticket, and the installed CLI route.
    const helperHelp = await run([helper, ticket, "--help"], { killAfterMs: 5_000 });
    const bareHelp = await run([helper, "-h"], { killAfterMs: 5_000 });
    const cliHelp = await run([CLI, "helper", "report", "--help"], {
      env: { NUCLEUS_HELPER: join(dir, "missing-helper.mjs"), NUCLEUS_TICKET: ticket },
      killAfterMs: 5_000,
    });
    for (const outcome of [helperHelp, bareHelp, cliHelp]) {
      assert.equal(outcome.code, 0, outcome.stderr);
      assert.match(outcome.stdout, /Usage: nucleus helper report/);
      for (const field of ["status", "summary", "head", "prNumber", "reviewText"])
        assert.match(outcome.stdout, new RegExp(`\\b${field}\\b`), `usage names ${field}`);
      assert.match(outcome.stdout, /<<'JSON'/, "usage carries a heredoc example");
      assert.match(outcome.stdout, /"head": "[a-f0-9]{40}"/, "the example uses the full SHA in head");
    }
    // The CLI answers without spawning the helper, so a missing or older one cannot hang it.
    for (const name of ["submit", "reparent", "detach", "review-entry", "bulk-dispose", "subscribe"]) {
      const outcome = await run([CLI, "helper", name, "--help"], { killAfterMs: 10_000 });
      assert.equal(outcome.code, 0, `${name}: ${outcome.stderr}`);
      assert.match(outcome.stdout, new RegExp(`nucleus helper ${name}`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report helper with an open, silent stdin exits within its bound and says how to pipe the report", async () => {
  const { dir, helper } = fixtureDir("helper-silent");
  try {
    const ticket = join(dir, "ticket.json");
    writeFileSync(ticket, JSON.stringify({ socketPath: join(dir, "s"), token: "fixture-secret", taskId: "t", runId: "r" }));
    const outcome = await run([helper, ticket], {
      env: { NUCLEUS_REPORT_STDIN_WAIT_MS: "400" },
      killAfterMs: 8_000,
    });
    assert.notEqual(outcome.code, 0);
    assert.match(outcome.stderr, /Pipe the report JSON on stdin, e\.g\. nucleus helper report <<'JSON'/);
    assert.ok(outcome.ms < 5_000, `exited after ${outcome.ms} ms`);
    // An empty, closed stdin fails at once with the same instruction.
    const empty = await run([helper, ticket], { input: "", killAfterMs: 5_000 });
    assert.notEqual(empty.code, 0);
    assert.match(empty.stderr, /No report JSON arrived on stdin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report helper still sends a heredoc report, and a complete report on a pipe left open", async () => {
  const { dir, helper } = fixtureDir("helper-heredoc");
  const socketPath = join(dir, "s");
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push({ path: req.url, body: JSON.parse(body) });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const ticket = join(dir, "ticket.json");
    writeFileSync(ticket, JSON.stringify({ socketPath, token: "fixture-secret", taskId: "t", runId: "r" }));
    const report = { status: "ready_to_merge", summary: "No findings", head: HEAD, prNumber: 7, reviewText: "None" };
    const heredoc = await new Promise<Outcome>((resolve, reject) => {
        const started = Date.now();
        // The literal agent form: a shell heredoc piped into the helper.
        const child = spawn("/bin/sh", ["-c", `"${process.execPath}" "${helper}" "${ticket}" <<'JSON'\n${JSON.stringify(report)}\nJSON`], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
      });
    assert.equal(heredoc.code, 0, heredoc.stderr);
    assert.deepEqual(JSON.parse(heredoc.stdout), { ok: true });
    assert.equal(bodies[0].path, "/complete");
    assert.equal(bodies[0].body.head, HEAD);
    assert.equal(bodies[0].body.status, "ready_to_merge");

    // A writer that sends a complete object and never closes the pipe is not waited on forever.
    const child = spawn(process.execPath, [helper, ticket], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NUCLEUS_REPORT_STDIN_WAIT_MS: "300" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.write(JSON.stringify({ ...report, summary: "Open pipe" }));
    const killer = setTimeout(() => child.kill("SIGKILL"), 8_000);
    const [code, signal] = await new Promise<[number | null, string | null]>((resolve) =>
      child.on("close", (c, s) => resolve([c, s])),
    );
    clearTimeout(killer);
    assert.equal(signal, null, "the helper finished on its own");
    assert.equal(code, 0, stderr);
    assert.equal(bodies[1].body.summary, "Open pipe");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused report names the expected field and shows the accepted shape", async () => {
  const { dir, helper } = fixtureDir("helper-refusal");
  const socketPath = join(dir, "s");
  const store = new Store(join(dir, "queue.sqlite"));
  const engine = new Engine(store, { observe: observeIdle("ws", "worker") } as unknown as Adapter);
  const stop = await startCallbacks(socketPath, helper, engine);
  try {
    const ticket = join(dir, "ticket.json");
    writeFileSync(ticket, JSON.stringify({ socketPath, token: "fixture-secret", taskId: "t", runId: "r" }));
    // The service rewrote the helper it was given; run those bytes.
    const wrongName = await run([helper, ticket], {
      input: JSON.stringify({ status: "ready_to_merge", summary: "No findings", headSha: HEAD, reviewText: "None" }),
    });
    assert.notEqual(wrongName.code, 0);
    assert.match(wrongName.stderr, /Error: Report refused: headSha is not a report field; use "head"/);
    assert.match(wrongName.stderr, /Expected shape: \{"status":"ready_to_merge"/);
    assert.match(wrongName.stderr, /nucleus helper report --help/);

    const shortHead = await run([helper, ticket], {
      input: JSON.stringify({ status: "ready_to_merge", summary: "No findings", head: "0123abc", reviewText: "None" }),
    });
    assert.notEqual(shortHead.code, 0);
    assert.match(shortHead.stderr, /head must be the full 40-character lowercase commit SHA/);

    const noSummary = await run([helper, ticket], {
      input: JSON.stringify({ status: "ready_to_merge", head: HEAD }),
    });
    assert.notEqual(noSummary.code, 0);
    assert.match(noSummary.stderr, /summary is missing/);
  } finally {
    await engine.stop();
    await stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // A well-formed report without head names the field and the exact value it needs.
  const run_ = { role: "reviewer", head: HEAD } as unknown as Run;
  const missing = completionRefusal(
    { status: "ready_to_merge", summary: "No findings", reviewText: "None" } as Completion,
    run_,
    {} as Task,
    false,
  );
  assert.match(missing ?? "", /requested exact head: the report has no "head" field; add "head": "0123456789abcdef0123456789abcdef01234567"/);
  const other = completionRefusal(
    { status: "ready_to_merge", summary: "No findings", reviewText: "None", head: "f".repeat(40) } as Completion,
    run_,
    {} as Task,
    false,
  );
  assert.match(other ?? "", /"head" is f{40}, and this run is for 0123456789abcdef/);
});
