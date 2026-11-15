import type { Task, Run, Notice } from "../../shared/contracts";
import type { HookRecord } from "../../shared/hooks";
import { STAGE_META, isSemanticIncidentCause, taskTelemetrySchema, telemetryStageForTask, type TaskTelemetry, type TelemetryStageKey } from "../../shared/telemetry";
import { taskUsage } from "./run-usage";
import { nonDeliveryEvents } from "../recovery/non-delivery";
import { plannerEscalations, reviewerConsults } from "../questions/ladder";

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

export function revisionKind(run: Run): "review" | "administrative" | "continuation" {
  return run.revisionCause
    ? (run.revisionCause === "continuation" || run.revisionCause === "non_delivery" || run.revisionCause === "unfinished" || run.revisionCause === "consult" ? "continuation" : run.revisionCause === "administrative" ? "administrative" : "review")
    : (run.instruction != null ? "administrative" : "review");
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
