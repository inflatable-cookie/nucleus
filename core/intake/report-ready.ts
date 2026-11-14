import type { Completion, Run, Task } from '../../shared/contracts';
import { heldBriefQueuePolicy } from '../planning/handoff';
import type { Resolution } from '../resolution';
import type { Store } from '../store/store';
import { recordResultApplied, resultApplied } from './applied-result';

/**
 * `report_ready` is one report-only result: the brief it was dispatched under must
 * opt into report-only work, and the artifact it names must be the latest exact
 * version of a lane the task carries. Worker intake and revision intake read the
 * same rule here, so a gate added for one is never missing for the other.
 */
export function reportReadyRefusal(store: Pick<Store, 'laneDocument'>, task: Task, input: Completion): string | null {
  const briefText = task.briefVersions.at(-1)?.text ?? task.brief?.text;
  if (!briefText) return 'report_ready requires a Nucleus-held brief with queue.reportOnly: true';
  let policy: ReturnType<typeof heldBriefQueuePolicy>;
  try { policy = heldBriefQueuePolicy(briefText); }
  catch { return 'report_ready requires a valid Nucleus-held brief with queue.reportOnly: true'; }
  if (!policy.reportOnly) return 'report_ready is only allowed when the brief opts into queue.reportOnly: true';
  if (!input.artifact) return 'report_ready requires the exact lane document artifact';
  if (policy.reportLane && input.artifact.key !== policy.reportLane) return `report_ready artifact must use the brief's report lane ${policy.reportLane}`;
  if (!task.lanes.includes(input.artifact.key)) return 'report_ready artifact must be a lane attached to this task';
  const exact = store.laneDocument(input.artifact.key, input.artifact.version);
  const latest = store.laneDocument(input.artifact.key);
  if (!exact || exact.digest !== input.artifact.digest || !latest || latest.version !== input.artifact.version || latest.digest !== input.artifact.digest)
    return 'report_ready artifact must identify the latest exact Nucleus lane document version and digest';
  return null;
}

export type ReportReadyFacts = { readonly store: Store; update: Resolution['update'] };

/**
 * Settle a revision's report-only turn: the task records the result and returns to
 * `report_ready`. One fence (the applied-result event) holds however many passes
 * reach it, so a second application changes nothing.
 */
export function settleReportReady(facts: ReportReadyFacts, task: Task, run: Run, input: Completion): boolean {
  const latest = facts.store.task(task.id);
  if (resultApplied(facts.store, task.id, run.id) || latest.resolution.currentRunId !== run.id) return false;
  facts.update(latest, { currentRunId: null, integrationTurn: null },
    { phase: 'report_ready', completion: input, reason: input.summary }, 'revision_report_ready');
  recordResultApplied(facts.store, task.id, run.id);
  return true;
}
