/** One open transport; the caller connects, sends its own requests, then closes it. */
export interface QueueClient {
  connect(): Promise<void>;
  close(): void;
  request(method: string, input?: unknown, ...rest: unknown[]): Promise<any>;
}
export function queueClient(options?: {
  viaPaseo?: boolean;
  dataDir?: string;
  rollWaitMs?: number;
  onProgress?: (message: string) => void;
  paseoClient?: unknown;
}): Promise<QueueClient>;
export function hostCallerIdentity(env?: NodeJS.ProcessEnv):
  | { hostKind: 't3code'; nativeAgentId: string; hostScope: string }
  | { hostKind: 'bb'; nativeAgentId: string }
  | { hostKind: 'paseo'; nativeAgentId: string }
  | null;
