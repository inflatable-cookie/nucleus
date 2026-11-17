import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { socketFixtureRoot } from "./support/socket-fixture";
import {
  bbCommand,
  bbPluginStatus,
  installedPluginBuild,
  installBbPlugin,
  listBbPlugins,
  resolveBbPluginDirectory,
  uninstallBbPlugin,
} from "../service/bb-install";
import {
  BB_PLUGIN_BUILD_FILE,
  BB_PLUGIN_ID,
  BB_PLUGIN_INSTALL_COMMAND,
  BB_PLUGIN_PACKAGE_DIR,
  bbPluginBuildPin,
  readBbPluginBuild,
  shortBuildId,
} from "../shared/bb-plugin-build";
import {
  NUCLEUS_BUILD_FILE,
  readNucleusBuild,
} from "../hosts/bb/plugin/build-identity";
import {
  checkPackageBbPlugin,
  bbPluginPackageFiles,
} from "../scripts/check-publication.mjs";

/**
 * Spec 062, phase 7: the operator install route and the build pin.
 *
 * These are the facts a fake `bb` CLI can prove without a BB server: the route
 * installs, reloads and removes exactly the plugin with ID `nucleus`; it refuses a
 * namesake it did not build and writes nothing; `status` reports the installed build
 * against the running service's; and the release build's publication gate fails when
 * the packaged plugin is missing or names another build. The isolated-BB proof
 * (`effigy proof:bb:install`) proves the same commands against a real server.
 */

const BUILD_A = "a".repeat(64);
const BUILD_B = "b".repeat(64);
const REVISION = "c".repeat(40);

function fixture(name: string): string {
  return join(socketFixtureRoot(name), name);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** A built plugin directory as the release build ships it (or a checkout's own). */
function builtPlugin(
  directory: string,
  options: { buildId?: string | null; name?: string } = {},
): string {
  writeJson(join(directory, "package.json"), {
    name: options.name ?? "bb-plugin-nucleus",
    version: "0.1.0",
    type: "module",
    // The packaged manifest names the built bundles; BB's install validates the entries exist.
    bb: { name: "Nucleus", server: "./dist/server.js", app: "./dist/app.js" },
  });
  writeJson(join(directory, "dist", "server.js"), "export {};\n");
  writeJson(join(directory, "dist", "server.meta.json"), {
    pluginId: BB_PLUGIN_ID,
    sdkVersion: "0.6.132",
  });
  writeJson(join(directory, "dist", "app.js"), "export default {};\n");
  writeJson(join(directory, "dist", "app.meta.json"), { sdkMajor: 0 });
  if (options.buildId !== null) {
    writeJson(join(directory, BB_PLUGIN_BUILD_FILE), {
      buildId: options.buildId ?? BUILD_A,
      revision: REVISION,
    });
  }
  return directory;
}

/** A BB data home whose `queue-service.json` names the running service's build. */
function dataHomeWithService(buildId: string | null): string {
  const directory = socketFixtureRoot("bb-service-");
  if (buildId) {
    writeJson(join(directory, "queue-service.json"), {
      protocolVersion: 1,
      buildId,
      socketPath: join(directory, "queue-service.sock"),
      credential: "d".repeat(64),
      pid: 4321,
      startedAt: "2026-11-17T00:00:00.000Z",
    });
  }
  return directory;
}

interface FakeBb {
  exec: (args: string[]) => string;
  commands: string[][];
}

/** A `bb` CLI that lists, installs, reloads and uninstalls, and records every command. */
function fakeBb(list: () => Array<Record<string, unknown>>): FakeBb {
  const commands: string[][] = [];
  return {
    commands,
    exec: (args: string[]) => {
      commands.push(args);
      const plugins = list();
      if (args[1] === "list") return JSON.stringify({ plugins });
      if (args[1] === "install") {
        const source = args[2] ?? "";
        const rootDir = source.startsWith("path:")
          ? source.slice("path:".length)
          : source;
        const existing = plugins.findIndex((row) => row.id === BB_PLUGIN_ID);
        const row = {
          id: BB_PLUGIN_ID,
          version: "0.1.0",
          enabled: true,
          status: "ok",
          rootDir,
        };
        if (existing === -1) plugins.push(row);
        else plugins[existing] = row;
        return "";
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
}

test("install writes only the plugin with ID nucleus, from the built package beside the service", () => {
  const packageRoot = socketFixtureRoot("bb-package-");
  builtPlugin(join(packageRoot, BB_PLUGIN_PACKAGE_DIR));
  const plugins: Array<Record<string, unknown>> = [
    {
      id: "usage-pace",
      version: "1.2.3",
      enabled: true,
      status: "ok",
      rootDir: "/plugins/usage-pace",
    },
  ];
  const bb = fakeBb(() => plugins);
  const dataDir = dataHomeWithService(BUILD_A);
  const report = installBbPlugin({ exec: bb.exec, dataDir, packageRoot });
  // The install and the reload name this plugin and nothing else.
  assert.deepEqual(
    bb.commands.map((args) => args.slice(0, 3)),
    [
      ["plugin", "list", "--json"],
      ["plugin", "install", `path:${join(packageRoot, BB_PLUGIN_PACKAGE_DIR)}`],
      ["plugin", "reload", BB_PLUGIN_ID],
      ["plugin", "list", "--json"],
    ],
  );
  assert.ok(
    bb.commands.every((args) => !args.includes("usage-pace")),
    "no command names another installed plugin",
  );
  assert.equal(report.action, "installed");
  assert.equal(report.pluginBuildId, BUILD_A);
  assert.equal(report.serviceBuildId, BUILD_A);
  assert.match(report.detail, new RegExp(shortBuildId(BUILD_A)));
});

test("install refuses a namesake plugin it did not build and writes nothing", () => {
  const packageRoot = socketFixtureRoot("bb-package-");
  builtPlugin(join(packageRoot, BB_PLUGIN_PACKAGE_DIR));
  const foreignRoot = join(socketFixtureRoot("bb-foreign-"), "nucleus");
  builtPlugin(foreignRoot, { name: "someone-elses-nucleus" });
  const plugins: Array<Record<string, unknown>> = [
    {
      id: BB_PLUGIN_ID,
      version: "9.9.9",
      enabled: true,
      status: "ok",
      rootDir: foreignRoot,
    },
  ];
  const bb = fakeBb(() => plugins);
  assert.throws(
    () =>
      installBbPlugin({
        exec: bb.exec,
        dataDir: dataHomeWithService(BUILD_A),
        packageRoot,
      }),
    (error: Error) =>
      /not a Nucleus build/.test(error.message) &&
      error.message.includes(foreignRoot) &&
      /refusing to overwrite/.test(error.message),
  );
  assert.deepEqual(
    bb.commands,
    [["plugin", "list", "--json"]],
    "only the read ran",
  );
  assert.equal(
    installedPluginBuild(listBbPlugins(bb.exec)[0]!).nucleusPackage,
    false,
  );
});

test("status reports the installed plugin against the running service's build", () => {
  const installed = builtPlugin(
    join(socketFixtureRoot("bb-status-"), "nucleus"),
    { buildId: BUILD_A },
  );
  const rows = (rootDir: string): Array<Record<string, unknown>> => [
    {
      id: BB_PLUGIN_ID,
      version: "0.1.0",
      enabled: true,
      status: "ok",
      rootDir,
    },
  ];

  const matching = bbPluginStatus({
    exec: fakeBb(() => rows(installed)).exec,
    dataDir: dataHomeWithService(BUILD_A),
  });
  assert.equal(matching.state, "match");
  assert.equal(matching.pluginBuildId, BUILD_A);
  assert.equal(matching.serviceBuildId, BUILD_A);
  assert.equal(matching.plugin?.version, "0.1.0");

  const behind = bbPluginStatus({
    exec: fakeBb(() => rows(installed)).exec,
    dataDir: dataHomeWithService(BUILD_B),
  });
  assert.equal(behind.state, "behind");
  assert.match(behind.detail, new RegExp(shortBuildId(BUILD_A)));
  assert.match(behind.detail, new RegExp(shortBuildId(BUILD_B)));
  assert.ok(behind.detail.includes(BB_PLUGIN_INSTALL_COMMAND));

  const absent = bbPluginStatus({
    exec: fakeBb(() => []).exec,
    dataDir: dataHomeWithService(BUILD_A),
  });
  assert.equal(absent.state, "not-installed");
  assert.ok(absent.detail.includes(BB_PLUGIN_INSTALL_COMMAND));

  const checkout = builtPlugin(
    join(socketFixtureRoot("bb-status-"), "checkout"),
    { buildId: null },
  );
  const unpinned = bbPluginStatus({
    exec: fakeBb(() => rows(checkout)).exec,
    dataDir: dataHomeWithService(BUILD_A),
  });
  assert.equal(unpinned.state, "unpinned");
  assert.equal(unpinned.pluginBuildId, null);

  const foreign = builtPlugin(
    join(socketFixtureRoot("bb-status-"), "foreign"),
    { name: "not-nucleus" },
  );
  const unrecognised = bbPluginStatus({
    exec: fakeBb(() => rows(foreign)).exec,
    dataDir: dataHomeWithService(BUILD_A),
  });
  assert.equal(unrecognised.state, "unrecognised");
});

test("uninstall removes the plugin with ID nucleus and nothing else", () => {
  const installed = builtPlugin(
    join(socketFixtureRoot("bb-uninstall-"), "nucleus"),
    { buildId: BUILD_A },
  );
  const plugins: Array<Record<string, unknown>> = [
    {
      id: "usage-pace",
      version: "1.2.3",
      enabled: true,
      status: "ok",
      rootDir: "/plugins/usage-pace",
    },
    {
      id: BB_PLUGIN_ID,
      version: "0.1.0",
      enabled: true,
      status: "ok",
      rootDir: installed,
    },
  ];
  const bb = fakeBb(() => plugins);
  const report = uninstallBbPlugin({
    exec: bb.exec,
    dataDir: dataHomeWithService(BUILD_A),
  });
  assert.equal(report.action, "removed");
  assert.deepEqual(
    bb.commands.filter((args) => args[1] !== "list"),
    [["plugin", "uninstall", BB_PLUGIN_ID]],
  );
  assert.ok(bb.commands.every((args) => !args.includes("usage-pace")));
});

test("uninstall reports an absent plugin without writing one", () => {
  const bb = fakeBb(() => []);
  const report = uninstallBbPlugin({
    exec: bb.exec,
    dataDir: dataHomeWithService(BUILD_A),
  });
  assert.equal(report.action, "absent");
  assert.deepEqual(bb.commands, [["plugin", "list", "--json"]]);
});

test("the built plugin is taken from the package, then the checkout, and a missing build is refused", () => {
  const packaged = socketFixtureRoot("bb-resolve-");
  builtPlugin(join(packaged, BB_PLUGIN_PACKAGE_DIR));
  assert.deepEqual(resolveBbPluginDirectory({ packageRoot: packaged }), {
    directory: join(packaged, BB_PLUGIN_PACKAGE_DIR),
    packaged: true,
  });

  const checkout = socketFixtureRoot("bb-resolve-");
  builtPlugin(join(checkout, "hosts/bb/plugin"));
  assert.deepEqual(resolveBbPluginDirectory({ packageRoot: checkout }), {
    directory: join(checkout, "hosts/bb/plugin"),
    packaged: false,
  });

  const unbuilt = socketFixtureRoot("bb-resolve-");
  writeJson(join(unbuilt, BB_PLUGIN_PACKAGE_DIR, "package.json"), {
    name: "bb-plugin-nucleus",
  });
  assert.throws(
    () => resolveBbPluginDirectory({ packageRoot: unbuilt }),
    /bb plugin build/,
  );
});

test("a command with no bb command: install, status and uninstall answer their usage or their refusal", () => {
  const usage = bbCommand(undefined, [], {
    packageRoot: socketFixtureRoot("bb-usage-"),
  });
  assert.equal(typeof usage, "string");
  assert.ok(typeof usage === "string");
  assert.match(usage, /nucleus bb install/);
  assert.match(usage, /nucleus bb status/);
  assert.match(usage, /nucleus bb uninstall/);
  assert.throws(
    () =>
      bbCommand("frobnicate", [], {
        packageRoot: socketFixtureRoot("bb-usage-"),
      }),
    /install, status or uninstall/,
  );
});

test("the plugin package reads the build file the release build writes, by the same name and shape", () => {
  assert.equal(
    NUCLEUS_BUILD_FILE,
    BB_PLUGIN_BUILD_FILE,
    "one file name, read by both sides",
  );
  const directory = socketFixtureRoot("bb-identity-");
  writeJson(join(directory, BB_PLUGIN_BUILD_FILE), {
    buildId: BUILD_A,
    revision: REVISION,
  });
  const moduleUrl = new URL(`file://${join(directory, "dist", "server.js")}`)
    .href;
  assert.equal(
    readNucleusBuild(moduleUrl),
    BUILD_A,
    "the built layout reads the identity beside dist",
  );
  assert.equal(readBbPluginBuild(directory)?.buildId, BUILD_A);
  // The plugin accepts only a full build id, exactly as the shared record does.
  writeJson(join(directory, BB_PLUGIN_BUILD_FILE), { buildId: "not-a-build" });
  assert.equal(readNucleusBuild(moduleUrl), null);
  assert.equal(readBbPluginBuild(directory), null);
});

test("the build pin refuses another build, names both and the fix, and keeps a source plugin working", () => {
  const pin = (
    serviceBuildId: string,
    pluginBuildId: string | null,
    serviceCompiled = false,
  ) => bbPluginBuildPin({ serviceBuildId, pluginBuildId, serviceCompiled });
  assert.deepEqual(pin(BUILD_A, BUILD_A), { ok: true });
  assert.deepEqual(
    pin(BUILD_A, null),
    { ok: true },
    "a source service pins nothing",
  );
  const compiledUnpinned = pin(BUILD_A, null, true);
  assert.equal(compiledUnpinned.ok, false);
  const mismatch = pin(BUILD_A, BUILD_B);
  assert.equal(mismatch.ok, false);
  if (mismatch.ok) return;
  assert.equal(mismatch.field, "nucleusBuild");
  assert.match(mismatch.reason, new RegExp(shortBuildId(BUILD_B)));
  assert.match(mismatch.reason, new RegExp(shortBuildId(BUILD_A)));
  assert.ok(mismatch.reason.includes(BB_PLUGIN_INSTALL_COMMAND));
});

test("the publication check fails a package that does not ship the built BB plugin", () => {
  const complete = socketFixtureRoot("bb-package-check-");
  builtPlugin(join(complete, BB_PLUGIN_PACKAGE_DIR), { buildId: BUILD_A });
  writeJson(join(complete, "build.json"), {
    buildId: BUILD_A,
    revision: REVISION,
  });
  assert.deepEqual(checkPackageBbPlugin(complete), []);

  const missing = socketFixtureRoot("bb-package-check-");
  writeJson(join(missing, "build.json"), {
    buildId: BUILD_A,
    revision: REVISION,
  });
  const findings = checkPackageBbPlugin(missing);
  for (const file of bbPluginPackageFiles) {
    assert.ok(
      findings.some((finding) =>
        finding.startsWith(`${file}: the packaged BB plugin is missing it`),
      ),
      `${file} is required`,
    );
  }

  const stale = socketFixtureRoot("bb-package-check-");
  builtPlugin(join(stale, BB_PLUGIN_PACKAGE_DIR), { buildId: BUILD_B });
  writeJson(join(stale, "build.json"), {
    buildId: BUILD_A,
    revision: REVISION,
  });
  assert.deepEqual(checkPackageBbPlugin(stale), [
    "bb-plugin/nucleus-build.json: the packaged BB plugin names a different build than build.json",
  ]);
});
