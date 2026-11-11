import type { Resolution } from '../resolution';
import type { Task } from "../../shared/contracts";
import { holdsOf, isDispositionActive } from "../../shared/contracts";
import type { Engine } from "../engine";
import { isPiSettingsLockFailure } from "./exhaustion";
import { worktreeLinksForBinding, worktreeLinksForClearedIntent } from "../workspaces/worktree-links";
import { retainNodeModules, workspaceCreationRefusal } from "../workspaces/workspace-allocation";
import { startsNoRuns } from "../closeout/queue-drain";
import { ABSENT_WORKER_REASON, ABSENT_WORKER_REPLACEMENT_REASON, PRE_AGENT_LAUNCH_FAILURE_REASON } from "./task-reasons";

/** Facts needed before an unowned workspace creation may be replayed. A parked
 * refusal for this exact classified state stands where the dispatching phase
 * would: the stop exists because the proven orphan was not yet removed, its
 * detail names the replay as the exit, and nothing else holds the task — so the
 * same recovery path clears it and replays once (nucleus#1106). */
export function workspaceReplayAllowed(task: Task, kind: string, canRemoveOrphan: boolean, hasRuns: boolean, replayRecorded: boolean, parkedRefusal?: string | null): boolean {
  const parked = task.phase === 'needs_attention' && !task.resolution.attention && !holdsOf(task).dispatch
    && Boolean(parkedRefusal) && task.resolution.stop?.detail === parkedRefusal;
  return (kind === 'absent' || kind === 'partial' && canRemoveOrphan) &&
    (task.phase === 'dispatching' || parked) && !task.agentIntent && !task.agentId && !task.runId && !task.completion &&
    !task.prUrl && !task.prHead && !task.resolution.recoveryActive && !task.resolution.attention &&
    (!task.resolution.incident || task.resolution.incident.status === 'resolved') &&
    (!task.resolution.recovery || task.resolution.recovery.status === 'resolved') && !hasRuns && !replayRecorded;
}

/** Choose the next absent-worker step from facts available at this point.
 * A missing replacement budget requests that read only after the grace gate. */
export function absentWorkerStep(facts: { launchRetry: boolean; retryDue: boolean; matches: number; graceElapsed: boolean; replacementSpent?: boolean }):
  'wait' | 'launch_retry' | 'read_budget' | 'escalate' | 'ambiguous' | 'replace' {
  if (facts.launchRetry && facts.matches === 0) return facts.retryDue ? 'launch_retry' : 'wait';
  if (!facts.graceElapsed) return 'wait';
  if (facts.replacementSpent === undefined) return 'read_budget';
  if (facts.replacementSpent) return 'escalate';
  if (facts.matches > 1) return 'ambiguous';
  return 'replace';
}

export type CreationRecoveryContext = Pick<Engine, 'adapter' | 'idleGraceMs' | 'launchAgent' | 'launchProofOnly' | 'note' | 'reconcileAbsentWorker' | 'recoverProofOnlyDispatch' | 'stopped' | 'store'>
  & { readonly resolution: Pick<Resolution, 'ensureIncident' | 'resolveIncident' | 'resumeAbsentWorker' | 'returnToDispatch' | 'saveIncident'> };

export class CreationRecovery {
  constructor(readonly engine: CreationRecoveryContext) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  async recover(task: Task) {
    if (task.entrypoint === 'proof' && task.proofOnly) {
      await this.engine.recoverProofOnlyDispatch(task);
      return;
    }
    if (!task.workspaceId) {
      await this.adapter.preflightWorkspaceStorage?.(task);
      const found = await this.adapter.findWorkspaces(task);
      if (found.length > 1) { this.engine.note(task.id, "Ambiguous workspace identity; no new resource created", 'workspace_unavailable', "needs_attention"); return; }
      if (found.length === 1) {
        this.store.update(task.id, { workspaceId: found[0]!.id, directory: found[0]!.directory, phase: "dispatching",
          ...worktreeLinksForBinding(this.store.task(task.id), { workspaceId: found[0]!.id, directory: found[0]!.directory }) }, "workspace_recovered", found[0]!.id);
        if (!startsNoRuns(this.store, this.engine.stopped)) await this.engine.launchAgent(this.store.task(task.id));
        return;
      }
      const classified = await this.adapter.inspectWorkspaceCreation!(task);
      if (classified.kind === "found_done") {
        // Binding a workspace findWorkspaces already returned is settlement.
        // createWorkspace is a start, even when the classifier says found_done.
        if (startsNoRuns(this.store, this.engine.stopped)) return;
        const workspace = await this.adapter.createWorkspace(task);
        this.store.update(task.id, { workspaceId: workspace.id, directory: workspace.directory, phase: "dispatching",
          ...worktreeLinksForBinding(this.store.task(task.id), { workspaceId: workspace.id, directory: workspace.directory }) }, "workspace_recovered", workspace.id);
        if (!startsNoRuns(this.store, this.engine.stopped)) await this.engine.launchAgent(this.store.task(task.id));
        return;
      }
      // A single replay is safe only after the complete classifier proves no
      // published or changed work and no worker or recovery owns the intent.
      if (workspaceReplayAllowed(task, classified.kind, classified.kind === 'partial' ? Boolean(this.adapter.removeOrphanWorkspace) : false, false, false, workspaceCreationRefusal(classified)) &&
          !this.store.runs(task.id).length && !this.store.eventsAll(task.id).some(event => event.kind === "workspace_creation_auto_replay")) {
        const current = this.store.task(task.id);
        if (current.version !== task.version || startsNoRuns(this.store, this.engine.stopped)) return;
        // Record before removing anything: a crash or uncertain removal cannot
        // authorize another automatic attempt.
        this.store.event(task.id, "workspace_creation_auto_replay", classified.kind);
        if (classified.kind === "partial") {
          await this.adapter.removeOrphanWorkspace!(task, classified.orphan);
          this.store.event(task.id, "orphan_workspace_removed", JSON.stringify(classified.orphan));
        }
        const latest = this.store.task(task.id);
        if (latest.version !== current.version || startsNoRuns(this.store, this.engine.stopped)) return;
        const cleared = worktreeLinksForClearedIntent(latest);
        if (cleared.worktreeLinks) this.store.update(latest.id, cleared);
        this.resolution.returnToDispatch(this.store.task(task.id), false, "Workspace creation proved empty; replaying once", "workspace_creation_replayed");
        return;
      }
      this.engine.note(task.id, workspaceCreationRefusal(classified), 'operator_needed', "needs_attention");
      return;
    } else if (task.agentIntent && !task.agentId) {
      const found = await this.adapter.findAgents(task);
      if (found.length === 1 && found[0].workspaceId === task.workspaceId) {
        const latest = this.store.task(task.id);
        // Another reconciliation may have bound or replaced this intent while
        // lookup was in flight. Its newer state owns the task; do not park it.
        if (!latest.agentIntent || latest.agentId || latest.runId !== task.runId) return;
        this.resolution.resolveIncident(latest, task.runId, 'Exact lookup bound the created worker');
        this.store.update(task.id, { agentId: found[0].id, phase: "working", reason: "Recovered worker identity" }, "agent_recovered", found[0].id);
        return;
      }
      await this.engine.reconcileAbsentWorker(this.store.task(task.id), found.length);
    }
  }
  /** Reconcile a proof-only provisioning intent and resume only its proof route. */
  async recoverProofOnlyDispatch(task: Task): Promise<void> {
    let workspace = task.workspaceId && task.directory ? { id: task.workspaceId, directory: task.directory } : null;
    if (workspace && task.proofOnly && this.adapter.populateTaskWorktree) {
      const checkout = await this.adapter.populateTaskWorktree(task);
      if (checkout.directory !== workspace.directory)
        throw new Error(`The recorded proof-only workspace is ${workspace.directory}, but its checkout is ${checkout.directory}`);
    }
    if (!workspace) {
      // Reconcile the detached checkout before binding a workspace discovered by
      // catalog lookup. Otherwise a reused registration can bypass the proof
      // head check and admit the executor from whatever commit it currently has.
      if (task.proofOnly && this.adapter.populateTaskWorktree)
        await this.adapter.populateTaskWorktree(task);
      const found = await this.adapter.findWorkspaces(task);
      if (found.length > 1) { this.engine.note(task.id, 'Ambiguous workspace identity; no new resource created', 'workspace_unavailable', 'needs_attention'); return; }
      if (found.length === 1) workspace = found[0]!;
      else {
        const state = this.adapter.inspectWorkspaceCreation ? await this.adapter.inspectWorkspaceCreation(task) : null;
        if (state && state.kind !== 'absent' && state.kind !== 'found_done') {
          this.engine.note(task.id, workspaceCreationRefusal(state), 'operator_needed', 'needs_attention'); return;
        }
        // A transport interruption may have happened before the detached worktree
        // or Paseo registration became visible. Re-enter the same idempotent
        // provisioning steps; createWorkspace will recover a completed registration.
        if (startsNoRuns(this.store, this.engine.stopped)) return;
        if (state?.kind === 'absent' && this.adapter.populateTaskWorktree) await this.adapter.populateTaskWorktree(task);
        if (!this.adapter.createWorkspace) throw new Error('Proof-only workspace provisioning is unavailable');
        workspace = await this.adapter.createWorkspace(task);
      }
      const current = this.store.task(task.id);
      this.store.update(task.id, { workspaceId: workspace.id, directory: workspace.directory,
        phase: 'dispatching', ...worktreeLinksForBinding(current, { workspaceId: workspace.id, directory: workspace.directory }) }, 'workspace_recovered', workspace.id);
    }
    if (task.proofOnly && workspace) retainNodeModules(task.repoPath, workspace.directory);
    if (!startsNoRuns(this.store, this.engine.stopped)) await this.engine.launchProofOnly(this.store.task(task.id));
  }
  /** Zero/one/many worker-creation reconciliation: after the bounded grace, exactly one replacement, then coordinator attention. */
  async reconcileAbsentWorker(t: Task, matches: number) {
    const incident = this.resolution.ensureIncident(t, null, ABSENT_WORKER_REASON, 'exact_lookup');
    const launchRetry=t.transientProviderRetry?.runId===t.runId&&t.transientProviderRetry.status==='waiting'&&t.transientProviderRetry.resumes===0&&isPiSettingsLockFailure(t.transientProviderRetry.error)?t.transientProviderRetry:null;
    const firstStep = absentWorkerStep({ launchRetry: Boolean(launchRetry), retryDue: launchRetry && matches === 0 ? !(Date.now() < Date.parse(launchRetry.retryAt ?? '')) : false, matches, graceElapsed: false });
    if(firstStep === 'launch_retry' && launchRetry){
      try{
        if(t.removedAt||isDispositionActive(t))throw new Error('Task is no longer reconcilable');
        if(!t.workspaceId||!t.directory||!t.profile||!t.runId)throw new Error('Pre-agent launch retry requires the retained workspace, profile and run intent');
        if(t.completion||t.prUrl||t.prHead||t.resumePrNumber||t.resolution.currentRunId||t.resolution.mergeIntent)throw new Error('Pre-agent launch retry requires untouched initial dispatch state');
        this.engine.note(t.id,PRE_AGENT_LAUNCH_FAILURE_REASON, 'operator_needed', 'needs_attention');
        const failed=this.store.task(t.id);
        await this.adapter.verifyWorkspace(failed,failed.directory!);
        const latest=this.store.task(failed.id);
        if(latest.version!==failed.version||latest.reason!==PRE_AGENT_LAUNCH_FAILURE_REASON||latest.runId!==failed.runId||!latest.agentIntent||latest.agentId||latest.transientProviderRetry?.runId!==failed.runId||latest.transientProviderRetry.status!=='waiting'||latest.transientProviderRetry.resumes!==0||!isPiSettingsLockFailure(latest.transientProviderRetry.error))throw new Error('Task changed during pre-agent launch retry verification');
        this.adapter.purgeReportingFiles?.(latest.id,[latest.runId!]);
        this.store.transaction(()=>{
          this.resolution.resumeAbsentWorker(latest,'Confirmed absent Pi launch after settings-lock race; Nucleus issued one retry');
          this.resolution.saveIncident(this.store.task(latest.id),{action:'replacement',attempt:incident.attempt+1,detail:'Pre-agent settings-lock failure was exact-looked-up; one retry issued'});
        });
      }catch(error){this.engine.note(t.id,error instanceof Error?error.message:String(error), 'classify', 'needs_attention');}
      return;
    }
    if (launchRetry && matches === 0) return;
    if (absentWorkerStep({ launchRetry: false, retryDue: false, matches, graceElapsed: !(Date.now() - Date.parse(incident.createdAt) < this.engine.idleGraceMs) }) === 'wait') return;
    const current = this.store.task(t.id);
    // Durable replacement budget: one recorded worker replacement means the next absence escalates.
    const step = absentWorkerStep({ launchRetry: false, retryDue: false, matches, graceElapsed: true, replacementSpent: this.store.events(t.id).some(event => event.kind === 'absent_worker_retry') });
    if (step === 'escalate') {
      const reason = ABSENT_WORKER_REPLACEMENT_REASON;
      this.engine.note(current.id, reason, 'operator_needed', 'needs_attention');
      this.resolution.ensureIncident(current, null, reason);
      return;
    }
    if (step === 'ambiguous') {
      const reason = `Worker creation lookup is ambiguous (${matches} matching agents); no resource was created`;
      this.engine.note(current.id, reason, 'operator_needed', 'needs_attention');
      this.resolution.ensureIncident(current, null, reason);
      return;
    }
    try {
      if (current.removedAt || isDispositionActive(current)) throw new Error('Task is no longer reconcilable');
      if (!current.workspaceId || !current.directory || !current.profile || !current.runId) throw new Error('Absent worker replacement requires the retained workspace, profile and run intent');
      if (current.completion || current.prUrl || current.prHead || current.resumePrNumber || current.resolution.currentRunId || current.resolution.mergeIntent) throw new Error('Absent worker replacement requires untouched initial dispatch state');
      this.engine.note(current.id, ABSENT_WORKER_REASON, 'operator_needed', 'needs_attention');
      await this.adapter.verifyWorkspace(current, current.directory);
      const latest = this.store.task(current.id);
      if (!latest.agentIntent || latest.agentId || latest.runId !== current.runId) throw new Error('Task changed during absent-worker verification');
      this.adapter.purgeReportingFiles?.(current.id, [current.runId]);
      this.store.transaction(() => {
        this.store.deleteCredential(current.runId!);
        this.resolution.resumeAbsentWorker(latest, 'Confirmed absent worker; Nucleus issued one replacement creation');
        const incident = current.resolution.incident;
        if (incident) this.resolution.saveIncident(this.store.task(latest.id), { action: 'replacement', attempt: incident.attempt + 1, detail: 'Proven-absent worker callback revoked; one replacement issued' });
      });
    } catch (error) {
      this.engine.note(current.id, error instanceof Error ? error.message : String(error), 'classify', 'needs_attention');
    }
  }
}
