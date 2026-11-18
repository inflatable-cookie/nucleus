import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { socketFixtureRoot } from "./support/socket-fixture";
import {
  bbCommand,
  bbPluginStatus,
  installBbPlugin,
  listBbPlugins,
  pluginConfig,
  resolveBbPluginDirectory,
  uninstallBbPlugin,
} from "../bin/bb-plugin";
import {
  BB_PLUGIN_BUILD_FILE,
  BB_PLUGIN_ID,
  BB_PLUGIN_INSTALL_COMMAND,
  BB_PLUGIN_PACKAGE_DIR,
  bbPluginBuildPin,
  nucleusPluginOwnership,
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
 * installs, configures, reloads and removes exactly the plugin with ID `nucleus`; it
 * refuses a namesake it did not build — for install *and* uninstall — and writes
 * nothing; it never hands an unrelated plugin to BB's `plugin install --yes`; `status`
 * reports the installed build against the running service's and says when the plugin
 * cannot connect; the managed copy stays writable so a BB update's own bundle rebuild
 * lands in it, and that rebuild is never a build mismatch (nucleus#1348); and the
 * release build's publication gate fails when the packaged plugin is missing or names
 * another build. The isolated-BB proof (`effigy proof:bb:install`) proves the same
 * commands against a real server.
 */

const BUILD_A = "a".repeat(64);
const BUILD_B = "b".repeat(64);
const REVISION = "c".repeat(40);

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/**
 * A built plugin directory: the release build's package (Nucleus, with its identity
 * file), a checkout's own package (no identity), or a namesake that shares the package
 * name and carries no Nucleus identity.
 */
function builtPlugin(
  directory: string,
  options: { buildId?: string | null; name?: string; pluginId?: string } = {},
): string {
  writeJson(join(directory, "package.json"), {
    name: options.name ?? "bb-plugin-nucleus",
    version: "0.1.0",
    type: "module",
    // BB's install validates that the declared backend entry exists.
    bb: { name: "Nucleus", server: "./dist/server.js", app: "./dist/app.js" },
  });
  writeJson(join(directory, "dist", "server.js"), "export {};\n");
  writeJson(join(directory, "dist", "server.meta.json"), {
    pluginId: options.pluginId ?? BB_PLUGIN_ID,
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

/** Every path in a tree its owner cannot write: the mode BB's own rebuild needs. */
function unwritable(root: string): string[] {
  const found: string[] = [];
  const visit = (at: string) => {
    if ((statSync(at).mode & 0o200) === 0) found.push(at);
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) visit(path);
      else if ((statSync(path).mode & 0o200) === 0) found.push(path);
    }
  };
  visit(root);
  return found;
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

const rowFor = (rootDir: string): Record<string, unknown> => ({
  id: BB_PLUGIN_ID,
  version: "0.1.0",
  enabled: true,
  status: "ok",
  rootDir,
});

interface FakeBb {
  exec: (args: string[]) => string;
  commands: string[][];
  /** The plugin's own settings, as `bb plugin config` would keep them. */
  values: Record<string, string>;
}

/**
 * A `bb` CLI that lists, installs, reads and writes the plugin's settings, reloads and
 * uninstalls, and records every command it was given.
 */
function fakeBb(list: () => Array<Record<string, unknown>>): FakeBb {
  const commands: string[][] = [];
  const values: Record<string, string> = {};
  return {
    commands,
    values,
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
        const row = { ...rowFor(rootDir), version: "0.1.0" };
        if (existing === -1) plugins.push(row);
        else plugins[existing] = row;
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
}

const otherPluginRow = (): Record<string, unknown> => ({
  id: "usage-pace",
  version: "1.2.3",
  enabled: true,
  status: "ok",
  rootDir: "/plugins/usage-pace",
});

test("install writes only the plugin with ID nucleus, then points it at this data home", () => {
  const packageRoot = socketFixtureRoot("bb-package-");
  const pluginDirectory = builtPlugin(join(packageRoot, BB_PLUGIN_PACKAGE_DIR));
  const plugins = [otherPluginRow()];
  const bb = fakeBb(() => plugins);
  const dataDir = dataHomeWithService(BUILD_A);
  const report = installBbPlugin({ exec: bb.exec, dataDir, packageRoot });
  // The install, the setting this plugin needs and the reload name this plugin only.
  assert.deepEqual(
    bb.commands.map((args) => args.slice(0, 3)),
    [
      ["plugin", "list", "--json"],
      [
        "plugin",
        "install",
        `path:${join(dataDir, "bb-plugin-install", BB_PLUGIN_ID)}`,
      ],
      ["plugin", "config", BB_PLUGIN_ID],
      ["plugin", "config", BB_PLUGIN_ID],
      ["plugin", "reload", BB_PLUGIN_ID],
      ["plugin", "list", "--json"],
    ],
  );
  assert.ok(
    bb.commands.every((args) => !args.includes("usage-pace")),
    "no command names another installed plugin",
  );
  assert.equal(
    bb.values.serviceDataDir,
    dataDir,
    "the plugin can reach this service",
  );
  assert.equal(report.action, "installed");
  assert.equal(
    report.pluginDirectory,
    join(dataDir, "bb-plugin-install", BB_PLUGIN_ID),
  );
  assert.notEqual(report.pluginDirectory, pluginDirectory);
  assert.equal(report.pluginBuildId, BUILD_A);
  assert.equal(report.serviceBuildId, BUILD_A);
  assert.equal(report.dataDir, dataDir);
  assert.match(report.detail, new RegExp(shortBuildId(BUILD_A)));
});

test("BB installs and rebuilds an owned copy without changing packaged version files", () => {
  const packageRoot = socketFixtureRoot("bb-version-");
  const source = builtPlugin(join(packageRoot, BB_PLUGIN_PACKAGE_DIR));
  writeJson(join(source, "manifest.json"), {
    files: {
      "dist/app.js": "source-app-digest",
      "dist/app.meta.json": "source-meta-digest",
    },
  });
  const fileBytes = (directory: string): Record<string, string> => {
    const result: Record<string, string> = {};
    const visit = (at: string, prefix = "") => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, entry.name),
          name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(path, name);
        else result[name] = readFileSync(path).toString("base64");
      }
    };
    visit(directory);
    return result;
  };
  const before = fileBytes(source);
  const plugins: Array<Record<string, unknown>> = [];
  const base = fakeBb(() => plugins);
  const bb = {
    ...base,
    exec(args: string[]) {
      const answer = base.exec(args);
      if (args[1] === "install") {
        const installed = args[2]!.slice("path:".length);
        // BB's plugin build writes generated files back into the path it installs.
        writeFileSync(
          join(installed, "dist/app.js"),
          "BB rebuilt this plugin\n",
        );
        writeFileSync(
          join(installed, "dist/app.meta.json"),
          JSON.stringify({ sdkMajor: 99 }),
        );
      }
      return answer;
    },
  };
  const dataDir = dataHomeWithService(BUILD_A);
  const report = installBbPlugin({ exec: bb.exec, dataDir, packageRoot });
  assert.deepEqual(
    fileBytes(source),
    before,
    "the version package, including its manifest, stays byte-identical",
  );
  assert.match(
    readFileSync(join(report.pluginDirectory, "dist/app.js"), "utf8"),
    /BB rebuilt/,
  );
  assert.deepEqual(
    unwritable(report.pluginDirectory),
    [],
    "the installed copy is writable by its owner, so BB can rebuild into it later",
  );
});

test("a BB update's SDK rebuild writes into the installed copy and stays a build match", () => {
  const packageRoot = socketFixtureRoot("bb-update-");
  const source = builtPlugin(join(packageRoot, BB_PLUGIN_PACKAGE_DIR), {
    buildId: BUILD_A,
  });
  const sourceBundle = readFileSync(join(source, "dist/app.js"));
  const plugins: Array<Record<string, unknown>> = [];
  const bb = fakeBb(() => plugins);
  const dataDir = dataHomeWithService(BUILD_A);
  const installed = installBbPlugin({ exec: bb.exec, dataDir, packageRoot });
  const copy = installed.pluginDirectory;

  // BB rebuilt every plugin's frontend on a 0.49 → 0.50.1 update: it stages the new
  // bundle in a fresh directory inside `dist/` and swaps it in. This is the exact shape
  // that failed with `EACCES: permission denied, mkdtemp '.../dist/.stage-…'`.
  const stage = mkdtempSync(join(copy, "dist", ".stage-"));
  writeFileSync(
    join(stage, "app.js"),
    "// rebuilt against plugin SDK 0.6.157\n",
  );
  writeFileSync(
    join(stage, "app.meta.json"),
    JSON.stringify({ sdkVersion: "0.6.157", sdkMajor: 0 }),
  );
  for (const name of ["app.js", "app.meta.json"])
    renameSync(join(stage, name), join(copy, "dist", name));
  rmSync(stage, { recursive: true, force: true });
  assert.match(
    readFileSync(join(copy, "dist/app.js"), "utf8"),
    /rebuilt against plugin SDK/,
    "the rebuild landed in the installed copy",
  );
  assert.equal(
    readBbPluginBuild(copy)?.buildId,
    BUILD_A,
    "a frontend rebuild leaves the Nucleus build identity alone",
  );

  // The bundle is BB's own build output: the status reads the build identity only, and
  // so does the service's own check on the declaring plugin.
  const status = bbPluginStatus({ exec: bb.exec, dataDir, packageRoot });
  assert.equal(status.state, "match");
  assert.equal(status.pluginBuildId, BUILD_A);
  assert.match(status.detail, new RegExp(shortBuildId(BUILD_A)));
  assert.deepEqual(
    bbPluginBuildPin({
      serviceBuildId: BUILD_A,
      serviceCompiled: true,
      pluginBuildId: readBbPluginBuild(copy)?.buildId ?? null,
    }),
    { ok: true },
    "the service accepts the host after BB's rebuild",
  );

  // A reinstall after the rebuild still installs a fresh copy: it never edits the old
  // one in place (nucleus#1319). A file only the rebuild left behind is gone.
  writeFileSync(join(copy, "dist", "rebuilt-only.txt"), "BB's own output\n");
  const reinstalled = installBbPlugin({ exec: bb.exec, dataDir, packageRoot });
  assert.equal(reinstalled.pluginDirectory, copy);
  assert.equal(
    existsSync(join(copy, "dist", "rebuilt-only.txt")),
    false,
    "the reinstall replaced the copy instead of updating it in place",
  );
  assert.deepEqual(
    readFileSync(join(copy, "dist/app.js")),
    sourceBundle,
    "the fresh copy carries the packaged bundle again",
  );
  assert.deepEqual(
    readdirSync(join(copy, "dist")).filter((name) =>
      name.startsWith(".stage-"),
    ),
    [],
    "no staging directory survives the install",
  );
  assert.deepEqual(unwritable(copy), [], "the fresh copy is writable too");
  assert.equal(
    bbPluginStatus({ exec: bb.exec, dataDir, packageRoot }).state,
    "match",
  );
});

test("install refuses a namesake with ID nucleus it did not build and writes nothing", () => {
  const packageRoot = socketFixtureRoot("bb-package-");
  builtPlugin(join(packageRoot, BB_PLUGIN_PACKAGE_DIR));
  // A plugin that is the Nucleus package by name, with ID nucleus, but carries no
  // Nucleus build identity and is not a directory this package ships: the operator's,
  // never ours to replace.
  const foreignRoot = builtPlugin(
    join(socketFixtureRoot("bb-foreign-"), "nucleus"),
    { buildId: null },
  );
  const plugins: Array<Record<string, unknown>> = [rowFor(foreignRoot)];
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
});

test("install never hands an unrelated plugin or a namesake directory to BB", () => {
  const packageRoot = socketFixtureRoot("bb-package-");
  builtPlugin(join(packageRoot, BB_PLUGIN_PACKAGE_DIR), { buildId: null });
  const unrelated = builtPlugin(
    join(socketFixtureRoot("bb-unrelated-"), "other"),
    { name: "bb-plugin-other" },
  );
  const bb = fakeBb(() => [otherPluginRow()]);
  assert.throws(
    () =>
      installBbPlugin({
        exec: bb.exec,
        dataDir: dataHomeWithService(BUILD_A),
        packageRoot,
        pluginDir: unrelated,
      }),
    /not the Nucleus BB plugin package/,
  );
  // A namesake directory: same package name, but no Nucleus build identity, so it is
  // not a plugin this package built.
  const namesake = builtPlugin(
    join(socketFixtureRoot("bb-namesake-"), "nucleus"),
    { buildId: null },
  );
  assert.throws(
    () =>
      installBbPlugin({
        exec: bb.exec,
        dataDir: dataHomeWithService(BUILD_A),
        packageRoot: socketFixtureRoot("bb-package-"),
        pluginDir: namesake,
      }),
    /carries no nucleus-build\.json/,
  );
  // A Nucleus package whose built backend belongs to another plugin id is refused too.
  const wrongBackend = builtPlugin(
    join(socketFixtureRoot("bb-backend-"), "nucleus"),
    { pluginId: "other" },
  );
  assert.throws(
    () =>
      installBbPlugin({
        exec: bb.exec,
        dataDir: dataHomeWithService(BUILD_A),
        packageRoot: socketFixtureRoot("bb-package-"),
        pluginDir: wrongBackend,
      }),
    /built backend for plugin "other"/,
  );
  assert.deepEqual(bb.commands, [], "no bb command ran for a refused source");
});

test("status reports the installed plugin against the running service's build", () => {
  const packageRoot = socketFixtureRoot("bb-package-");
  const installed = builtPlugin(
    join(socketFixtureRoot("bb-status-"), "nucleus"),
    { buildId: BUILD_A },
  );
  const statusFor = (
    rootDir: string,
    buildId: string | null,
    configured: string | null = dataHomeWithService(buildId),
  ) => {
    const bb = fakeBb(() => [rowFor(rootDir)]);
    if (configured) bb.values.serviceDataDir = configured;
    return bbPluginStatus({
      exec: bb.exec,
      dataDir: dataHomeWithService(buildId),
      packageRoot,
    });
  };

  const matching = statusFor(installed, BUILD_A);
  assert.equal(matching.state, "match");
  assert.equal(matching.pluginBuildId, BUILD_A);
  assert.equal(matching.serviceBuildId, BUILD_A);
  assert.equal(matching.plugin?.version, "0.1.0");
  assert.doesNotMatch(matching.detail, /serviceDataDir/);

  const behind = statusFor(installed, BUILD_B);
  assert.equal(behind.state, "behind");
  assert.match(behind.detail, new RegExp(shortBuildId(BUILD_A)));
  assert.match(behind.detail, new RegExp(shortBuildId(BUILD_B)));
  assert.ok(behind.detail.includes(BB_PLUGIN_INSTALL_COMMAND));

  // Installed but never configured to connect is a state the operator can see.
  const unconfigured = statusFor(installed, BUILD_A, null);
  assert.equal(unconfigured.state, "match");
  assert.match(unconfigured.detail, /not configured to connect/);
  assert.equal(unconfigured.serviceDataDir, null);

  const elsewhere = statusFor(
    installed,
    BUILD_A,
    socketFixtureRoot("bb-elsewhere-"),
  );
  assert.match(elsewhere.detail, /configured for another Nucleus data home/);

  const absent = bbPluginStatus({
    exec: fakeBb(() => []).exec,
    dataDir: dataHomeWithService(BUILD_A),
    packageRoot,
  });
  assert.equal(absent.state, "not-installed");
  assert.ok(absent.detail.includes(BB_PLUGIN_INSTALL_COMMAND));

  // A checkout install is one of this package's own directories, so it is ours — and
  // unpinned, because a checkout build carries no Nucleus build identity.
  const checkoutRoot = socketFixtureRoot("bb-checkout-");
  builtPlugin(join(checkoutRoot, "hosts/bb/plugin"), { buildId: null });
  const checkout = bbPluginStatus({
    exec: fakeBb(() => [rowFor(join(checkoutRoot, "hosts/bb/plugin"))]).exec,
    dataDir: dataHomeWithService(BUILD_A),
    packageRoot: checkoutRoot,
  });
  assert.equal(checkout.state, "unpinned");
  assert.equal(checkout.pluginBuildId, null);

  const foreign = builtPlugin(
    join(socketFixtureRoot("bb-status-"), "foreign"),
    { buildId: null },
  );
  const unrecognised = statusFor(foreign, BUILD_A);
  assert.equal(unrecognised.state, "unrecognised");
  assert.match(unrecognised.detail, /refuse to touch it/);
});

test("uninstall removes the plugin with ID nucleus and nothing else", () => {
  const packageRoot = socketFixtureRoot("bb-package-");
  const installed = builtPlugin(
    join(socketFixtureRoot("bb-uninstall-"), "nucleus"),
    { buildId: BUILD_A },
  );
  const plugins: Array<Record<string, unknown>> = [
    otherPluginRow(),
    rowFor(installed),
  ];
  const bb = fakeBb(() => plugins);
  const report = uninstallBbPlugin({
    exec: bb.exec,
    dataDir: dataHomeWithService(BUILD_A),
    packageRoot,
  });
  assert.equal(report.action, "removed");
  assert.deepEqual(
    bb.commands.filter((args) => args[1] !== "list"),
    [["plugin", "uninstall", BB_PLUGIN_ID]],
  );
  assert.ok(bb.commands.every((args) => !args.includes("usage-pace")));
});

test("uninstall removes the BB plugin copy installed under this Nucleus data home", () => {
  const packageRoot = socketFixtureRoot("bb-copy-uninstall-");
  const source = builtPlugin(join(packageRoot, BB_PLUGIN_PACKAGE_DIR));
  const dataDir = dataHomeWithService(BUILD_A);
  const plugins: Array<Record<string, unknown>> = [];
  const bb = fakeBb(() => plugins);
  installBbPlugin({ exec: bb.exec, dataDir, packageRoot });
  const managedCopy = join(dataDir, "bb-plugin-install", BB_PLUGIN_ID);
  assert.equal(existsSync(managedCopy), true);
  const report = uninstallBbPlugin({ exec: bb.exec, dataDir, packageRoot });
  assert.equal(report.action, "removed");
  assert.equal(report.plugin?.rootDir, managedCopy);
  assert.equal(existsSync(managedCopy), false);
  assert.equal(
    existsSync(source),
    true,
    "uninstall leaves the packaged version intact",
  );
});

test("uninstall refuses a namesake with ID nucleus and writes nothing", () => {
  const packageRoot = socketFixtureRoot("bb-package-");
  const foreignRoot = builtPlugin(
    join(socketFixtureRoot("bb-namesake-"), "nucleus"),
    { buildId: null },
  );
  const bb = fakeBb(() => [rowFor(foreignRoot)]);
  assert.throws(
    () =>
      uninstallBbPlugin({
        exec: bb.exec,
        dataDir: dataHomeWithService(BUILD_A),
        packageRoot,
      }),
    (error: Error) =>
      /not a Nucleus build/.test(error.message) &&
      error.message.includes(foreignRoot) &&
      /refusing to remove/.test(error.message),
  );
  assert.deepEqual(
    bb.commands,
    [["plugin", "list", "--json"]],
    "only the read ran",
  );
});

test("uninstall reports an absent plugin without writing one", () => {
  const bb = fakeBb(() => []);
  const report = uninstallBbPlugin({
    exec: bb.exec,
    dataDir: dataHomeWithService(BUILD_A),
    packageRoot: socketFixtureRoot("bb-package-"),
  });
  assert.equal(report.action, "absent");
  assert.deepEqual(bb.commands, [["plugin", "list", "--json"]]);
});

test("ownership reads the build identity, then this package's own directories", () => {
  const packageRoot = socketFixtureRoot("bb-own-");
  const packaged = builtPlugin(join(packageRoot, BB_PLUGIN_PACKAGE_DIR), {
    buildId: BUILD_B,
  });
  assert.deepEqual(nucleusPluginOwnership(packaged, packageRoot), {
    ours: true,
    reason: "it carries the Nucleus build identity",
    buildId: BUILD_B,
  });
  // A previously installed build from another package version is still ours.
  const olderVersion = builtPlugin(
    join(socketFixtureRoot("bb-oldver-"), "bb-plugin"),
    { buildId: BUILD_A },
  );
  assert.equal(
    nucleusPluginOwnership(olderVersion, packageRoot).ours,
    true,
    "a plugin from an earlier Nucleus package stays ours across a roll",
  );
  const checkout = builtPlugin(join(packageRoot, "hosts/bb/plugin"), {
    buildId: null,
  });
  assert.deepEqual(nucleusPluginOwnership(checkout, packageRoot), {
    ours: true,
    reason: "it is this Nucleus package's own plugin directory",
    buildId: null,
  });
  const namesake = builtPlugin(
    join(socketFixtureRoot("bb-namesake-"), "nucleus"),
    { buildId: null },
  );
  assert.equal(nucleusPluginOwnership(namesake, packageRoot).ours, false);
  assert.equal(nucleusPluginOwnership(null, packageRoot).ours, false);
});

test("the built plugin is taken from the package, then the checkout, and a missing build is refused", () => {
  const packaged = socketFixtureRoot("bb-resolve-");
  builtPlugin(join(packaged, BB_PLUGIN_PACKAGE_DIR));
  assert.deepEqual(resolveBbPluginDirectory({ packageRoot: packaged }), {
    directory: join(packaged, BB_PLUGIN_PACKAGE_DIR),
    packaged: true,
    buildId: BUILD_A,
  });

  const checkout = socketFixtureRoot("bb-resolve-");
  builtPlugin(join(checkout, "hosts/bb/plugin"), { buildId: null });
  assert.deepEqual(resolveBbPluginDirectory({ packageRoot: checkout }), {
    directory: join(checkout, "hosts/bb/plugin"),
    packaged: false,
    buildId: null,
  });

  const unbuilt = socketFixtureRoot("bb-resolve-");
  writeJson(join(unbuilt, BB_PLUGIN_PACKAGE_DIR, "package.json"), {
    name: "bb-plugin-nucleus",
    bb: { server: "./dist/server.js" },
  });
  assert.throws(
    () => resolveBbPluginDirectory({ packageRoot: unbuilt }),
    /not the Nucleus BB plugin package|bb plugin build/,
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
  assert.throws(
    () =>
      bbCommand("install", ["--plugin-dir"], {
        packageRoot: socketFixtureRoot("bb-usage-"),
      }),
    /--plugin-dir needs a built plugin directory/,
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
  // The plugin accepts only a build id, exactly as the shared record does.
  writeJson(join(directory, BB_PLUGIN_BUILD_FILE), { buildId: "not-a-build" });
  assert.equal(readNucleusBuild(moduleUrl), null);
  assert.equal(readBbPluginBuild(directory), null);
});

test("the plugin settings read answers null when BB cannot report them", () => {
  assert.deepEqual(
    pluginConfig(() => {
      throw new Error("no server");
    }),
    { serviceDataDir: null },
  );
  assert.deepEqual(
    pluginConfig(() => JSON.stringify({ ok: true, values: {} })),
    { serviceDataDir: null },
  );
  assert.deepEqual(
    pluginConfig(() =>
      JSON.stringify({ ok: true, values: { serviceDataDir: "/data/home" } }),
    ),
    { serviceDataDir: "/data/home" },
  );
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
