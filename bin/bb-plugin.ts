/**
 * The operator install route for this integration's BB plugin (Spec 062, phase 7).
 *
 * `nucleus bb install` wraps BB's own CLI: it installs exactly one plugin — the one
 * with ID `nucleus` — from the built plugin shipped beside the Nucleus package, and
 * reloads it. `nucleus bb status` reports the installed plugin against the running
 * service's build. `nucleus bb uninstall` removes that same plugin and nothing else.
 *
 * Three rules decide the refusals:
 *
 * - the route touches only the plugin with ID `nucleus`. Every other plugin,
 *   including a locally patched one loaded from thread storage, is left alone: no
 *   command this file issues names another ID, and BB's own routes are per-plugin;
 * - a plugin with ID `nucleus` that is not ours is refused by name for install *and*
 *   uninstall, never overwritten and never removed. "Ours" is the build identity the
 *   release build writes (`nucleus-build.json`) or one of this package's own plugin
 *   directories — not the plugin ID, and not the package name, which a namesake
 *   shares (`shared/bb-plugin-build.ts`);
 * - the install source must be a built Nucleus backend: the Nucleus plugin package
 *   whose `dist/server.js` belongs to plugin ID `nucleus`. An unrelated plugin, or a
 *   namesake, is never handed to BB's `plugin install --yes`.
 *
 * After installing, the route writes the one setting the plugin needs to connect —
 * `serviceDataDir`, this CLI's own Nucleus data home — through BB's own
 * `plugin config`, then reloads. Without it the plugin loads and waits: installed but
 * never connected, which is the half-working state this route exists to prevent.
 *
 * Nothing here writes into BB's data directory directly: every write is a `bb`
 * command, and the plugin is pinned to the service build by the identity file the
 * release build writes into the package.
 *
 * The managed copy stays writable by its owner (nucleus#1348). BB rebuilds a plugin's
 * frontend bundle into `dist/` whenever its SDK changes, and a BB update does exactly
 * that to every installed plugin; a read-only copy failed that rebuild with `EACCES`
 * on `mkdtemp` inside `dist/`, leaving the plugin loaded with no frontend until an
 * operator ran `chmod -R u+w` and reloaded it by hand. Integrity is the build identity
 * (`nucleus-build.json` against the running service), never file modes, so a bundle BB
 * rebuilt itself is never a mismatch.
 *
 * It lives under `bin/` because the CLI may import `bin/` and `shared/` only (the
 * folder-import boundary), while the package layout, the identity file and the pin
 * decision are `shared/` facts.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { dataHome } from "../shared/data-home.mjs";
import { findBbCli } from "../shared/bb-cli.mjs";
import { readServiceInfo } from "../shared/service/discovery";
import {
  BB_PLUGIN_BUILD_FILE,
  BB_PLUGIN_ID,
  BB_PLUGIN_INSTALL_COMMAND,
  bbPluginPackagePaths,
  nucleusPluginOwnership,
  nucleusPluginSource,
  readBbPluginBuild,
  shortBuildId,
} from "../shared/bb-plugin-build";

/** One row of `bb plugin list --json`; only the fields this route reads. */
export interface BbPluginRow {
  id: string;
  version: string | null;
  enabled: boolean | null;
  status: string | null;
  rootDir: string | null;
}

export interface BbCommandContext {
  /** Run one `bb` command and return its stdout. Injected by tests. */
  exec: (args: string[]) => string;
  /** The Nucleus data home whose service identity names the running build. */
  dataDir: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/** BB is allowed to build its install source, so never hand it a version package. */
function ownedPluginDirectory(dataDir: string): string {
  return join(dataDir, "bb-plugin-install", BB_PLUGIN_ID);
}

/** A mode with these bits set is writable, and reachable for a directory, by its owner. */
const OWNER_WRITE = 0o200;
const OWNER_WRITE_TRAVERSE = 0o300;

/** Add owner mode bits, keeping whatever else the source carried. */
function addOwnerMode(path: string, bits: number): void {
  const mode = statSync(path).mode & 0o7777;
  if ((mode & bits) !== bits) chmodSync(path, mode | bits);
}

/**
 * Make a tree writable by its owner, which is the same user BB runs as: BB's own
 * rebuild of a plugin's frontend stages files in `dist/` and swaps them in, and a
 * directory it cannot write fails that rebuild with `EACCES` (nucleus#1348). Symlinks
 * are never followed, so nothing outside the copy is chmodded.
 */
function grantOwnerWrite(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      grantOwnerWrite(path);
      addOwnerMode(path, OWNER_WRITE_TRAVERSE);
    } else if (entry.isFile()) addOwnerMode(path, OWNER_WRITE);
  }
  addOwnerMode(root, OWNER_WRITE_TRAVERSE);
}

/**
 * Loosen a tree enough to remove it. The installed copy is owner-writable now, but a
 * copy an earlier Nucleus made is `0555`/`0444`, and its directories cannot be
 * emptied while they are. This is only ever a removal path, never a post-install step.
 */
function makeTreeRemovable(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) makeTreeRemovable(path);
    else if (entry.isFile()) chmodSync(path, 0o600);
  }
  chmodSync(root, 0o700);
}

function prepareBbPluginCopy(source: string, dataDir: string): string {
  const destination = ownedPluginDirectory(dataDir);
  mkdirSync(join(dataDir, "bb-plugin-install"), {
    recursive: true,
    mode: 0o700,
  });
  try {
    if (lstatSync(destination).isSymbolicLink()) {
      throw new Error(
        `refusing to replace BB plugin copy symlink at ${destination}`,
      );
    }
    makeTreeRemovable(destination);
    rmSync(destination, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  cpSync(source, destination, { recursive: true, dereference: false });
  // BB installs and builds this copy, and every later BB update rebuilds its frontend
  // bundle into `dist/`: the owner must be able to write it, whoever packed the source.
  grantOwnerWrite(destination);
  return destination;
}

function removeBbPluginCopy(directory: string): void {
  try {
    if (lstatSync(directory).isSymbolicLink()) return;
    makeTreeRemovable(directory);
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function bbExec(cli: string, env: NodeJS.ProcessEnv = process.env) {
  return (args: string[]): string =>
    execFileSync(cli, args, {
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: DEFAULT_TIMEOUT_MS,
    });
}

/** The installed plugins BB reports, or a refusal naming what its CLI answered. */
export function listBbPlugins(exec: BbCommandContext["exec"]): BbPluginRow[] {
  const output = exec(["plugin", "list", "--json"]);
  let answer: unknown;
  try {
    answer = JSON.parse(output);
  } catch {
    throw new Error(
      "bb plugin list --json did not answer JSON; check the installed BB and try again",
    );
  }
  const record = answer as { plugins?: unknown; error?: { message?: unknown } };
  if (!Array.isArray(record?.plugins)) {
    const reason =
      typeof record?.error?.message === "string"
        ? record.error.message
        : "no plugin list";
    throw new Error(`bb plugin list refused: ${reason}`);
  }
  return (record.plugins as Array<Record<string, unknown>>).map((row) => ({
    id: typeof row.id === "string" ? row.id : "",
    version: typeof row.version === "string" ? row.version : null,
    enabled: typeof row.enabled === "boolean" ? row.enabled : null,
    status: typeof row.status === "string" ? row.status : null,
    rootDir: typeof row.rootDir === "string" ? row.rootDir : null,
  }));
}

/** The one row this route owns; a plugin with any other ID is never read or written. */
export const nucleusRow = (rows: BbPluginRow[]) =>
  rows.find((row) => row.id === BB_PLUGIN_ID) ?? null;

/**
 * The built plugin directory to install: an explicit directory (a built plugin under
 * test), the copy shipped beside the Nucleus package, or the checkout's own package in
 * a source run. Every candidate is checked as a Nucleus build before it is returned,
 * so an unrelated plugin, a namesake or an unbuilt directory never reaches BB's
 * install.
 */
export function resolveBbPluginDirectory(input: {
  packageRoot: string;
  pluginDir?: string | null;
}): { directory: string; packaged: boolean; buildId: string | null } {
  const candidates = input.pluginDir
    ? [{ directory: input.pluginDir, packaged: true }]
    : bbPluginPackagePaths(input.packageRoot).map((directory, index) => ({
        directory,
        packaged: index === 0,
      }));
  const found = candidates.filter((candidate) =>
    existsSync(join(candidate.directory, "package.json")),
  );
  if (!found.length) {
    throw new Error(
      `no BB plugin was found beside this Nucleus package (looked in ${candidates.map((item) => item.directory).join(" and ")}); reinstall the Nucleus package or pass --plugin-dir with a built plugin`,
    );
  }
  for (const candidate of found) {
    const source = nucleusPluginSource(candidate.directory);
    if (!source.ok) throw new Error(source.reason);
    const buildId = readBbPluginBuild(candidate.directory)?.buildId ?? null;
    // The packaged plugin and an explicit directory must name the Nucleus build they
    // came from: that record is what the service pins the connection to, and what
    // tells our plugin from a namesake that shares both the ID and the package name.
    if (candidate.packaged && buildId === null) {
      throw new Error(
        `${candidate.directory} carries no ${BB_PLUGIN_BUILD_FILE} naming the Nucleus build it came from; it is not a plugin this package built, so ${BB_PLUGIN_INSTALL_COMMAND} will not install it`,
      );
    }
    return { ...candidate, buildId };
  }
  throw new Error(
    `no Nucleus BB plugin was found beside this Nucleus package (looked in ${found.map((item) => item.directory).join(" and ")})`,
  );
}

export interface BbInstallReport {
  action: "installed";
  plugin: BbPluginRow;
  pluginBuildId: string | null;
  serviceBuildId: string | null;
  pluginDirectory: string;
  /** The Nucleus data home this route wrote into the plugin's `serviceDataDir` setting. */
  dataDir: string;
  detail: string;
}

/**
 * Install the packaged plugin under ID `nucleus`, point it at this CLI's Nucleus data
 * home, then reload that plugin.
 *
 * A plugin with the same ID that is not ours is refused by name before anything is
 * written, and the install source must itself be a Nucleus build: BB's
 * `plugin install --yes` is only ever given a directory this route built or ships.
 * Every other installed plugin is never named to the CLI.
 */
export function installBbPlugin(
  input: BbCommandContext & {
    packageRoot: string;
    pluginDir?: string | null;
  },
): BbInstallReport {
  const { directory, buildId: sourceBuildId } = resolveBbPluginDirectory(input);
  const before = listBbPlugins(input.exec);
  const existing = nucleusRow(before);
  if (existing) {
    const ownership = nucleusPluginOwnership(
      existing.rootDir,
      input.packageRoot,
    );
    if (!ownership.ours) {
      throw new Error(
        `a BB plugin with ID ${BB_PLUGIN_ID} is already installed from ${existing.rootDir ?? "an unknown directory"} and it is not a Nucleus build (${ownership.reason}); refusing to overwrite it. Remove it with bb plugin uninstall ${BB_PLUGIN_ID} if you mean to replace it`,
      );
    }
  }
  // BB builds the plugin it installs, and that build writes into dist/. Give it an
  // install-owned copy under the data home so version directories remain immutable.
  // The copy stays writable: a BB update rebuilds its bundle in place, and the pin —
  // not a file mode — is what tells the right build from the wrong one.
  const installDirectory = prepareBbPluginCopy(directory, input.dataDir);
  input.exec(["plugin", "install", `path:${installDirectory}`, "--yes"]);
  // The one setting the plugin needs to connect: this CLI's own data home. Written
  // through BB's own `plugin config`, for the plugin with ID `nucleus` only.
  input.exec([
    "plugin",
    "config",
    BB_PLUGIN_ID,
    "set",
    "serviceDataDir",
    input.dataDir,
  ]);
  const configured = pluginConfig(input.exec);
  if (configured.serviceDataDir !== input.dataDir) {
    throw new Error(
      `BB did not keep the plugin's serviceDataDir setting (it reads ${JSON.stringify(configured.serviceDataDir ?? null)}); the plugin would load without connecting, so ${BB_PLUGIN_INSTALL_COMMAND} did not finish`,
    );
  }
  input.exec(["plugin", "reload", BB_PLUGIN_ID]);
  const installed = nucleusRow(listBbPlugins(input.exec));
  if (!installed)
    throw new Error(
      `bb installed the plugin from ${directory} but does not list a plugin with ID ${BB_PLUGIN_ID}`,
    );
  if (installed.status === "error") {
    throw new Error(
      `BB installed the plugin from ${directory} but reports it as errored; read bb plugin logs ${BB_PLUGIN_ID}`,
    );
  }
  const pluginBuildId =
    readBbPluginBuild(installed.rootDir ?? "")?.buildId ?? sourceBuildId;
  const serviceBuildId = runningServiceBuildId(input.dataDir);
  const detail =
    pluginBuildId === null
      ? `installed plugin ${installed.version ?? "unknown"} built from the checkout; a packaged service refuses an unpinned plugin, so install from a Nucleus package to pin it`
      : serviceBuildId === null
        ? `installed build ${shortBuildId(pluginBuildId)}; no running service records a build to compare it with yet`
        : pluginBuildId === serviceBuildId
          ? `installed build ${shortBuildId(pluginBuildId)}, which matches the running service`
          : `installed build ${shortBuildId(pluginBuildId)} but the running service is build ${shortBuildId(serviceBuildId)}; the service refuses the plugin until ${BB_PLUGIN_INSTALL_COMMAND} installs the matching build`;
  return {
    action: "installed",
    plugin: installed,
    pluginBuildId,
    serviceBuildId,
    pluginDirectory: installDirectory,
    dataDir: input.dataDir,
    detail,
  };
}

/** The plugin's own settings as BB reports them, or empty when the read fails. */
export function pluginConfig(exec: BbCommandContext["exec"]): {
  serviceDataDir: string | null;
} {
  let answer: unknown;
  try {
    answer = JSON.parse(exec(["plugin", "config", BB_PLUGIN_ID, "--json"]));
  } catch {
    return { serviceDataDir: null };
  }
  const values = (answer as { values?: unknown } | null)?.values;
  if (typeof values !== "object" || values === null)
    return { serviceDataDir: null };
  const configured = (values as Record<string, unknown>).serviceDataDir;
  return {
    serviceDataDir:
      typeof configured === "string" && configured ? configured : null,
  };
}

export type BbPluginStatus =
  | "match"
  | "behind"
  | "unpinned"
  | "not-installed"
  | "unrecognised"
  | "service-unavailable";

export interface BbStatusReport {
  state: BbPluginStatus;
  detail: string;
  plugin: (BbPluginRow & { buildId: string | null }) | null;
  pluginBuildId: string | null;
  serviceBuildId: string | null;
  /** The plugin's own `serviceDataDir` setting, as BB reports it. */
  serviceDataDir: string | null;
}

/** The build the running service published, or null when none is running. */
export function runningServiceBuildId(dataDir: string): string | null {
  const info = readServiceInfo(dataDir);
  return typeof info?.buildId === "string" && info.buildId
    ? info.buildId
    : null;
}

/** The installed plugin against the running service's build. */
export function bbPluginStatus(
  input: BbCommandContext & { packageRoot: string },
): BbStatusReport {
  const plugin = nucleusRow(listBbPlugins(input.exec));
  const serviceBuildId = runningServiceBuildId(input.dataDir);
  if (!plugin) {
    return {
      state: "not-installed",
      detail: `the Nucleus BB plugin is not installed in BB; run ${BB_PLUGIN_INSTALL_COMMAND}`,
      plugin: null,
      pluginBuildId: null,
      serviceBuildId,
      serviceDataDir: null,
    };
  }
  const ownership = nucleusPluginOwnership(plugin.rootDir, input.packageRoot);
  const pluginBuildId = ownership.buildId;
  const configured = pluginConfig(input.exec).serviceDataDir;
  const report = {
    plugin: { ...plugin, buildId: pluginBuildId },
    pluginBuildId,
    serviceBuildId,
    serviceDataDir: configured,
  };
  if (!ownership.ours) {
    return {
      ...report,
      state: "unrecognised",
      detail: `a BB plugin with ID ${BB_PLUGIN_ID} is installed from ${plugin.rootDir ?? "an unknown directory"} and it is not a Nucleus build (${ownership.reason}); ${BB_PLUGIN_INSTALL_COMMAND} and ${BB_PLUGIN_ID} uninstall refuse to touch it`,
    };
  }
  // An install with no data home loaded the plugin without connecting: installed and
  // idle, which reads exactly like a healthy plugin that has nothing to do.
  const connection =
    configured === null
      ? `; it is not configured to connect, because its serviceDataDir setting is unset — run ${BB_PLUGIN_INSTALL_COMMAND}`
      : configured !== input.dataDir
        ? `; it is configured for another Nucleus data home (${JSON.stringify(configured)}), so it cannot reach this one — run ${BB_PLUGIN_INSTALL_COMMAND}`
        : "";
  if (pluginBuildId === null) {
    return {
      ...report,
      state: "unpinned",
      detail: `the installed plugin carries no Nucleus build identity (a checkout build); a packaged service refuses it, so run ${BB_PLUGIN_INSTALL_COMMAND} from the installed package${connection}`,
    };
  }
  if (serviceBuildId === null) {
    return {
      ...report,
      state: "service-unavailable",
      detail: `installed build ${shortBuildId(pluginBuildId)}; no running Nucleus service records a build to compare it with${connection}`,
    };
  }
  if (pluginBuildId === serviceBuildId) {
    return {
      ...report,
      state: "match",
      detail: `installed build ${shortBuildId(pluginBuildId)} matches the running service${connection}`,
    };
  }
  return {
    ...report,
    state: "behind",
    detail: `installed build ${shortBuildId(pluginBuildId)} is not the running service's build ${shortBuildId(serviceBuildId)}; run ${BB_PLUGIN_INSTALL_COMMAND} to install the matching plugin${connection}`,
  };
}

export interface BbUninstallReport {
  action: "removed" | "absent";
  plugin: BbPluginRow | null;
  detail: string;
}

/**
 * Remove the plugin with ID `nucleus` and nothing else. A plugin with that ID that is
 * not ours is refused by name: removing it would delete an operator's plugin because it
 * shares an ID with this integration's.
 */
export function uninstallBbPlugin(
  input: BbCommandContext & { packageRoot: string },
): BbUninstallReport {
  const existing = nucleusRow(listBbPlugins(input.exec));
  if (!existing) {
    return {
      action: "absent",
      plugin: null,
      detail: `no BB plugin with ID ${BB_PLUGIN_ID} is installed; nothing was removed`,
    };
  }
  const ownership = nucleusPluginOwnership(existing.rootDir, input.packageRoot);
  if (!ownership.ours) {
    throw new Error(
      `a BB plugin with ID ${BB_PLUGIN_ID} is installed from ${existing.rootDir ?? "an unknown directory"} and it is not a Nucleus build (${ownership.reason}); refusing to remove it`,
    );
  }
  input.exec(["plugin", "uninstall", BB_PLUGIN_ID]);
  const remaining = nucleusRow(listBbPlugins(input.exec));
  if (remaining) {
    throw new Error(
      `bb still lists a plugin with ID ${BB_PLUGIN_ID} after uninstall; read bb plugin logs ${BB_PLUGIN_ID}`,
    );
  }
  if (
    resolve(existing.rootDir ?? "") ===
    resolve(ownedPluginDirectory(input.dataDir))
  ) {
    removeBbPluginCopy(ownedPluginDirectory(input.dataDir));
  }
  return {
    action: "removed",
    plugin: existing,
    detail: `removed the BB plugin with ID ${BB_PLUGIN_ID} installed from ${existing.rootDir ?? "an unknown directory"}`,
  };
}

export const BB_COMMAND_USAGE = [
  "nucleus bb install [--plugin-dir <directory>]",
  `  Install the built BB plugin shipped with this Nucleus package under ID ${BB_PLUGIN_ID}, point it at this Nucleus data home, then reload it.`,
  "nucleus bb status",
  "  Report the installed BB plugin against the running service's build.",
  `nucleus bb uninstall`,
  `  Remove the BB plugin with ID ${BB_PLUGIN_ID}. No other plugin is touched.`,
].join("\n");

export interface BbCommandOptions {
  /** The Nucleus package (or checkout) root the built plugin is looked up beside. */
  packageRoot: string;
  /** The Nucleus data home holding the running service's identity. */
  dataDir?: string;
  /** The `bb` command; resolved from the installed app when omitted. */
  cli?: string;
  /** Run one `bb` command. Injected by tests. */
  exec?: BbCommandContext["exec"];
}

/** One command request from `bin/nucleus-bb.mjs`; returns what the CLI prints. */
export function bbCommand(
  command: string | undefined,
  args: string[],
  options: BbCommandOptions,
): BbInstallReport | BbStatusReport | BbUninstallReport | string {
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    args.includes("--help")
  ) {
    return BB_COMMAND_USAGE;
  }
  let cli = options.cli ?? null;
  let exec = options.exec;
  if (!exec) {
    if (!cli) {
      const found = findBbCli();
      if (!found.cli) {
        throw new Error(
          `no installed BB was found; looked for the bb command at ${found.tried.join(", ")}`,
        );
      }
      cli = found.cli;
    }
    exec = bbExec(cli);
  }
  const dataDir = options.dataDir ?? dataHome();
  if (command === "install") {
    let pluginDir: string | null = null;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "--plugin-dir") {
        pluginDir = args[++index] ?? null;
        if (!pluginDir)
          throw new Error("--plugin-dir needs a built plugin directory");
      } else
        throw new Error(
          `unknown argument ${arg}; ${BB_COMMAND_USAGE.split("\n")[0]}`,
        );
    }
    return installBbPlugin({
      exec,
      dataDir,
      packageRoot: options.packageRoot,
      pluginDir,
    });
  }
  if (command === "status")
    return bbPluginStatus({ exec, dataDir, packageRoot: options.packageRoot });
  if (command === "uninstall")
    return uninstallBbPlugin({
      exec,
      dataDir,
      packageRoot: options.packageRoot,
    });
  throw new Error(
    `choose a bb command: install, status or uninstall (got ${command})`,
  );
}
