// Exercise the installed T3 adapter with an isolated store and synthetic threads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, isAbsolute, join } from "node:path";
import { test } from "node:test";

const [app, scratch] = process.argv.slice(2);
assert(app?.endsWith(".app") && isAbsolute(app), "Pass the absolute path to the T3 app bundle");
assert(scratch && isAbsolute(scratch), "Pass an existing scratch directory");

async function loopbackPort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function withT3(root, workspace, run) {
  const port = await loopbackPort();
  const token = randomUUID();
  const contents = join(app, "Contents");
  const child = spawn(join(contents, "MacOS", basename(app, ".app")), [
    join(contents, "Resources/app.asar/apps/server/dist/bin.mjs"),
    "serve", "--base-dir", root, "--host", "127.0.0.1", "--port", String(port),
    "--dev-url", "http://127.0.0.1:1", workspace,
  ], {
    cwd: workspace,
    env: {
      ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH, TMPDIR: root, TMP: root, TEMP: root,
      T3CODE_DEV_AUTH_TOKEN: token, T3CODE_LOG_LEVEL: "Warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  const output = [];
  child.stderr.setEncoding("utf8").on("data", line => output.push(line));
  let ws;
  try {
    const ready = new Promise(resolve => {
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", chunk => {
        stdout += chunk;
        if (stdout.includes("T3 Code server is ready.")) resolve();
      });
    });
    const startup = AbortSignal.timeout(20_000);
    await Promise.race([
      ready,
      exited.then(([code]) => { throw Error(`Fixture server exited during startup (${code})`); }),
      once(startup, "abort").then(() => { throw Error("Fixture server startup timed out"); }),
    ]);
    const rootUrl = `http://127.0.0.1:${port}`;
    const response = await fetch(`${rootUrl}/api/auth/websocket-ticket/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    assert(response.ok, `WebSocket ticket failed with status ${response.status}`);
    const { ticket } = await response.json();
    assert(ticket);
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`);
    await once(ws, "open", { signal: AbortSignal.timeout(5_000) });
    let next = 0;
    await run(async (tag, payload) => {
      const requestId = String(++next);
      const exit = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.removeEventListener("message", receive);
          reject(Error(`Timed out waiting for ${tag}`));
        }, 5_000);
        function receive({ data }) {
          for (const frame of [JSON.parse(data)].flat()) {
            if (frame._tag === "Exit" && frame.requestId === requestId) {
              clearTimeout(timer);
              ws.removeEventListener("message", receive);
              resolve(frame.exit);
            }
          }
        }
        ws.addEventListener("message", receive);
      });
      ws.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
      return exit;
    });
  } catch (error) {
    if (output.length) console.error(output.join("").replaceAll(token, "[fixture token]"));
    throw error;
  } finally {
    ws?.close();
    child.kill();
    const stop = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited.finally(() => clearTimeout(stop));
  }
}

function accepted(exit) {
  assert.equal(exit._tag, "Success", JSON.stringify(exit));
  return exit.value;
}

test("T3 replays accepted hold receipts and still refuses rejected command IDs after restart", async () => {
  const root = await mkdtemp(join(scratch, "t3-receipts-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const projectId = "project:receipt-fixture";
    const threadId = "thread:nucleus-receipt-fixture";
    const modelSelection = { instanceId: "codex", model: "gpt-5.4" };
    const provenance = { createdBy: "user", creationSource: "server" };
    const hold = {
      type: "message.dispatch", commandId: `${threadId}-hold-acp-1:codex`, threadId,
      messageId: "receipt-message", text: "Synthetic parent hold", attachments: [],
      ...provenance, modelSelection,
      // Exercise the same message command without starting any provider.
      dispatchMode: { type: "defer_start" },
    };
    const rejected = { ...hold, commandId: `${threadId}-hold-acp-2:codex`, messageId: "rejected-message" };
    const method = "orchestration.dispatchCommand";
    let receipt;
    await withT3(root, workspace, async call => {
      accepted(await call("projects.mutate", {
        type: "project.create", commandId: "project-setup", projectId, title: "Receipt fixture",
        workspaceRoot: workspace,
      }));
      accepted(await call(method, {
        type: "thread.create", commandId: "thread-setup", threadId, projectId, title: "Receipt fixture",
        modelSelection, runtimeMode: "full-access", interactionMode: "default", branch: null,
        worktreePath: null, ...provenance,
      }));
      receipt = accepted(await call(method, hold));
      assert(Number.isInteger(receipt.sequence));
      const failure = await call(method, { ...rejected, manualContinuationOfRunId: "absent-run" });
      assert.equal(failure._tag, "Failure");
      assert.equal(failure.cause[0].error.commandId, rejected.commandId);
    });
    await withT3(root, workspace, async call => {
      // Both payloads would be valid new sends. Command identity decides the result.
      assert.deepEqual(accepted(await call(method, { ...hold, messageId: "another-message" })), receipt);
      const refusal = await call(method, rejected);
      assert.equal(refusal._tag, "Failure");
      const [reason] = refusal.cause;
      assert.equal(reason._tag, "Fail");
      assert.equal(reason.error._tag, "OrchestrationV2DispatchCommandError");
      assert.equal(reason.error.commandId, rejected.commandId);
      assert.equal(reason.error.commandType, hold.type);
      assert.equal(reason.error.cause.name, "OrchestratorCommandPreviouslyRejectedError");
      assert(reason.error.cause.message.startsWith(`Command ${rejected.commandId} was previously rejected: `));
      accepted(await call(method, { ...rejected, commandId: `${threadId}-hold-acp-3:codex` }));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
