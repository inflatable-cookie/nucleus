/** Shared callback transport: sends once and returns the decoded response. */
export function callbackRequest<T = unknown>(
  binding: { socketPath: string; token: string },
  path: string,
  payload: unknown,
  options?: { timeoutMs?: number; timeoutMessage?: string },
): Promise<T>;

/** This launch's callback environment value, or undefined. */
export function callbackEnvValue(name: string, env?: Record<string, string | undefined>): string | undefined;
