import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ChildProcess, spawn } from "node:child_process";
import { socketFixtureRoot } from "./support/socket-fixture";
import { bbCommand } from "../bin/bb-plugin";
import {
  BB_PLUGIN_BUILD_FILE,
  BB_PLUGIN_ID,
  BB_PLUGIN_PACKAGE_DIR,
} from "../shared/bb-plugin-build";
import {
  BB_PLUGIN_ROLL_FILE,
  bbPluginRollNote,
  bbPluginRollSchema,
  type BbPluginRollRecord,
} from "../shared/bb-plugin-roll";
import { readBbPluginRoll, readServiceRoll } from "../shared/service/discovery";
import { writeServiceRoll } from "../service/transport/identity";
import {
  bbPluginCli,
  bbPluginRoll,
  type BbCommandRun,
} from "../hosts/paseo/plugin/bb-plugin-roll";
import { RollScheduler } from "../hosts/paseo/plugin/roll";
import { BridgeSession } from "../hosts/paseo/plugin/session";
import { bridgeProcessActions } from "../service/install/bridge-process-actions";
import {
  RuntimeHealthProjection,
  type RuntimeHealthContext,
} from "../service/runtime-health";

/**
 * nucleus#1339: a landed service roll keeps BB's installed Nucleus plugin on the
 * build it landed.
 *
 * Twice on 2026-11-18 a roll left the installed plugin at the previous build, the
 * build pin refused it, the BB host showed offline and BB tasks stalled until a
 * planner ran `nucleus bb install`. These tests prove the step against the real
 * `nucleus bb status` / `bb plugin list --json` shapes and the real roll record:
 * an installed plugin that is `behind` is installed and reports `match`; a machine
 * without the plugin issues no install; a plugin that is not this integration's is
 * left alone; a failed install is recorded with its cause and the roll still lands;
 * and health and the roll record both name it. Installing changes no file in the
 * packaged version directory (the #1319 invariant).
 */

const BUILD_A = "a".repeat(64);
const BUILD_B = "b".repeat(64);
const REVISION = "c".repeat(40);

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** A built plugin directory, as the release build packages it under `bb-plugin/`. */
function packagedPlugin(directory: string, buildId = BUILD_A): string {
  writeJson(join(directory, "package.json"), {
    name: "bb-plugin-nucleus",
    version: "0.1.0",
    type: "module",
    bb: { name: "Nucleus", server: "./dist/server.js", app: "./dist/app.js" },
  });
  writeJson(join(directory, "dist", "server.js"), "export {};\n");
  writeJson(join(directory, "dist", "server.meta.json"), {
    pluginId: BB_PLUGIN_ID,
  });
  writeJson(join(directory, "dist", "app.js"), "export default {};\n");
  writeJson(join(directory, BB_PLUGIN_BUILD_FILE), {
    buildId,
    revision: REVISION,
  });
  return directory;
}

/** A compiled version root: the two entries `bbPluginCli` requires. */
function versionRoot(): string {
  const root = socketFixtureRoot("bb-version-");
  mkdirSync(join(root, "runtime"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "runtime", "node"), "#!/bin/sh\n");
  writeFileSync(join(root, "bin", "nucleus.mjs"), "// the installed CLI\n");
  packagedPlugin(join(root, BB_PLUGIN_PACKAGE_DIR));
  return root;
}

/** A BB data home whose service identity names the build the roll landed. */
function dataHomeWithService(buildId: string | null): string {
  const directory = socketFixtureRoot("bb-data-");
  if (buildId) {
    writeJson(join(directory, "queue-service.json"), {
      protocolVersion: 1,
      buildId,
      socketPath: join(directory, "queue-service.sock"),
      credential: "d".repeat(64),
      pid: 4321,
      startedAt: "2026-11-18T00:00:00.000Z",
    });
  }
  return directory;
}

interface FakeBb {
  exec: (args: string[]) => string;
  commands: string[][];
  values: Record<string, string>;
  failInstall?: string;
}

const rowFor = (rootDir: string) => ({
  id: BB_PLUGIN_ID,
  version: "0.1.0",
  enabled: true,
  status: "ok",
  rootDir,
});

/**
 * A `bb` CLI that lists, installs, configures, reloads and uninstalls, exactly as
 * `test/bb-plugin-install.test.ts` fakes it, so these tests run the real route
 * (`bbCommand`) and the real `bb plugin list --json` shape.
 */
function fakeBb(list: () => Array<Record<string, unknown>>): FakeBb {
  const commands: string[][] = [];
  const values: Record<string, string> = {};
  const fake: FakeBb = {
    commands,
    values,
    exec: (args: string[]) => {
      commands.push(args);
      const plugins = list();
      if (args[1] === "list") return JSON.stringify({ plugins });
      if (args[1] === "install") {
        if (fake.failInstall) throw new Error(fake.failInstall);
        const source = args[2] ?? "";
        const rootDir = source.startsWith("path:")
          ? source.slice("path:".length)
          : source;
        // BB rebuilds the plugin it installs, in the copy it was given.
        writeFileSync(
          join(rootDir, "dist", "app.js"),
          "BB rebuilt this plugin\n",
        );
        const existing = plugins.findIndex((row) => row.id === BB_PLUGIN_ID);
        if (existing === -1) plugins.push(rowFor(rootDir));
        else plugins[existing] = rowFor(rootDir);
        return "";
      }
      if (args[1] === "config") {
        if (args[3] === "set") {
          values[args[4]!] = args[5]!;
          return `${args[4]} = ${JSON.stringify(args[5])}  (string)\n`;
        }
        return JSON.stringify({
          ok: true,
          schema: { serviceDataDir: { type: "string", default: "" } },
          values: { serviceDataDir: "", ...values },
        });
      }
      if (args[1] === "reload") return "";
      if (args[1] === "uninstall") {
        const at = plugins.findIndex((row) => row.id === args[2]);
        if (at !== -1) plugins.splice(at, 1);
        return "";
      }
      throw new Error(`unexpected bb command: ${args.join(" ")}`);
    },
  };
  return fake;
}

interface Recorder {
  run: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<BbCommandRun>;
  commands: string[][];
  envs: NodeJS.ProcessEnv[];
}

/**
 * The step's own command seam, answered by the real `nucleus bb` route: the
 * arguments after the CLI entry are handed to `bbCommand`, which prints the JSON
 * the installed command would print, and a thrown refusal becomes the exit status
 * and stderr a real subprocess would produce.
 */
function routeRunner(input: {
  packageRoot: string;
  dataDir: string;
  exec: (args: string[]) => string;
}): Recorder {
  const commands: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  return {
    commands,
    envs,
    run: async (_command, args, options) => {
      // The step appends `bb <verb>` to the CLI entry: the route is given `<verb>`.
      const [bb, verb, ...rest] = args.slice(-2);
      assert.equal(bb, "bb", "the step runs the CLI's own bb route");
      commands.push([bb!, verb!, ...rest]);
      envs.push(options.env);
      try {
        const answer = bbCommand(verb, rest, {
          exec: input.exec,
          dataDir: input.dataDir,
          packageRoot: input.packageRoot,
        });
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify(answer),
          stderr: "",
        };
      } catch (error) {
        return {
          status: 1,
          signal: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/** Every file under one directory, as bytes: a version directory must not change. */
function treeBytes(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (at: string, prefix = "") => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path, name);
      else
        files[name] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
    }
  };
  visit(directory);
  return files;
}

test("a landed roll installs the BB plugin BB reports behind, which then reports match", async () => {
  const packageRoot = versionRoot();
  const dataDir = dataHomeWithService(BUILD_A);
  // The operator's BB carries the Nucleus plugin from an earlier build.
  const plugins: Array<Record<string, unknown>> = [
    rowFor(join(dataDir, "bb-plugin-install", BB_PLUGIN_ID)),
  ];
  writeJson(
    join(dataDir, "bb-plugin-install", BB_PLUGIN_ID, BB_PLUGIN_BUILD_FILE),
    { buildId: BUILD_B, revision: REVISION },
  );
  writeJson(join(dataDir, "bb-plugin-install", BB_PLUGIN_ID, "package.json"), {
    name: "bb-plugin-nucleus",
    version: "0.1.0",
    bb: { server: "./dist/server.js" },
  });
  mkdirSync(join(dataDir, "bb-plugin-install", BB_PLUGIN_ID, "dist"), {
    recursive: true,
  });
  writeFileSync(
    join(dataDir, "bb-plugin-install", BB_PLUGIN_ID, "dist", "server.js"),
    "export {};\n",
  );
  const bb = fakeBb(() => plugins);
  const runner = routeRunner({ packageRoot, dataDir, exec: bb.exec });
  const before = treeBytes(packageRoot);

  const record = await bbPluginRoll({
    packageRoot,
    dataDir,
    buildId: BUILD_A,
    run: runner.run,
  });

  assert.equal(record?.action, "installed");
  assert.equal(record?.state, "match");
  assert.equal(record?.buildId, BUILD_A);
  assert.equal(
    bb.values.serviceDataDir,
    dataDir,
    "the plugin can reach the service it now matches",
  );
  assert.deepEqual(
    runner.commands,
    [
      ["bb", "status"],
      ["bb", "install"],
      ["bb", "status"],
    ],
    "the step reports first, installs only what BB says is behind, then confirms it",
  );
  assert.ok(
    bb.commands.every((args) => !args.includes("usage-pace")),
    "no command names another installed plugin",
  );
  assert.deepEqual(
    treeBytes(packageRoot),
    before,
    "the installed version directory is untouched (#1319)",
  );
  assert.match(
    bbPluginRollNote(record!),
    /installed the BB plugin for this build/,
  );
});

test("a machine whose BB has no Nucleus plugin is untouched: no install is attempted", async () => {
  const packageRoot = versionRoot();
  const dataDir = dataHomeWithService(BUILD_A);
  const plugins: Array<Record<string, unknown>> = [];
  const bb = fakeBb(() => plugins);
  const runner = routeRunner({ packageRoot, dataDir, exec: bb.exec });

  const record = await bbPluginRoll({
    packageRoot,
    dataDir,
    buildId: BUILD_A,
    run: runner.run,
  });

  assert.equal(record?.action, "skipped");
  assert.equal(record?.state, "not-installed");
  assert.deepEqual(
    runner.commands,
    [["bb", "status"]],
    "status only: nothing was installed",
  );
  assert.ok(bb.commands.every((args) => args[1] !== "install"));
  assert.equal(
    bbPluginRollNote(record!),
    "",
    "an untouched machine adds no roll note",
  );
});

test("a plugin that is not this integration's is left alone, and no install is attempted", async () => {
  const packageRoot = versionRoot();
  const dataDir = dataHomeWithService(BUILD_A);
  // A developer's checkout install: the Nucleus package, no build identity.
  const checkout = socketFixtureRoot("bb-checkout-");
  writeJson(join(checkout, "package.json"), {
    name: "bb-plugin-nucleus",
    version: "0.1.0",
    bb: { server: "./dist/server.js" },
  });
  mkdirSync(join(checkout, "dist"), { recursive: true });
  writeFileSync(join(checkout, "dist", "server.js"), "export {};\n");
  const plugins: Array<Record<string, unknown>> = [rowFor(checkout)];
  const bb = fakeBb(() => plugins);
  const runner = routeRunner({ packageRoot, dataDir, exec: bb.exec });

  const record = await bbPluginRoll({
    packageRoot,
    dataDir,
    buildId: BUILD_A,
    run: runner.run,
  });

  assert.equal(record?.action, "skipped");
  assert.equal(record?.state, "unrecognised");
  assert.deepEqual(runner.commands, [["bb", "status"]]);
  assert.deepEqual(
    plugins.map((row) => row.rootDir),
    [checkout],
    "the operator's own install is not replaced",
  );
});

test("a failed install keeps the roll landed and names its cause", async () => {
  const packageRoot = versionRoot();
  const dataDir = dataHomeWithService(BUILD_A);
  const plugins: Array<Record<string, unknown>> = [
    rowFor(join(dataDir, "bb-plugin-install", BB_PLUGIN_ID)),
  ];
  writeJson(
    join(dataDir, "bb-plugin-install", BB_PLUGIN_ID, BB_PLUGIN_BUILD_FILE),
    { buildId: BUILD_B, revision: REVISION },
  );
  writeJson(join(dataDir, "bb-plugin-install", BB_PLUGIN_ID, "package.json"), {
    name: "bb-plugin-nucleus",
    version: "0.1.0",
    bb: { server: "./dist/server.js" },
  });
  mkdirSync(join(dataDir, "bb-plugin-install", BB_PLUGIN_ID, "dist"), {
    recursive: true,
  });
  writeFileSync(
    join(dataDir, "bb-plugin-install", BB_PLUGIN_ID, "dist", "server.js"),
    "export {};\n",
  );
  const bb = fakeBb(() => plugins);
  bb.failInstall = "bb plugin install refused: the plugin build failed";
  const runner = routeRunner({ packageRoot, dataDir, exec: bb.exec });

  const record = await bbPluginRoll({
    packageRoot,
    dataDir,
    buildId: BUILD_A,
    run: runner.run,
  });

  assert.equal(record?.action, "failed");
  assert.equal(record?.state, "behind");
  assert.match(record!.detail, /nucleus bb install exit 1/);
  assert.match(record!.detail, /the plugin build failed/);
  assert.match(bbPluginRollNote(record!), /the BB plugin was not updated/);
});

test("a version root with no compiled CLI, or a BB that cannot answer, runs nothing", async () => {
  const dataDir = dataHomeWithService(BUILD_A);
  const bare = socketFixtureRoot("bb-bare-");
  assert.equal(bbPluginCli(bare), null);
  const runs: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    runs.push(args);
    return {
      status: 1,
      signal: null,
      stdout: "",
      stderr: "no installed BB was found",
    };
  };
  const source = await bbPluginRoll({
    packageRoot: bare,
    dataDir,
    buildId: BUILD_A,
    run,
  });
  assert.equal(
    source,
    null,
    "a checkout ships no compiled command, so the step steps aside",
  );
  assert.deepEqual(runs, []);

  const unreadable = await bbPluginRoll({
    packageRoot: versionRoot(),
    dataDir,
    buildId: BUILD_A,
    run,
  });
  assert.equal(
    unreadable,
    null,
    "a BB this host cannot run is left exactly as it was",
  );
});

/** A `spawn` that records what a landed roll asked for and starts nothing. */
function recorderSpawn(spawned: Array<{ command: string; args: string[] }>) {
  return ((command: string, args: string[]) => {
    spawned.push({ command, args });
    return { on() {}, unref() {} } as unknown as ChildProcess;
  }) as unknown as typeof spawn;
}

/**
 * One roll scheduler over a fixture data home, with no service: enough to land a
 * roll record and observe the BB plugin step every landed roll runs.
 */
function landedRollFixture(input: {
  step: (request: {
    packageRoot: string;
    dataDir: string;
    buildId: string;
  }) => Promise<BbPluginRollRecord | null>;
}) {
  const dataDir = dataHomeWithService(BUILD_A);
  const spawned: Array<{ command: string; args: string[] }> = [];
  const sourcePath = versionRoot();
  const session = new BridgeSession(BUILD_A, BUILD_B, sourcePath, REVISION);
  const processActions = {
    ...bridgeProcessActions,
    spawn: recorderSpawn(spawned),
  };
  const scheduler = new RollScheduler({
    options: {
      processActions,
      dataDir,
      bbPluginRoll: input.step,
      reloadPluginCommand: () => ({
        command: "paseo",
        args: ["plugin", "reload", "nucleus"],
      }),
    },
    dataDir,
    session,
    processActions,
    ensure: async () => {
      throw new Error("a landed roll never spawns here");
    },
  });
  return { scheduler, dataDir, spawned, sourcePath, session };
}

test("a landed roll writes the BB step where health reads it and names a failure on the roll", async () => {
  const failure = {
    at: "2026-11-18T09:00:00.000Z",
    buildId: BUILD_A,
    action: "failed" as const,
    state: "behind",
    detail:
      "nucleus bb install exit 1: bb plugin install refused: the plugin build failed",
  };
  const { scheduler, dataDir, spawned } = landedRollFixture({
    step: async () => failure,
  });
  writeServiceRoll(dataDir, {
    status: "replacing",
    fromBuild: BUILD_B,
    toBuild: BUILD_A,
    digest: REVISION,
    at: "2026-11-18T08:59:00.000Z",
    detail: "Main build and startup proof verified; replacing the service",
    deferrals: [],
  });

  await scheduler.settleLandedRoll(BUILD_A);

  const roll = readServiceRoll(dataDir)!;
  assert.equal(roll.status, "rolled", "the roll still lands");
  assert.equal(roll.toBuild, BUILD_A);
  assert.match(
    roll.detail,
    /the BB plugin was not updated \(behind: nucleus bb install exit 1/,
  );
  assert.deepEqual(
    readBbPluginRoll(dataDir),
    failure,
    "health reads the same record",
  );
  assert.equal(
    bbPluginRollSchema.parse(readBbPluginRoll(dataDir)).action,
    "failed",
  );
  assert.equal(spawned.length, 1, "the landed roll still reloads the plugin");
  assert.deepEqual(spawned[0]!.args.slice(-3), ["plugin", "reload", "nucleus"]);
});

test("a landed roll that installed the BB plugin says so, and a step that throws never unlands the roll", async () => {
  const installed = {
    at: "2026-11-18T10:00:00.000Z",
    buildId: BUILD_A,
    action: "installed" as const,
    state: "match",
    detail: `installed build ${BUILD_A.slice(0, 12)}, which matches the running service`,
  };
  const first = landedRollFixture({ step: async () => installed });
  writeServiceRoll(first.dataDir, {
    status: "replacing",
    fromBuild: BUILD_B,
    toBuild: BUILD_A,
    digest: REVISION,
    at: "2026-11-18T09:59:00.000Z",
    detail: "replacing",
    deferrals: [],
  });
  await first.scheduler.settleLandedRoll(BUILD_A);
  assert.match(
    readServiceRoll(first.dataDir)!.detail,
    /installed the BB plugin for this build \(match\)/,
  );
  assert.deepEqual(readBbPluginRoll(first.dataDir), installed);

  const second = landedRollFixture({
    step: async () => {
      throw new Error("the command seam lost its child");
    },
  });
  writeServiceRoll(second.dataDir, {
    status: "replacing",
    fromBuild: BUILD_B,
    toBuild: BUILD_A,
    digest: REVISION,
    at: "2026-11-18T10:01:00.000Z",
    detail: "replacing",
    deferrals: [],
  });
  await second.scheduler.settleLandedRoll(BUILD_A);
  const roll = readServiceRoll(second.dataDir)!;
  assert.equal(
    roll.status,
    "rolled",
    "a broken step is recorded, never a failed roll",
  );
  assert.match(
    roll.detail,
    /the BB plugin step could not run: the command seam lost its child/,
  );
  assert.match(readBbPluginRoll(second.dataDir)!.detail, /lost its child/);
});

test("a roll whose BB step is not configured leaves the operator's BB alone", async () => {
  const dataDir = dataHomeWithService(BUILD_A);
  const spawned: Array<{ command: string; args: string[] }> = [];
  const processActions = {
    ...bridgeProcessActions,
    spawn: recorderSpawn(spawned),
  };
  const scheduler = new RollScheduler({
    options: { processActions, dataDir },
    dataDir,
    session: new BridgeSession(BUILD_A, BUILD_B, versionRoot(), REVISION),
    processActions,
    ensure: async () => {
      throw new Error("a landed roll never spawns here");
    },
  });
  writeServiceRoll(dataDir, {
    status: "replacing",
    fromBuild: BUILD_B,
    toBuild: BUILD_A,
    digest: REVISION,
    at: "2026-11-18T10:02:00.000Z",
    detail: "replacing",
    deferrals: [],
  });

  await scheduler.settleLandedRoll(BUILD_A);

  assert.equal(readServiceRoll(dataDir)!.status, "rolled");
  assert.equal(
    existsSync(join(dataDir, BB_PLUGIN_ROLL_FILE)),
    false,
    "no step ran, so there is no record to report",
  );
});

/** The smallest health context: every member the projection reads, nothing else. */
function healthContext(plugins: {
  roll: BbPluginRollRecord | null;
}): RuntimeHealthContext {
  return {
    store: { getMeta: () => undefined, countTasks: () => 0, maintenanceTasks: () => [] },
    engine: { reconciliationSnapshot: () => ({}) },
    lifecycle: {
      phase: "serving",
      ready: true,
      startError: "",
      identityConflict: null,
      bootstrapRunning: false,
      bootstrapStartedAt: null,
      lastStoreAccessAt: null,
      prStateFacts: () => ({}),
    },
    hostRegistry: { known: () => [], primary: () => null, get: () => null },
    t3Host: () => null,
    bb: () => ({
      online: false,
      hosts: [],
      offlineReason: "",
      lastRefusal: null,
    }),
    bbPluginRoll: () => plugins.roll,
    admission: { snapshot: () => ({}) },
    capacityChanges: { state: () => ({ changes: [], effective: {} }) },
    maintenance: { compactionHealth: () => null },
    eventLoopDelay: { report: () => ({}) },
    anyHostConnected: () => false,
    drainProjection: () => ({ drained: false, boundRuns: [] }),
    pluginPresenceFaultMessage: () => "",
    hostSessionId: () => null,
    serveHostRunEndpoint: false,
    hostRunEndpoint: () => null,
    hostRunEndpointError: () => "",
    admissionRpcMetrics: () => null,
  } as unknown as RuntimeHealthContext;
}

test("service health names the landed roll's BB plugin failure and its cause", () => {
  const failure: BbPluginRollRecord = {
    at: "2026-11-18T09:00:00.000Z",
    buildId: BUILD_A,
    action: "failed",
    state: "behind",
    detail:
      "nucleus bb install exit 1: bb plugin install refused: the plugin build failed",
  };
  const health = new RuntimeHealthProjection(
    healthContext({ roll: failure }),
  ).health();
  assert.deepEqual(health.bbPlugin, failure);
  assert.match(health.bbPlugin!.detail, /the plugin build failed/);

  const quiet = new RuntimeHealthProjection(
    healthContext({ roll: null }),
  ).health();
  assert.equal(
    "bbPlugin" in quiet,
    false,
    "a machine the step never ran reports nothing",
  );
});
