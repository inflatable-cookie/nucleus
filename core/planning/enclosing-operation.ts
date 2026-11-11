import { isDeepStrictEqual } from 'node:util';
import { taskControlInputSchema, type TaskControlInput } from '../../shared/contracts';
import { normalizedTaskControl } from '../verbs/task-control-key';
import type { Store } from '../store/store';

/** A durable task_control operation id offered as the enclosing admission. */
export interface EnclosingOperationRef { readonly operationId: string }

/**
 * Spec 012/317: the one internally authenticated operation that is executing a
 * `queue.task` admission right now.
 *
 * An effect guard may exclude exactly that operation from its unresolved-effect
 * scan, because the operation is the admission itself, not a competing effect.
 * A raw operation id is never enough: a stale, foreign, pending, settled,
 * mismatched or caller-asserted id must exclude nothing. Callers obtain this
 * value only from `verifyEnclosingOperation`, which re-proves the stored
 * record's kind, task, action, version, exact normalized payload and running
 * state on every check.
 */
declare const verifiedEnclosingBrand: unique symbol;
export interface VerifiedEnclosingOperation extends EnclosingOperationRef { readonly [verifiedEnclosingBrand]: true }

/**
 * Prove the executor's own running operation for this exact control, or return
 * undefined when nothing is authenticated. Reads the store only.
 */
export function verifyEnclosingOperation(store: Store, input: TaskControlInput, operationId: string | undefined): VerifiedEnclosingOperation | undefined {
  if (operationId === undefined) return undefined;
  const record = store.operation(operationId);
  if (!record || record.state !== 'running') return undefined;
  return proveEnclosingOperation(store, record, input);
}

/**
 * The same proof for the operation that was accepted for this exact control and
 * has not run yet. An `operation` parked in the host wait is not running, so the
 * host-independent refusal that runs before that wait (#927) must still be able
 * to recognise it as the invocation itself rather than a competing writer.
 * Nothing else widens: a settled, foreign or mismatched record still proves
 * nothing, and effects keep reading the running-only form.
 */
export function verifyAcceptedEnclosingOperation(store: Store, input: TaskControlInput, operationId: string | undefined): VerifiedEnclosingOperation | undefined {
  if (operationId === undefined) return undefined;
  const record = store.operation(operationId);
  if (!record || !['pending', 'running'].includes(record.state)) return undefined;
  return proveEnclosingOperation(store, record, input);
}

function proveEnclosingOperation(store: Store, record: { id: string; kind: string; taskId: string | null; expectedVersion: number | null }, input: TaskControlInput): VerifiedEnclosingOperation | undefined {
  if (record.kind !== 'task_control' || record.taskId !== input.taskId) return undefined;
  if (record.expectedVersion !== null && record.expectedVersion !== input.version) return undefined;
  const payload = store.operationPayload(record.id) as { type?: unknown; control?: unknown } | null;
  if (payload === null || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'task_control') return undefined;
  const parsed = taskControlInputSchema.safeParse((payload as { control?: unknown }).control);
  if (!parsed.success) return undefined;
  if (!isDeepStrictEqual(parsed.data, normalizedTaskControl(input))) return undefined;
  return { operationId: record.id } as VerifiedEnclosingOperation;
}

/**
 * Prove the executor's own running `task_control` operation whose normalized
 * control satisfies `matches`, for a caller that holds the action/version and
 * an exact payload field rather than the whole control object (the answered-carry
 * binding). Every other check is identical to `verifyEnclosingOperation`, so a
 * raw, foreign, pending, settled, mismatched or wrong-version id still cannot
 * suppress an effect.
 */
export function verifyEnclosingOperationMatching(store: Store, taskId: string, operationId: string | undefined, expectedVersion: number,
  matches: (input: TaskControlInput) => boolean): VerifiedEnclosingOperation | undefined {
  if (operationId === undefined) return undefined;
  const record = store.operation(operationId);
  if (!record || record.kind !== 'task_control' || record.taskId !== taskId || record.state !== 'running') return undefined;
  if (record.expectedVersion !== null && record.expectedVersion !== expectedVersion) return undefined;
  const payload = store.operationPayload(operationId) as { type?: unknown; control?: unknown } | null;
  if (payload === null || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'task_control') return undefined;
  const parsed = taskControlInputSchema.safeParse((payload as { control?: unknown }).control);
  if (!parsed.success || parsed.data.taskId !== taskId || parsed.data.version !== expectedVersion || !matches(parsed.data)) return undefined;
  return { operationId: record.id } as VerifiedEnclosingOperation;
}
