import { boardDispatchHoldApplies } from "../../shared/board-dispatch-hold";
import type { Profile, Task } from "../../shared/contracts";
import { DEFAULT_GLOBAL_LIMIT, isDispositionActive, workerProfileIsExcluded } from "../../shared/contracts";
import { groupIsUnavailable } from '../../shared/pool';
import { capacityFor, dispatchBlocked, occupiesSlot, queuedVisits } from "./capacity";
import { PRE_DISPATCH_BASE_ADVANCE_LIMIT, queuedDispatchOrder, workspaceAdmissionGapMs, type Engine } from "../engine";
import { GitBulkCommandError } from "../git/index";
import { type GitTransientEpisode } from '../git/git-transient-backoff';
import { hookHoldReason, READ_ONLY_BASE_ADVANCED_KIND, type HookEmissionResult } from "../hooks/hooks";
import { LANE_PRIORITY_TASK } from "../scheduling/lane-priorities";
import type { Adapter } from "../host/adapter";
import { proofSingleFlightRefusal } from '../qa/proof-execution';
import { assertReviewEntryUnowned, assertReviewEntryWriterYielded, reviewEntryInputForTask, ReviewEntryRefusal, verifyReviewEntry, type ReviewEntryAdapter } from "../review/review-entry";
import { chooseProfile, eligibilityReasons } from "./routing";
import { WORKSPACE_POPULATE_BUDGET_MS } from "../workspaces/workspace-allocation";
import { worktreeLinksForBinding, worktreeLinksForIntent } from "../workspaces/worktree-links";
import { startsNoRuns } from "../closeout/queue-drain";

/** First dispatch stop, evaluated as each fact becomes available. */
export function dispatchGate(facts: { transientWaiting?: boolean; task?: Task; stopped?: boolean; paused?: boolean; dispatchHeld?: boolean; catalogKnown?: boolean; dependencyWait?: string; capacity?: string; selectionAvailable?: boolean }): string {
  if (facts.transientWaiting) return "transient";
  if (facts.task && (facts.task.phase !== "queued" || dispatchBlocked(facts.task) || isDispositionActive(facts.task))) return "task";
  if (facts.stopped || facts.paused) return "paused";
  if (facts.task && facts.dispatchHeld && boardDispatchHoldApplies(facts.task)) return "dispatch held";
  if (facts.catalogKnown === false) return "catalog";
  if (facts.dependencyWait) return "dependency";
  if (facts.capacity) return "capacity";
  if (facts.selectionAvailable === false) return "route";
  return "";
}

/** Decide whether host pressure delays a new workspace at this instant. */
export function decideWorkspacePressureWait(task: Pick<Task, 'workspaceId' | 'queuePriority'>, host: { load: number; cpus: number } | undefined, next: number, now: number): string {
  if (task.workspaceId || task.queuePriority > 0 || !host || host.load <= host.cpus || next <= now) return "";
  return `Workspace creation paced under host pressure (${host.load.toFixed(1)} load / ${host.cpus} CPUs); waiting for the admission gap to pass`;
}

export class Dispatch {
  /** The one armed wake for the durable workspace admission gap; see armWorkspacePressureWake. */
  private workspacePressureWake: { at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  constructor(readonly engine: Engine) {}
  stop() {
    if (this.workspacePressureWake) clearTimeout(this.workspacePressureWake.timer);
    this.workspacePressureWake = null;
  }
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  notePreDispatchHold(id: string, emission: HookEmissionResult) {
    const current = this.store.task(id);
    if (current.removedAt || current.phase !== "queued" || isDispositionActive(current)) return;
    // A gate superseded because main fast-forwarded under it answered nothing: stay
    // queued so the next pass mints a fresh gate at the new base. Bounded, so a base
    // that never holds still reaches a human.
    const advanced = emission.records.find(record => record.event === "task.pre_dispatch" && record.baseAdvance);
    if (advanced && this.store.events(id).filter(event => event.kind === READ_ONLY_BASE_ADVANCED_KIND).length <= PRE_DISPATCH_BASE_ADVANCE_LIMIT) {
      this.engine.note(id, "Integration base advanced during the pre-dispatch gate; re-running it at the new base", 'lifecycle');
      return;
    }
    this.engine.note(id, hookHoldReason(emission), 'operator_needed', "needs_attention");
  }
  async dispatchQueued(repoPath?: string): Promise<void> {
    const dispatchHeld = this.store.getMeta<boolean>("dispatchHeld") ?? false;
    const availability = this.store.availability();
    this.store.setRoutingEpoch(JSON.stringify([this.engine.profiles, this.store.pool(),
      availability.map(group => [group.group, groupIsUnavailable(group)]),
      this.store.usageLevel(), this.store.demandRoleOffsets()]));
    const limit = this.store.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT;
    const candidates = queuedDispatchOrder(this.store.readyQueueHeads(limit + 2, repoPath, dispatchHeld));
    await this.resolution.withDispatchPass(async () => {
      const visit = (candidate: Task) => this.engine.scheduleLane(`task:${candidate.id}`, LANE_PRIORITY_TASK, () => this.engine.dispatchTask(candidate.id, dispatchHeld));
      const { start, rest } = queuedVisits(candidates, this.store.activeCapacityTasks().filter(task => occupiesSlot(task)),
        this.store.projectDispatchLimitResolver(), this.store.papercutDispatchPolicy(), () => "none", limit);
      // Free slots start together, so one slow or stuck workspace doesn't hold up the next.
      // Each task has its own lane and the intent transaction re-checks capacity and the gap.
      const results = await Promise.allSettled(start.map(visit));
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw (failed as PromiseRejectedResult).reason;
      // Waiting for a slot is derived on read, not a reason to visit a task.
      void rest;
    });
  }
  workspacePressureWait(task: Task, host = this.adapter.hostLoad?.()): string {
    if (task.workspaceId || task.queuePriority > 0 || !host || host.load <= host.cpus) return "";
    return decideWorkspacePressureWait(task, host, this.store.getMeta<number>("workspacePressureNotBefore") ?? 0, Date.now());
  }
  armWorkspacePressureWake(): void {
    const next = this.store.getMeta<number>("workspacePressureNotBefore") ?? 0;
    const delay = next - Date.now();
    if (this.engine.stopped || delay <= 0) return;
    if (this.workspacePressureWake?.at === next) return;
    if (this.workspacePressureWake) clearTimeout(this.workspacePressureWake.timer);
    const timer = setTimeout(() => {
      this.workspacePressureWake = null;
      if (this.engine.stopped) return;
      void this.engine.cleanContext(() => this.engine.dispatchQueued()).catch(() => {});
    }, delay);
    timer.unref();
    this.workspacePressureWake = { at: next, timer };
  }
  async dispatchTask(taskId: string, dispatchHeld: boolean): Promise<void> {
    const hostId = this.store.task(taskId).hostId;
    if (hostId) return this.engine.withHost(hostId, () => this.dispatchTaskOnHost(taskId, dispatchHeld));
    return this.dispatchTaskOnHost(taskId, dispatchHeld);
  }
  private async dispatchTaskOnHost(taskId: string, dispatchHeld: boolean): Promise<void> {
    if (dispatchGate({ transientWaiting: this.engine.gitTransientWaiting(taskId) })) return;
    const transientBefore = this.store.getMeta<GitTransientEpisode | null>(this.engine.transientKey(taskId));
    const task = this.store.task(taskId);
    if (!this.engine.taskHostAvailable(task)) {
      // Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait): new dispatch
      // for a project on an unavailable host waits on that host too, with the
      // same named stop as work already in flight. A task with no proven host
      // identity keeps its own distinct wait.
      if (this.engine.hostWait(task)) return;
      const reason = task.hostId ? `Waiting for host ${task.hostId}` : "Waiting for a proven host identity";
      if (task.reason !== reason) this.store.update(task.id, { reason });
      return;
    }
    if (dispatchGate({ task })) return;
    if (dispatchGate({ stopped: this.engine.stopped, paused: this.engine.stopped ? false : this.store.getMeta<boolean>("paused") })) return;
    if (dispatchGate({ task, dispatchHeld })) return;
    if (dispatchGate({ catalogKnown: this.engine.profileCatalogKnown() })) return;
    const admission = this.engine.admission;
    const owned = admission ? this.store.activeCapacityTasks().filter(candidate => occupiesSlot(candidate) && candidate.workspaceId).length : 0;
    // Recover a missed release refresh before dispatch (Spec 028).
    const wasWaiting = task.dependsOn.length > 0 && !this.store.prerequisiteReleaseRefreshed(task.id);
    const dependencyWait = this.store.dependencyWait(task);
    if (dispatchGate({ dependencyWait })) return;
    // In-flight requests (reviews, revisions and verification) take free slots ahead
    // of never-dispatched work; queuePriority orders requests globally within each tier.
    const capacity = this.resolution.slotAdmissionReason(task);
    if (dispatchGate({ capacity })) return;
    // Intake admission creates only the first independent reviewer. Once that
    // review requests changes, the task follows ordinary Queue revision and
    // retained-review rotation in its existing workspace.
    if(task.entrypoint==="review"&&!task.agentId){
      await this.engine.dispatchReviewEntry(task);
      return;
    }
    const proofOnlyNeedsGo = task.entrypoint === 'proof' && Boolean(task.requiresOperatorGo);
    const unavailable = new Set(this.store.db.prepare("SELECT * FROM availability").all().flatMap(r => {
      const a = JSON.parse(String(r.data));
      return groupIsUnavailable(a) ? [a.group] : [];
    }));
    // The task's own host decides availability: profiles its catalog cannot
    // run (a thinking level or feature value it does not report) are kept out
    // of selection here instead of being refused at launch (nucleus#1139).
    const hostProfiles = this.engine.profilesFor(task.hostId);
    const workerProfiles=hostProfiles.filter(profile=>!workerProfileIsExcluded(task,profile.id));
    const selection = task.entrypoint === 'proof'
      ? this.resolution.select(task, proofOnlyNeedsGo ? 'reviewer' : 'executor')
      : chooseProfile(task, workerProfiles, this.store.pool(), this.store.counts(), unavailable,'worker',this.store.recentCounts(),this.store.usageLevel(), this.store.demandRoleOffsets(), true);
    if (dispatchGate({ selectionAvailable: Boolean(selection) })) { const availability=this.store.db.prepare("SELECT data FROM availability").all().map(row=>JSON.parse(String(row.data)));const reason=task.entrypoint === 'proof'
      ? `No eligible ${proofOnlyNeedsGo ? 'independent reviewer' : 'proof executor'} profile; check the profile pool`
      : eligibilityReasons(task,workerProfiles,this.store.pool(),availability,this.store.usageLevel(),hostProfiles);this.engine.note(task.id,task.workerExclusions.length?`No eligible worker remains after recorded exclusions: ${reason}`:reason, 'route_unavailable'); this.store.markRoutingAttempt(task.id); void this.engine.cleanContext(() => this.engine.wakeRepository(task.repoPath)); return; }
    if (!selection) return; // The route gate above handles this case.
    // Bounded workspace admission (Contract 007): a degraded Paseo or a full
    // Queue-owned workspace budget defers this creation plainly. No durable
    // creation intent is recorded, so the task stays queued and retries
    // instead of minting an uncertain workspace that needs attention.
    if (!task.workspaceId) {
      const pressure = this.engine.workspacePressureWait(task);
      if (pressure) { this.engine.armWorkspacePressureWake(); return; }
    }
    if (admission && !task.workspaceId) {
      const admitted = admission.workspaceAdmission(owned);
      if (!admitted.admitted) return;
    }
    if (wasWaiting) {
      await this.engine.refreshCheckoutSiblings(this.store.task(task.id), "prerequisite_release");
      this.store.event(task.id, "prerequisite_release_refreshed", "checkout siblings refreshed on prerequisite release");
    }
    try {
      if (!task.workspaceId) await this.adapter.preflightWorkspaceStorage?.(task);
      const base = await this.adapter.validate(task);
      if (transientBefore) this.store.deleteMeta(this.engine.transientKey(taskId));
      const latest = this.store.task(task.id);
      if (startsNoRuns(this.store, this.engine.stopped) || latest.phase !== "queued" || dispatchBlocked(latest) || latest.version !== task.version) return;
      const dependencyWait = this.store.dependencyWait(latest);
      if (dependencyWait) return;
      if (capacityFor(latest, this.store.activeCapacityTasks(), this.store.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT, this.store.projectDispatchLimitFor(latest), this.store.papercutDispatchPolicy())) return;
      const preDispatch = await this.engine.hooks.emit("task.pre_dispatch", latest, { event: "task.pre_dispatch", baseCommit: base, summary: latest.reason });
      if (preDispatch.hold) { this.engine.notePreDispatchHold(latest.id, preDispatch); return; }
      let loaded = "";
      let inFlightWait = "";
      let loadGuardSkipped = "";
      const admitted = this.store.transaction(() => {
        // Re-sample after awaited checks; pressure admission and its pacing marker
        // commit with the creation intent, so a roll cannot admit a second start.
        const host = !task.workspaceId ? this.adapter.hostLoad?.() : undefined;
        loaded = this.engine.workspacePressureWait(this.store.task(task.id), host);
        if (loaded) return false;
        // Re-check the current gate inside the single intent transaction:
        // a hold, disposition fence or capacity change that landed while the
        // remote base and hook checks ran must win over this dispatch.
        const current = this.store.task(task.id);
        if (current.version !== latest.version || startsNoRuns(this.store)) return false;
        if (current.phase !== "queued" || dispatchBlocked(current) || isDispositionActive(current)) throw new Error("Dispatch gate changed; this task is no longer dispatchable");
        inFlightWait = this.resolution.projectInFlightAdmissionReason(current);
        if (inFlightWait) return false;
        if (capacityFor(current, this.store.activeCapacityTasks(), this.store.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT, this.store.projectDispatchLimitFor(current), this.store.papercutDispatchPolicy())) throw new Error("Concurrent task-slot limit reached");
        this.store.update(task.id, { phase: "dispatching", profile: current.entrypoint === 'proof' ? null : selection.profile,
          profileGroup: current.entrypoint === 'proof' ? null : selection.entry.group, planningBase: base, workspaceIntent: true,
          ...worktreeLinksForIntent(current), reason: current.workspaceId ? "Dispatching in retained workspace" : "Creating isolated workspace" }, "dispatch_intent", selection.profile.name);
        this.store.chargeAssignment(selection.entry.group,selection.profile.id);
        this.store.noteGrantRun(current, "worker");
        // Recorded in the same transaction as the intent: an interruption can never leave the
        // durable dispatch intent without the priority override that admitted it.
        const gapMs = host ? workspaceAdmissionGapMs(host) : 0;
        if (host && gapMs > 0) {
          if (current.queuePriority > 0) loadGuardSkipped = `load guard skipped for promoted task; load ${host.load.toFixed(1)} over ${host.cpus} CPUs`;
          else {
            const nextAdmissionAt = Date.now() + gapMs;
            this.store.setMeta("workspacePressureNotBefore", nextAdmissionAt);
            this.store.event(task.id, "workspace_pressure_admitted", JSON.stringify({ load: host.load, cpus: host.cpus, gapMs, nextAdmissionAt }));
          }
        }
        if (loadGuardSkipped) this.store.event(task.id, "load_guard_skipped", loadGuardSkipped);
        return true;
      });
      // An admission that set a gap, or a pacing refusal, arms the wake that starts the next task at its end.
      this.engine.armWorkspacePressureWake();
      if (loaded) return;
      if (inFlightWait) return;
      if (!admitted) return;
      const prepared = this.store.task(task.id);
      if (!prepared.workspaceId) {
        let freshlyPopulated = false;
        if (this.adapter.populateTaskWorktree) {
          const started = Date.now();
          this.store.event(task.id, "workspace_populate_started", JSON.stringify({
            budgetMs: WORKSPACE_POPULATE_BUDGET_MS, branch: prepared.branch,
          }));
          try {
            const populated = await this.adapter.populateTaskWorktree(prepared);
            freshlyPopulated = populated.populated;
            this.store.event(task.id, "workspace_populate_finished", JSON.stringify({
              budgetMs: populated.budgetMs || WORKSPACE_POPULATE_BUDGET_MS, elapsedMs: populated.elapsedMs, outcome: "ok", populated: populated.populated,
            }));
          } catch (error) {
            const detail = error instanceof GitBulkCommandError
              ? { budgetMs: error.budgetMs, elapsedMs: error.elapsedMs, outcome: error.timedOut ? "timedOut" : "failed",
                  timedOut: error.timedOut, killed: error.killed, exitCode: error.exitCode, signal: error.signal }
              : { budgetMs: WORKSPACE_POPULATE_BUDGET_MS, elapsedMs: Date.now() - started, outcome: "failed" };
            this.store.event(task.id, "workspace_populate_finished", JSON.stringify(detail));
            throw error;
          }
        }
        const workspace = await this.adapter.createWorkspace(prepared, { freshlyPopulated });
        this.store.update(task.id, { workspaceId: workspace.id, directory: workspace.directory, ...worktreeLinksForBinding(this.store.task(task.id), { workspaceId: workspace.id, directory: workspace.directory }) }, "workspace_created", workspace.id);
      }
      if (!this.engine.stopped) {
        const current = this.store.task(task.id);
        if (current.entrypoint === 'proof') await this.engine.launchProofOnly(current, selection.profile);
        else await this.engine.launchAgent(current);
      }
      // The workspace exists now: project its title from the recorded phase.
      this.engine.enqueueTitle(task.id);
    } catch (error) { this.engine.noteStepFailure(task.id, error); }
  }
  async launchProofOnly(task: Task, selectedProfile?: Profile): Promise<void> {
    if (task.entrypoint !== 'proof' || !task.proofOnly) throw new Error('Proof-only launch requires an immutable merged commit');
    const priorProofRun = this.store.runs(task.id).find(run => run.role === 'executor' || run.role === 'reviewer');
    if (priorProofRun && this.resolution.suppressAutomaticRetry(task, 'proof_reactivation',
      `Prior proof run ${priorProofRun.id} at ${priorProofRun.head} ended ${priorProofRun.completion?.status ?? priorProofRun.status}; ${priorProofRun.completion?.summary ?? 'no completion was recorded'}`,
      priorProofRun.id)) return;
    // Task 560: single-flight. The reservation transaction owns the launch,
    // so a rival intent that landed first owns the task: this trigger returns
    // quietly and the restart path and the advance loop never mint a second
    // executor for the same task and head.
    if (proofSingleFlightRefusal(task, this.store.runs(task.id), task.proofOnly.commit)) return;
    const selection = selectedProfile ? { profile: selectedProfile } : this.resolution.select(task, task.requiresOperatorGo ? 'reviewer' : 'executor');
    if (!selection) {
      this.engine.note(task.id, `No eligible ${task.requiresOperatorGo ? 'independent reviewer' : 'proof executor'} profile; check the profile pool`, 'route_unavailable');
      return;
    }
    try {
      if (task.requiresOperatorGo) await this.resolution.launch(task, 'reviewer', { profile: selection.profile });
      else await this.resolution.proofExecution(task, {
        authorizedBy: { role: 'queue_dispatch', caller: null, note: 'Proof-only task promoted with a brief-named qualification' }, operationId: null,
      }, selection.profile);
    } catch (error) {
      // A concurrent trigger won the reservation between the check above and
      // the transaction: its intent owns the task, so this trigger stands down.
      if (error instanceof Error && /already dispatched and unreleased|already spent its one execution|already reserved at/.test(error.message)) return;
      throw error;
    }
  }
  dispatchReviewEntry(task:Task):Promise<void>{
    return this.engine.performReviewEntryAdmission(task);
  }
  async performReviewEntryAdmission(task:Task):Promise<void>{
    if(!task.reviewEntry||!this.adapter.inspectReviewEntry||!this.adapter.originAgent)throw Error('Review-entry task is missing immutable provenance or adapter support');
    // Task 405: an unreleased run (including a proof executor finishing its turn)
    // owns the workspace; review admission waits for it to be observed and released.
    if(this.store.runs(task.id).some(run => !run.released))return;
    if(!this.resolution.select(task,'reviewer')){this.engine.note(task.id,`No eligible independent reviewer profile; check the profile pool${this.resolution.requiredRouteNote(task,'reviewer')||this.resolution.usageCeilingNote(task,'reviewer')}`, 'route_unavailable');this.store.markRoutingAttempt(task.id);void this.engine.cleanContext(() => this.engine.wakeRepository(task.repoPath));return;}
    const input=reviewEntryInputForTask(task);
    try{
      const target=this.adapter as Adapter&ReviewEntryAdapter;
      if (!task.originHostId) { if(task.reason!=='Waiting for a proven origin host')this.engine.note(task.id,'Waiting for a proven origin host','lifecycle'); return; }
      if (!this.engine.withHost(task.originHostId,()=>this.engine.hostAvailable(task.originHostId!))) { const reason=`Waiting for origin host ${task.originHostId}`;if(task.reason!==reason)this.engine.note(task.id,reason,'lifecycle');return; }
      const reviewAdapter = task.originHostId === task.hostId ? target : new Proxy(target, { get: (adapter, property, receiver) => {
        if (property !== 'inspectReviewEntry') return Reflect.get(adapter, property, receiver);
        return async (reviewInput: typeof input, taskId?: string) => {
          const proof = await this.engine.withHost(task.originHostId!, async () => {
            const origin = await this.engine.host.originAgent(reviewInput.submission.originAgentId);
            if (!origin || origin.archived || !origin.workspaceId) throw new Error('Review entry requires a live originating thread');
            return { origin, state: await this.engine.host.observe(origin.id) };
          });
          return adapter.inspectReviewEntry(reviewInput,taskId,proof);
        };
      } });
      const proof=await verifyReviewEntry(input,reviewAdapter,{allowBaseAdvance:true,taskId:task.id});
      const latest=this.store.task(task.id);
      if(latest.phase!=="queued"||dispatchBlocked(latest)||isDispositionActive(latest)||startsNoRuns(this.store))return;
      const dependencyWait=this.store.dependencyWait(latest);if(dependencyWait)return;
      const capacity=capacityFor(latest,this.store.activeCapacityTasks(),this.store.getMeta<number>("globalLimit")??DEFAULT_GLOBAL_LIMIT,this.store.projectDispatchLimitFor(latest), this.store.papercutDispatchPolicy());
      if(capacity)return;
      const preDispatch=await this.engine.hooks.emit("task.pre_dispatch",latest,{event:"task.pre_dispatch",baseCommit:proof.base,summary:latest.reason});
      if(preDispatch.hold){this.engine.notePreDispatchHold(latest.id,preDispatch);return;}
      // The writer observation inside verifyReviewEntry bounds acceptance only:
      // it precedes the awaited hook and canonical proofs above. Admission is the
      // execution decision, so the writer's yield is re-proved here as the last
      // awaited proof before the admission write. A writer that resumed during
      // those proofs keeps the task queued with its visible wait instead of
      // promising independent review.
      try{await assertReviewEntryWriterYielded(input,reviewAdapter,task.id);}
      catch(error){
        if(error instanceof ReviewEntryRefusal&&error.transient){this.engine.note(task.id,error.message,'origin_busy');return;}
        throw error;
      }
      const dependencyRace=this.store.transaction(()=>{
        const current=this.store.task(task.id);
        if(current.phase!=="queued"||dispatchBlocked(current)||isDispositionActive(current))throw Error('Review-entry admission changed before binding');
        if(this.store.runs(current.id).some(run => !run.released))throw Error('Review-entry admission changed before binding');
        if(startsNoRuns(this.store))return null;
        const wait=this.store.dependencyWait(current);if(wait)return wait;
        assertReviewEntryUnowned(this.store,input,current.id);
        if(capacityFor(current,this.store.activeCapacityTasks(),this.store.getMeta<number>("globalLimit")??DEFAULT_GLOBAL_LIMIT,this.store.projectDispatchLimitFor(current), this.store.papercutDispatchPolicy()))throw Error('Concurrent task-slot limit reached');
        this.store.update(current.id,{phase:"awaiting_review",planningBase:proof.base,reviewEntry:{...current.reviewEntry!,dispatchBase:proof.base},reason:"Review entry admitted; awaiting independent review"},"review_entry_admitted",proof.head);
        return null;
      });
      void dependencyRace;
    }catch(error){
      // A transient admission condition (an active origin or workspace turn)
      // waits in `queued` with its reason instead of parking the task in
      // needs_attention; the next admission pass retries and the wait clears
      // itself once the condition ends. The pending handover this task was
      // accepted under is a source-writer wait: it has no owner verb, because
      // only the writer yielding clears it. A foreign Queue ownership conflict
      // is not transient and still parks.
      if(error instanceof ReviewEntryRefusal&&error.transient){
        this.engine.note(task.id,error.message,error.code==='workspace_busy'?'origin_busy':'classify');return;}
      this.engine.noteStepFailure(task.id,error);
    }
  }
}
