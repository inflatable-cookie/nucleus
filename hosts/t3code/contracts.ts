import { z } from 'zod';

const id = z.string().min(1);
const date = z.string().min(1);
export const modelSelection = z.object({ instanceId: id, model: id });
export const threadRecord = z.object({
  id, projectId: id, title: z.string(), providerInstanceId: id, modelSelection,
  worktreePath: z.string().nullable(), branch: z.string().nullable(),
  archivedAt: date.nullable(), deletedAt: date.nullable(), updatedAt: date,
});
export const shellThread = threadRecord.extend({
  activeRunId: id.nullable(), status: z.enum(['idle', 'preparing', 'queued', 'starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']),
  pendingRuntimeRequest: z.object({ id, kind: id, createdAt: date, blocking: z.boolean().optional() }).nullable(),
  latestUserMessageAt: date.nullable(), lastError: z.string().nullable().optional(),
});
export const project = z.object({ id, title: z.string(), workspaceRoot: id });
export const shellSnapshot = z.object({
  schemaVersion: z.number().int().positive(), snapshotSequence: z.number().int().nonnegative(),
  projects: z.array(project), threads: z.array(shellThread), archivedThreads: z.array(shellThread),
});
export const runtimeRequest = z.object({
  id, kind: id, status: z.enum(['pending', 'resolved', 'expired', 'cancelled']),
  responseCapability: z.discriminatedUnion('type', [
    z.object({ type: z.literal('live'), providerSessionId: id }),
    z.object({ type: z.literal('message') }),
    z.object({ type: z.literal('not_resumable'), reason: z.string() }),
  ]), answers: z.record(z.string(), z.unknown()).optional(),
});
const question = z.object({ id, header: z.string(), question: z.string(), options: z.array(z.object({ label: z.string() })) });
export const turnItem = z.object({ id, type: id, requestId: id.optional(),
  questions: z.array(question).optional(), createdAt: date.optional(), updatedAt: date.optional(),
}).passthrough().superRefine((item, ctx) => {
  if (item.type === 'user_input_request' && (!item.requestId || !item.questions))
    ctx.addIssue({ code: 'custom', path: ['questions'], message: 'Missing question fields' });
});
export const projection = z.object({
  thread: threadRecord,
  runs: z.array(z.object({ id, status: shellThread.shape.status, startedAt: date.nullable() })),
  runtimeRequests: z.array(runtimeRequest), turnItems: z.array(turnItem),
  messages: z.array(z.object({ id, role: id, text: z.string() })), updatedAt: date,
});
/** Coverage flags are consumed facts, not optional hints that can be truthiness-tested. */
export const threadSnapshot = z.object({
  kind: z.literal('snapshot'), snapshotSequence: z.number().int().nonnegative(), projection,
  hasMoreHistory: z.boolean().optional(), historyCursor: id.nullable().optional(),
  latestLocalTurnOrdinal: z.number().int().nonnegative().nullable().optional(),
  turnItemsOmitLocalVisible: z.boolean().optional(), idTable: z.literal(true).optional(),
});
export const config = z.object({ environment: z.object({ environmentId: id, serverVersion: id, orchestrationProtocolVersion: z.literal(2) }),
  providers: z.array(z.object({ instanceId: id, displayName: z.string().optional(), enabled: z.boolean(),
    status: z.string(), models: z.array(z.object({ slug: id, name: z.string() })) })),
});

export class T3CompatibilityError extends Error {
  constructor(readonly field: string) { super(`T3Code compatibility check failed: ${field}`); this.name = 'T3CompatibilityError'; }
}
export function decode<T>(schema: z.ZodType<T>, value: unknown, at: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new T3CompatibilityError(`${at}.${result.error.issues[0]?.path.join('.') || 'response'}`);
  return result.data;
}
