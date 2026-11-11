/**
 * How one run settles with a verb's transition.
 *
 * One rule for `next` and for execution (round 4; Tom, 2026-10-27): the durable
 * side effects no transition may act over, the reason text for that refusal, and
 * whether an unreleased run can settle at all. It lives in its own module so the
 * verb registry, the engine's settlement and the reviewer continuation share the
 * same rule without an import cycle.
 */
import { blockingRecoveryEffects, recoveryEffectsRefusal } from '../recovery/recovery-effects';
import type { AgentObservation } from '../host/adapter';
import type { Store } from '../store/store';
import type { Run, Task } from '../../shared/contracts';

/**
 * The durable side effect, if any, a verb must not act over when it settles this
 * run: unknown delivery, a pending authenticated delivery or a blocking recovery
 * effect. A recorded report is the run's result, but it never settles a separate
 * effect it does not own.
 */
export function runSettlementFence(facts: { store: Store; task: Task }, run: Run): string | null {
  const effects = blockingRecoveryEffects(facts.store, facts.task, { runId: run.id }).filter(item => item.runId === run.id);
  const effectRefusal = recoveryEffectsRefusal(effects);
  if (effectRefusal) return effectRefusal;
  if (["intent", "uncertain"].includes(run.status)) return "its delivery is unknown";
  if ((run.reviewDeliveries ?? []).some(delivery => delivery.status === "reserved" || delivery.status === "uncertain"))
    return "its authenticated delivery is pending";
  return null;
}

/** The one refusal for a run carrying a durable side effect, naming what clears it. */
export function runFenceRefusal(run: Run, why: string): string {
  const clears = why === "its delivery is unknown" || why.startsWith('run-delivery ')
    ? "restart re-creates it under the same run, or wait for reconciliation to settle it"
    : "wait for that delivery or effect to settle, or retry_effect it";
  return `A ${run.role} run (${run.id}) holds a durable side effect Queue will not act over blindly (${why}); ${clears}`;
}

/**
 * Queue's own durable-effect fence refused before anything was bound or sent.
 * `runSettlementFence` is a read-only store projection, so this class carries
 * that proof whatever the refusal's prose says (papercut 4b285a6e): a control
 * it refuses settles as refused — never as an unknown delivery. The two
 * canonical messages above and `verbRunFenceRefusal` in `VerbFences` are this
 * class's texts; the store's legacy reconcile recognizes exactly them.
 */
export class DurableFenceRefusal extends Error {}

/**
 * The plan distinguishes durable fences, runs settled by their own recorded
 * result, and runs requiring fresh observation. Saved activity is only cached
 * evidence: execution must prove the bound participant's current identity,
 * activity, permissions, tools and effects before settling or displacing it.
 */
export type RunSettlement = { kind: "settles" } | { kind: "observes" } | { kind: "fences"; why: string };

export function runSettlement(facts: { store: Store; task: Task }, run: Run, options: { direct?: boolean } = {}): RunSettlement {
  const durable = runSettlementFence(facts, run);
  if (durable) return { kind: "fences", why: durable };
  if (options.direct) return { kind: "settles" };
  return { kind: "observes" };
}

/**
 * Positive participant liveness; delivery callers supply their narrower statuses.
 *
 * An agent observed in `error` with no active turn and no pending permission
 * is dead weight, like a closed one: it cannot write, so it never blocks a
 * run that does not need it. Wherever `closed` counts as inactive, `error`
 * counts too, through this one helper — callers keep naming the statuses
 * they accept and never re-list the error equivalence. The identity,
 * workspace, activity, turn and permission proofs still apply, so an errored
 * agent with a live turn or a pending permission still fences.
 */
export function matchingInactiveParticipant(participant: { agentId: string | null; workspaceId: string | null }, observed: AgentObservation,
  statuses: readonly string[] = ['idle', 'error', 'closed']): boolean {
  const effective = statuses.includes('closed') && !statuses.includes('error') ? [...statuses, 'error'] : statuses;
  return Boolean(participant.agentId && participant.workspaceId && observed.id === participant.agentId
    && observed.workspaceId === participant.workspaceId && observed.active === false && !observed.activeTurnId
    && observed.permissions === false && effective.includes(observed.status));
}
