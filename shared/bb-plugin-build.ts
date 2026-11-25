/** Build pin used by the legacy BB executor registration path. */
const BB_PLUGIN_INSTALL_COMMAND = "nucleus bb install";

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
 * - a plugin with no identity connects to a source service and is refused by
 *   a packaged service.
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
