export function hostCallerIdentity(env?: NodeJS.ProcessEnv): { hostKind: 'paseo'; nativeAgentId: string } | null;
export function paseoBridgeQueueClient(options?: { paseoClient?: unknown }): Promise<{
  connect(): Promise<void>;
  close(): void;
  request(method: string, input: unknown): unknown;
}>;
