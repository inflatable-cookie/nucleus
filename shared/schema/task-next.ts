import { z } from "zod";
import { taskPhaseSchema } from "./task-primitives";
import { routingPolicySchema } from "./settings";
import { worktreeLinksSchema } from "./workspace";
import { resolutionSchema } from "./resolution";
import { taskSchema } from "./tasks";
import { runSchema } from "./runs";
import { taskStopKindSchema, taskStopReasonSchema, taskStopVerbSchema } from "../task-stop";

/** Spec 050: one run an owner can act on, as `task.next` reports it. */
export const taskNextRunSchema = z.object({
  // `worker` is the initial worker binding on the task row: it has no Run record.
  runId: z.string(), role: z.union([runSchema.shape.role, z.literal("worker")]), agentId: z.string().nullable(),
  profileId: z.string().nullable(), profileName: z.string().nullable(),
  status: runSchema.shape.status, released: z.boolean(),
  lastActivity: z.string().nullable(), summary: z.string().nullable(),
}).strict();

export type TaskNextRun = z.infer<typeof taskNextRunSchema>;

/** Spec 050: one registered owner verb as `task.next` reports it. */
export const taskNextVerbSchema = z.object({
  verb: z.string(),
  /** The `queue.task` action this verb maps to until a native verb replaces it. */
  action: z.string(),
  available: z.boolean(),
  /** Copy-ready arguments with every derived identity filled in. */
  args: z.record(z.string(), z.unknown()).optional(),
  /** Alternative planner/operator override for this control. */
  forceArgs: z.record(z.string(), z.unknown()).optional(),
  forceFill: z.array(z.string()).optional(),
  /** Owner-supplied free-text fields to add to `args` before calling. */
  fill: z.array(z.string()).optional(),
  /**
   * Optional owner-supplied fields that qualify the verb as a whole: supply all of
   * them or none. None applies the verb ordinarily; all of them name the qualified
   * disposition the verb records (a descendant external-merge closeout's
   * qualification and exact final head).
   */
  qualifyingFill: z.array(z.string()).optional(),
  /** The plain reason the verb does not apply to this task now. */
  refusal: z.string().optional(),
  /** One honest sentence beside an available verb: the evidence it lacks or the disposition it records. */
  note: z.string().optional(),
}).strict().refine(verb => verb.available === Boolean(verb.args), {
  message: "An available verb carries prefilled args; a refused one names its refusal",
});

export type TaskNextVerb = z.infer<typeof taskNextVerbSchema>;

/**
 * Spec 050: the task's current review outcome and the decision it leaves. One
 * derivation from the task's own records, shared by `task.next`, the recovery
 * launch snapshot and an authenticated refresh. It is observation: never review,
 * merge or execution authority, and applying a report still re-derives it.
 */
const taskNextReviewImpedimentSchema = z.object({
  status: z.enum(["blocked", "error"]), head: z.string().nullable(), currentHead: z.boolean(),
  runId: z.string(), eventId: z.string(), responsibility: z.string().nullable(),
  summary: z.string(), reviewText: z.string().nullable(),
  retained: z.boolean(), current: z.boolean(),
}).strict();

export const taskNextReviewOutcomeSchema = z.object({
  /** The newest verdict Queue applied, proved by its own `review_result_applied` event. */
  accepted: z.object({
    status: z.enum(["ready_to_merge", "changes_required"]),
    head: z.string().nullable(),
    /** False once the PR head moved: history for that head, never evidence for the new one. */
    currentHead: z.boolean(),
    /** True when the task row no longer holds it as the current accepted review (a fresh-review move, an author return, a revision resume): applied history, never merge authority. */
    superseded: z.boolean(),
    runId: z.string(),
    eventId: z.string(),
    reviewerAgentId: z.string().nullable(),
    /** The published review or comment id, or null when the verdict carries no publication evidence. */
    reviewId: z.number().int().positive().nullable(),
    published: z.boolean(),
    summary: z.string().nullable(),
  }).strict().nullable(),
  /** A reviewer result recorded on a run the task never applied: a report, never the accepted verdict. */
  reported: z.object({
    status: z.enum(["ready_to_merge", "changes_required"]),
    head: z.string().nullable(),
    runId: z.string(),
    eventId: z.string(),
    reviewerAgentId: z.string().nullable(),
    published: z.boolean(),
    summary: z.string().nullable(),
  }).strict().nullable(),
  /** A completed non-verdict, with its actual retention state, never review or merge credit. */
  impediment: taskNextReviewImpedimentSchema.nullable(),
  /** Completed reviewer impediments in run order; history is not acceptance. */
  impediments: z.array(taskNextReviewImpedimentSchema),
  /** The reviewer run that holds the current head with no verdict yet, when one is actually live. */
  reader: z.object({ runId: z.string(), agentId: z.string().nullable(), head: z.string().nullable(), checkpoint: z.number().int().positive().nullable() }).strict().nullable(),
  /**
   * The author's latest recorded result. `afterApplied` is true when no applied
   * verdict is recorded or this result comes after the newest applied one: when
   * it is `ready_for_review` at the current head, the applied findings are
   * history and this result is what the outstanding review covers, not another
   * author revision.
   */
  authorResult: z.object({
    runId: z.string().nullable(),
    status: z.string(),
    head: z.string().nullable(),
    currentHead: z.boolean(),
    afterApplied: z.boolean(),
    eventId: z.string(),
    summary: z.string().nullable(),
  }).strict().nullable(),
  /** The decision still outstanding, in plain words, from the same facts. */
  decision: z.string(),
  /** The author revision allowance charged to this work; an exhausted allowance is an owner disposition, never another review. */
  revision: z.object({ runs: z.number().int().nonnegative(), budget: z.number().int().positive(), exhausted: z.boolean() }).strict(),
}).strict();

export type TaskNextReviewOutcome = z.infer<typeof taskNextReviewOutcomeSchema>;

export const taskNextStopSchema = z.object({
  kind: taskStopKindSchema,
  reason: taskStopReasonSchema,
  detail: z.string(),
  since: z.string(),
  suggestedVerbs: z.array(taskStopVerbSchema),
  owner: z.string().nullable(),
  evidence: z.string().nullable(),
}).strict();

export type TaskNextStop = z.infer<typeof taskNextStopSchema>;

const taskNextFenceSchema = z.object({ owner: z.string(), reason: z.string(), since: z.string() }).strict();

/**
 * Papercut 8fffbf59: a retained reviewer was swapped without which eligibility
 * condition failed. Observation only; the swap event carries the same reason.
 */
const taskNextReviewerSwapSchema = z.object({
  fromAgentId: z.string().nullable(),
  condition: z.enum(['round', 'participant', 'runtime', 'context', 'error']),
  detail: z.string(),
  head: z.string().nullable(),
  at: z.string(),
}).strict();

/** Spec 050 read verb: what an owner reads before steering one stuck task. */
export const taskNextInputSchema = z.object({
  caller: z.literal("operator (board)").optional(),
  taskId: z.string().min(1).max(160).optional(),
  reference: z.string().trim().min(1).max(200).optional(),
}).strict().superRefine((input, ctx) => {
  if (Number(input.taskId !== undefined) + Number(input.reference !== undefined) !== 1)
    ctx.addIssue({ code: "custom", path: ["taskId"], message: "Pass exactly one of taskId or reference" });
});

export type TaskNextInput = z.infer<typeof taskNextInputSchema>;

/** Spec 050: the task's worker retirement count and replacement ceiling. */
const taskNextReplacementSchema = z.object({
  retirements: z.number().int().nonnegative(),
  ceiling: z.number().int().positive(),
  /** True once the ordinary ceiling is reached. */
  ceilingReached: z.boolean(),
}).strict();

export const taskNextSchema = z.object({
  critical: z.boolean().default(false),
  criticalReviewFallbacks: resolutionSchema.shape.criticalReviewFallbacks,
  taskId: z.string(), title: z.string(), phase: taskPhaseSchema, version: z.number().int().positive(),
  paused: z.boolean().default(false), dispatchHeld: z.boolean().default(false),
  repository: z.string().nullable(), number: z.number().nullable(), reference: z.string().nullable(),
  attention: z.boolean(), reason: z.string(),
  /**
   * Spec 050: the worker retirement count and ordinary ceiling. Observation
   * only; it is re-derived at apply time.
   */
  replacement: taskNextReplacementSchema.optional(),
  activeRun: taskNextRunSchema.nullable(),
  prHead: z.string().nullable(), prUrl: z.string().nullable(), branch: z.string(),
  stop: taskNextStopSchema.nullable(),
  /** Spec 050: the current review outcome, its exact source and the decision still outstanding. */
  outcome: taskNextReviewOutcomeSchema,
  holds: z.object({ dispatch: taskNextFenceSchema.optional(), merge: taskNextFenceSchema.optional() }).strict(),
  verbs: z.array(taskNextVerbSchema),
  /** Spec 052: the usage policy for the profiles this task's routing names, read fresh. */
  routingPolicy: routingPolicySchema.optional(),
  /** Durable worker exclusions, lifted by an owner route to the profile. */
  workerExclusions: taskSchema.shape.workerExclusions.optional(),
  /** Task 645: the durable owner no-automatic-retry rule and the control that recorded it. */
  noAutomaticRetry: z.boolean().optional(),
  noAutomaticRetryProvenance: z.string().nullable().optional(),
  /** Papercut 8fffbf59: the newest retained-reviewer swap and the condition that failed. */
  reviewerSwap: taskNextReviewerSwapSchema.nullable().optional(),
  /** Task 662: present when the owner retired the spent author-side proof declaration. */
  proofExecutionRetired: z.literal(true).optional(),
  workerDemandStep: z.string().optional(),
  /** The checkout's links-only provisioning record, when it has one. */
  worktreeLinks: worktreeLinksSchema.optional(),
  /** Pinned host for this task. Switching a repository hostKind never rehosts it. */
  host: z.string().optional(),
}).strict();

export type TaskNext = z.infer<typeof taskNextSchema>;
