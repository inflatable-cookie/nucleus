import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { workerHelper } from "../service/callbacks/callback";
import { retainedCallbackSentence } from "../core/dispatch/retained-callback";

const BB_HOST = `bb:${"0".repeat(32)}`;

/** The NUCLEUS_* assignments a continuation sentence names, unquoted. */
function assignments(sentence: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const match of sentence.matchAll(/(NUCLEUS_[A-Z_]+)='((?:[^']|'\\'')*)'/g))
    env[match[1]!] = match[2]!.replaceAll("'\\''", "'");
  return env;
}

test("a continuation on a host without per-thread environment names the run's own callback", () => {
  const helperPath = "/synthetic/bb/worker-report.mjs";
  const sentence = retainedCallbackSentence({
    run: { id: "run-bb" },
    helperPath,
    perThreadEnvironment: false,
  });
  assert.deepEqual(assignments(sentence), {
    NUCLEUS_HELPER: helperPath,
    NUCLEUS_CONTINUATION_RUN_ID: "run-bb",
    NUCLEUS_CONTINUATION_TICKET: "/synthetic/bb/tickets/run-bb.json",
  });
  assert.match(sentence, /nucleus helper report\. Feed the actual result JSON on stdin; never print the ticket\.$/);
  assert.equal(
    retainedCallbackSentence({ run: { id: "run-bb" }, helperPath, perThreadEnvironment: true }),
    "",
    "a host that injects the environment keeps its continuation text",
  );
  assert.equal(
    retainedCallbackSentence({ run: { id: "run-bb" }, helperPath: undefined, perThreadEnvironment: false }),
    "",
  );
});

test("the named callback reports for the run after the shell has lost its environment", async (t) => {
  // A plugin roll or a reset shell keeps no NUCLEUS_* values. The sentence's own
  // command is the only handle left, and it must still reach the authenticated run.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ns-retained-cb-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = join(dir, "worker-report.mjs");
  mkdirSync(join(dir, "tickets"));
  const received: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ path: request.url ?? "", body: JSON.parse(body) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, receipt: "relayed" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(helper, workerHelper);
  const ticket = join(dir, "tickets", "run-bb.json");
  writeFileSync(
    ticket,
    JSON.stringify({
      socketPath: join(dir, "absent.sock"),
      taskId: "task-bb",
      runId: "run-bb",
      host: BB_HOST,
      token: "bb-secret",
    }),
    { mode: 0o600 },
  );
  const sentence = retainedCallbackSentence({ run: { id: "run-bb" }, helperPath: helper, perThreadEnvironment: false });
  const run = (env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      // Only the sentence's assignments and the relay location reach the helper; nothing inherited.
      const child = spawn(
        process.execPath,
        [new URL("../bin/nucleus.mjs", import.meta.url).pathname, "helper", "report"],
        { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: dir, BB_SERVER_URL: base, ...env } },
      );
      let out = "", err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out, err }));
      child.stdin.end(JSON.stringify({ status: "blocked", summary: "Retained report" }));
    });

  const bare = await run({ NUCLEUS_HELPER: helper });
  assert.notEqual(bare.code, 0);
  assert.match(bare.err, /Missing Nucleus callback environment/, "the bare shell is the observed refusal");
  assert.equal(received.length, 0);

  const named = await run(assignments(sentence));
  assert.equal(named.code, 0, named.err);
  assert.deepEqual(JSON.parse(named.out), { ok: true, receipt: "relayed" });
  assert.equal(received.length, 1);
  assert.equal(received[0]!.path, "/api/v1/plugins/nucleus/http/report");
  assert.equal(received[0]!.body.route, "/complete");
  assert.equal(received[0]!.body.taskId, "task-bb");
  assert.equal(received[0]!.body.runId, "run-bb");
  assert.equal(received[0]!.body.token, "bb-secret");
});
