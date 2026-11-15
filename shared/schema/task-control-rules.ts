import { z } from "zod";
import { parseHoldUntil } from "./task-holds";
import type { TaskControlFields } from "./task-control-fields";

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

/**
 * The cross-field rules one task control must satisfy: which actions take which
 * fields, which need a reason or an authorization note, and which combinations
 * are refused. The field bag itself is `taskControlFields` in task-control.ts.
 */
export function checkTaskControlRules(input: TaskControlFields, ctx: z.RefinementCtx): void {
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
    if (input.role === "executor")
      ctx.addIssue({
        code: "custom",
        path: ["role"],
        message: "A proof executor is never routed; restart role=executor asks the live executor to resend its report",
      });
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
    if (input.role === "executor")
      ctx.addIssue({
        code: "custom",
        path: ["role"],
        message: "An executor role names the proof-execution re-report continuation, which only restart accepts",
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
}
