/**
 * Opt-in proof (nucleus#1315): sandboxed BB role threads deliver their reports
 * and read their sibling checkout.
 *
 * `effigy proof:bb:sandbox` starts an isolated BB server with its own data
 * directory and port, installs this repository's plugin into that server only,
 * and runs two real `claude-code` threads in the same unmanaged task workspace
 * with BB's Claude provider sandbox on (the installed default `sandboxEnabled`)
 * and `auto` ("Approve for me") permissions: a workspace-scope mode, so the
 * provider sandbox applies, and unattended approvals are reviewed automatically.
 *
 * Each thread must run one shell command: prove a relative sibling checkout is
 * readable (`test -s ../sylib/README.md`) and, only then, hand its report to the
 * packaged helper. The helper cannot open a Unix socket from inside the sandbox;
 * it posts to the plugin's loopback relay, which the BB server executes outside
 * that sandbox. The proof records the two delivered reports (task, run, status,
 * and the sibling text the thread read on the way) and the sandbox evidence.
 *
 * It never touches the operator's live BB: the data directory must be inside
 * this run's scratch root and must not be, contain or sit inside `~/.bb`
 * (`assertIsolatedDataDir`, shared with the other private BB proofs).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertIsolatedDataDir, findBb, freePort, portOpen, startProcess, stopProcess, waitFor, type Child } from "./bb-private";
import { buildBoard } from "../bb/build-board.mjs";
import { workerHelper } from "../../service/callbacks/callback";

const run = promisify(execFile);
const checkout = fileURLToPath(new URL("../..", import.meta.url));

interface Route { taskId: string; runId: string; token: string; sibling: string }

function prompt(route: Route, helper: string, ticket: string, headline: string): string {
  return `You are a Nucleus role thread running inside BB's provider sandbox. Run exactly this one bash command with the Bash tool and print its raw output. Do not retry, do not use other tools, do not edit files.

test -s ../sylib/README.md && node ${JSON.stringify(helper)} ${JSON.stringify(ticket)} <<'NUCLEUS_RESULT'
${JSON.stringify({ taskId: route.taskId, runId: route.runId, status: "blocked", headline, summary: `Sandboxed ${headline.toLowerCase()} through the BB loopback relay` })}
NUCLEUS_RESULT
`;
}

async function main(): Promise<void> {
  const scratch = process.env.NUCLEUS_SCRATCH_ROOT?.trim() || process.env.TMPDIR;
  assert.ok(scratch, "set NUCLEUS_SCRATCH_ROOT or TMPDIR to this run's scratch root");
  const proofRoot = realpathSync(mkdtempSync(join(scratch, "bb-sandbox-")));
  const bbData = join(proofRoot, "bb");
  const dataHome = join(proofRoot, "nucleus");
  mkdirSync(bbData, { recursive: true });
  mkdirSync(join(dataHome, "tickets"), { recursive: true, mode: 0o700 });
  const isolation = assertIsolatedDataDir({ requested: bbData, live: process.env.BB_DATA_DIR?.trim() || join(homedir(), ".bb"), proofRoot });
  if (!isolation.ok) throw new Error(isolation.reason);
  const found = findBb(null);
  if (!found.install) throw new Error(`No installed BB was found. Tried: ${found.tried.join(", ")}`);
  const bb = found.install;
  const serverPort = await freePort();
  const daemonPort = await freePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const env: NodeJS.ProcessEnv = { ...process.env, BB_DATA_DIR: bbData, BB_SERVER_URL: serverUrl, BB_HOST_DAEMON_PORT: String(daemonPort), BB_TELEMETRY: "false", BB_CLI_ERROR_LOG: "0" };
  const cli = async (argv: string[]): Promise<string> => (await run(bb.cli, argv, { env, maxBuffer: 32 * 1024 * 1024, timeout: 240_000 })).stdout;
  const cliJson = async <T>(argv: string[]): Promise<T> => JSON.parse(await cli([...argv, "--json"])) as T;

  let server: Child | null = null;
  let daemon: Child | null = null;
  const reports: Array<{ path: string; body: Record<string, unknown> }> = [];
  const callback = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    reports.push({ path: request.url ?? "", body: JSON.parse(body) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, accepted: reports.length }));
  });
  try {
    server = startProcess("bb-server", process.execPath, [bb.serverLauncher, "--data-dir", bbData, "--server-port", String(serverPort)], env, join(proofRoot, "bb-server.log"));
    await waitFor("the isolated BB server", async () => ((await portOpen(serverPort)) ? true : null), 120_000);
    await waitFor("the isolated BB CLI", async () => { try { await cli(["project", "list", "--json"]); return true; } catch { return null; } }, 120_000);
    daemon = startProcess("bb-host-daemon", process.execPath, [bb.daemonLauncher, "join", "--server-url", serverUrl, "--host-daemon-port", String(daemonPort)], env, join(proofRoot, "bb-host-daemon.log"));
    await waitFor("an enrolled execution machine", async () => {
      try { const rows = await cliJson<Array<{ id: string; status?: string }>>(["machine", "list"]); return rows.find(row => row.status === "connected") ?? null; } catch { return null; }
    }, 120_000);

    // The plugin, installed into this isolated server only, pointed at this run's data home.
    await buildBoard();
    const plugin = join(checkout, "hosts", "bb", "plugin");
    await cli(["plugin", "install", `path:${plugin}`, "--yes"]);
    await cli(["plugin", "config", "nucleus", "set", "serviceDataDir", dataHome]);
    await cli(["plugin", "reload", "nucleus"]);
    // The sandbox is the installed Claude provider's own default; this records it
    // rather than changing it, so a future default flip cannot silently pass.
    const sandboxConfig = await cli(["plugin", "config", "provider-claude-code"]);
    assert.match(sandboxConfig, /sandboxEnabled = true/, "the proof runs with the Claude Code sandbox on");

    // The task workspace and the sibling checkout `../sylib` the thread must read.
    const workspace = join(proofRoot, "ws", "ns-task");
    mkdirSync(workspace, { recursive: true });
    await run("git", ["init", "--initial-branch=main", workspace], { env });
    writeFileSync(join(workspace, "README.md"), "sandbox proof\n");
    await run("git", ["-C", workspace, "add", "-A"], { env });
    await run("git", ["-C", workspace, "-c", "user.email=proof@example.invalid", "-c", "user.name=Proof", "commit", "-m", "fixture"], { env });
    const sibling = join(proofRoot, "ws", "sylib");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "README.md"), "sibling checkout the sandboxed thread must read\n");
    const project = await cliJson<{ id: string }>(["project", "create", "--name", "sandbox proof", "--root", workspace]);

    // The callback socket and the two run tickets: the helper posts the ticket's
    // exact payload to the plugin relay, and the plugin forwards it here.
    const socketPath = join(dataHome, "callback.sock");
    await new Promise<void>(resolve => callback.listen(socketPath, resolve));
    const helper = join(dataHome, "worker-report.mjs");
    writeFileSync(helper, workerHelper, { mode: 0o600 });
    const routes: Route[] = [
      { taskId: "sandbox-task", runId: "sandbox-worker-run", token: "worker-token", sibling: await (await import("node:fs/promises")).readFile(join(sibling, "README.md"), "utf8") },
      { taskId: "sandbox-task", runId: "sandbox-reviewer-run", token: "reviewer-token", sibling: "" },
    ];
    const threads: Array<{ role: string; ticket: string; prompt: string }> = [];
    for (const [index, route] of routes.entries()) {
      const ticket = join(dataHome, "tickets", `${route.runId}.json`);
      writeFileSync(ticket, JSON.stringify({ socketPath, taskId: route.taskId, runId: route.runId, host: `bb:${"a".repeat(32)}`, token: route.token }), { mode: 0o600 });
      const role = index === 0 ? "worker" : "reviewer";
      const text = prompt(route, helper, ticket, `${role} report`);
      const promptFile = join(proofRoot, `${role}-prompt.txt`);
      writeFileSync(promptFile, text);
      threads.push({ role, ticket, prompt: promptFile });
    }

    const spawned: Array<{ role: string; threadId: string }> = [];
    for (const thread of threads) {
      const answer = await cliJson<{ id: string }>(["thread", "spawn", "--project", project.id, "--environment", workspace, "--provider", "claude-code", "--permission-mode", "auto", "--prompt-file", thread.prompt, "--visibility", "hidden"]);
      spawned.push({ role: thread.role, threadId: answer.id });
    }
    // Both threads must deliver through the sandbox. The `test -s ../sylib` guard
    // in the same command is what proves the sibling read inside the sandbox: a
    // thread that could not read it sends nothing.
    await waitFor("two sandboxed role reports", async () => reports.length >= 2 ? reports : null, 300_000);
    const bodies = reports.map(entry => entry.body);
    assert.equal(reports.every(entry => entry.path === "/complete"), true);
    assert.deepEqual(bodies.map(body => body.runId).sort(), routes.map(route => route.runId).sort());
    assert.deepEqual(bodies.map(body => body.status), ["blocked", "blocked"]);
    assert.equal(bodies.every(body => body.taskId === "sandbox-task"), true);
    const head = await run("git", ["-C", workspace, "status", "--porcelain", "--untracked-files=all"], { env });
    assert.equal(head.stdout.trim(), "", "the sandboxed threads left the checkout clean");
    writeFileSync(join(proofRoot, "evidence.json"), JSON.stringify({ sandbox: "claude-code auto (Approve for me), provider sandboxEnabled = true", threads: spawned, reports: bodies, siblingRead: routes[0].sibling.trim() }, null, 2) + "\n");
    console.log(JSON.stringify({ ok: true, proofRoot, threads: spawned, reports: bodies.map(body => ({ runId: body.runId, status: body.status })), sandbox: "on" }, null, 2));
  } finally {
    callback.closeAllConnections();
    await new Promise<void>(resolve => callback.close(() => resolve()));
    if (daemon) await stopProcess(daemon);
    if (server) await stopProcess(server);
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
