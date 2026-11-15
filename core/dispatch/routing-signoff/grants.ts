/**
 * Spec 052 planner grants (Tom, 2026-11-06). A planner asks for standing
 * permission to use frontier and above-ceiling profiles for a block of work; the
 * operator says yes on the board; while it stands that planner's own requests
 * and routes take effect without a per-task question. Only a board answer
 * activates a grant.
 *
 * A grant's coverage reaches a task's requests through the sign-off rules in
 * `request.ts`, so the per-task reconcile and this store both write the same
 * record.
 */
import { hostKindOf } from '../../../shared/host-kind';
import { parseAgentId, sameCallerIdentity } from '../../../shared/agent-identity';
import { randomUUID } from "node:crypto";
import { requestOnly } from "../../../shared/pool";
import { clipDecisionQuestion, routingGrantSchema, taskOwner, type RoutingGrant, type Task } from "../../../shared/contracts";
import type { Decisions } from "../../planning/decisions";
import type { Store } from "../../store/store";
import { now } from "../../store/store";
import { ROLES, withdrawOpen, withEndedGrant, withGrantSignoff, type Request } from "./request";

export const GRANT_OPERATOR_BOARD = "operator (board)";
export const GRANT_APPROVE = "Grant standing permission";
export const GRANT_DECLINE = "Decline: keep per-task sign-off";
const GRANT_META = "routingGrants";

export function readRoutingGrants(store: Store): RoutingGrant[] {
  const parsed = routingGrantSchema.array().safeParse(store.getMeta<unknown>(GRANT_META) ?? []);
  return parsed.success ? parsed.data : [];
}

function writeRoutingGrants(store: Store, grants: RoutingGrant[]): void {
  store.setMeta(GRANT_META, grants.map(grant => routingGrantSchema.parse(grant)));
  store.advanceRevision();
}

function grantIsLive(grant: RoutingGrant, at = Date.now()): boolean {
  return grant.status === "active" && (!grant.until || Date.parse(grant.until) > at);
}

/** True when wake must inventory live agents to archive a planner grant. */
export function grantArchiveDue(store: Store, at = Date.now()): boolean {
  return readRoutingGrants(store).some(grant => grant.status === "pending" || grantIsLive(grant, at));
}

function liveGrants(grants: RoutingGrant[], at: number): RoutingGrant[] {
  return grants.filter(grant => grantIsLive(grant, at)).sort((a, b) => (b.activatedAt ?? "").localeCompare(a.activatedAt ?? ""));
}

/** Board projection: live grants only, no persist. Expiry writes on reconcile. */
export function activeRoutingGrants(store: Store, at = Date.now()): RoutingGrant[] {
  return liveGrants(readRoutingGrants(store), at);
}

function replaceGrant(store: Store, next: RoutingGrant): RoutingGrant {
  const grants = readRoutingGrants(store);
  const index = grants.findIndex(grant => grant.id === next.id);
  const updated = index >= 0 ? grants.map(grant => grant.id === next.id ? next : grant) : [...grants, next];
  writeRoutingGrants(store, updated);
  return next;
}

function liveForPlanner(grants: RoutingGrant[], planner: string, at = Date.now()): RoutingGrant | undefined {
  return grants.find(grant => sameCallerIdentity(grant.planner, planner) && (grant.status === "pending" || grantIsLive(grant, at)));
}

function grantCoversProfile(store: Store, grant: RoutingGrant, profileId: string): boolean {
  if (grant.profiles.length) return grant.profiles.includes(profileId);
  const entry = store.pool().find(item => item.profileId === profileId);
  return Boolean(entry && requestOnly(entry, store.usageLevel()));
}

/** The active grant that covers this task's current owner and profile, or null. */
export function coveringGrant(store: Store, task: Task, profileId: string, at = Date.now()): RoutingGrant | null {
  expireStaleGrants(store, at);
  const owner = taskOwner(task);
  for (const grant of readRoutingGrants(store)) {
    if (!grantIsLive(grant, at) || !sameCallerIdentity(grant.planner, owner, undefined, task.originHostId)) continue;
    if (grantCoversProfile(store, grant, profileId)) return grant;
  }
  return null;
}

/** Withdraw a grant's open question, recording a withdrawal that did not happen. */
function withdrawGrantDecision(store: Store, decisions: Decisions, grant: RoutingGrant, reason: string): void {
  if (!grant.decisionId || withdrawOpen(decisions, grant.decisionId, reason)) return;
  store.event('queue', 'routing_grant_withdraw_failed', JSON.stringify({ grantId: grant.id, decisionId: grant.decisionId, reason }));
}

/** The request every live task of the grant's planner carries after the grant ended. */
function clearGrantSignoffs(store: Store, grantId: string): void {
  for (const task of store.liveTasks()) {
    const requests = { ...task.profileRequests };
    let changed = false;
    for (const role of ROLES) {
      const request: Request | undefined = requests[role];
      if (!request) continue;
      const stripped = withEndedGrant(request, grantId);
      if (!stripped) continue;
      requests[role] = stripped;
      changed = true;
    }
    if (!changed) continue;
    store.update(task.id, { profileRequests: requests }, "routing_signoff",
      JSON.stringify({ status: "cleared", grantId }));
  }
}

function applyGrantToTask(store: Store, decisions: Decisions, task: Task, grant: RoutingGrant): void {
  const requests = { ...task.profileRequests };
  let changed = false;
  for (const role of ROLES) {
    const request: Request | undefined = requests[role];
    if (!request) continue;
    if (!grantCoversProfile(store, grant, request.profileId)) continue;
    const covered = withGrantSignoff(decisions, request, grant);
    if (!covered) continue;
    requests[role] = covered;
    changed = true;
  }
  if (!changed) return;
  store.update(task.id, { profileRequests: requests }, "routing_signoff",
    JSON.stringify({ status: "approved", grantId: grant.id, decisionId: grant.decisionId, note: "" }));
}

/**
 * Every live grant applied to every live task it covers, in one scan of the
 * tasks: a request joins the planner's open grant, so a task's owner has at most
 * one live grant and the two loops meet once.
 */
function settleCoveredTasks(store: Store, decisions: Decisions): void {
  const live = liveGrants(readRoutingGrants(store), Date.now());
  if (!live.length) return;
  for (const task of store.liveTasks()) {
    const owner = taskOwner(task);
    for (const grant of live) {
      if (!sameCallerIdentity(grant.planner, owner, undefined, task.originHostId)) continue;
      applyGrantToTask(store, decisions, task, grant);
    }
  }
}

function expireStaleGrants(store: Store, at = Date.now()): void {
  const grants = readRoutingGrants(store);
  const expiredIds: string[] = [];
  const next = grants.map(grant => {
    if (grant.status !== "active" || !grant.until || Date.parse(grant.until) > at) return grant;
    expiredIds.push(grant.id);
    return { ...grant, status: "expired" as const, endedAt: new Date(at).toISOString(), endedBy: "queue", endReason: "expired" };
  });
  if (!expiredIds.length) return;
  writeRoutingGrants(store, next);
  for (const id of expiredIds) clearGrantSignoffs(store, id);
}

function applyAnsweredGrants(store: Store, decisions: Decisions): void {
  for (const grant of readRoutingGrants(store)) {
    if (grant.status !== "pending" || !grant.decisionId) continue;
    let decision = null;
    try { decision = decisions.get({ id: grant.decisionId }); } catch { decision = null; }
    if (decision?.status === "open") continue;
    const at = now();
    const answer = decision?.status === "answered" ? decision.answer : null;
    const boardYes = Boolean(answer && !answer.relayed && answer.answeredBy === GRANT_OPERATOR_BOARD && answer.text.trim() === GRANT_APPROVE);
    if (boardYes) {
      replaceGrant(store, { ...grant, status: "active", activatedAt: at, activatedBy: GRANT_OPERATOR_BOARD });
      settleCoveredTasks(store, decisions);
      continue;
    }
    const note = !decision ? "The grant decision is gone"
      : answer?.relayed || (answer && answer.answeredBy !== GRANT_OPERATOR_BOARD)
        ? "A relayed answer does not activate a grant; answer on the board"
        : decision.status === "answered" ? (answer?.text ?? "declined").slice(0, 400)
          : `The grant decision was ${decision.status}`;
    replaceGrant(store, { ...grant, status: "declined", endedAt: at, endedBy: answer?.answeredBy ?? null, endReason: note });
  }
}

/**
 * Expire, apply answered grant decisions, and settle covered per-task sign-offs.
 * Idempotent, and the store-wide entry point: the per-task reconcile reads
 * `reconcileGrantDecisions` instead so one task's pass never re-settles the queue.
 */
export function reconcileRoutingGrants(store: Store, decisions: Decisions): void {
  reconcileGrantDecisions(store, decisions);
  settleCoveredTasks(store, decisions);
}

/** Expire stale grants and apply answered grant decisions, without the queue-wide settle. */
export function reconcileGrantDecisions(store: Store, decisions: Decisions): void {
  expireStaleGrants(store);
  applyAnsweredGrants(store, decisions);
}

/** An archived planner thread ends its grant. `live` is the unarchived agent set; a failed inventory must not call this. */
export function archiveRoutingGrants(store: Store, decisions: Decisions, live: ReadonlySet<string>, observedHostId?: string): void {
  reconcileRoutingGrants(store, decisions);
  const at = now();
  for (const grant of readRoutingGrants(store)) {
    if (!(grant.status === "pending" || grantIsLive(grant))) continue;
    const plannerHost = parseAgentId(grant.planner)?.hostId;
    if (plannerHost && plannerHost !== observedHostId || !plannerHost && observedHostId && hostKindOf(observedHostId) !== 'paseo') continue;
    if ([...live].some(id => sameCallerIdentity(grant.planner, id, undefined, observedHostId))) continue;
    withdrawGrantDecision(store, decisions, grant, "The planner thread was archived; the grant no longer applies");
    const ended = replaceGrant(store, { ...grant, status: "archived", endedAt: at, endedBy: "queue", endReason: "archived" });
    clearGrantSignoffs(store, ended.id);
  }
}

function findGrant(store: Store, grantId: string | undefined, planner?: string): RoutingGrant {
  const grants = readRoutingGrants(store);
  const grant = grantId ? grants.find(item => item.id === grantId)
    : planner ? liveForPlanner(grants, planner) ?? grants.filter(item => sameCallerIdentity(item.planner, planner)).at(-1)
      : undefined;
  if (!grant) throw new Error(grantId ? `Unknown routing grant ${grantId}` : "No routing grant for this planner");
  return grant;
}

function endGrant(store: Store, decisions: Decisions, grant: RoutingGrant, endedBy: string, status: "ended" | "revoked", reason: string): RoutingGrant {
  if (grant.status !== "pending" && grant.status !== "active") return grant;
  withdrawGrantDecision(store, decisions, grant, reason);
  const ended = replaceGrant(store, { ...grant, status, endedAt: now(), endedBy, endReason: reason.slice(0, 400) });
  clearGrantSignoffs(store, ended.id);
  return ended;
}

export function applyRoutingGrant(store: Store, decisions: Decisions, input: {
  action: "request" | "end" | "revoke";
  caller: string;
  reason?: string;
  profiles?: string[];
  until?: string | null;
  grantId?: string;
}): { grant: RoutingGrant; joined: boolean; alreadyActive: boolean } {
  const caller = input.caller.trim();
  if (!caller) throw new Error("queue.routing-grant requires caller");
  reconcileRoutingGrants(store, decisions);

  if (input.action === "revoke") {
    if (caller !== GRANT_OPERATOR_BOARD) throw new Error("Only the operator at the board revokes a routing grant");
    const grant = findGrant(store, input.grantId);
    const ended = endGrant(store, decisions, grant, GRANT_OPERATOR_BOARD, "revoked", input.reason?.trim() || "revoked");
    return { grant: ended, joined: false, alreadyActive: false };
  }

  if (input.action === "end") {
    if (caller === GRANT_OPERATOR_BOARD || caller === "operator")
      throw new Error("The operator revokes a grant from the board; a planner ends their own");
    const grant = findGrant(store, input.grantId, caller);
    if (!sameCallerIdentity(grant.planner, caller)) throw new Error("A planner ends only their own grant");
    const ended = endGrant(store, decisions, grant, caller, "ended", input.reason?.trim() || "ended");
    return { grant: ended, joined: false, alreadyActive: false };
  }

  if (caller === GRANT_OPERATOR_BOARD || caller === "operator")
    throw new Error("A planner requests a grant; the operator answers the decision on the board");
  const reason = (input.reason ?? "").trim();
  if (!reason) throw new Error("A grant request needs a reason");
  const until = input.until ?? null;
  if (until && Date.parse(until) <= Date.now()) throw new Error("`until` must be in the future");
  const profiles = [...new Set((input.profiles ?? []).map(id => id.trim()).filter(Boolean))];
  const pool = store.pool();
  for (const profileId of profiles) {
    if (!pool.some(entry => entry.profileId === profileId)) throw new Error(`Unknown profile ${profileId}`);
  }

  const existing = liveForPlanner(readRoutingGrants(store), caller);
  if (existing?.status === "active") return { grant: existing, joined: false, alreadyActive: true };
  if (existing?.status === "pending") return { grant: existing, joined: true, alreadyActive: false };

  const stamp = now();
  const id = randomUUID();
  const named = profiles.length ? `named profiles ${profiles.join(", ")}` : "every frontier and above-ceiling profile";
  const untilLine = until ? ` Until ${until}.` : "";
  const decision = decisions.add({
    askedBy: caller,
    question: clipDecisionQuestion(`Grant planner ${caller} standing permission to use frontier and above-ceiling profiles for this block of work?`),
    headline: "Grant this planner frontier models?",
    context: [`Requested by ${caller}: ${reason}`, `Covers ${named}.${untilLine}`, "",
      "A yes activates the grant. While it stands, this planner's own profile requests and routes take effect without a per-task question. Automatic selection and other planners are unchanged. Only an answer on the board activates the grant."].join("\n").slice(0, 20000),
    options: [GRANT_APPROVE, GRANT_DECLINE],
    recommendation: GRANT_APPROVE,
  });
  const grant = replaceGrant(store, {
    id, planner: caller, reason, profiles, until, status: "pending",
    requestedAt: stamp, requestedBy: caller, decisionId: decision.id,
    activatedAt: null, activatedBy: null, endedAt: null, endedBy: null, endReason: null, runCount: 0,
  });
  return { grant, joined: false, alreadyActive: false };
}
