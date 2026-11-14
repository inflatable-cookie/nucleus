/** The one retry rule for a versioned task write; see bin/versioned-write.mjs. */
export type TransportFailure = { code?: string } | undefined;
export function firstLine(error: unknown): string;
export function uncertainFailure(error: unknown): boolean;
export class VersionedWriteError extends Error {
  constructor(message: string, detail: { reason: string; attempts: number; uncertain: boolean });
  readonly reason: string;
  readonly attempts: number;
  readonly uncertain: boolean;
}
export function applyVersionedWrite(client: { request(method: string, input: unknown): Promise<unknown> }, options: {
  taskId: string;
  method: string;
  input: Record<string, unknown>;
  idempotent: boolean;
  attempts?: number;
  delay?: (ms: number) => Promise<void>;
}): Promise<unknown>;
