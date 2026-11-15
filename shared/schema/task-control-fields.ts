import { z } from "zod";
import { dependencyIdsSchema, holdKindSchema, laneKeyListSchema, laneKeySchema, taskPhaseSchema } from "../schema/task-primitives";
import { capabilityLevelSchema, routingProfileRequestsSchema, scopeSchema } from "./settings";
import { workDispositionSchema } from "./disposition";
import { BRIEF_MAX_LENGTH, laneDocumentRefSchema } from "./briefs";

/**
 * The control's field bag. It is strict: an unknown key on a control write is refused,
 * never silently stripped. Cross-field rules live in task-control-rules.ts.
 */
export const taskControlFields = <T extends z.ZodType<number | undefined>>(version: T) =>
  z
    .object({
      taskId: z.string(),
      version,
      /** Optional observation fence when the caller names the phase it saw. */
      phase: taskPhaseSchema.optional(),
      action: z.enum([
        "hold",
        "release",
        "keep_hold",
        "cancel",
        "withdraw_cancel",
        "supersede",
        "promote",
        "set_dependencies",
        "set_prerequisite_wait",
        "set_lane",
        "set_routing",
        "exclude_worker",
        "note",
        "amend_brief",
        "complete",
        "move",
        "route",
        "restart",
        "retry_effect",
        "stop",
        "proof",
        "accept_receipt",
        "extend_budget",
      ]),
      workerExclusion: z
        .object({
          agentId: z.string().trim().min(1).max(240).optional(),
          profileId: z.string().trim().min(1).max(160).optional(),
        })
        .strict()
        .optional(),
      reviewer: z
        .object({
          profileId: z.string().trim().min(1),
          reason: z.string().trim().min(1).max(4000),
        })
        .strict()
        .optional(),
      rebindWorkspaceId: z.string().min(1).max(240).optional(),
      instruction: z.string().trim().min(1).max(12000).optional(),
      dependsOn: dependencyIdsSchema.optional(),
      waitsFor: dependencyIdsSchema.optional(),
      reason: z.string().trim().min(1).max(4000).optional(),
      // Spec 046: a self-lifting hold's end condition, a task ID or an offset timestamp.
      until: z.string().trim().min(1).max(200).optional(),
      // Independent fence: dispatch while queued, merge after dispatch, unless named.
      kind: holdKindSchema.optional(),
      // Spec 040: the calling agent, recorded as the hold's owner. Absent means the operator.
      agentId: z.string().trim().min(1).max(240).optional(),
      // Spec 050: the calling agent recorded on the owner_control audit event when a
      // control is applied through the owner verb registry. Record only: its absence
      // keeps the legacy operator control record, and no guard refuses on it.
      caller: z.string().trim().min(1).max(240).optional(),
      note: z.string().trim().min(1).max(4000).optional(),
      message: z.string().trim().min(1).max(4000).optional(),
      relayed: z.boolean().optional(),
      /** Spec 058 (task 540): an answer an agent gave to a delegated question. It needs the answering agent as `caller`, the recorded note, and never `relayed`. */
      delegated: z.boolean().optional(),
      /** Structured standing authority for a delegated budget extension. */
      budgetAuthority: z.literal("approve_by_default").optional(),
      scope: scopeSchema.optional(),
      complexity: capabilityLevelSchema.nullable().optional(),
      critical: z.boolean().optional(),
      preferredProfileId: z.string().optional(),
      requirePreferred: z.boolean().optional(),
      thinkingOptionId: z.string().optional(),
      profileRequests: routingProfileRequestsSchema.optional(),
      replacementTaskId: z.string().min(1).max(160).optional(),
      workDisposition: workDispositionSchema.optional(),
      brief: z.string().min(1).max(BRIEF_MAX_LENGTH).optional(),
      /** Exact decision IDs settled by this planner-authored brief amendment. */
      overtakes: z.array(z.string().min(1).max(160)).max(100).optional(),
      lane: laneKeySchema.nullable().optional(),
      lanes: laneKeyListSchema.optional(),
      /** Spec 048: authenticated CLI thread identity and exact delivered report artifact. */
      /** Legacy move input retained so stored owner-revision operations remain parseable; current moves ignore it. */
      ownerAgentId: z.string().trim().min(1).max(300).optional(),
      /** Spec 050 `move to=review`: bind this open replacement PR on the task branch before review (strict identity reconciliation). */
      prNumber: z.number().int().positive().optional(),
      /** Spec 050: the step an owner `move` sends the task to. */
      to: z.enum(["work", "review", "merge", "closeout"]).optional(),
      /** Spec 050 `retry_effect`: one stable effect key from `task.next`, or every pending effect when omitted and exactly one is recorded. */
      effect: z.string().trim().min(1).max(240).optional(),
      /** Owner override of a named blocking effect or move gate. */
      force: z.boolean().optional(),
      /** Spec 050 `retry_effect`: explicit opt-in to discard unpublished checkout state a held occurrence still pins. */
      discard: z.boolean().optional(),
      /** Spec 050 `route`/`restart`: the role the control acts on. nucleus#1195: `executor` names the proof-execution re-report continuation, which only `restart` accepts. */
      role: z.enum(["worker", "reviewer", "coordinator", "executor"]).optional(),
      /**
       * Spec 050 `move to=merge`: the disclosed qualification an owner acceptance
       * records over the reviewer findings. Task 408: `move to=closeout` takes the
       * same field to record the exact-final-head operator source acceptance of a
       * never-dispatched review-entry task or a dispatched retained-source task
       * whose PR merged outside Queue.
       */
      qualification: z.string().trim().min(1).max(4000).optional(),
      /** Display-only: task.next copies a held or effect summary into prefilled args. The control ignores it; it is named here so it is not refused. */
      summary: z.string().optional(),
      /** Task 645: an owner instruction that forbids (true) or re-permits (false) automatic retry. Only valid for move, restart, route or amend_brief. */
      noAutomaticRetry: z.boolean().optional(),
      /** Spec 050 owner acceptance: the exact PR head named for merge or dispatched external-merge closeout. */
      head: z
        .string()
        .regex(/^[a-f0-9]{40}$/, "head must be a full 40-character commit SHA")
        .optional(),
      /** Spec 050 `route`: the profile the named role's next run uses. */
      profileId: z.string().trim().min(1).max(160).optional(),
      /** Spec 050 `route`: stop and replace the role's live run on the new route. */
      now: z.boolean().optional(),
      /** Spec 050 `restart`: start a fresh agent on the role's current route instead of continuing the retained one. */
      fresh: z.boolean().optional(),
      /** Spec 050 `complete`: the optional exact lane document the owner's completion cites. */
      artifact: laneDocumentRefSchema.optional(),
    })
    .strict();

/** The fields the cross-field rules read: everything but the version fence, whose type the rules never see. */
export type TaskControlFields = Omit<z.infer<ReturnType<typeof taskControlFields>>, "version">;
