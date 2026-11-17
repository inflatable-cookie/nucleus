/**
 * Opt-in proof: the operator install route against an isolated BB server (Spec 062,
 * phase 7).
 *
 * Run it with `effigy proof:bb:install` (optionally `--keep`). It refuses the
 * operator's live BB data directory exactly as the phase-0 proof does: it starts its
 * own `bb-server` on its own port with its own data directory under this run's
 * scratch, enrolls its own host daemon, and touches nothing else. It starts a private
 * Nucleus service on its own data home too, so the build the plugin is pinned to is
 * this process's own build and no live daemon is read.
 *
 * What it proves, in one run:
 *
 * 1. two plugins already installed in that server — one unrelated, one standing in
 *    for the operator's locally patched Usage Pace — stay byte-identical across every
 *    `nucleus bb` command, and no command names their ids;
 * 2. `nucleus bb install` installs the built plugin under ID `nucleus` and reloads it;
 * 3. `nucleus bb status` reports the installed plugin's build as the running service's
 *    build, and reports it as behind when the plugin carries another build;
 * 4. `nucleus bb uninstall` removes that plugin and nothing else;
 * 5. the packaged plugin connects on the setting `install` itself wrote — the
 *    private service's data home — and the service accepts a plugin from its own
 *    build, refuses one from another build by naming both and the fix, and accepts
 *    the reinstalled matching one;
 * 6. a plugin with ID `nucleus` that is not a Nucleus build is refused by name for
 *    install *and* uninstall and left byte-identical, and an unrelated plugin
 *    directory is never handed to BB's `plugin install`.
 *
 * Every write goes through BB's own CLI. The proof keeps its evidence in its own
 * scratch root and never writes into the operator's BB.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { QueueService } from "../../service/transport/server";
import { currentServiceBuildId } from "../../shared/service/build";
import { hostIdFromDataDir } from "../../shared/host-operation";
import {
  assertIsolatedDataDir,
  findBb,
  freePort,
  portOpen,
  startProcess,
  stopProcess,
  waitFor,
  type Child,
} from "./bb-private";

const run = promisify(execFile);
const checkout = fileURLToPath(new URL("../..", import.meta.url));

const PLUGIN_ID = "nucleus";
const STAND_IN_IDS = ["proof-unrelated", "usage-pace"];

/** A synthetic plugin package the isolated server can install and load. */
function syntheticPlugin(directory: string, id: string, display: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name: `bb-plugin-${id}`,
        version: "1.0.0",
        private: true,
        type: "module",
        engines: { bb: ">=0.49", bbPluginSdk: ">=0.6.132" },
        bb: {
          name: display,
          description: `${display}, a synthetic plugin for the install proof.`,
          branding: { icon: "Boxes" },
          server: "./dist/server.js",
        },
      },
      null,
      2,
    ) + "\n",
  );
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(
    join(directory, "dist", "server.js"),
    `export default async function plugin(bb) { bb.log.info(${JSON.stringify(`${id} loaded`)}); }\n`,
  );
  writeFileSync(
    join(directory, "dist", "server.meta.json"),
    JSON.stringify(
      {
        sdkMajor: 0,
        sdkVersion: "0.6.132",
        artifactFormatVersion: 1,
        pluginId: id,
        pluginVersion: "1.0.0",
      },
      null,
      2,
    ) + "\n",
  );
}

/** The Nucleus refusal a failed CLI call printed, for the evidence line. */
function lastLine(message: string | null): string | null {
  if (!message) return null;
  const lines = message
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1]?.slice(0, 300) ?? null;
}

/** Every regular file in a plugin directory, with its SHA-256: the byte-identity proof. */
function directoryDigest(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        files[path.slice(directory.length + 1)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
    }
  };
  walk(directory);
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const scratch = process.env.TMPDIR;
  if (!scratch || !existsSync(scratch) || !statSync(scratch).isDirectory())
    throw new Error(
      "The run scratch volume is required: set TMPDIR to an existing directory",
    );
  const proofRoot = mkdtempSync(
    join(realpathSync(scratch), "bb-install-proof-"),
  );
  const evidence: {
    steps: Array<{ step: string; ok: boolean; detail: unknown }>;
    proofRoot: string;
    [key: string]: unknown;
  } = { steps: [], proofRoot };
  const note = (step: string, ok: boolean, detail: unknown) => {
    evidence.steps.push({ step, ok, detail });
    console.log(
      `${ok ? "[ok]  " : "[FAIL]"} ${step}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`,
    );
  };

  const liveDataDir = process.env.BB_DATA_DIR?.trim() || join(homedir(), ".bb");
  const bbData = join(proofRoot, "bb-data");
  const isolation = assertIsolatedDataDir({
    requested: bbData,
    live: liveDataDir,
    proofRoot,
  });
  if (!isolation.ok) {
    console.error(`[refused] ${isolation.reason}`);
    process.exitCode = 2;
    return;
  }
  note("isolation", true, {
    comparedLiveDataDir:
      liveDataDir === join(homedir(), ".bb") ? "~/.bb" : "BB_DATA_DIR",
    isolatedDataDir: "this run's proof root",
  });

  const found = findBb(null);
  if (!found.install) {
    console.error(
      `[cannot start] No installed BB was found. Tried: ${found.tried.join(", ")}`,
    );
    process.exitCode = 3;
    return;
  }
  const bb = found.install;
  mkdirSync(bbData, { recursive: true });
  const serverPort = await freePort();
  const daemonPort = await freePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const bbEnv: NodeJS.ProcessEnv = {
    ...process.env,
    BB_DATA_DIR: bbData,
    BB_SERVER_URL: serverUrl,
    BB_HOST_DAEMON_PORT: String(daemonPort),
    BB_TELEMETRY: "false",
    BB_CLI_ERROR_LOG: "0",
  };
  const cli = async (argv: string[]): Promise<string> =>
    (
      await run(bb.cli, argv, {
        env: bbEnv,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 240_000,
      })
    ).stdout;

  // The private Nucleus service this run installs the plugin against: its build id is
  // what `status` compares, and its channel is what the pinned plugin connects to.
  const serviceDataDir = join(proofRoot, "nucleus-service");
  mkdirSync(serviceDataDir, { recursive: true });
  const service = new QueueService({
    owner: { dataDir: serviceDataDir, timers: false },
    fixture: "fake",
  });
  const buildId = currentServiceBuildId();

  let server: Child | null = null;
  let daemon: Child | null = null;
  try {
    await service.start();
    server = startProcess(
      "bb-server",
      process.execPath,
      [
        bb.serverLauncher,
        "--data-dir",
        bbData,
        "--server-port",
        String(serverPort),
      ],
      bbEnv,
      join(proofRoot, "bb-server.log"),
    );
    await waitFor(
      "the isolated BB server",
      async () => ((await portOpen(serverPort)) ? true : null),
      120_000,
    );
    await waitFor(
      "the isolated BB CLI",
      async () => {
        try {
          await cli(["project", "list", "--json"]);
          return true;
        } catch {
          return null;
        }
      },
      120_000,
    );
    note("isolated-server", true, {
      dataDir: "this run's proof root",
      port: serverPort,
    });

    daemon = startProcess(
      "bb-host-daemon",
      process.execPath,
      [
        bb.daemonLauncher,
        "join",
        "--server-url",
        serverUrl,
        "--host-daemon-port",
        String(daemonPort),
      ],
      bbEnv,
      join(proofRoot, "bb-host-daemon.log"),
    );
    await waitFor(
      "an enrolled execution machine",
      async () => {
        try {
          const rows = JSON.parse(
            await cli(["machine", "list", "--json"]),
          ) as Array<{ id: string; status?: string }>;
          return rows.find((row) => row.status === "connected") ?? null;
        } catch {
          return null;
        }
      },
      120_000,
    );
    note("isolated-machine", true, "one enrolled machine");

    // Two plugins the operator's BB could already have: an unrelated one, and the
    // locally patched Usage Pace stand-in the route must never touch.
    const standIns = STAND_IN_IDS.map((id) => {
      const directory = join(proofRoot, `plugins/${id}`);
      syntheticPlugin(
        directory,
        id,
        id === "usage-pace" ? "Usage Pace (stand-in)" : "Proof Unrelated",
      );
      return { id, directory };
    });
    for (const standIn of standIns)
      await cli(["plugin", "install", `path:${standIn.directory}`, "--yes"]);
    /**
     * Every plugin except this integration's: its listed row and, for the two stand-ins,
     * every byte of its directory. The route may change none of it.
     */
    const otherPlugins = async () => {
      const listed = JSON.parse(await cli(["plugin", "list", "--json"])) as {
        plugins: Array<{
          id: string;
          version?: string;
          enabled?: boolean;
          status?: string;
          rootDir?: string;
        }>;
      };
      return {
        rows: listed.plugins
          .filter((row) => row.id !== PLUGIN_ID)
          .map((row) => ({
            id: row.id,
            version: row.version,
            enabled: row.enabled,
            status: row.status,
            rootDir: row.rootDir,
          })),
        digests: Object.fromEntries(
          standIns.map((standIn) => [
            standIn.id,
            directoryDigest(standIn.directory),
          ]),
        ),
      };
    };
    const baseline = await otherPlugins();
    for (const standIn of standIns) {
      assert.ok(
        baseline.rows.some((row) => row.id === standIn.id),
        `${standIn.id} is installed before the Nucleus route runs`,
      );
    }
    note("pre-existing-plugins", true, {
      plugins: standIns.map((standIn) => standIn.id),
      files: Object.values(baseline.digests).reduce(
        (count, files) => count + Object.keys(files).length,
        0,
      ),
    });

    // The built plugin, packaged the way the release build ships it: the built bundles,
    // the packaged manifest that names them, and the Nucleus build identity.
    const pluginSource = join(checkout, "hosts", "bb", "plugin");
    await cli(["plugin", "build", pluginSource]);
    const packaged = join(proofRoot, "bb-plugin");
    cpSync(join(pluginSource, "dist"), join(packaged, "dist"), {
      recursive: true,
    });
    const manifest = JSON.parse(
      readFileSync(join(pluginSource, "package.json"), "utf8"),
    );
    writeFileSync(
      join(packaged, "package.json"),
      JSON.stringify(
        {
          ...manifest,
          bb: {
            ...manifest.bb,
            server: "./dist/server.js",
            app: "./dist/app.js",
          },
        },
        null,
        2,
      ) + "\n",
    );
    const identityFile = join(packaged, "nucleus-build.json");
    writeFileSync(
      identityFile,
      JSON.stringify({ buildId, revision: "0".repeat(40) }, null, 2) + "\n",
    );
    note("packaged-plugin", true, {
      files: Object.keys(directoryDigest(packaged)).length,
      pinnedTo: buildId.slice(0, 12),
    });

    // The operator command runs exactly as an operator runs it (the checkout's CLI here,
    // with the private data home the isolated service recorded).
    const nucleus = async (argv: string[]): Promise<unknown> => {
      const { stdout } = await run(
        process.execPath,
        [join(checkout, "bin", "nucleus.mjs"), "bb", ...argv],
        {
          env: { ...bbEnv, NUCLEUS_DATA_HOME: serviceDataDir },
          cwd: checkout,
          maxBuffer: 32 * 1024 * 1024,
          timeout: 240_000,
        },
      );
      return JSON.parse(stdout);
    };

    // 1. install
    const installed = (await nucleus([
      "install",
      "--plugin-dir",
      packaged,
    ])) as {
      action: string;
      plugin: { id: string; version: string; status: string };
      pluginBuildId: string;
      serviceBuildId: string;
      dataDir: string;
    };
    assert.equal(installed.action, "installed");
    assert.equal(installed.plugin.id, PLUGIN_ID);
    assert.notEqual(installed.plugin.status, "error");
    assert.equal(installed.pluginBuildId, buildId);
    assert.equal(installed.serviceBuildId, buildId);
    const listedAfterInstall = JSON.parse(
      await cli(["plugin", "list", "--json"]),
    ) as { plugins: Array<{ id: string }> };
    assert.ok(
      listedAfterInstall.plugins.some((row) => row.id === PLUGIN_ID),
      "BB lists the plugin after install",
    );
    note("install", true, {
      plugin: installed.plugin.id,
      version: installed.plugin.version,
      status: installed.plugin.status,
      pinnedTo: buildId.slice(0, 12),
    });
    assert.deepEqual(
      await otherPlugins(),
      baseline,
      "installing the Nucleus plugin changed no other plugin",
    );

    // 2. status reports a match against the running service
    const matched = (await nucleus(["status"])) as {
      state: string;
      pluginBuildId: string;
      serviceBuildId: string;
    };
    assert.equal(matched.state, "match");
    assert.equal(matched.pluginBuildId, buildId);
    assert.equal(matched.serviceBuildId, buildId);
    note("status-match", true, {
      state: matched.state,
      build: buildId.slice(0, 12),
    });

    // A rebuild from another build reads as behind, without a second install.
    writeFileSync(
      identityFile,
      JSON.stringify(
        { buildId: "f".repeat(16), revision: "0".repeat(40) },
        null,
        2,
      ) + "\n",
    );
    const behind = (await nucleus(["status"])) as {
      state: string;
      detail: string;
    };
    assert.equal(behind.state, "behind");
    assert.match(behind.detail, /nucleus bb install/);
    writeFileSync(
      identityFile,
      JSON.stringify({ buildId, revision: "0".repeat(40) }, null, 2) + "\n",
    );
    note("status-behind", true, { state: behind.state, detail: behind.detail });

    // 3. the install's own configuration is what connects the plugin: no second
    // command, no manual `plugin config`.
    assert.equal(installed.dataDir, serviceDataDir);
    const settings = JSON.parse(
      await cli(["plugin", "config", PLUGIN_ID, "--json"]),
    ) as { values?: { serviceDataDir?: string } };
    assert.equal(
      settings.values?.serviceDataDir,
      serviceDataDir,
      "install wrote the plugin's serviceDataDir setting",
    );
    const hostId = hostIdFromDataDir(bbData);
    await waitFor(
      "the installed plugin to declare its executor role",
      async () => (service.hostExecutorIds().includes(hostId) ? true : null),
      120_000,
    );
    const accepted = service.hostExecutorStatus(hostId);
    assert.equal(accepted?.dataDir, realpathSync(bbData));
    note("pinned-connect", true, { hostId, build: buildId.slice(0, 12) });

    // The same plugin from another build is refused on connect, and health names both
    // builds and the fix — the reason the board reports the host unavailable with.
    writeFileSync(
      identityFile,
      JSON.stringify(
        { buildId: "f".repeat(16), revision: "0".repeat(40) },
        null,
        2,
      ) + "\n",
    );
    await cli(["plugin", "reload", PLUGIN_ID]);
    const refusal = await waitFor(
      "the service to refuse the plugin from another build",
      async () => {
        const health = service.health() as {
          bb?: {
            online: boolean;
            offlineReason: string;
            lastRefusal: { field: string } | null;
          };
        };
        return health.bb?.lastRefusal?.field === "nucleusBuild" &&
          health.bb.online === false
          ? health
          : null;
      },
      120_000,
    );
    const reason = (refusal as { bb: { offlineReason: string } }).bb
      .offlineReason;
    assert.match(reason, /ffffffffffff/);
    assert.match(reason, new RegExp(buildId.slice(0, 12)));
    assert.match(reason, /nucleus bb install/);
    note("pinned-refusal", true, { reason });

    // 4. install again from the correct build restores the connection
    writeFileSync(
      identityFile,
      JSON.stringify({ buildId, revision: "0".repeat(40) }, null, 2) + "\n",
    );
    await nucleus(["install", "--plugin-dir", packaged]);
    await waitFor(
      "the reinstalled plugin to declare again",
      async () => (service.hostExecutorIds().includes(hostId) ? true : null),
      120_000,
    );
    note("reinstall", true, { build: buildId.slice(0, 12) });

    // 5. the other plugins are byte-identical after every command so far
    assert.deepEqual(
      await otherPlugins(),
      baseline,
      "an unrelated plugin and the Usage Pace stand-in are byte-identical",
    );
    note("other-plugins-untouched", true, {
      plugins: standIns.map((standIn) => standIn.id),
    });

    // 6. uninstall removes this plugin and nothing else
    const removed = (await nucleus(["uninstall"])) as {
      action: string;
      plugin: { id: string };
    };
    assert.equal(removed.action, "removed");
    assert.equal(removed.plugin.id, PLUGIN_ID);
    assert.deepEqual(
      await otherPlugins(),
      baseline,
      "uninstalling the Nucleus plugin changed no other plugin",
    );
    const absent = (await nucleus(["status"])) as { state: string };
    assert.equal(absent.state, "not-installed");
    note("uninstall", true, {
      action: removed.action,
      plugins: baseline.rows.length,
    });

    // 7. a plugin with ID nucleus that is not a Nucleus build is refused by name for
    // both install and uninstall, and left exactly as it was.
    const namesake = join(proofRoot, "namesake");
    mkdirSync(join(namesake, "dist"), { recursive: true });
    writeFileSync(
      join(namesake, "package.json"),
      JSON.stringify(
        {
          name: "bb-plugin-nucleus",
          version: "0.0.9",
          private: true,
          type: "module",
          engines: { bb: ">=0.49", bbPluginSdk: ">=0.6.132" },
          bb: {
            name: "Namesake",
            description: "A plugin that shares the ID, installed by the proof.",
            branding: { icon: "Boxes" },
            server: "./dist/server.js",
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(namesake, "dist", "server.js"),
      "export default async function plugin() {}\n",
    );
    await cli(["plugin", "install", `path:${namesake}`, "--yes"]);
    const namesakeDigest = directoryDigest(namesake);
    const refusedInstall = await nucleus(["install"]).then(
      () => null,
      (error: Error) => error.message,
    );
    const refusedUninstall = await nucleus(["uninstall"]).then(
      () => null,
      (error: Error) => error.message,
    );
    for (const [step, message] of [
      ["install", refusedInstall],
      ["uninstall", refusedUninstall],
    ] as const) {
      assert.ok(message, `${step} refuses the namesake`);
      assert.match(message, /not a Nucleus build/);
      assert.ok(
        message.includes(namesake),
        `${step} names the namesake directory`,
      );
    }
    assert.deepEqual(
      directoryDigest(namesake),
      namesakeDigest,
      "the namesake's files are untouched",
    );
    assert.ok(
      (await cli(["plugin", "list", "--json"])).includes(PLUGIN_ID),
      "the namesake is still installed",
    );
    await cli(["plugin", "uninstall", PLUGIN_ID]);
    const afterNamesake = (await nucleus(["status"])) as { state: string };
    assert.equal(afterNamesake.state, "not-installed");
    note("namesake-refused", true, {
      install: lastLine(refusedInstall),
      uninstall: lastLine(refusedUninstall),
    });

    // 8. an unrelated plugin directory is never handed to BB's install, whether it is
    // passed explicitly or found in place of the packaged plugin.
    const unrelated = await nucleus([
      "install",
      "--plugin-dir",
      standIns[0]!.directory,
    ]).then(
      () => null,
      (error: Error) => error.message,
    );
    assert.ok(unrelated, "install refuses an unrelated plugin directory");
    assert.match(unrelated, /not the Nucleus BB plugin package/);
    const stillThere = JSON.parse(await cli(["plugin", "list", "--json"])) as {
      plugins: Array<{ id: string }>;
    };
    assert.ok(
      !stillThere.plugins.some((row) => row.id === PLUGIN_ID),
      "the refused install left no plugin with ID nucleus installed",
    );
    assert.deepEqual(
      await otherPlugins(),
      baseline,
      "the refused installs changed no other plugin",
    );
    note("unrelated-refused", true, { detail: lastLine(unrelated) });

    writeFileSync(
      join(proofRoot, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    note("evidence", true, {
      retainedIn: "this run's scratch root (removed at release)",
    });
    console.log("\nAll phase-7 install-route proof steps passed.");
  } catch (error) {
    writeFileSync(
      join(proofRoot, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    throw error;
  } finally {
    await service.stop().catch(() => {});
    if (!keep) {
      await stopProcess(daemon);
      await stopProcess(server);
    } else {
      console.log(
        `[keep] BB processes left running: bb-server pid ${server?.child.pid ?? "?"}, host-daemon pid ${daemon?.child.pid ?? "?"}`,
      );
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  });
}

export { main };
