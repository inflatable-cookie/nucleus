/**
 * The one admission rule for the store's own observation writes.
 *
 * Spec 050 owner controls are admitted against the version `task.next` showed
 * and then revalidate the facts they depend on after every await. Between those
 * two reads the lifecycle pass may record an observation of the same task: the
 * last observed time, the agent's activity and status, the idle stamp. The store
 * already answers which of its writes was an observation — `lastSubstantiveVersion`
 * only advances on a substantive write, and `putRun` treats a run that differs
 * only in `lastObservedAt` as an observation — so a request is still current when
 * its version is the current one or an earlier one with no substantive write
 * after it.
 *
 * This is not a version bypass: the version stays monotonic for readers and
 * stale-entry detection, and any real change (reason, phase, head, workspace,
 * branch, route, hold, disposition, merge intent, run state, completion, report,
 * checkpoint, permission, activity permission or effect record) advances the
 * marker and still refuses with the caller's own message. Nothing here retries,
 * resends, invents an operation or writes a compatibility record.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Run, Task } from '../../shared/contracts';

/**
 * Whether `version` is this task's current version, or an earlier one whose only
 * later writes were observations. A version ahead of the record is never
 * current.
 */
export function observationAdvanceSince(task: Task, version: number): boolean {
  if (!Number.isInteger(version) || version < 1) return false;
  if (version > task.version) return false;
  return version >= (task.lastSubstantiveVersion ?? task.version);
}

/**
 * The same run set, when every recorded run is the one admitted and the only
 * difference is its observation timestamp. A run that appears, releases, gains a
 * result, a delivery or an effect, or changes activity is a real change.
 */
export function runsUnchangedSince(admitted: readonly Run[], current: readonly Run[]): boolean {
  if (admitted.length !== current.length) return false;
  return admitted.every((run, index) => {
    const other = current[index];
    return Boolean(other) && other!.id === run.id
      && isDeepStrictEqual({ ...run, lastObservedAt: null }, { ...other!, lastObservedAt: null });
  });
}
