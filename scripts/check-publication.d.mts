export const syntheticArtifactFixtures: Set<string>;
export const syntheticVolumeFixtures: Record<string, string[]>;
export function publicationDenylist(root: string, env?: NodeJS.ProcessEnv): string[];
export function checkPublication(root: string, options?: { env?: NodeJS.ProcessEnv }): string[];
