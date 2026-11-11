import type { RecoveryDispatchSnapshot } from '../host/types';
export type { RecoveryDispatchSnapshot } from '../host/types';
import type { TaskNext, TaskNextReviewOutcome, TaskNextVerb } from '../../shared/contracts';
import { ownerTaskNext, retainedCheckpointRun, type OwnerVerbFacts } from '../verbs/owner-verbs';

/** Bounds the snapshot: a coordinator reads the plan, not the task's history. */
const TEXT_LIMIT = 500, ITEM_LIMIT = 20;
/** Identity and control-plumbing fields a coordinator report never names. */
const IDENTITY_ARGS = ['action', 'taskId', 'version', 'caller'];

const bounded = (text: string | null | undefined): string | null => text == null ? null
  : text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;
const bundle = (items: string[]) => items.slice(0, ITEM_LIMIT).map(item => bounded(item) ?? '');

/**
 * The task-scoped plan `next` derives, projected for the coordinator's first
 * prompt. It reads the same `ownerTaskNext` facts with no second planner, keeps
 * only what a coordinator needs to choose, and carries no credential. It is a
 * snapshot: application re-derives current facts when the report arrives.
 */
export function recoveryDispatchSnapshot(facts: OwnerVerbFacts, why: { cause: string | null; target: string; recoveryRunId: string }): RecoveryDispatchSnapshot {
  const next = ownerTaskNext(facts);
  const { task, runs } = facts;
  const stop = next.stop ? {
    kind: next.stop.kind, reason: next.stop.reason, owner: next.stop.owner ?? null,
    evidence: bounded(next.stop.evidence), detail: bounded(next.stop.detail),
  } : null;
  const retained = retainedCheckpointRun(runs);
  const latest = retained?.reviewCheckpoints?.at(-1);
  // The workspace of a run, or the task's own worker workspace for its initial binding.
  const workspaceOf = (runId: string | null) => runId === null ? null
    : runs.find(run => run.id === runId)?.workspaceId ?? (runId === task.runId ? task.workspaceId : null);
  const checkpoint = retained && latest ? {
    runId: retained.id, workspaceId: retained.workspaceId, ordinal: latest.ordinal, head: latest.head,
    covered: bundle(latest.checkpoint.covered), remaining: bundle(latest.checkpoint.remaining),
    notes: bounded(latest.checkpoint.notes ?? null),
  } : null;
  // The outcome rides in the same `next` read, so the launch snapshot and the
  // credentialed refresh cannot disagree.
  const outcome = next.outcome;
  const authorResult = outcome.authorResult ? { ...outcome.authorResult, summary: bounded(outcome.authorResult.summary) } : null;
  return {
    why: { cause: bounded(why.cause), target: why.target, recoveryRunId: why.recoveryRunId },
    phase: next.phase, reason: bounded(next.reason), stop,
    activeRun: next.activeRun ? { ...next.activeRun, summary: bounded(next.activeRun.summary), workspaceId: workspaceOf(next.activeRun.runId) } : null,
    holds: next.holds,
    outcome: {
      ...outcome,
      accepted: outcome.accepted ? { ...outcome.accepted, summary: bounded(outcome.accepted.summary) } : null,
      reported: outcome.reported ? { ...outcome.reported, summary: bounded(outcome.reported.summary) } : null,
      impediment: outcome.impediment ? { ...outcome.impediment, summary: bounded(outcome.impediment.summary) ?? '', reviewText: bounded(outcome.impediment.reviewText) } : null,
      impediments: outcome.impediments.map(item => ({ ...item, summary: bounded(item.summary) ?? '', reviewText: bounded(item.reviewText) })),
      decision: bounded(outcome.decision) ?? outcome.decision,
    },
    checkpoint, authorResult,
    ...(next.replacement ? { replacement: next.replacement } : {}),
    verbs: next.verbs.map(verb => ({
      verb: verb.verb, available: verb.available,
      ...(verb.args ? { args: Object.fromEntries(Object.entries(verb.args).filter(([key]) => !IDENTITY_ARGS.includes(key))) } : {}),
      ...(verb.fill?.length ? { fill: verb.fill } : {}),
      ...(verb.refusal ? { refusal: bounded(verb.refusal) ?? undefined } : {}),
      ...(verb.note ? { note: bounded(verb.note) ?? undefined } : {}),
    })),
  };
}
