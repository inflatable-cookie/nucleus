import { randomBytes, randomUUID } from "node:crypto";
import { workerProfileIsExcluded } from "../../shared/contracts";
import type { Task } from "../../shared/contracts";
import { currentBrief } from "../planning/brief";
import { CheckoutUnavailableError } from "../workspaces/checkout-volume";
import { dispatchBlocked, DISPATCH_HELD_REASON } from "./capacity";
import type { Engine } from "../engine";
import { isPiSettingsLockFailure, isRateLimitError, rateLimitCooldownData, transientProviderRetryAt } from "../recovery/exhaustion";
import { workerPrompt } from "./prompts";
import { runTicketPath } from "./agent-creation";
import { ABSENT_WORKER_REASON, PRE_AGENT_LAUNCH_FAILURE_REASON, PROFILE_CATALOG_PENDING_REASON } from "../recovery/task-reasons";
import { startsNoRuns } from "../closeout/queue-drain";

/**
 * Creates a task's worker once: one creation per task at a time, one run identity
 * for it, then the agent. Same-name `Engine` methods delegate here. `store`,
 * `adapter` and `resolution` read the engine per call: tests replace the adapter.
 */
export class WorkerLauncher {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  private readonly workerCreations = new Map<string, Promise<void>>();
  async launchAgent(task: Task) {
    const existing = this.workerCreations.get(task.id);
    if (existing) return existing;
    // Record a failed proof before releasing the shared attempt, so another
    // lane cannot start a new proof in the gap before the caller records it.
    const creation = this.engine.launchAgentOnce(task).catch(error => { this.engine.noteStepFailure(task.id,error); throw error; });
    this.workerCreations.set(task.id,creation);
    try { await creation; } finally { if (this.workerCreations.get(task.id) === creation) this.workerCreations.delete(task.id); }
  }
  async launchAgentOnce(task: Task) {
    if (startsNoRuns(this.store, this.engine.stopped)) return;
    task = this.store.task(task.id);
    if (dispatchBlocked(task)) { this.store.update(task.id, { reason: DISPATCH_HELD_REASON }); return; }
    // A dispatching task resumed after a restart reaches here without dispatchTask;
    // its route and escalation proofs read the catalog, so wait for it (review #565).
    if (!this.engine.profileCatalogKnown()) { this.resolution.waiting(task, PROFILE_CATALOG_PENDING_REASON, 'lifecycle'); return; }
    if (!task.directory || !task.workspaceId || !task.profile) throw new Error("Missing workspace or route");
    task = await this.engine.ensureSiblings(task);
    task = await this.engine.refreshCheckoutSiblings(task, "worker_creation");
    let worktreeLinkRecordFailure: string | null;
    ({ task, recordFailure: worktreeLinkRecordFailure } = await this.engine.prepareWorktreeLinks(task));
    if (!task.directory || !task.workspaceId || !task.profile) throw new Error("Missing workspace or route");
    // Keep the source and authority observed before awaited creation proofs.
    task=structuredClone(this.store.task(task.id));
    if (!task.directory || !task.workspaceId || !task.profile) return;
    if(dispatchBlocked(task)){this.store.update(task.id,{reason:DISPATCH_HELD_REASON});return;}
    if(!task.agentIntent&&!task.agentId&&!task.runId&&task.profile&&workerProfileIsExcluded(task,task.profile.id)){
      const reason=`Selected worker profile ${task.profile.id} is excluded; Nucleus will reselect before worker creation`;
      this.store.update(task.id,{phase:"queued",profile:null,profileGroup:null,failoverReason:"",reason},"excluded_worker_dispatch_refused",reason);
      return;
    }
    for (const old of task.retiredWorkers) {
      const state = await this.engine.host.observe(old.agentId);
      if (state.workspaceId !== task.workspaceId || state.active || state.permissions || !["idle","error","closed"].includes(state.status)) throw new Error("Previous worker has not released the continuation workspace");
    }
    let branch: string;
    // A continuation keeps the retained worktree's work: after a retired worker,
    // or after a gone author's replacement, verify it as a continuation.
    if (task.retiredWorkers.length || task.continuesWorkspace) {
      if (!this.adapter.verifyResume) throw new Error("Adapter cannot verify continuation worktrees");
      await this.adapter.verifyResume(task); branch = task.branch;
    } else branch = await this.adapter.verifyWorkspace(task, task.directory);
    const stash = await this.engine.readStash(task.directory);
    if (startsNoRuns(this.store, this.engine.stopped)) return;
    const token = randomBytes(32).toString("hex");
    // Spec 050 `restart`: a proven-absent creation that recorded its run identity
    // is restarted under that same run, never a second one.
    const runId = this.store.task(task.id).restartRunId ?? randomUUID();
    const owns = this.store.transaction(() => {
      const current = this.store.task(task.id);
      // Contract 003: one worker creation mints exactly one run identity. The
      // caller's snapshot predates the workspace or continuation verification
      // above, so the launch gate is rechecked inside this transaction: a
      // concurrent launcher for the same creation yields here instead of
      // overwriting task.runId or issuing a second credential and agent. The
      // context checks fail closed when the task was replaced under this
      // snapshot (a new workspace, route or retired-worker set).
      if (!current.agentIntent&&!current.agentId&&!current.runId&&current.profile&&workerProfileIsExcluded(current,current.profile.id)){
        const reason=`Selected worker profile ${current.profile.id} is excluded; Nucleus will reselect before worker creation`;
        this.store.update(current.id,{phase:"queued",profile:null,profileGroup:null,failoverReason:"",reason},"excluded_worker_dispatch_refused",reason);
        return false;
      }
      if(dispatchBlocked(current)){this.store.update(current.id,{reason:DISPATCH_HELD_REASON});return false;}
      if (startsNoRuns(this.store, this.engine.stopped)) return false;
      const restartingRun=Boolean(current.restartRunId&&current.runId===current.restartRunId&&!current.agentId&&!current.agentIntent);
      if (current.agentIntent || current.agentId || (current.runId && !restartingRun) ||
        (restartingRun && current.restartRunId !== runId) ||
        current.workspaceId !== task.workspaceId || current.retiredWorkers.length !== task.retiredWorkers.length ||
        current.profile?.id !== task.profile?.id) return false;
      this.store.setCredential(runId, token);
      // Spec 020: the worker run records the Queue-held brief version it is given.
      const brief = currentBrief(current);
      // Spec 026: linked lane documents are pinned at first dispatch; every worker run records what it was given.
      const pins = this.store.laneDocumentPinsFor(current) ?? current.laneDocumentPins;
      this.store.update(task.id, { branch, runId, ...(this.adapter.runTemporaryDirectory ? { temporaryDirectory: this.adapter.runTemporaryDirectory(runId, current) } : {}), restartRunId: null, transientProviderRetry: undefined, agentIntent: true, reason: "Creating worker", stashBaseline: stash ? { runId, entries: stash } : null,
        ...(brief ? { briefRuns: [...current.briefRuns, { runId, version: brief.version }] } : {}),
        ...(pins?.length ? { laneDocumentPins: pins, laneDocumentRuns: [...current.laneDocumentRuns ?? [], { runId, documents: pins.map(({ key, version, digest }) => ({ key, version, digest })) }] } : {}) }, "agent_intent", runId);
      return true;
    });
    if (!owns) return;
    const prepared = this.store.task(task.id);
    try {
      const helper = this.adapter.helperPath;
      const ticket = helper && prepared.runId ? runTicketPath({ helperPath: helper }, prepared.runId) : undefined;
      const agent = await this.adapter.createAgent(prepared, token, workerPrompt(prepared, Boolean(this.adapter.reportingViaMcp), this.store.runs(prepared.id), worktreeLinkRecordFailure, helper, ticket),workerPrompt(prepared,false, this.store.runs(prepared.id), worktreeLinkRecordFailure, helper, ticket));
      this.store.update(task.id, { agentId: agent.id }, "agent_created", agent.id);
      if (agent.workspaceId !== task.workspaceId) throw new Error("Worker returned in the wrong workspace; inspect before proceeding");
    } catch (error) {
      // The adapter proves the checkout volume before issuing its native create. Its typed
      // refusal is therefore a definite pre-send failure, not an unknown agent.
      if (error instanceof CheckoutUnavailableError) {
        const current = this.store.task(task.id);
        if (current.agentIntent && !current.agentId && current.runId === runId) this.store.transaction(() => {
          this.store.deleteCredential(runId);
          this.store.update(task.id, { agentIntent: false, restartRunId: runId,
            briefRuns: current.briefRuns.filter(item => item.runId !== runId),
            laneDocumentRuns: (current.laneDocumentRuns ?? []).filter(item => item.runId !== runId) }, 'agent_create_storage_deferred');
        });
        throw error;
      }
      // Record the exact-lookup window now: automatic reconciliation owns the fault before any coordinator can engage.
      this.resolution.ensureIncident(this.store.task(task.id), null, ABSENT_WORKER_REASON, 'exact_lookup');
      const detail=error instanceof Error?error.message:String(error);
      const current=this.store.task(task.id);
      // Task 646: a 429 at creation paces the provider group (short cool-down
      // in capacity state so new launches prefer other profiles) and requeues
      // this task instead of parking it: a burst of rate-limited launches must
      // spread, not fill the failed list.
      if (isRateLimitError(detail) && current.profileGroup) {
        const row = this.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get(current.profileGroup) as { data: string } | undefined;
        const cooldown = rateLimitCooldownData(row?.data, detail, current.profileGroup);
        this.store.transaction(() => {
          this.store.setAvailability(current.profileGroup!, cooldown);
          if (current.runId) this.store.deleteCredential(current.runId);
          this.store.update(current.id, { phase: 'queued', profile: null, profileGroup: null, agentIntent: false, runId: null,
            transientProviderRetry: undefined, reason: `Rate-limited at launch; requeued to pace group ${current.profileGroup}` },
            'rate_limit_launch_paced', `worker launch paced: ${detail.slice(0, 1200)}`);
        });
        return;
      }
      const retryAlreadyUsed=this.store.events(task.id).some(event=>event.kind==='absent_worker_retry');
      if(isPiSettingsLockFailure(detail)&&!retryAlreadyUsed&&current.agentIntent&&!current.agentId&&current.runId){
        const retry={runId:current.runId,resumes:0,status:'waiting' as const,error:detail.slice(0,2000),retryAt:transientProviderRetryAt(detail,0),messageId:null,resumedAt:null,observedUpdatedAt:null,sawProgress:false};
        this.store.update(task.id,{phase:'dispatching',reason:PRE_AGENT_LAUNCH_FAILURE_REASON,transientProviderRetry:retry},'transient_provider_retry_scheduled',`worker launch: one creation retry at ${retry.retryAt}; ${detail.slice(0,1200)}`);
        return;
      }
      throw error;
    }
    this.store.update(task.id, { phase: "working", reason: "Worker running" });
  }
}
