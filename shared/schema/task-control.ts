import { z } from "zod";
import { repoRelativePathSchema } from "../hooks";
import { dependencyIdsSchema, holdKindSchema, laneKeyListSchema, laneKeySchema, taskPhaseSchema } from "../schema/task-primitives";
import { capabilityLevelSchema, routingPolicySchema, routingProfileRequestsSchema, scopeSchema } from "./settings";
import { workDispositionSchema } from "./disposition";
import { BRIEF_MAX_LENGTH, laneDocumentRefSchema } from "./briefs";
import { parseHoldUntil } from "./task-holds";
import { taskSchema } from "./tasks";
import { runSchema } from "./runs";
import { taskStopKindSchema, taskStopReasonSchema, taskStopVerbSchema } from "../task-stop";
import { resolutionSchema } from "./resolution";
import { worktreeLinksSchema } from "./workspace";

export const owningDocumentPathsSchema = z.array(repoRelativePathSchema.refine(path => path.startsWith("docs/") && path.endsWith(".md") && path === path.trim() && !/[\u0000-\u001f\u007f]/.test(path), "Owning-document paths must be normalized Markdown files under docs/"))
    .min(1).max(8).superRefine((paths, ctx) => {
      if (new Set(paths).size !== paths.length) ctx.addIssue({ code: "custom", message: "Owning-document paths must be unique" });
    });

/**
 * Tom 2026-10-12: `set_routing` names the task type `scope` and takes an optional
 * nullable `complexity` for capability-weighted selection. The legacy
 * `capability` spelling is refused on this operator write, never silently
 * accepted or guessed.
 */
const refuseLegacyRoutingCapability = (raw: unknown): unknown => {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "capability" in (raw as Record<string, unknown>))
    throw new Error('Routing task type is "scope"; the legacy "capability" field is refused on routing writes');
  return raw;
};

/** Task controls whose engine paths may carry an operator ruling in `note`. */
export const TASK_CONTROL_RELAYED_NOTE_ACTIONS = [
  "set_routing",
  "route",
  "exclude_worker",
  "move",
  "retry_effect",
  "proof",
  "accept_receipt",
  "restart",
  "extend_budget",
] as const;

const taskControlSchema = <T extends z.ZodType<number | undefined>>(version: T) => z.preprocess(
  refuseLegacyRoutingCapability,
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
      /** Spec 050 `route`/`restart`: the role the control acts on. */
      role: z.enum(["worker", "reviewer", "coordinator"]).optional(),
      /**
       * Spec 050 `move to=merge`: the disclosed qualification an owner acceptance
       * records over the reviewer findings. Task 408: `move to=closeout` takes the
       * same field to record the exact-final-head operator source acceptance of a
       * never-dispatched review-entry task or a dispatched retained-source task
       * whose PR merged outside Queue.
       */
      qualification: z.string().trim().min(1).max(4000).optional(),
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
    .superRefine((input, ctx) => {
      if (input.action === "complete") {
        if (!input.reason)
          ctx.addIssue({
            code: "custom",
            path: ["reason"],
            message: "Completing a task requires the owner's reason",
          });
        if (input.ownerAgentId !== undefined)
          ctx.addIssue({
            code: "custom",
            path: ["ownerAgentId"],
            message:
              "Complete is recorded from the calling thread; owner identity is not a field",
          });
      } else if (input.artifact !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["artifact"],
          message: "An artifact is only valid for complete",
        });
      if (
        input.ownerAgentId !== undefined &&
        input.action !== "complete" &&
        input.action !== "move"
      )
        ctx.addIssue({
          code: "custom",
          path: ["ownerAgentId"],
          message:
            "Owner identity is only valid for a legacy move input",
        });
      if (input.action === "route") {
        // Spec 050 `route`: name one role and the profile its next run uses. The
        // profile checks (catalog, role, scope, thinking option, group availability)
        // run against the live catalog in the engine, not here.
        if (!input.role)
          ctx.addIssue({
            code: "custom",
            path: ["role"],
            message: "route requires a role",
          });
        if (!input.profileId)
          ctx.addIssue({
            code: "custom",
            path: ["profileId"],
            message: "route requires a profile",
          });
        if (!input.reason)
          ctx.addIssue({
            code: "custom",
            path: ["reason"],
            message: "route requires a reason",
          });
      } else if (input.action === "restart") {
        // Spec 050 `restart`: the role and the fresh flag are optional; Queue
        // derives the role from the phase and continues the retained agent unless
        // `fresh` asks for a replacement on the role's current route.
        if (!input.reason)
          ctx.addIssue({
            code: "custom",
            path: ["reason"],
            message: "restart requires a reason",
          });
        if (input.profileId !== undefined)
          ctx.addIssue({
            code: "custom",
            path: ["profileId"],
            message: "A route profile is only valid for route",
          });
        if (input.now !== undefined)
          ctx.addIssue({
            code: "custom",
            path: ["now"],
            message: "A route now flag is only valid for route",
          });
      } else {
        if (input.role !== undefined && input.action !== "stop")
          ctx.addIssue({
            code: "custom",
            path: ["role"],
            message: "A control role is only valid for route, restart or stop",
          });
        if (input.profileId !== undefined)
          ctx.addIssue({
            code: "custom",
            path: ["profileId"],
            message: "A route profile is only valid for route",
          });
        if (input.now !== undefined)
          ctx.addIssue({
            code: "custom",
            path: ["now"],
            message: "A route now flag is only valid for route",
          });
      }
      if (input.fresh !== undefined && !(input.action === "restart" || (input.action === "move" && input.to === "review")))
        ctx.addIssue({
          code: "custom",
          path: ["fresh"],
          message: "A fresh flag is only valid for restart or move to review",
        });
      const routingFields = [
        "critical",
        "scope",
        "complexity",
        "preferredProfileId",
        "requirePreferred",
        "thinkingOptionId",
        "profileRequests",
      ] as const;
      if (input.action === "set_routing") {
        if (!input.reason)
          ctx.addIssue({
            code: "custom",
            path: ["reason"],
            message: "Routing change requires a reason",
          });
        if (input.relayed && !input.note)
          ctx.addIssue({
            code: "custom",
            path: ["note"],
            message:
              "Relayed routing change requires an operator authorization note",
          });
        if (!routingFields.some((field) => input[field] !== undefined))
          ctx.addIssue({
            code: "custom",
            path: ["action"],
            message: "set_routing requires at least one routing field",
          });
      } else if (
        routingFields.some((field) => input[field] !== undefined) &&
        input.action !== "route"
      )
        ctx.addIssue({
          code: "custom",
          path: ["action"],
          message: "Routing fields are only valid for set_routing",
        });
      if (input.action === "exclude_worker") {
        if (
          !input.workerExclusion ||
          Number(Boolean(input.workerExclusion.agentId)) +
            Number(Boolean(input.workerExclusion.profileId)) !==
            1
        )
          ctx.addIssue({
            code: "custom",
            path: ["workerExclusion"],
            message:
              "Worker exclusion requires exactly one agentId or profileId",
          });
        if (!input.reason)
          ctx.addIssue({
            code: "custom",
            path: ["reason"],
            message: "Worker exclusion requires a reason",
          });
        if (input.relayed && !input.note)
          ctx.addIssue({
            code: "custom",
            path: ["note"],
            message:
              "Relayed worker exclusion requires an operator authorization note",
          });
      } else if (input.workerExclusion !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["workerExclusion"],
          message: "A worker exclusion target is only valid for exclude_worker",
        });
      if (input.reviewer !== undefined && input.action !== "move")
        ctx.addIssue({
          code: "custom",
          path: ["reviewer"],
          message: "A reviewer role request is only valid for move",
        });
      const acceptsRelayNote =
        (TASK_CONTROL_RELAYED_NOTE_ACTIONS as readonly string[]).includes(input.action) &&
        (input.action !== "restart" || input.relayed === true || input.delegated === true);
      if (
        !acceptsRelayNote &&
        (input.note !== undefined || input.relayed !== undefined || input.delegated !== undefined)
      )
        ctx.addIssue({
          code: "custom",
          path: ["note"],
          message:
            `Authorization note is only valid for ${TASK_CONTROL_RELAYED_NOTE_ACTIONS.filter(action => action !== "restart").join(", ")}, or a relayed or delegated restart`,
        });
      // Task 405: a relayed proof activation carries the operator ruling that
      // authorises it, exactly as a relayed merge acceptance does.
      if (input.budgetAuthority && (input.action !== "extend_budget" || !input.delegated))
        ctx.addIssue({ code: "custom", path: ["budgetAuthority"], message: "Budget authority is only valid for a delegated budget extension" });
      if (input.delegated && (input.relayed || !input.caller || !input.note))
        ctx.addIssue({ code: "custom", path: ["delegated"], message: "A delegated answer names the answering agent as caller and records its note, and is never relayed" });
      if (input.action === "proof" && input.relayed && !input.note)
        ctx.addIssue({
          code: "custom",
          path: ["note"],
          message:
            "A relayed proof activation requires the recorded operator authorization note",
        });
      if (input.action !== "amend_brief" && input.brief)
        ctx.addIssue({
          code: "custom",
          path: ["brief"],
          message: "Brief text is only valid for amend_brief",
        });
      if (input.action !== "amend_brief" && input.overtakes !== undefined)
        ctx.addIssue({ code: "custom", path: ["overtakes"], message: "Decision references are only valid for amend_brief" });
      if (input.action !== "note" && input.message !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["message"],
          message: "A coordination message is only valid for note",
        });
      if (input.action === "note" && !input.message)
        ctx.addIssue({
          code: "custom",
          path: ["message"],
          message: "A coordination note requires a message",
        });
      if (input.action === "amend_brief" && !input.reason)
        ctx.addIssue({
          code: "custom",
          path: ["reason"],
          message: "A brief amendment requires its reason",
        });
      if (input.rebindWorkspaceId && input.action !== "restart")
        ctx.addIssue({
          code: "custom",
          path: ["rebindWorkspaceId"],
          message:
            "Workspace rebind is only valid for restart of a pre-dispatch task",
        });
      if (!["restart", "move"].includes(input.action) && input.instruction)
        ctx.addIssue({
          code: "custom",
          path: ["instruction"],
          message: "Instruction is only valid for a restart or a move to work",
        });
      if (input.noAutomaticRetry !== undefined && !["move", "restart", "route", "amend_brief"].includes(input.action))
        ctx.addIssue({
          code: "custom",
          path: ["noAutomaticRetry"],
          message: "A no-automatic-retry rule is only valid for move, restart, route or amend_brief",
        });
      if (input.action === "set_dependencies" && !input.dependsOn)
        ctx.addIssue({
          code: "custom",
          path: ["dependsOn"],
          message:
            "Dependency changes require the complete prerequisite task ID list",
        });
      if (input.action !== "set_dependencies" && input.dependsOn)
        ctx.addIssue({
          code: "custom",
          path: ["dependsOn"],
          message: "Prerequisites are only valid for dependency changes",
        });
      if (input.action === "set_prerequisite_wait" && !input.waitsFor)
        ctx.addIssue({
          code: "custom",
          path: ["waitsFor"],
          message:
            "Prerequisite waits require the complete prerequisite task ID list",
        });
      if (input.action !== "set_prerequisite_wait" && input.waitsFor)
        ctx.addIssue({
          code: "custom",
          path: ["waitsFor"],
          message: "waitsFor is only valid for set_prerequisite_wait",
        });
      if (input.action === "set_prerequisite_wait" && !input.reason)
        ctx.addIssue({
          code: "custom",
          path: ["reason"],
          message: "A retained prerequisite wait requires a reason",
        });
      if (
        input.action === "set_lane" &&
        input.lane === undefined &&
        input.lanes === undefined
      )
        ctx.addIssue({
          code: "custom",
          path: ["lane"],
          message: "set_lane requires a lane key, a lane list or null",
        });
      if (
        input.action === "set_lane" &&
        input.lane !== undefined &&
        input.lanes !== undefined
      )
        ctx.addIssue({
          code: "custom",
          path: ["lanes"],
          message: "set_lane takes lane or lanes, not both",
        });
      if (input.action !== "set_lane" && input.lane !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["lane"],
          message: "Lane is only valid for set_lane",
        });
      if (input.action !== "set_lane" && input.lanes !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["lanes"],
          message: "Lanes are only valid for set_lane",
        });
      if (input.action === "supersede" && !input.replacementTaskId)
        ctx.addIssue({
          code: "custom",
          path: ["replacementTaskId"],
          message: "Supersession requires the retained replacement task ID",
        });
      if (input.action !== "supersede" && input.replacementTaskId)
        ctx.addIssue({
          code: "custom",
          path: ["replacementTaskId"],
          message: "A replacement task is only valid for supersession",
        });
      if (
        input.workDisposition === "retained_by_replacement" &&
        input.action !== "supersede"
      )
        ctx.addIssue({
          code: "custom",
          path: ["workDisposition"],
          message:
            "Retained-by-replacement disposition is only valid for supersession",
        });
      // Spec 050 `retry_effect`: an owner re-running a disposition workspace proof
      // may select the existing safe archive_if_empty policy when the recorded
      // retained_by_replacement proof can no longer be produced. No other policy is
      // selectable here and no new disposal request is created.
      if (
        input.workDisposition &&
        !["cancel", "supersede"].includes(input.action) &&
        !(
          input.action === "retry_effect" &&
          input.workDisposition === "archive_if_empty"
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["workDisposition"],
          message:
            "Work disposition is only valid for cancellation, supersession, or an owner-selected archive_if_empty recovery of a disposition workspace proof",
        });
      // Keep free-text reasons scoped to controls whose contract records them.
      if (input.action === "withdraw_cancel" && !input.reason)
        ctx.addIssue({
          code: "custom",
          path: ["reason"],
          message: "Withdrawing a cancellation requires an operator reason",
        });
      if (
        (input.action === "hold" || input.action === "keep_hold") &&
        !input.reason
      )
        ctx.addIssue({
          code: "custom",
          path: ["reason"],
          message: "A hold requires its reason",
        });
      if (input.until !== undefined && input.action !== "hold")
        ctx.addIssue({
          code: "custom",
          path: ["until"],
          message: "An until condition is only valid for hold",
        });
      if (
        input.action === "hold" &&
        input.until !== undefined &&
        !parseHoldUntil(input.until)
      )
        ctx.addIssue({
          code: "custom",
          path: ["until"],
          message: "A hold's until must be a task ID or an offset timestamp",
        });
      if (
        input.kind !== undefined &&
        input.action !== "hold" &&
        input.action !== "release" &&
        input.action !== "keep_hold"
      )
        ctx.addIssue({
          code: "custom",
          path: ["kind"],
          message: "A hold kind is only valid for hold, release or keep_hold",
        });
      if (
        input.agentId &&
        input.action !== "hold" &&
        input.action !== "keep_hold"
      )
        ctx.addIssue({
          code: "custom",
          path: ["agentId"],
          message: "An agent ID is only valid for hold or keep_hold",
        });
      if (input.action === "move" && (!input.to || !input.reason))
        ctx.addIssue({
          code: "custom",
          path: ["to"],
          message:
            "move requires a target step (work, review, merge or closeout) and a reason",
        });
      if (input.action === "stop" && !input.reason)
        ctx.addIssue({
          code: "custom",
          path: ["reason"],
          message: "stop requires a reason",
        });
      if (input.to !== undefined && input.action !== "move")
        ctx.addIssue({
          code: "custom",
          path: ["to"],
          message: "A target step is only valid for move",
        });
      if (
        input.qualification !== undefined &&
        !(
          input.action === "move" &&
          (input.to === "merge" || input.to === "closeout")
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["qualification"],
          message:
            "A qualification is only valid for move to merge or a review-entry external-merge closeout",
        });
      if (
        input.head !== undefined &&
        !(
          input.action === "move" &&
          (input.to === "merge" || input.to === "closeout") &&
          input.qualification !== undefined
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["head"],
          message:
            "A head is only valid for move to merge or closeout with an owner acceptance (qualification)",
        });
      if (
        input.prNumber !== undefined &&
        !(input.action === "move" && input.to === "review")
      )
        ctx.addIssue({
          code: "custom",
          path: ["prNumber"],
          message: "A replacement PR number is only valid for move to review",
        });
      if (input.action === "extend_budget") {
        if (!input.reason)
          ctx.addIssue({ code: "custom", path: ["reason"], message: "Extending a task budget requires the operator's reason" });
        if (input.relayed && !input.note)
          ctx.addIssue({ code: "custom", path: ["note"], message: "A relayed budget extension requires the operator's authorization note" });
      }
      if (input.action === "retry_effect" && !input.reason)
        ctx.addIssue({
          code: "custom",
          path: ["reason"],
          message:
            "Retrying a recorded side effect requires the owner's reason",
        });
      if (input.force && !["move", "retry_effect"].includes(input.action))
        ctx.addIssue({ code: "custom", path: ["force"], message: "force applies only to move or retry_effect" });
      if (input.force && input.action === "retry_effect" && !input.effect)
        ctx.addIssue({ code: "custom", path: ["effect"], message: "A forced settlement requires the named effect" });
      if (input.effect !== undefined && input.action !== "retry_effect")
        ctx.addIssue({
          code: "custom",
          path: ["effect"],
          message: "An effect key is only valid for retry_effect",
        });
      if (input.discard !== undefined && input.action !== "retry_effect")
        ctx.addIssue({
          code: "custom",
          path: ["discard"],
          message: "Checkout discard is only valid for retry_effect",
        });
      if (
        input.reason &&
        ![
          "cancel",
          "withdraw_cancel",
          "supersede",
          "amend_brief",
          "set_routing",
          "exclude_worker",
          "hold",
          "keep_hold",
          "set_prerequisite_wait",
          "complete",
          "move",
          "route",
          "restart",
          "retry_effect",
          "stop",
          "proof",
          "accept_receipt",
          "extend_budget",
        ].includes(input.action)
      )
        ctx.addIssue({
          code: "custom",
          path: ["reason"],
          message:
            "A reason is only valid for cancellation withdrawal, cancellation, supersession, a brief amendment, a routing change, worker exclusion, re-review, a hold, a retained prerequisite wait, owner completion, a task move, an owner route, a restart, a stop or a recorded side-effect retry",
        });
    }),
);

/** Persisted and internal controls always carry a concrete admission version. */
export const taskControlInputSchema = taskControlSchema(z.number());
export const taskControlRequestSchema = z.preprocess(raw => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { reference, ...input } = raw as Record<string, unknown>;
  if (reference === undefined) return input;
  if (input.taskId !== undefined) throw Error("taskId: pass exactly one of taskId or reference");
  return { ...input, taskId: reference };
}, taskControlSchema(z.number().optional()));
export type TaskControlRequest = z.infer<typeof taskControlRequestSchema>;
export type TaskControlInput = z.infer<typeof taskControlInputSchema>;

/** A task control response is the updated task (the 23 narrow-action aliases and their deprecation notes were deleted on 2026-10-15). */
export const taskControlTaskSchema = taskSchema.extend({
  changes: z.array(z.string()).optional(),
});

export type TaskControlTask = z.infer<typeof taskControlTaskSchema>;

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
  /** Task 645: the durable owner no-automatic-retry rule and the control that recorded it. */
  noAutomaticRetry: z.boolean().optional(),
  noAutomaticRetryProvenance: z.string().nullable().optional(),
  /** Task 662: present when the owner retired the spent author-side proof declaration. */
  proofExecutionRetired: z.literal(true).optional(),
  workerDemandStep: z.string().optional(),
  /** The checkout's links-only provisioning record, when it has one. */
  worktreeLinks: worktreeLinksSchema.optional(),
}).strict();

export type TaskNext = z.infer<typeof taskNextSchema>;
