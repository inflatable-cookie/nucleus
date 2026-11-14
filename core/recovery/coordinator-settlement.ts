import { resultApplied, recordResultApplied } from '../intake/applied-result';
import type { Task, Run, RecoveryActionBinding } from '../../shared/contracts';
import type { Engine } from '../engine';
import type { Resolution } from '../resolution';
import { collectOwnerVerbFacts, ownerVerb, ownerVerbViews } from '../verbs/owner-verbs';
import { coordinatorActionPlan, coordinatorReportMatches, recoverySettlementPatch } from './coordinator-report';

/**
 * Settles what a recovery run reported through the owner verbs. A report is
 * claimed once, applied as the owner verb it names under that verb's own lane, or
 * refused with the verb's reason and recorded as not applied. `Engine` registers
 * it as `Recovery`'s coordinator-action handler; a `Resolution` built without an
 * engine has none. `store` and `resolution` read the engine per call.
 */
/** Reports currently being applied, so a second pass never applies the same claim twice. */
export const recoveryApplicationsInFlight = new Set<string>();

export type RecoverySettlementContext = Pick<Engine, 'coordinatorActionRunId' | 'host' | 'onTaskHost' | 'performTaskControl' | 'store'>
  & { readonly resolution: Pick<Resolution, 'attention' | 'recovery' | 'update'> };
export class RecoverySettlement {
 constructor(readonly engine:RecoverySettlementContext){}
 get store(){return this.engine.store;}
 get resolution(){return this.engine.resolution;}
  /** Apply one coordinator report as the corresponding Spec 050 owner verb. */
  async applyCoordinatorAction(task: Task, run: Run, binding: RecoveryActionBinding): Promise<void> {
    const action = binding.coordinatorAction;
    if (!action || resultApplied(this.store, task.id, run.id)) return;
    const finish = (status: "applied" | "refused", reason?: string) => {
      try {
        this.store.recordVerbOutcome(task.id, action.verb, status, "coordinator",
          { coordinatorRun: run.id, ...(reason ? { reason: reason.slice(0, 600) } : {}) }, `coordinator:${binding.eventId}`);
      } catch { /* the outcome stands even if its record could not be written */ }
      this.store.transaction(() => {
        const current = this.store.task(task.id);
        if (resultApplied(this.store, task.id, run.id)) return;
        const latestRun = this.store.run(run.id);
        if (latestRun && !latestRun.released)
          this.store.putRun({ ...latestRun, completion: latestRun.completion ?? run.completion, released: true, status: "finished" });
        const settlement = recoverySettlementPatch({ status, reason, binding, action, runId: run.id, task: current, at: new Date().toISOString() });
        if (settlement.kind === "event_only") this.store.event(task.id, settlement.event, binding.eventId);
        else this.resolution.update(current, settlement.changes, settlement.patch, settlement.event, binding.eventId);
        if (action.verb === 'cannot' && status === 'refused')
          this.resolution.recovery.escalate(this.store.task(task.id), `The coordinator cannot settle this stop: ${action.reason} — ${binding.summary}`.slice(0, 4000));
        recordResultApplied(this.store, task.id, run.id);
      });
    };

    const claimKey = JSON.stringify([task.id, run.id, binding.eventId]);
    if (recoveryApplicationsInFlight.has(claimKey)) return;
    const previousClaim = this.store.eventsAll(task.id).some(event => event.kind === 'run_result_applying' && event.detail === claimKey);
    if (previousClaim) {
      const outcome = this.store.db.prepare("SELECT outcome FROM verb_outcomes WHERE taskId=? AND key=?").get(task.id, `coordinator:${binding.eventId}`) as {outcome?: string} | undefined;
      if (outcome?.outcome === 'applied' || outcome?.outcome === 'refused') {
        finish(outcome.outcome);
      } else {
        const latest = this.store.task(task.id);
        const reason = `Coordinator result ${run.id} has an uncertain owner-verb outcome; inspect next and settle the existing action before retrying`;
        if (latest.reason !== reason) this.resolution.attention(latest, reason);
      }
      return;
    }
    const claimed = this.store.transaction(() => {
      const latest = this.store.task(task.id);
      if (resultApplied(this.store, task.id, run.id) || latest.resolution.recovery?.runId !== run.id
        || latest.resolution.recovery.action?.eventId !== binding.eventId
        || latest.resolution.recovery.action.status !== 'pending'
        || this.store.eventsAll(task.id).some(event => event.kind === 'run_result_applying' && event.detail === claimKey)) return false;
      this.store.event(task.id, 'run_result_applying', claimKey);
      return true;
    });
    if (!claimed) return;
    recoveryApplicationsInFlight.add(claimKey);
    try {
    const current = this.store.task(task.id);
    const recovery = current.resolution.recovery;
    const stop = current.resolution.stop;
    // Round 4 (2026-10-19 audit): the report binds to its episode and
    // generation, not to the exact stop record it was opened for. Whether the
    // reported verb still applies is the verb's own call below, from the same
    // views `next` shows — a refreshed or cleared stop is no reason to refuse.
    const bound = recovery?.runId === run.id && run.generation === current.coordinatorGeneration;
    if (!bound) {
      finish("refused", "The coordinator report arrived after a newer coordinator episode or generation took over the task");
      return;
    }
    // The report binds to the task's progress when the coordinator was asked:
    // a stop that churns between a wait and a stop for one condition is not the
    // task moving on (consumer-b #639 refused every report that way, including a
    // correct reviewer route). A result, a head, a phase, a run or a route that
    // changed is; the reported verb is then stale (review #535). Episodes opened
    // before the digest existed keep the exact stop binding.
    // Same-review checkpoint evolution leaves this intent guard unchanged;
    // recovery revisits unfinished delivery separately from report staleness.
    const moved = !coordinatorReportMatches(current);
    if (moved) {
      finish("refused", "The task moved on since the coordinator was asked (its results, head, phase, run or routes changed)");
      return;
    }
    if (action.verb === "cannot") {
      // A coordinator can arrive while the retained worker is still processing
      // its own run. Observe that exact binding before treating its report as a
      // fault: the worker remains the owner of its result.
      const revision = current.resolution.currentRunId ? this.store.run(current.resolution.currentRunId) : null;
      const worker = current.phase === "working" && current.agentId && current.runId && current.workspaceId && !current.completion
        ? { id: current.runId, agentId: current.agentId, workspaceId: current.workspaceId, revision: false }
        : revision?.role === "revision" && !revision.released && !revision.completion && revision.agentId
          && ["running", "uncertain"].includes(revision.status) && revision.agentId === current.agentId
          && revision.workspaceId === current.workspaceId
          ? { id: revision.id, agentId: revision.agentId, workspaceId: revision.workspaceId, revision: true } : null;
      if (worker) {
        const observed = await this.engine.onTaskHost(current, () => this.engine.host.observe(worker.agentId)).catch(() => null);
        const latest = this.store.task(task.id), latestRun = worker.revision ? this.store.run(worker.id) : null;
        if (observed && observed.id === worker.agentId && observed.workspaceId === worker.workspaceId
          && !["closed", "error"].includes(observed.status) && latest.version === current.version
          && (!worker.revision || latestRun && !latestRun.released && !latestRun.completion
            && latestRun.agentId === worker.agentId && latestRun.workspaceId === worker.workspaceId
            && ["running", "uncertain"].includes(latestRun.status)) && coordinatorReportMatches(latest)) {
          finish("applied", `Waiting for worker run ${worker.id} to report`);
          return;
        }
      }
      // The coordinator cannot settle it: the owner decides. Escalating keeps
      // the stop from reopening another coordinator episode (consumer-b #639).
      finish("refused", action.reason);
      return;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const current = this.store.task(task.id);
      if (current.resolution.recovery?.runId !== run.id || run.generation !== current.coordinatorGeneration || !coordinatorReportMatches(current))
        throw new Error("The task moved on since the coordinator was asked (its results, head, phase, run or routes changed)");
      const stop = current.resolution.stop;
      // The shared plan must read the same authenticated reporting-run binding the
      // applied verb does, so a report's own delivering run is never its fence.
      const facts = collectOwnerVerbFacts(this.store, current, null, run.id);
      const verb = ownerVerb(action.verb);
      const plan = coordinatorActionPlan({ action, views: ownerVerbViews(facts), stopReason: stop?.reason,
        routeCost: action.verb === "route" ? this.store.pool().find(entry => entry.profileId === action.profileId)?.cost ?? null : null,
        routeCapability: action.verb === "route" ? this.store.pool().find(entry => entry.profileId === action.profileId)?.capability ?? null : null,
        usage: this.store.usageLevel(), verbRegistered: Boolean(verb) });
      if (!plan.ok) throw new Error(plan.refusal);
      const args = plan.args;
      await this.engine.coordinatorActionRunId.run(run.id,
        () => verb!.apply(input => this.engine.performTaskControl(input), args));
      finish("applied");
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only the explicit version refusal is safe to retry. Rebuild the plan
      // and recheck the report binding; never replay an uncertain effect.
      if (attempt === 0 && /^Task changed; refresh before (?:retrying|restarting) \(the task is now version \d+; read next again and reassess before retrying\)$/.test(message)) {
        this.store.event(task.id, "coordinator_action_version_retry", `${binding.eventId}: ${message}`);
        continue;
      }
      finish("refused", message);
      return;
    }
    }
    } finally { recoveryApplicationsInFlight.delete(claimKey); }
}
}
