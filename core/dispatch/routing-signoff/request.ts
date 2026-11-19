import { isOperatorBoardOrT3 } from "../../../shared/operator-identity";
/**
 * Spec 052 routing sign-off (Tom, 2026-10-21). A request for a profile above
 * the usage level's cost ceiling, or rated frontier below Maximum, applies only once the operator signs
 * it off on the board. Queue asks through an operator decision linked to the
 * task; until it is answered the role runs on automatic selection within the
 * level, so nothing waits on the operator. The answer approves the requested
 * profile, picks another, or declines (automatic selection stays). Only an
 * answer given on the board counts; a relayed answer does not sign off.
 *
 * A planner's standing grant (Spec 052, Tom 2026-11-06) is the other writer of
 * the same recorded sign-off, so the shape of a request's sign-off and the rules
 * that change it live here, and both writers call them.
 */
import { USAGE_LABELS, requestOnly } from "../../../shared/pool";
import { requestedTier } from "../../../shared/demand";
import { clipDecisionQuestion, type DecisionView, type Profile, type RoutingGrant, type Task } from "../../../shared/contracts";
import type { Decisions } from "../../planning/decisions";
import type { Store } from "../../store/store";
import { now } from "../../store/store";

export const ROLES = ["worker", "reviewer", "coordinator"] as const;
export type Role = (typeof ROLES)[number];
export type Request = NonNullable<NonNullable<Task["profileRequests"]>[Role]>;
export type Signoff = NonNullable<Request["signoff"]>;
export type ApprovedRoute = { role: Role; profileId: string; decisionId: string; reason: string; now: boolean };

export const OPERATOR_BOARD = "operator (board)";
export const SIGNOFF_DECLINE = "Decline: keep automatic selection";
export const signoffApprove = (name: string) => `Approve: ${name}`;
export const signoffUse = (name: string) => `Use ${name}`;

/** The sign-off a request recorded by the operator on the board carries from the start. */
export const boardSignoff = (): Signoff => ({ status: "approved", decisionId: null, by: OPERATOR_BOARD, at: now(), note: "" });

/** The sign-off a standing grant writes on a request it covers. */
export function grantSignoff(grant: RoutingGrant): Signoff {
  return { status: "approved", decisionId: grant.decisionId, by: OPERATOR_BOARD, at: grant.activatedAt ?? now(), note: "", grantId: grant.id };
}

const nameOf = (profiles: readonly Profile[], profileId: string) => profiles.find(profile => profile.id === profileId)?.name ?? profileId;

/** Other pool profiles the operator may pick instead, by option text. */
export function alternatives(store: Store, profiles: readonly Profile[], requested: string): Map<string, string> {
  const choices = new Map<string, string>();
  for (const entry of store.pool()) {
    if (!entry.enabled || entry.profileId === requested) continue;
    const option = signoffUse(nameOf(profiles, entry.profileId)).slice(0, 200);
    if (!choices.has(option) && choices.size < 13) choices.set(option, entry.profileId);
  }
  return choices;
}

/** What an answered or closed sign-off decision means for the request. */
export function outcome(decision: DecisionView | null, approve: string, choices: Map<string, string>): { signoff: Signoff; profileId?: string } {
  const at = now();
  if (!decision) return { signoff: { status: "declined", decisionId: null, by: null, at, note: "The sign-off decision is gone" } };
  const closed = (note: string): { signoff: Signoff } => ({ signoff: { status: "declined", decisionId: decision.id, by: null, at, note } });
  if (decision.status !== "answered" || !decision.answer) return closed(`The sign-off decision was ${decision.status}`);
  const answer = decision.answer;
  if (answer.relayed || !isOperatorBoardOrT3(answer.answeredBy))
    return closed("A relayed answer does not sign off a routing request; answer on the board");
  const text = answer.text.trim();
  const signed = (profileId?: string) => ({ signoff: { status: "approved" as const, decisionId: decision.id, by: answer.answeredBy, at, note: "" },
    ...(profileId ? { profileId } : {}) });
  if (text === approve) return signed();
  const chosen = choices.get(text);
  if (chosen) return signed(chosen);
  return { signoff: { status: "declined", decisionId: decision.id, by: OPERATOR_BOARD, at, note: text.slice(0, 400) } };
}

/**
 * Withdraws a sign-off decision that is still open; a closed one is left as it
 * is. Returns whether the decision is now closed, so the caller can record a
 * withdrawal that did not happen instead of losing it.
 */
export function withdrawOpen(decisions: Decisions, decisionId: string, reason: string): boolean {
  try {
    const decision = decisions.get({ id: decisionId });
    if (decision.status !== "open") return true;
    decisions.withdraw({ id: decision.id, version: decision.version, reason, withdrawnBy: "queue" });
    return true;
  } catch { return false; }
}

/**
 * The request a standing grant signs off, or null when the grant leaves it
 * alone: an operator's own per-task approval is never replaced, a decline
 * stands, and the grant's own sign-off is already applied. An open question the
 * grant covers is withdrawn, so nothing waits on the operator.
 */
export function withGrantSignoff(decisions: Decisions, request: Request, grant: RoutingGrant): Request | null {
  const signoff = request.signoff;
  if (signoff?.status === "declined") return null;
  if (signoff?.status === "approved" && (!signoff.grantId || signoff.grantId === grant.id)) return null;
  if (signoff?.status === "pending" && signoff.decisionId) withdrawOpen(decisions, signoff.decisionId, `Covered by planner grant ${grant.id}`);
  return { ...request, signoff: grantSignoff(grant) };
}

/**
 * The request a grant that has ended leaves behind: automatic selection, the
 * grant it came from recorded so the same grant cannot cover it again. Ending,
 * revoking, expiring or archiving a grant writes this over every task it covered.
 */
export function withEndedGrant(request: Request, grantId: string): Request | null {
  if (request.signoff?.grantId !== grantId) return null;
  return { ...request, signoff: { status: "pending", decisionId: null, by: null,
    at: now(), note: "", endedGrantId: grantId } };
}

/**
 * The request a grant sign-off that no longer covers it is cleared from: the
 * sign-off goes, and the request is unsigned rather than waiting on a question
 * nobody asked. A task a grant ended under is already marked by
 * `withEndedGrant`; this is the record for a task that was not live at the time.
 */
export function withoutGrantSignoff(request: Request): Request {
  const unsigned = { ...request };
  delete unsigned.signoff;
  return unsigned;
}

/** The routing sign-off events, decoded once: the ask, and each recorded outcome. */
export type SignoffEvent =
  | { kind: "requested"; role: Role; profileId: string; decisionId: string }
  | { kind: "recorded"; role: Role; profileId: string; status: string; decisionId: string | null; grantId: string | null };

const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);
const textOf = (value: unknown): string | null => typeof value === "string" && value ? value : null;

/**
 * The task's routing sign-off events as typed records. Both event kinds carry
 * their state as JSON detail, so this is the one place that decodes them; a row
 * it cannot read is skipped rather than read as an absence.
 */
export function readSignoffEvents(store: Store, taskId: string): SignoffEvent[] {
  let rows: Array<{ kind: string; detail: string }>;
  try { rows = store.eventsAll(taskId); } catch { return []; }
  const events: SignoffEvent[] = [];
  for (const event of rows) {
    if (event.kind !== "routing_signoff" && event.kind !== "routing_signoff_requested") continue;
    let raw: unknown;
    try { raw = JSON.parse(event.detail); } catch { continue; }
    const record = raw as Record<string, unknown> | null;
    if (!record || typeof record !== "object" || !isRole(record.role)) continue;
    const decisionId = textOf(record.decisionId);
    if (event.kind === "routing_signoff_requested") {
      const profileId = textOf(record.profileId);
      if (profileId && decisionId) events.push({ kind: "requested", role: record.role, profileId, decisionId });
      continue;
    }
    const profileId = textOf(record.profileId);
    if (!profileId) continue;
    events.push({ kind: "recorded", role: record.role, profileId, status: textOf(record.status) ?? "", decisionId, grantId: textOf(record.grantId) });
  }
  return events;
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
  const events = readSignoffEvents(store, taskId);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.kind !== "recorded" || event.role !== role || event.profileId !== profileId) continue;
    if (event.grantId) continue;
    if (event.status === "approved") return { status: "approved", decisionId: event.decisionId, by: OPERATOR_BOARD, at: now(), note: "" };
    if (event.status === "declined") return { status: "declined", decisionId: event.decisionId, by: OPERATOR_BOARD, at: now(), note: "" };
    return null;
  }
  return null;
}

/** Task 515: an approval already given for this task and profile is not asked again. */
export function priorApprovedSignoff(store: Store, taskId: string, role: Role, profileId: string): Signoff | null {
  const prior = priorNonGrantSignoff(store, taskId, role, profileId);
  return prior?.status === "approved" ? prior : null;
}

/** The question a request that the usage level does not cover is asked, and why. */
export function signoffQuestion(store: Store, profiles: readonly Profile[], task: Task, role: Role, request: Request) {
  const entry = store.pool().find(item => item.profileId === request.profileId)!;
  const usage = store.usageLevel();
  // The question names the tier, not a cost (Tom, 2026-11-17); a request only
  // reaches a gated profile, so the tier is one the level's permission rule holds.
  const why = `is rated ${(entry.capability ?? "unrated").replaceAll("_", " ")}, which needs the operator's permission at the ${USAGE_LABELS[usage].label} usage level`;
  const name = nameOf(profiles, request.profileId);
  return {
    name,
    approve: signoffApprove(name).slice(0, 200),
    choices: alternatives(store, profiles, request.profileId),
    why,
    question: clipDecisionQuestion(`${task.reference ?? task.id} ${role}: use ${name}? It ${why}.`),
  };
}
