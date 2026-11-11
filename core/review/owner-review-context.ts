import type { OwnerReviewContext } from '../host/types';
export type { OwnerReviewContext } from '../host/types';
import { taskControlInputSchema, type Run, type Task } from '../../shared/contracts';
import { currentBrief } from '../planning/brief';
import { operationInputHash, type Store } from '../store/store';

/**
 * Find one opaque owner instruction behind a previous reviewer dispatch. The
 * audit event, successful hashed operation and the run's exact delivered text
 * must agree. Ambiguous or incomplete records disclose no instruction text.
 */
export function ownerReviewContext(store: Store, task: Task, replacement: Run): OwnerReviewContext | null {
  if (replacement.role !== 'reviewer') return null;
  const runs = store.runs(task.id);
  const prior = runs.slice(0, Math.max(0, runs.findIndex(run => run.id === replacement.id)));
  if (!prior.some(run => run.role === 'reviewer' && run.reviewReason)) return null;
  const operations = store.operations({ taskId: task.id, states: ['succeeded'], limit: 1000 });
  if (operations.length === 1000) return { state: 'unknown', detail: 'Owner control history exceeds the bounded lookup; source context cannot be attributed.' };
  const controls = operations.flatMap(operation => {
    if (operation.kind !== 'task_control') return [];
    const payload = store.operationPayload(operation.id) as { type?: unknown; control?: unknown } | null;
    if (!payload || payload.type !== 'task_control' || operation.inputHash !== operationInputHash(payload)) return [];
    const parsed = taskControlInputSchema.safeParse(payload.control);
    if (!parsed.success || parsed.data.taskId !== task.id || parsed.data.version !== operation.expectedVersion) return [];
    return [{ operation, control: parsed.data }];
  });
  const events = store.eventsAll(task.id).flatMap(event => {
    if (event.kind !== 'owner_control') return [];
    try {
      // Lines recorded before Spec 058 cutover 5 carry an `ownerThread` bit; the field is gone
      // with project ownership, and attribution now reads only caller, verb and role.
      const value = JSON.parse(event.detail) as { verb?: string; caller?: string; ownerThread?: boolean; identities?: { version?: number; restart?: { role?: string } } };
      return value.caller && value.verb === 'restart' && value.identities?.restart?.role === 'reviewer'
        ? [{ event, value }] : [];
    } catch { return []; }
  });
  for (const { event, value } of events.reverse()) {
    const matching = controls.filter(({ control }) => control.action === 'restart' && control.role === 'reviewer'
      && control.caller === value.caller && control.version === value.identities?.version);
    // A later owner reviewer restart with no durable operation may have supplied
    // a new instruction; an earlier one cannot silently override it.
    if (matching.length !== 1) return { state: 'unknown', detail: 'A reviewer owner control has no unique successful instruction record.' };
    const { operation, control } = matching[0];
    if (!control.instruction) continue;
    if (operations.some(candidate => candidate.kind === 'task_control' && (candidate.expectedVersion ?? -1) > control.version
      && !controls.some(valid => valid.operation.id === candidate.id)))
      return { state: 'unknown', detail: 'A later task control has an unverifiable payload; its effect on the instruction is unknown.' };
    if (controls.some(candidate => candidate.control.action === 'restart' && candidate.control.role === 'reviewer'
      && candidate.control.instruction && candidate.control.version > control.version))
      return { state: 'unknown', detail: 'A later reviewer instruction is recorded without an attributable owner dispatch.' };
    const matches = prior.filter(run => run.role === 'reviewer' && run.reviewReason === control.instruction
      && run.createdAt >= operation.createdAt && run.createdAt >= event.at);
    if (matches.length !== 1) return { state: 'unknown', detail: 'The owner instruction does not identify exactly one earlier reviewer dispatch.' };
    const source = matches[0];
    const brief = currentBrief(task), pinned = task.briefVersions.find(item => item.version === source.briefVersion);
    if (!brief || !pinned || source.briefVersion == null || event.at < pinned.pinnedAt || source.head !== replacement.head || task.prHead !== replacement.head
      || brief.version !== pinned.version || brief.digest !== pinned.digest
      || prior.slice(prior.indexOf(source) + 1).some(run => run.role === 'revision' && Boolean(run.completion)))
      return { state: 'historical', detail: `Owner instruction from reviewer run ${source.id} is historical because its source, brief or later author work differs.` };
    return { state: 'compatible', detail: 'Attributed owner instruction from the earlier reader; context only.', source: {
      operationId: operation.id, caller: control.caller!, runId: source.id, head: source.head,
      briefVersion: pinned.version, briefDigest: pinned.digest, text: control.instruction,
    } };
  }
  return { state: 'unknown', detail: 'No attributable owner reviewer instruction is recorded for the earlier reader.' };
}
