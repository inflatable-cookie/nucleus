import { z } from "zod";
import { incidentRoleSchema } from "./incident";
import type { Task } from "./contracts";

export const telemetryStageKeySchema = z.enum([
  "prerequisite_wait", "held_wait", "capacity_wait", "creation",
  "worker_active", "worker_release_wait", "review_wait", "planner_acceptance_wait", "review", "verification",
  "merge", "synchronization", "closeout", "repository_hook", "attention", "complete", "cancelled",
]);
export type TelemetryStageKey = z.infer<typeof telemetryStageKeySchema>;
export const telemetryStageCategorySchema = z.enum(["waiting", "active", "intervention", "terminal"]);
export const closeoutAuthoritySchema = z.enum(["repository_hook", "agent", "pending", "none"]);
/**
 * Spec 058 slice 1: per-task usage, summed over every run's observed turns. Effective
 * tokens = uncached input + output + 10% of cached input. A provider that reports no
 * tokens contributes turns and wall time only, never an invented token count.
 */
export const USAGE_ROLES = ["worker", "reviewer", "recovery", "closeout"] as const;
export type UsageRole = (typeof USAGE_ROLES)[number];
export const usageTotalsSchema = z.object({
  turns: z.number().int().nonnegative(), reportedTurns: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(), cachedInputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  effectiveTokens: z.number().nonnegative(), wallMs: z.number().nonnegative(), peakContextTokens: z.number().nonnegative().nullable(),
}).strict();
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export const taskUsageSchema = z.object({
  evidence: z.enum(["exact", "partial", "none"]),
  total: usageTotalsSchema,
  byRole: z.object({ worker: usageTotalsSchema, reviewer: usageTotalsSchema, recovery: usageTotalsSchema, closeout: usageTotalsSchema }).strict(),
}).strict();
export type TaskUsage = z.infer<typeof taskUsageSchema>;
export const usageDistributionSchema = z.object({
  count: z.number().int().nonnegative(), partialCount: z.number().int().nonnegative(),
  p50: z.number().nonnegative().nullable(), p95: z.number().nonnegative().nullable(),
}).strict();
/** Finished tasks of one complexity: nearest-rank percentiles of their usage totals. */
export const usageComplexitySchema = z.object({
  complexity: z.string(), finishedCount: z.number().int().nonnegative(),
  effectiveTokens: usageDistributionSchema, wallMs: usageDistributionSchema, turns: usageDistributionSchema,
}).strict();
export type UsageComplexity = z.infer<typeof usageComplexitySchema>;

export const stageDurationSchema = z.object({
  stage: telemetryStageKeySchema,
  category: telemetryStageCategorySchema,
  elapsedMs: z.number().nonnegative(),
  partial: z.boolean(),
  supplemental: z.boolean().default(false),
}).strict();

export const counterSchema = z.object({ key: z.string(), count: z.number().int().nonnegative() }).strict();
export const recoveryCounterSchema = z.object({
  targetRole: z.enum(["worker", "reviewer", "coordinator", "closeout", "unknown"]),
  provider: z.string().nullable(), profileGroup: z.string().nullable(),
  status: z.string(), cause: z.string(), count: z.number().int().nonnegative(),
}).strict();
export const interventionSchema = z.object({
  recoveryRuns: z.number().int().nonnegative(),
  recoveries: z.array(recoveryCounterSchema),
  uncertainCreations: z.number().int().nonnegative(),
  absentCreations: z.number().int().nonnegative(),
  attentionNotices: z.number().int().nonnegative(),
  escalations: z.number().int().nonnegative(),
  hookHolds: z.number().int().nonnegative(),
  hookRetries: z.number().int().nonnegative(),
  // Automatic exact-identity base-advance replays are counted separately from
  // coordinator recovery, operator hook retry and semantic hook refusal.
  automaticHookReplays: z.number().int().nonnegative().default(0),
  // Prospective-merge occurrences and the stale candidate rebuilds they caused
  // stay separate from semantic refusals, hook holds and recovery coordinators.
  prospectiveMergeHooks: z.number().int().nonnegative().default(0),
  staleCandidateRebuilds: z.number().int().nonnegative().default(0),
  revisions: z.number().int().nonnegative(),
  // Pass-gate publication continuations return to the worker without counting
  // as semantic review revisions or administrative recovery.
  continuationRevisions: z.number().int().nonnegative().default(0),
  administrativeRevisions: z.number().int().nonnegative().default(0),
  // Bounded worker checkpoint receipts and continuation turns are recorded
  // separately. Their time stays worker active time and they never inflate
  // recovery, semantic revision or operator-administration counters.
  checkpoints: z.number().int().nonnegative().default(0),
  checkpointContinuations: z.number().int().nonnegative().default(0),
  incidents: z.array(z.object({ role: incidentRoleSchema, provider: z.string().nullable(), profileGroup: z.string().nullable(), cause: z.string(), count: z.number().int().nonnegative() }).strict()).default([]),
  replacements: z.number().int().nonnegative(),
  operatorActions: z.array(counterSchema),
}).strict();

export const taskTelemetrySchema = z.object({
  taskId: z.string(),
  generatedAt: z.string(),
  evidence: z.enum(["exact", "mixed", "partial"]),
  totalElapsedMs: z.number().nonnegative(),
  waitingMs: z.number().nonnegative(),
  activeMs: z.number().nonnegative(),
  interventionMs: z.number().nonnegative(),
  currentStage: telemetryStageKeySchema,
  currentStageAgeMs: z.number().nonnegative(),
  closeoutAuthority: closeoutAuthoritySchema,
  stages: z.array(stageDurationSchema),
  interventions: interventionSchema,
  /** Absent only on telemetry written before Spec 058 slice 1; derived otherwise. */
  usage: taskUsageSchema.optional(),
  /** Spec 058: unchanged blocked/error worker results, attributed to their reported model. */
  nonDelivery: z.object({
    count: z.number().int().nonnegative(),
    byModel: z.array(z.object({ provider: z.string().nullable(), model: z.string().nullable(), count: z.number().int().nonnegative() }).strict()),
  }).strict().default({ count: 0, byModel: [] }),
  /**
   * Spec 058 slice 17 (task 584): the task's blocked reports per model, and where
   * each ladder escalation sits — worker continuations, reviewer consults, planner
   * escalations, and escalations that reached the operator.
   */
  blockers: z.object({
    count: z.number().int().nonnegative(),
    byModel: z.array(z.object({ provider: z.string().nullable(), model: z.string().nullable(), count: z.number().int().nonnegative() }).strict()),
    escalations: z.object({
      worker: z.number().int().nonnegative(),
      reviewer: z.number().int().nonnegative(),
      planner: z.number().int().nonnegative(),
      tom: z.number().int().nonnegative(),
    }).strict(),
  }).strict().default({ count: 0, byModel: [], escalations: { worker: 0, reviewer: 0, planner: 0, tom: 0 } }),
}).strict();
export type TaskTelemetry = z.infer<typeof taskTelemetrySchema>;

/**
 * Headline categories separate what a task's evidence means. Each category counts
 * tasks that carry at least one fact of its class; a task may appear in more than one
 * category, but no fact class is ever counted as delivery inefficiency by mistake.
 */
export const telemetryHeadlineCategorySchema = z.object({
  taskCount: z.number().int().nonnegative(), factCount: z.number().int().nonnegative(),
  rate: z.number().min(0).max(1).nullable(),
}).strict();
export const telemetryHeadlineSchema = z.object({
  deliveryExceptions: telemetryHeadlineCategorySchema,
  semanticReview: telemetryHeadlineCategorySchema,
  operatorAdministration: telemetryHeadlineCategorySchema,
}).strict();
export type TelemetryHeadline = z.infer<typeof telemetryHeadlineSchema>;
export type TelemetryHeadlineKey = keyof TelemetryHeadline;
export const telemetryHeadlineKeys = ["deliveryExceptions", "semanticReview", "operatorAdministration"] as const;
export const emptyTelemetryHeadline: TelemetryHeadline = {
  deliveryExceptions: { taskCount: 0, factCount: 0, rate: null },
  semanticReview: { taskCount: 0, factCount: 0, rate: null },
  operatorAdministration: { taskCount: 0, factCount: 0, rate: null },
};

/**
 * Classify one task's raw intervention facts into the three headline categories.
 * Delivery exceptions cover operational recovery, uncertain or absent creation,
 * delivery attention and operational hook failure. Semantic review covers accepted
 * findings returned to the retained worker. Operator administration covers explicit
 * hold, reprioritize, disposition, cancel, supersede, remap and versioned controls;
 * bulk administration therefore never reads as delivery inefficiency.
 */
export function headlineFacts(interventions: TaskTelemetry["interventions"]): Record<TelemetryHeadlineKey, number> {
  return {
    deliveryExceptions: interventions.recoveryRuns + interventions.uncertainCreations + interventions.absentCreations
      + interventions.attentionNotices + interventions.hookHolds,
    semanticReview: interventions.revisions,
    operatorAdministration: interventions.administrativeRevisions
      + interventions.operatorActions.reduce((sum, action) => sum + action.count, 0),
  };
}

/**
 * The bounded shadow-review experiment plan, recorded as designed but disabled. No runtime,
 * dispatch or enablement belongs to telemetry: turning any experiment on requires a separate
 * operator decision and versioned control (Spec 011).
 */
export const shadowReviewPlanSchema = z.object({
  experimentId: z.string(), name: z.string(),
  enabled: z.literal(false), mode: z.literal("non_authoritative_read_only"),
  dailyCap: z.number().int().max(5), maxSampleRate: z.number().max(0.1),
  shadowsPerTask: z.literal(1), independentProfile: z.literal(true),
  startsAt: z.null(), endsAt: z.null(),
  eligibility: z.literal("deferred_to_operator_authorization"),
  authority: z.literal("separate_operator_decision"),
}).strict();
export type ShadowReviewPlan = z.infer<typeof shadowReviewPlanSchema>;
export const disabledShadowReviewPlan: ShadowReviewPlan = shadowReviewPlanSchema.parse({
  experimentId: "pending-operator-authorization", name: "Reviewer shadow-review calibration experiment",
  enabled: false, mode: "non_authoritative_read_only", shadowsPerTask: 1, independentProfile: true,
  startsAt: null, endsAt: null, authority: "separate_operator_decision",
  // Eligibility, fixed start and end are defined only when an operator authorizes a named
  // experiment; the disabled default records that deferral explicitly (Spec 011).
  eligibility: "deferred_to_operator_authorization",
  dailyCap: 5, maxSampleRate: 0.1,
});

/**
 * Incident cause families that describe accepted work identity rather than operational
 * delivery. Post-merge incidents with these causes report as semantic; every other
 * normalized family reports as operational.
 */
export const semanticIncidentCauses = ["repository_identity"] as const;
export const isSemanticIncidentCause = (cause: string) => (semanticIncidentCauses as readonly string[]).includes(cause);

/**
 * Reviewer calibration facts. Every signal carries its underlying counts, and rates are
 * computed only over verdicts whose exact-head and reviewer-identity edges are proven.
 * Rows stay counts only: they are calibration evidence, never reviewer scores or causal
 * claims, and reviewer dimensions are kept separate from worker routing dimensions.
 */
export const reviewerCalibrationRowSchema = z.object({
  key: z.string(), label: z.string(),
  provider: z.string().nullable(), model: z.string().nullable(), profileGroup: z.string().nullable(), agentId: z.string().nullable(),
  verdicts: z.number().int().nonnegative(), approved: z.number().int().nonnegative(), changesRequired: z.number().int().nonnegative(),
  revisionRounds: z.number().int().nonnegative(), resolvedRounds: z.number().int().nonnegative(), preMergeRefusals: z.number().int().nonnegative(),
  postMergeIncidents: z.number().int().nonnegative(),
}).strict();
export type ReviewerCalibrationRow = z.infer<typeof reviewerCalibrationRowSchema>;
export const reviewerCalibrationSchema = z.object({
  verdicts: z.number().int().nonnegative(), approved: z.number().int().nonnegative(), changesRequired: z.number().int().nonnegative(),
  exactVerdicts: z.number().int().nonnegative(), partialVerdicts: z.number().int().nonnegative(), exactApproved: z.number().int().nonnegative(),
  revisionRounds: z.number().int().nonnegative(), partialRevisionRounds: z.number().int().nonnegative(),
  resolvedRounds: z.number().int().nonnegative(), preMergeRefusals: z.number().int().nonnegative(),
  postMergeIncidents: z.number().int().nonnegative(), postMergeSemanticIncidents: z.number().int().nonnegative(), postMergeOperationalIncidents: z.number().int().nonnegative(),
  revisionReturnRate: z.number().min(0).max(1).nullable(), resolutionRate: z.number().min(0).max(1).nullable(), refusalRate: z.number().min(0).max(1).nullable(),
  reviewers: z.array(reviewerCalibrationRowSchema),
  omittedReviewers: z.number().int().nonnegative().default(0),
  evidence: z.enum(["exact", "mixed", "partial"]),
}).strict();
export type ReviewerCalibration = z.infer<typeof reviewerCalibrationSchema>;
export const emptyReviewerCalibration: ReviewerCalibration = {
  verdicts: 0, approved: 0, changesRequired: 0, exactVerdicts: 0, partialVerdicts: 0, exactApproved: 0,
  revisionRounds: 0, partialRevisionRounds: 0, resolvedRounds: 0, preMergeRefusals: 0,
  postMergeIncidents: 0, postMergeSemanticIncidents: 0, postMergeOperationalIncidents: 0,
  revisionReturnRate: null, resolutionRate: null, refusalRate: null, reviewers: [], omittedReviewers: 0, evidence: "partial",
};

const distributionSchema = z.object({
  count: z.number().int().nonnegative(), partialCount: z.number().int().nonnegative(),
  p50Ms: z.number().nonnegative().nullable(), p95Ms: z.number().nonnegative().nullable(),
}).strict();
/**
 * Queue host-scheduler telemetry for project validations: queue wait, wall and
 * CPU reported separately, never folded into run time. Each
 * distribution counts validations with a recorded value; `partialCount` counts
 * validations where that value was unavailable, including older rows without
 * scheduler telemetry, and null percentiles mean no validation recorded it.
 */
export const qaValidationAdmissionSchema = z.object({
  /** Settled project validations observed in this group. */
  validations: z.number().int().nonnegative(),
  queueWaitMs: distributionSchema, wallMs: distributionSchema, cpuMs: distributionSchema,
  /** Typed capacity holds: lapsed Queue scheduler deadlines, never validation failures. */
  capacityUnavailable: z.number().int().nonnegative(),
}).strict();
export type QaValidationAdmission = z.infer<typeof qaValidationAdmissionSchema>;
export const emptyQaValidationAdmission: QaValidationAdmission = {
  validations: 0,
  queueWaitMs: { count: 0, partialCount: 0, p50Ms: null, p95Ms: null },
  wallMs: { count: 0, partialCount: 0, p50Ms: null, p95Ms: null },
  cpuMs: { count: 0, partialCount: 0, p50Ms: null, p95Ms: null },
  capacityUnavailable: 0,
};
export const telemetryStageAggregateSchema = distributionSchema.extend({
  stage: telemetryStageKeySchema, category: telemetryStageCategorySchema, supplemental: z.boolean().default(false),
}).strict();
export const telemetryGroupSchema = z.object({
  key: z.string(), label: z.string(), taskCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(), completionRate: z.number().min(0).max(1).nullable(),
  interventionTaskCount: z.number().int().nonnegative(), interventionRate: z.number().min(0).max(1).nullable(),
  total: distributionSchema, waiting: distributionSchema, active: distributionSchema,
  stages: z.array(telemetryStageAggregateSchema), interventions: interventionSchema,
  headline: telemetryHeadlineSchema.default(emptyTelemetryHeadline),
  closeoutAuthorities: z.object({ repositoryHook: z.number().int().nonnegative(), agent: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), none: z.number().int().nonnegative() }).strict(),
  qaAdmission: qaValidationAdmissionSchema.default(emptyQaValidationAdmission),
  evidence: z.enum(["exact", "mixed", "partial"]),
  reviewerCalibration: reviewerCalibrationSchema.default(emptyReviewerCalibration),
}).strict();
export const telemetryFilterSchema = z.object({
  repoPath: z.string().optional(), scope: z.enum(["general", "mechanical", "complex"]).optional(),
  profileGroup: z.string().optional(), window: z.enum(["24h", "7d", "30d", "90d", "all"]).default("30d"),
  createdAfter: z.string().datetime({offset:true}).optional(),
  interventionRole: z.enum(["worker", "reviewer", "coordinator", "closeout", "unknown"]).optional(),
  interventionProvider: z.string().optional(),
  closeoutAuthority: closeoutAuthoritySchema.optional(),
  reviewerProvider: z.string().optional(), reviewerProfile: z.string().optional(), reviewerProfileGroup: z.string().optional(),
  groupBy: z.enum(["none", "repository", "scope", "profile_group", "closeout_authority"]).default("none"),
}).strict();
/**
 * Bounded Paseo admission evidence (Contract 007, Spec 013 "Incremental
 * reconciliation"). Queue records what it asked Paseo for, how long each class
 * waited and whether degraded-state backpressure is holding new work. The
 * numbers describe Queue's own outbound load; they never assert Paseo health.
 */
export const admissionClasses = ["callback", "control", "observation", "title", "cleanup", "inventory", "workspace"] as const;
export const admissionClassSchema = z.enum(admissionClasses);
export type AdmissionClass = (typeof admissionClasses)[number];
const admissionClassStateFields = {
  limit: z.number().int().positive(), running: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), coalesced: z.number().int().nonnegative(),
};
const admissionLatencyFields = {
  samples: z.number().int().nonnegative(), p50Ms: z.number().nonnegative().nullable(),
  p95Ms: z.number().nonnegative().nullable(), maxMs: z.number().nonnegative().nullable(),
};
export const admissionClassStateSchema = z.object(admissionClassStateFields).strict();
export const admissionLatencySchema = z.object(admissionLatencyFields).strict();
export const paseoAdmissionSchema = z.object({
  callback: admissionClassStateSchema, control: admissionClassStateSchema, observation: admissionClassStateSchema,
  title: admissionClassStateSchema, cleanup: admissionClassStateSchema, inventory: admissionClassStateSchema, workspace: admissionClassStateSchema,
  latency: z.object({
    callback: admissionLatencySchema, control: admissionLatencySchema, observation: admissionLatencySchema,
    title: admissionLatencySchema, cleanup: admissionLatencySchema, inventory: admissionLatencySchema, workspace: admissionLatencySchema,
  }).strict(),
  observationCacheEntries: z.number().int().nonnegative(), observationCacheHits: z.number().int().nonnegative(),
  workspaceBudget: z.number().int().nonnegative(), workspaces: z.number().int().nonnegative(), workspaceDeferrals: z.number().int().nonnegative(),
  lifecycleSignals: z.number().int().nonnegative(),
  backpressure: z.object({
    degraded: z.boolean(), since: z.string().nullable(), reason: z.string(), warning: z.string(),
    healthySamples: z.number().int().nonnegative(), thresholdMs: z.number().nonnegative(),
  }).strict(),
}).strict();
export type PaseoAdmission = z.infer<typeof paseoAdmissionSchema>;
export const emptyAdmissionLatency = { samples: 0, p50Ms: null, p95Ms: null, maxMs: null };
const emptyAdmissionClass = { limit: 1, running: 0, waiting: 0, completed: 0, coalesced: 0 };
export const emptyPaseoAdmission: PaseoAdmission = {
  callback: { ...emptyAdmissionClass }, control: { ...emptyAdmissionClass }, observation: { ...emptyAdmissionClass },
  title: { ...emptyAdmissionClass }, cleanup: { ...emptyAdmissionClass }, inventory: { ...emptyAdmissionClass }, workspace: { ...emptyAdmissionClass },
  latency: { callback: { ...emptyAdmissionLatency }, control: { ...emptyAdmissionLatency }, observation: { ...emptyAdmissionLatency },
    title: { ...emptyAdmissionLatency }, cleanup: { ...emptyAdmissionLatency }, inventory: { ...emptyAdmissionLatency }, workspace: { ...emptyAdmissionLatency } },
  observationCacheEntries: 0, observationCacheHits: 0, workspaceBudget: 0, workspaces: 0, workspaceDeferrals: 0, lifecycleSignals: 0,
  backpressure: { degraded: false, since: null, reason: "", warning: "", healthySamples: 0, thresholdMs: 0 },
};

/** Durable cursor evidence for the bounded safety sweep (Spec 013). */
export const reconciliationSweepSchema = z.object({
  cursor: z.string().nullable(), swept: z.number().int().nonnegative(), tasks: z.number().int().nonnegative(),
  dirty: z.boolean(), passes: z.number().int().nonnegative(), lastPassAt: z.string().nullable(),
}).strict();
export type ReconciliationSweep = z.infer<typeof reconciliationSweepSchema>;
export const emptyReconciliationSweep: ReconciliationSweep = {
  cursor: null, swept: 0, tasks: 0, dirty: false, passes: 0, lastPassAt: null,
};

/** Round 4: applied and refused task controls by source, from Queue's 30-day outcome record. */
const controlRateSchema = z.object({
  applied: z.number().int().nonnegative(), refused: z.number().int().nonnegative(), refusalRate: z.number().min(0).max(1).nullable(),
}).strict();
export const taskControlTelemetrySchema = z.object({
  windowDays: z.number().nonnegative(), owner: controlRateSchema, coordinator: controlRateSchema,
  byAction: z.array(z.object({ source: z.enum(["owner", "coordinator"]), action: z.string(), applied: z.number().int().nonnegative(), refused: z.number().int().nonnegative() }).strict()),
  topRefusals: z.array(z.object({ source: z.enum(["owner", "coordinator"]), action: z.string(), reason: z.string(), count: z.number().int().positive() }).strict()),
}).strict();
export type TaskControlTelemetry = z.infer<typeof taskControlTelemetrySchema>;
const emptyControlRate = { applied: 0, refused: 0, refusalRate: null };
export const emptyTaskControlTelemetry: TaskControlTelemetry = { windowDays: 0, owner: emptyControlRate, coordinator: emptyControlRate, byAction: [], topRefusals: [] };

export const telemetrySnapshotSchema = z.object({
  generatedAt: z.string(), filters: telemetryFilterSchema,
  matchingTasks: z.number().int().nonnegative(), groups: z.array(telemetryGroupSchema),
  omittedGroups: z.number().int().nonnegative().default(0), truncatedDimensions: z.array(z.string()).default([]),
  repositories: z.array(z.string()), scopes: z.array(z.string()), profileGroups: z.array(z.string()), interventionProviders: z.array(z.string()),
  reviewerProviders: z.array(z.string()).default([]), reviewerProfiles: z.array(z.string()).default([]), reviewerProfileGroups: z.array(z.string()).default([]),
  shadowPlan: shadowReviewPlanSchema.default(disabledShadowReviewPlan),
  admission: paseoAdmissionSchema.default(emptyPaseoAdmission),
  reconciliation: reconciliationSweepSchema.default(emptyReconciliationSweep),
  controls: taskControlTelemetrySchema.default(emptyTaskControlTelemetry),
  /** Spec 058 slice 1: finished tasks' usage percentiles per complexity, over the matching tasks. */
  usageByComplexity: z.array(usageComplexitySchema).default([]),
}).strict();
export type TelemetrySnapshot = z.infer<typeof telemetrySnapshotSchema>;

export const STAGE_META: Record<TelemetryStageKey, { label: string; category: z.infer<typeof telemetryStageCategorySchema> }> = {
  prerequisite_wait: { label: "Prerequisites", category: "waiting" },
  held_wait: { label: "Held", category: "waiting" },
  capacity_wait: { label: "Capacity", category: "waiting" },
  creation: { label: "Workspace and agent creation", category: "active" },
  worker_active: { label: "Worker active", category: "active" },
  worker_release_wait: { label: "Worker release wait", category: "waiting" },
  review_wait: { label: "Review wait", category: "waiting" },
  planner_acceptance_wait: { label: "Planner acceptance", category: "waiting" },
  review: { label: "Review", category: "active" },
  verification: { label: "Verification", category: "active" },
  merge: { label: "Merge", category: "active" },
  synchronization: { label: "Synchronization", category: "active" },
  closeout: { label: "Closeout", category: "active" },
  repository_hook: { label: "Repository hooks", category: "active" },
  attention: { label: "Attention and recovery", category: "intervention" },
  complete: { label: "Complete", category: "terminal" },
  cancelled: { label: "Cancelled", category: "terminal" },
};

/** Current mutually-exclusive lifecycle stage. Persist its changes as generic event facts. */
export function telemetryStageForTask(task: Task): TelemetryStageKey {
  if (task.phase === "done") return "complete";
  if (task.phase === "cancelled") return "cancelled";
  if (task.held) return "held_wait";
  if (task.phase === "queued") return task.reason.startsWith("Waiting for prerequisites:") ? "prerequisite_wait" : "capacity_wait";
  if (task.phase === "dispatching") return "creation";
  if (task.phase === "working") return task.completion ? "worker_release_wait" : "worker_active";
  if (task.phase === "awaiting_review") return "review_wait";
  if (task.phase === "report_ready") return "planner_acceptance_wait";
  if (task.phase === "reviewing") return "review";
  if (task.phase === "changes_requested") return "worker_active";
  if (task.phase === "verifying") return "verification";
  if (task.phase === "merging") return "merge";
  if (task.phase === "syncing") return "synchronization";
  if (task.phase === "closing") return "closeout";
  return "attention";
}

export function formatTelemetryDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(ms < 10_800_000 ? 1 : 0)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

export function compactTelemetrySummary(telemetry: TaskTelemetry) {
  const i = telemetry.interventions;
  const interventions = i.recoveryRuns + i.uncertainCreations + i.absentCreations + i.attentionNotices
    + i.escalations + i.hookHolds + i.hookRetries + i.automaticHookReplays + i.revisions + i.replacements
    + i.operatorActions.reduce((sum, action) => sum + action.count, 0);
  return {
    metrics: [
      { label: "Total", value: formatTelemetryDuration(telemetry.totalElapsedMs) },
      { label: "Waiting", value: formatTelemetryDuration(telemetry.waitingMs) },
      { label: "Active", value: formatTelemetryDuration(telemetry.activeMs) },
      { label: "Current", value: `${STAGE_META[telemetry.currentStage].label} · ${formatTelemetryDuration(telemetry.currentStageAgeMs)}` },
      { label: "Closeout", value: ({ repository_hook: "Repository hook", agent: "Agent", pending: "Pending", none: "Unavailable history" } as const)[telemetry.closeoutAuthority] },
      { label: "Interventions", value: String(interventions) },
    ],
    evidence: telemetry.evidence === "exact" ? "Exact transition evidence"
      : telemetry.evidence === "mixed" ? "Mixed evidence: recent transitions are exact; earlier timing is reconstructed"
      : "Partial historical timing reconstructed from durable events",
    usage: usageSummary(telemetry.usage),
  };
}

export function formatTokenCount(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(Math.round(tokens));
}

/**
 * Spec 058 slice 1 display: the task total and one line per role that ran. A provider
 * that reported no tokens shows its turns and wall time, never a token figure.
 */
function usageSummary(usage: TaskUsage | undefined) {
  if (!usage || usage.evidence === "none") {
    return { evidence: "No usage reported by the provider", total: "Not reported", lines: [] as string[] };
  }
  const describe = (totals: UsageTotals) => {
    const tokens = totals.reportedTurns > 0 ? `${formatTokenCount(totals.effectiveTokens)} effective` : "tokens not reported";
    return `${tokens} · ${totals.turns} ${totals.turns === 1 ? "turn" : "turns"} · wall ${formatTelemetryDuration(totals.wallMs)}`;
  };
  const lines = USAGE_ROLES.filter(role => usage.byRole[role].turns > 0)
    .map(role => `${role[0].toUpperCase()}${role.slice(1)} · ${describe(usage.byRole[role])}`);
  return {
    evidence: usage.evidence === "exact" ? "Usage observed on every run's agent stream" : "Partial usage: a gap Nucleus could not observe is excluded",
    total: describe(usage.total),
    lines,
  };
}
