/**
 * Spec 058 (task 577): a task keeps one worker thread. A worker replacement
 * (retiring the retained worker and creating a new agent) happens only when
 * the retained worker cannot continue, or the task's worker profile actually
 * changes to a different model on an approved and effective route.
 *
 * Every other path continues the same retained worker agent: recovery actions,
 * "remap" restarts, owner restarts without a model change, route requests
 * still waiting on sign-off, non-delivery push-backs and unfinished
 * continuations.
 *
 * This module owns the one guard every replacement path reads — `restart`,
 * `route`, `move to=work` with fresh, coordinator recovery actions and the
 * automatic failover sweep — so the rule is enforced in the replacement path
 * itself, not in each caller. A caller that asks for a replacement the guard
 * refuses records `worker_replacement_refused` naming the rule and continues
 * the retained worker.
 */
import { requestOnly, honouredRequest } from "../../shared/pool";
import { WORKER_REPLACEMENT_CEILING } from "../../shared/contracts";
import type { PoolEntry, Task, UsageLevel } from "../../shared/contracts";
import { isQuotaExhaustion } from "./exhaustion";
import { modelKey } from "../dispatch/routing";

/** Why the retained worker cannot continue. */
export type WorkerReplacementFailure =
  | { kind: "provider_failure"; detail: string }
  | { kind: "quota_exhaustion"; detail: string }
  | { kind: "agent_errored"; detail: string }
  | { kind: "agent_closed"; detail: string }
  | { kind: "session_unrecoverable"; detail: string };

/** The rule a `worker_replacement_refused` event names. */
export type WorkerReplacementRefusalRule =
  | "signoff_pending"
  | "same_model_no_failure"
  | "fresh_without_cause_or_relay"
  | "route_superseded";

export type WorkerReplacementDecision =
  | { allowed: true; cause: string }
  | { allowed: false; rule: WorkerReplacementRefusalRule; detail: string };

/**
 * Positive evidence that the retained worker cannot continue, from the task's
 * recorded facts and one fresh observation. An errored agent counts only when
 * it has no active turn or pending permission; an unreadable observation counts
 * for nothing, so an observation failure never authorizes a replacement.
 */
export function retainedWorkerFailureCause(args: {
  task: Task;
  observedStatus?: string | null;
  observedError?: string | null;
  observedActive?: boolean | null;
  observedPermissions?: boolean | null;
  observedWorkspaceId?: string | null;
  groupUnavailable?: { group: string; reason: string } | null;
}): WorkerReplacementFailure | null {
  if (args.task.completion?.providerUnavailable) {
    const retry = args.task.completion.providerRetryAt ? ` (retry ${args.task.completion.providerRetryAt})` : "";
    return { kind: "provider_failure", detail: `the retained worker reported provider exhaustion${retry}` };
  }
  if (args.observedError && isQuotaExhaustion(args.observedError))
    return { kind: "quota_exhaustion", detail: `the retained worker observed quota exhaustion: ${args.observedError.slice(0, 400)}` };
  if (args.groupUnavailable)
    return { kind: "quota_exhaustion", detail: `subscription group ${args.groupUnavailable.group} is unavailable: ${args.groupUnavailable.reason.slice(0, 400)}` };
  if (args.observedStatus === "error" && args.observedActive === false && args.observedPermissions === false)
    return { kind: "agent_errored", detail: `the retained worker agent errored: ${(args.observedError || "no error detail").slice(0, 400)}` };
  if (args.observedStatus === "closed" || args.observedStatus === "archived")
    return { kind: "agent_closed", detail: `the retained worker agent was observed ${args.observedStatus}` };
  if (args.observedWorkspaceId !== undefined && args.observedWorkspaceId !== null
    && args.task.workspaceId && args.observedWorkspaceId !== args.task.workspaceId)
    return { kind: "session_unrecoverable", detail: "the retained worker's workspace identity changed" };
  return null;
}

/**
 * Whether the named worker route is approved and effective: a profile within
 * the usage level needs no approval, while a frontier or above-ceiling profile
 * needs the operator's board sign-off on this task and profile.
 */
export function isWorkerRouteApproved(
  task: Pick<Task, "profileRequests">,
  profileId: string,
  pool: readonly Pick<PoolEntry, "cost" | "capability" | "profileId">[],
  usage: UsageLevel,
): boolean {
  const entry = pool.find(item => item.profileId === profileId);
  if (!entry || !requestOnly(entry, usage)) return true;
  return honouredRequest(task.profileRequests?.worker ?? null, pool, usage)?.profileId === profileId;
}

/**
 * The one replacement guard (Spec 058 task 577). `requestedModel` is the
 * replacement candidate's model, `currentModel` the retained worker's; both
 * compare by normalized model key, so two profiles on one model are the same
 * worker thread. `approved` is whether the new route is approved and effective
 * (see `isWorkerRouteApproved`); `failure` is positive evidence the retained
 * worker cannot continue; `explicitOperatorRelay` is an explicit
 * operator-relayed reason (the board caller or a relayed operator note), which
 * is the only other way a `restart role=worker fresh` without a failure or a
 * model change may replace.
 */
export function decideWorkerReplacement(args: {
  task: Task;
  requestedProfileId: string | null;
  requestedModel: string | null;
  currentModel: string | null;
  approved: boolean;
  failure: WorkerReplacementFailure | null;
  explicitOperatorRelay: boolean;
  /** The caller shape, naming the refusal rule for a fresh restart. */
  freshRestart?: boolean;
}): WorkerReplacementDecision {
  if (args.failure)
    return { allowed: true, cause: `${args.failure.kind}: ${args.failure.detail}` };
  if (args.explicitOperatorRelay)
    return { allowed: true, cause: "operator_relayed: an explicit operator-relayed reason authorizes the replacement" };
  const current = (args.currentModel ?? "").trim();
  const requested = (args.requestedModel ?? "").trim();
  const modelChanges = Boolean(current && requested) && modelKey(requested) !== modelKey(current);
  if (args.requestedProfileId && !args.approved)
    return {
      allowed: false,
      rule: "signoff_pending",
      detail: `route to ${args.requestedProfileId} is waiting on the operator's board sign-off; the request is recorded and nothing replaces the retained worker until it is approved`,
    };
  if (args.requestedProfileId && modelChanges && args.approved)
    return { allowed: true, cause: `approved_model_change: the worker route moves from ${current} to ${requested} on an approved route` };
  if (args.freshRestart)
    return {
      allowed: false,
      rule: "fresh_without_cause_or_relay",
      detail: "a fresh worker restart replaces only on provider failure, quota exhaustion, an inactive errored agent, a closed agent or an unrecoverable session, or with an explicit operator-relayed reason; the retained worker continues",
    };
  return {
    allowed: false,
    rule: "same_model_no_failure",
    detail: "the replacement keeps the same model with no worker failure; the retained worker continues",
  };
}

/**
 * The refusal when the worker retirement ceiling has been reached. The ceiling and
 * its one exit belong to the replacement rule, so every caller that refuses names
 * the same bound and the same owner verb.
 */
export function replacementCeilingRefusal(task: Pick<Task, 'retiredWorkers'>): string {
  return `Nucleus has retired ${task.retiredWorkers.length} workers, the replacement ceiling of ${WORKER_REPLACEMENT_CEILING}; an operator-relayed restart role=worker fresh is required to replace it`;
}

/** The `worker_replacement_refused` detail for a selection that stopped matching its armed request. */
export function supersededReplacementRefusal(recordedProfileId: string | null, selectedProfileId: string, cause: string): WorkerReplacementDecision {
  return {
    allowed: false,
    rule: "route_superseded",
    detail: `the recorded replacement request ${recordedProfileId ?? "absent"} no longer selects ${selectedProfileId}: ${cause}. Nothing was retired and the retained worker continues`,
  };
}
