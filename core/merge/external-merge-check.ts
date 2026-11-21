import { isDispositionActive, isDispositionComplete, type Incident, type Run, type Task } from "../../shared/contracts";
import { dispatchBlocked } from "../dispatch/capacity";
import { escalationWaitDetail, findOpenPlannerEscalation, plannerEscalations, PLANNER_ESCALATION_CHOICES, type LadderEvent } from "../questions/ladder";
import { incidentKey } from "../recovery/incident";
import { ACCEPTED_PR_RECONCILIATION_REASON, EXTERNAL_MERGE_CHECK_REASON_PREFIX, EXTERNAL_MERGE_CHECK_RECOVERED_REASON } from "../recovery/task-reasons";
import { digest, type Store } from "../store/store";
import type { Resolution } from "../resolution";

/**
 * The one owner of the external-merge *check* park: the transient external-merge
 * probe failure that parks a task in `reviewing`, the proof that a fresh probe
 * recovered exactly that park, the restore of the state it interrupted, and the
 * separate stop of an unreviewed external merge.
 *
 * The predicate that recognises a recoverable park is written as its named
 * facts instead of one fifteen-condition expression, so each condition says what
 * it proves. Everything reads typed lifecycle state: the reason prefix is the
 * one Queue recorded, never provider prose.
 */
export type ExternalMergeCheckStore = Pick<Store, "event" | "eventsAll" | "getMeta" | "putRun" | "run" | "runs" | "task" | "transaction">;
export interface ExternalMergeCheckContext {
  store: ExternalMergeCheckStore;
  resolution: Pick<Resolution, "openPlannerEscalation" | "paused" | "update" | "waiting">;
}

/** The task still sits exactly where the check left it: reviewing, nothing disposed or dispatch-blocked. */
function checkParkedTask(task: Task, run: Run | null): boolean {
  return Boolean(run && !task.removedAt && task.phase === "reviewing"
    && !isDispositionActive(task) && !isDispositionComplete(task) && !dispatchBlocked(task));
}

/** The stored incident is this check's own reconciling reviewer incident. */
function checkIncident(incident: Incident | null | undefined, run: Run | null): incident is Incident {
  return Boolean(incident && run && incident.status === "reconciling" && incident.action === ""
    && incident.role === "reviewer" && incident.runId === run.id
    && incident.detail.startsWith(EXTERNAL_MERGE_CHECK_REASON_PREFIX));
}

/** One unreleased, running reviewer run owns the task, and it is this incident's run. */
function soleReviewerRun(run: Run, runs: Run[]): boolean {
  return run.role === "reviewer" && run.status === "running" && !run.released && !run.completion
    && !runs.some(item => !item.released && item.id !== run.id);
}

/** The incident still derives from its own detail: the recorded fingerprint is unchanged. */
function incidentFingerprintUnchanged(task: Task, run: Run, incident: Incident, runs: Run[]): boolean {
  return incidentKey(task, run, incident.detail, runs).id === (incident.fingerprint || incident.id);
}

/** Attention, when it is raised at all, is this same check — not a second, unrelated park. */
function attentionOnlyOnThisCheck(task: Task): boolean {
  return !task.resolution.attention || task.reasonFact?.code === "external_merge_check";
}

/** No recovery episode or stalled turn is still open over the park. */
function noOpenEpisode(task: Task): boolean {
  if (task.resolution.recoveryActive || task.resolution.recovery && task.resolution.recovery.status !== "resolved") return false;
  return !task.resolution.stalledTurnStop || task.resolution.stalledTurnStop.status === "completed";
}

/** No merge intent, recorded merge, integration turn, uncertain merge outcome or publication holds it. */
function noMergeOrPublicationEffect(store: Pick<Store, "getMeta">, task: Task, run: Run): boolean {
  const resolution = task.resolution;
  if (resolution.mergeIntent || resolution.mergeHead || resolution.mergedCommit || resolution.externalMerge || resolution.integrationTurn
    || resolution.mergeResponseOutcome === "uncertain" || resolution.mergeRetryOutcome === "uncertain") return false;
  return !store.getMeta(`reviewPublication:${run.id}`);
}

/**
 * The reconciling external-check incident that a fresh successful probe proves
 * recovered, or null. Every condition is one of the named facts above.
 */
export function recoveredExternalCheckIncident(
  context: ExternalMergeCheckContext,
  task: Task,
): Incident | null {
  const { store, resolution } = context;
  const incident = task.resolution.incident;
  if (resolution.paused()) return null;
  const run = task.resolution.currentRunId ? store.run(task.resolution.currentRunId) : null;
  if (!checkParkedTask(task, run) || !checkIncident(incident, run)) return null;
  const runs = store.runs(task.id);
  if (!soleReviewerRun(run!, runs) || !incidentFingerprintUnchanged(task, run!, incident, runs)) return null;
  if (!attentionOnlyOnThisCheck(task) || !noOpenEpisode(task) || !noMergeOrPublicationEffect(store, task, run!)) return null;
  return incident;
}

/**
 * Restore the phase and reason a task held before a transient external-merge
 * check parked it, clearing the flag and the recorded pre-attention state. When
 * no record exists (an older strand, or a fault that never recorded one) the
 * remembered reason must not pretend to be a resumable phase, so the recovery
 * reason alone is written; the lifecycle sweep can then resume it.
 */
export function resumeFromExternalMergeCheck(
  context: Pick<ExternalMergeCheckContext, "resolution">,
  task: Task,
  fallbackReason: string,
): Task {
  const pre = task.resolution.externalMergePreAttention;
  return context.resolution.update(task, { attention: false, externalMergePreAttention: null },
    pre ? { phase: pre.phase, reason: pre.reason } : { reason: fallbackReason },
    "external_merge_check_recovered");
}

/**
 * Whether an answered escalation's recorded disposition still holds: the stop or the
 * prerequisite wait the answer established is still current (nucleus#1425). A released
 * wait or hold has ended, so the next honest answer is a re-entry, not a silent carry.
 */
function dispositionHolds(task: Task): boolean {
  return Boolean(task.resolution.stop) || Boolean(task.prerequisiteWait && !task.prerequisiteWait.releasedAt);
}

/**
 * Task 993: a freshly observed external merge at a head no recorded review
 * evidence binds is a fact, not an outcome. One transaction supersedes the
 * quiet runs the advance would have released and records the merge fact;
 * the task then parks inside the blocker ladder for its planner, which owns
 * the route: a fresh review of the merged head (`move to=review`) or an
 * operator source acceptance (`move to=closeout`). A repeated observation
 * on the same cause attaches to the open escalation instead of asking again.
 */
export function stopUnreviewedExternalMerge(
  context: ExternalMergeCheckContext,
  current: Task,
  head: string,
  commit: string,
): void {
  const { store, resolution } = context;
  // The cause is a stable per-task, per-head digest: the ladder's escalation
  // parser reads a 64-hex cause, and a repeated observation on the same cause
  // must join the open escalation instead of opening another one.
  const cause = digest(["unreviewed-external-merge", current.id, head].join(":"));
  const prNumber = current.reviewEntry?.prNumber ?? current.resumePrNumber ?? current.completion?.prNumber ?? null;
  const detail = `The PR${prNumber ? ` #${prNumber}` : ""} merged outside Queue at head ${head} (merge commit ${commit}), but no recorded ready_to_merge review, reviewer source approval, qualified owner acceptance or operator source acceptance binds that merged head. The merge is recorded as an observed fact; the task stopped for its planner and nothing was advanced, synced or reverted.`;
  const events = store.eventsAll(current.id) as LadderEvent[];
  const existing = findOpenPlannerEscalation(events, cause);
  // nucleus#1425: an answered escalation for this same cause whose recorded wait or
  // stop still holds is honored. A reobservation of the unchanged merge neither reopens
  // the question nor restates the answer; re-entry waits for the wait to release or the
  // owner to change the disposition.
  const answered = existing ? null : plannerEscalations(events).filter(item => item.cause === cause).at(-1) ?? null;
  const honored = answered?.answered && dispositionHolds(store.task(current.id)) ? answered : null;
  store.transaction(() => {
    const stopped = store.runs(current.id).filter(run => !run.released);
    for (const run of stopped) store.putRun({ ...run, released: true, status: "superseded" });
    store.event(current.id, "external_merge_unreviewed", `${detail}${stopped.length ? ` Superseded quiet runs: ${stopped.map(run => run.id).join(", ")}.` : ""}`.slice(0, 4000));
  });
  // nucleus#1425: the stop keeps the observed merge's exact identities, so the fresh
  // review route and its verdict bind this merged source and nothing else.
  const record = prNumber ? { prNumber, head, commit } : null;
  if (record && JSON.stringify(store.task(current.id).resolution.unreviewedMerge) !== JSON.stringify(record))
    resolution.update(store.task(current.id), { unreviewedMerge: record }, {}, "external_merge_unreviewed_recorded", `PR #${record.prNumber} merged at ${head} (commit ${commit})`);
  if (honored) return;
  if (existing) {
    resolution.waiting(store.task(current.id), escalationWaitDetail.attached(existing.id), "escalated");
    return;
  }
  // The park's phase rides its own write BEFORE the escalation records its
  // stop: a lifecycle-changing write clears a stop that merely repeats, so
  // the escalated park is recorded after the phase settled (store.update's
  // stop rule).
  const parked = store.task(current.id);
  if (parked.phase !== "blocked" && !["done", "cancelled"].includes(parked.phase))
    resolution.update(parked, {}, { phase: "blocked" }, "external_merge_unreviewed_stopped");
  const question = `The responsible task "${current.title}"'s PR${prNumber ? ` #${prNumber}` : ""} merged outside Queue at head ${head} (merge commit ${commit}) with no recorded review evidence binding that merged head, so Nucleus did not count the merge. Two routes differ and neither is the other. (1) Independent review: move to=review starts a fresh reviewer at merged head ${head}; only that reviewer's ready_to_merge verdict at ${head} reconciles the merge, and a verdict at any other head does not count. (2) Operator source acceptance: only the operator accepts that exact head, with move to=closeout and qualification ${head}, recording the missing review evidence. A planner hand-back, a generic approval or a review of another head is not that acceptance. Choose how it proceeds: ${PLANNER_ESCALATION_CHOICES.join("; ")}. You may also answer directly with the direction Queue should follow.`;
  resolution.openPlannerEscalation(store.task(current.id), {
    cause, runId: null, question, payload: { cause, head, commit, prNumber, question },
    causeDetail: detail.slice(0, 2000),
  });
}

/**
 * Lifecycle sweep (project-a #1837): a task parked in `needs_attention` with the
 * attention flag already cleared, no current run and no unreleased run has
 * nothing that will advance it. When the previous episode recorded the state a
 * transient external-merge check interrupted, restore that phase and reason so
 * the ordinary resolution path runs again instead of idling.
 */
export function resumeClearedAttention(
  context: Pick<ExternalMergeCheckContext, "resolution" | "store">,
  task: Task,
): Task | null {
  if (task.phase !== "needs_attention" || task.resolution.attention || task.resolution.currentRunId) return null;
  if (context.store.runs(task.id).some(run => !run.released)) return null;
  const pre = task.resolution.externalMergePreAttention;
  const checkReason = task.reasonFact?.code === "external_merge_check" || task.reasonFact?.code === "external_merge_recovered";
  // A record beside any other reason was superseded by the action that wrote that
  // reason; restoring an old phase over it would undo the pending resolution.
  if (!checkReason) {
    if (pre) context.resolution.update(task, { externalMergePreAttention: null }, {}, "external_merge_pre_attention_superseded");
    return null;
  }
  if (pre) return context.resolution.update(task, { externalMergePreAttention: null }, { phase: pre.phase, reason: pre.reason }, "external_merge_pre_attention_restored");
  // A strand from before the record existed carries the recovered reason on a
  // task whose accepted PR is still final: resume the accepted-PR reconciliation
  // that was pending when the check failed, and let advance() route it.
  if (task.reasonFact?.code !== "external_merge_recovered") return null;
  if (task.completion?.status !== "ready_for_review" || !task.prHead || !task.workspaceId) return null;
  return context.resolution.update(task, { attention: false }, { reason: ACCEPTED_PR_RECONCILIATION_REASON }, "external_merge_check_recovered_resumed");
}
