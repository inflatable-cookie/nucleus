import type { Notice, Run, Task } from "../../shared/contracts";
import type { HookRecord } from "../../shared/hooks";
import {
  RETAINED_TELEMETRY_VERSION, STAGE_META, retainedTaskTelemetrySchema,
  type RetainedTaskTelemetry, type TaskTelemetry, type TaskUsage,
} from "../../shared/telemetry";
import { deriveTaskTelemetry, type QueueEvent } from "./task-facts";
import { reviewerCalibrationFacts, type ReviewerCalibrationFacts } from "./reviewer-calibration";

/** The task facts the aggregate filters, groups and counts by. Nothing else of a task is read. */
export interface TelemetryTaskFacts {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  phase: string;
  repoPath: string;
  scope: string;
  profileGroup?: string | null;
  complexity?: string | null;
}

/** The measured lifecycle facts the aggregate reads from one task's derivation. */
export type TelemetryMeasures = Pick<TaskTelemetry,
  "evidence" | "totalElapsedMs" | "waitingMs" | "activeMs" | "interventionMs" | "closeoutAuthority" | "stages" | "interventions">
  & { usage?: Pick<TaskUsage, "evidence" | "total"> };

/** One settled project validation's scheduler measures; unavailable values stay null, never zero. */
export interface QaValidationSample {
  queueWaitMs: number | null;
  wallMs: number | null;
  cpuMs: number | null;
  capacityUnavailable: boolean;
}

/**
 * One task's single contribution to the aggregate, from live detailed history or from its
 * retained compact record once that history is purged. The aggregate reads only these
 * fields, so both sources go through the same filters, groups and percentiles.
 */
export interface TelemetryBaseItem {
  task: TelemetryTaskFacts;
  telemetry: TelemetryMeasures;
  reviewer: ReviewerCalibrationFacts;
  qaValidation: QaValidationSample | null;
  /** Providers named by the task's own profile and its runs, for the intervention-provider dictionary. */
  providers: string[];
  /** True when this contribution comes from a retained record after detail purge. */
  retained: boolean;
  /** Retained verdicts whose only attribution was an agent identity the record does not keep. */
  reviewerAttributionUnavailable: number;
}

export interface TaskTelemetryFacts {
  task: Task;
  events: QueueEvent[];
  runs: Run[];
  notices: Notice[];
  hooks: HookRecord[];
}

function qaValidationSample(task: Task): QaValidationSample | null {
  const validation = task.resolution.projectValidation;
  if (!validation || validation.state === "running") return null;
  const record = validation.hostRunTelemetry, legacy = validation.admission;
  const number = (value: number | null | undefined) => typeof value === "number" ? value : null;
  const cpuMs = record?.cpuMs ?? (legacy?.cpuUserMs != null || legacy?.cpuSystemMs != null
    ? (legacy?.cpuUserMs ?? 0) + (legacy?.cpuSystemMs ?? 0) : null);
  return {
    queueWaitMs: number(record?.queueWaitMs ?? legacy?.queueWaitMs),
    wallMs: number(record?.wallMs ?? legacy?.wallMs),
    cpuMs: number(cpuMs),
    capacityUnavailable: Boolean(validation.capacityUnavailable),
  };
}

/** Derive one live task's contribution from its detailed history. */
export function liveTelemetryItem(facts: TaskTelemetryFacts, generatedAt: Date): TelemetryBaseItem {
  const { task, events, runs } = facts;
  const providers = new Set<string>();
  if (task.profile?.provider) providers.add(task.profile.provider);
  for (const run of runs) if (run.profile?.provider) providers.add(run.profile.provider);
  return {
    task: {
      id: task.id, createdAt: task.createdAt, finishedAt: task.finishedAt ?? null, phase: task.phase,
      repoPath: task.repoPath, scope: task.scope, profileGroup: task.profileGroup ?? null, complexity: task.complexity ?? null,
    },
    telemetry: deriveTaskTelemetry(task, events, runs, facts.notices, facts.hooks, generatedAt),
    reviewer: reviewerCalibrationFacts(task, events, runs),
    qaValidation: qaValidationSample(task),
    providers: [...providers].sort(),
    retained: false,
    reviewerAttributionUnavailable: 0,
  };
}

/**
 * Project one live contribution into the version-1 retained record. Only aggregate inputs
 * are copied: no titles, briefs, messages, raw events, run, thread or workspace identity.
 * A reviewer verdict whose visible attribution was its agent identity is marked
 * `unavailable`; one whose row identity cannot be kept without it leaves the exact cohort.
 */
export function retainedTelemetryRecord(item: TelemetryBaseItem, capturedAt: Date): RetainedTaskTelemetry {
  const { task, telemetry, reviewer } = item;
  return retainedTaskTelemetrySchema.parse({
    version: RETAINED_TELEMETRY_VERSION,
    taskId: task.id, createdAt: task.createdAt, finishedAt: task.finishedAt, capturedAt: capturedAt.toISOString(),
    outcome: { phase: task.phase },
    dimensions: { repoPath: task.repoPath, scope: task.scope, profileGroup: task.profileGroup ?? null, complexity: task.complexity ?? null, providers: item.providers },
    measures: {
      evidence: telemetry.evidence, totalElapsedMs: telemetry.totalElapsedMs, waitingMs: telemetry.waitingMs,
      activeMs: telemetry.activeMs, interventionMs: telemetry.interventionMs, closeoutAuthority: telemetry.closeoutAuthority,
      stages: telemetry.stages.map(stage => ({ stage: stage.stage, elapsedMs: stage.elapsedMs, partial: stage.partial })),
      usage: telemetry.usage ? { evidence: telemetry.usage.evidence, total: telemetry.usage.total } : null,
    },
    interventions: telemetry.interventions,
    reviewer: {
      verdicts: reviewer.verdicts.map(verdict => {
        const identity = verdict.reviewer;
        const unavailable = Boolean(identity.agentId) && !identity.profileName;
        const keyLost = Boolean(identity.agentId) && !identity.profileId;
        return {
          at: verdict.at, verdict: verdict.verdict, exact: verdict.exact && !keyLost,
          attribution: unavailable ? "unavailable" : identity.profileId || identity.profileName ? "profile" : "none",
          reviewer: { profileId: identity.profileId, profileName: identity.profileName, provider: identity.provider, model: identity.model, profileGroup: identity.profileGroup },
        };
      }),
      rounds: reviewer.rounds.map(round => ({ at: round.at, kind: round.kind, partial: round.partial, verdictIndex: round.verdictIndex })),
      refusals: reviewer.refusals.map(refusal => ({ at: refusal.at, verdictIndex: refusal.verdictIndex })),
      postMergeIncidents: reviewer.postMergeIncidents.map(incident => ({ at: incident.at, cause: incident.cause, semantic: incident.semantic, verdictIndex: incident.verdictIndex })),
    },
    qaValidation: item.qaValidation,
  });
}

/** Capture one task's retained record from the same facts the live base derives from. */
export function captureRetainedTelemetry(facts: TaskTelemetryFacts, at: Date): RetainedTaskTelemetry {
  return retainedTelemetryRecord(liveTelemetryItem(facts, at), at);
}

/**
 * Restore a retained record as the same contribution the live derivation gave. Verdict
 * identities are synthetic and task-qualified, so distinct-verdict rates still count each
 * verdict once; agent identity is never restored.
 */
export function retainedTelemetryItem(record: RetainedTaskTelemetry): TelemetryBaseItem {
  const { taskId } = record;
  return {
    task: {
      id: taskId, createdAt: record.createdAt, finishedAt: record.finishedAt, phase: record.outcome.phase,
      repoPath: record.dimensions.repoPath, scope: record.dimensions.scope,
      profileGroup: record.dimensions.profileGroup, complexity: record.dimensions.complexity,
    },
    telemetry: {
      evidence: record.measures.evidence, totalElapsedMs: record.measures.totalElapsedMs, waitingMs: record.measures.waitingMs,
      activeMs: record.measures.activeMs, interventionMs: record.measures.interventionMs, closeoutAuthority: record.measures.closeoutAuthority,
      stages: record.measures.stages.map(stage => ({ ...stage, category: STAGE_META[stage.stage].category, supplemental: stage.stage === "repository_hook" })),
      interventions: record.interventions,
      ...(record.measures.usage ? { usage: record.measures.usage } : {}),
    },
    reviewer: {
      verdicts: record.reviewer.verdicts.map((verdict, index) => ({
        at: verdict.at, runId: `retained:${taskId}:verdict:${index}`, head: "", verdict: verdict.verdict, exact: verdict.exact,
        reviewer: { agentId: null, ...verdict.reviewer },
      })),
      rounds: record.reviewer.rounds.map((round, index) => ({ ...round, runId: `retained:${taskId}:round:${index}`, head: "" })),
      refusals: record.reviewer.refusals.map(refusal => ({ ...refusal, runId: null })),
      postMergeIncidents: record.reviewer.postMergeIncidents.map((incident, index) => ({ ...incident, id: `retained:${taskId}:incident:${index}` })),
    },
    qaValidation: record.qaValidation,
    providers: record.dimensions.providers,
    retained: true,
    reviewerAttributionUnavailable: record.reviewer.verdicts.filter(verdict => verdict.attribution === "unavailable").length,
  };
}
