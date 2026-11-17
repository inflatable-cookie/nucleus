/**
 * Opt-in proof: the reverse host-operation channel and the five-step BB lifecycle
 * against an isolated BB server (Spec 062, phase 0).
 *
 * Run it with `effigy proof:bb` (optionally `-- --keep`, `--provider <id>`,
 * `--data-dir <path>`).
 *
 * What it proves, in one run:
 *
 * 1. the scratch BB plugin opens the owner-only Nucleus service socket, authenticates,
 *    declares the `host-executor` role and re-declares after `bb plugin reload` and
 *    after a BB server restart;
 * 2. the host identity the service derives from the BB data directory is re-proved on
 *    every one of those connections;
 * 3. a workspace handle is minted and the project registered with zero
 *    `threads.spawn` calls, read from the plugin's own call counters;
 * 4. a Nucleus-created worktree is attached as an unmanaged environment by a
 *    synthetic worker thread under a synthetic planner with notifications off, and
 *    the same environment ID is read back after the BB restart;
 * 5. the thread is observed, stopped, and archived after its cascade read, leaving
 *    the planner untouched;
 * 6. the terminal-scope question is answered: where a thread-scoped terminal and a
 *    `host_path` terminal actually appear.
 *
 * The synthetic worker runs on the installed provider named by `--provider` (default
 * `pi`); the proof stops that turn as soon as BB records the environment it is
 * provisioning and never reads the turn's outcome, so nothing here depends on a
 * model answering.
 *
 * `--record-interactions` adds an opt-in recording pass (Spec 062, phase 4): it
 * spawns two probe threads on an authenticated provider, lets one raise a native
 * question and the other a plan approval, records the raw SDK rows the plugin read
 * and the resolutions it wrote, and leaves them in the run's scratch root. Unlike
 * the default proof, that pass depends on a provider answering, so it never runs
 * unless it is asked for.
 *
 * It refuses to run against the operator's live BB data directory and reports what
 * it looked for when it cannot find an installed BB. Everything it creates lives in
 * one scratch directory it makes under this run's TMPDIR.
 */
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createServer, connect } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { QueueService } from "../../service/transport/server";
import { readServiceInfo } from "../../service/transport/identity";
import { hostIdFromDataDir, workspaceHandleForPath } from "../../shared/host-operation";

const run = promisify(execFile);
const checkout = fileURLToPath(new URL("../..", import.meta.url));

export interface IsolationInput {
  /** The data directory this run would use. */
  requested: string;
  /** The operator's live BB data directory. */
  live: string;
  /** The scratch root this run owns. */
  proofRoot: string;
}

/** A refusal names the path it compared, with the account home shortened to `~`. */
function displayPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/**
 * Refuse any data directory that is, contains, or sits inside the operator's live BB
 * data directory, and refuse one outside this run's own scratch root. The refusal
 * names both paths it compared, so a reader sees exactly what was tried.
 */
export function assertIsolatedDataDir(input: IsolationInput): { ok: true } | { ok: false; reason: string } {
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const requested = real(input.requested);
  const live = real(input.live);
  const proofRoot = real(input.proofRoot);
  const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
  if (inside(requested, live) || inside(live, requested)) {
    return { ok: false, reason: `refusing to run against the operator's live BB data directory (${displayPath(input.live)}); this proof uses an isolated data directory of its own` };
  }
  if (!inside(requested, proofRoot)) {
    return { ok: false, reason: `refusing a BB data directory outside this run's scratch root (${displayPath(input.requested)} is not inside ${displayPath(input.proofRoot)})` };
  }
  return { ok: true };
}

interface Args {
  provider: string;
  keep: boolean;
  /** Opt-in provider interaction recording (needs an authenticated provider). */
  recordInteractions: boolean;
  recordProvider: string;
  recordModel: string | null;
  /** Only ever used to demonstrate the refusal: the proof runs in its own root. */
  dataDir: string | null;
  bbApp: string | null;
  serverPort: number | null;
  daemonPort: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { provider: "pi", keep: false, recordInteractions: false, recordProvider: "claude-code", recordModel: null, dataDir: null, bbApp: null, serverPort: null, daemonPort: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--keep") args.keep = true;
    else if (arg === "--record-interactions") args.recordInteractions = true;
    else if (arg === "--record-provider") args.recordProvider = argv[++i] ?? args.recordProvider;
    else if (arg === "--record-model") args.recordModel = argv[++i] ?? null;
    else if (arg === "--provider") args.provider = argv[++i] ?? args.provider;
    else if (arg === "--data-dir") args.dataDir = argv[++i] ?? null;
    else if (arg === "--bb-app") args.bbApp = argv[++i] ?? null;
    else if (arg === "--server-port") args.serverPort = Number(argv[++i]);
    else if (arg === "--daemon-port") args.daemonPort = Number(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

export interface BbInstall { cli: string; serverLauncher: string; daemonLauncher: string }

/** Find the installed BB from its own command shim; report every path tried when it is absent. */
export function findBb(override: string | null): { install: BbInstall } | { install: null; tried: string[] } {
  const tried: string[] = [];
  const home = homedir();
  const shim = override ?? [
    join(home, ".bb", "bin", "bb"),
    join(home, ".local", "bin", "bb"),
    "/opt/homebrew/bin/bb",
    "/usr/local/bin/bb",
  ].find(path => existsSync(path)) ?? null;
  if (!shim) return { install: null, tried: [join(home, ".bb", "bin", "bb"), join(home, ".local", "bin", "bb"), "/opt/homebrew/bin/bb", "/usr/local/bin/bb"] };
  tried.push(shim);
  let appDist: string | null = null;
  try {
    const source = readFileSync(shim, "utf8");
    const entry = /^entry='([^']+)'/m.exec(source)?.[1];
    if (entry) appDist = dirname(entry);
  } catch { /* an executable binary shim names no entry; fall back to the app layout */ }
  const candidates = [
    appDist ? join(appDist, "bb-server.js") : null,
    join(dirname(dirname(shim)), "..", "Resources", "app.asar.unpacked", "node_modules", "bb-app", "dist", "bb-server.js"),
  ].filter((path): path is string => typeof path === "string").map(path => resolve(path));
  const serverLauncher = candidates.find(path => existsSync(path));
  tried.push(...candidates);
  if (!serverLauncher) return { install: null, tried };
  const daemonLauncher = join(dirname(serverLauncher), "bb-host-daemon.js");
  tried.push(daemonLauncher);
  if (!existsSync(daemonLauncher)) return { install: null, tried };
  return { install: { cli: shim, serverLauncher, daemonLauncher } };
}

export async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePort(port));
    });
  });
}

export async function portOpen(port: number): Promise<boolean> {
  return await new Promise(resolveOpen => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(500, () => { socket.destroy(); resolveOpen(false); });
    socket.on("connect", () => { socket.destroy(); resolveOpen(true); });
    socket.on("error", () => resolveOpen(false));
  });
}

export async function waitFor<T>(what: string, probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
}

export interface Child { child: ChildProcess; label: string }

export function startProcess(label: string, command: string, argv: string[], env: NodeJS.ProcessEnv, logPath: string): Child {
  const log = openSync(logPath, "a");
  // Detached so this file owns the process group it created: teardown signals that
  // group and nothing else, never a pattern.
  const child = spawn(command, argv, { env, stdio: ["ignore", log, log], detached: true });
  child.unref();
  return { child, label };
}

/** Stop a process this file started, and its own process group. */
export async function stopProcess(entry: Child | null): Promise<void> {
  if (!entry) return;
  const pid = entry.child.pid;
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGTERM"); } catch { try { entry.child.kill("SIGTERM"); } catch { /* already gone */ } }
  const exited = await Promise.race([
    new Promise<boolean>(resolveExit => entry.child.once("exit", () => resolveExit(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    await delay(200);
  }
}

interface Evidence { steps: Array<{ step: string; ok: boolean; detail: unknown }>; [key: string]: unknown }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scratch = process.env.TMPDIR;
  if (!scratch || !existsSync(scratch) || !statSync(scratch).isDirectory()) throw new Error("The run scratch volume is required: set TMPDIR to an existing directory");
  const proofRoot = mkdtempSync(join(realpathSync(scratch), "bb-proof-"));
  const evidence: Evidence = { steps: [], proofRoot };
  const note = (step: string, ok: boolean, detail: unknown) => {
    evidence.steps.push({ step, ok, detail });
    console.log(`${ok ? "[ok]  " : "[FAIL]"} ${step}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  };

  const home = homedir();
  const liveDataDir = process.env.BB_DATA_DIR?.trim() || join(home, ".bb");
  const bbData = join(proofRoot, "bb-data");
  const isolation = assertIsolatedDataDir({ requested: args.dataDir ?? bbData, live: liveDataDir, proofRoot });
  if (!isolation.ok) {
    console.error(`[refused] ${isolation.reason}`);
    evidence.refused = isolation.reason;
    writeFileSync(join(proofRoot, "evidence.json"), JSON.stringify(evidence, null, 2));
    process.exitCode = 2;
    return;
  }
  note("isolation", true, { comparedLiveDataDir: liveDataDir === join(home, ".bb") ? "~/.bb" : "BB_DATA_DIR", isolatedDataDir: "this run's proof root" });

  const found = findBb(args.bbApp);
  if (!found.install) {
    const message = `No installed BB was found. Tried: ${found.tried.join(", ")}. Pass --bb-app <command shim> when BB lives elsewhere.`;
    console.error(`[cannot start] ${message}`);
    evidence.unstartable = message;
    writeFileSync(join(proofRoot, "evidence.json"), JSON.stringify(evidence, null, 2));
    process.exitCode = 3;
    return;
  }
  const bb = found.install;
  note("install", true, { launcherFound: true });
  mkdirSync(bbData, { recursive: true });
  const serverPort = args.serverPort ?? await freePort();
  const daemonPort = args.daemonPort ?? await freePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const bbEnv: NodeJS.ProcessEnv = { ...process.env, BB_DATA_DIR: bbData, BB_SERVER_URL: serverUrl, BB_HOST_DAEMON_PORT: String(daemonPort), BB_TELEMETRY: "false", BB_CLI_ERROR_LOG: "0" };
  const cli = async (argv: string[]): Promise<string> => {
    const { stdout } = await run(bb.cli, argv, { env: bbEnv, maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
    return stdout;
  };
  const cliJson = async <T>(argv: string[]): Promise<T> => JSON.parse(await cli(argv)) as T;

  // The synthetic repository and its worktree: Nucleus owns worktree creation, so the
  // proof creates one exactly as a task would.
  const repository = join(proofRoot, "synthetic-repository");
  const worktree = join(proofRoot, "synthetic-worktree");
  mkdirSync(repository);
  const git = async (argv: string[], cwd = repository) => await run("git", argv, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  await git(["init", "--quiet", "."]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["config", "user.name", "Synthetic fixture"]);
  writeFileSync(join(repository, "fixture.txt"), "Synthetic BB proof fixture\n");
  await git(["add", "fixture.txt"]);
  await git(["commit", "--quiet", "-m", "Synthetic fixture"]);
  await git(["worktree", "add", "--quiet", worktree, "-b", "nucleus-proof"]);
  note("synthetic-repository", true, { files: ["fixture.txt"], worktreeBranch: "nucleus-proof" });

  let server: Child | null = null;
  let daemon: Child | null = null;
  const service = new QueueService({ owner: { dataDir: join(proofRoot, "ns"), timers: false }, fixture: "fake" });
  try {
    // 1. The isolated BB server: its own data directory and port.
    server = startProcess("bb-server", process.execPath, [bb.serverLauncher, "--data-dir", bbData, "--server-port", String(serverPort)], bbEnv, join(proofRoot, "bb-server.log"));
    await waitFor("the isolated BB server", async () => (await portOpen(serverPort)) ? true : null, 120_000);
    await waitFor("the isolated BB CLI", async () => { try { await cli(["project", "list", "--json"]); return true; } catch { return null; } }, 120_000);
    note("isolated-server", true, { dataDir: "this run's proof root", port: serverPort });

    // 2. Enroll this machine into that server only, and start its host daemon.
    daemon = startProcess("bb-host-daemon", process.execPath, [bb.daemonLauncher, "join", "--server-url", serverUrl, "--host-daemon-port", String(daemonPort)], bbEnv, join(proofRoot, "bb-host-daemon.log"));
    const machines = await waitFor("an enrolled execution machine", async () => {
      try {
        const rows = await cliJson<Array<{ id: string; status?: string }>>(["machine", "list", "--json"]);
        return rows.find(row => row.status === "connected") ?? null;
      } catch { return null; }
    }, 120_000);
    note("isolated-machine", true, { hostId: machines.id, status: machines.status });

    // 3. The Nucleus service the plugin connects out to, isolated like everything else.
    await service.start();
    const serviceInfo = readServiceInfo(join(proofRoot, "ns"));
    assert.ok(serviceInfo, "the isolated Nucleus service published its identity");
    const hostId = hostIdFromDataDir(bbData);
    note("nucleus-service", true, { protocolVersion: serviceInfo.protocolVersion });

    // 4. Install this repository's plugin skeleton into the isolated server only.
    const pluginSource = join(checkout, "hosts", "bb", "plugin");
    const pluginDir = join(proofRoot, "plugin");
    mkdirSync(pluginDir);
    for (const name of ["package.json", "server.ts", "channel.ts", "operations.ts", "protocol.ts"]) cpSync(join(pluginSource, name), join(pluginDir, name));
    // Record unprojected SDK answers from this isolated server. The wrapper exists
    // only in the proof copy: installed production plugins never record wire data.
    const wirePath = join(proofRoot, "sdk-wire.jsonl");
    const recorder = `
import { appendFileSync as recordAppend } from "node:fs";
function recordSdk(sdk: any, bb: any, prefix = ""): any {
  return new Proxy(sdk, { get(target, key) {
    const value = target[key], name = prefix ? prefix + "." + String(key) : String(key);
    if (typeof value === "function") return async (...args: any[]) => {
      const result = await value.apply(target, args);
      recordAppend(${JSON.stringify(wirePath)}, JSON.stringify({ method: name, args, result }) + "\\n");
      if (name === "threads.stop" && !recordInteraction) {
        recordInteraction = true;
        void bb.ui.requestInput({ threadId: args[0].threadId, rendererId: "wire-fixture", title: "Synthetic question", payload: {}, timeoutMs: 2000 }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 100));
        const interactions = await sdkRoot.threads.interactions.list({ threadId: args[0].threadId });
        recordAppend(${JSON.stringify(wirePath)}, JSON.stringify({ method: "threads.interactions.list", args: [args[0]], result: interactions }) + "\\n");
        const list = await sdkRoot.threads.list({ threadIds: [args[0].threadId], includeHidden: true });
        recordAppend(${JSON.stringify(wirePath)}, JSON.stringify({ method: "threads.list", args: [{threadIds: [args[0].threadId]}], result: list }) + "\\n");
        const timelineArgs = { threadId: args[0].threadId, segmentLimit: "20", includeNestedRows: "true", deferContent: "true" };
        const timeline = await sdkRoot.threads.timeline(timelineArgs);
        recordAppend(${JSON.stringify(wirePath)}, JSON.stringify({ method: "threads.timeline", args: [timelineArgs], result: timeline }) + "\\n");
        for (const i of interactions) await sdkRoot.threads.interactions.cancel({ threadId: args[0].threadId, interactionId: i.id });
        for (const [method, args] of [["providers.list", {}], ["providers.models", {providerId: "codex"}]]) {
          const [area, verb] = method.split(".");
          const result = await sdkRoot[area][verb](args);
          recordAppend(${JSON.stringify(wirePath)}, JSON.stringify({ method, args: [args], result }) + "\\n");
        }
        const sendArgs = { threadId: args[0].threadId, input: [{type: "text", text: "Synthetic revision fixture. Do not run tools."}], mode: "queue-if-active", pluginSubmission: { pluginId: "nucleus", data: {messageId: "synthetic-message"} } };
        const sent = await sdkRoot.threads.send(sendArgs);
        recordAppend(${JSON.stringify(wirePath)}, JSON.stringify({ method: "threads.send", args: [sendArgs], result: sent }) + "\\n");
        await sdkRoot.threads.stop({ threadId: args[0].threadId });
      }
      return result;
    };
    return value && typeof value === "object" ? recordSdk(value, bb, name) : value;
  }});
}
let recordInteraction = false;
let sdkRoot: any;
`;
    const entry = join(pluginDir, "server.ts");
    writeFileSync(entry, recorder + readFileSync(entry, "utf8").replace("sdk: bb.sdk as unknown as BbHostSdk,", "sdk: recordSdk(sdkRoot = bb.sdk, bb) as unknown as BbHostSdk,"));
    await cli(["plugin", "install", `path:${pluginDir}`, "--yes"]);
    await cli(["plugin", "config", "nucleus", "set", "serviceDataDir", join(proofRoot, "ns")]);
    await cli(["plugin", "reload", "nucleus"]);
    await waitFor("the plugin's host-executor declaration", async () => service.hostExecutorStatus(hostId), 120_000);
    const firstConnection = service.hostExecutorStatus(hostId)!;
    note("channel-connected", true, { hostId, connectedAt: firstConnection.connectedAt });

    const send = async <T>(op: string, input: unknown): Promise<{ value: T; calls: Record<string, number> }> => {
      const outcome = await service.sendHostOperation(hostId, op as never, input);
      return { value: outcome.value as T, calls: outcome.calls };
    };

    // 5. Identity derived and proved through the channel.
    interface Identity { dataDir: string; bbVersion: string; sdkVersion: string; hostIds: string[] }
    const identity = await send<Identity>("identity.probe", {});
    assert.equal(realpathSync(identity.value.dataDir), realpathSync(bbData), "the plugin names the isolated data directory");
    assert.equal(hostIdFromDataDir(identity.value.dataDir), hostId, "the service derives the same identity from the declared directory");
    note("identity-proved", true, { hostId, bbVersion: identity.value.bbVersion, sdkVersion: identity.value.sdkVersion, hostIds: identity.value.hostIds, machineId: machines.id });

    // Spec 062 phase 1: the probe is these four reads, and the plugin's own counters are
    // the evidence that this BB release answers each one. A changed shape would have
    // thrown out of the read instead of answering.
    const probeReads = ["status.get", "system.version", "threads.list", "hosts.list"];
    for (const read of probeReads) assert.ok((identity.calls[read] ?? 0) > 0, `the identity probe read ${read} against the isolated BB`);
    note("identity-probe-reads", true, Object.fromEntries(probeReads.map(read => [read, identity.calls[read]])));

    // 6. Step 1 of the lifecycle: register the project and mint the handle, no thread.
    interface Workspace { projectId: string; projectCreated: boolean; projectCount: number; handle: string; path: string; spawned: number }
    const workspace = await send<Workspace>("workspace.create", { repositoryRoot: repository, name: "Synthetic project" });
    assert.equal(workspace.value.spawned, 0, "the workspace step made zero threads.spawn calls");
    assert.equal(workspace.value.handle, workspaceHandleForPath(repository), "the handle is the Nucleus derivation for the directory");
    const environmentsBefore = await send<{ environments: Array<{ environmentId: string }> }>("environment.list", {});
    assert.deepEqual(environmentsBefore.value.environments, [], "no environment exists before a thread attaches one");
    note("workspace-minted", true, { projectCreated: workspace.value.projectCreated, zeroSpawns: true, threadsBeforeAttach: 0, handle: workspace.value.handle.slice(0, 16) + "…" });

    // 7. Step 2: attach the worktree by spawning a synthetic worker under a synthetic planner.
    interface Attached { threadId: string; environmentId: string; status: string; parentThreadId: string | null; parentNotifications: string; pluginMetadata: Record<string, unknown> | null; createdAt: number }
    const planner = await send<Attached>("run.attach", {
      projectId: workspace.value.projectId,
      title: "Synthetic planner",
      environmentPath: repository,
      parentNotifications: "off",
      prompt: "Synthetic planner fixture. Do not run any tools.",
      providerId: args.provider,
      pluginMetadata: { nucleus: { task: "spike", run: "phase-0" } },
    });
    const worker = await send<Attached>("run.attach", {
      projectId: workspace.value.projectId,
      title: "Synthetic worker",
      environmentPath: worktree,
      parentThreadId: planner.value.threadId,
      parentNotifications: "off",
      prompt: "Synthetic worker fixture. Do not run any tools; this thread is a fixture for an attach proof.",
      providerId: args.provider,
      pluginMetadata: { nucleus: { task: "spike", run: "phase-0" } },
    });
    assert.ok(worker.value.environmentId, "the spawn response recorded the attached environment");
    assert.equal(worker.value.parentThreadId, planner.value.threadId);
    assert.equal(worker.value.parentNotifications, "off");
    assert.deepEqual(worker.value.pluginMetadata, { nucleus: { task: "spike", run: "phase-0" } });
    // A second role in the same task worktree re-attaches by path and resolves to the
    // same environment: that is the "one environment per task" claim made concrete.
    const sibling = await send<Attached>("run.attach", {
      projectId: workspace.value.projectId,
      title: "Synthetic reviewer",
      environmentPath: worktree,
      parentThreadId: planner.value.threadId,
      parentNotifications: "off",
      prompt: "Synthetic sibling fixture. Do not run any tools.",
      providerId: args.provider,
      pluginMetadata: { nucleus: { task: "spike", run: "phase-0" } },
    });
    assert.equal(sibling.value.environmentId, worker.value.environmentId, "a second role in the same worktree reuses the environment");
    await send("thread.stop", { threadId: sibling.value.threadId });
    const environmentsAfter = await send<{ environments: Array<{ environmentId: string; path: string; isWorktree: boolean; managed: boolean }> }>("environment.list", {});
    const attachedEnvironment = environmentsAfter.value.environments.find(row => row.environmentId === worker.value.environmentId);
    assert.ok(attachedEnvironment, "the environment is listed");
    assert.equal(attachedEnvironment.managed, false, "the attach is unmanaged");
    assert.equal(realpathSync(attachedEnvironment.path), realpathSync(worktree));
    note("worktree-attached", true, { workerThread: worker.value.threadId, environmentId: worker.value.environmentId, parent: planner.value.threadId, parentNotifications: "off", unmanaged: true });

    // 8. Step 3: observe the thread as the inventory and one exact read see it.
    interface Observed { threadId: string; title: string | null; status: string; displayStatus: string; environmentId: string | null; parentThreadId: string | null; parentNotifications: string; pluginMetadata: Record<string, unknown> | null; archivedAt: number | null; queuedWork: string | null }
    const observed = await send<Observed>("thread.observe", { threadId: worker.value.threadId });
    assert.equal(observed.value.environmentId, worker.value.environmentId);
    assert.equal(observed.value.parentThreadId, planner.value.threadId);
    assert.equal(observed.value.archivedAt, null);
    const inventory = await send<{ complete: boolean; rows: Array<{ threadId: string; environmentId: string | null; parentThreadId: string | null }> }>("thread.inventory", { projectId: workspace.value.projectId });
    assert.ok(inventory.value.rows.some(row => row.threadId === worker.value.threadId && row.environmentId === worker.value.environmentId), "the inventory names the worker and its environment");
    // The adoption search of decision 6: this plugin's origin across every project,
    // hidden rows included, not filtered by the current planner or project.
    const originWalk = await send<{ complete: boolean; rows: Array<{ threadId: string; originPluginId: string | null; archivedAt: number | null }> }>("thread.inventory", { originPluginId: "nucleus", includeHidden: true });
    assert.ok(originWalk.value.rows.some(row => row.threadId === worker.value.threadId), "the unfiltered origin walk names the worker");
    assert.ok(originWalk.value.rows.every(row => row.originPluginId === "nucleus"), "every row of the origin walk belongs to this plugin");
    const stopped = await send<{ threadId: string; status: string; displayStatus: string }>("thread.stop", { threadId: worker.value.threadId });
    note("thread-observed", true, { status: observed.value.status, displayStatus: observed.value.displayStatus, environment: observed.value.environmentId, parent: observed.value.parentThreadId, pluginMetadata: observed.value.pluginMetadata, afterStop: stopped.value.status });
    const timeline = await send<{ entries: unknown[]; pendingBackgroundTasks: string[] }>("thread.timeline", { threadId: worker.value.threadId });
    note("bounded-thread-timeline", true, { entries: timeline.value.entries.length, pendingBackgroundTasks: timeline.value.pendingBackgroundTasks.length });

    // 9. The terminal-scope question: where each kind of terminal actually appears.
    const threadTerminal = await send<{ session: { id: string; threadId: string | null } }>("terminal.create", { scope: { kind: "thread", threadId: worker.value.threadId }, title: "nucleus worker terminal" });
    const hostTerminal = await send<{ session: { id: string; initialCwd: string | null; threadId: string | null; hostId: string | null } }>("terminal.create", { scope: { kind: "host_path", hostId: machines.id, cwd: worktree }, title: "nucleus task directory" });
    // A terminal row can lag its creation by a moment on both scopes; wait a bounded
    // window rather than reading the first list as the answer.
    const listUntil = async (scope: Record<string, unknown>, expected: (sessions: Array<{ id: string }>) => boolean): Promise<{ sessions: Array<{ id: string }>; waitedMs: number }> => {
      const startedAt = Date.now();
      let list = await send<{ sessions: Array<{ id: string }> }>("terminal.list", { scope });
      while (!expected(list.value.sessions) && Date.now() - startedAt < 10_000) {
        await delay(250);
        list = await send<{ sessions: Array<{ id: string }> }>("terminal.list", { scope });
      }
      return { sessions: list.value.sessions, waitedMs: Date.now() - startedAt };
    };
    const threadScoped = await listUntil({ kind: "thread", threadId: worker.value.threadId }, sessions => sessions.some(row => row.id === threadTerminal.value.session.id));
    const hostScoped = await listUntil({ kind: "host_path", hostId: machines.id }, sessions => sessions.some(row => row.id === hostTerminal.value.session.id));
    const environmentScoped = await send<{ sessions: Array<{ id: string }> }>("terminal.list", { scope: { kind: "environment", environmentId: worker.value.environmentId } });
    const threadTerminalInThreadPanel = threadScoped.sessions.some(row => row.id === threadTerminal.value.session.id);
    const threadTerminalInHostPanel = hostScoped.sessions.some(row => row.id === threadTerminal.value.session.id);
    const hostTerminalInThreadPanel = threadScoped.sessions.some(row => row.id === hostTerminal.value.session.id);
    const hostTerminalInHostPanel = hostScoped.sessions.some(row => row.id === hostTerminal.value.session.id);
    note("terminal-scope", true, {
      threadScopedTerminalInThreadPanel: threadTerminalInThreadPanel,
      threadScopedTerminalInHostPanel: threadTerminalInHostPanel,
      hostPathTerminalInThreadPanel: hostTerminalInThreadPanel,
      hostPathTerminalInHostPanel: hostTerminalInHostPanel,
      threadScopeSessions: threadScoped.sessions.length,
      hostScopeSessions: hostScoped.sessions.length,
      waitedMs: { thread: threadScoped.waitedMs, host: hostScoped.waitedMs },
      environmentScopedSessions: environmentScoped.value.sessions.length,
      created: { threadScoped: threadTerminal.value.session.id, hostPath: hostTerminal.value.session.id, hostPathHostId: hostTerminal.value.session.hostId, hostPathCwd: hostTerminal.value.session.initialCwd, machineId: machines.id },
      answer: "a thread-scoped terminal belongs to its thread's panel; a host_path terminal at a task worktree appears only in the host's terminal list, never in the planner thread's panel",
    });
    assert.equal(threadTerminalInThreadPanel, true, "a thread-scoped terminal belongs to its thread's list");
    assert.equal(threadTerminalInHostPanel, false, "a thread-scoped terminal is not a host-path terminal");
    assert.equal(hostTerminalInThreadPanel, false, "a host_path terminal never appears in a thread's list");
    assert.equal(hostTerminalInHostPanel, true, "a host_path terminal appears only in the host's own list");

    // 10. Step 4: archive after the cascade read, leaving the planner untouched.
    interface Cascade { threadId: string; cascadeThreadIds: string[] }
    const cascade = await send<Cascade>("thread.cascade", { threadId: worker.value.threadId, action: "archive" });
    assert.deepEqual(cascade.value.cascadeThreadIds, [], "nothing depends on the worker thread");
    const plannerBefore = await send<Observed>("thread.observe", { threadId: planner.value.threadId });
    const archived = await send<{ threadId: string; archivedAt: number; cascadeThreadIds: string[] }>("thread.archive", { threadId: worker.value.threadId, expectedCascadeThreadIds: [] });
    const archivedObserved = await send<Observed>("thread.observe", { threadId: worker.value.threadId });
    assert.ok(archivedObserved.value.archivedAt === archived.value.archivedAt, "the archive is recorded on the thread");
    const plannerAfter = await send<Observed>("thread.observe", { threadId: planner.value.threadId });
    assert.equal(plannerAfter.value.archivedAt, null, "the planner is not archived by the cascade");
    assert.equal(plannerAfter.value.status, plannerBefore.value.status, "the planner's status is untouched");
    const siblingAfter = await send<Observed>("thread.observe", { threadId: sibling.value.threadId });
    assert.equal(siblingAfter.value.archivedAt, null, "the sibling in the same worktree is not archived by the cascade");
    note("thread-archived", true, { archivedAt: archived.value.archivedAt, cascadeNamed: cascade.value.cascadeThreadIds.length, plannerUntouched: true, siblingUntouched: true, sharedEnvironment: worker.value.environmentId });

    // 11. Plugin reload: the channel reconnects and the identity is re-proved.
    await cli(["plugin", "reload", "nucleus"]);
    const afterReload = await waitFor("the re-declared host-executor connection", async () => {
      const status = service.hostExecutorStatus(hostId);
      return status && status.connectedAt !== firstConnection.connectedAt ? status : null;
    }, 120_000);
    const reloadIdentity = await send<Identity>("identity.probe", {});
    assert.equal(hostIdFromDataDir(reloadIdentity.value.dataDir), hostId, "the reloaded plugin proves the same identity");
    // Decision 6's second walk: archived rows need their own filter.
    const archivedWalk = await send<{ complete: boolean; rows: Array<{ threadId: string; archivedAt: number | null }> }>("thread.inventory", { originPluginId: "nucleus", includeHidden: true, archived: true });
    assert.ok(archivedWalk.value.rows.some(row => row.threadId === worker.value.threadId && row.archivedAt !== null), "the archived origin walk names the archived worker");
    note("origin-walks", true, { unarchivedOriginRows: originWalk.value.rows.length, archivedOriginRows: archivedWalk.value.rows.length, projectFilterUsed: false, hiddenIncluded: true, archivedWalkInsteadOfResend: true });
    const afterReloadObserved = await send<Observed>("thread.observe", { threadId: worker.value.threadId });
    assert.equal(afterReloadObserved.value.environmentId, worker.value.environmentId, "the environment id is the same after the plugin reload");
    note("plugin-reload-reconnect", true, { previousConnectedAt: firstConnection.connectedAt, reconnectedAt: afterReload.connectedAt, hostId, environmentId: afterReloadObserved.value.environmentId });

    // 12. BB server restart: the environment ID survives and is read back.
    await stopProcess(server);
    server = null;
    await waitFor("the isolated server to go away", async () => (await portOpen(serverPort)) ? null : true, 60_000);
    await waitFor("the dead server's executor connection to drop", async () => service.hostExecutorIds().includes(hostId) ? null : true, 60_000);
    server = startProcess("bb-server", process.execPath, [bb.serverLauncher, "--data-dir", bbData, "--server-port", String(serverPort)], bbEnv, join(proofRoot, "bb-server.restart.log"));
    await waitFor("the restarted isolated BB server", async () => (await portOpen(serverPort)) ? true : null, 120_000);
    await waitFor("the restarted BB CLI", async () => { try { await cli(["project", "list", "--json"]); return true; } catch { return null; } }, 120_000);
    const afterRestart = await waitFor("the restarted plugin's host-executor connection", async () => {
      const status = service.hostExecutorStatus(hostId);
      return status && status.connectedAt !== afterReload.connectedAt ? status : null;
    }, 180_000);
    const restartIdentity = await send<Identity>("identity.probe", {});
    assert.equal(hostIdFromDataDir(restartIdentity.value.dataDir), hostId, "the restarted server proves the same identity");
    const reobserved = await send<Observed>("thread.observe", { threadId: worker.value.threadId });
    assert.equal(reobserved.value.environmentId, worker.value.environmentId, "the environment id is the same after the restart");
    assert.equal(reobserved.value.archivedAt, archivedObserved.value.archivedAt, "the archived state survived the restart");
    const environmentsRestart = await send<{ environments: Array<{ environmentId: string; path: string }> }>("environment.list", {});
    const survivingEnvironment = environmentsRestart.value.environments.find(row => row.environmentId === worker.value.environmentId);
    assert.ok(survivingEnvironment, "the unmanaged environment is still listed after the restart");
    assert.equal(realpathSync(survivingEnvironment.path), realpathSync(worktree));
    note("bb-restart-reproved", true, { reconnectedAt: afterRestart.connectedAt, environmentId: reobserved.value.environmentId, archivedAt: reobserved.value.archivedAt, environmentStillListed: true });

    // 13. Close the terminals this run created and archive the planner, then finish.
    await send("terminal.close", { terminalId: threadTerminal.value.session.id, mode: "force" });
    await send("terminal.close", { terminalId: hostTerminal.value.session.id, mode: "force" });
    const plannerCascade = await send<Cascade>("thread.cascade", { threadId: planner.value.threadId, action: "archive" });
    await send("thread.archive", { threadId: planner.value.threadId, expectedCascadeThreadIds: plannerCascade.value.cascadeThreadIds });
    const finalInventory = await send<{ rows: Array<{ threadId: string; archivedAt: number | null }> }>("thread.inventory", { projectId: workspace.value.projectId, archived: true });
    assert.ok(finalInventory.value.rows.every(row => row.archivedAt !== null), "everything this run created is archived");
    note("teardown-archived", true, { archivedThreads: finalInventory.value.rows.length, closedTerminals: 2 });

    // 14. Opt-in (Spec 062, phase 4): record real provider interaction rows. The default
    // proof never depends on a model answering; this pass does, so it only runs when asked.
    if (args.recordInteractions) {
      const models: string[] = [];
      const collectModels = (value: unknown) => {
        if (Array.isArray(value)) { for (const item of value) collectModels(item); return; }
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (typeof record.model === "string" && record.model && !models.includes(record.model)) models.push(record.model);
        for (const item of Object.values(record)) collectModels(item);
      };
      // A just-restarted provider reports its catalog a moment later; wait a bounded
      // window for it rather than failing the recording pass on a cold catalog.
      const catalogDeadline = Date.now() + 90_000;
      while (!models.length && Date.now() < catalogDeadline) {
        const catalog = await cliJson<unknown>(["provider", "models", args.recordProvider, "--json"]).catch(() => null);
        collectModels(catalog);
        if (!models.length) await delay(2_000);
      }
      const model = args.recordModel ?? models[0];
      assert.ok(model, `the ${args.recordProvider} provider listed no model to run the interaction probes on`);
      const waitInteraction = async (threadId: string, kind: string, timeoutMs = 180_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const listed = await send<{ interactions: Array<{ interactionId: string; kind: string; status: string; questions?: Array<{ id: string; header: string; options: Array<{ label: string; value: string }>; allowFreeText: boolean }>; decisions?: string[] }> }>("thread.interactions", { threadId });
          const found = listed.value.interactions.find(item => item.kind === kind && (item.status === "pending" || item.status === "resolving"));
          if (found) return found;
          await delay(1_000);
        }
        throw new Error(`the ${kind} interaction never appeared on ${threadId}`);
      };
      const retireProbe = async (threadId: string) => {
        await send("thread.stop", { threadId });
        const threadCascade = await send<Cascade>("thread.cascade", { threadId, action: "archive" });
        await send("thread.archive", { threadId, expectedCascadeThreadIds: threadCascade.value.cascadeThreadIds });
      };

      // A native question: the probe thread asks one and waits for the answer.
      const questionThread = await send<Attached>("run.attach", {
        projectId: workspace.value.projectId, title: "Synthetic question probe", environmentPath: worktree,
        parentNotifications: "off", providerId: args.recordProvider, model, permissionMode: "accept-edits",
        prompt: "Use your AskUserQuestion tool right now to ask: \"Proceed with the synthetic probe?\" with exactly two options, \"Proceed\" and \"Stop\". Then stop and wait for the answer.",
        pluginMetadata: { nucleus: { task: "spike", run: "question-probe" } },
      });
      const question = await waitInteraction(questionThread.value.threadId, "user_question");
      assert.ok(question.questions?.length, "the recorded question names at least one question");
      const offered = question.questions![0]!;
      assert.ok(offered.options.length >= 2, "the recorded question offers a choice");
      assert.notEqual(offered.options[0]!.label, offered.options[0]!.value, "a real provider gives an option a wire value distinct from its label");
      // The label is what the operator picks; the plugin must send the option's value.
      const answered = await send<{ status: string; resolutionKind: string }>("thread.interaction.respond", {
        threadId: questionThread.value.threadId, interactionId: question.interactionId,
        answer: { kind: "question", answers: { [offered.header]: offered.options[0]!.label } },
      });
      assert.ok(["resolved", "resolving"].includes(answered.value.status), "the question answer is accepted");
      await retireProbe(questionThread.value.threadId);

      // An approval: the plan-mode probe thread proposes a plan and waits for a decision.
      const approvalThread = await cliJson<{ id: string }>(["thread", "spawn", "--json", "--project", workspace.value.projectId,
        "--machine", machines.id, "--environment", worktree, "--provider", args.recordProvider, "--model", model,
        "--permission-mode", "accept-edits", "--plan", "--title", "Synthetic approval probe",
        "--prompt", "Make a plan with two short steps to add a greeting line to fixture.txt. Stop after presenting the plan."]);
      const approval = await waitInteraction(approvalThread.id, "approval");
      assert.ok(approval.decisions?.includes("allow_once"), "the recorded approval offers allow_once");
      const decided = await send<{ status: string; resolutionKind: string }>("thread.interaction.respond", {
        threadId: approvalThread.id, interactionId: approval.interactionId, answer: { kind: "permission", decision: "accept" },
      });
      assert.ok(["resolved", "resolving"].includes(decided.value.status), "the approval answer is accepted");
      await retireProbe(approvalThread.id);

      // Keep the raw SDK rows and resolutions the plugin actually read and wrote.
      const lines = readFileSync(wirePath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { method?: string; args?: unknown[]; result?: unknown });
      const rawQuestion = lines.filter(line => line.method === "threads.interactions.list").flatMap(line => (line.result as Array<{ id?: string }> | undefined) ?? []).find(row => row.id === question.interactionId);
      const rawApproval = lines.filter(line => line.method === "threads.interactions.list").flatMap(line => (line.result as Array<{ id?: string }> | undefined) ?? []).find(row => row.id === approval.interactionId);
      const resolutions = lines.filter(line => line.method === "threads.interactions.resolve").map(line => ({ args: line.args, result: line.result }));
      assert.ok(rawQuestion && rawApproval, "the raw provider interaction rows were recorded from this isolated server");
      const recordedQuestionResolution = resolutions.find(entry => JSON.stringify(entry.args).includes(question.interactionId));
      const recordedApprovalResolution = resolutions.find(entry => JSON.stringify(entry.args).includes(approval.interactionId));
      assert.ok(recordedQuestionResolution && recordedApprovalResolution, "both resolutions were recorded");
      writeFileSync(join(proofRoot, "provider-interactions.json"), JSON.stringify({ provider: args.recordProvider, model, question: rawQuestion, approval: rawApproval, resolutions: [recordedQuestionResolution, recordedApprovalResolution] }, null, 2));
      note("provider-interactions-recorded", true, { file: "provider-interactions.json", provider: args.recordProvider,
        questionKind: question.kind, questionOptions: offered.options.length, optionLabelDiffersFromValue: true,
        approvalKind: approval.kind, approvalDecisions: approval.decisions, answered: [answered.value.status, decided.value.status] });
    }

    writeFileSync(join(proofRoot, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(`\nEvidence retained in this run's scratch directory (evidence.json, server logs, plugin sources).`);
  } catch (error) {
    evidence.failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    note("proof", false, error instanceof Error ? error.message : String(error));
    writeFileSync(join(proofRoot, "evidence.json"), JSON.stringify(evidence, null, 2));
    process.exitCode = 1;
  } finally {
    // The in-process service always stops: its persistence worker otherwise keeps this
    // process alive and a kept run would never return.
    await service.stop().catch(() => {});
    if (!args.keep) {
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
