export function hostHome(env?: NodeJS.ProcessEnv): string;
export function hostHomeOverride(env?: NodeJS.ProcessEnv): string | undefined;
export function hostEnvironment(home?: string): { [key: string]: string };
