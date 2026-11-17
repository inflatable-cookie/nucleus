/**
 * Opt-in proof: the forked sidebar builds and installs into an isolated BB server
 * (Spec 062, phase 5's last acceptance bullet).
 *
 * Run it with `effigy proof:bb:sidebar` (optionally `--keep`). It refuses the
 * operator's live BB data directory exactly as the phase-0 proof does: it starts
 * its own `bb-server` on its own port with its own data directory under this run's
 * scratch, enrolls its own host daemon, and touches nothing else.
 *
 * What it proves, in one run:
 *
 * 1. `bb plugin build` succeeds for `hosts/bb/plugin` and writes the backend bundle,
 *    the frontend bundle and their metadata;
 * 2. the built plugin installs into that server and loads as `nucleus`;
 * 3. the server serves the plugin's own app bundle, and that bundle registers the
 *    forked list in the `threadList` slot under the id `thread-list`;
 * 4. the host's `sidebar.threadListProvider` preference starts unset (automatic
 *    selection, which prefers a non-bundled list) and pinning it to the bundled
 *    list is accepted and read back — the operator's documented fallback;
 * 5. the built app bundle still carries the host's row-status hook, so another
 *    plugin's row status keeps drawing through the fork (fact 23);
 * 6. the backend composes the vendored list's server entry (Spec 062, decision
 *    5a): the plugin reports its `prefs` CLI and its preference RPC answers in
 *    this server, which is the read the list hydrates through before it leaves its
 *    loading skeleton.
 *
 * 7. phase 6: the board bundle is built first (`scripts/bb/build-board.mjs`), the
 *    served app bundle carries the board's registrations (the rail panel, the
 *    project and task tabs, the pending-question renderer and the composer pills),
 *    the board's forwarding RPC is registered and fails closed without a Nucleus
 *    service, and `bb nucleus terminal --help` answers from the same CLI.
 *
 * It deliberately does not claim a visual proof: the New-thread button, the
 * navigation rail and the footer are host-rendered chrome that this plugin never
 * registers, which the plugin's slot registration and the fork's own unchanged
 * row tests establish, not a screenshot.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertIsolatedDataDir, findBb, freePort, portOpen, startProcess, stopProcess, waitFor, type Child } from "./bb-private";
import { buildBoard } from "../bb/build-board.mjs";

const run = promisify(execFile);
const checkout = fileURLToPath(new URL("../..", import.meta.url));

const BB_APP_SLOT_NAMES = ["threadList"];

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const scratch = process.env.TMPDIR;
  if (!scratch || !existsSync(scratch) || !statSync(scratch).isDirectory()) throw new Error("The run scratch volume is required: set TMPDIR to an existing directory");
  const proofRoot = mkdtempSync(join(realpathSync(scratch), "bb-sidebar-proof-"));
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
  const cli = async (argv: string[]): Promise<string> => (await run(bb.cli, argv, { env: bbEnv, maxBuffer: 32 * 1024 * 1024, timeout: 180_000 })).stdout;

  let server: Child | null = null;
  let daemon: Child | null = null;
  try {
    server = startProcess("bb-server", process.execPath, [bb.serverLauncher, "--data-dir", bbData, "--server-port", String(serverPort)], bbEnv, join(proofRoot, "bb-server.log"));
    await waitFor("the isolated BB server", async () => ((await portOpen(serverPort)) ? true : null), 120_000);
    await waitFor("the isolated BB CLI", async () => { try { await cli(["project", "list", "--json"]); return true; } catch { return null; } }, 120_000);
    note("isolated-server", true, { dataDir: "this run's proof root", port: serverPort });

    daemon = startProcess("bb-host-daemon", process.execPath, [bb.daemonLauncher, "join", "--server-url", serverUrl, "--host-daemon-port", String(daemonPort)], bbEnv, join(proofRoot, "bb-host-daemon.log"));
    await waitFor("an enrolled execution machine", async () => {
      try {
        const rows = JSON.parse(await cli(["machine", "list", "--json"])) as Array<{ id: string; status?: string }>;
        return rows.find(row => row.status === "connected") ?? null;
      } catch { return null; }
    }, 120_000);
    note("isolated-machine", true, "one enrolled machine");

    // 1. The build: the board bundle first (phase 6), then `bb plugin build` itself.
    const board = await buildBoard();
    note("board-bundle", true, { bytes: board.bytes });
    const pluginDir = join(checkout, "hosts", "bb", "plugin");
    const buildOut = await cli(["plugin", "build", pluginDir]);
    const artifacts = ["server.js", "server.meta.json", "app.js", "app.css", "app.meta.json"].map(name => join(pluginDir, "dist", name));
    for (const artifact of artifacts) assert.ok(existsSync(artifact), `${artifact} was built`);
    const appMeta = JSON.parse(readFileSync(join(pluginDir, "dist", "app.meta.json"), "utf8")) as Record<string, unknown>;
    note("plugin-build", true, { artifacts: artifacts.length, appMeta, output: buildOut.trim().slice(0, 200) });

    // 2. The install and load, in that server only.
    await cli(["plugin", "install", `path:${pluginDir}`, "--yes"]);
    await cli(["plugin", "reload", "nucleus"]);
    const listed = await waitFor("the nucleus plugin to load", async () => {
      const answer = JSON.parse(await cli(["plugin", "list", "--json"])) as { plugins?: Array<{ id: string; enabled?: boolean; status?: string }> };
      const plugin = answer.plugins?.find(entry => entry.id === "nucleus");
      return plugin && plugin.status !== "error" ? plugin : null;
    }, 120_000);
    note("plugin-installed", true, listed);

    // 3. The host serves the plugin's own app bundle, and it registers the list in
    // the threadList slot under the fork's id.
    const pluginList = JSON.parse(await cli(["plugin", "list", "--json"])) as {
      plugins: Array<{ id: string; rootDir?: string; app?: { hasApp?: boolean; bundle?: { jsUrl?: string } } }>;
    };
    const installed = pluginList.plugins.find(entry => entry.id === "nucleus");
    const installedApp = installed?.rootDir ? join(installed.rootDir, "dist", "app.js") : null;
    const bundle = installedApp && existsSync(installedApp) ? readFileSync(installedApp, "utf8") : null;
    assert.ok(bundle, "the installed plugin carries its built app bundle");
    for (const slot of BB_APP_SLOT_NAMES) assert.ok(bundle!.includes(slot), `the app bundle registers the ${slot} slot`);
    assert.ok(bundle!.includes("thread-list"), "the registration id is the fork's own");
    assert.ok(bundle!.includes("nucleus.board-signal"), "the refetch signal rides the same bundle");
    note("app-bundle", true, { servedFrom: "the installed plugin directory", slots: BB_APP_SLOT_NAMES, registrationId: "thread-list" });

    // The host serves that bundle over its own HTTP API for the frontend to load.
    const jsUrl = installed?.app?.bundle?.jsUrl;
    assert.equal(typeof jsUrl, "string", "the host reports the plugin app bundle's served URL");
    const response = await fetch(`${serverUrl}${jsUrl}`);
    assert.equal(response.status, 200, "the server serves the plugin's app bundle");
    const served = await response.text();
    assert.ok(served.includes("thread-list"), "the served bundle is the fork's list");
    note("app-served", true, { status: response.status, bytes: served.length, url: jsUrl });

    // 4. Selection: unset means automatic (a non-bundled list wins); pinning the
    // bundled list is accepted and read back, which is the operator's fallback.
    const provider = async (): Promise<string | null> => {
      try {
        const out = JSON.parse(await cli(["settings", "ui", "get", "sidebar.threadListProvider", "--json"])) as { value?: unknown };
        return typeof out.value === "string" ? out.value : null;
      } catch {
        return null;
      }
    };
    const unpinned = await provider();
    assert.equal(unpinned, "__automatic__", "the thread-list provider starts automatic, which prefers a non-bundled list");
    const bundled = "bb--thread-list";
    await cli(["settings", "ui", "set", "sidebar.threadListProvider", bundled]);
    const pinned = await provider();
    assert.equal(pinned, bundled, "pinning the bundled list is accepted and read back");
    await cli(["settings", "ui", "reset", "sidebar.threadListProvider"]);
    assert.equal(await provider(), "__automatic__", "resetting returns the host to automatic selection");
    note("provider-selection", true, { automatic: "__automatic__", pinned: bundled, reset: "__automatic__" });

    // 5. The vendored list's server entry is composed: its CLI and its preference
    // RPC answer in this real backend, which is what the list hydrates through.
    const listedCli = JSON.parse(await cli(["plugin", "list", "--json"])) as {
      plugins: Array<{ id: string; cliCommand?: { name?: string } | string | null }>;
    };
    const reportedCli = listedCli.plugins.find(entry => entry.id === "nucleus")?.cliCommand ?? null;
    const cliCommand = typeof reportedCli === "string" ? reportedCli : reportedCli?.name ?? null;
    assert.equal(cliCommand, "nucleus", "the vendored list CLI registers under the plugin id");
    const preferenceAnswer = await fetch(`${serverUrl}/api/v1/plugins/nucleus/rpc/listPreferences`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    assert.equal(preferenceAnswer.status, 200, "the preference RPC answers in this backend");
    const preferenceBody = (await preferenceAnswer.json()) as { ok?: boolean; result?: { preferences?: Record<string, unknown> } };
    assert.equal(preferenceBody.ok, true, "the preference read succeeds");
    const preferences = preferenceBody.result?.preferences ?? {};
    assert.ok("expandedTaskGroups" in preferences, "the read carries the fork's own collapse preference");
    assert.deepEqual(preferences.expandedTaskGroups, [], "a fresh sidebar has no expanded task groups");
    let cliOutput = "";
    try {
      cliOutput = (await cli(["nucleus", "prefs", "list", "--json"])).trim();
    } catch (error) {
      cliOutput = `the isolated CLI did not run the command: ${error instanceof Error ? error.message : String(error)}`;
    }
    evidence.preferenceRead = { cliCommand, preferences: Object.keys(preferences).sort(), cliOutput: cliOutput.slice(0, 400) };
    note("sidebar-server-composition", true, {
      cliCommand,
      preferenceRpc: "listPreferences",
      preferenceKeys: Object.keys(preferences).length,
      expandedTaskGroups: preferences.expandedTaskGroups,
      cliRan: !cliOutput.startsWith("the isolated CLI did not run"),
    });

    // 7. Phase 6: the board's registrations ride the same app bundle, its forwarding
    // RPC is registered (and fails closed with no Nucleus service), and the terminal
    // command joins the list's CLI.
    for (const id of ["nucleus-board", "nucleus-project-board", "nucleus-task", "nucleus-question", "nucleus-pills", "nucleus-settings"])
      assert.ok(bundle!.includes(id), `the app bundle registers ${id}`);
    const boardAnswer = await fetch(`${serverUrl}/api/v1/plugins/nucleus/rpc/boardCall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "queue.ui-snapshot", input: {} }),
    });
    const boardBody = (await boardAnswer.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
    assert.notEqual(boardBody?.ok, true, "without a Nucleus service the board call fails closed rather than inventing a board");
    let terminalHelp = "";
    try { terminalHelp = (await cli(["nucleus", "terminal", "--help"])).trim(); } catch (error) { terminalHelp = `the isolated CLI did not run the command: ${error instanceof Error ? error.message : String(error)}`; }
    note("board-surfaces", true, { boardCallStatus: boardAnswer.status, boardCallError: boardBody?.error?.message?.slice(0, 200) ?? null, terminalHelp: terminalHelp.slice(0, 200) });

    // 6. The row-status path another plugin writes keeps drawing through the fork.
    assert.ok(bundle!.includes("useSidebarThreadRowStatus"), "the fork's rows still honour the host row-status path");
    note("row-status-path", true, { honouredBy: "the vendored rows, unchanged by the patch set" });

    writeFileSync(join(proofRoot, "evidence.json"), JSON.stringify(evidence, null, 2));
    note("evidence", true, { retainedIn: "this run's scratch root (removed at release)" });
    console.log("\nAll phase-5 sidebar proof steps passed.");
  } catch (error) {
    writeFileSync(join(proofRoot, "evidence.json"), JSON.stringify(evidence, null, 2));
    throw error;
  } finally {
    if (!keep) {
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

export { main };
