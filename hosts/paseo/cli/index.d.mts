export function hostCallerIdentity(env?: NodeJS.ProcessEnv): { hostKind: 'paseo'; nativeAgentId: string } | null;
export function queueClient(options?: { viaPaseo?: boolean; dataDir?: string; rollWaitMs?: number; onProgress?: (message: string) => void; paseoClient?: unknown }): Promise<any>;
