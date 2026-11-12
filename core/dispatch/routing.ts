import type { Task, Run, Profile, PoolEntry, DemandRoleOffsets, RoutePolicy, RoutingPolicy, UsageLevel, UsageView, HostEffect, SelectionExplanation } from "../../shared/contracts";
import type { Resolution } from "../resolution";
import { authorModelKey, queueAuthorModelKey, taskAuthorModelKeys } from "../../shared/authors";
import {demandRank,workerThinking} from '../../shared/pool';
export {workerThinking};
import {automaticSelection, requestOnly, describeRoutePolicy, honouredRequest, requestReaches, groupIsUnavailable, withinUsage} from '../../shared/pool';
import {DEMAND_ROLE_OFFSETS, DEMAND_USAGE_OFFSETS, demandTier, effectiveWeight, runDemand, workerDemandStep, workerStepDown, workerStepLabel} from '../../shared/demand';
type Role = "worker"|"reviewer"|"coordinator";
/** The normalized model key Spec 036 compares: the last path segment, lower-cased. */
export function modelKey(model: string): string {
  return model.split("/").at(-1)!.toLowerCase();
}
/**
 * Spec 050: whether the task's recorded reviewer request is an owner `route`
 * for this profile. Only the `route` verb writes the marker — `set_routing`
 * and submissions are stripped at their writers — so a reviewer that shares
 * the current author's model passes the independence gates only for an owner
 * route with a recorded `owner_control` waiver event.
 */
/** The refusal for a worker thinking level given twice with different values, or null. */
export function workerThinkingConflict(top: string | undefined, request: { thinkingOptionId?: string } | null | undefined): string | null {
  return top && request?.thinkingOptionId && request.thinkingOptionId !== top
    ? `Conflicting worker thinking levels: thinkingOptionId ${top} and profileRequests.worker.thinkingOptionId ${request.thinkingOptionId}; give one` : null;
}
export function isOwnerRoutedReviewer(task: Pick<Task, "profileRequests">, profileId: string): boolean {
  const request = task.profileRequests?.reviewer;
  return request?.ownerRoute === true && request.profileId === profileId;
}
/**
 * Spec 050: `set_routing` and submissions store the plain request. Only
 * `route` writes the `ownerRoute` marker, so callers can never smuggle the
 * reviewer independence waiver through another writer.
 */
export function plainProfileRequest(request: { profileId: string; reason: string; required: boolean; thinkingOptionId?: string }) {
  return { profileId: request.profileId, reason: request.reason, required: request.required,
    ...(request.thinkingOptionId !== undefined ? { thinkingOptionId: request.thinkingOptionId } : {}),
  };
}
/**
 * Known concrete routing for the admission-time independence preflight. Runtime
 * selection still re-checks after the actual author or catalog can change.
 */
export type RoutingPreflightInput = {
  scope: Task["scope"];
  /** Spec 052: the usage level in force; absent is `normal`. */
  usage?: UsageLevel;
  preferredProfileId?: string;
  requirePreferred?: boolean;
  profileRequests?: Task["profileRequests"];
  skipPRReview?: boolean;
  declaredAuthorModels?: readonly string[];
};
type RoleRequest = { profileId: string; required: boolean };
type ResolvedModel =
  | { kind: "missing"; profileId: string }
  | { kind: "opaque"; profileId: string; model: string }
  | { kind: "concrete"; profileId: string; model: string; key: string };

/**
 * Preflight proves a pairing impossible; a request awaiting the operator's
 * sign-off (Spec 052) is not, so preflight reads requests as recorded.
 */
function workerRequest(routing: RoutingPreflightInput): RoleRequest | null {
  const request = routing.profileRequests?.worker;
  if (request) return { profileId: request.profileId, required: request.required };
  if (routing.preferredProfileId)
    return { profileId: routing.preferredProfileId, required: Boolean(routing.requirePreferred) };
  return null;
}

function reviewerRequest(routing: RoutingPreflightInput): RoleRequest | null {
  const request = routing.profileRequests?.reviewer;
  return request ? { profileId: request.profileId, required: request.required } : null;
}

function resolveProfile(profileId: string, profiles: readonly Profile[]): ResolvedModel {
  const profile = profiles.find(candidate => candidate.id === profileId);
  if (!profile) return { kind: "missing", profileId };
  const model = profile.model;
  const key = modelKey(model);
  if (!model.trim() || key === "default") return { kind: "opaque", profileId, model };
  return { kind: "concrete", profileId, model, key };
}

function correction(detail: string): string {
  return `${detail}; choose independent worker and reviewer routing`;
}

export { requestOnly };
function identityRoutes(
  role: "worker" | "reviewer",
  routing: RoutingPreflightInput,
  profiles: readonly Profile[],
  pool: readonly PoolEntry[],
): Array<{ id: string; model: string; key: string }> {
  const request = role === "worker" ? workerRequest(routing) : reviewerRequest(routing);
  return pool.flatMap(entry => {
    const profile = profiles.find(candidate => candidate.id === entry.profileId);
    if (!entry.enabled || !profile?.available) return [];
    if (requestOnly(entry, routing.usage) && request?.profileId !== entry.profileId) return [];
    const key = modelKey(profile.model);
    if (!profile.model.trim() || key === "default") return [];
    return [{ id: profile.id, model: profile.model, key }];
  });
}
/**
 * Tom 2026-10-12: a provably impossible required worker/reviewer model pairing
 * fails before promotion and admission, not only when review selection later
 * reports no eligible independent reviewer. Uses the same normalized model key
 * as runtime selection. Subscription exhaustion is not an identity conflict;
 * optional requests still pass when another independent catalog route exists.
 */
export function independentReviewRoutingConflict(
  routing: RoutingPreflightInput,
  profiles: readonly Profile[],
  pool: readonly PoolEntry[],
): string | null {
  if (routing.skipPRReview) return null;
  const worker = workerRequest(routing);
  const reviewer = reviewerRequest(routing);
  const resolvedWorker = worker ? resolveProfile(worker.profileId, profiles) : null;
  const resolvedReviewer = reviewer ? resolveProfile(reviewer.profileId, profiles) : null;
  if (worker?.required && resolvedWorker?.kind === "missing")
    return correction(`Required worker profile ${worker.profileId} is absent from the live catalog`);
  if (worker?.required && resolvedWorker?.kind === "opaque")
    return correction(`Required worker ${worker.profileId} (${resolvedWorker.model || "default"}) uses an opaque provider-default model that cannot prove review independence`);
  if (reviewer?.required && resolvedReviewer?.kind === "missing")
    return correction(`Required reviewer profile ${reviewer.profileId} is absent from the live catalog`);
  if (reviewer?.required && resolvedReviewer?.kind === "opaque")
    return correction(`Required reviewer ${reviewer.profileId} (${resolvedReviewer.model || "default"}) uses an opaque provider-default model that cannot prove review independence`);
  const authorLabels = new Map<string, string>();
  if (worker?.required && resolvedWorker?.kind === "concrete")
    authorLabels.set(resolvedWorker.key, `required worker ${resolvedWorker.profileId} (${resolvedWorker.model})`);
  for (const model of routing.declaredAuthorModels ?? []) {
    const key = modelKey(model);
    if (!model.trim() || key === "default")
      return correction(`Declared author model ${model || "default"} is opaque and cannot prove review independence`);
    if (!authorLabels.has(key)) authorLabels.set(key, `declared author model ${model}`);
  }
  if (reviewer?.required && resolvedReviewer?.kind === "concrete") {
    const author = authorLabels.get(resolvedReviewer.key);
    if (author) {
      if (worker?.required && resolvedWorker?.kind === "concrete" && resolvedWorker.profileId === resolvedReviewer.profileId)
        return correction(`Required worker ${resolvedWorker.profileId} (${resolvedWorker.model}) and required reviewer ${resolvedReviewer.profileId} (${resolvedReviewer.model}) share the same model`);
      return correction(`${author} and required reviewer ${resolvedReviewer.profileId} (${resolvedReviewer.model}) share model ${resolvedReviewer.model}`);
    }
  }
  if (authorLabels.size && !reviewer?.required) {
    const routes = identityRoutes("reviewer", routing, profiles, pool);
    if (!routes.length || routes.some(route => !authorLabels.has(route.key))) return null;
    return correction(`${[...authorLabels.values()].join(" and ")} leaves no independent reviewer route`);
  }
  if (reviewer?.required && resolvedReviewer?.kind === "concrete" && !authorLabels.size) {
    const routes = identityRoutes("worker", routing, profiles, pool);
    if (!routes.length || routes.some(route => route.key !== resolvedReviewer.key)) return null;
    return correction(`Required reviewer ${resolvedReviewer.profileId} (${resolvedReviewer.model}) leaves no independent worker route`);
  }
  return null;
}
export function validateNamedProfile(profileId:string, role:Role, scope:Task["scope"], profiles:Profile[], pool:PoolEntry[], reason="", thinkingOptionId="") {
  const profile=profiles.find(p=>p.id===profileId);
  const entry=pool.find(p=>p.profileId===profileId);
  if(!profile)throw Error(`Profile ${profileId} is absent from the live catalog`);
  if(!profile.available)throw Error(`Profile ${profileId} is unavailable: ${profile.problem}`);
  if(!entry?.enabled)throw Error(`Profile ${profileId} is disabled in the pool`);
  if(role==="worker"&&thinkingOptionId&&!profile.supportedThinking.includes(thinkingOptionId))throw Error(`Profile ${profileId} does not support thinking option ${thinkingOptionId}`);
  return {profile,entry};
}
/**
 * Review independence for worker selection (Spec 036). A retained reviewer
 * filters every worker profile on its model, and a provider-default worker
 * model never proves independence. Worker failover, the first revision worker,
 * the `route` verb's refusal and the `next` route view read this one rule. It
 * has no waiver: the reviewer-side owner-route waiver has no worker counterpart.
 */
export function reviewerFiltersWorker(reviewer: { model: string } | null | undefined, worker: { model: string }): boolean {
  const reviewerModel = reviewer?.model ? modelKey(reviewer.model) : "";
  return Boolean(reviewerModel) && (worker.model === "default" || modelKey(worker.model) === reviewerModel);
}

/** The reason a reviewer-filtered worker profile is named by, in eligibility and route refusals. */
export function reviewerIndependenceFilter(worker: { model: string }): string {
  return worker.model === "default"
    ? "uses a provider-default model; filtered for review independence"
    : `shares the reviewer's model (${worker.model}); filtered for review independence`;
}

/** The route refusal for a worker profile review independence filters, naming the two ways out. */
export function workerReviewerRouteRefusal(worker: Profile, reviewer: { model: string }): string {
  return `Worker profile ${worker.id} ${reviewerIndependenceFilter(worker)}; worker selection drops it with no waiver. Route the retained reviewer to a different model, or route the worker to an eligible profile that does not run on ${reviewer.model}.`;
}

/**
 * Task 515: a profile the live catalog holds but the eligible set filtered
 * out is reported as filtered, never as missing. The catalog holds the
 * truth about absence; a task exclusion and review-independence filtering are
 * the two filters that remove catalogued profiles before eligibility reads
 * them, and the message names them plainly.
 */
function eligibilityAbsence(task:Task,profileId:string,catalog:readonly Profile[]):string{
  if(!catalog.some(profile=>profile.id===profileId))return "absent from catalog";
  if(task.workerExclusions?.some(exclusion=>exclusion.profileId===profileId))return "excluded for this task";
  const candidate=catalog.find(profile=>profile.id===profileId);
  if(candidate&&reviewerFiltersWorker(task.resolution?.reviewerProfile,candidate))return reviewerIndependenceFilter(candidate);
  return "filtered from the eligible set";
}
export function eligibilityReasons(task:Task,profiles:Profile[],pool:PoolEntry[],availability:{group:string;unavailable:boolean;reason:string;retryAt:string|null}[],usage:UsageLevel="normal",catalog:readonly Profile[]=profiles) {
  const raw=task.profileRequests?.worker;
  const request=honouredRequest(raw,pool,usage);
  const preferred=request?.profileId??(raw?"":task.preferredProfileId);
  const required=request?.required??(!raw&&task.requirePreferred);
  const reasons=pool.map(entry=>{
    const p=profiles.find(profile=>profile.id===entry.profileId);
    const causes:string[]=[];
    if(!entry.enabled)causes.push("disabled");
    if(!p)causes.push(eligibilityAbsence(task,entry.profileId,catalog));
    else if(!p.available)causes.push(`unavailable: ${p.problem}`);
    if(!requestReaches(entry,usage,request))causes.push(raw?.profileId===entry.profileId?"awaiting the operator's board sign-off":!withinUsage(usage,entry.cost)?`${entry.cost} cost above the ${usage} usage level without a signed-off request`:`frontier below Maximum without a signed-off request`);
    const thinking=workerThinking(task);
    if(thinking&&p&&!p.supportedThinking.includes(thinking))causes.push(`thinking option ${thinking} unsupported`);
    const group=availability.find(a=>a.group===entry.group&&groupIsUnavailable(a));
    if(group)causes.push(`group ${entry.group} unavailable: ${group.reason}${group.retryAt?` (retry ${group.retryAt})`:""}`);
    return causes.length?`${entry.profileId}: ${causes.join(", ")}`:null;
  }).filter((reason):reason is string=>Boolean(reason));
  if(required&&preferred)reasons.unshift(`preference required but ineligible: ${preferred}`);
  if(!pool.length)reasons.push("pool empty");
  return `No eligible worker profile: ${reasons.slice(0,8).join("; ")}${reasons.length>8?`; and ${reasons.length-8} more`:""}`.slice(0,2000);
}
/** An unrated worker or reviewer cannot demonstrate critical peer capability. */
export function criticalReviewerMeets(task: Task, profile: Profile, pool: readonly PoolEntry[]): boolean {
  const worker = pool.find(entry => entry.profileId === task.profile?.id)?.capability;
  const reviewer = pool.find(entry => entry.profileId === profile.id)?.capability;
  return Boolean(worker && reviewer && task.profile && modelKey(profile.model) !== 'default'
    && modelKey(profile.model) !== modelKey(task.profile.model) && demandRank(reviewer) >= demandRank(worker));
}
export function chooseProfile(task: Task, profiles: Profile[], pool: PoolEntry[], counts: Record<string, number>, unavailable: Set<string>, role: "worker"|"reviewer"|"coordinator" = "worker", recent:Record<string,number>=counts, usage:UsageLevel="normal", offsets:DemandRoleOffsets=DEMAND_ROLE_OFFSETS, initialWorker = false) {
  // Spec 052 (2026-10-21): an unsigned request for a request-only profile is
  // dropped whole: it pins nothing, waits for nothing and sets no thinking, so
  // the role runs on automatic selection until the operator signs it off.
  const raw=task.profileRequests?.[role];
  const request=honouredRequest(raw, pool, usage);
  const unsigned=Boolean(raw&&!request);
  const preferredId=request?.profileId ?? (role === "worker" && !unsigned ? task.preferredProfileId : "");
  const required=request?.required ?? (role === "worker" && !unsigned && task.requirePreferred);
  const thinkingOptionId=role === "worker" ? (unsigned ? task.thinkingOptionId ?? "" : workerThinking(task)) : request?.thinkingOptionId ?? "";
  let eligible = pool.flatMap(entry => {
    const profile = profiles.find(p => p.id === entry.profileId);
    // Spec 053 retires the pool's role and scope switches: every model can work, review and coordinate.
    if (!entry.enabled || !profile?.available || unavailable.has(entry.group)) return [];
    // Above the usage level's cost ceiling, or rated frontier below Maximum
    // (Tom, 2026-11-09), automatic selection never lands on a
    // profile; only an explicit request with a reason that the operator signed
    // off on the board does (Tom, 2026-10-01/15/21; Spec 052).
    if(!requestReaches(entry, usage, request))return [];
    if (thinkingOptionId && !profile.supportedThinking.includes(thinkingOptionId)) return [];
    return [{ entry, profile: { ...profile, thinkingOptionId: thinkingOptionId || profile.thinkingOptionId } }];
  });
  if (preferredId) {
    const preferred = eligible.find(e => e.profile.id === preferredId);
    if (preferred) return preferred;
    if (required) return null;
  }
  if (role === "reviewer" && task.critical) {
    const rigorous = eligible.filter(candidate => criticalReviewerMeets(task, candidate.profile, pool));
    // Availability includes usage/sign-off gates above. A shortfall never parks review.
    if (rigorous.length) eligible = rigorous;
  }
  // Spec 053 (Tom, 2026-10-21; 2026-11-04): the run's demand decides the set.
  // Demand is the task's complexity moved by the role and the usage level; the
  // set is every eligible profile rated at or above it, or on a shortfall the
  // most capable. Cost never removes a profile: the last 50 assignments rotate
  // within the set by per-model share, recent use over the effective weight
  // (configured weight times the cost lean). The subscription group's recent
  // count paces without deciding, and lifetime use breaks ties.
  const fullDemand = runDemand(task.complexity, role, usage, offsets);
  const demand = role === "worker" && initialWorker ? workerDemandStep(fullDemand, workerStepDown(usage, false)) : fullDemand;
  const { tier } = demandTier(demand, eligible.map(candidate => candidate.entry));
  const inTier = new Set(tier.map(entry => entry.profileId));
  const ranked = eligible.filter(candidate => inTier.has(candidate.entry.profileId));
  const share = (candidate: typeof ranked[number]) => effectiveWeight(candidate.entry.weight, candidate.entry.cost);
  ranked.sort((a, b) => (recent[`profile:${a.profile.id}`] ?? 0) / share(a) - (recent[`profile:${b.profile.id}`] ?? 0) / share(b)
    || (recent[a.entry.group] ?? 0) - (recent[b.entry.group] ?? 0)
    || (counts[`profile:${a.profile.id}`] ?? 0) / share(a) - (counts[`profile:${b.profile.id}`] ?? 0) / share(b)
    || (counts[a.entry.group] ?? 0) - (counts[b.entry.group] ?? 0) || a.profile.id.localeCompare(b.profile.id));
  return ranked[0] ?? null;
}
/**
 * Spec 052 diagnostics: the usage policy for the profiles a task's routing
 * names, read from the same `requestOnly` the selector uses. Bounded to the
 * task's own requests, preference and recorded runs, never the whole pool.
 * Read-only: no selection, gate or setting depends on it.
 */
export interface SelectionCounts { counts: Record<string, number>; recent: Record<string, number>; offsets: DemandRoleOffsets }
export function taskRoutingPolicy(task: Task, pool: readonly PoolEntry[], usage: UsageView, availability: readonly { group: string; unavailable: boolean; reason: string; retryAt: string | null }[], at = Date.now(), profiles: readonly Profile[] = [], selectionCounts?: SelectionCounts): RoutingPolicy {
  const named: Array<{ role: Role; profileId: string; source: RoutePolicy["source"] }> = [];
  const add = (role: Role, profileId: string | null | undefined, source: RoutePolicy["source"]) => {
    if (profileId && !named.some(item => item.role === role && item.profileId === profileId)) named.push({ role, profileId, source });
  };
  add("worker", task.profileRequests?.worker?.profileId, "request");
  add("worker", task.preferredProfileId, "preference");
  add("worker", task.profile?.id, "dispatched");
  add("reviewer", task.profileRequests?.reviewer?.profileId, "request");
  add("reviewer", task.resolution.reviewerProfile?.id, "dispatched");
  add("coordinator", task.profileRequests?.coordinator?.profileId, "request");
  return { usage, scope: task.scope, profiles: named.map(({ role, profileId, source }) => {
    const entry = pool.find(item => item.profileId === profileId);
    const group = entry && availability.find(item => item.group === entry.group && groupIsUnavailable(item, at));
    // The task host's own catalog is the availability answer when the caller
    // passes it: a profile that host cannot run — an unreported runtime mode is
    // the T3Code case (nucleus#1143) — is ineligible there with its reason
    // named, so the board shows why instead of the launch refusing it.
    const profile = entry && profiles.length ? profiles.find(candidate => candidate.id === profileId) : undefined;
    const gates = !entry ? ["not in the pool"] : [
      ...(!entry.enabled ? ["disabled in the pool"] : []),
      ...(profile && !profile.available ? [`unavailable on this host: ${profile.problem}`] : []),
      ...(group ? [`group ${entry.group} unavailable${group.retryAt ? ` until ${group.retryAt}` : ""}`] : []),
    ];
    const requested = source === "request" ? task.profileRequests?.[role]?.signoff : undefined;
    const policy = { role, profileId, source, inPool: Boolean(entry), cost: entry?.cost ?? null, capability: entry?.capability ?? null,
      automatic: entry ? automaticSelection(entry, usage.level) : null, gates,
      ...(requested ? { signoff: { status: requested.status, decisionId: requested.decisionId, note: requested.note, ...(requested.grantId ? { grantId: requested.grantId } : {}), ...(requested.endedGrantId ? { endedGrantId: requested.endedGrantId } : {}) } } : {}) };
    return { ...policy, explanation: describeRoutePolicy(policy, usage) };
  }), ...(profiles.length && selectionCounts ? { selection: workerSelectionExplanation(task, pool, profiles, usage.level,
    new Set(availability.filter(item => groupIsUnavailable(item, at)).map(item => item.group)), selectionCounts) } : {}),
  ...(task.hostId && profiles.length ? { host: { hostId: task.hostId, effects: hostEffects(pool, profiles) } } : {}) };
}

/**
 * Why automatic worker selection lands where it does for this task
 * (nucleus#1151, "why did this get Luna?"): the same demand, tier and rotation
 * `chooseProfile` uses at first dispatch, against the task host's snapshot.
 */
export function workerSelectionExplanation(task: Task, pool: readonly PoolEntry[], profiles: readonly Profile[], usage: UsageLevel,
  unavailableGroups: ReadonlySet<string>, { counts, recent, offsets }: SelectionCounts): SelectionExplanation {
  const complexity = task.complexity ?? "medium";
  const fullDemand = runDemand(complexity, "worker", usage, offsets);
  const demand = workerDemandStep(fullDemand, workerStepDown(usage, false));
  const eligible = pool.filter(entry => entry.enabled && !unavailableGroups.has(entry.group) && requestReaches(entry, usage, null)
    && profiles.some(profile => profile.id === entry.profileId && profile.available));
  const { tier, shortfall } = demandTier(demand, eligible);
  const nameOf = (id: string) => profiles.find(profile => profile.id === id)?.name ?? id;
  const met = tier.map(entry => ({ profileId: entry.profileId, name: nameOf(entry.profileId), capability: entry.capability ?? null, cost: entry.cost ?? null,
    weight: entry.weight, effectiveWeight: effectiveWeight(entry.weight, entry.cost), recent: recent[`profile:${entry.profileId}`] ?? 0 }))
    .sort((a, b) => a.recent / a.effectiveWeight - b.recent / b.effectiveWeight || a.profileId.localeCompare(b.profileId));
  const picked = chooseProfile(task, [...profiles], [...pool], counts, new Set(unavailableGroups), "worker", recent, usage, offsets, true);
  const named = task.profileRequests?.worker?.profileId ?? task.preferredProfileId;
  const row = picked && met.find(item => item.profileId === picked.profile.id);
  const reason = !picked ? "no eligible profile on this host"
    : picked.profile.id === named ? "named by the task's request or preference"
    : row ? `fewest recent assignments per effective weight in the set: ${row.recent} of the last 50 over weight ${row.weight} × cost lean ${row.effectiveWeight / row.weight} (cost ${row.cost ?? "unset"})${met.length > 1 ? `; next ${met.filter(item => item.profileId !== row.profileId).slice(0, 2).map(item => `${item.name} ${item.recent} over ${item.effectiveWeight}`).join(", ")}` : ""}`
    : "outside the demand set";
  return { role: "worker", complexity, roleOffset: offsets.worker, usageOffset: DEMAND_USAGE_OFFSETS[usage], step: workerStepLabel(usage, false),
    fullDemand, demand, shortfall, met, choice: picked ? { profileId: picked.profile.id, name: picked.profile.name, reason } : null };
}

/**
 * Every enabled pool profile the host snapshot rules out or launches with
 * mapped values (nucleus#1151). Disabled entries are left out: they never
 * dispatch anywhere, so the host is not why they were passed over.
 */
export function hostEffects(pool: readonly PoolEntry[], profiles: readonly Profile[]): HostEffect[] {
  const effects: HostEffect[] = [];
  for (const entry of pool) {
    if (!entry.enabled) continue;
    const profile = profiles.find(candidate => candidate.id === entry.profileId);
    if (!profile) continue;
    if (profile.excluded) effects.push({ profileId: profile.id, name: profile.name, effect: "excluded", reason: profile.problem });
    else if (!profile.available) effects.push({ profileId: profile.id, name: profile.name, effect: "unavailable", reason: profile.problem });
    else if (profile.mapped?.length) effects.push({ profileId: profile.id, name: profile.name, effect: "mapped",
      reason: `launches as ${profile.provider}/${profile.model}${profile.modeId ? `, mode ${profile.modeId}` : ""}${profile.thinkingOptionId ? `, thinking ${profile.thinkingOptionId}` : ""} (mapped: ${profile.mapped.join(", ")})` });
  }
  return effects;
}

export const proofExecutorAgents = (task: Pick<Task, 'proofExecutions'>): string[] =>
  (task.proofExecutions ?? []).flatMap(record => record.agentId ? [record.agentId] : []);

/**
 * Spec 036/050: whether a reviewer is independent of the task's authors.
 * Four copies (selection, a candidate profile, retained continuation / verdict
 * verification, and consult-bound restart) read this one rule; each site pins
 * today's own unknown and waiver shape, including consult-bound restart which
 * does not apply the owner-route waiver and does not treat a default reviewer
 * model as unknown on its own.
 */
export type ReviewerIndependence = 'independent' | 'unknown' | 'collision' | 'waived';
export type ReviewerIndependenceFacts =
  | { site: 'select'; entrypoint: string | undefined; authors: ReadonlySet<string>; currentAuthorModels: ReadonlySet<string> }
  | { site: 'profile' | 'assert' | 'verify'; authors: ReadonlySet<string>; currentAuthorModels: ReadonlySet<string>; reviewerModel: string; namedRequired: boolean; ownerRouted: boolean }
  | { site: 'consult'; authors: ReadonlySet<string>; reviewerModel: string };
export function reviewerIndependence(facts: ReviewerIndependenceFacts): ReviewerIndependence {
  if (facts.site === 'select') {
    if (facts.entrypoint === 'proof' && facts.authors.size === 0) return 'independent';
    const currentKnown = facts.currentAuthorModels.size > 0 && !facts.currentAuthorModels.has('default');
    return currentKnown && facts.authors.size > 0 && !facts.authors.has('default') ? 'independent' : 'unknown';
  }
  if (facts.site === 'consult') {
    if (!facts.authors.size || facts.authors.has('default')) return 'unknown';
    return facts.authors.has(facts.reviewerModel) ? 'collision' : 'independent';
  }
  if (facts.site === 'profile') {
    if (!facts.reviewerModel || facts.reviewerModel === 'default') return 'unknown';
    if (!facts.authors.has(facts.reviewerModel)) return 'independent';
    const currentKnown = facts.currentAuthorModels.size > 0 && !facts.currentAuthorModels.has('default');
    if (facts.namedRequired && currentKnown && (!facts.currentAuthorModels.has(facts.reviewerModel) || facts.ownerRouted)) return 'waived';
    return 'collision';
  }
  if (!facts.authors.size || facts.authors.has('default') || !facts.reviewerModel || facts.reviewerModel === 'default' || facts.currentAuthorModels.has('default'))
    return 'unknown';
  if (!facts.authors.has(facts.reviewerModel)) return 'independent';
  if (facts.namedRequired && (!facts.currentAuthorModels.has(facts.reviewerModel) || facts.ownerRouted)) return 'waived';
  return 'collision';
}

/** Who may take a role: reviewer, coordinator or proof executor selection and its independence gates. */
export class RoleSelection {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  /**
   * Spec 036: agents that authored task work. A reviewer must never be an
   * agent that ran the worker, a revision or an author checkpoint turn on the
   * task. Independent review-only agents may retain their own reading context. Worker runs are
   * bound to the task itself (no run record), so the task and retired-worker
   * agent identities join the revision-run agents here.
   */
  authorAgentIds(t: Task): Set<string> {
    return new Set([...(t.entrypoint === 'proof' ? [] : [t.agentId]), ...(t.retiredWorkers ?? []).map(w => w.agentId),
      ...this.store.runs(t.id).filter(r => r.role === 'revision' && r.agentId).map(r => r.agentId!)].filter((id): id is string => Boolean(id)));
  }
  select(t: Task, role: 'reviewer' | 'coordinator' | 'executor', extraUnavailable: Iterable<string> = [], excludedProfiles: ReadonlySet<string> = new Set(), usage: UsageLevel = this.store.usageLevel()) {
    const unavailable = new Set([...this.store.db.prepare('SELECT data FROM availability').all().flatMap(r => { const a = JSON.parse(String(r.data)); return groupIsUnavailable(a) ? [a.group as string] : []; }), ...extraUnavailable]);
    const pool = this.store.pool();
    // Opaque provider routes cannot prove review independence. Every boundary
    // (selection, retained restart, verdict verification) reads the one author
    // evidence derivation in shared/authors.ts.
    const model = authorModelKey;
    const authors = taskAuthorModelKeys(t, this.store.runs(t.id).filter(run => run.role === 'revision'));
    // Spec 036: an earlier author's model is allowed only when the operator
    // names that profile explicitly through route (preflight already
    // proved it independent of the head under review). Automatic selection
    // keeps excluding every author model, and this is never a fallback: an
    // explicit request is honored only when it names the profile directly.
    // The carve-out never reaches the current author's model: a request that
    // shares the model of the worker whose head is under review stays
    // excluded here exactly as without a request, so selection alone can
    // never certify a head through its own author's model.
    const reviewerRequest = role === 'reviewer' ? t.profileRequests?.reviewer : undefined;
    const explicitReviewer = reviewerRequest?.required === true ? reviewerRequest.profileId : undefined;
    // The current author is the Queue worker whose head is under review. A
    // workerless external-PR review entry has no such worker, so every recorded
    // external author is current: absence never manufactures an unknown author.
    const currentQueueModel = queueAuthorModelKey(t);
    const currentAuthorModels = currentQueueModel === null ? authors : new Set([currentQueueModel]);
    // A reviewer may never be selected while any author evidence is unknown: the
    // current Queue author's own model when a worker exists, or any declared,
    // observed or later-contributor model. Selection, the retained continuation
    // and verdict verification all read this same gate.
    const reviewerIndependent = reviewerIndependence({ site: 'select', entrypoint: t.entrypoint, authors, currentAuthorModels }) === 'independent';
    // Spec 050: an owner-routed reviewer (`route`, which writes the
    // `ownerRoute` marker) is used even when it shares the current author's
    // model; the audit records the waiver. A required request from any other
    // writer still waives earlier author models, as before; the current
    // author's model needs the marker, so `set_routing` and submission-time
    // requests can never certify a head through its own author's model.
    // Optional requests and automatic selection keep preferring independence.
    const ownerRouted = Boolean(explicitReviewer && isOwnerRoutedReviewer(t, explicitReviewer));
    const profiles = this.resolution.profiles().filter(p => role !== 'reviewer' || reviewerIndependent && model(p.model) !== 'default' && !excludedProfiles.has(p.id) && reviewerIndependence({
      site: 'profile', authors, currentAuthorModels, reviewerModel: model(p.model),
      namedRequired: p.id === explicitReviewer, ownerRouted,
    }) !== 'collision')
      .filter(p => role !== 'executor' || (p.model !== 'default' && !excludedProfiles.has(p.id)
        && !(t.entrypoint === 'proof' && t.resolution.reviewerProfile && model(p.model) === model(t.resolution.reviewerProfile.model))));
    return chooseProfile({ ...t, preferredProfileId: '', requirePreferred: false, thinkingOptionId: '', scope: role === 'coordinator' && !honouredRequest(t.profileRequests?.coordinator, pool, usage) ? 'general' as const : t.scope }, profiles, pool, this.store.counts(), unavailable, role === 'executor' ? 'worker' : role,this.store.recentCounts(),usage,this.store.demandRoleOffsets());
  }
  /**
   * When a required profile request is what leaves a role without a profile,
   * name it and why, so the owner can `route` the role elsewhere. Empty otherwise.
   */
  requiredRouteNote(t: Task, role: 'reviewer' | 'coordinator'): string {
    const request = t.profileRequests?.[role];
    if (!request?.required) return '';
    const entry = this.store.pool().find(item => item.profileId === request.profileId);
    const profile = this.resolution.profiles().find(item => item.id === request.profileId);
    const availability = entry ? this.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get(entry.group) as { data: string } | undefined : undefined;
    const why = !entry ? 'it is not in the profile pool' : !entry.enabled ? 'it is disabled'
      : !profile?.available ? `the profile is unavailable${profile?.problem ? `: ${profile.problem}` : ''}`
      : availability && groupIsUnavailable(JSON.parse(availability.data)) ? `subscription group ${entry.group} is unavailable` : '';
    return why ? `; the required ${role} request names ${request.profileId}, but ${why}: route role=${role} to another profile` : '';
  }
  /**
   * Spec 052: when the usage level's cost ceiling, not the pool, leaves a role
   * with no profile, say so and name the way out. Empty when the pool itself is
   * the cause.
   */
  usageCeilingNote(t: Task, role: 'reviewer' | 'coordinator' | 'worker', extraUnavailable: Iterable<string> = [], excludedProfiles: ReadonlySet<string> = new Set(), widened?: () => { profile: Profile; entry: { cost?: string | null } } | null): string {
    const usage = this.store.usageLevel();
    if (usage === 'high' || usage === 'maximum') return '';
    if (role !== 'worker' && !widened && this.resolution.select(t, role, extraUnavailable, excludedProfiles)) return '';
    const above = widened ? widened() : role === 'worker' ? null : this.resolution.select(t, role, extraUnavailable, excludedProfiles, 'maximum');
    return above ? `; the ${usage} usage level holds automatic selection below ${above.profile.id} (${above.entry.cost ?? 'unset'} cost): raise the usage level or route the ${role} to a profile` : '';
  }
  retainedProfileIssue(assigned:Profile|null){
    if(!assigned)return 'assigned profile is missing';
    // An unloaded catalog proves nothing about the profile: report no issue, so no
    // caller supersedes, remaps or parks on it. Every action that would use the
    // profile (a launch) waits for the catalog on its own (consumer #660, review #565).
    if(!this.resolution.catalogKnown())return null;
    const catalog=this.resolution.profiles().find(p=>p.id===assigned.id);
    if(!catalog?.available)return `profile ${assigned.name||assigned.id} is unavailable`;
    const entry=this.store.pool().find(p=>p.profileId===assigned.id);
    if(!entry?.enabled)return `pool profile ${assigned.name||assigned.id} is disabled`;
    const availability=this.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get(entry.group);
    if(availability){
      const state=JSON.parse(String(availability.data));
      if(groupIsUnavailable(state))return `subscription group ${entry.group} is unavailable`;
    }
    return null;
  }
  retainedWorkerProfileIssue(t:Task){return this.resolution.retainedProfileIssue(t.profile)}
  /**
   * Spec 052 sign-off for a new run on a retained profile: a reviewer launched
   * fresh on the recorded reviewer profile, or a new run on the bound coordinator.
   * A live run, a review continuation and a worker continuing its own thread are
   * not new selections and are never stopped by it (Tom, 2026-10-21: keep the
   * worker's thread).
   */
  signoffIssue(t:Task,assigned:Profile|null,role:'reviewer'|'coordinator'):string|null{
    if(!assigned)return null;
    const entry=this.store.pool().find(item=>item.profileId===assigned.id);
    const usage=this.store.usageLevel();
    const request=t.profileRequests?.[role];
    // A request the operator has since signed off for another profile takes over
    // from the retained one, as an owner route does.
    if(request?.signoff?.status==='approved'&&request.profileId!==assigned.id)return `the operator signed off ${request.profileId} for the ${role}`;
    if(!entry||requestReaches(entry,usage,request))return null;
    return `profile ${assigned.name||assigned.id} needs the operator's board sign-off at the ${usage} usage level`;
  }
  assertReviewProfileIndependent(task: Task, run: Run) {
    if (!task.hostId || run.hostId !== task.hostId) throw new Error('Waiting for a proven reviewer host');
    const profile = run.profile, assigned = task.resolution.reviewerProfile;
    if (!profile || !assigned || task.resolution.reviewerAgentId !== run.agentId) throw new Error('Original reviewer profile/agent assignment is missing');
    const runtimeIdentity = (p: Profile) => JSON.stringify([p.provider, p.model, p.modeId, p.featureValues]);
    const configured = this.resolution.profiles().find(candidate => candidate.id === profile.id);
    if (!this.resolution.catalogKnown()) throw new Error('The daemon profile catalog is still loading after service start; retry shortly');
    if (!configured || runtimeIdentity(configured) !== runtimeIdentity(profile) || runtimeIdentity(assigned) !== runtimeIdentity(profile) ||
        assigned.thinkingOptionId !== profile.thinkingOptionId) throw new Error('Original reviewer profile runtime identity changed');
    if (profile.thinkingOptionId !== undefined && !configured.supportedThinking.includes(profile.thinkingOptionId))
      throw new Error(`Original reviewer profile no longer supports pinned thinking option ${profile.thinkingOptionId}`);
    const profileIssue = this.resolution.retainedProfileIssue(profile);
    if (profileIssue) throw new Error(`Original reviewer profile is unavailable: ${profileIssue}`);
    // The reviewer agent may not be an agent that authored any part of the task,
    // including the author-side proof execution (Spec 055).
    if (this.resolution.authorAgentIds(task).has(run.agentId!) || proofExecutorAgents(task).includes(run.agentId!))
      throw new Error('Original reviewer authored this task; independent continuation refused');
    const model = authorModelKey;
    const authors = taskAuthorModelKeys(task, this.store.runs(task.id).filter(item => item.role === 'revision'));
    // The current author is the Queue worker whose head is under review. A
    // workerless external-PR review entry has no such worker, so its recorded
    // declared and observed external authors are the current author: absence is
    // not an unknown model. An actual worker with no recorded model still is.
    const queueAuthorModel = queueAuthorModelKey(task);
    const currentAuthorModels = queueAuthorModel === null ? authors : new Set([queueAuthorModel]);
    const reviewerModel = model(profile.model);
    // Spec 050: an owner `route` (which writes the `ownerRoute` marker)
    // may name a reviewer on any author's model, including the current
    // one. Any other same-model request — `set_routing`, submission-time
    // or optional — never waives the current author's model; continuation
    // and closure recheck that same marked request.
    const reviewerRequest = task.profileRequests?.reviewer;
    const named = reviewerRequest?.required === true && reviewerRequest.profileId === profile.id;
    const independence = reviewerIndependence({
      site: 'assert', authors, currentAuthorModels, reviewerModel,
      namedRequired: Boolean(named), ownerRouted: isOwnerRoutedReviewer(task, profile.id),
    });
    if (independence === 'unknown') throw new Error('Reviewer/model independence is unknown');
    if (independence === 'collision') throw new Error('Original reviewer model is not independent of actual task authors');
  }
}
