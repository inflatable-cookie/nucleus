import { digest } from "../store/store";
import type {
  CapabilityLevel,
  CoordinatorAction,
  ProfileCapability,
  RecoveryActionBinding,
  Task,
  TaskNextVerb,
  UsageLevel,
} from "../../shared/contracts";
import { requestOnly } from "../../shared/pool";
import { requestedTier } from "../../shared/demand";
import type { ResolutionChanges } from "./task-stops";

/** A worker return cannot be valid after review; a held lifecycle check is the only cheap recovery left. */
/**
 * The conservative intent guard: what the task was when the coordinator was
 * asked — its phase, exact source head, worker identity, latest results and
 * review, current run, merge state, routes and approved instruction source. A
 * report is stale when this changed, and the stop record itself churns between
 * waits and stops for one condition (consumer-b #639), so it is not the binding.
 *
 * It deliberately carries no review coverage at all: the same retained reviewer
 * saving a further checkpoint at the same head is the unit the episode is already
 * working in, and that must not remove the ordinary move authority the episode
 * was opened with (review 5668519775). The loop's coverage measure stays in
 * `taskWorkIdentity`, and recovery's decision to revisit a still-unfinished
 * checkpoint is a separate lifecycle question it answers from current delivery
 * facts, not through this digest.
 */
export function taskProgressDigest(t: Task): string {
  return digest(
    JSON.stringify([
      t.phase,
      t.prHead,
      t.agentId,
      t.runId,
      t.completion?.eventId ?? null,
      t.resolution.review?.eventId ?? null,
      t.resolution.currentRunId,
      t.resolution.mergeIntent,
      t.resolution.mergedCommit,
      t.briefVersions.at(-1)?.digest ?? null,
      t.profileRequests ?? null,
      t.removedAt ?? null,
    ]),
  );
}
/**
 * Whether an accepted coordinator report still describes the task it was asked
 * about, so Queue may apply it: the progress digest recorded when the episode
 * opened. A changed head, result, review, result, participant or run, a re-pinned brief or
 * an owner route makes it stale; the same reviewer's own checkpoint evolution
 * does not.
 */
export function coordinatorReportMatches(t: Task): boolean {
  const progress = t.resolution.recovery?.progress;
  return Boolean(progress && progress === taskProgressDigest(t));
}

/**
 * The retired narrow actions, each with the owner verb that does its work now.
 * A stored report naming one applies nothing: it is refused *as retired*, and the
 * refusal names the verb to use instead (nucleus#1388). Only these shapes are
 * retired; a report that names no action is a settled observation.
 */
const RETIRED_NARROW_ACTIONS: Record<string, string> = {
  // Spec 049 coordinator recovery actions, kept readable on old completions and
  // bindings (`completion.recoveryAction`); nothing applies them.
  retry: "restart",
  revise: "move to=work",
  resume_worker: "restart role=worker",
  reassign_origin: "restart role=coordinator",
  reconcile: "restart",
  // The four narrow task controls folded into the owner verbs (Tom, 2026-10-19).
  continue_review: "restart role=reviewer",
  retry_resolution: "restart",
  resolve_escalation: "restart",
  repin_instruction: "amend_brief with no text",
};

/** A retired narrow action a stored report names, and the owner verb that replaced it. */
export type RetiredNarrowAction = { action: string; instead: string };

export function retiredNarrowAction(
  binding: Pick<RecoveryActionBinding, "recoveryAction" | "coordinatorAction">,
): RetiredNarrowAction | null {
  for (const name of [
    binding.recoveryAction ?? null,
    binding.coordinatorAction?.verb ?? null,
  ]) {
    const instead = name ? RETIRED_NARROW_ACTIONS[name] : undefined;
    if (name && instead) return { action: name, instead };
  }
  return null;
}

/** The refusal a retired narrow action records: nothing applied, the verb to use instead named. */
export function retiredNarrowRefusal(retired: RetiredNarrowAction): string {
  return `${retired.action} is a retired narrow action and applies nothing; use ${retired.instead}`;
}

/**
 * Whether an accepted report names no owner verb at all: the coordinator found the
 * work live, or could not act, and said so. That settles the episode as observed;
 * it is never a retired narrow action and is never refused for having no verb
 * (nucleus#1388).
 */
export function reportNamesNoAction(
  binding: Pick<RecoveryActionBinding, "recoveryAction" | "coordinatorAction">,
): boolean {
  return (
    !binding.recoveryAction &&
    (!binding.coordinatorAction || binding.coordinatorAction.verb === "none")
  );
}

/**
 * The owner verb a coordinator's report asks for, as the arguments to apply, or
 * the refusal naming why it no longer applies. Every string here is the owner's
 * own: the plan reads the same views `next` shows, so a coordinator cannot invent
 * a verb the task does not offer, and the caller applies it under its usual lane.
 */
export type CoordinatorActionPlan =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; refusal: string };

/**
 * The plan for one coordinator action: the reported verb's own view, the role it
 * binds, the operator's usage level for a route, and the arguments built from the
 * report's fields. Pure over the task's verb views; the caller applies it.
 */
export function coordinatorActionPlan(input: {
  action: CoordinatorAction;
  /** The task's owner-verb views, as `next` derives them from the same store facts. */
  views: TaskNextVerb[];
  /** The stop the report answers, if the task still records one. */
  stopReason?: string | null;
  /** The reported route profile's cost, when the verb is `route`. */
  routeCost: CapabilityLevel | null;
  /** The reported route profile's capability, which decides whether it needs permission. */
  routeCapability?: ProfileCapability | null;
  /** The task's complexity, which fixes its requested tier for the permission rule. */
  complexity?: CapabilityLevel | null;
  usage: UsageLevel;
  /** Whether `ownerVerb` holds a handler for the reported verb. */
  verbRegistered: boolean;
}): CoordinatorActionPlan {
  const { action } = input;
  // A view that derived no role (a blocked or errored task with a PR) leaves
  // the role to the caller's explicit choice, which its own note documents;
  // only a role the view did derive is a binding.
  const force =
    (action.verb === "move" || action.verb === "retry_effect") &&
    action.force === true;
  const requested = input.views.find((view) => {
    const args = force
      ? view.forceArgs
      : view.available
        ? view.args
        : undefined;
    return (
      view.verb === action.verb &&
      args &&
      (action.verb !== "route" || args.role === action.role) &&
      (action.verb !== "move" || args.to === action.to) &&
      (action.verb !== "retry_effect" ||
        !action.effect ||
        args.effect === action.effect)
    );
  });
  const offeredArgs = force ? requested?.forceArgs : requested?.args;
  if (!offeredArgs) {
    // Name why, from the same views `next` shows, so the owner or the next
    // coordinator can choose without another diagnostic read.
    const refusals = [
      ...new Set(
        input.views
          .filter(
            (view) =>
              view.verb === action.verb && !view.available && view.refusal,
          )
          .map((view) => view.refusal!),
      ),
    ];
    return {
      ok: false,
      refusal:
        `The reported ${action.verb} does not apply to the task now${input.stopReason ? ` (stop ${input.stopReason})` : ""}${refusals.length ? `: ${refusals.join("; ")}` : ""}`.slice(
          0,
          4000,
        ),
    };
  }
  if (
    action.verb === "restart" &&
    action.role &&
    offeredArgs.role !== undefined &&
    offeredArgs.role !== action.role
  )
    return {
      ok: false,
      refusal: `restart ${action.role} does not match the stopped role ${String(offeredArgs.role)}`,
    };
  // A coordinator stays within the operator's usage level's permission rule
  // (Spec 052, Tom 2026-11-17): a top-tier route above the task's own requested
  // tier at Low or Normal, or a frontier route at High, is the owner's call.
  if (
    action.verb === "route" &&
    input.routeCapability &&
    requestOnly(
      { cost: input.routeCost, capability: input.routeCapability },
      input.usage,
      requestedTier(input.complexity),
    )
  )
    return {
      ok: false,
      refusal: `A coordinator cannot route to ${action.profileId}: its ${input.routeCapability.replaceAll("_", " ")} tier needs the operator's permission at the ${input.usage} usage level. Use a profile the level covers, and report an environment block (a missing tool or stack) as cannot`,
    };
  if (!input.verbRegistered)
    return {
      ok: false,
      refusal: `The ${action.verb} owner verb is not registered`,
    };
  const args: Record<string, unknown> = {
    ...offeredArgs,
    reason: action.reason,
  };
  if (action.verb === "restart")
    Object.assign(args, {
      ...(action.role ? { role: action.role } : {}),
      ...(action.instruction ? { instruction: action.instruction } : {}),
      ...(action.fresh !== undefined ? { fresh: action.fresh } : {}),
    });
  if (action.verb === "route")
    Object.assign(args, {
      role: action.role,
      profileId: action.profileId,
      ...(action.thinkingOptionId !== undefined
        ? { thinkingOptionId: action.thinkingOptionId }
        : {}),
      ...(action.now !== undefined ? { now: action.now } : {}),
    });
  if (action.verb === "move")
    Object.assign(args, {
      to: action.to,
      ...(action.instruction ? { instruction: action.instruction } : {}),
      ...(action.fresh !== undefined ? { fresh: action.fresh } : {}),
    });
  if (action.verb === "retry_effect" && action.effect)
    args.effect = action.effect;
  return { ok: true, args };
}

/**
 * What settling one accepted coordinator report changes on the task: the episode
 * resolves with its action's outcome, a refused report's reason lands on the stop
 * it answers, and a recovered report resolves the incident it owns. An episode or
 * action the accepted report no longer binds settles as the recorded event alone.
 */
export type RecoverySettlementPatch =
  | {
      kind: "event_only";
      event: "coordinator_action_applied" | "coordinator_action_refused";
    }
  | {
      kind: "patch";
      event: "coordinator_action_applied" | "coordinator_action_refused";
      changes: ResolutionChanges;
      patch: Partial<Task>;
    };

export function recoverySettlementPatch(facts: {
  status: "applied" | "refused";
  reason?: string;
  binding: RecoveryActionBinding;
  /** The action the report asked for; a `cannot` carries the reason a refusal quotes. */
  action: CoordinatorAction;
  /** The recovery run whose report this is. */
  runId: string;
  /** The task as the settlement transaction reads it. */
  task: Task;
  /** The clock read the settlement records when it resolves an incident. */
  at: string;
}): RecoverySettlementPatch {
  const event =
    facts.status === "applied"
      ? ("coordinator_action_applied" as const)
      : ("coordinator_action_refused" as const);
  const recovery = facts.task.resolution.recovery;
  if (
    !recovery ||
    recovery.runId !== facts.runId ||
    recovery.action?.eventId !== facts.binding.eventId
  )
    return { kind: "event_only", event };
  const stop = facts.task.resolution.stop;
  const matches = Boolean(
    stop && recovery.key === digest(`stop:${stop.reason}:${stop.since}`),
  );
  const detail =
    facts.reason ?? (facts.action.verb === "cannot" ? facts.action.reason : "");
  const updatedStop =
    facts.status === "applied"
      ? null
      : matches && stop && detail
        ? {
            ...stop,
            detail: `${detail} — ${facts.binding.summary}`.slice(0, 4000),
          }
        : stop;
  const nextAction =
    facts.status === "applied"
      ? { ...facts.binding, status: "applied" as const }
      : {
          ...facts.binding,
          status: "refused" as const,
          reason: (
            facts.reason ??
            "Coordinator report no longer matches the current task stop"
          ).slice(0, 4000),
        };
  const incident = facts.task.resolution.incident;
  const settledIncident =
    facts.status === "applied" &&
    facts.binding.reportStatus === "recovered" &&
    recovery.incidentId &&
    incident?.id === recovery.incidentId &&
    incident.status === "reconciling"
      ? {
          ...incident,
          status: "resolved" as const,
          detail: `Recovery reported the trigger settled: ${facts.binding.summary}`,
          updatedAt: facts.at,
        }
      : incident;
  return {
    kind: "patch",
    event,
    changes: {
      recovery: {
        ...recovery,
        status: "resolved",
        summary: facts.binding.summary,
        action: nextAction,
      },
      incident: settledIncident,
      recoveryActive: false,
      stop: updatedStop,
    },
    patch:
      updatedStop && updatedStop.detail !== facts.task.reason
        ? { reason: updatedStop.detail }
        : {},
  };
}
