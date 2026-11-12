export type HostCaller = { hostKind: string; nativeAgentId: string };
export type CallerSource = { source: 'ticket'; path: string } | ({ source: 'host' } & HostCaller);
export type CallerIdentity = { caller: string; hostId: string; source: 'run-ticket' | 'participant-ticket' | 'host' };
export function callerSource(env?: NodeJS.ProcessEnv, hostIdentity?: (env: NodeJS.ProcessEnv) => HostCaller | null): CallerSource;
/** The active service handover diagnostic for ticket-pinned caller resolution. */
export function callerRollProgress(dataDir?: string, now?: number): string | null;
/** The proven host of the identity a request names, for that exact identity only. */
export function identitySourceFor(identity: CallerIdentity | null | undefined, agent: unknown): { agent: string; hostId: string } | undefined;
export function resolveCaller(options?: { env?: NodeJS.ProcessEnv; hostIdentity?: (env: NodeJS.ProcessEnv) => HostCaller | null; resolveHost?: (input: HostCaller) => Promise<CallerIdentity>; source?: CallerSource }): Promise<CallerIdentity>;
