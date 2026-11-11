/**
 * Spec 052 routing sign-off (Tom, 2026-10-21). A request for a profile above
 * the usage level's cost ceiling, or rated frontier below Maximum, applies only once the operator signs
 * it off on the board. Queue asks through an operator decision linked to the
 * task; until it is answered the role runs on automatic selection within the
 * level, so nothing waits on the operator. The answer approves the requested
 * profile, picks another, or declines (automatic selection stays). Only an
 * answer given on the board counts; a relayed answer does not sign off.
 */
import { requestOnly, USAGE_LABELS, withinUsage } from "../../shared/pool";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import type { DecisionView, Profile, Task } from "../../shared/contracts";
import { taskOwner } from "../../shared/contracts";
import type { Decisions } from "../planning/decisions";
import type { Store } from "../store/store";
import { now } from "../store/store";
import { coveringGrant, grantSignoff, reconcileRoutingGrants } from "./routing-grants";

const ROLES = ["worker", "reviewer", "coordinator"] as const;
type Role = (typeof ROLES)[number];
type Request = NonNullable<NonNullable<Task["profileRequests"]>[Role]>;
export type Signoff = NonNullable<Request["signoff"]>;

export const OPERATOR_BOARD = "operator (board)";
export const SIGNOFF_DECLINE = "Decline: keep automatic selection";
export const signoffApprove = (name: string) => `Approve: ${name}`;
export const signoffUse = (name: string) => `Use ${name}`;

/** The sign-off a request recorded by the operator on the board carries from the start. */
export const boardSignoff = (): Signoff => ({ status: "approved", decisionId: null, by: OPERATOR_BOARD, at: now(), note: "" });

const nameOf = (profiles: readonly Profile[], profileId: string) => profiles.find(profile => profile.id === profileId)?.name ?? profileId;

/** Other pool profiles the operator may pick instead, by option text. */
function alternatives(store: Store, profiles: readonly Profile[], task: Task, role: Role, requested: string): Map<string, string> {
  const choices = new Map<string, string>();
  for (const entry of store.pool()) {
    if (!entry.enabled || entry.profileId === requested) continue;
    const option = signoffUse(nameOf(profiles, entry.profileId)).slice(0, 200);
    if (!choices.has(option) && choices.size < 13) choices.set(option, entry.profileId);
  }
  return choices;
}

/** What an answered or closed sign-off decision means for the request. */
function outcome(decision: DecisionView | null, approve: string, choices: Map<string, string>): { signoff: Signoff; profileId?: string } {
  const at = now();
  if (!decision) return { signoff: { status: "declined", decisionId: null, by: null, at, note: "The sign-off decision is gone" } };
  const closed = (note: string): { signoff: Signoff } => ({ signoff: { status: "declined", decisionId: decision.id, by: null, at, note } });
  if (decision.status !== "answered" || !decision.answer) return closed(`The sign-off decision was ${decision.status}`);
  const answer = decision.answer;
  if (answer.relayed || answer.answeredBy !== OPERATOR_BOARD)
    return closed("A relayed answer does not sign off a routing request; answer on the board");
  const text = answer.text.trim();
  const signed = (profileId?: string) => ({ signoff: { status: "approved" as const, decisionId: decision.id, by: OPERATOR_BOARD, at, note: "" },
    ...(profileId ? { profileId } : {}) });
  if (text === approve) return signed();
  const chosen = choices.get(text);
  if (chosen) return signed(chosen);
  return { signoff: { status: "declined", decisionId: decision.id, by: OPERATOR_BOARD, at, note: text.slice(0, 400) } };
}

/**
 * One pass over a task's requests: open a decision for each request that needs
 * sign-off and has none, apply each answered one, and withdraw open ones on a
 * finished task. Idempotent; a task with nothing to do is not written.
 */
export function reconcileRoutingSignoffs(store: Store, decisions: Decisions, taskId: string, profiles: readonly Profile[]): void {
  let task: Task;
  try { task = store.task(taskId); } catch { return; }
  if (task.removedAt) return;
  reconcileRoutingGrants(store, decisions);
  try { task = store.task(taskId); } catch { return; }
  const finished = task.phase === "done" || task.phase === "cancelled";
  // Requests can be amended away. Their open decisions are no longer answerable
  // against task state, so close only decisions created by this routing flow.
  {
    let events: Array<{ kind: string; detail: string }> = [];
    try { events = store.eventsAll(task.id); } catch { /* The current request still reconciles below. */ }
    for (const event of events) {
      if (event.kind !== "routing_signoff_requested") continue;
      let record: { role?: Role; decisionId?: string } | null = null;
      try { record = JSON.parse(event.detail); } catch { continue; }
      if (!record?.decisionId || !record.role) continue;
      const current = task.profileRequests?.[record.role]?.signoff;
      if (current?.decisionId === record.decisionId) continue;
      withdrawOpen(decisions, record.decisionId, "The routing request no longer exists");
    }
  }
  const usage = store.usageLevel();
  const pool = store.pool();
  for (const role of ROLES) {
    let request = task.profileRequests?.[role];
    if (!request) continue;
    let signoff = request.signoff;
    if (finished) {
      if (signoff?.status === "pending" && signoff.decisionId) withdrawOpen(decisions, signoff.decisionId, "The task finished; the routing request no longer applies");
      continue;
    }
    const grant = coveringGrant(store, task, request.profileId);
    if (grant) {
      if (signoff?.status === "approved" && !signoff.grantId) continue;
      if (signoff?.status === "declined") continue;
      if (signoff?.status === "approved" && signoff.grantId === grant.id) continue;
      if (signoff?.status === "pending" && signoff.decisionId) withdrawOpen(decisions, signoff.decisionId, `Covered by planner grant ${grant.id}`);
      const covered: Signoff = grantSignoff(grant);
      task = store.update(task.id, { profileRequests: { ...task.profileRequests, [role]: { ...request, signoff: covered } } }, "routing_signoff",
        JSON.stringify({ role, requested: request.profileId, profileId: request.profileId, status: covered.status, decisionId: covered.decisionId, grantId: grant.id, note: "" }));
      continue;
    }
    if (signoff?.status === "approved" && signoff.grantId) {
      const unsigned = { ...request };
      delete unsigned.signoff;
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
    if (!entry || !requestOnly(entry, usage)) {
      // The level now covers the profile: nothing to ask, and an open question is moot.
      if (signoff?.status === "pending" && signoff.decisionId) withdrawOpen(decisions, signoff.decisionId, `The ${USAGE_LABELS[usage].label} usage level now covers this profile`);
      continue;
    }
    if (signoff?.status === "pending" && signoff.decisionId) {
      let decision: DecisionView | null = null;
      try { decision = decisions.get({ id: signoff.decisionId }); } catch { decision = null; }
      if (decision?.status === "open") continue;
      // The answer maps through the options as they were asked, never a later catalog.
      const asked = signoff.options;
      const result = asked ? outcome(decision, asked.approve, new Map(Object.entries(asked.choices))) : outcome(decision, "", new Map());
      const next: Request = { ...request, ...(result.profileId ? { profileId: result.profileId } : {}), signoff: result.signoff };
      if (result.profileId) delete next.thinkingOptionId; // A different profile does not inherit the request's thinking level.
      // A pending worker replacement aimed at the requested profile follows the operator's pick.
      const replacement = role === "worker" && result.profileId && task.replacementProfile?.profileId === request.profileId
        ? { replacementProfile: { ...task.replacementProfile, profileId: result.profileId } } : {};
      task = store.update(task.id, { profileRequests: { ...task.profileRequests, [role]: next }, ...replacement }, "routing_signoff",
        JSON.stringify({ role, requested: request.profileId, profileId: next.profileId, status: result.signoff.status, decisionId: signoff.decisionId, note: result.signoff.note }));
      continue;
    }
    // Task 515: an approval already given for this task and profile is not
    // asked again; the recorded approval is restored instead of opening a
    // new decision.
    const prior = priorApprovedSignoff(store, task.id, role, request.profileId);
    if (prior) {
      task = store.update(task.id, { profileRequests: { ...task.profileRequests, [role]: { ...request, signoff: prior } } }, "routing_signoff",
        JSON.stringify({ role, requested: request.profileId, profileId: request.profileId, status: prior.status, decisionId: prior.decisionId, note: prior.note }));
      continue;
    }
    const name = nameOf(profiles, request.profileId);
    const approve = signoffApprove(name).slice(0, 200);
    const choices = alternatives(store, profiles, task, role, request.profileId);
    const reference = task.reference ?? task.id;
    const why = withinUsage(usage, entry.cost)
      ? "is rated frontier, which is request-only below Maximum" : `is above the ${USAGE_LABELS[usage].label} usage level (${entry.cost!.replaceAll("_", " ")} cost)`;
    const origin = normalizeRepositoryOrigin(task.repository ?? "");
    const decision = decisions.add({
      // The submission's own request belongs to whoever owns the task now (Spec 040).
      askedBy: !request.requestedBy || request.requestedBy === task.originAgentId ? taskOwner(task) : request.requestedBy,
      project: origin ? { origin, path: task.repoPath } : null,
      tasks: [task.id],
      question: `${reference} ${role}: use ${name}? It ${why}.`.slice(0, 4000),
      context: [`Task: ${task.title}`, `Requested by ${request.requestedBy ?? taskOwner(task)}: ${request.reason}`, "",
        `Until you answer, the ${role} runs on automatic selection within the usage level, and an approval applies from that role's next run. Only an answer on the board signs this off.`].join("\n").slice(0, 20000),
      options: [approve, SIGNOFF_DECLINE, ...choices.keys()],
    });
    const pending: Signoff = { status: "pending", decisionId: decision.id, by: null, at: now(), note: "",
      options: { approve, choices: Object.fromEntries(choices) } };
    task = store.update(task.id, { profileRequests: { ...task.profileRequests, [role]: { ...request, signoff: pending } } }, "routing_signoff_requested",
      JSON.stringify({ role, profileId: request.profileId, decisionId: decision.id }));
  }
}

/**
 * Latest non-grant `routing_signoff` for this task, role and profile.
 * An approval is reused (task 515). A decline is returned so a covering grant
 * cannot rewrite a closed no; callers attach it only when coveringGrant is set.
 * Without a grant, today's route leaves the request unsigned. A later ruling
 * for the same role and profile wins. Grant-tagged records are skipped so a
 * revoked grant cannot mask a true operator no.
 */
export function priorNonGrantSignoff(store: Store, taskId: string, role: Role, profileId: string): Signoff | null {
  let events: Array<{ kind: string; detail: string }>;
  try { events = store.eventsAll(taskId); } catch { return null; }
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.kind !== "routing_signoff") continue;
    let record: { role?: string; profileId?: string; status?: string; decisionId?: string | null; grantId?: string } | null = null;
    try { record = JSON.parse(event.detail); } catch { continue; }
    if (record?.role !== role || record.profileId !== profileId) continue;
    if (record.grantId) continue;
    if (record.status === "approved")
      return { status: "approved", decisionId: record.decisionId ?? null, by: OPERATOR_BOARD, at: now(), note: "" };
    if (record.status === "declined")
      return { status: "declined", decisionId: record.decisionId ?? null, by: OPERATOR_BOARD, at: now(), note: "" };
    return null;
  }
  return null;
}

/** Task 515: an approval already given for this task and profile is not asked again. */
function priorApprovedSignoff(store: Store, taskId: string, role: Role, profileId: string): Signoff | null {
  const prior = priorNonGrantSignoff(store, taskId, role, profileId);
  return prior?.status === "approved" ? prior : null;
}

/** Withdraws a sign-off decision that is still open; a closed one is left as it is. */
export function withdrawOpen(decisions: Decisions, decisionId: string, reason: string): void {
  try {
    const decision = decisions.get({ id: decisionId });
    if (decision.status === "open") decisions.withdraw({ id: decision.id, version: decision.version, reason, withdrawnBy: "queue" });
  } catch { /* Gone or already closed: nothing to withdraw. */ }
}
