import type { Run } from '../../../shared/contracts';

/**
 * The durable absence budget: one replacement per role, recorded as an event so
 * a crash or a later pass cannot spend it twice. The record's detail names the
 * role and the run it replaced, so the budget is read from a field rather than
 * matched inside the recorded sentence. The visible text still follows the
 * scope.
 */

/** The one writer of a replacement record: `<role>:<runId>: <visible text>`. */
export const absentReplacementRecord = (role: Run['role'], runId: string, text: string): string => `${role}:${runId}: ${text}`;

/** Whether one same-role replacement was already recorded for this task. */
export const absentReplacementSpent = (events: Array<{ kind: string; detail: string }>, role: Run['role']): boolean =>
  events.some(event => event.kind === 'absent_creation_replaced' && absentReplacementRole(event.detail) === role);

/**
 * The role a replacement record spent its budget on, or null when the record is
 * another shape. Records written before the scoped detail named the role inside
 * the sentence instead; that legacy wording stays readable here because a task
 * created under it still owns one replacement, and this is the one reader of it.
 */
export const absentReplacementRole = (detail: string): string | null => {
  const scope = detail.indexOf(':');
  if (scope > 0) return detail.slice(0, scope);
  const legacy = /^Confirmed absent (\w+) creation/.exec(detail);
  return legacy ? legacy[1]! : null;
};
