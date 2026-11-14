import type { Run, Task } from './contracts';

/**
 * The owner's no-automatic-retry intent, read once for every automatic gate.
 *
 * The durable decision is `resolution.noAutomaticRetry` once an owner control has
 * recorded one (`noAutomaticRetryDecided`); only rows with no decision fall back
 * to the phrases an owner wrote in the brief, handoff or instruction that launched
 * the run. That fallback is migration evidence for reports and rows recorded
 * before the decision existed: keep it in this one reader, never in the gates.
 */
/** Phrases that forbid automatic retry in an owner instruction, reason or brief. */
export const NO_AUTOMATIC_RETRY_FORBID = [
  /\bnoAutomaticRetry\s*:\s*true\b/i,
  /\bno automatic retry\b/i,
  /\bautomatic retries? (?:are )?(?:forbidden|prohibited|not allowed)\b/i,
];
/** Phrases that lift the rule again: a later owner instruction that permits retry. */
export const NO_AUTOMATIC_RETRY_LIFT = [
  /\bnoAutomaticRetry\s*:\s*false\b/i,
  /\ballow automatic retr\w*\b/i,
  /\bautomatic retr\w* (?:is |are )?(allowed|permitted|enabled)\b/i,
  /\bpermit\w* automatic retr\w*\b/i,
  /\bresume automatic retr\w*\b/i,
  /\bre-?enable automatic retr\w*\b/i,
];
/** Read one owner's no-automatic-retry intent from free text: forbid wins on mixed wording. */
export function noAutomaticRetryRule(text: string | null | undefined): 'forbid' | 'lift' | null {
  if (!text) return null;
  if (NO_AUTOMATIC_RETRY_FORBID.some(pattern => pattern.test(text))) return 'forbid';
  if (NO_AUTOMATIC_RETRY_LIFT.some(pattern => pattern.test(text))) return 'lift';
  return null;
}
/** Read an explicit retry prohibition from the pinned owner brief's wording. */
export function automaticRetryForbidden(task: Task, runs?: Run[]): boolean {
  if (task.resolution.noAutomaticRetry) return true;
  // An explicit owner lift is authoritative: the brief-text and old-run fallbacks
  // below serve only rows with no durable owner decision, so the superseded run's
  // instruction can never re-forbid retry after the owner permitted it.
  if (task.resolution.noAutomaticRetryDecided) return false;
  const text = [task.briefVersions?.at(-1)?.text, task.brief?.text, task.handoffText,
    task.resolution.pendingWorkerInstruction, task.resolution.revisionInstruction?.text].filter((value): value is string => Boolean(value)).join('\n');
  if (NO_AUTOMATIC_RETRY_FORBID.some(pattern => pattern.test(text))) return true;
  // Older rows recorded the prohibition only in the instruction that launched
  // the run: read the latest owner-instructed run's instruction, which the
  // launch clears from the task row once its run starts.
  if (runs) for (let index = runs.length - 1; index >= 0; index--) {
    const instruction = runs[index]?.instruction;
    if (!instruction) continue;
    return NO_AUTOMATIC_RETRY_FORBID.some(pattern => pattern.test(instruction));
  }
  return false;
}
