import { z } from 'zod';
import { certifyHostFailureFacts } from '../../core/host/errors';

const id = z.string().min(1);
const date = z.string().min(1);
/** A model's option choice: one selectable value of one option descriptor (nightly `ProviderOptionChoice`). */
export const optionChoice = z.object({ id, label: z.string(), description: z.string().optional(), isDefault: z.boolean().optional() });
/**
 * One configurable option of a model (nightly `ProviderOptionDescriptor`):
 * a select with its choices or a boolean toggle, `currentValue` when the provider reports one.
 * `role: "reasoning"` is the nightly's marker for a provider's own thought-level control;
 * every stock driver names its reasoning select `reasoningEffort`.
 */
export const optionDescriptor = z.discriminatedUnion('type', [
  z.object({ id, label: z.string(), description: z.string().optional(), type: z.literal('select'),
    options: z.array(optionChoice), currentValue: z.string().optional(), role: z.string().optional() }),
  z.object({ id, label: z.string(), description: z.string().optional(), type: z.literal('boolean'),
    currentValue: z.boolean().optional() }),
]);
/**
 * The nightly's runtime-mode contract (`packages/contracts/src/providerPolicy.ts`
 * in the source, `RuntimeMode` in the installed bundle): four thread-wide modes,
 * narrowest first, with `full-access` as the default a thread is launched with.
 * A provider reports the subset it offers as `supportedRuntimeModes`; omitting
 * the field means it offers all four, and a request outside the reported subset
 * silently runs as `approval-required` (`providerRuntimeMode`). The adapter never
 * relies on that downgrade: the catalog reports this list per provider and the
 * launch fence refuses a mode the provider does not offer.
 */
export const runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const;
export const runtimeMode = z.enum(runtimeModes);
export type RuntimeMode = z.infer<typeof runtimeMode>;
/** The mode a launch uses when the profile names none (`DEFAULT_RUNTIME_MODE`). */
export const defaultRuntimeMode: RuntimeMode = 'full-access';
export const modelCapabilities = z.object({ optionDescriptors: z.array(optionDescriptor).optional() });
export const modelSelection = z.object({ instanceId: id, model: id });
export const threadRecord = z.object({
  id, projectId: id, title: z.string(), providerInstanceId: id, modelSelection,
  /** The thread's runtime mode. The nightly always reports it; retained only when present for older shapes. */
  runtimeMode: runtimeMode.optional(),
  /** Nightly's manual settled marker; a new message dispatch clears it. */
  settledOverride: z.enum(['settled', 'active']).nullable(), settledAt: date.nullable(),
  worktreePath: z.string().nullable(), branch: z.string().nullable(),
  archivedAt: date.nullable(), deletedAt: date.nullable(), updatedAt: date,
});
export const shellThread = threadRecord.extend({
  activeRunId: id.nullable(), status: z.enum(['idle', 'preparing', 'queued', 'starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']),
  pendingRuntimeRequest: z.object({ id, kind: id, createdAt: date, blocking: z.boolean().optional() }).nullable(),
  latestUserMessageAt: date.nullable(), lastError: z.string().nullable().optional(),
});
export const project = z.object({ id, title: z.string(), workspaceRoot: id, archivedAt: date.nullable().optional() });
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
  runs: z.array(z.object({ id, status: shellThread.shape.status, startedAt: date.nullable(), ordinal: z.number().int().nonnegative().optional() })),
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
    /** The nightly `ServerProvider` field: the runtime modes this provider offers. Absent means all four. */
    supportedRuntimeModes: z.array(runtimeMode).optional(),
    status: z.string(), models: z.array(z.object({ slug: id, name: z.string(), aliases: z.array(z.string()).optional(),
      capabilities: modelCapabilities.optional() })) })),
});

/**
 * How much of a thread's timeline one `subscribeThread` snapshot carries.
 *
 * The nightly answers a bounded snapshot only to a client that asks for one
 * (`acceptBoundedSnapshot`). It then keeps the thread record, every run and
 * every runtime request in full and windows only the timeline, so `paged`
 * describes the transcript and never the state observation reads.
 * `hasMoreHistory` and `historyCursor` are a pair: a window that left earlier
 * history behind sets both, a complete snapshot sets neither, and any other
 * combination is a coverage claim the adapter cannot use. `idTable` is the
 * compact-id codec's wire shape, which the plain decode here does not expand.
 */
export interface ThreadSnapshotCoverage { paged: boolean; omitsTurnItems: boolean }
export function threadSnapshotCoverage(snapshot: z.infer<typeof threadSnapshot>): ThreadSnapshotCoverage {
  const paged = snapshot.hasMoreHistory === true;
  const cursor = snapshot.historyCursor ?? null;
  if (paged !== (cursor !== null))
    throw new T3CompatibilityError(`subscribeThread: hasMoreHistory ${paged} with ${cursor === null ? 'no cursor' : 'a cursor'}`);
  if (snapshot.idTable !== undefined) throw new T3CompatibilityError('subscribeThread: idTable');
  return { paged, omitsTurnItems: snapshot.turnItemsOmitLocalVisible === true };
}

export class T3CompatibilityError extends Error {
  constructor(readonly field: string) {
    super(`T3Code compatibility check failed: ${field}`);
    this.name = 'T3CompatibilityError';
    // The field is one of this adapter's own constants (a snapshot name, a
    // decoded path), so an owner refusal may name it.
    certifyHostFailureFacts(this, { field });
  }
}
export function decode<T>(schema: z.ZodType<T>, value: unknown, at: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new T3CompatibilityError(`${at}.${result.error.issues[0]?.path.join('.') || 'response'}`);
  return result.data;
}
