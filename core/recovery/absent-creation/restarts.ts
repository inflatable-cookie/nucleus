import { type Run, type Task } from '../../../shared/contracts';
import { now } from '../../store/store';
import { ABSENT_WORKER_REASON, PRE_AGENT_LAUNCH_FAILURE_REASON, ABSENT_WORKER_REPLACEMENT_REASON, ABSENT_RESOLUTION_REASON, resolutionCreationRoles } from '../task-reasons';
import { isDispositionActive, isDispositionComplete } from '../../../shared/contracts';
import { isPiSettingsLockFailure } from '../exhaustion';
import { taskPrNumber } from '../../forge/index';
import type { Resolution } from '../../resolution';
import { absentReplacementRecord, absentReplacementSpent } from './budget';
import { provenAbsentCreation } from './decisions';

/** Recreate proven-absent runs and workers under their same identities. */
export type AbsentRestartsContext = Pick<Resolution, 'adapter' | 'attention' | 'ensureIncident' | 'graceMs' | 'paused' | 'recordIncidentEvent' | 'resolveIncident' | 'resumeWorkerContinuation' | 'settleVerbFences' | 'store' | 'update' | 'waiting'>;

/**
 * The resolution-side half of absence: admit and replay a proven-absent worker
 * creation, recreate one proven-absent reviewer, closeout or executor run under
 * the SAME run id, and issue exactly one same-role replacement. The engine-side
 * half, which owns workspace creation and the worker-absence observations, is
 * `CreationRecovery` in `creation.ts`; the budget both read is `budget.ts`.
 */
export class AbsentRestarts {
  constructor(readonly resolution: AbsentRestartsContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get graceMs() { return this.resolution.graceMs; }

  /**
   * Mint one worker in the retained workspace for a proven-absent creation.
   *
   * `authorized` is the operator path: it also accepts the post-replacement escalation the
   * automatic budget writes, because the state is recoverable and only the automatic path's
   * budget should stop it. Automatic and recovery callers keep the initial reason only, so
   * the one-replacement budget stays exactly one and a later automatic absence still
   * escalates. The event differs, so an operator replacement is visible as such and never
   * counts as the automatic retry.
   */
  admitAbsentWorker(t:Task,instruction:string,authorized=false,settleRunIds:string[]=[]): string {
    const retry=t.transientProviderRetry;
    const preAgentFailure=t.reason===PRE_AGENT_LAUNCH_FAILURE_REASON&&retry?.runId===t.runId&&retry.status==='waiting'&&retry.resumes===0&&isPiSettingsLockFailure(retry.error);
    const accepted=authorized?[ABSENT_WORKER_REASON,ABSENT_WORKER_REPLACEMENT_REASON]:[ABSENT_WORKER_REASON];
    if(t.phase!=='needs_attention'||(!accepted.includes(t.reason)&&!preAgentFailure)||!t.agentIntent||t.agentId||!t.runId||!t.workspaceId||!t.directory||!t.profile)
      throw Error('Absent-worker retry requires a retained creation intent with no worker');
    if(t.prerequisiteWait && !t.prerequisiteWait.releasedAt)
      throw new Error('Task is waiting for its retained prerequisites; wait for the owner notice or clear the wait');
    if(t.completion||t.prUrl||t.prHead||t.resolution.currentRunId||t.resolution.mergeIntent||t.resolution.mergedCommit)
      throw Error('Absent-worker retry cannot replace accepted work, PR, resolution, or merge state');
    if(this.store.runs(t.id).some(r=>r.role!=='recovery'&&!r.released&&!settleRunIds.includes(r.id)))throw Error('Absent-worker retry has an unresolved task run');
    const action=instruction.trim();if(!action)throw Error('Worker resume requires an explicit instruction');
    return action;
  }

  resumeAbsentWorker(t:Task,instruction:string,authorized=false){
    const action=this.admitAbsentWorker(t,instruction,authorized);
    return this.resolution.resumeWorkerContinuation(t,authorized,current=>{
      this.store.deleteCredential(current.runId!);
      // Spec 050 `restart`: keep the run identity and mark it, so the launcher
      // reuses it for the retried creation instead of minting a second run.
      return this.store.update(current.id,{agentIntent:false,runId:current.runId,restartRunId:current.runId,transientProviderRetry:undefined,phase:'dispatching',reason:'Confirmed absent worker; creating a worker in the retained workspace',resolution:{...current.resolution,pendingWorkerInstruction:action}},authorized?'absent_worker_operator_replacement':'absent_worker_retry',action);
    });
  }

  absentResolutionRun(t:Task){
    const run=t.resolution.currentRunId?this.store.run(t.resolution.currentRunId):null;
    if(!run||run.released||run.agentId||run.completion||run.status!=='uncertain'||!resolutionCreationRoles.has(run.role))return null;
    return run;
  }

  admitAbsentResolution(t:Task,runId:string,settleRunIds:string[]=[]): Run {
    const current=t;
    const run=this.absentResolutionRun(current);
    if(!run||run.id!==runId)throw Error('Absent resolution-run recovery requires an uncertain reviewer or coordinator creation with no agent');
    if(!current.workspaceId||!current.directory)throw Error('Absent resolution-run recovery requires the retained task workspace');
    if(run.taskId!==current.id||current.workspaceId!==run.workspaceId)throw Error('Absent resolution-run identity or workspace changed');
    if(current.resolution.mergeIntent&&!current.resolution.mergedCommit)throw Error('Absent resolution-run recovery cannot replace an uncertain merge intent');
    if(run.role!=='closeout'&&current.resolution.mergedCommit)throw Error('Absent resolution-run recovery cannot replace a merged PR');
    if(this.store.runs(current.id).some(r=>r.id!==run.id&&r.role!=='recovery'&&!r.released&&!settleRunIds.includes(r.id)))throw Error('Absent resolution-run recovery has another unresolved task run');
    return run;
  }

  /**
   * Spec 050 `restart` on a proven-absent resolution run: settle the run as
   * released history and let the ordinary launch create a fresh run from the
   * role's current route. The recorded creation payload is never replayed, so a
   * profile that changed provider since the intent is what launches. The new
   * run has its own identity and creation intent. The caller has already run the
   * exact lookup and read it as zero matches.
   */
  replaceAbsentRunFromRoute(t: Task, runId: string, instruction: string | null, settleFences?: { detail: string; runIds: string[]; displacedRunIds?: string[] }): Task {
    if (this.resolution.paused()) throw Error('Nucleus is paused; absent run replacement is deferred');
    const settling = settleFences ? [...settleFences.runIds, ...(settleFences.displacedRunIds ?? [])] : [];
    return this.store.transaction(() => {
      const current = this.store.task(t.id), run = this.store.run(runId);
      if (current.version !== t.version || current.resolution.currentRunId !== runId || !run || run.released || run.agentId || run.status !== 'uncertain')
        throw Error('Absent run changed during restart; refresh before retrying');
      this.admitAbsentResolution(current, runId, settling);
      if (settleFences) this.resolution.settleVerbFences(t.id, settleFences);
      this.releaseAbsentRun(current, runId, `restart ${run.role}${instruction ? `: ${instruction.slice(0, 80)}` : ''}`);
      const phase = run.role === 'reviewer' ? 'awaiting_review' : run.role === 'executor' ? (run.proofExecution?.returnPhase ?? 'awaiting_review') : 'closing';
      return this.resolution.update(this.store.task(t.id), { currentRunId: null, attention: false },
        { phase, reason: `Absent ${run.role} creation settled; a fresh ${run.role} run launches from the current route` },
        'absent_creation_routed', `${run.role}:${run.id}`);
    });
  }

  /**
   * Release one unreleased, agentless uncertain creation as settled history:
   * its credential is revoked so a late callback cannot authenticate, the run is
   * superseded and released, and its incident resolves. Nothing is archived or
   * stopped, because no thread exists. The caller proves the absence first; the
   * route and restart paths both do. Writes only inside the caller's transaction.
   */
  releaseAbsentRun(t: Task, runId: string, detail: string): void {
    const run = this.store.run(runId);
    if (!run || run.released || run.agentId || run.status !== 'uncertain') throw Error('Only an uncertain creation with no agent can be released as absent');
    this.store.deleteCredential(run.id);
    this.store.putRun({ ...run, status: 'superseded', released: true, active: false, absentProvenAt: run.absentProvenAt ?? now() });
    this.store.event(t.id, 'absent_creation_released', `${run.role}:${run.id}: ${detail}`);
    this.resolution.resolveIncident(this.store.task(t.id), run.id, `Absent ${run.role} creation released: ${detail}`);
  }

  /**
   * Zero/one/many reconciliation for one uncertain creation. After the bounded
   * grace: bind one exact match (done by the caller), replace a proven-absent
   * creation exactly once, or hand ambiguity and second failures to the coordinator.
   */
  async reconcileAbsentCreation(t: Task, run: Run, found: { id: string; workspaceId: string | null }[]) {
    if (isDispositionActive(t) || isDispositionComplete(t)) return;
    // A creation already proved absent is settled: nothing re-looks it up, reopens its incident or escalates again.
    if (provenAbsentCreation(this.store.run(run.id) ?? run)) return;
    const incident = this.resolution.ensureIncident(t, run, ABSENT_RESOLUTION_REASON, 'exact_lookup');
    if (Date.now() - Date.parse(incident.createdAt) < this.graceMs) return;
    const current = this.store.task(t.id);
    // The replacement budget is durable: one recorded same-role replacement means the next absence settles as absent for the owner.
    if (absentReplacementSpent(this.store.events(t.id), run.role)) {
      if (found.length) {
        this.resolution.attention(current, `${run.role} creation lookup found ${found.length} matching agents; no resource was created`);
        return;
      }
      this.settleAbsentProof(current, run);
      return;
    }
    if (found.length > 0) {
      this.resolution.attention(current, `${run.role} creation lookup is ambiguous (${found.length} matching agents); no resource was created`);
      return;
    }
    try {
      await this.replaceAbsentCreation(current, run);
    } catch (error) {
      this.resolution.attention(this.store.task(t.id), `Absent ${run.role} creation could not be replaced safely: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Record that an exact lookup proved this uncertain creation produced no agent,
   * once the replacement budget is spent. The run keeps its lease until an owner
   * control releases it, but observation stops looking it up and the effect no
   * longer blocks other verbs. The task names the owner controls that replace it.
   */
  settleAbsentProof(t: Task, run: Run): void {
    this.store.transaction(() => {
      const latest = this.store.run(run.id);
      if (!latest || latest.released || latest.agentId || latest.absentProvenAt) return;
      this.store.putRun({ ...latest, absentProvenAt: now() });
      this.store.event(t.id, 'absent_creation_proven', `${run.role}:${run.id}`);
    });
    // The exact-lookup window has ended with an absence: the incident records that and stops asking for a retry.
    this.resolution.resolveIncident(this.store.task(t.id), run.id, 'Exact lookup proved no agent; the creation settled as absent');
    // A wait, not attention: the coordinator's own creation runs on the same host that never answered, so the owner replaces this run instead.
    this.resolution.waiting(this.store.task(t.id), `A replacement ${run.role} creation also proved absent after an exact lookup; route now or restart fresh replaces it from the current route`, 'lifecycle', { suggestedVerbs: ['route', 'restart'] });
  }

  /** Atomically revoke one proven-absent callback and issue exactly one same-role replacement. */
  async replaceAbsentCreation(t: Task, run: Run) {
    if (isDispositionActive(t) || isDispositionComplete(t)) return;
    if (t.removedAt) throw new Error('Task was removed from the queue');
    if (!t.workspaceId || !t.directory) throw new Error('Absent run replacement requires the retained task workspace');
    if (t.resolution.mergeIntent && !t.resolution.mergedCommit) throw new Error('Absent run replacement cannot replace an uncertain merge intent');
    if (run.role !== 'closeout' && t.resolution.mergedCommit) throw new Error('Absent run replacement cannot replace a merged PR');
    if (this.adapter.workspaceAvailable && !await this.adapter.workspaceAvailable(t.workspaceId)) throw new Error('Absent run replacement requires the retained task workspace');
    if (run.role === 'closeout') {
      if (!this.adapter.verifyCleanQueueWorktree) throw new Error('Workspace verification is unavailable');
      await this.adapter.verifyCleanQueueWorktree(t);
    } else {
      const pr = await this.adapter.verifyPr(t, taskPrNumber(t));
      if (pr.head !== t.prHead || pr.head !== run.head) throw new Error('PR head changed; inspect it before replacing the absent run');
    }
    const current = this.store.task(t.id);
    if (isDispositionActive(current) || isDispositionComplete(current)) return;
    const live = current.resolution.currentRunId ? this.store.run(current.resolution.currentRunId) : null;
    if (!live || live.id !== run.id || live.agentId || live.completion || live.released) throw new Error('Task changed during absent-run reconciliation');
    this.adapter.purgeReportingFiles?.(t.id, [run.id]);
    this.store.transaction(() => {
      this.store.deleteCredential(run.id);
      this.store.putRun({ ...run, status: 'superseded', released: true });
      const incident = current.resolution.incident!;
      const phase = run.role === 'reviewer' ? 'awaiting_review' : run.role === 'executor' ? (run.proofExecution?.returnPhase ?? 'awaiting_review') : 'closing';
      const reason = `Confirmed absent ${run.role} creation; Nucleus issued one replacement`;
      this.resolution.update(current, {
        currentRunId: null, attention: false,
        incident: { ...incident, action: 'replacement', attempt: incident.attempt + 1, detail: `Proven-absent ${run.role} callback revoked; one replacement issued`, status: 'reconciling', updatedAt: now() },
      }, { phase, reason }, 'absent_creation_replaced', absentReplacementRecord(run.role, run.id, reason));
      this.resolution.recordIncidentEvent(current.id, { ...incident, action: 'replacement', attempt: incident.attempt + 1, status: 'reconciling', updatedAt: now() });
    });
  }
}
