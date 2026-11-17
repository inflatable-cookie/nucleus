export const syntheticArtifactFixtures: Set<string>;
export const syntheticVolumeFixtures: Record<string, string[]>;
export function publicationDenylist(root: string, env?: NodeJS.ProcessEnv): string[];
export function checkPublication(root: string, options?: { env?: NodeJS.ProcessEnv }): string[];
export const bbPluginPackageFiles: string[];
/** The release build's own gate: the package ships the built BB plugin and its identity. */
export function checkPackageBbPlugin(
  packageRoot: string,
  options?: { buildId?: string },
): string[];
