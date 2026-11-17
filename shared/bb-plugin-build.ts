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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
 * Whether an installed plugin directory is a Nucleus build. The package name is the
 * fact, not the ID: a plugin that merely calls itself `nucleus` is exactly the case
 * the install route refuses to overwrite.
 */
export function isNucleusPluginPackage(directory: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    ) as {
      name?: unknown;
    };
    return manifest.name === BB_PLUGIN_PACKAGE_NAME;
  } catch {
    return false;
  }
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
