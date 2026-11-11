import { hostSelectionSchema } from "../host-selection";
import { z } from "zod";
import { holdKindSchema, taskPhaseSchema } from "../schema/task-primitives";
import { checkpointStateSchema, completionSchema, proofExecutionRecordSchema, proofOnlyResultSchema, proofReceiptAcceptanceSchema, reportAcceptanceSchema, reviewEntryRecordSchema, submissionSchema } from "./review";
import { capabilityLevelSchema, completionCohortMemberSchema, completionRecipientSchema, completionSubscriptionSchema, profileSchema } from "./settings";
import { holdBlockingSchema, holdUntilSchema, retainedPrerequisiteWaitSchema, stashEntrySchema, taskHoldsSchema, workerExclusionSchema } from "./task-holds";
import { checkoutSiblingFindingSchema, pausedStopSchema, siblingFindingSchema, siblingPinSchema, worktreeLinksSchema } from "./workspace";
import { transientProviderRetrySchema } from "./runs";
import { resolutionSchema } from "./resolution";
import { dispositionSchema } from "./disposition";
import { briefVersionSchema, laneDocumentPinSchema, laneDocumentRefSchema } from "./briefs";
import { laneContextSchema } from "./lanes";
import { waitStateViewSchema } from "../wait-state";
import { heavyRunViewSchema } from "../schema/task-view";
import { taskBudgetViewSchema } from "../task-budget";
import { taskTitleSchema } from "./task-common";

/** The completion policy a cohort freeze reads; every field is recorded task history. */
export type CompletionPolicy = Pick<Task,"notifyOriginOnCloseout"|"originWorkspaceId"|"originAgentId"|"creatorCompletionRecipients"|"completionSubscriptionOverrides"> & { notificationAgentId?: string | null };

export const taskSchema = submissionSchema.extend({
  hostSelection: hostSelectionSchema.optional(),
  /** Host that proved the origin thread; missing on unproven legacy records. */
  originHostId: z.string().min(1).optional(),
  /** Source class pinned at admission; later lead edits cannot change slot accounting. */
  papercutTask: z.boolean().default(false),
  repository: z.string().nullable().default(null),
  number: z.number().int().positive().nullable().default(null),
  reference: z.string().nullable().default(null),
  entrypoint:z.enum(["worker","review","proof"]).default("worker"), reviewEntry:reviewEntryRecordSchema.nullable().default(null),
  id: z.string(), hostId: z.string(), createdAt: z.string(), updatedAt: z.string(), version: z.number(),
  originWorkspaceId:z.string().nullable().default(null), notificationAgentId:z.string().nullable().default(null), originError:z.string().default(""), originLookupError:z.string().default(""),
  creatorCompletionRecipients:z.array(completionRecipientSchema).default([]),
  completionSubscriptionOverrides:z.array(completionSubscriptionSchema).default([]),
  completionNotificationCohort:z.array(completionCohortMemberSchema).nullable().default(null),
  removedAt: z.string().nullable().default(null), finishedAt: z.string().nullable().default(null),
  queuePriority: z.number().int().nonnegative().default(0),
  // A retained task can be explicitly parked on prerequisites without changing
  // its worker, PR, lifecycle phase or ordinary task reason. Recording while a
  // run is live is allowed: the wait is visible immediately and takes effect
  // when that run releases, before the next dispatch.
  prerequisiteWait: retainedPrerequisiteWaitSchema.nullable().default(null),
  phase: taskPhaseSchema,
  reason: z.string(), held: z.boolean(),
  /** Spec 058: responsible task budget starts when an old task is converted. */
  budgetSince: z.string().datetime({ offset: true }).nullable().default(null),
  // Spec 040: every hold has an owner (an agent ID, or "operator"), a reason and a start time.
  holdOwner: z.string().nullable().default(null), holdReason: z.string().nullable().default(null), holdAt: z.string().nullable().default(null),
  holdGeneration: z.number().int().nonnegative().default(0),
  holdBlocking: holdBlockingSchema.nullable().default(null),
  // Spec 046: a self-lifting hold names what ends it. Null is an ordinary hold, and
  // older task rows read null without a migration.
  holdUntil: holdUntilSchema.nullable().default(null),
  // Independent dispatch and merge fences. Legacy held/mergeHold/holdOwner fields
  // stay in sync with these; an empty object means no fence.
  holds: taskHoldsSchema.default(() => ({})),
  handoffText: z.string(), planningBase: z.string(),
  // Task version at the last non-observation update; permits a hold across newer observations only.
  lastSubstantiveVersion: z.number().int().positive().optional(),
  workspaceId: z.string().nullable(), directory: z.string().nullable(), branch: z.string(),
  agentId: z.string().nullable(), runId: z.string().nullable(),
  /** Queue-owned temp root for the task row's current author run. */
  temporaryDirectory: z.string().max(2000).optional(), profile: profileSchema.nullable(),
  /** Queue #650: the task's initial worker thread was stopped while Queue was paused (unresolved until it resumes). */
  pausedStop: pausedStopSchema.optional(),
  workspaceIntent: z.boolean(), agentIntent: z.boolean(), lastAgentStatus: z.string().nullable(),
  idleSince: z.string().nullable(), completion: completionSchema.nullable(),
  agentActive: z.boolean().nullable(), lastObservedAt: z.string().nullable(),
  profileGroup: z.string().nullable().default(null),
  failoverReason: z.string().default(""), resumePrNumber: z.number().nullable().default(null),
  transientProviderRetry: transientProviderRetrySchema.optional(),
  /** Spec 050 `restart`: the retained run identity a proven-absent worker creation is restarted under, so the launcher reuses it instead of minting a second run. */
  restartRunId: z.string().nullable().optional(),
  /** The worker replacement this task has armed. Legacy authorizationId rows remain readable. */
  replacementProfile: z.object({profileId:z.string().min(1),reason:z.string().trim().min(1).max(4000),
    authorizationId:z.string().min(1).optional(),
    /** Spec 058 task 577: the arming restart carried an explicit operator-relayed reason, so the sweep may retire on it. */
    operatorRelayed:z.boolean().optional()}).nullable().default(null),
  workerExclusions: z.array(workerExclusionSchema).default([]),
  retiredWorkers: z.array(z.object({agentId:z.string(),runId:z.string(),profile:profileSchema,reason:z.string()})).default([]),
  /** Legacy extra-replacement history went with schema 54 (task 989); the store strips retired copies from stored rows. */
  /** A replacement for a gone author continues the retained workspace: dispatch verifies it as a continuation, preserving its work, though no old agent was retired. */
  continuesWorkspace: z.boolean().optional(),
  workerModel: z.string().nullable().default(null),
  workerModels: z.array(z.string()).default([]),
  resolution: resolutionSchema.default(() => resolutionSchema.parse({})),
  /** Task 405: append-only author-side proof execution evidence; the task allowance is one. */
  proofExecutions: z.array(proofExecutionRecordSchema).default([]),
  /** Task 662: an owner may retire a spent brief proof declaration once; it can never be named again. */
  proofExecutionRetired: z.boolean().default(false),
  proofOnlyResult: proofOnlyResultSchema.nullable().default(null),
  proofReceiptAcceptance: proofReceiptAcceptanceSchema.nullable().default(null),
  checkpoints: checkpointStateSchema.default(() => checkpointStateSchema.parse({})),
  prUrl: z.string().nullable(), prHead: z.string().nullable(), coordinatorGeneration: z.number(),
  // Papercut fa4a53a7: the pre-PR branch reconciliation repeats its open-PR
  // lookup with a backoff stepped in idle-grace multiples and records its event
  // pair only when the outcome changes, so unchanged empty results coalesce
  // onto this stamp (attempt counter and last-checked time) instead of the
  // event log. Null until the first lookup; new worker activity restarts the
  // schedule (attempts 0) but keeps the outcome, so an unchanged result after
  // the restart is still coalesced rather than logged twice.
  prLookup: z.object({
    attempts: z.number().int().nonnegative(),
    lastAt: z.string(),
    // Null while the latest attempt ended without a definitive answer (a failed
    // or ambiguous read); the next definitive outcome is compared against it.
    outcome: z.enum(["empty", "found"]).nullable(),
  }).strict().nullable().default(null),
  disposition: dispositionSchema.nullable().default(null),
  // Brief-mode tasks only: every pinned version, oldest first, and the version each worker run was given.
  briefVersions: z.array(briefVersionSchema).default([]),
  briefRuns: z.array(z.object({ runId: z.string(), version: z.number().int().positive() }).strict()).default([]),
  // Spec 026: linked lane documents as pinned at first dispatch, and what each worker run was given.
  laneDocumentPins: z.array(laneDocumentPinSchema).optional(),
  laneDocumentIssues: z.array(z.string().min(1).max(240)).optional(),
  laneDocumentRuns: z.array(z.object({ runId: z.string(), documents: z.array(laneDocumentRefSchema) }).strict()).optional(),
  /** Explicit project-owner acceptance; separate from authenticated worker callbacks and reviews. */
  reportAcceptance: reportAcceptanceSchema.optional(),
  // Spec 027: sibling context. Pins are recorded at creation; true while creation is in flight.
  siblingPins: z.array(siblingPinSchema).default([]),
  siblingFindings: z.array(siblingFindingSchema).default([]),
  siblingIntent: z.boolean().default(false),
  // Spec 028: worktree-root sibling checkouts Queue did not fast-forward.
  checkoutSiblingFindings: z.array(checkoutSiblingFindingSchema).default([]),
  // Links-only provisioning of a new checkout; absent on tasks bound before it, which never get links.
  worktreeLinks: worktreeLinksSchema.optional(),
  laneContext: z.array(laneContextSchema).default([]),
  // The shared stash list when the current worker or revision run was created,
  // compared at readiness to name a stash that crossed worktrees.
  stashBaseline: z.object({ runId: z.string(), entries: z.array(stashEntrySchema) }).strict().nullable().default(null),
}).strip();

export type Task = z.infer<typeof taskSchema>;

export const taskDetailSchema = taskSchema.extend({ holdKind: holdKindSchema.optional(), waitState: waitStateViewSchema.optional(), heavyRun: heavyRunViewSchema.optional(), budget: taskBudgetViewSchema.optional() });

export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const taskReferenceSchema = taskSchema.pick({id:true,submissionId:true,title:true,phase:true,removedAt:true,held:true}).extend({purgedAt:z.string().nullable().default(null)}).strip();

/**
 * Spec 058 slice 4: any thread registers itself as a responsible task.
 * The caller is the authenticated calling thread, filled and overwritten by the CLI from
 * its Nucleus ticket or host-supplied identity, never a typed name: the schema takes
 * no agent, workspace or branch field, so the worktree binding cannot be
 * steered from input. Complexity sizes the budget; the task is always
 * responsible and creates no planner, owner or coordinator role.
 */
export const taskRegistrationSchema = z.object({
  hostId: z.string().trim().min(1).max(240).optional(),
  title: taskTitleSchema,
  description: z.string().trim().min(1).max(12000),
  complexity: capabilityLevelSchema,
  caller: z.string().min(1).max(240),
}).strict();

export type TaskRegistrationInput = z.infer<typeof taskRegistrationSchema>;

export const taskRegistrationResultSchema = z.object({
  task: taskSchema, workspaceId: z.string(), directory: z.string(), branch: z.string(),
  workerAgentId: z.string(), runId: z.string(), status: z.string(), model: z.string(),
});

export type TaskRegistrationResult = z.infer<typeof taskRegistrationResultSchema>;
