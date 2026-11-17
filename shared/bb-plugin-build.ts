/**
 * The BB plugin's build identity and the service's pin (Spec 062, phase 7).
 *
 * The release build runs `bb plugin build` for `hosts/bb/plugin` and ships the
 * built package beside the rest of the Nucleus package under `bb-plugin/`, with
 * `nucleus-build.json` recording the Nucleus build it came from. The plugin
 * announces that id when it declares its executor role, and the service refuses a
 * plugin from a different build with a plain message naming both builds and the
 * command that fixes it — never a silent half-working connection (the sidebar of a
 * plugin whose operations the service does not serve).
 *
 * A plugin that carries no identity (one installed from a source checkout, which
 * is how the private proofs run) is not pinned against a source service, and is
 * refused by a packaged one: it cannot be the plugin that package shipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

/** The one plugin ID this integration installs, tests and uninstalls. */
export const BB_PLUGIN_ID = "nucleus";
/** The plugin package's own name, the fact that tells a Nucleus build from a namesake. */
export const BB_PLUGIN_PACKAGE_NAME = "bb-plugin-nucleus";
/** Where the built plugin lives inside a Nucleus package, beside `paseo-plugin.json`. */
export const BB_PLUGIN_PACKAGE_DIR = "bb-plugin";
/** The checkout directory the release build compiles. */
export const BB_PLUGIN_SOURCE_DIR = "hosts/bb/plugin";
/** The file the release build writes into the packaged plugin. */
export const BB_PLUGIN_BUILD_FILE = "nucleus-build.json";
/** The operator command that installs the packaged plugin and fixes a pin refusal. */
export const BB_PLUGIN_INSTALL_COMMAND = "nucleus bb install";

/**
 * A build identity, as the service records one: the packaged build's full SHA-256 or a
 * source service's 16-character identity. The pin is exact string equality either way.
 */
export const BB_PLUGIN_BUILD_ID = /^[a-f0-9]{8,64}$/;

export const bbPluginBuildSchema = z
  .object({
    buildId: z.string().regex(BB_PLUGIN_BUILD_ID),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
export type BbPluginBuild = z.infer<typeof bbPluginBuildSchema>;

/** The Nucleus build a packaged plugin came from, or null when it carries none. */
export function readBbPluginBuild(directory: string): BbPluginBuild | null {
  try {
    return bbPluginBuildSchema.parse(
      JSON.parse(readFileSync(join(directory, BB_PLUGIN_BUILD_FILE), "utf8")),
    );
  } catch {
    return null;
  }
}

/**
 * Whether a plugin directory is the Nucleus plugin *package* by name, with the backend
 * entry its manifest declares.
 *
 * The name is necessary and not sufficient: a plugin with ID `nucleus` is a package
 * named `bb-plugin-nucleus`, so a namesake that shares the ID shares the name.
 * Ownership (below) is the fact that decides whether the route may replace or remove
 * it, and the built backend's own plugin id has to agree before anything is handed to
 * BB's install.
 */
export function isNucleusPluginPackage(directory: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    ) as {
      name?: unknown;
      bb?: { server?: unknown };
    };
    if (manifest.name !== BB_PLUGIN_PACKAGE_NAME) return false;
    if (typeof manifest.bb?.server !== "string") return false;
    return existsSync(join(directory, manifest.bb.server));
  } catch {
    return false;
  }
}

/** A built backend's own meta record, when the directory has one. */
export function readBbPluginServerMeta(directory: string): {
  pluginId: string | null;
} | null {
  try {
    const meta = JSON.parse(
      readFileSync(join(directory, "dist", "server.meta.json"), "utf8"),
    ) as { pluginId?: unknown };
    return {
      pluginId: typeof meta.pluginId === "string" ? meta.pluginId : null,
    };
  } catch {
    return null;
  }
}

/**
 * Whether one built plugin directory is a Nucleus build this route may install: the
 * Nucleus plugin package by name, with a built backend that belongs to plugin ID
 * `nucleus`. Nothing else is ever handed to BB's install.
 */
export function nucleusPluginSource(
  directory: string,
): { ok: true } | { ok: false; reason: string } {
  if (!isNucleusPluginPackage(directory)) {
    return {
      ok: false,
      reason: `${directory} is not the Nucleus BB plugin package (${BB_PLUGIN_PACKAGE_NAME} with the backend entry it declares); refusing to install it`,
    };
  }
  if (!existsSync(join(directory, "dist", "server.js"))) {
    return {
      ok: false,
      reason: `${directory} has no built plugin (dist/server.js); run bb plugin build ${directory} and try ${BB_PLUGIN_INSTALL_COMMAND} again`,
    };
  }
  const meta = readBbPluginServerMeta(directory);
  if (meta && meta.pluginId !== BB_PLUGIN_ID) {
    return {
      ok: false,
      reason: `${directory} carries a built backend for plugin ${JSON.stringify(meta.pluginId)}, not ${BB_PLUGIN_ID}; refusing to install it`,
    };
  }
  return { ok: true };
}

/** The plugin directories this package ships, in the order the route prefers them. */
export function bbPluginPackagePaths(packageRoot: string): string[] {
  return [
    join(packageRoot, BB_PLUGIN_PACKAGE_DIR),
    join(packageRoot, BB_PLUGIN_SOURCE_DIR),
  ];
}

export interface BbPluginOwnership {
  /** True only for a directory this route may replace or remove. */
  ours: boolean;
  reason: string;
  /** The packaged build identity, when the directory records one. */
  buildId: string | null;
}

/**
 * Whether an installed plugin with ID `nucleus` is ours to replace or remove.
 *
 * Two facts count, and only these: the directory carries the Nucleus build identity
 * the release build writes (`nucleus-build.json`, so a plugin from an earlier package
 * version stays ours across a roll), or it is one of this package's own plugin
 * directories (the checkout install a developer or a private proof makes). A plugin
 * that merely has the ID and the package name is the operator's — a namesake — and is
 * never overwritten or removed.
 */
export function nucleusPluginOwnership(
  rootDir: string | null,
  packageRoot: string,
): BbPluginOwnership {
  if (!rootDir) {
    return {
      ours: false,
      reason: `it is installed from an unknown directory`,
      buildId: null,
    };
  }
  const build = readBbPluginBuild(rootDir);
  if (build) {
    return {
      ours: true,
      reason: "it carries the Nucleus build identity",
      buildId: build.buildId,
    };
  }
  if (bbPluginPackagePaths(packageRoot).includes(resolve(rootDir))) {
    return {
      ours: true,
      reason: "it is this Nucleus package's own plugin directory",
      buildId: null,
    };
  }
  if (isNucleusPluginPackage(rootDir)) {
    return {
      ours: false,
      reason:
        "it has the Nucleus package name but carries no Nucleus build identity and is not a directory this package ships",
      buildId: null,
    };
  }
  return {
    ours: false,
    reason: "it is not the Nucleus plugin package",
    buildId: null,
  };
}

/** The short form a person reads in a message; the full digest stays in the records. */
export const shortBuildId = (buildId: string) => buildId.slice(0, 12);

export interface BbPluginBuildPinInput {
  /** The build the running service publishes (`currentServiceBuildId()`). */
  serviceBuildId: string;
  /** True when this service runs from a packaged build rather than a source checkout. */
  serviceCompiled: boolean;
  /** What the declaring plugin announced, or null when it carries no identity. */
  pluginBuildId: string | null;
}

export type BbPluginBuildPin =
  | { ok: true }
  | { ok: false; field: "nucleusBuild"; reason: string };

/**
 * Decide whether a declaring plugin belongs to this service's build.
 *
 * - the same build connects;
 * - a different build is refused, naming both and the fix;
 * - a plugin with no identity connects to a source service (the private proofs),
 *   and is refused by a packaged one, which cannot have shipped it.
 */
export function bbPluginBuildPin(
  input: BbPluginBuildPinInput,
): BbPluginBuildPin {
  const { pluginBuildId, serviceBuildId } = input;
  if (pluginBuildId === null) {
    if (!input.serviceCompiled) return { ok: true };
    return {
      ok: false,
      field: "nucleusBuild",
      reason: `The connected BB plugin carries no Nucleus build identity and this service is build ${shortBuildId(serviceBuildId)}; run ${BB_PLUGIN_INSTALL_COMMAND} to install the plugin from this Nucleus package`,
    };
  }
  if (pluginBuildId === serviceBuildId) return { ok: true };
  return {
    ok: false,
    field: "nucleusBuild",
    reason: `The connected BB plugin is from Nucleus build ${shortBuildId(pluginBuildId)} and this service is build ${shortBuildId(serviceBuildId)}; run ${BB_PLUGIN_INSTALL_COMMAND} to install the plugin that matches this service`,
  };
}
