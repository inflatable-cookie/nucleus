export type HostCaller = { hostKind: string; nativeAgentId: string };
export type CallerSource = { source: 'ticket'; path: string } | ({ source: 'host' } & HostCaller);
export type CallerIdentity = { caller: string; hostId: string; source: 'run-ticket' | 'participant-ticket' | 'host' };
export function callerSource(env?: NodeJS.ProcessEnv, hostIdentity?: (env: NodeJS.ProcessEnv) => HostCaller | null): CallerSource;
export function resolveCaller(options?: { env?: NodeJS.ProcessEnv; hostIdentity?: (env: NodeJS.ProcessEnv) => HostCaller | null; resolveHost?: (input: HostCaller) => Promise<CallerIdentity>; source?: CallerSource }): Promise<CallerIdentity>;
