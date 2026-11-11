import type { Task, Run, Notice } from "../../shared/contracts";
import type { HookRecord } from "../../shared/hooks";
import {
  STAGE_META, headlineFacts, isSemanticIncidentCause, telemetryFilterSchema, telemetrySnapshotSchema, telemetryStageForTask,
  taskTelemetrySchema, type QaValidationAdmission, type ReviewerCalibration, type ReviewerCalibrationRow, type TaskTelemetry,
  type TelemetryHeadline, type TelemetryHeadlineKey, type TelemetrySnapshot, type TelemetryStageKey,
  disabledShadowReviewPlan, taskControlTelemetrySchema, type TaskControlTelemetry, type TaskUsage, type UsageComplexity,
} from "../../shared/telemetry";
import { VERB_OUTCOME_RETENTION_MS, type Store, type TelemetryFactChunk, type VerbOutcome } from "../store/store";
import { taskUsage } from "./run-usage";
import { nonDeliveryEvents } from '../recovery/non-delivery';
import { plannerEscalations, reviewerConsults } from '../questions/blocker-ladder';

export interface QueueEvent { id: number; taskId: string; at: string; kind: string; detail: string }
interface Boundary { at: number; stage: TelemetryStageKey; partial: boolean }

const terminalHookStates = new Set(["result", "published", "blocked", "failed", "uncertain"]);

const ms = (value: string | null | undefined, fallback: number) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

function heuristicStage(event: QueueEvent): TelemetryStageKey | null {
  const detail = event.detail.toLowerCase();
  if (event.kind === "submitted") return "capacity_wait";
  if (event.kind === "hold") return "held_wait";
  if (event.kind === "release") return "capacity_wait";
  if (detail.includes("waiting for prerequisites")) return "prerequisite_wait";
  if (["dispatch_intent", "workspace_created", "agent_intent"].includes(event.kind)) return "creation";
  if (event.kind === "agent_created" || event.kind === "adopted") return "worker_active";
  if (event.kind === "completion_received") return "worker_release_wait";
  if (event.kind === "workspace_released") return detail.includes("ready_for_review") ? "review" : "attention";
  if (event.kind === "run_intent") {
    if (detail.includes("reviewer")) return "review";
    if (detail.includes("revision")) return "worker_active";
    if (detail.includes("verification")) return "verification";
    if (detail.includes("closeout")) return "closeout";
    if (detail.includes("recovery")) return "attention";
  }
  if (event.kind === "revision_requested" || event.kind === "worker_resume_requested") return "worker_active";
  if (event.kind === "merge_intent") return "merge";
  if (event.kind === "merge_verified" || event.kind === "external_merge_observed") return "synchronization";
  if (event.kind === "main_synchronized") return "closeout";
  if (event.kind === "needs_attention" || event.kind === "recovery_pending" || event.kind === "recovery_escalated" || event.kind === "incident") return "attention";
  if (event.kind === "closed_out") return "complete";
  if (event.kind === "disposition_complete" || event.kind === "cancel") return "cancelled";
  return null;
}

function timeline(task: Task, events: QueueEvent[], at: number): { boundaries: Boundary[]; evidence: TaskTelemetry["evidence"] } {
  const created = ms(task.createdAt, at);
  const exact = events.filter(event => event.kind === "telemetry_stage")
    .map(event => ({ event, stage: event.detail as TelemetryStageKey }))
    .filter(item => item.stage in STAGE_META).sort((a, b) => ms(a.event.at, at) - ms(b.event.at, at));
  const firstExact = exact[0] ? ms(exact[0].event.at, at) : Infinity;
  const boundaries: Boundary[] = [];
  if (firstExact - created <= 1_000) boundaries.push({ at: created, stage: exact[0].stage, partial: false });
  else {
    boundaries.push({ at: created, stage: "capacity_wait", partial: true });
    for (const event of events.slice().sort((a, b) => ms(a.at, at) - ms(b.at, at))) {
      const time = ms(event.at, at);
      if (time >= firstExact) break;
      const stage = heuristicStage(event);
      if (stage) boundaries.push({ at: time, stage, partial: true });
    }
  }
  for (const item of exact) boundaries.push({ at: ms(item.event.at, at), stage: item.stage, partial: false });
  const normalized = boundaries.sort((a, b) => a.at - b.at).filter((item, index, all) => index === 0 || item.stage !== all[index - 1].stage);
  const partial = normalized.some(item => item.partial), precise = normalized.some(item => !item.partial);
  return { boundaries: normalized, evidence: partial ? precise ? "mixed" : "partial" : "exact" };
}

function hookDuration(records: HookRecord[], events: QueueEvent[], at: number) {
  if (!records.length) return null;
  let total = 0, partial = false;
  for (const record of records) {
    const related = events.filter(event => event.detail.includes(record.eventId)).sort((a, b) => ms(a.at, at) - ms(b.at, at));
    const exactStarts = related.some(event => event.kind === "hook_execution_started");
    if (!exactStarts) partial = true;
    let start: number | null = null;
    for (const event of related) {
      const time = ms(event.at, at);
      if (event.kind === "hook_execution_started" || !exactStarts && ["hook_intent", "hook_workspace_created"].includes(event.kind)) start = time;
      if (start !== null && ["hook_result", "hook_published", "hook_blocked", "hook_failed", "hook_uncertain"].includes(event.kind)) {
        total += Math.max(0, time - start); start = null;
      }
    }
    if (start !== null) total += Math.max(0, at - start);
    if (!related.length) total += Math.max(0, ms(record.updatedAt, at) - ms(record.createdAt, at));
  }
  return { total, partial };
}

export function normalizeTelemetryCause(text: string): string {
  const value = text.toLowerCase();
  if (/quota|credit|monthlylimit|profile.+unavailable|subscription.+(?:unavailable|exhaust)/.test(value)) return "provider_unavailable";
  if (/clean worktree|dirty|switched integration|workspace/.test(value)) return "workspace_state";
  if (/\bstall/.test(value)) return "stalled_turn";
  if (/uncertain|timeout|timed out|transport|creation/.test(value)) return "uncertain_delivery";
  if (/\b(?:missing callback|no callback|stopped|inactive|idle)\b/.test(value)) return "missing_callback";
  if (/branch|head changed|pull request|\bpr\b|merge conflict/.test(value)) return "repository_identity";
  if (/hook|executable|runner/.test(value)) return "hook_failure";
  if (/prerequisite|capacity|slot|queue/.test(value)) return "scheduling";
  return "other";
}

function recordedRecovery(run: Run, events: QueueEvent[]) {
  const event = events.find(candidate => candidate.kind === "telemetry_recovery" && candidate.detail.includes(run.id));
  if (!event) return null;
  try {
    const value = JSON.parse(event.detail) as { runId?: unknown; targetRole?: unknown; cause?: unknown };
    if (value.runId !== run.id || !["worker", "reviewer", "coordinator", "closeout", "unknown"].includes(String(value.targetRole))) return null;
    return { targetRole: value.targetRole as "worker" | "reviewer" | "coordinator" | "closeout" | "unknown", cause: typeof value.cause === "string" ? value.cause : "" };
  } catch { return null; }
}

function recoveryTarget(run: Run, events: QueueEvent[]) {
  const recorded = recordedRecovery(run, events);
  if (recorded) return recorded.targetRole;
  const created = ms(run.createdAt, Date.now());
  const prior = events.filter(event => ms(event.at, created) <= created && ["needs_attention", "recovery_pending", "state"].includes(event.kind)).at(-1);
  const text = `${prior?.detail ?? ""} ${run.completion?.summary ?? ""}`.toLowerCase();
  if (text.includes("reviewer") || text.includes("review ")) return "reviewer" as const;
  if (text.includes("closeout") || text.includes("hook")) return "closeout" as const;
  if (text.includes("verification") || text.includes("merge") || text.includes("sync")) return "coordinator" as const;
  if (text.includes("worker") || text.includes("revision")) return "worker" as const;
  return "unknown" as const;
}

function recoveryCauseEvent(run: Run, events: QueueEvent[]) {
  const created = ms(run.createdAt, 0);
  return events.filter(event => ms(event.at, 0) <= created
    && ["needs_attention", "recovery_pending", "state"].includes(event.kind)
    && event.detail.trim()).at(-1);
}

function revisionKind(run: Run): "review" | "administrative" | "continuation" {
  return run.revisionCause
    ? (run.revisionCause === "continuation" || run.revisionCause === "non_delivery" || run.revisionCause === "unfinished" || run.revisionCause === "consult" ? "continuation" : run.revisionCause === "administrative" ? "administrative" : "review")
    : (run.instruction != null ? "administrative" : "review");
}

export interface ReviewerVerdictFact {
  at: string; runId: string; head: string;
  verdict: "approved" | "changes_required"; exact: boolean;
  reviewer: { agentId: string | null; profileId: string | null; profileName: string | null; provider: string | null; model: string | null; profileGroup: string | null };
}
export interface ReviewerRoundFact { at: string; runId: string; head: string; kind: "review" | "pre_merge"; partial: boolean; verdictIndex: number | null }
export interface ReviewerIncidentFact { at: string; id: string; cause: string; semantic: boolean; verdictIndex: number | null }
/**
 * Per-task reviewer calibration facts derived once per base build. Attribution links only
 * Queue-proven ordering: each later fact (revision round, pre-merge refusal, post-merge
 * incident) belongs to the latest accepted or blocking verdict recorded at or before it.
 * No fact reads repository prose or titles.
 */
export interface ReviewerCalibrationFacts {
  verdicts: ReviewerVerdictFact[];
  rounds: ReviewerRoundFact[];
  refusals: { at: string; runId: string | null; verdictIndex: number | null }[];
  postMergeIncidents: ReviewerIncidentFact[];
}

function reviewerIdentity(run: Run): ReviewerVerdictFact["reviewer"] {
  return {
    agentId: run.agentId, profileId: run.profile?.id ?? null, profileName: run.profile?.name ?? null,
    provider: run.profile?.provider ?? null, model: run.profile?.model ?? null, profileGroup: run.profileGroup ?? null,
  };
}

/**
 * Durable exact-head reviewer attribution. A verdict is exact when the reviewer run carries
 * a proven reviewer profile (identity edge) and its completion records the verdict at the
 * run's exact head; everything older or incomplete stays partial and leaves the
 * identity-denominated rates alone. Revision rounds follow the same cause rule as the
 * intervention counters: rounds without a stored cause marker are reconstructed and marked
 * partial.
 */
export function reviewerCalibrationFacts(task: Task, events: QueueEvent[], runs: Run[]): ReviewerCalibrationFacts {
  const verdictRuns = runs.filter(run => run.role === "reviewer" && run.completion
    && (run.completion.status === "ready_to_merge" || run.completion.status === "changes_required"))
    .sort((a, b) => ms(a.createdAt, 0) - ms(b.createdAt, 0));
  const verdicts: ReviewerVerdictFact[] = verdictRuns.map(run => ({
    at: run.createdAt, runId: run.id, head: run.head,
    verdict: run.completion!.status === "ready_to_merge" ? "approved" : "changes_required",
    exact: Boolean(run.profile?.provider),
    reviewer: reviewerIdentity(run),
  }));
  const verdictIndexFor = (at: string) => {
    const time = ms(at, 0);
    let index: number | null = null;
    for (let index_ = 0; index_ < verdicts.length; index_++) {
      if (ms(verdicts[index_].at, 0) <= time) index = index_; else break;
    }
    return index;
  };
  const firstVerdictAt = verdicts.length ? ms(verdicts[0].at, 0) : null;
  const rounds = firstVerdictAt === null ? [] : runs
    .filter(run => run.role === "revision" && revisionKind(run) === "review" && ms(run.createdAt, 0) >= firstVerdictAt)
    .sort((a, b) => ms(a.createdAt, 0) - ms(b.createdAt, 0))
    .map(run => ({
      at: run.createdAt, runId: run.id, head: run.head,
      kind: run.revisionCause === "pre_merge" ? "pre_merge" as const : "review" as const,
      partial: !run.revisionCause, verdictIndex: verdictIndexFor(run.createdAt),
    }));
  const refusals = firstVerdictAt === null ? [] : events
    .filter(event => event.kind === "pre_merge_refused")
    .sort((a, b) => ms(a.at, 0) - ms(b.at, 0))
    .map(event => ({ at: event.at, runId: null, verdictIndex: verdictIndexFor(event.at) }));
  const mergeAt = Math.min(...events.filter(event => ["merge_verified", "external_merge_observed"].includes(event.kind)).map(event => ms(event.at, 0)), Infinity);
  const incidents = new Map<string, ReviewerIncidentFact>();
  if (Number.isFinite(mergeAt)) for (const event of events) {
    if (event.kind !== "incident" || ms(event.at, 0) < mergeAt) continue;
    try {
      const value = JSON.parse(event.detail) as { id?: unknown; cause?: unknown };
      if (typeof value.id !== "string" || typeof value.cause !== "string") continue;
      const prior = incidents.get(value.id);
      if (prior && ms(prior.at, 0) <= ms(event.at, 0)) continue;
      incidents.set(value.id, { at: event.at, id: value.id, cause: value.cause, semantic: isSemanticIncidentCause(value.cause), verdictIndex: verdictIndexFor(event.at) });
    } catch { /* Unparseable historical incidents stay out of the calibration cohort. */ }
  }
  return { verdicts, rounds, refusals, postMergeIncidents: [...incidents.values()] };
}

function reviewerRowKey(identity: ReviewerVerdictFact["reviewer"]) {
  return identity.profileId ?? identity.agentId ?? "unknown-reviewer";
}

function reviewerRowLabel(identity: ReviewerVerdictFact["reviewer"]) {
  return identity.profileName ?? identity.agentId ?? "Unattributed reviewer";
}

/**
 * Aggregate per-task calibration facts into one group section: counts everywhere, rates only
 * at group level. Rates count distinct verdicts (or exact-attributed rounds) so a rate can
 * never exceed one no matter how many facts share a verdict, and every rate excludes partial
 * verdicts and facts attributed to them, matching Contract 006's partial-evidence rule.
 */
export function mergeReviewerCalibration(items: TelemetryBaseItem[]): ReviewerCalibration {
  const rows = new Map<string, ReviewerCalibrationRow>();
  const row = (identity: ReviewerVerdictFact["reviewer"]) => {
    const key = reviewerRowKey(identity);
    const existing = rows.get(key);
    if (existing) return existing;
    const created: ReviewerCalibrationRow = { key, label: reviewerRowLabel(identity),
      provider: identity.provider, model: identity.model, profileGroup: identity.profileGroup, agentId: identity.agentId,
      verdicts: 0, approved: 0, changesRequired: 0,
      revisionRounds: 0, resolvedRounds: 0, preMergeRefusals: 0, postMergeIncidents: 0 };
    rows.set(key, created);
    return created;
  };
  const totals = { verdicts: 0, approved: 0, changesRequired: 0, exactVerdicts: 0, partialVerdicts: 0, exactApproved: 0,
    revisionRounds: 0, partialRevisionRounds: 0, exactVerdictRounds: 0, resolvedRounds: 0,
    preMergeRefusals: 0,
    postMergeIncidents: 0, postMergeSemanticIncidents: 0, postMergeOperationalIncidents: 0 };
  // Distinct-verdict cohorts for the rates: verdict run IDs are globally unique, so a verdict
  // counts once no matter how many rounds or refusals it produced.
  const exactRoundVerdicts = new Set<string>(), exactRefusalVerdicts = new Set<string>();
  const evidence = new Set<ReviewerVerdictFact["exact"]>();
  for (const item of items) {
    const facts = item.reviewer;
    for (const verdict of facts.verdicts) {
      evidence.add(verdict.exact);
      totals.verdicts += 1;
      if (verdict.verdict === "approved") totals.approved += 1; else totals.changesRequired += 1;
      if (verdict.exact) { totals.exactVerdicts += 1; if (verdict.verdict === "approved") totals.exactApproved += 1; }
      else totals.partialVerdicts += 1;
      // A partial verdict keeps its group verdict count but never joins a per-reviewer row.
      if (!verdict.exact) continue;
      const aggregate = row(verdict.reviewer);
      aggregate.verdicts += 1;
      if (verdict.verdict === "approved") aggregate.approved += 1; else aggregate.changesRequired += 1;
    }
    // A round is resolved only by the next recorded verdict being an accepted re-review;
    // a round followed by another blocking verdict stays unresolved.
    const nextVerdict = (at: string) => facts.verdicts.find(verdict => ms(verdict.at, 0) > ms(at, 0)) ?? null;
    for (const round of facts.rounds) {
      const target = round.verdictIndex !== null ? facts.verdicts[round.verdictIndex] : null;
      totals.revisionRounds += 1;
      if (round.partial) totals.partialRevisionRounds += 1;
      if (!target?.exact) continue;
      totals.exactVerdictRounds += 1;
      exactRoundVerdicts.add(target.runId);
      const resolved = nextVerdict(round.at)?.verdict === "approved";
      if (resolved) totals.resolvedRounds += 1;
      const aggregate = row(target.reviewer);
      aggregate.revisionRounds += 1;
      if (resolved) aggregate.resolvedRounds += 1;
    }
    for (const refusal of facts.refusals) {
      const target = refusal.verdictIndex !== null ? facts.verdicts[refusal.verdictIndex] : null;
      // The reviewed-head gate only runs after an accepted ready_to_merge verdict.
      if (!target?.exact || target.verdict !== "approved") continue;
      totals.preMergeRefusals += 1;
      exactRefusalVerdicts.add(target.runId);
      row(target.reviewer).preMergeRefusals += 1;
    }
    for (const incident of facts.postMergeIncidents) {
      totals.postMergeIncidents += 1;
      if (incident.semantic) totals.postMergeSemanticIncidents += 1; else totals.postMergeOperationalIncidents += 1;
      const target = incident.verdictIndex !== null ? facts.verdicts[incident.verdictIndex] : null;
      if (target?.exact) row(target.reviewer).postMergeIncidents += 1;
    }
  }
  const rate = (numerator: number, denominator: number) => denominator > 0 ? numerator / denominator : null;
  return {
    verdicts: totals.verdicts, approved: totals.approved, changesRequired: totals.changesRequired,
    exactVerdicts: totals.exactVerdicts, partialVerdicts: totals.partialVerdicts, exactApproved: totals.exactApproved,
    revisionRounds: totals.revisionRounds, partialRevisionRounds: totals.partialRevisionRounds,
    resolvedRounds: totals.resolvedRounds, preMergeRefusals: totals.preMergeRefusals,
    postMergeIncidents: totals.postMergeIncidents, postMergeSemanticIncidents: totals.postMergeSemanticIncidents, postMergeOperationalIncidents: totals.postMergeOperationalIncidents,
    // Distinct-verdict shares stay within [0,1] even when several rounds share one verdict.
    revisionReturnRate: rate(exactRoundVerdicts.size, totals.exactVerdicts),
    resolutionRate: rate(totals.resolvedRounds, totals.exactVerdictRounds),
    refusalRate: rate(exactRefusalVerdicts.size, totals.exactApproved),
    reviewers: [...rows.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(0, 100),
    omittedReviewers: Math.max(0, rows.size - 100),
    // Without verdicts nothing is proven, so the calibration evidence stays partial.
    evidence: totals.verdicts === 0 ? "partial" : evidence.size > 1 ? "mixed" : evidence.has(true) ? "exact" : "partial",
  };
}

function interventionRoute(task: Task, runId: string | null, targetRole: string, runs: Run[]) {
  const exact = runId ? runs.find(run => run.id === runId) : null;
  const roles: Run["role"][] = targetRole === "reviewer" ? ["reviewer"] : targetRole === "closeout" ? ["closeout"]
    : targetRole === "coordinator" ? ["recovery"] : targetRole === "worker" ? ["revision"] : [];
  const candidate = exact?.profile ? exact : [...runs].reverse().find(run => roles.includes(run.role) && run.profile);
  if (candidate?.profile) return { provider: candidate.profile.provider || null, profileGroup: candidate.profileGroup ?? null };
  if (targetRole === "worker" && task.profile) return { provider: task.profile.provider || null, profileGroup: task.profileGroup ?? null };
  return { provider: null, profileGroup: null };
}

function interventions(task: Task, events: QueueEvent[], runs: Run[], notices: Notice[], hooks: HookRecord[]) {
  const recoveryRuns = runs.filter(run => run.role === "recovery");
  const grouped = new Map<string, { targetRole: ReturnType<typeof recoveryTarget>; provider: string | null; profileGroup: string | null; status: string; cause: string; count: number }>();
  for (const run of recoveryRuns) {
    const recorded = recordedRecovery(run, events);
    const targetRole = recoveryTarget(run, events);
    const status = run.completion?.status ?? run.status;
    const causeEvent = recoveryCauseEvent(run, events);
    const cause = normalizeTelemetryCause(recorded?.cause || causeEvent?.detail || run.completion?.summary || task.reason);
    const route = interventionRoute(task, null, targetRole, runs.filter(candidate => ms(candidate.createdAt, 0) <= ms(run.createdAt, 0) && candidate.role !== "recovery"));
    const key = `${targetRole}:${route.provider}:${route.profileGroup}:${status}:${cause}`, current = grouped.get(key);
    if (current) current.count += 1; else grouped.set(key, { targetRole, ...route, status, cause, count: 1 });
  }
  // Semantic review revisions (ordinary findings returning to the retained worker) stay
  // separate from administrative recovery revisions. Runs before the revision-cause marker
  // reconstruct partially: a bound scoped instruction implies administrative recovery.
  const revisionRuns = runs.filter(run => run.role === "revision");
  const reviewRevisions = revisionRuns.filter(run => revisionKind(run) === "review").length;
  const continuationRevisions = revisionRuns.filter(run => revisionKind(run) === "continuation").length;
  const administrativeRevisions = revisionRuns.filter(run => revisionKind(run) === "administrative").length;
  const actions = new Map<string, number>();
  for (const event of events) {
    const historicalOperatorAction = ["queue_promoted", "dependencies_changed", "disposition_requested"].includes(event.kind)
      && event.detail.includes("operator control");
    if (event.kind !== "operator_control" && !historicalOperatorAction) continue;
    const key = event.kind === "operator_control" ? event.detail : event.kind;
    actions.set(key, (actions.get(key) ?? 0) + 1);
  }
  const uncertainCreations = runs.filter(run => run.status === "uncertain" && !run.agentId).length
    + events.filter(event => /creation.*uncertain|uncertain.*creation/.test(`${event.kind} ${event.detail}`.toLowerCase())).length;
  const absentEvents = events.filter(event => (event.kind.includes("absent") && event.kind.includes("retry")) || event.kind === "absent_creation_replaced");
  const absentCreations = absentEvents.length || events.filter(event => event.kind === "operator_control" && event.detail.includes("absent")).length;
  const recordedHookHolds = events.filter(event => ["hook_blocked", "hook_uncertain"].includes(event.kind)
    && hooks.some(hook => event.detail.includes(hook.eventId))).length;
  // Exact incident attribution: one row per deduplicated incident identity, grouped by role and normalized cause.
  const incidentRecords = new Map<string, { role: string; runId: string | null; cause: string }>();
  const knownRoles = new Set(["worker", "reviewer", "coordinator", "closeout", "recovery", "unknown"]);
  for (const event of events) {
    if (event.kind !== "incident") continue;
    try {
      const value = JSON.parse(event.detail) as { id?: unknown; role?: unknown; runId?: unknown; cause?: unknown };
      if (typeof value.id !== "string" || typeof value.role !== "string" || !knownRoles.has(value.role) || typeof value.cause !== "string") continue;
      incidentRecords.set(value.id, { role: value.role, runId: typeof value.runId === "string" ? value.runId : null, cause: value.cause });
    } catch { /* Unparseable historical events keep the partial legacy counters. */ }
  }
  const incidentGroups = new Map<string, { role:string; provider:string|null; profileGroup:string|null; cause:string; count:number }>();
  for (const record of incidentRecords.values()) {
    const route=interventionRoute(task,record.runId,record.role,runs);
    const key = `${record.role}:${route.provider}:${route.profileGroup}:${record.cause}`, current=incidentGroups.get(key);
    if(current)current.count+=1;else incidentGroups.set(key,{role:record.role,...route,cause:record.cause,count:1});
  }
  const incidents = [...incidentGroups.values()].map(row=>({...row,role:row.role as "worker" | "reviewer" | "coordinator" | "closeout" | "recovery" | "unknown"}))
    .sort((a, b) => `${a.role}:${a.cause}`.localeCompare(`${b.role}:${b.cause}`));
  return {
    recoveryRuns: recoveryRuns.length,
    recoveries: [...grouped.values()].sort((a, b) => `${a.targetRole}:${a.status}:${a.cause}`.localeCompare(`${b.targetRole}:${b.status}:${b.cause}`)),
    uncertainCreations, absentCreations,
    attentionNotices: notices.filter(notice => notice.kind === "attention").length,
    escalations: events.filter(event => event.kind === "recovery_escalated").length,
    hookHolds: recordedHookHolds || hooks.filter(hook => ["blocked", "uncertain"].includes(hook.state) || hook.delivery === "required" && hook.state === "failed").length,
    hookRetries: hooks.reduce((sum, hook) => sum + Math.max(0, hook.attempt - 1), 0),
    // One durable lineage record per automatic replay: the fresh occurrence, not
    // the superseded intent, so a restart never double-counts one advance.
    automaticHookReplays: hooks.filter(hook => hook.replay?.automatic === true).length,
    // Prospective-merge occurrences and the stale candidate rebuilds they caused
    // stay separate from semantic refusals, operator retries and recovery runs.
    prospectiveMergeHooks: hooks.filter(hook => hook.target === "prospective_merge").length,
    staleCandidateRebuilds: events.filter(event => event.kind === "pre_merge_candidate_stale").length,
    revisions: reviewRevisions,
    continuationRevisions,
    administrativeRevisions,
    checkpoints: events.filter(event => event.kind === "progress_checkpoint").length,
    checkpointContinuations: events.filter(event => event.kind === "checkpoint_continued").length,
    incidents,
    replacements: task.retiredWorkers.length + events.filter(event => event.kind === "role_replacement").length,
    operatorActions: [...actions].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function deriveTaskTelemetry(task: Task, events: QueueEvent[], runs: Run[], notices: Notice[], hooks: HookRecord[], generatedAt = new Date()): TaskTelemetry {
  const at = generatedAt.getTime(), end = task.finishedAt ? ms(task.finishedAt, at) : at;
  const built = timeline(task, events, end), stageMap = new Map<TelemetryStageKey, { elapsedMs: number; partial: boolean }>();
  for (let index = 0; index < built.boundaries.length; index++) {
    const boundary = built.boundaries[index], next = built.boundaries[index + 1]?.at ?? end;
    const current = stageMap.get(boundary.stage) ?? { elapsedMs: 0, partial: false };
    current.elapsedMs += Math.max(0, next - boundary.at); current.partial ||= boundary.partial; stageMap.set(boundary.stage, current);
  }
  const hook = hookDuration(hooks, events, end);
  const stages = [...stageMap].map(([stage, value]) => ({ stage, category: STAGE_META[stage].category, elapsedMs: value.elapsedMs, partial: value.partial, supplemental: false }));
  if (hook) stages.push({ stage: "repository_hook", category: "active", elapsedMs: hook.total, partial: hook.partial, supplemental: true });
  stages.sort((a, b) => Object.keys(STAGE_META).indexOf(a.stage) - Object.keys(STAGE_META).indexOf(b.stage));
  const sum = (category: "waiting" | "active" | "intervention") => stages.filter(stage => !stage.supplemental && stage.category === category).reduce((total, stage) => total + stage.elapsedMs, 0);
  const last = built.boundaries.at(-1) ?? { at: ms(task.updatedAt, end), stage: telemetryStageForTask(task), partial: true };
  const openHook = hooks.filter(record => !terminalHookStates.has(record.state)).at(-1);
  const currentStage = openHook && !task.finishedAt ? "repository_hook" : task.finishedAt ? telemetryStageForTask(task) : last.stage;
  const currentHookBoundary = openHook ? events.filter(event => event.detail.includes(openHook.eventId)
    && ["hook_intent", "hook_workspace_intent", "hook_execution_started"].includes(event.kind)).at(-1) : null;
  const currentStarted = openHook && !task.finishedAt ? ms(currentHookBoundary?.at ?? openHook.createdAt, last.at) : last.at;
  const closeoutAuthority = hooks.some(record => record.event === "task.closeout" && record.mode === "integration_write" && record.delivery === "required")
    ? "repository_hook" : runs.some(run => run.role === "closeout") ? "agent" : task.finishedAt ? "none" : "pending";
  const nonDeliveryCounts = new Map<string, { provider: string | null; model: string | null; count: number }>();
  const nonDeliveries = nonDeliveryEvents(events);
  for (const item of nonDeliveries) {
    const key = `${item.provider ?? ''}\u0000${item.model ?? ''}`;
    const existing = nonDeliveryCounts.get(key) ?? { provider: item.provider, model: item.model, count: 0 };
    existing.count += 1; nonDeliveryCounts.set(key, existing);
  }
  // Spec 058 slice 17: blocked reports per model, and the ladder seat of each escalation.
  const blockerCounts = new Map<string, { provider: string | null; model: string | null; count: number }>();
  const blockedReport = (provider: string | null, model: string | null) => {
    const key = `${provider ?? ''}\u0000${model ?? ''}`;
    const existing = blockerCounts.get(key) ?? { provider, model, count: 0 };
    existing.count += 1; blockerCounts.set(key, existing);
  };
  let blockedReports = 0;
  for (const run of runs) {
    if (!run.completion || !['blocked', 'error'].includes(run.completion.status)) continue;
    if (!['worker', 'revision'].includes(run.role)) continue;
    blockedReports += 1;
    blockedReport(run.profile?.provider ?? null, run.profile?.model ?? null);
  }
  const initial = task.completion;
  if (initial && ['blocked', 'error'].includes(initial.status) && !runs.some(run => run.id === initial.runId)) {
    blockedReports += 1;
    blockedReport(task.profile?.provider ?? null, task.profile?.model ?? task.workerModel ?? null);
  }
  const ladderEvents = events as Array<{ id: number; taskId: string; at: string; kind: string; detail: string }>;
  const escalations = {
    worker: events.filter(event => ['non_delivery', 'unfinished_continuation'].includes(event.kind)).length,
    reviewer: reviewerConsults(ladderEvents).length,
    planner: plannerEscalations(ladderEvents).length,
    tom: events.filter(event => event.kind === 'planner_escalation_decision_linked').length,
  };
  return taskTelemetrySchema.parse({
    taskId: task.id, generatedAt: generatedAt.toISOString(), evidence: built.evidence,
    totalElapsedMs: Math.max(0, end - ms(task.createdAt, end)), waitingMs: sum("waiting"), activeMs: sum("active"), interventionMs: sum("intervention"),
    currentStage, currentStageAgeMs: task.finishedAt ? 0 : Math.max(0, at - currentStarted), closeoutAuthority, stages,
    interventions: interventions(task, events, runs, notices, hooks), usage: taskUsage(runs),
    nonDelivery: { count: nonDeliveries.length, byModel: [...nonDeliveryCounts.values()] },
    blockers: { count: blockedReports, byModel: [...blockerCounts.values()], escalations },
  });
}

/**
 * Spec 058 slice 1: finished tasks grouped by complexity, with nearest-rank percentiles of
 * effective tokens, observed wall time and turns. Partial usage counts as partial, never zero.
 */
function usageByComplexity(items: TelemetryBaseItem[]): UsageComplexity[] {
  const finished = items.filter(item => item.task.phase === "done");
  const groups = new Map<string, TelemetryBaseItem[]>();
  // An unset complexity is its own bucket: an unrated task is never folded into a level.
  const complexityOf = (item: TelemetryBaseItem) => item.task.complexity ?? "unset";
  for (const item of finished) groups.set(complexityOf(item), [...(groups.get(complexityOf(item)) ?? []), item]);
  return [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([complexity, members]) => {
    const usages = members.map(item => item.telemetry.usage).filter((usage): usage is TaskUsage => usage !== undefined);
    // A task with no usage at all is partial and stays out of the samples: never a zero.
    const measured = usages.filter(usage => usage.evidence !== "none");
    const partialCount = usages.filter(usage => usage.evidence !== "exact").length;
    const dist = (values: number[]) => ({ count: values.length, partialCount, p50: percentile(values, .5), p95: percentile(values, .95) });
    return {
      complexity, finishedCount: members.length,
      // A provider that reported no tokens contributes turns and wall time only.
      effectiveTokens: dist(measured.filter(usage => usage.total.reportedTurns > 0).map(usage => usage.total.effectiveTokens)),
      wallMs: dist(measured.map(usage => usage.total.wallMs)),
      turns: dist(measured.map(usage => usage.total.turns)),
    };
  });
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function distribution(values: number[], partialCount: number) {
  return { count: values.length, partialCount, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95) };
}
/**
 * Aggregate one group's settled project validations into separate queue-wait,
 * wall and CPU distributions from Queue's scheduler record. Queue wait never folds into run time;
 * validations without a value count as partial, never as zero.
 */
function mergeQaValidationAdmission(items: TelemetryBaseItem[]): QaValidationAdmission {
  const settled = items.map(item => item.task.resolution.projectValidation)
    .filter((validation): validation is NonNullable<Task["resolution"]["projectValidation"]> => Boolean(validation) && validation!.state !== "running");
  const distributionOf = (values: (number | null | undefined)[]) => {
    const recorded = values.filter((value): value is number => typeof value === "number");
    return { count: recorded.length, partialCount: values.length - recorded.length, p50Ms: percentile(recorded, .5), p95Ms: percentile(recorded, .95) };
  };
  const scheduler = settled.map(validation => validation.hostRunTelemetry);
  const legacy = settled.map(validation => validation.admission);
  const cpuMs = scheduler.map((record, index) => record?.cpuMs
    ?? (legacy[index]?.cpuUserMs != null || legacy[index]?.cpuSystemMs != null
      ? (legacy[index]?.cpuUserMs ?? 0) + (legacy[index]?.cpuSystemMs ?? 0) : null));
  return {
    validations: settled.length,
    queueWaitMs: distributionOf(scheduler.map((record, index) => record?.queueWaitMs ?? legacy[index]?.queueWaitMs)),
    wallMs: distributionOf(scheduler.map((record, index) => record?.wallMs ?? legacy[index]?.wallMs)),
    cpuMs: distributionOf(cpuMs),
    capacityUnavailable: settled.filter(validation => validation.capacityUnavailable).length,
  };
}

function mergeInterventions(items: TaskTelemetry[]) {
  const recovery = new Map<string, TaskTelemetry["interventions"]["recoveries"][number]>(), actions = new Map<string, number>(), incidents = new Map<string, TaskTelemetry["interventions"]["incidents"][number]>();
  const total = { recoveryRuns: 0, uncertainCreations: 0, absentCreations: 0, attentionNotices: 0, escalations: 0, hookHolds: 0, hookRetries: 0, automaticHookReplays: 0, prospectiveMergeHooks: 0, staleCandidateRebuilds: 0, revisions: 0, continuationRevisions: 0, administrativeRevisions: 0, checkpoints: 0, checkpointContinuations: 0, replacements: 0 };
  for (const item of items) {
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += item.interventions[key];
    for (const row of item.interventions.recoveries) { const key = `${row.targetRole}:${row.provider}:${row.profileGroup}:${row.status}:${row.cause}`, prior = recovery.get(key); if (prior) prior.count += row.count; else recovery.set(key, { ...row }); }
    for (const row of item.interventions.incidents) { const key = `${row.role}:${row.provider}:${row.profileGroup}:${row.cause}`, prior = incidents.get(key); if (prior) prior.count += row.count; else incidents.set(key, { ...row }); }
    for (const row of item.interventions.operatorActions) actions.set(row.key, (actions.get(row.key) ?? 0) + row.count);
  }
  return { ...total, recoveries: [...recovery.values()], incidents: [...incidents.values()].sort((a, b) => `${a.role}:${a.cause}`.localeCompare(`${b.role}:${b.cause}`)), operatorActions: [...actions].map(([key, count]) => ({ key, count })) };
}

export interface TelemetryBaseItem { task: Task; telemetry: TaskTelemetry; reviewer: ReviewerCalibrationFacts }
/**
 * One coalesced task-level base per durable store revision and short age bucket. It holds
 * the current derivation for every task plus bounded dimension dictionaries; filters and
 * groups are computed in memory from it, so memory never grows with filter cardinality.
 */
export interface TelemetryBase {
  revision: number;
  generatedAt: string;
  builtAt: number;
  items: TelemetryBaseItem[];
  repositories: string[];
  scopes: string[];
  profileGroups: string[];
  interventionProviders: string[];
  reviewerProviders: string[];
  reviewerProfiles: string[];
  reviewerProfileGroups: string[];
}

interface FactBundle {
  tasks: Task[];
  eventsByTask: Map<string, QueueEvent[]>;
  runsByTask: Map<string, Run[]>;
  noticesByTask: Map<string, Notice[]>;
  hooksByTask: Map<string, HookRecord[]>;
}

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

function emptyBundle(): FactBundle {
  return { tasks: [], eventsByTask: new Map(), runsByTask: new Map(), noticesByTask: new Map(), hooksByTask: new Map() };
}

function pushFact<T>(map: Map<string, T[]>, taskId: string, value: T) {
  const list = map.get(taskId);
  if (list) list.push(value); else map.set(taskId, [value]);
}

function applyFactChunk(bundle: FactBundle, chunk: TelemetryFactChunk) {
  if (chunk.kind === "tasks") bundle.tasks.push(...chunk.tasks);
  else if (chunk.kind === "events") for (const row of chunk.events) pushFact(bundle.eventsByTask, row.taskId, row.event);
  else if (chunk.kind === "runs") for (const row of chunk.runs) pushFact(bundle.runsByTask, row.taskId, row.run);
  else if (chunk.kind === "notices") for (const row of chunk.notices) pushFact(bundle.noticesByTask, row.taskId, row.notice);
  else for (const row of chunk.hooks) pushFact(bundle.hooksByTask, row.taskId, row.hook);
}

function deriveItem(bundle: FactBundle, task: Task, generatedAt: Date): TelemetryBaseItem {
  const events = bundle.eventsByTask.get(task.id) ?? [], runs = bundle.runsByTask.get(task.id) ?? [];
  return { task, telemetry: deriveTaskTelemetry(task, events, runs,
    bundle.noticesByTask.get(task.id) ?? [], bundle.hooksByTask.get(task.id) ?? [], generatedAt),
    reviewer: reviewerCalibrationFacts(task, events, runs) };
}

function dimensionValues(bundle: FactBundle, items: TelemetryBaseItem[]) {
  const providers = new Set<string>();
  const reviewerProviders = new Set<string>(), reviewerProfileGroups = new Set<string>(), reviewerProfiles = new Set<string>();
  for (const item of items) {
    if (item.task.profile?.provider) providers.add(item.task.profile.provider);
    for (const run of bundle.runsByTask.get(item.task.id) ?? []) if (run.profile?.provider) providers.add(run.profile.provider);
    for (const verdict of item.reviewer.verdicts) {
      if (verdict.reviewer.provider) reviewerProviders.add(verdict.reviewer.provider);
      if (verdict.reviewer.profileGroup) reviewerProfileGroups.add(verdict.reviewer.profileGroup);
      reviewerProfiles.add(verdict.reviewer.profileName ?? verdict.reviewer.agentId ?? verdict.reviewer.profileId ?? "Unattributed reviewer");
    }
  }
  return {
    repositories: [...new Set(items.map(item => item.task.repoPath))].sort(),
    scopes: [...new Set(items.map(item => item.task.scope))].sort(),
    profileGroups: [...new Set(items.map(item => item.task.profileGroup).filter((value): value is string => Boolean(value)))].sort(),
    interventionProviders: [...providers].sort(),
    reviewerProviders: [...reviewerProviders].sort(), reviewerProfileGroups: [...reviewerProfileGroups].sort(), reviewerProfiles: [...reviewerProfiles].sort(),
  };
}

/**
 * Load every telemetry fact in bounded pages, handing the event loop back between pages so
 * concurrent Queue RPC and lifecycle work keep running during a cold build.
 */
export async function buildTelemetryBase(store: Store, generatedAt = new Date(), options: { pageSize?: number; yieldEvery?: number } = {}): Promise<TelemetryBase> {
  const revision = store.telemetryRevision();
  const bundle = emptyBundle();
  for (const chunk of store.telemetryFactChunks(options.pageSize ?? 500)) { applyFactChunk(bundle, chunk); await yieldToEventLoop(); }
  const yieldEvery = Math.max(1, options.yieldEvery ?? 16);
  const items: TelemetryBaseItem[] = [];
  for (let index = 0; index < bundle.tasks.length; index++) {
    items.push(deriveItem(bundle, bundle.tasks[index], generatedAt));
    if (index % yieldEvery === yieldEvery - 1) await yieldToEventLoop();
  }
  return { revision, generatedAt: generatedAt.toISOString(), builtAt: generatedAt.getTime(), items, ...dimensionValues(bundle, items) };
}

/** Synchronous construction for direct derivation, tests and small stores. */
export function buildTelemetryBaseSync(store: Store, generatedAt = new Date(), page = 500): TelemetryBase {
  const revision = store.telemetryRevision();
  const facts = store.telemetryFacts(page);
  const bundle: FactBundle = { tasks: facts.tasks, eventsByTask: facts.eventsByTask, runsByTask: facts.runsByTask, noticesByTask: facts.noticesByTask, hooksByTask: facts.hooksByTask };
  const items = bundle.tasks.map(task => deriveItem(bundle, task, generatedAt));
  return { revision, generatedAt: generatedAt.toISOString(), builtAt: generatedAt.getTime(), items, ...dimensionValues(bundle, items) };
}

function headlineCounts(items: TelemetryBaseItem[]): TelemetryHeadline {
  const facts = items.map(item => headlineFacts(item.telemetry.interventions));
  const category = (key: TelemetryHeadlineKey) => {
    const taskCount = facts.filter(row => row[key] > 0).length;
    return { taskCount, factCount: facts.reduce((sum, row) => sum + row[key], 0), rate: items.length ? taskCount / items.length : null };
  };
  return { deliveryExceptions: category("deliveryExceptions"), semanticReview: category("semanticReview"), operatorAdministration: category("operatorAdministration") };
}

/** Filter, group and aggregate one already-built base in memory. */
export function telemetrySnapshotFromBase(base: TelemetryBase, input: unknown): TelemetrySnapshot {
  const filters = telemetryFilterSchema.parse(input), nowAt = base.builtAt;
  const windowMs = filters.window === "all" ? Infinity : ({ "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[filters.window] * 86_400_000);
  const createdAfter = filters.createdAfter ? Date.parse(filters.createdAfter) : null;
  const data = base.items.filter(item => nowAt - ms(item.task.createdAt, nowAt) <= windowMs)
    .filter(item => createdAfter === null || ms(item.task.createdAt, 0) >= createdAfter)
    .filter(item => !filters.repoPath || item.task.repoPath === filters.repoPath)
    .filter(item => !filters.scope || item.task.scope === filters.scope)
    .filter(item => !filters.profileGroup || item.task.profileGroup === filters.profileGroup)
    .filter(item => !filters.closeoutAuthority || item.telemetry.closeoutAuthority === filters.closeoutAuthority)
    .filter(item => !filters.reviewerProvider || item.reviewer.verdicts.some(verdict => verdict.reviewer.provider === filters.reviewerProvider))
    .filter(item => !filters.reviewerProfile || item.reviewer.verdicts.some(verdict => {
      // Match the same identity the dimension dictionary advertises: profile name, then agent
      // id, then profile id, with the unattributed fallback matching identity-less verdicts.
      const identity = verdict.reviewer;
      return identity.profileName === filters.reviewerProfile || identity.profileId === filters.reviewerProfile
        || identity.agentId === filters.reviewerProfile
        || (!identity.profileName && !identity.profileId && !identity.agentId && filters.reviewerProfile === "Unattributed reviewer");
    }))
    .filter(item => !filters.reviewerProfileGroup || item.reviewer.verdicts.some(verdict => verdict.reviewer.profileGroup === filters.reviewerProfileGroup))
    .filter(item => !filters.interventionRole || item.telemetry.interventions.recoveries.some(row => row.targetRole === filters.interventionRole) || item.telemetry.interventions.incidents.some(row => row.role === filters.interventionRole))
    .filter(item => !filters.interventionProvider || item.telemetry.interventions.recoveries.some(row => row.provider === filters.interventionProvider) || item.telemetry.interventions.incidents.some(row => row.provider === filters.interventionProvider));
  const grouped = new Map<string, TelemetryBaseItem[]>();
  for (const item of data) {
    const key = filters.groupBy === "repository" ? item.task.repoPath : filters.groupBy === "scope" ? item.task.scope : filters.groupBy === "profile_group" ? item.task.profileGroup ?? "unassigned" : filters.groupBy === "closeout_authority" ? item.telemetry.closeoutAuthority : "all";
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  const selectedGroups = [...grouped].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 100);
  const groups = selectedGroups.map(([key, items]) => {
    const telemetries = items.map(item => item.telemetry), completed = items.filter(item => item.task.phase === "done").length;
    const interventionTasks = telemetries.filter(item => {
      const value = item.interventions;
      return value.recoveryRuns + value.uncertainCreations + value.absentCreations + value.attentionNotices
        + value.escalations + value.hookHolds + value.hookRetries + value.automaticHookReplays + value.revisions + value.replacements
        + value.operatorActions.reduce((sum, action) => sum + action.count, 0) > 0;
    }).length;
    const stageRows = Object.keys(STAGE_META).map(stage => {
      const key = stage as TelemetryStageKey, samples = telemetries.flatMap(item => item.stages.filter(row => row.stage === key));
      return { stage: key, category: STAGE_META[key].category, supplemental: key === "repository_hook", ...distribution(samples.map(row => row.elapsedMs), samples.filter(row => row.partial).length) };
    }).filter(row => row.count > 0);
    const evidence = telemetries.every(item => item.evidence === "exact") ? "exact" : telemetries.every(item => item.evidence === "partial") ? "partial" : "mixed";
    const label = key === "all" ? "All matching tasks" : filters.groupBy === "closeout_authority" ? key.replaceAll("_", " ") : key.split("/").filter(Boolean).at(-1) ?? key;
    return { key, label, taskCount: items.length, completedCount: completed, completionRate: items.length ? completed / items.length : null,
      interventionTaskCount: interventionTasks, interventionRate: items.length ? interventionTasks / items.length : null,
      total: distribution(telemetries.map(item => item.totalElapsedMs), telemetries.filter(item => item.evidence !== "exact").length),
      waiting: distribution(telemetries.map(item => item.waitingMs), telemetries.filter(item => item.evidence !== "exact").length),
      active: distribution(telemetries.map(item => item.activeMs), telemetries.filter(item => item.evidence !== "exact").length),
      stages: stageRows, interventions: mergeInterventions(telemetries), headline: headlineCounts(items),
      closeoutAuthorities: { repositoryHook: telemetries.filter(item => item.closeoutAuthority === "repository_hook").length,
        agent: telemetries.filter(item => item.closeoutAuthority === "agent").length,
        pending: telemetries.filter(item => item.closeoutAuthority === "pending").length,
        none: telemetries.filter(item => item.closeoutAuthority === "none").length }, evidence,
      qaAdmission: mergeQaValidationAdmission(items),
      reviewerCalibration: mergeReviewerCalibration(items),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
  const dimensions = {
    repositories: base.repositories, scopes: base.scopes, profileGroups: base.profileGroups, interventionProviders: base.interventionProviders,
    reviewerProviders: base.reviewerProviders, reviewerProfiles: base.reviewerProfiles, reviewerProfileGroups: base.reviewerProfileGroups,
  };
  const truncatedDimensions = Object.entries(dimensions).filter(([, values]) => values.length > 100).map(([key]) => key);
  return telemetrySnapshotSchema.parse({ generatedAt: base.generatedAt, filters, matchingTasks: data.length, groups,
    usageByComplexity: usageByComplexity(data),
    omittedGroups: grouped.size - selectedGroups.length, truncatedDimensions,
    ...Object.fromEntries(Object.entries(dimensions).map(([key, values]) => [key, values.slice(0, 100)])),
    shadowPlan: disabledShadowReviewPlan });
}

/** Direct synchronous aggregate derivation over the whole store. */
export function telemetrySnapshot(store: Store, input: unknown, generatedAt = new Date()): TelemetrySnapshot {
  return telemetrySnapshotFromBase(buildTelemetryBaseSync(store, generatedAt), input);
}

/**
 * Coalescing aggregate cache. One in-flight cold build is shared by every concurrent filter,
 * the base is reused until a durable write advances the store revision, and a fifteen-second
 * maximum age refreshes unfinished current-stage ages even when no write occurs. Only the
 * current base and its bounded dimensions are retained, never one entry per filter.
 */
export function createTelemetrySnapshotCache(
  store: Store,
  options: { maxAgeMs?: number; now?: () => number; pageSize?: number; yieldEvery?: number } = {},
): (input: unknown) => Promise<TelemetrySnapshot> {
  const maxAgeMs = options.maxAgeMs ?? 15_000;
  const now = options.now ?? Date.now;
  let base: TelemetryBase | null = null;
  let building: Promise<TelemetryBase> | null = null;

  const current = () => base !== null && base.revision === store.telemetryRevision() && now() - base.builtAt <= maxAgeMs;
  const ensure = () => {
    if (current()) return Promise.resolve(base!);
    if (building) return building;
    const started = new Date(now());
    building = buildTelemetryBase(store, started, options)
      .then(next => { base = next; return next; })
      .finally(() => { building = null; });
    return building;
  };

  return async (input: unknown) => telemetrySnapshotFromBase(await ensure(), input);
}

/**
 * Round 4: the applied and refused task-control rate for the telemetry window,
 * capped at the 30-day outcome retention. Owner and coordinator outcomes stay
 * separate (the round-4 exit target is coordinator refusals under 10%). Refusal
 * reasons group by their text with identities and numbers masked.
 */
export function taskControlTelemetry(store: Store, input: unknown, generatedAt = new Date()): TaskControlTelemetry {
  const filters = telemetryFilterSchema.parse(input);
  const windowMs = Math.min(VERB_OUTCOME_RETENTION_MS, filters.window === "all" ? Infinity : { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[filters.window] * 86_400_000);
  const repoOf = new Map<string, string | null>();
  const repo = (taskId: string) => {
    // A finished task's live row is purged after 4 days but its control outcomes are
    // kept 30, so a purged task resolves through its durable outcome (review #571).
    if (!repoOf.has(taskId)) {
      let path: string | null = null;
      try { path = store.task(taskId).repoPath; } catch { path = store.outcome(taskId)?.repository?.path ?? null; }
      repoOf.set(taskId, path);
    }
    return repoOf.get(taskId) ?? null;
  };
  const outcomes = store.verbOutcomes(new Date(generatedAt.getTime() - windowMs).toISOString())
    .filter(row => !filters.repoPath || repo(row.taskId) === filters.repoPath);
  const rate = (source: VerbOutcome["source"]) => {
    const rows = outcomes.filter(row => row.source === source), refused = rows.filter(row => row.outcome === "refused").length;
    return { applied: rows.length - refused, refused, refusalRate: rows.length ? refused / rows.length : null };
  };
  const actions = new Map<string, TaskControlTelemetry["byAction"][number]>();
  const reasons = new Map<string, TaskControlTelemetry["topRefusals"][number]>();
  for (const row of outcomes) {
    const key = `${row.source}:${row.action}`;
    const entry = actions.get(key) ?? { source: row.source, action: row.action, applied: 0, refused: 0 };
    entry[row.outcome === "applied" ? "applied" : "refused"] += 1;
    actions.set(key, entry);
    if (row.outcome !== "refused") continue;
    const reason = String(row.detail.reason ?? "No reason recorded")
      .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "…").replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, "…").replace(/\d+/g, "#").slice(0, 200);
    const reasonKey = `${key}:${reason}`;
    const counted = reasons.get(reasonKey) ?? { source: row.source, action: row.action, reason, count: 0 };
    counted.count += 1;
    reasons.set(reasonKey, counted);
  }
  return taskControlTelemetrySchema.parse({
    windowDays: windowMs / 86_400_000, owner: rate("owner"), coordinator: rate("coordinator"),
    byAction: [...actions.values()].sort((a, b) => b.applied + b.refused - a.applied - a.refused || a.action.localeCompare(b.action)).slice(0, 24),
    topRefusals: [...reasons.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 8),
  });
}
