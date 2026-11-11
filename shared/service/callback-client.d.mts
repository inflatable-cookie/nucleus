/** Shared callback transport: sends once and returns the decoded response. */
export function callbackRequest<T = unknown>(
  binding: { socketPath: string; token: string },
  path: string,
  payload: unknown,
  options?: { timeoutMs?: number; timeoutMessage?: string },
): Promise<T>;

export function callbackTransportPhase(error: unknown): "connect" | "inflight" | "response" | null;
