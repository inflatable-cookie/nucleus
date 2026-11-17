/**
 * Opt-in proof: Spec 062 phase 7's three mid-task faults on an isolated BB server.
 *
 * Run it with `effigy proof:bb:trial` (optionally `--keep`, `--provider <id>`).
 *
 * The phase's acceptance asks for evidence that a plugin reload mid-task, a BB
 * restart mid-task and a host outage during observation each leave the task
 * uncertain and recovered by observation, never resent and never read as idle. The
 * task-level half of that (the lifecycle record itself) is
 * `test/bb-lifecycle.test.ts`. This is the host-level half, against a real BB
 * release in its own data directory and port, never the operator's live BB:
 *
 * 1. a synthetic task worktree is attached as an unmanaged environment by a worker
 *    thread under a synthetic planner, and the worker is mid-turn when each fault
 *    lands;
 * 2. `bb plugin reload nucleus` replaces the executor connection: the service
 *    accepts the new declaration, the plugin's own operation counters start again,
 *    and an observation after the reload names the same thread and the same
 *    environment with **zero** `threads.spawn` calls — the spawn was adopted, not
 *    resent;
 * 3. a BB server restart on the same data directory does the same: the environment
 *    id survives, one observation reads it back, and nothing is spawned again;
 * 4. an outage (`bb plugin disable nucleus`, so BB is up and its executor is gone)
 *    is not observed: the service has no executor for the identity and the
 *    operation is refused as *not sent*, which is never an idle reading. Enabling
 *    the plugin again reconnects and the same thread is observed once.
 *
 * It refuses the operator's live BB data directory exactly as the phase-0 proof
 * does, and everything it creates lives in one scratch directory under TMPDIR.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { QueueService } from "../../service/transport/server";
import { HostExecutorUnavailableError } from "../../service/host-executor";
import { readServiceInfo } from "../../service/transport/identity";
import { hostIdFromDataDir } from "../../shared/host-operation";
import { assertIsolatedDataDir, findBb, freePort, portOpen, startProcess, stopProcess, waitFor, type Child } from "./bb-private";
import { buildBoard } from "../bb/build-board.mjs";

const run = promisify(execFile);
const checkout = fileURLToPath(new URL("../..", import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const provider = args[args.indexOf("--provider") + 1]?.startsWith("--") === false ? args[args.indexOf("--provider") + 1] : "pi";
  const scratch = process.env.TMPDIR;
  if (!scratch || !existsSync(scratch) || !statSync(scratch).isDirectory()) throw new Error("The run scratch volume is required: set TMPDIR to an existing directory");
  const proofRoot = mkdtempSync(join(realpathSync(scratch), "bb-trial-proof-"));
  const evidence: { steps: Array<{ step: string; ok: boolean; detail: unknown }>; proofRoot: string; [key: string]: unknown } = { steps: [], proofRoot };
  const note = (step: string, ok: boolean, detail: unknown) => {
    evidence.steps.push({ step, ok, detail });
    console.log(`${ok ? "[ok]  " : "[FAIL]"} ${step}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  };

  const home = homedir();
  const liveDataDir = process.env.BB_DATA_DIR?.trim() || join(home, ".bb");
  const bbData = join(proofRoot, "bb-data");
  const isolation = assertIsolatedDataDir({ requested: bbData, live: liveDataDir, proofRoot });
  if (!isolation.ok) {
    console.error(`[refused] ${isolation.reason}`);
    process.exitCode = 2;
    return;
  }
  note("isolation", true, { comparedLiveDataDir: liveDataDir === join(home, ".bb") ? "~/.bb" : "BB_DATA_DIR", isolatedDataDir: "this run's proof root" });

  const found = findBb(null);
  if (!found.install) {
    console.error(`[cannot start] No installed BB was found. Tried: ${found.tried.join(", ")}`);
    process.exitCode = 3;
    return;
  }
  const bb = found.install;
  mkdirSync(bbData, { recursive: true });
  const serverPort = await freePort();
  const daemonPort = await freePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const bbEnv: NodeJS.ProcessEnv = { ...process.env, BB_DATA_DIR: bbData, BB_SERVER_URL: serverUrl, BB_HOST_DAEMON_PORT: String(daemonPort), BB_TELEMETRY: "false", BB_CLI_ERROR_LOG: "0" };
  const cli = async (argv: string[]): Promise<string> => {
    const { stdout } = await run(bb.cli, argv, { env: bbEnv, maxBuffer: 32 * 1024 * 1024, timeout: 300_000 });
    return stdout;
  };
  const cliJson = async <T>(argv: string[]): Promise<T> => JSON.parse(await cli(argv)) as T;

  // A synthetic repository and the worktree a task would own.
  const repository = join(proofRoot, "synthetic-repository");
  const worktree = join(proofRoot, "synthetic-worktree");
  mkdirSync(repository);
  const git = async (argv: string[], cwd = repository) => await run("git", argv, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  await git(["init", "--quiet", "."]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["config", "user.name", "Synthetic fixture"]);
  writeFileSync(join(repository, "fixture.txt"), "Synthetic BB trial fixture\n");
  await git(["add", "fixture.txt"]);
  await git(["commit", "--quiet", "-m", "Synthetic fixture"]);
  await git(["worktree", "add", "--quiet", worktree, "-b", "nucleus-trial"]);

  let server: Child | null = null;
  let daemon: Child | null = null;
  const service = new QueueService({ owner: { dataDir: join(proofRoot, "ns"), timers: false }, fixture: "fake" });
  try {
    // 1. The isolated BB server: its own data directory and port.
    server = startProcess("bb-server", process.execPath, [bb.serverLauncher, "--data-dir", bbData, "--server-port", String(serverPort)], bbEnv, join(proofRoot, "bb-server.log"));
    await waitFor("the isolated BB server", async () => (await portOpen(serverPort)) ? true : null, 120_000);
    await waitFor("the isolated BB CLI", async () => { try { await cli(["project", "list", "--json"]); return true; } catch { return null; } }, 180_000);
    daemon = startProcess("bb-host-daemon", process.execPath, [bb.daemonLauncher, "join", "--server-url", serverUrl, "--host-daemon-port", String(daemonPort)], bbEnv, join(proofRoot, "bb-host-daemon.log"));
    const machine = await waitFor("an enrolled execution machine", async () => {
      try {
        const rows = await cliJson<Array<{ id: string; status?: string }>>(["machine", "list", "--json"]);
        return rows.find(row => row.status === "connected") ?? null;
      } catch { return null; }
    }, 120_000);
    note("isolated-server", true, { dataDir: "this run's proof root", port: serverPort, machine: machine.id });

    // 2. The Nucleus service this plugin connects out to, isolated like everything else.
    await service.start();
    const serviceInfo = readServiceInfo(join(proofRoot, "ns"));
    assert.ok(serviceInfo, "the isolated Nucleus service published its identity");
    const hostId = hostIdFromDataDir(bbData);

    // 3. The real built plugin, installed into this server only.
    const pluginSource = join(checkout, "hosts", "bb", "plugin");
    await buildBoard();
    await cli(["plugin", "build", pluginSource]);
    const packaged = join(proofRoot, "bb-plugin");
    cpSync(join(pluginSource, "dist"), join(packaged, "dist"), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(pluginSource, "package.json"), "utf8"));
    writeFileSync(join(packaged, "package.json"), JSON.stringify({
      ...manifest,
      bb: { ...manifest.bb, server: "./dist/server.js", app: "./dist/app.js" },
    }, null, 2));
    await cli(["plugin", "install", `path:${packaged}`, "--yes"]);
    await cli(["plugin", "config", "nucleus", "set", "serviceDataDir", join(proofRoot, "ns")]);
    await cli(["plugin", "reload", "nucleus"]);
    const first = await waitFor("the plugin's host-executor declaration", async () => service.hostExecutorStatus(hostId), 180_000);
    note("plugin-installed", true, { pluginId: "nucleus", hostId, connectedAt: first.connectedAt });

    const send = async <T>(op: string, input: unknown): Promise<{ value: T; calls: Record<string, number> }> => {
      const outcome = await service.sendHostOperation(hostId, op as never, input);
      return { value: outcome.value as T, calls: outcome.calls };
    };

    // 4. Mint the workspace and attach the task's worktree with a live worker turn.
    interface Workspace { projectId: string; handle: string; spawned: number }
    const workspace = await send<Workspace>("workspace.create", { repositoryRoot: repository, name: "Synthetic trial project" });
    assert.equal(workspace.value.spawned, 0, "the workspace step made zero spawns");
    interface Attached { threadId: string; environmentId: string; pluginMetadata: Record<string, unknown> | null }
    const planner = await send<Attached>("run.attach", {
      projectId: workspace.value.projectId, title: "Synthetic trial planner", environmentPath: repository,
      parentNotifications: "off", providerId: provider,
      prompt: "Synthetic planner fixture. Do not run any tools.", pluginMetadata: { nucleus: { task: "trial", run: "phase-7", role: "planner" } },
    });
    const worker = await send<Attached>("run.attach", {
      projectId: workspace.value.projectId, title: "Synthetic trial worker", environmentPath: worktree,
      parentThreadId: planner.value.threadId, parentNotifications: "off", providerId: provider,
      prompt: "Synthetic worker fixture for the mid-task fault proof. Do not run any tools.",
      pluginMetadata: { nucleus: { task: "trial", run: "phase-7", role: "worker" } },
    });
    assert.ok(worker.value.environmentId, "the worker attach recorded its environment");
    note("mid-task", true, { workerThread: worker.value.threadId, environmentId: worker.value.environmentId, planner: planner.value.threadId });

    // 5. Fault 1, plugin reload mid-task: a new connection, no resend, same thread.
    const beforeReload = await send<{ threadId: string; status: string; environmentId: string | null }>("thread.observe", { threadId: worker.value.threadId });
    await cli(["plugin", "reload", "nucleus"]);
    const reloaded = await waitFor("the re-declared host-executor connection", async () => {
      const status = service.hostExecutorStatus(hostId);
      return status && status.connectedAt !== first.connectedAt ? status : null;
    }, 180_000);
    // The reloaded plugin is a new process: its counters start at zero, so a spawn
    // counter of zero after the observation is the proof nothing was resent.
    const afterReload = await send<{ threadId: string; status: string; environmentId: string | null }>("thread.observe", { threadId: worker.value.threadId });
    assert.equal(afterReload.value.environmentId, worker.value.environmentId, "the reload kept the same environment");
    assert.equal(afterReload.value.threadId, worker.value.threadId);
    assert.equal(afterReload.calls["threads.spawn"] ?? 0, 0, "the reloaded plugin spawned nothing");
    const reloadWalk = await send<{ complete: boolean; rows: Array<{ threadId: string; environmentId: string | null }> }>("thread.inventory", { originPluginId: "nucleus", includeHidden: true });
    assert.equal(reloadWalk.value.rows.filter(row => row.threadId === worker.value.threadId).length, 1, "exactly one thread names the task's worker");
    note("plugin-reload-mid-task", true, {
      previousConnectedAt: first.connectedAt, reconnectedAt: reloaded.connectedAt,
      environmentBefore: beforeReload.value.environmentId, environmentAfter: afterReload.value.environmentId,
      spawnsOnTheNewConnection: afterReload.calls["threads.spawn"] ?? 0, workerThreads: 1, status: afterReload.value.status,
    });

    // 6. Fault 2, BB restart mid-task: same data directory, environment and thread.
    await stopProcess(server);
    server = null;
    await waitFor("the isolated server to go away", async () => (await portOpen(serverPort)) ? null : true, 60_000);
    await waitFor("the executor connection to drop with the server", async () => service.hostExecutorStatus(hostId) ? null : true, 120_000);
    server = startProcess("bb-server", process.execPath, [bb.serverLauncher, "--data-dir", bbData, "--server-port", String(serverPort)], bbEnv, join(proofRoot, "bb-server.restart.log"));
    await waitFor("the restarted isolated BB server", async () => (await portOpen(serverPort)) ? true : null, 180_000);
    await waitFor("the restarted BB CLI", async () => { try { await cli(["project", "list", "--json"]); return true; } catch { return null; } }, 180_000);
    const restarted = await waitFor("the restarted plugin's host-executor connection", async () => {
      const status = service.hostExecutorStatus(hostId);
      return status && status.connectedAt !== reloaded.connectedAt ? status : null;
    }, 240_000);
    const afterRestart = await send<{ threadId: string; status: string; environmentId: string | null }>("thread.observe", { threadId: worker.value.threadId });
    assert.equal(afterRestart.value.environmentId, worker.value.environmentId, "the restart kept the same environment");
    assert.equal(afterRestart.calls["threads.spawn"] ?? 0, 0, "the restarted plugin spawned nothing");
    const environments = await send<{ environments: Array<{ environmentId: string; path: string; managed: boolean }> }>("environment.list", {});
    const surviving = environments.value.environments.find(row => row.environmentId === worker.value.environmentId);
    assert.ok(surviving, "the unmanaged environment is still listed after the restart");
    assert.equal(realpathSync(surviving.path), realpathSync(worktree));
    note("bb-restart-mid-task", true, {
      reconnectedAt: restarted.connectedAt, environmentId: afterRestart.value.environmentId,
      spawnsAfterRestart: afterRestart.calls["threads.spawn"] ?? 0, environmentStillListed: true, status: afterRestart.value.status,
    });

    // 7. Fault 3, a host outage during observation. BB stays up; its executor is
    //    unloaded, which is the outage an observation must not read as idle.
    await cli(["plugin", "disable", "nucleus"]);
    await waitFor("the executor connection to go away", async () => service.hostExecutorStatus(hostId) ? null : true, 180_000);
    let outageRefusal = "";
    try {
      await service.sendHostOperation(hostId, "thread.observe" as never, { threadId: worker.value.threadId });
    } catch (error) {
      outageRefusal = error instanceof HostExecutorUnavailableError ? `${error.name}: ${error.message}` : `${(error as Error).name}: ${(error as Error).message}`;
    }
    assert.match(outageRefusal, /No host executor is connected/, "an observation during the outage is refused as not sent, never answered as idle");
    note("host-outage-during-observation", true, { refusedAs: outageRefusal, bbServerStayedUp: true, observationSent: false });
    await cli(["plugin", "enable", "nucleus"]);
    const back = await waitFor("the re-enabled plugin's host-executor connection", async () => {
      const status = service.hostExecutorStatus(hostId);
      return status && status.connectedAt !== restarted.connectedAt ? status : null;
    }, 240_000);
    const afterOutage = await send<{ threadId: string; status: string; environmentId: string | null }>("thread.observe", { threadId: worker.value.threadId });
    assert.equal(afterOutage.value.environmentId, worker.value.environmentId, "the outage left the same environment to observe");
    assert.equal(afterOutage.calls["threads.spawn"] ?? 0, 0, "recovery by observation spawned nothing");
    note("outage-recovered-by-observation", true, { reconnectedAt: back.connectedAt, environmentId: afterOutage.value.environmentId, spawnsOnRecovery: afterOutage.calls["threads.spawn"] ?? 0 });

    // 8. Teardown: stop the worker's turn, then archive after the cascade read.
    await send("thread.stop", { threadId: worker.value.threadId });
    const workerCascade = await send<{ cascadeThreadIds: string[] }>("thread.cascade", { threadId: worker.value.threadId, action: "archive" });
    assert.deepEqual(workerCascade.value.cascadeThreadIds, [], "nothing depends on the worker thread");
    await send("thread.archive", { threadId: worker.value.threadId, expectedCascadeThreadIds: [] });
    await send("thread.stop", { threadId: planner.value.threadId });
    const plannerCascade = await send<{ cascadeThreadIds: string[] }>("thread.cascade", { threadId: planner.value.threadId, action: "archive" });
    await send("thread.archive", { threadId: planner.value.threadId, expectedCascadeThreadIds: plannerCascade.value.cascadeThreadIds });
    note("teardown-archived", true, { threads: 2, cascadeNamed: workerCascade.value.cascadeThreadIds.length });

    writeFileSync(join(proofRoot, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(`\nEvidence retained in this run's scratch directory (evidence.json, server logs).`);
  } catch (error) {
    evidence.failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    note("proof", false, error instanceof Error ? error.message : String(error));
    writeFileSync(join(proofRoot, "evidence.json"), JSON.stringify(evidence, null, 2));
    process.exitCode = 1;
  } finally {
    await service.stop().catch(() => {});
    if (!args.includes("--keep")) {
      await stopProcess(daemon);
      await stopProcess(server);
    } else {
      console.log(`[keep] BB processes left running: bb-server pid ${server?.child.pid ?? "?"}, host-daemon pid ${daemon?.child.pid ?? "?"}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
