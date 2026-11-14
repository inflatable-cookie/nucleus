import { NO_PENDING_EFFECT_REFUSAL } from "./verb-refusal-text";
import { canRetireCancelledWorkspace } from "../workspaces/terminal-workspace-retirement";
import { terminalArchiveWorkspaces } from "../closeout/terminal-archive";
import { exhaustedThreadArchives } from "../workspaces/thread-archive";
import { archiveIntentOutstanding, archiveIntentUnreadable } from "../workspaces/archive-intent";
import { externalArchiveHoldReason, preservedExternalWorkspace, recordedExternalArchive } from "../workspaces/external-workspace-archive";
import { z } from "zod";
import { externalWorkspaceArchivePending, dispositionWorkPolicy, incidentBindsCurrentWork, isDispositionActive, taskControlInputSchema, taskNextVerbSchema, externalArchiveOccurrence, runtimeRetirementOccurrence, type Task, type TaskControlInput, type TaskNextVerb } from "../../shared/contracts";
import { hookHoldsTransition, supersededRetentionReconciliation } from "../../shared/hooks";
import { isAcceptedReview } from "../recovery/task-reasons";
import { blockingRecoveryEffects } from "../recovery/recovery-effects";
import { classifyReviewPublication } from "../review/review-publication";
import { prIdentity } from './owner-facts';
import type { OwnerVerbFacts } from './owner-facts';
import { verbInput } from './owner-shared';
import type { OwnerVerb } from './owner-shared';

/**
 * One recorded failed or uncertain side effect an owner can retry (Spec 050
 * `retry_effect`). The `effect` key is stable: `task.next` derives it from the
 * recorded facts, and `retry_effect` re-derives the same list from the store
 * before it acts, so the read view and the applied control never disagree.
 */
export type OwnerEffect = {
  effect: string;
  kind: "hook" | "workspace_creation" | "workspace_archive" | "runtime_retirement"
    | "build_output_cleanup" | "merged_task_retention" | "review_publication" | "planning_base"
    | "external_workspace_archive" | "disposition_workspace" | "task_control_operation" | "recovery_effect" | "owned_tool";
  summary: string;
};

/** Bind a settlement to the recorded occurrence, not its diagnostic text. */
export function ownerEffectOccurrence(facts: OwnerVerbFacts, effect: OwnerEffect): string {
  if (effect.kind === 'build_output_cleanup') {
    const workspaceId = effect.effect.slice('build_output_cleanup.'.length);
    const record = facts.task.resolution.buildOutputCleanups.find(item => item.workspaceId === workspaceId && !item.runId);
    return JSON.stringify([workspaceId, record?.at ?? null]);
  }
  if (effect.kind === 'runtime_retirement') {
    const workspaceId = effect.effect.slice('runtime_retirement.'.length);
    const record = facts.task.resolution.runtimeRetirements.find(item => item.workspaceId === workspaceId);
    return record ? runtimeRetirementOccurrence(record) : '';
  }
  if (effect.kind === 'external_workspace_archive') {
    const workspaceId = effect.effect.slice('external_workspace_archive.'.length);
    return externalArchiveOccurrence(workspaceId, facts.task.resolution.externalWorkspaceArchives.find(item => item.workspaceId === workspaceId));
  }
  if (effect.effect === 'project-validation.project-validation') {
    const validation = facts.task.resolution.projectValidation;
    return JSON.stringify(validation ? [validation.hostRunId ?? null, validation.submittedAt ?? null, validation.head, validation.digest] : null);
  }
  if (effect.effect === 'merge-response.merge-response') return facts.task.resolution.mergeRequestedAt ?? '';
  if (effect.kind === 'owned_tool') {
    const runId = effect.effect.slice('owned_tool.'.length);
    const event = facts.events.findLast(item => item.kind === 'owned_tool_hold' && (() => {
      try { return JSON.parse(item.detail).runId === runId; } catch { return false; }
    })());
    return String(event?.id ?? '');
  }
  if (effect.kind === 'workspace_archive') {
    const workspaceId = effect.effect.slice('workspace_archive.'.length);
    const retry = facts.task.resolution.workspaceArchiveRetries.find(item => item.workspaceId === workspaceId);
    return JSON.stringify([workspaceId, retry?.attempts ?? null]);
  }
  return effect.effect;
}

/**
 * A cancel or supersede disposition that stopped at its workspace step: the
 * last recorded proof or archive occurrence is uncertain and the fence still
 * holds the task. The identity comes from the store, so `next` and the applied
 * retry always name the same effect, and only a workspace effect is offered —
 * thread stops, PR closes and hook emissions never reopen this way.
 */
function pendingDispositionWorkspaceEffect(task: Task): OwnerEffect | null {
  const disposition = task.disposition;
  if (!disposition || disposition.status !== "needs_attention" || !task.workspaceId || disposition.workspaceArchived) return null;
  const workspaceId = task.workspaceId;
  const last = disposition.effects.filter(effect => (effect.kind === "workspace_proof" || effect.kind === "archive_workspace")
    && effect.target === workspaceId).at(-1);
  if (!last?.uncertain) return null;
  const policy = dispositionWorkPolicy(disposition);
  const reclaim = policy === "retained_by_replacement"
    ? "; if the replacement no longer exists, archive_if_empty is the existing safe policy an owner may explicitly select"
    : "";
  return { effect: `disposition_workspace.${workspaceId}`, kind: "disposition_workspace",
    summary: `The ${disposition.kind === "supersede" ? "supersession" : "cancellation"} workspace step is uncertain (${last.result ?? last.kind}); its recorded ${policy} proof can be re-run now${reclaim}` };
}

/**
 * Every recorded failed or uncertain side effect on one task, from store reads
 * only. The engine re-derives this list when `retry_effect` applies, so an
 * effect named by an owner is re-proved pending before any handler runs.
 */
export function ownerPendingEffects(facts: OwnerVerbFacts): OwnerEffect[] {
  const { store, task, hookRecords, events } = facts;
  const effects: OwnerEffect[] = [];
  const incident = task.resolution.incident;
  const activeRecoveryRun = facts.runs.some(run => run.role === "recovery" && !run.released);
  if (incident?.status === "reconciling" && incidentBindsCurrentWork(task, facts.runs)
    && !task.resolution.recoveryActive && !activeRecoveryRun) {
    effects.push({ effect: `incident.${incident.id}`, kind: "recovery_effect",
      summary: `Incident ${incident.id} is still reconciling, but no active recovery run owns it; re-prove and settle the incident` });
  }
  const ownedToolState = new Map<string, { held: boolean; reason?: string }>();
  for (const event of events) if (event.kind === 'owned_tool_hold' || event.kind === 'owned_tool_settled') {
    try {
      const value = JSON.parse(event.detail) as { runId?: unknown; reason?: unknown };
      if (typeof value.runId === 'string') ownedToolState.set(value.runId,
        event.kind === 'owned_tool_hold' && typeof value.reason === 'string' ? { held: true, reason: value.reason } : { held: false });
    } catch { /* malformed evidence does not create an owner action */ }
  }
  for (const [runId, state] of ownedToolState) if (state.held)
    effects.push({ effect: `owned_tool.${runId}`, kind: 'owned_tool', summary: `Run ${runId} is held by an owned tool: ${state.reason}` });
  // A task-control retry may itself be left uncertain after its effect was
  // applied. Keep that operation visible until an owner re-proves its target
  // or a later control supersedes it.
  for (const operation of store.operations({ taskId: task.id, states: ["needs_attention"], limit: 1000 })) {
    if (operation.kind !== "task_control") continue;
    const payload = store.operationPayload(operation.id) as { control?: { action?: string } } | null;
    if (payload?.control?.action !== "retry_effect") continue;
    effects.push({ effect: `task_control_operation.${operation.id}`, kind: "task_control_operation",
      summary: `Task-control operation ${operation.id} is uncertain: ${operation.diagnostic || "no diagnostic was recorded"}` });
  }
  // A disposition frozen at its workspace proof or archive is the owner's to
  // re-run; nothing else about the fence changes.
  const dispositionWorkspace = pendingDispositionWorkspaceEffect(task);
  if (dispositionWorkspace) effects.push(dispositionWorkspace);
  for (const workspace of terminalArchiveWorkspaces(task, facts.runs)) {
    if (!workspace.id || !workspace.directory || !workspace.head || task.resolution.archivedWorkspaceIds.includes(workspace.id)) continue;
    const retry = task.resolution.workspaceArchiveRetries.find(record => record.workspaceId === workspace.id);
    const uncertain = task.resolution.archiveIntentWorkspaceId === workspace.id;
    const exhausted = exhaustedThreadArchives(store, task, facts.runs, workspace.id);
    if (!retry && !uncertain && !exhausted.length || effects.some(item => item.effect === `workspace_archive.${workspace.id}`)) continue;
    effects.push({ effect: `workspace_archive.${workspace.id}`, kind: 'workspace_archive',
      summary: exhausted.length ? `Workspace archive waits for thread archive reconciliation: ${exhausted.join(', ')}` : retry ? `Workspace archive for ${workspace.id} failed: ${retry.error}` : `Workspace ${workspace.id} archive is unconfirmed; observe before retrying` });
  }
  // An outstanding intent is offered as its own observation, so the owner can see and settle an unknown
  // outcome; the retry observes and reports, it never sends a second request.
  const outstandingIntent = archiveIntentOutstanding(task) ? task.resolution.archiveIntentWorkspaceId : null;
  if (outstandingIntent && !effects.some(item => item.effect === `workspace_archive.${outstandingIntent}`))
    effects.push({ effect: `workspace_archive.${outstandingIntent}`, kind: 'workspace_archive',
      summary: `Review view ${outstandingIntent} archive outcome is unconfirmed; the retry observes it and reports where custody or publication is unresolved` });
  // An intent whose reviewer run can no longer be read cannot be re-attempted,
  // but it must never become an invisible stuck state: the ordinary retry names
  // it, observes the catalog entry and reports what it finds.
  const unreadableView = archiveIntentUnreadable(task, facts.runs);
  if (unreadableView && !task.resolution.archivedWorkspaceIds.includes(unreadableView)
    && !effects.some(item => item.effect === `workspace_archive.${unreadableView}`))
    effects.push({ effect: `workspace_archive.${unreadableView}`, kind: 'workspace_archive',
      summary: `Review view ${unreadableView} archive is unconfirmed and its reviewer run can no longer be read; the retry observes the catalog entry and reports it` });
  if (canRetireCancelledWorkspace(task)) effects.push({ effect: `workspace_archive.${task.workspaceId}`, kind: 'workspace_archive',
    summary: task.resolution.workspaceRetirement?.detail ?? 'Cancelled workspace is preserved; an owner may authorize retirement after fresh source and idle proofs' });
  // Spec 017: a merged review-entry task's preserved external workspace owes a
  // catalog archive per registration. A held or unknown answer is the owner's to
  // retry; the retry re-proves placement, membership, source and idleness before
  // the one effect and observes an unknown prior answer instead of replaying it.
  // `archived` and `failed` are settled: a hard failure is never replayed.
  const preserved = preservedExternalWorkspace(task);
  if (preserved && task.phase === 'done' && task.resolution.mergedCommit) {
    const samePath = task.resolution.externalWorkspaceArchives.filter(record => record.directory === preserved.directory);
    const bound = recordedExternalArchive(task, preserved.workspaceId);
    if (!bound)
      effects.push({ effect: `external_workspace_archive.${preserved.workspaceId}`, kind: 'external_workspace_archive',
        summary: `Preserved external workspace ${preserved.workspaceId} still shows a Paseo sidebar entry; its catalog archive has not been attempted` });
    for (const record of samePath) {
      if (!externalWorkspaceArchivePending(record)) continue;
      effects.push({ effect: `external_workspace_archive.${record.workspaceId}`, kind: 'external_workspace_archive',
        summary: record.workspaceId === preserved.workspaceId
          ? externalArchiveHoldReason(task) || `External workspace catalog archive is ${record.state}`
          : `Catalog registration ${record.workspaceId} at the preserved folder is ${record.state}: ${record.detail || externalArchiveHoldReason(task)}` });
    }
  }
  // A hook occurrence that still holds its transition (blocked, uncertain, or a
  // required-delivery failure), or the latest failed advisory occurrence of a
  // hook (a task.finished runtime stop is never retried automatically, so the
  // owner retries it explicitly).
  const latestAdvisory = new Map<string, (typeof hookRecords)[number]>();
  for (const record of hookRecords) if (record.delivery === "advisory") latestAdvisory.set(`${record.event}:${record.hookId}`, record);
  // A pre-archive occurrence gates one workspace's archive; once that
  // workspace is archived (by Queue or observed gone) it holds nothing.
  const archivedDirectories = new Set(terminalArchiveWorkspaces(task, facts.runs)
    .filter(workspace => workspace.id && workspace.directory && task.resolution.archivedWorkspaceIds.includes(workspace.id))
    .map(workspace => workspace.directory!));
  const archivedGate = (record: (typeof hookRecords)[number]) => record.event === "task.pre_archive"
    && Boolean(record.workspace?.path) && archivedDirectories.has(record.workspace!.path);
  // Hook records the specialized derivation above deliberately does not offer:
  // they are settled history (archived gate, superseded reconciliation) or
  // hold no transition. The recovery-effect projection below must not
  // re-introduce them (task 620's projection adds blockers the established
  // keys do not already cover; it never overrides this derivation).
  const omittedHookRecords = new Set<string>();
  for (const record of hookRecords) {
    const failedAdvisory = record.delivery === "advisory" && record.state === "failed" && latestAdvisory.get(`${record.event}:${record.hookId}`) === record;
    if (!hookHoldsTransition(record) && !failedAdvisory) { omittedHookRecords.add(record.id); continue; }
    if (supersededRetentionReconciliation(hookRecords, record) || archivedGate(record)) { omittedHookRecords.add(record.id); continue; }
    effects.push({
      effect: `hook.${record.eventId}`, kind: "hook",
      summary: `${record.event} hook ${record.hookId} occurrence is ${record.state}${record.checkoutDiscard?.status === "held" ? " after checkout disposal" : ""}`,
    });
  }
  // Pre-dispatch workspace creation: the creation intent is recorded, no worker
  // identity ever arrived and the state is otherwise settled, so the replay
  // observes the resource first (present binds, proven absent replays once).
  const settledPreDispatch = !task.completion && !prIdentity(task) && !task.resolution.currentRunId
    && !task.resolution.recoveryActive && !facts.runs.some(run => !run.released || run.role !== "recovery");
  if (settledPreDispatch && task.workspaceIntent && !task.agentIntent && !task.agentId
    && ["queued", "needs_attention", "blocked", "error"].includes(task.phase))
    effects.push({ effect: "workspace_creation", kind: "workspace_creation", summary: "Workspace creation is unproven; replay observes, then binds or replays once" });
  // An unused-workspace archive whose intent was recorded but whose archive was
  // never confirmed.
  for (const event of events) {
    if (event.kind !== "unused_workspace_archive_intent") continue;
    try {
      const evidence = JSON.parse(event.detail) as { workspaceId?: string };
      if (!evidence.workspaceId) continue;
      if (effects.some(item => item.effect === `workspace_archive.${evidence.workspaceId}`)) continue;
      const prior = store.getMeta<{ status?: string }>(`unusedWorkspaceArchive:${task.id}:${evidence.workspaceId}`);
      if (prior?.status === "archived") continue;
      effects.push({ effect: `workspace_archive.${evidence.workspaceId}`, kind: "workspace_archive",
        summary: `Unused workspace ${evidence.workspaceId} archive is unconfirmed` });
    } catch { /* a malformed intent line is not a pending effect */ }
  }
  // A dispatch workspace a rebind displaced is owed its archive even before an
  // archive intent exists; the handler re-proves it idle and unnamed first.
  const listed = new Set(effects.map(item => item.effect));
  for (const row of store.db.prepare("SELECT key FROM meta WHERE key LIKE ?").all(`displacedDispatchWorkspace:${task.id}:%`) as { key: string }[]) {
    const workspaceId = row.key.slice(`displacedDispatchWorkspace:${task.id}:`.length);
    if (!workspaceId || listed.has(`workspace_archive.${workspaceId}`) || task.resolution.archivedWorkspaceIds.includes(workspaceId)) continue;
    if (store.getMeta<{ status?: string }>(`unusedWorkspaceArchive:${task.id}:${workspaceId}`)?.status === "archived") continue;
    effects.push({ effect: `workspace_archive.${workspaceId}`, kind: "workspace_archive",
      summary: `Workspace ${workspaceId} was displaced by a rebind and is not archived` });
  }
  for (const record of task.resolution.runtimeRetirements) {
    if (record.state !== "failed") continue;
    effects.push({ effect: `runtime_retirement.${record.workspaceId}`, kind: "runtime_retirement",
      summary: `Runtime retirement for workspace ${record.workspaceId} failed: ${record.error || "retry owed"}` });
  }
  // Run-bound records settle on their own run path; `retry_effect` owns only the terminal workspace cleanup.
  for (const record of task.resolution.buildOutputCleanups) {
    if (record.runId || record.state !== "skipped" && record.state !== "uncertain") continue;
    effects.push({ effect: `build_output_cleanup.${record.workspaceId}`, kind: "build_output_cleanup",
      summary: `Build output cleanup for workspace ${record.workspaceId} is ${record.state}: ${record.detail}` });
  }
  // A merged done task whose latest pre-archive gate occurrence for the
  // retained worktree still holds its transition (Spec 047).
  if (task.phase === "done" && task.resolution.mergedCommit && task.directory) {
    const prior = hookRecords.findLast(record => record.event === "task.pre_archive"
      && (record.workspace?.path ?? null) === task.directory);
    if (prior && hookHoldsTransition(prior) && !supersededRetentionReconciliation(hookRecords, prior) && !archivedGate(prior))
      effects.push({ effect: `merged_task_retention.${prior.eventId}`, kind: "merged_task_retention",
        summary: `Merged-task retention gate ${prior.hookId} is ${prior.state} for the retained worktree` });
  }
  // A parked task still owns its accepted verdict. Publication recovery does
  // not depend on the phase or on the ladder retaining currentRunId.
  for (const run of facts.runs) {
    if (run.role === "reviewer" && run.released && run.status === "finished"
      && run.head === task.prHead && run.completion && isAcceptedReview(run.completion)
      && !run.completion.reviewId && !run.completion.reviewCommentId
      && store.getMeta(`reviewPublication:${run.id}`)
      && classifyReviewPublication(store, task, run).state !== 'superseded')
      effects.push({ effect: `review_publication.${run.id}`, kind: "review_publication",
        summary: `Reviewer run ${run.id} reported ${run.completion!.status}; its publication is unrecorded` });
  }
  // A workerless task with a recorded workspace that cannot dispatch from its
  // recorded base; the re-record observes the worktree head before anything moves.
  if (settledPreDispatch && task.workspaceIntent && task.workspaceId && task.directory
    && ["needs_attention", "blocked", "error"].includes(task.phase))
    effects.push({ effect: "planning_base", kind: "planning_base",
      summary: "The retained workspace may not dispatch from the recorded base; re-record observes the worktree head first" });
  // Every blocker consumed by lifecycle gates is visible through the same
  // projection those gates use. Existing owner handlers keep their established
  // keys; remaining kinds use kind.identity from the projection.
  for (const blocking of blockingRecoveryEffects(store, task, { noticeKinds: 'all' })) {
    // A running validation is named so an owner can settle it, but its
    // ordinary retry remains unavailable until its own observer can act.
    const hookRecord = blocking.kind === 'hook' ? hookRecords.find(record => record.id === blocking.identity) : undefined;
    // A hook the specialized derivation deliberately omitted is settled
    // history (archived gate, superseded reconciliation), not a pending
    // effect — never re-offer it as uncertain here. Invalid and in-flight
    // hook states keep surfacing through the projection.
    if (blocking.kind === 'hook' && blocking.state === 'uncertain' && (!hookRecord || omittedHookRecords.has(hookRecord.id))) continue;
    const key = blocking.kind === 'hook' ? `hook.${hookRecord?.eventId ?? blocking.identity}`
      : blocking.kind === 'publication' ? `review_publication.${blocking.identity}`
        : blocking.kind === 'operation' && effects.some(item => item.kind === 'task_control_operation'
          && item.effect === `task_control_operation.${blocking.identity}`) ? null
          : `${blocking.kind}.${blocking.identity}`;
    if (!key || effects.some(item => item.effect === key)) continue;
    effects.push({ effect: key, kind: 'recovery_effect', summary: `${blocking.kind} ${blocking.identity} is ${blocking.state}: ${blocking.reason}` });
  }
  // A settled archive intent may no longer be a cleanup candidate (its run's
  // custody can change). The settlement itself still names a workspace left on disk.
  for (const record of task.resolution.ownerSettlements) {
    if (!record.effect.startsWith('workspace_archive.')) continue;
    const workspaceId = record.effect.slice('workspace_archive.'.length);
    if (task.resolution.archivedWorkspaceIds.includes(workspaceId) || effects.some(effect => effect.effect === record.effect)) continue;
    const effect: OwnerEffect = { effect: record.effect, kind: 'workspace_archive', summary: `Workspace ${workspaceId} remains unarchived` };
    if (record.occurrence === ownerEffectOccurrence(facts, effect)) effects.push(effect);
  }
  return effects.flatMap(effect => {
    const settled = task.resolution.ownerSettlements.some(record =>
      record.effect === effect.effect && record.occurrence === ownerEffectOccurrence(facts, effect));
    if (!settled) return [effect];
    // Force settles the uncertainty, never the workspace on disk. Keep the
    // ordinary retry visible while automatic cleanup honours the settlement.
    return effect.kind === 'workspace_archive' ? [{ ...effect,
      summary: `Workspace ${effect.effect.slice('workspace_archive.'.length)} left on disk after forced settlement; retry to observe and archive it` }] : [];
  });
}

function effectViews(facts: OwnerVerbFacts): TaskNextVerb[] {
  const { task } = facts;
  const effects = ownerPendingEffects(facts);
  if (!effects.length)
    return [taskNextVerbSchema.parse({ verb: "retry_effect", action: "retry_effect", available: false,
      refusal: NO_PENDING_EFFECT_REFUSAL })];
  return effects.map(item => {
    if (item.effect.startsWith('project-validation.') && (task.resolution.projectValidation?.state === 'running' || !task.resolution.attention))
      return taskNextVerbSchema.parse({ verb: 'retry_effect', action: 'retry_effect', available: false,
        refusal: `${item.effect}: validation is still running; a planner or operator can force settlement with a reason` });
    if (item.effect.startsWith('review_publication.')) {
      // Round 4: a pause or dispatch hold records the retry for later, so neither refuses it here.
      const refusal = item.kind !== 'review_publication' ? 'no released accepted ordinary verdict at the current PR head can be published'
        : facts.runs.some(run => !run.released && run.id !== facts.reportingRunId) ? 'a retained run must finish and release before publication'
        : ['done', 'cancelled'].includes(task.phase) || task.resolution.mergeIntent || task.resolution.mergedCommit || isDispositionActive(task) || task.removedAt ? 'the task is terminal, merging, removed or under disposition'
        : null;
      if (refusal) return taskNextVerbSchema.parse({ verb: 'retry_effect', action: 'retry_effect', available: false,
        refusal: `${item.effect}: ${item.summary}; ${refusal}` });
    }
    const held = item.kind === "hook"
      && facts.hookRecords.find(record => `hook.${record.eventId}` === item.effect)?.checkoutDiscard?.status === "held";
    return taskNextVerbSchema.parse({
      verb: "retry_effect", action: "retry_effect", available: true,
      args: { action: "retry_effect", effect: item.effect, taskId: task.id, version: task.version, summary: item.summary },
      // Discarding unpublished checkout state stays an explicit owner choice:
      // the held occurrence lists `discard` among the fields the owner adds.
      fill: held || item.kind === "workspace_creation" ? ["reason", "discard"] : ["reason"],
      // A disposition workspace step re-runs the policy it records. The safe
      // archive_if_empty policy is only an explicit owner addition when the
      // recorded retained_by_replacement proof can no longer be produced.
      ...(item.kind === "disposition_workspace" ? { note: item.summary } : {}),
      ...(item.kind === 'review_publication' ? { note: 'Use retry_effect without force to observe and publish the original verdict. Force cannot discard it.' } : {}),
    });
  });
}

/**
 * `retry_effect` (Spec 050): observe, then bind or retry once, one recorded
 * failed or uncertain side effect. `next` lists each pending effect with its
 * stable `effect` key; the apply re-derives the same list from the store,
 * refuses with what was observed when the named effect is no longer pending,
 * and otherwise delegates to the existing handler, which observes the remote
 * or local resource before any retry.
 */
export const retryEffect: OwnerVerb = {
  verb: "retry_effect",
  action: "retry_effect",
  input: verbInput({
    effect: z.string().trim().min(1).max(240).optional(),
    reason: z.string().trim().min(1).max(4000),
    discard: z.boolean().optional(),
    force: z.boolean().optional(),
    relayed: z.boolean().optional(),
    note: z.string().trim().min(1).max(4000).optional(),
  }),
  applicable: facts => {
    const effects = ownerPendingEffects(facts);
    if (!effects.length) return { available: false, refusal: NO_PENDING_EFFECT_REFUSAL };
    if (effects.length === 1) return { available: true, args: { effect: effects[0].effect } };
    return { available: true, fill: ["effect"], args: {} };
  },
  apply: (call, args) => call(taskControlInputSchema.parse({ action: "retry_effect", ...args }) as TaskControlInput),
  views: effectViews,
};

