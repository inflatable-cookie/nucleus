/**
 * The operator install route for this integration's BB plugin (Spec 062, phase 7).
 *
 * `nucleus bb install` wraps BB's own CLI: it installs exactly one plugin — the one
 * with ID `nucleus` — from the built plugin shipped beside the Nucleus package, and
 * reloads it. `nucleus bb status` reports the installed plugin against the running
 * service's build. `nucleus bb uninstall` removes that same plugin and nothing else.
 *
 * Two rules decide the refusals:
 *
 * - the route touches only the plugin with ID `nucleus`. Every other plugin,
 *   including a locally patched one loaded from thread storage, is left alone: no
 *   command this file issues names another ID, and BB's own routes are per-plugin;
 * - a plugin with ID `nucleus` that is not a Nucleus build (`bb-plugin-nucleus`) is
 *   named and refused, never overwritten. A namesake is the operator's plugin, not
 *   ours to replace.
 *
 * Nothing here writes into BB's data directory: every write is a `bb` command, and
 * the plugin is pinned to the service build by the identity file the release build
 * writes into the package (`shared/bb-plugin-build.ts`).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "../shared/data-home.mjs";
import { findBbCli } from "../shared/bb-cli.mjs";
import { readServiceInfo } from "../shared/service/discovery";
import {
  BB_PLUGIN_ID,
  BB_PLUGIN_INSTALL_COMMAND,
  BB_PLUGIN_PACKAGE_DIR,
  BB_PLUGIN_SOURCE_DIR,
  isNucleusPluginPackage,
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
 * test), the copy shipped beside the Nucleus package, or the checkout's own package
 * in a source run. A directory with no built `dist/` is refused with the build command.
 */
export function resolveBbPluginDirectory(input: {
  packageRoot: string;
  pluginDir?: string | null;
}): { directory: string; packaged: boolean } {
  const candidates = input.pluginDir
    ? [{ directory: input.pluginDir, packaged: true }]
    : [
        {
          directory: join(input.packageRoot, BB_PLUGIN_PACKAGE_DIR),
          packaged: true,
        },
        {
          directory: join(input.packageRoot, BB_PLUGIN_SOURCE_DIR),
          packaged: false,
        },
      ];
  for (const candidate of candidates) {
    if (!existsSync(join(candidate.directory, "package.json"))) continue;
    if (!existsSync(join(candidate.directory, "dist", "server.js"))) {
      throw new Error(
        `${candidate.directory} has no built plugin (dist/server.js); run bb plugin build ${candidate.directory} and try ${BB_PLUGIN_INSTALL_COMMAND} again`,
      );
    }
    return candidate;
  }
  throw new Error(
    `no built BB plugin was found beside this Nucleus package (looked in ${candidates.map((item) => item.directory).join(" and ")}); reinstall the Nucleus package or pass --plugin-dir with a built plugin`,
  );
}

/** The installed plugin's own identity, when it is a Nucleus build that carries one. */
export function installedPluginBuild(row: BbPluginRow | null): {
  nucleusPackage: boolean;
  buildId: string | null;
} {
  if (!row?.rootDir) return { nucleusPackage: false, buildId: null };
  return {
    nucleusPackage: isNucleusPluginPackage(row.rootDir),
    buildId: readBbPluginBuild(row.rootDir)?.buildId ?? null,
  };
}

export interface BbInstallReport {
  action: "installed";
  plugin: BbPluginRow;
  pluginBuildId: string | null;
  serviceBuildId: string | null;
  pluginDirectory: string;
  detail: string;
}

/**
 * Install the packaged plugin under ID `nucleus`, then reload that plugin. A plugin
 * with the same ID that is not a Nucleus build is refused by name before anything is
 * written; every other installed plugin is never named to the CLI.
 */
export function installBbPlugin(
  input: BbCommandContext & {
    packageRoot: string;
    pluginDir?: string | null;
  },
): BbInstallReport {
  const { directory } = resolveBbPluginDirectory(input);
  const before = listBbPlugins(input.exec);
  const existing = nucleusRow(before);
  if (existing && !installedPluginBuild(existing).nucleusPackage) {
    throw new Error(
      `a BB plugin with ID ${BB_PLUGIN_ID} is already installed from ${existing.rootDir ?? "an unknown directory"} and it is not a Nucleus build; refusing to overwrite it. Remove it with bb plugin uninstall ${BB_PLUGIN_ID} if you mean to replace it`,
    );
  }
  input.exec(["plugin", "install", `path:${directory}`, "--yes"]);
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
  const identity = installedPluginBuild(installed);
  const serviceBuildId = runningServiceBuildId(input.dataDir);
  const pluginBuildId = identity.buildId;
  const detail =
    pluginBuildId === null
      ? `installed build ${installed.version ?? "unknown"} from a source checkout; a packaged service refuses an unpinned plugin, so install from a Nucleus package to pin it`
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
    pluginDirectory: directory,
    detail,
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
}

/** The build the running service published, or null when none is running. */
export function runningServiceBuildId(dataDir: string): string | null {
  const info = readServiceInfo(dataDir);
  return typeof info?.buildId === "string" && info.buildId
    ? info.buildId
    : null;
}

/** The installed plugin against the running service's build. */
export function bbPluginStatus(input: BbCommandContext): BbStatusReport {
  const plugin = nucleusRow(listBbPlugins(input.exec));
  const serviceBuildId = runningServiceBuildId(input.dataDir);
  if (!plugin) {
    return {
      state: "not-installed",
      detail: `the Nucleus BB plugin is not installed in BB; run ${BB_PLUGIN_INSTALL_COMMAND}`,
      plugin: null,
      pluginBuildId: null,
      serviceBuildId,
    };
  }
  const identity = installedPluginBuild(plugin);
  const pluginBuildId = identity.buildId;
  const report = {
    plugin: { ...plugin, buildId: pluginBuildId },
    pluginBuildId,
    serviceBuildId,
  };
  if (!identity.nucleusPackage) {
    return {
      ...report,
      state: "unrecognised",
      detail: `a BB plugin with ID ${BB_PLUGIN_ID} is installed from ${plugin.rootDir ?? "an unknown directory"} and it is not a Nucleus build; ${BB_PLUGIN_INSTALL_COMMAND} refuses to overwrite it`,
    };
  }
  if (pluginBuildId === null) {
    return {
      ...report,
      state: "unpinned",
      detail: `the installed plugin carries no Nucleus build identity (a checkout build); a packaged service refuses it, so run ${BB_PLUGIN_INSTALL_COMMAND} from the installed package`,
    };
  }
  if (serviceBuildId === null) {
    return {
      ...report,
      state: "service-unavailable",
      detail: `installed build ${shortBuildId(pluginBuildId)}; no running Nucleus service records a build to compare it with`,
    };
  }
  if (pluginBuildId === serviceBuildId) {
    return {
      ...report,
      state: "match",
      detail: `installed build ${shortBuildId(pluginBuildId)} matches the running service`,
    };
  }
  return {
    ...report,
    state: "behind",
    detail: `installed build ${shortBuildId(pluginBuildId)} is not the running service's build ${shortBuildId(serviceBuildId)}; run ${BB_PLUGIN_INSTALL_COMMAND} to install the matching plugin`,
  };
}

export interface BbUninstallReport {
  action: "removed" | "absent";
  plugin: BbPluginRow | null;
  detail: string;
}

/** Remove the plugin with ID `nucleus` and nothing else. */
export function uninstallBbPlugin(input: BbCommandContext): BbUninstallReport {
  const existing = nucleusRow(listBbPlugins(input.exec));
  if (!existing) {
    return {
      action: "absent",
      plugin: null,
      detail: `no BB plugin with ID ${BB_PLUGIN_ID} is installed; nothing was removed`,
    };
  }
  input.exec(["plugin", "uninstall", BB_PLUGIN_ID]);
  const remaining = nucleusRow(listBbPlugins(input.exec));
  if (remaining) {
    throw new Error(
      `bb still lists a plugin with ID ${BB_PLUGIN_ID} after uninstall; read bb plugin logs ${BB_PLUGIN_ID}`,
    );
  }
  return {
    action: "removed",
    plugin: existing,
    detail: `removed the BB plugin with ID ${BB_PLUGIN_ID} installed from ${existing.rootDir ?? "an unknown directory"}`,
  };
}

export const BB_COMMAND_USAGE = [
  "nucleus bb install [--plugin-dir <directory>]",
  `  Install the built BB plugin shipped with this Nucleus package under ID ${BB_PLUGIN_ID}, then reload it.`,
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
  if (command === "status") return bbPluginStatus({ exec, dataDir });
  if (command === "uninstall") return uninstallBbPlugin({ exec, dataDir });
  throw new Error(
    `choose a bb command: install, status or uninstall (got ${command})`,
  );
}
