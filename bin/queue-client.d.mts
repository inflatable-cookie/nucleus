export function queueClient(options?: Record<string, unknown>): Promise<unknown>;
export function hostCallerIdentity(env?: NodeJS.ProcessEnv):
  | { hostKind: 't3code'; nativeAgentId: string; hostScope: string }
  | { hostKind: 'bb'; nativeAgentId: string }
  | { hostKind: 'paseo'; nativeAgentId: string }
  | null;
