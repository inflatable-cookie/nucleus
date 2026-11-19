import { isOperatorBoardOrT3 } from "../../../shared/operator-identity";
/**
 * One pass over a task's routing requests: apply a standing grant that covers a
 * request, clear a sign-off whose grant is gone, ask for each request that needs
 * the operator's sign-off and has no question, apply each answered one, and
 * withdraw open questions that no longer apply. Idempotent; a task with nothing
 * to do is not written.
 */
import { requestOnly, USAGE_LABELS } from "../../../shared/pool";
import { climbedTier, requestedTier } from "../../../shared/demand";
import { normalizeRepositoryOrigin } from "../../../shared/lanes";
import { taskOwner, type Profile, type Task } from "../../../shared/contracts";
import type { Decisions } from "../../planning/decisions";
import type { Store } from "../../store/store";
import { now } from "../../store/store";
import { liveRun, liveRunForRole } from "../../task-decision-rules";
import { coveringGrant, reconcileGrantDecisions } from "./grants";
import { reconcileUsageGate } from "../usage-gate";
import {
  ROLES, SIGNOFF_DECLINE, outcome, priorApprovedSignoff, readSignoffEvents, signoffQuestion,
  withGrantSignoff, withdrawOpen, withoutGrantSignoff,
  type ApprovedRoute, type Request, type Role, type Signoff,
} from "./request";

/** Withdraw the task's open question, and record a withdrawal that did not happen. */
function withdrawSignoff(store: Store, decisions: Decisions, taskId: string, decisionId: string, reason: string): void {
  if (withdrawOpen(decisions, decisionId, reason)) return;
  store.event(taskId, "routing_signoff_withdraw_failed", JSON.stringify({ decisionId, reason }));
}

/**
 * Requests whose question was withdrawn or answered away: an amendment that
 * removes a request leaves its decision unanswerable against task state, so only
 * questions this flow asked are closed.
 */
function closeOrphanedQuestions(store: Store, decisions: Decisions, task: Task): void {
  for (const event of readSignoffEvents(store, task.id)) {
    if (event.kind !== "requested") continue;
    if (task.profileRequests?.[event.role]?.signoff?.decisionId === event.decisionId) continue;
    withdrawSignoff(store, decisions, task.id, event.decisionId, "The routing request no longer exists");
  }
}

export function reconcileRoutingSignoffs(store: Store, decisions: Decisions, taskId: string, profiles: readonly Profile[]): ApprovedRoute[] {
  const approvedRoutes: ApprovedRoute[] = [];
  let task: Task;
  try { task = store.task(taskId); } catch { return approvedRoutes; }
  if (task.removedAt) return approvedRoutes;
  // Expire and answered grants, never the queue-wide settle: this pass runs once
  // per task per sweep, and the task it is for settles below.
  reconcileGrantDecisions(store, decisions);
  // Spec 052 (Tom, 2026-11-17): the Low usage level's submission gate opens one
  // board decision and holds a high-complexity task until it is approved.
  reconcileUsageGate(store, decisions, taskId, profiles);
  try { task = store.task(taskId); } catch { return approvedRoutes; }
  const finished = task.phase === "done" || task.phase === "cancelled";
  task = reconcileUnavailablePreference(store, decisions, task, profiles, finished);
  // A required legacy preference is also a worker routing request. Materialize
  // it only when it needs board sign-off, so the same decision lifecycle can
  // surface and settle it instead of leaving an invisible required wait.
  const preference = poolEntryForRequiredPreference(task, store);
  if (!finished && preference) {
    task = store.update(task.id, { profileRequests: { ...task.profileRequests, worker: {
      profileId: preference, required: true, reason: 'Required worker preference in the submitted task',
      ...(task.thinkingOptionId ? { thinkingOptionId: task.thinkingOptionId } : {}),
    } } }, 'routing_preference_requested', `Required worker preference ${preference} requires board sign-off`);
  }
  closeOrphanedQuestions(store, decisions, task);
  const usage = store.usageLevel();
  const pool = store.pool();
  for (const role of ROLES) {
    let request: Request | undefined = task.profileRequests?.[role];
    if (!request) continue;
    let signoff: Signoff | undefined = request.signoff;
    if (finished) {
      if (signoff?.status === "pending" && signoff.decisionId)
        withdrawSignoff(store, decisions, task.id, signoff.decisionId, "The task finished; the routing request no longer applies");
      continue;
    }
    const grant = coveringGrant(store, task, request.profileId);
    if (grant) {
      const covered = withGrantSignoff(decisions, request, grant);
      if (!covered) continue;
      task = store.update(task.id, { profileRequests: { ...task.profileRequests, [role]: covered } }, "routing_signoff",
        JSON.stringify({ role, requested: request.profileId, profileId: request.profileId, status: covered.signoff!.status, decisionId: covered.signoff!.decisionId, grantId: grant.id, note: "" }));
      continue;
    }
    if (signoff?.status === "approved" && signoff.grantId) {
      const unsigned = withoutGrantSignoff(request);
      task = store.update(task.id, { profileRequests: { ...task.profileRequests, [role]: unsigned } }, "routing_signoff",
        JSON.stringify({ role, requested: request.profileId, profileId: request.profileId, status: "cleared", grantId: signoff.grantId }));
      request = unsigned;
      signoff = undefined;
    }
    // A grant-covered request stays automatic after that grant ends. A fresh
    // explicit request replaces this marker at its writer and can ask again.
    if (signoff?.endedGrantId) continue;
    if (signoff?.status === "approved" || signoff?.status === "declined") continue;
    const entry = pool.find(item => item.profileId === request.profileId);
    if (!entry || !requestOnly(entry, usage, requestedTier(task.complexity), climbedTier(task))) {
      // The level now covers the profile: nothing to ask, and an open question is moot.
      if (signoff?.status === "pending" && signoff.decisionId)
        withdrawSignoff(store, decisions, task.id, signoff.decisionId, `The ${USAGE_LABELS[usage].label} usage level now covers this profile`);
      continue;
    }
    const asked = signoff?.status === "pending" ? signoff : undefined;
    if (asked?.decisionId) {
      let decision = null;
      try { decision = decisions.get({ id: asked.decisionId }); } catch { decision = null; }
      if (decision?.status === "open") continue;
      // The answer maps through the options as they were asked, never a later catalog.
      const result = asked.options ? outcome(decision, asked.options.approve, new Map(Object.entries(asked.options.choices)))
        : outcome(decision, "", new Map());
      const next: Request = { ...request, ...(result.profileId ? { profileId: result.profileId } : {}), signoff: result.signoff };
      if (result.profileId) delete next.thinkingOptionId; // A different profile does not inherit the request's thinking level.
      // A pending worker replacement aimed at the requested profile follows the operator's pick.
      const replacement = role === "worker" && result.profileId && task.replacementProfile?.profileId === request.profileId
        ? { replacementProfile: { ...task.replacementProfile, profileId: result.profileId } } : {};
      task = store.update(task.id, { profileRequests: { ...task.profileRequests, [role]: next }, ...replacement }, "routing_signoff",
        JSON.stringify({ role, requested: request.profileId, profileId: next.profileId, status: result.signoff.status, decisionId: asked.decisionId, by: result.signoff.by, note: result.signoff.note }));
      if (result.signoff.status === "approved" && asked.decisionId) approveRoute(approvedRoutes, store, task, role, next, asked.decisionId, request.reason);
      continue;
    }
    // Task 515: an approval already given for this task and profile is not
    // asked again; the recorded approval is restored instead of opening a
    // new decision.
    const prior = priorApprovedSignoff(store, task.id, role, request.profileId);
    if (prior) {
      task = store.update(task.id, { profileRequests: { ...task.profileRequests, [role]: { ...request, signoff: prior } } }, "routing_signoff",
        JSON.stringify({ role, requested: request.profileId, profileId: request.profileId, status: prior.status, decisionId: prior.decisionId, by: prior.by, note: prior.note }));
      continue;
    }
    const question = signoffQuestion(store, profiles, task, role, request);
    const origin = normalizeRepositoryOrigin(task.repository ?? "");
    const decision = decisions.add({
      // The submission's own request belongs to whoever owns the task now (Spec 040).
      askedBy: !request.requestedBy || request.requestedBy === task.originAgentId ? taskOwner(task) : request.requestedBy,
      project: origin ? { origin, path: task.repoPath } : null,
      tasks: [task.id],
      question: question.question,
      context: [`Task: ${task.title}`, `Requested by ${request.requestedBy ?? taskOwner(task)}: ${request.reason}`, "",
        `Until you answer, the ${role} runs on automatic selection within the usage level, and an approval applies from that role's next run. Only an answer on the board signs this off.`].join("\n").slice(0, 20000),
      options: [question.approve, SIGNOFF_DECLINE, ...question.choices.keys()],
    });
    const pending: Signoff = { status: "pending", decisionId: decision.id, by: null, at: now(), note: "",
      options: { approve: question.approve, choices: Object.fromEntries(question.choices) } };
    task = store.update(task.id, { profileRequests: { ...task.profileRequests, [role]: { ...request, signoff: pending } } }, "routing_signoff_requested",
      JSON.stringify({ role, profileId: request.profileId, decisionId: decision.id }));
  }
  return approvedRoutes;
}

/** An unavailable required preference needs a choice, not a profile sign-off. */
function reconcileUnavailablePreference(store: Store, decisions: Decisions, task: Task, profiles: readonly Profile[], finished: boolean): Task {
  const request = task.profileRequests?.worker;
  const profileId = request?.required ? request.profileId : !request && task.requirePreferred ? task.preferredProfileId : '';
  const events = store.eventsAll(task.id);
  // Reconcile all prior questions before consulting the current preference: a
  // changed or cleared request must not leave an answerable orphan behind.
  for (const event of events.filter(item => item.kind === 'routing_unavailable_requested')) {
    const split = event.detail.indexOf(': ');
    if (split < 0) continue;
    const requested = event.detail.slice(0, split);
    if (requested === profileId && !finished && !task.agentIntent && !task.agentId) continue;
    if (events.some(item => item.id > event.id && item.kind === 'routing_unavailable_resolved' && item.detail.startsWith(`${requested}: `))) continue;
    try {
      const record = JSON.parse(event.detail.slice(split + 2)) as { decisionId: string };
      if (withdrawOpen(decisions, record.decisionId, 'The required routing preference changed or the task advanced'))
        store.event(task.id, 'routing_unavailable_resolved', `${requested}: routing preference changed`);
      else store.event(task.id, 'routing_signoff_withdraw_failed', JSON.stringify({ decisionId: record.decisionId, reason: 'The required routing preference changed or the task advanced' }));
    } catch { /* Preserve unreadable evidence rather than guessing its identity. */ }
  }
  if (!profileId) return task;
  const entry = store.pool().find(item => item.profileId === profileId);
  const profile = profiles.find(item => item.id === profileId);
  const last = store.eventsAll(task.id).findLast(event => ['routing_unavailable_requested', 'routing_unavailable_resolved'].includes(event.kind) && event.detail.startsWith(`${profileId}: `));
  const prior = last?.kind === 'routing_unavailable_requested' ? last : undefined;
  if (entry?.enabled && profile?.available || finished || task.agentIntent || task.agentId) {
    if (prior) {
      try {
        const record = JSON.parse(prior.detail.slice(profileId.length + 2)) as { decisionId: string };
        withdrawSignoff(store, decisions, task.id, record.decisionId, 'The required routing wait no longer applies');
        store.event(task.id, 'routing_unavailable_resolved', `${profileId}: routing wait ended`);
      } catch { /* Keep unreadable evidence rather than guessing its identity. */ }
    }
    return task;
  }
  if (prior) {
    let record: { decisionId: string; choices: Record<string, string> };
    try { record = JSON.parse(prior.detail.slice(profileId.length + 2)); } catch { return task; }
    let decision;
    try { decision = decisions.get({ id: record.decisionId }); } catch { return task; }
    if (decision.status !== 'answered' || !decision.answer || decision.answer.relayed || !isOperatorBoardOrT3(decision.answer.answeredBy)) return task;
    const selected = record.choices[decision.answer.text.trim()];
    if (selected) return store.update(task.id, { profileRequests: { ...task.profileRequests, worker: { profileId: selected, required: true, reason: 'Operator selected an available worker profile' } } },
      'routing_unavailable_resolved', `${profileId}: selected ${selected}`);
    if (decision.answer.text.trim() === SIGNOFF_DECLINE) return store.update(task.id, { requirePreferred: false, preferredProfileId: '',
      profileRequests: { ...task.profileRequests, worker: undefined } }, 'routing_unavailable_resolved', `${profileId}: automatic selection`);
    return task;
  }
  const choices: Record<string, string> = {};
  for (const candidate of store.pool()) {
    const available = profiles.find(item => item.id === candidate.profileId && item.available);
    if (candidate.enabled && available && candidate.profileId !== profileId) choices[`Use ${available.name}`.slice(0, 200)] = candidate.profileId;
  }
  const origin = normalizeRepositoryOrigin(task.repository ?? '');
  const decision = decisions.add({ askedBy: taskOwner(task), project: origin ? { origin, path: task.repoPath } : null, tasks: [task.id],
    question: `Required worker profile ${profileId} is missing, disabled or unavailable. Which route should this task use?`,
    context: 'Selecting a profile does not grant a usage-level sign-off; any required sign-off is asked separately.',
    options: [SIGNOFF_DECLINE, ...Object.keys(choices).slice(0, 13)] });
  store.event(task.id, 'routing_unavailable_requested', `${profileId}: ${JSON.stringify({ decisionId: decision.id, choices })}`);
  return task;
}

function poolEntryForRequiredPreference(task: Task, store: Store): string | null {
  if (!task.requirePreferred || !task.preferredProfileId || task.profileRequests?.worker || task.agentIntent || task.agentId) return null;
  const entry = store.pool().find(item => item.profileId === task.preferredProfileId);
  return entry && requestOnly(entry, store.usageLevel()) ? entry.profileId : null;
}

/** The route an approval asks for, and whether the live run must be replaced to take it now. */
function approveRoute(routes: ApprovedRoute[], store: Store, task: Task, role: Role, next: Request, decisionId: string, reason: string): void {
  const currentRun = task.resolution.currentRunId ? store.run(task.resolution.currentRunId) : null;
  const expectedRole = role === "worker" ? "revision" : role === "reviewer" ? "reviewer" : null;
  const live = role === "worker"
    ? liveRunForRole(task, store.runs(task.id), role)
    : liveRun(currentRun) && currentRun.role === expectedRole ? { run: currentRun } : null;
  const selectedProfileId = live?.run?.profile?.id ?? (role === "worker" && live?.run === null ? task.profile?.id : null);
  routes.push({ role, profileId: next.profileId, decisionId, reason: `Rerouted to ${next.profileId} after approval ${decisionId}: ${reason}`.slice(0, 4000),
    now: Boolean(live && selectedProfileId && selectedProfileId !== next.profileId) });
}
