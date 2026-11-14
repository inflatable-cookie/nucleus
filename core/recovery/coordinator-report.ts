import { digest } from '../store/store';
import type { CapabilityLevel, CoordinatorAction, ProfileCapability, RecoveryActionBinding, Task, TaskNextVerb, UsageLevel } from '../../shared/contracts';
import { frontierAllowed, withinUsage } from '../../shared/pool';
import type { ResolutionChanges } from './task-stops';

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
export function taskProgressDigest(t:Task):string{
 return digest(JSON.stringify([t.phase,t.prHead,t.agentId,t.runId,t.completion?.eventId??null,
  t.resolution.review?.eventId??null,t.resolution.currentRunId,t.resolution.mergeIntent,t.resolution.mergedCommit,
  t.briefVersions.at(-1)?.digest??null,t.profileRequests??null,t.removedAt??null]));
}
/**
 * Whether an accepted coordinator report still describes the task it was asked
 * about, so Queue may apply it: the progress digest recorded when the episode
 * opened. A changed head, result, review, result, participant or run, a re-pinned brief or
 * an owner route makes it stale; the same reviewer's own checkpoint evolution
 * does not.
 */
export function coordinatorReportMatches(t:Task):boolean{
 const progress=t.resolution.recovery?.progress;
 return Boolean(progress&&progress===taskProgressDigest(t));
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
  /** The reported route profile's capability; a frontier profile is request-only below Maximum. */
  routeCapability?: ProfileCapability | null;
  usage: UsageLevel;
  /** Whether `ownerVerb` holds a handler for the reported verb. */
  verbRegistered: boolean;
}): CoordinatorActionPlan {
  const { action } = input;
  // A view that derived no role (a blocked or errored task with a PR) leaves
  // the role to the caller's explicit choice, which its own note documents;
  // only a role the view did derive is a binding.
  const requested = input.views.find(view => view.verb === action.verb && view.available && view.args
    && (action.verb !== "route" || view.args.role === action.role)
    && (action.verb !== "move" || view.args.to === action.to)
    && (action.verb !== "retry_effect" || !action.effect || view.args.effect === action.effect));
  if (!requested?.args) {
    // Name why, from the same views `next` shows, so the owner or the next
    // coordinator can choose without another diagnostic read.
    const refusals = [...new Set(input.views.filter(view => view.verb === action.verb && !view.available && view.refusal).map(view => view.refusal!))];
    return { ok: false, refusal: `The reported ${action.verb} does not apply to the task now${input.stopReason ? ` (stop ${input.stopReason})` : ""}${refusals.length ? `: ${refusals.join("; ")}` : ""}`.slice(0, 4000) };
  }
  if (action.verb === "restart" && action.role && requested.args.role !== undefined && requested.args.role !== action.role)
    return { ok: false, refusal: `restart ${action.role} does not match the stopped role ${String(requested.args.role)}` };
  // A coordinator stays within the operator's usage level (Spec 052). At
  // `normal` that keeps the 2026-10-01/15 rule: a very_high-cost (Sol-class)
  // route is the owner's last resort, since an availability or environment
  // block is not a capability failure.
  if (action.verb === "route" && input.routeCost && !withinUsage(input.usage, input.routeCost))
    return { ok: false, refusal: `A coordinator cannot route to ${action.profileId}: its ${input.routeCost} cost is above the operator's ${input.usage} usage level. Wait out an availability block or use an equivalent-cost profile, and report an environment block (a missing tool or stack) as cannot` };
  if (action.verb === "route" && !frontierAllowed(input.usage, input.routeCapability))
    return { ok: false, refusal: `A coordinator cannot route to ${action.profileId}: it is rated frontier, which is request-only below Maximum. Use a profile within the ${input.usage} usage level, and report an environment block (a missing tool or stack) as cannot` };
  if (!input.verbRegistered) return { ok: false, refusal: `The ${action.verb} owner verb is not registered` };
  const args: Record<string, unknown> = { ...requested.args, reason: action.reason };
  if (action.verb === "restart") Object.assign(args, {
    ...(action.role ? { role: action.role } : {}), ...(action.instruction ? { instruction: action.instruction } : {}),
    ...(action.fresh !== undefined ? { fresh: action.fresh } : {}),
  });
  if (action.verb === "route") Object.assign(args, {
    role: action.role, profileId: action.profileId,
    ...(action.thinkingOptionId !== undefined ? { thinkingOptionId: action.thinkingOptionId } : {}),
    ...(action.now !== undefined ? { now: action.now } : {}),
  });
  if (action.verb === "move") Object.assign(args, {
    to: action.to, ...(action.instruction ? { instruction: action.instruction } : {}),
    ...(action.fresh !== undefined ? { fresh: action.fresh } : {}),
  });
  if (action.verb === "retry_effect" && action.effect) args.effect = action.effect;
  return { ok: true, args };
}

/**
 * What settling one accepted coordinator report changes on the task: the episode
 * resolves with its action's outcome, a refused report's reason lands on the stop
 * it answers, and a recovered report resolves the incident it owns. An episode or
 * action the accepted report no longer binds settles as the recorded event alone.
 */
export type RecoverySettlementPatch =
  | { kind: "event_only"; event: "coordinator_action_applied" | "coordinator_action_refused" }
  | { kind: "patch"; event: "coordinator_action_applied" | "coordinator_action_refused";
      changes: ResolutionChanges; patch: Partial<Task> };

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
  const event = facts.status === "applied" ? "coordinator_action_applied" as const : "coordinator_action_refused" as const;
  const recovery = facts.task.resolution.recovery;
  if (!recovery || recovery.runId !== facts.runId || recovery.action?.eventId !== facts.binding.eventId) return { kind: "event_only", event };
  const stop = facts.task.resolution.stop;
  const matches = Boolean(stop && recovery.key === digest(`stop:${stop.reason}:${stop.since}`));
  const detail = facts.reason ?? (facts.action.verb === "cannot" ? facts.action.reason : "");
  const updatedStop = facts.status === "applied" ? null : matches && stop && detail
    ? { ...stop, detail: `${detail} — ${facts.binding.summary}`.slice(0, 4000) }
    : stop;
  const nextAction = facts.status === "applied"
    ? { ...facts.binding, status: "applied" as const }
    : { ...facts.binding, status: "refused" as const, reason: (facts.reason ?? "Coordinator report no longer matches the current task stop").slice(0, 4000) };
  const incident = facts.task.resolution.incident;
  const settledIncident = facts.status === "applied" && facts.binding.reportStatus === "recovered" && recovery.incidentId
    && incident?.id === recovery.incidentId && incident.status === "reconciling"
    ? { ...incident, status: "resolved" as const,
        detail: `Recovery reported the trigger settled: ${facts.binding.summary}`, updatedAt: facts.at }
    : incident;
  return { kind: "patch", event,
    changes: { recovery: { ...recovery, status: "resolved", summary: facts.binding.summary, action: nextAction },
      incident: settledIncident, recoveryActive: false, stop: updatedStop },
    patch: updatedStop && updatedStop.detail !== facts.task.reason ? { reason: updatedStop.detail } : {} };
}
