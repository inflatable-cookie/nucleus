import type {CapabilityLevel,DemandLevel,PoolEntry,ProfileCapability,RoutePolicy,UsageLevel,UsageView} from './contracts';
import {profileCapabilityLevels} from './contracts';
export type ProfileSettings=PoolEntry;
/** Ordinal rank of the five cost and task-complexity levels, lowest first. */
export const CAPABILITY_LEVELS: readonly CapabilityLevel[] = ["very_low", "low", "medium", "high", "very_high"];
export function capabilityRank(value:CapabilityLevel):number{return CAPABILITY_LEVELS.indexOf(value);}
/** A profile's five capability stops, lowest first (Tom, 2026-11-09: `very_low` gave way to `frontier`). */
export const PROFILE_CAPABILITY_LEVELS: readonly ProfileCapability[] = profileCapabilityLevels;
/**
 * The demand scale both a run's demand and a profile's capability rank on:
 * task complexity's five levels plus `frontier`, which only Maximum reaches.
 */
export const DEMAND_LEVELS: readonly DemandLevel[] = ["very_low", "low", "medium", "high", "very_high", "frontier"];
export function demandRank(value:DemandLevel):number{return DEMAND_LEVELS.indexOf(value);}
/**
 * Spec 052 (Tom, 2026-10-18): the highest cost automatic selection may land on
 * at each usage level. Above it a profile needs an explicit request with a
 * reason. Cost is a ceiling only; frontier is a capability tier (Tom, 2026-11-09).
 */
export const USAGE_COST_CEILING: Record<UsageLevel, CapabilityLevel> = { minimal: "low", low: "medium", normal: "high", high: "very_high", maximum: "very_high" };
export const USAGE_LABELS: Record<UsageLevel, { label: string; detail: string }> = {
  minimal: { label: "Minimal", detail: "Every run needs two steps less; nothing above low cost without a request" },
  low: { label: "Low", detail: "Every run needs a step less; nothing above medium cost without a request" },
  normal: { label: "Normal", detail: "Runs need what the task needs; nothing above high cost without a request; frontier profiles only on request" },
  high: { label: "High", detail: "Every run needs a step more; every cost is automatic; frontier profiles only on request" },
  maximum: { label: "Maximum", detail: "Every run needs two steps more; frontier profiles join automatic selection" },
};
/** Whether automatic selection at this level may use a profile of this cost; unset cost is never cost-gated. */
export function withinUsage(level: UsageLevel, cost: CapabilityLevel | null | undefined): boolean {
  return !cost || capabilityRank(cost) <= capabilityRank(USAGE_COST_CEILING[level]);
}
/** Spec 052 (Tom, 2026-11-09: "Yes, at Maximum only"): a frontier profile is automatic only at Maximum. */
export function frontierAllowed(level: UsageLevel, capability: ProfileCapability | null | undefined): boolean {
  return capability !== "frontier" || level === "maximum";
}
/**
 * Whether a pool entry needs an explicit request at this usage level: a cost
 * above the level's ceiling, or a frontier capability below Maximum. Automatic
 * eligibility is capability tier × level, cost × level and On/Off, nothing
 * else (Tom, 2026-11-09, retiring By request). One predicate for preflight,
 * eligibility, selection and the read-only explanation below.
 */
export const requestOnly = (entry: Pick<PoolEntry, "cost" | "capability">, usage: UsageLevel = "normal") =>
  !withinUsage(usage, entry.cost) || !frontierAllowed(usage, entry.capability);
/** Spec 052: the operator signed this request off on the board. */
export const requestSignedOff = (request: { signoff?: { status: string } | null } | null | undefined) => request?.signoff?.status === "approved";
/**
 * Whether an explicit request reaches this pool entry. A profile within the
 * usage level needs none; one above its cost ceiling, or rated frontier below
 * Maximum, needs the request with a reason and the operator's board sign-off
 * (Tom, 2026-10-21).
 */
export const requestReaches = (entry: Pick<PoolEntry, "cost" | "capability" | "profileId">, usage: UsageLevel,
  request: { profileId: string; reason: string; signoff?: { status: string } | null } | null | undefined) =>
  !requestOnly(entry, usage) || (request?.profileId === entry.profileId && Boolean(request.reason.trim()) && requestSignedOff(request));
/**
 * The request a selection honours: unchanged when its profile is within the
 * level, or signed off; otherwise none, so an unsigned request never pins a
 * profile, waits for one, or sets its thinking (automatic selection applies).
 */
export function honouredRequest<T extends { profileId: string; reason: string; signoff?: { status: string } | null }>(
  request: T | null | undefined, pool: readonly Pick<PoolEntry, "cost" | "capability" | "profileId">[], usage: UsageLevel): T | null {
  if (!request) return null;
  const entry = pool.find(item => item.profileId === request.profileId);
  return !entry || requestReaches(entry, usage, request) ? request : null;
}
/**
 * Spec 052 diagnostics: what the usage level in force means for automatic
 * selection of one pool entry. A read of `requestOnly`, never a gate; other
 * gates (enabled, group, catalog) are reported beside it, not folded in. A
 * cost above the ceiling is named first, then a frontier tier below Maximum.
 */
export function automaticSelection(entry: Pick<PoolEntry, "cost" | "capability">, level: UsageLevel): NonNullable<RoutePolicy["automatic"]> {
  if (!withinUsage(level, entry.cost)) return "request_ceiling";
  return frontierAllowed(level, entry.capability) ? "allowed" : "request_frontier";
}
/** One plain sentence for `automaticSelection`; `time` formats the optional end time (the client passes local time). */
export function describeAutomaticSelection(entry: Pick<PoolEntry, "cost" | "capability">, usage: UsageView, time: (iso: string) => string = iso => iso): string {
  const label = USAGE_LABELS[usage.level].label;
  const ends = !usage.expired && usage.until && usage.level !== "normal" ? ` until ${time(usage.until)}` : "";
  const ended = usage.expired && usage.until ? ` (${USAGE_LABELS[usage.setLevel].label} ended ${time(usage.until)})` : "";
  switch (automaticSelection(entry, usage.level)) {
    case "allowed": return `${entry.capability === "frontier" ? "Frontier · " : ""}Automatic at ${label}${ends}${ended}`;
    case "request_frontier": return `Frontier: request-only below Maximum${ended}`;
    case "request_ceiling": return `Explicit request required at ${label}: ${entry.cost!.replaceAll("_", " ")} cost is above its ceiling${ended}`;
  }
}
/**
 * A short suffix for a profile button: the effective policy. Buttons do not
 * wrap, so the tag stays a few words (compact routing dialogs at 360 pt); the
 * chosen profile's wrapping sentence carries the level and end time.
 */
export function automaticSelectionTag(entry: Pick<PoolEntry, "cost" | "capability">, level: UsageLevel): string {
  const automatic = automaticSelection(entry, level);
  return automatic === "request_frontier" ? " · frontier" : automatic === "request_ceiling" ? " · request only" : "";
}
/** The full sentence for one routing policy row; the server passes ISO time, the client local time. */
export function describeRoutePolicy(policy: Omit<RoutePolicy, "explanation">, usage: UsageView, time: (iso: string) => string = iso => iso): string {
  const asked = policy.source === "request" && policy.automatic?.startsWith("request");
  const signoff = policy.signoff;
  if (signoff?.endedGrantId) return `Explicit ${policy.role} request was covered by grant ${signoff.endedGrantId.slice(0, 8)}, which has ended; automatic selection applies`;
  const source = policy.source === "request" ? (!asked ? `Explicit ${policy.role} request`
      : signoff?.status === "approved" && signoff.grantId ? `Explicit ${policy.role} request, covered by grant ${signoff.grantId.slice(0, 8)}`
      : signoff?.status === "approved" ? `Explicit ${policy.role} request, signed off on the board`
      : signoff?.status === "declined" ? `Explicit ${policy.role} request, declined${signoff.note ? ` (${signoff.note})` : ""}: automatic selection applies`
      : `Explicit ${policy.role} request awaiting the operator's board sign-off${signoff?.decisionId ? ` (decision ${signoff.decisionId.slice(0, 8)})` : ""}: automatic selection runs meanwhile`)
    : policy.source === "preference" ? "Worker preference"
    : `Recorded ${policy.role} run used it (history, not today's policy)`;
  if (!policy.automatic) return `${source}; not in the pool, so automatic selection never uses it`;
  const preferenceOnly = policy.source === "preference" && policy.automatic.startsWith("request");
  return `${source}; automatic selection: ${describeAutomaticSelection(policy, usage, time)}${preferenceOnly ? "; a preference alone does not select it" : ""}${policy.gates.length ? `; also ${policy.gates.join(", ")}` : ""}`;
}
export function saveProfileSettings(pool:PoolEntry[],settings:ProfileSettings):PoolEntry[]{
 const group=settings.group.trim();
 if(!group)throw Error('Subscription group is required');
 return [...pool.filter(p=>p.profileId!==settings.profileId),{...settings,group}];
}

/**
 * Pool entries a save may store. A new or changed entry must name a profile in
 * Paseo's current catalog. An entry left unchanged is kept even if its profile
 * has since gone from Paseo: one stale entry must not block every other save
 * (live 2026-09-27: a disabled entry for a deleted profile failed every Profile
 * Pool change). Dispatch only draws from the catalog, so a kept stale entry is inert.
 */
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`
 :JSON.stringify(value)??'null';
export function checkPoolEntries(entries:PoolEntry[],knownProfileIds:ReadonlySet<string>,stored:PoolEntry[]){
 if(new Set(entries.map(e=>e.profileId)).size!==entries.length)throw Error('Duplicate pool profile');
 const unchanged=new Set(stored.map(canonical));
 for(const entry of entries){
  if(!knownProfileIds.has(entry.profileId)&&!unchanged.has(canonical(entry)))throw Error('Unknown profile; refresh the catalog');
  if(entry.group.startsWith('profile:'))throw Error('Subscription group prefix is reserved');
 }
}

/**
 * Entries whose profile is gone from Paseo's catalog. An empty catalog (none
 * named, or the daemon disconnected so none are loaded) marks nothing stale:
 * a daemon outage must never offer to drop the whole pool.
 */
export function stalePoolEntries(pool:readonly PoolEntry[],profiles:readonly {id:string}[]):PoolEntry[]{
 if(!profiles.length)return [];
 const known=new Set(profiles.map(p=>p.id));
 return pool.filter(entry=>!known.has(entry.profileId));
}

/** Drop one entry. Every other entry is the same object, so a save stays byte-identical for them. */
export function removePoolEntry(pool:readonly PoolEntry[],profileId:string):PoolEntry[]{
 return pool.filter(entry=>entry.profileId!==profileId);
}

export function groupIsUnavailable(state:{unavailable:boolean;retryAt:string|null},at=Date.now()){
 return state.unavailable&&(!state.retryAt||Date.parse(state.retryAt)>at);
}
/** The groups unavailable at this instant. Every dispatch path reads availability through this, so no caller parses its own rows. */
export function unavailableGroups(availability:readonly {group:string;unavailable:boolean;retryAt:string|null}[],at=Date.now()){
 return new Set(availability.filter(state=>groupIsUnavailable(state,at)).map(state=>state.group));
}
export function normalizeRetryAt(value:string|null){
 const retryAt=value?.trim()||null;
 if(retryAt&&!Number.isFinite(Date.parse(retryAt)))throw Error('Retry time must be a valid date');
 return retryAt;
}
export function activeGroupLimit(availability:readonly {group:string;unavailable:boolean;reason:string;retryAt:string|null}[],group:string,at=Date.now()) {
 return availability.find(a=>a.group===group&&groupIsUnavailable(a,at));
}

/**
 * The worker's effective thinking level: the worker request's own level when
 * it names one, else the task's. A brief or route may put it in either place,
 * and selection, validation and display all read it here (papercut 4befc74b:
 * a worker request's level was stored but never applied).
 */
export function workerThinking(task: { thinkingOptionId?: string; profileRequests?: { worker?: { thinkingOptionId?: string } | null } | null }): string {
  return task.profileRequests?.worker?.thinkingOptionId || task.thinkingOptionId || "";
}
/**
 * The worker thinking level selection may carry: the worker request's level only
 * while that request is honoured (Spec 052), otherwise the task's own level, so
 * an unsigned request's level never narrows automatic or replacement selection.
 */
export function honouredWorkerThinking(task: { thinkingOptionId?: string; profileRequests?: { worker?: ({ profileId: string; reason: string; thinkingOptionId?: string; signoff?: { status: string } | null }) | null } | null },
  pool: readonly Pick<PoolEntry, "cost" | "capability" | "profileId">[], usage: UsageLevel): string {
  return honouredRequest(task.profileRequests?.worker ?? null, pool, usage) ? workerThinking(task) : task.thinkingOptionId || "";
}

/**
 * The worker profile the next worker run takes. A required request (an owner
 * route or a required submission) wins over the profile
 * that last ran; a soft request does not (consumer-b #658: a fresh restart pinned
 * the last profile over the owner's required route). An owner route is intent,
 * not a boundary: a required owner route remains effective until the owner
 * routes again.
 */
/**
 * Task 515: one general rule for every role's dispatch and replacement
 * selection. A recorded selection (the dispatched profile, the retained
 * reviewer, the bound coordinator) that predates a required route the
 * selection honours yields to it: an approval the operator already gave for
 * the same task and profile is never asked again, and an approved route never
 * leaves an older selection in force. Returns the winning profile, or null
 * when nothing supersedes the recorded selection. A soft request never
 * displaces: like a fresh dispatch, it only decides when it is eligible.
 */
export function supersedingRouteProfile(
  request: { profileId: string; reason: string; required?: boolean; signoff?: { status: string } | null } | null | undefined,
  recordedProfileId: string | null | undefined,
  pool: readonly Pick<PoolEntry, "cost" | "capability" | "profileId">[],
  usage: UsageLevel,
): string | null {
  const honoured = honouredRequest(request ?? null, pool, usage);
  return honoured?.required && honoured.profileId !== recordedProfileId ? honoured.profileId : null;
}

export function workerRouteProfile(task: {
  profile?: { id: string } | null; preferredProfileId?: string;
  profileRequests?: { worker?: { profileId: string; required?: boolean; ownerRoute?: boolean; routedAt?: string } | null } | null;
}): string | null {
  const request = task.profileRequests?.worker;
  return (request?.required ? request.profileId : null) ?? task.profile?.id ?? request?.profileId ?? task.preferredProfileId ?? null;
}
