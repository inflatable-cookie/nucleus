/**
 * The one-row model on T3 (Tom, 2026-11-15; nucleus#1366): a task is one row, its
 * parent thread, and that row spends most of its life snoozed rather than settled.
 * This module is the vocabulary that row reads — which roles are support roles, the
 * step they report and how the row's title names it. Nothing here tags, links or
 * settles a thread: T3 draws a nested child inside the parent row itself.
 */
import { WIRE_LABEL_KEYS } from '../../shared/wire-labels';

/**
 * The run role whose thread is still the task's worker row. A worker launch
 * carries no role label; a revision thread is a worker-shaped thread, settled
 * and archived with the worker (nucleus#1154), never a support row.
 */
export const workerRoles: ReadonlySet<string> = new Set(['worker', 'revision']);

/** The step a live support run names on the worker row, in the order they win. */
const steps: ReadonlyArray<{ role: string; step: string; word: string }> = [
  { role: 'reviewer', step: 'reviewing', word: 'reviewer' },
  { role: 'recovery', step: 'recovery', word: 'recovery' },
  { role: 'verification', step: 'verifying', word: 'verifier' },
  { role: 'closeout', step: 'closing', word: 'closeout' },
  { role: 'executor', step: 'executing', word: 'executor' },
];
const stepOf = new Map(steps.map(entry => [entry.role, entry]));
/** The first step the platform's table names, so two live roles read the same way every pass. */
export const stepOrder = steps.map(entry => entry.role);

export const isSupportRole = (role: string | undefined | null): role is string =>
  Boolean(role) && !workerRoles.has(role!);

/** The step a support role's own live run is doing: `reviewing`, `recovery`, `verifying`, … */
export function activeStep(role: string): string | undefined { return stepOf.get(role)?.step; }
/** How the worker row names that role when it needs input or is blocked. */
export function roleWord(role: string): string { return stepOf.get(role)?.word ?? role; }

/**
 * The step a task's worker row names, from what its support threads report:
 * a pending question or permission wins, then a finished-with-fault thread, then
 * a live role in the table's order. Empty when nothing of the task is running.
 */
export function rowStep(observed: ReadonlyArray<{ role: string; pending: boolean; live: boolean; faulted: boolean }>): string {
  const ranked = (predicate: (entry: { role: string; pending: boolean; live: boolean; faulted: boolean }) => boolean) =>
    [...observed].filter(predicate).sort((a, b) => stepOrder.indexOf(a.role) - stepOrder.indexOf(b.role));
  const pending = ranked(entry => entry.pending)[0];
  if (pending) return `${roleWord(pending.role)} needs input`;
  const faulted = ranked(entry => entry.faulted)[0];
  if (faulted) return `blocked: ${roleWord(faulted.role)}`;
  const live = ranked(entry => entry.live)[0];
  return live ? activeStep(live.role) ?? '' : '';
}

/** A step that names work waiting on a person rather than a run in flight. */
export function attentionStep(step: string): boolean {
  return step.endsWith(' needs input') || step.startsWith('blocked: ');
}

/**
 * The worker row's title: the task's own state title, then the step it is doing.
 * The suffix is dropped when the state title already opens with that word
 * (`Reviewing: …` needs no second `reviewing`), so the row reads once.
 */
export function rowTitle(stateTitle: string, step: string): string {
  if (!step) return stateTitle;
  const state = stateTitle.slice(0, stateTitle.indexOf(':') === -1 ? stateTitle.length : stateTitle.indexOf(':')).trim().toLowerCase();
  if (state === step.toLowerCase()) return stateTitle;
  return `${stateTitle} · ${step}`;
}

/** The role a thread's labels name, if this adapter recorded one. */
export function labelRole(labels: Record<string, string> | undefined): string | undefined {
  return labels?.[WIRE_LABEL_KEYS.role];
}
export function labelTask(labels: Record<string, string> | undefined): string | undefined {
  return labels?.[WIRE_LABEL_KEYS.task];
}
