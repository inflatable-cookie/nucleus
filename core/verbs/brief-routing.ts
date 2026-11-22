import type { Task } from "../../shared/contracts";
import { TASK_OWNER_HOLD } from "../../shared/contracts";
import type { Engine } from "../engine";
import { holdPatch, releasePatch, HOLD_REASON_NOT_RECORDED } from "../merge/merge-hold";
import { submissionQueueFields } from "../planning/handoff";

/** The operator's stated reason for a merge hold, or the recorded absence. */
const mergeHoldReason = (value: unknown): string => typeof value === 'string' ? value : HOLD_REASON_NOT_RECORDED;

/** The routing fields the ordinary profile validation path owns. */
const ROUTING_KEYS = ['scope', 'complexity', 'preferredProfileId', 'requirePreferred', 'thinkingOptionId', 'profileRequests', 'critical'];

/**
 * What the amended brief's queue frontmatter changes besides its text: the routing
 * fields through the owners that already validate them, then the merge hold and
 * the interactive mode. Routing and brief writes share the amendment transaction,
 * including every refusal, so a refused routing change leaves nothing written.
 */
export function applyBriefRouting(engine: Engine, input: {
  task: Task;
  /** The queue fields the amended document carries, or null when it has no frontmatter. */
  queue: Record<string, unknown> | null;
  /** The queue fields the pinned version carried, for the diff. */
  previous: Record<string, unknown>;
  reason: string;
  /** Gate events the amendment records beside its own version pin. */
  gateEvents: { kind: string; detail: string }[];
  /** The amendment's own patch: the hold and interactive changes land in it, not in a second write. */
  changes: Partial<Task>;
}): Task {
  const { queue, previous, reason, gateEvents, changes } = input;
  // Body-only edits keep stored routing, but delivery mode follows the brief's bytes.
  // Submission conversion omits these delivery fields; amendment comparison must retain them.
  const next: Record<string, unknown> = { completionNotificationAgentIds: [], ...submissionQueueFields(queue ?? previous), reportOnly: queue?.reportOnly, reportLane: queue?.reportLane };
  const prior: Record<string, unknown> = { completionNotificationAgentIds: [], ...submissionQueueFields(previous), reportOnly: previous.reportOnly, reportLane: previous.reportLane };
  // An amendment that does not name `queue.interactive` leaves the mode to its own block below.
  let task = applyRoutingFields(engine, input.task, next, prior, reason, queue?.interactive !== undefined);
  if (!queue) return task;
  const mergeHold = queue.mergeHold === true;
  const previousMergeHold = previous?.mergeHold === true;
  if (mergeHold !== previousMergeHold || (mergeHold && queue.mergeHoldReason !== previous?.mergeHoldReason)) {
    Object.assign(changes, mergeHold ? holdPatch(task, "merge", TASK_OWNER_HOLD, mergeHoldReason(queue.mergeHoldReason)) : releasePatch(task, "merge"));
    gateEvents.push({ kind: 'brief_merge_hold_changed', detail: `${previousMergeHold} → ${mergeHold}; ${reason}` });
  }
  // Spec 051: only an explicit queue.interactive changes the mode (it may also come
  // from queue.submit), and the worker prompt carries it, so only before dispatch.
  const interactive = queue.interactive;
  const previousInteractive = task.interactive === true;
  if (interactive !== undefined && interactive !== previousInteractive) {
    if (task.phase !== 'queued' || task.agentId || task.agentIntent) throw Error('queue.interactive changes only before dispatch; the running worker already has its instructions');
    changes.interactive = interactive as boolean;
    gateEvents.push({ kind: 'brief_interactive_changed', detail: `${previousInteractive} → ${interactive}; ${reason}` });
  }
  return task;
}

/**
 * The routing fields, diffed against the pinned version. A field this owner does
 * not know, or any field after dispatch began, is refused by name: routing is the
 * one thing an amendment may change only before dispatch.
 */
function applyRoutingFields(engine: Engine, task: Task, next: Record<string, unknown>, prior: Record<string, unknown>,
  reason: string, queueNamesInteractive: boolean): Task {
  const store = engine.store;
  const defaults: Record<string, unknown> = { dependsOn: [], lanes: [], scope: 'general', complexity: null,
    preferredProfileId: '', requirePreferred: false, thinkingOptionId: '', profileRequests: {},
    siblings: true, interactive: false,
    critical: false, laneDocuments: undefined };
  const managed = new Set(['mergeHold', 'mergeHoldReason', 'proofExecution', 'responsible', 'manualVerification', 'reviewContinuationIds']);
  const fields = [...new Set([...Object.keys(next), ...Object.keys(prior)])].filter(key =>
    !managed.has(key) && !(key === 'interactive' && !queueNamesInteractive)
    && JSON.stringify(next[key]) !== JSON.stringify(prior[key]));
  if (!fields.length) return task;
  const beforeDispatch = task.phase === 'queued' && engine.neverDispatched(task)
    && !task.workspaceIntent && !task.workspaceId && !task.agentIntent && !task.agentId;
  const refused = fields.filter(key => !(key in defaults) || !beforeDispatch);
  if (refused.length) throw Error(`Brief routing changes refused: ${refused.map(key => `queue.${key}`).join(', ')}; ${beforeDispatch ? 'these fields cannot change through amend_brief' : 'routing changes only before dispatch'}; nothing was written`);
  const values = Object.fromEntries(fields.map(key => [key, next[key] ?? defaults[key]]));
  if (fields.includes('dependsOn')) task = store.updateDependencies(task, (values.dependsOn as string[]).map(id => store.resolveTaskId(id)), 'brief amendment');
  if (fields.includes('lanes')) task = store.setTaskLanes(task, values.lanes as string[], task.repository);
  if (fields.some(key => ROUTING_KEYS.includes(key))) {
    // Use the ordinary profile validation path.
    const routing = Object.fromEntries(ROUTING_KEYS.filter(key => key in values).map(key => [key, values[key]]));
    if (fields.includes('profileRequests')) {
      const requests = { ...(values.profileRequests as NonNullable<Task['profileRequests']>) };
      for (const role of ['worker', 'reviewer', 'coordinator'] as const)
        if (task.profileRequests?.[role] && !requests[role]) Object.assign(requests, { [role]: null });
      routing.profileRequests = requests;
    }
    // Critical is a routing field here, before dispatch only; it grants no force or operator authority.
    const { critical, ...ordinary } = routing;
    if (Object.keys(ordinary).length) task = engine.applyTaskControlSetRouting({ taskId: task.id, version: task.version,
      action: 'set_routing', reason, ...ordinary } as Parameters<Engine['applyTaskControlSetRouting']>[0], result => result);
    if (critical !== undefined) task = store.update(task.id, { critical: critical as boolean }, 'brief_critical_changed', reason);
  }
  const direct = Object.fromEntries(fields.filter(key => !['dependsOn', 'lanes', 'interactive', ...ROUTING_KEYS].includes(key)).map(key => [key, values[key]]));
  if (Object.keys(direct).length) task = store.update(task.id, direct, 'brief_routing_changed', JSON.stringify({ fields: Object.keys(direct), reason }));
  return task;
}
