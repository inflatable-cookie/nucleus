/**
 * Opt-in proof (nucleus#1315): a BB role thread reports, validates and reads its
 * sibling checkout.
 *
 * `effigy proof:bb:sandbox` starts an isolated BB server with its own data
 * directory and port, installs this repository's plugin into that server only,
 * and runs two real `claude-code` role threads in one task workspace under BB's
 * Full Access mode — the mode Nucleus now launches a BB role thread in (planner
 * ruling, 2026-11-18), because a sandboxed thread cannot run Effigy at all.
 *
 * What it proves:
 *
 * 1. **The production sibling placement.** The workspace is a real task worktree
 *    under the canonical per-repository root, and the sibling checkout beside it
 *    is made by `WorkspaceProvisioning.ensureSharedSiblingCheckouts` (the same code
 *    a BB launch runs), from the project's sibling repository — never by this
 *    script. A second task on the same repository re-observes it, so the link is
 *    shared rather than per-task.
 * 2. **Reports and validation from the thread.** Each thread's one command proves
 *    the relative sibling read (`test -s ../sylib/README.md`), runs a real Effigy
 *    selector (its foreground guard is what the sandbox blocked), and only then
 *    hands its report to the packaged helper. The helper posts to the plugin's
 *    loopback relay, which forwards to the run's ticket-bound callback socket from
 *    the BB server process.
 *
 * It never touches the operator's live BB: the data directory must be inside this
 * run's scratch root and must not be, contain or sit inside `~/.bb`
 * (`assertIsolatedDataDir`, shared with the other private BB proofs). It also
 * scrubs the live Nucleus admission-hook environment, so the thread's Effigy run
 * never reserves capacity on the operator's service.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertIsolatedDataDir, findBb, freePort, portOpen, startProcess, stopProcess, waitFor, type Child } from "./bb-private";
import { buildBoard } from "../bb/build-board.mjs";
import { workerHelper } from "../../service/callbacks/callback";
import { Store } from "../../core/store/store";
import { submissionSchema } from "../../shared/contracts";
import { git, command } from "../../core/git/index";
import { repoCommonDir, WORKSPACES_DIR } from "../../core/workspaces/workspace-allocation";
import { digest } from "../../core/store/store";
import { WorkspaceProvisioning } from "../../core/workspaces/workspace-provisioning";
import { checkoutRunScratchPlacement, runTemporaryEnvironment } from "../../core/workspaces/run-scratch";
import type { Engine } from "../../core/engine";

const run = promisify(execFile);
const checkout = fileURLToPath(new URL("../..", import.meta.url));
const bbHost = `bb:${"a".repeat(32)}`;

interface Route { taskId: string; runId: string; token: string; role: string }

function prompt(route: Route, helper: string, ticket: string, effigyCheckout: string): string {
  const report = JSON.stringify({ taskId: route.taskId, runId: route.runId, status: "blocked", headline: `${route.role} report`, summary: `BB ${route.role} report after a sibling read and an Effigy run` });
  const effigy = route.role === "worker" ? `( cd ${JSON.stringify(effigyCheckout)} && effigy qa:docs >/dev/null 2>&1 ) && ` : "";
  return `You are a Nucleus role thread running in BB. Run exactly this one bash command with the Bash tool and print its raw output. Do not retry, do not use other tools, do not edit files.

test -s ../sylib/README.md && ${effigy}node ${JSON.stringify(helper)} ${JSON.stringify(ticket)} <<'NUCLEUS_RESULT'
${report}
NUCLEUS_RESULT
`;
}

async function repo(root: string, name: string, files: Record<string, string>): Promise<string> {
  await command("git", ["init", "--bare", "--initial-branch=main", join(root, `${name}.git`)], root);
  await command("git", ["clone", join(root, `${name}.git`), join(root, name)], root);
  const path = join(root, name);
  await git(path, "config", "user.name", "Proof");
  await git(path, "config", "user.email", "proof@example.invalid");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  await git(path, "add", "-A");
  await git(path, "commit", "-m", `fixture ${name}`);
  await git(path, "push", "origin", "main");
  return path;
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
  // The thread's Effigy run must never reserve capacity on the operator's service.
  const env: NodeJS.ProcessEnv = { ...process.env, BB_DATA_DIR: bbData, BB_SERVER_URL: serverUrl, BB_HOST_DAEMON_PORT: String(daemonPort), BB_TELEMETRY: "false", BB_CLI_ERROR_LOG: "0" };
  delete env.EFFIGY_ADMISSION_HOOK;
  delete env.QUEUE_ADMISSION_SOCKET;
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
    const sandboxConfig = await cli(["plugin", "config", "provider-claude-code"]);
    assert.match(sandboxConfig, /sandboxEnabled = true/, "the provider setting stays on; Nucleus's mode is Full Access");

    // Two pushed repositories: the task's own and its sibling, plus the task
    // workspace under the canonical per-repository root.
    const repos = join(proofRoot, "repos");
    mkdirSync(repos, { recursive: true });
    const alpha = await repo(repos, "alpha", { "README.md": "sandbox proof\n" });
    const beta = await repo(repos, "sylib", { "README.md": "sibling checkout the BB role thread must read\n" });
    await git(beta, "fetch", "origin", "main");
    const store = new Store(join(dataHome, "queue.sqlite"));
    try {
      store.upsertProject({ key: "proof", name: "Proof", repositories: [{ origin: "acme/alpha", path: alpha }, { origin: "acme/sylib", path: beta }], primary: { origin: "acme/alpha", path: alpha } });
      const planningCommit = await git(alpha, "rev-parse", "HEAD");
      const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: "Sandbox proof", repoPath: alpha, planningCommit, handoffPath: "handoff.md", originAgentId: "origin", baseBranch: "main" }), bbHost, "handoff", planningCommit);
      const workspaceRoot = join(proofRoot, WORKSPACES_DIR, digest(await repoCommonDir(alpha)));
      const directory = join(workspaceRoot, `ns-${task.id}`);
      mkdirSync(workspaceRoot, { recursive: true });
      await git(alpha, "fetch", "origin", "main");
      await git(alpha, "worktree", "add", "-b", task.branch, directory, planningCommit);
      const running = store.update(task.id, { workspaceId: `bb-worktree-${"a".repeat(40)}`, directory, baseBranch: "main" });
      // The production placement a BB launch runs; this script never makes the link.
      const provisioning = new WorkspaceProvisioning({ store, siblingDataDir: proofRoot, adapter: { vocabulary: { kind: "bb", label: "BB", providers: {} } } } as unknown as Engine);
      await provisioning.ensureSharedSiblingCheckouts(running);
      const shared = join(workspaceRoot, "sylib");
      assert.equal(await git(shared, "rev-parse", "HEAD"), await git(beta, "rev-parse", "refs/remotes/origin/main"), "the shared sibling checkout is the sibling repository's base");
      // A second task on the same repository resolves the same shared checkout.
      const second = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: "Second proof task", repoPath: alpha, planningCommit, handoffPath: "handoff.md", originAgentId: "origin", baseBranch: "main" }), bbHost, "handoff", planningCommit);
      const secondDirectory = join(workspaceRoot, `ns-${second.id}`);
      await git(alpha, "worktree", "add", "-b", second.branch, secondDirectory, planningCommit);
      await provisioning.ensureSharedSiblingCheckouts(store.update(second.id, { workspaceId: `bb-worktree-${"b".repeat(40)}`, directory: secondDirectory, baseBranch: "main" }));
      assert.equal(await git(shared, "rev-parse", "HEAD"), await git(beta, "rev-parse", "refs/remotes/origin/main"), "the second task re-observed the existing shared checkout");
      const sharedPlacement = store.events(second.id).find(event => event.kind === "shared_sibling_checkouts");
      assert.match(sharedPlacement?.detail ?? "", /sylib existing/);

      const project = await cliJson<{ id: string }>(["project", "create", "--name", "sandbox proof", "--root", directory]);
      const socketPath = join(dataHome, "callback.sock");
      await new Promise<void>(resolve => callback.listen(socketPath, resolve));
      const helper = join(dataHome, "worker-report.mjs");
      writeFileSync(helper, workerHelper, { mode: 0o600 });
      const routes: Route[] = [
        { taskId: task.id, runId: "sandbox-worker-run", token: "worker-token", role: "worker" },
        { taskId: task.id, runId: "sandbox-reviewer-run", token: "reviewer-token", role: "reviewer" },
      ];
      // Each run's recorded scratch leaf, created by the very call the BB adapter
      // makes before `run.attach`, owner-only, before either thread exists.
      const scratchPlacement = checkoutRunScratchPlacement({ mount: proofRoot, namespace: "nucleus" });
      const scratch: Array<{ runId: string; role: string; path: string; mode: string; directory: boolean; symlink: boolean; createdBeforeSpawn: boolean }> = [];
      for (const route of routes) {
        store.putRun({ id: route.runId, taskId: task.id, hostId: bbHost, role: route.role === "worker" ? "revision" : "reviewer", generation: 0,
          head: planningCommit, base: planningCommit, agentId: null, workspaceId: directory, profile: null, status: "intent",
          createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false, siblings: [] });
        const recorded = store.run(route.runId)?.temporaryDirectory;
        const environment = runTemporaryEnvironment(route.runId, scratchPlacement, recorded);
        const leaf = lstatSync(environment.TMPDIR);
        assert.ok(leaf.isDirectory() && !leaf.isSymbolicLink(), `run scratch for ${route.runId} is a real directory`);
        assert.equal(leaf.mode & 0o077, 0, `run scratch for ${route.runId} is owner-only`);
        scratch.push({ runId: route.runId, role: route.role, path: environment.TMPDIR, mode: `0${(leaf.mode & 0o777).toString(8)}`, directory: leaf.isDirectory(), symlink: leaf.isSymbolicLink(), createdBeforeSpawn: true });
      }
      const prompts: Array<{ role: string; file: string }> = [];
      for (const route of routes) {
        const ticket = join(dataHome, "tickets", `${route.runId}.json`);
        writeFileSync(ticket, JSON.stringify({ socketPath, taskId: route.taskId, runId: route.runId, host: bbHost, token: route.token }), { mode: 0o600 });
        const file = join(proofRoot, `${route.role}-prompt.txt`);
        writeFileSync(file, prompt(route, helper, ticket, checkout));
        prompts.push({ role: route.role, file });
      }

      const spawned: Array<{ role: string; threadId: string }> = [];
      for (const entry of prompts) {
        const answer = await cliJson<{ id: string }>(["thread", "spawn", "--project", project.id, "--environment", directory, "--provider", "claude-code", "--permission-mode", "full", "--prompt-file", entry.file, "--visibility", "hidden"]);
        spawned.push({ role: entry.role, threadId: answer.id });
      }
      // Each thread's command is gated on the sibling read and (the worker's) an
      // Effigy run, so two delivered reports prove all three steps ran.
      await waitFor("two BB role reports", async () => reports.length >= 2 ? reports : null, 300_000);
      const bodies = reports.map(entry => entry.body);
      assert.equal(reports.every(entry => entry.path === "/complete"), true);
      assert.deepEqual(bodies.map(body => body.runId).sort(), routes.map(route => route.runId).sort());
      assert.deepEqual(bodies.map(body => body.status), ["blocked", "blocked"]);
      assert.equal(bodies.every(body => body.taskId === task.id), true);
      const status = await run("git", ["-C", directory, "status", "--porcelain", "--untracked-files=all"], { env });
      assert.equal(status.stdout.trim(), "", "the role threads left the checkout clean");
      writeFileSync(join(proofRoot, "evidence.json"), JSON.stringify({
        mode: "claude-code Full Access; provider sandboxEnabled remains true",
        threads: spawned,
        reports: bodies,
        sibling: { checkout: shared, head: await git(shared, "rev-parse", "HEAD"), placement: "WorkspaceProvisioning.ensureSharedSiblingCheckouts", secondTaskEvent: sharedPlacement?.detail ?? null },
        effigy: "effigy qa:docs ran inside the worker thread before its report",
        scratch: { placement: "core/workspaces/run-scratch.ts runTemporaryEnvironment (the call service/bb-adapter.ts makes before run.attach)", runs: scratch },
        checkoutStatus: status.stdout.trim(),
      }, null, 2) + "\n");
      console.log(JSON.stringify({ ok: true, proofRoot, threads: spawned, reports: bodies.map(body => ({ runId: body.runId, status: body.status })), scratch: scratch.map(entry => ({ runId: entry.runId, mode: entry.mode })), sibling: shared }, null, 2));
    } finally {
      store.close();
    }
  } finally {
    callback.closeAllConnections();
    await new Promise<void>(resolve => callback.close(() => resolve()));
    if (daemon) await stopProcess(daemon);
    if (server) await stopProcess(server);
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
