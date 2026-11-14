import type { Engine } from '../engine';
import type { Profile, Task } from '../../shared/contracts';
import { DEFAULT_GLOBAL_LIMIT, isDispositionActive, workerProfileIsExcluded } from '../../shared/contracts';
import { unavailableGroups } from '../../shared/pool';
import { capacityRefusal, dispatchBlocked, occupiesSlot } from './capacity';
import { workspaceAdmissionGapMs } from '../engine';
import { GitBulkCommandError } from '../git/index';
import type { GitTransientEpisode } from '../git/git-transient-backoff';
import { WORKSPACE_POPULATE_BUDGET_MS } from '../workspaces/workspace-allocation';
import { worktreeLinksForBinding, worktreeLinksForIntent } from '../workspaces/worktree-links';
import { startsNoRuns } from '../closeout/queue-drain';
import type { Resolution } from '../resolution';
import { chooseProfile, eligibilityReasons } from './routing';
import { dispatchGate } from './dispatch-decisions';

/** The engine facts one first dispatch reads; review admission is a peer owner, not a nested dispatch. */
export type FirstDispatchContext = Pick<Engine,
  'adapter' | 'admission' | 'armWorkspacePressureWake' | 'cleanContext' | 'enqueueTitle' | 'gitTransientWaiting' | 'hooks'
  | 'launchAgent' | 'launchProofOnly' | 'note' | 'notePreDispatchHold' | 'noteStepFailure' | 'profileCatalogKnown' | 'profilesFor'
  | 'refreshCheckoutSiblings' | 'stopped' | 'store' | 'taskHostAvailable' | 'transientKey' | 'wakeRepository' | 'withHost'
  | 'workspacePressureWait'> & {
    readonly resolution: Pick<Resolution, 'projectInFlightAdmissionReason' | 'select' | 'slotAdmissionReason'>;
  };
/** A review-entry task is admitted by its own owner, never by the worker launcher. */
export type FirstDispatchPorts = { reviewEntryAdmission(task: Task): Promise<void> };

/**
 * First dispatch: the one path that turns a queued task into a workspace, a
 * dispatch intent and a launched run. Every stop is a dispatch-gate fact read as
 * it becomes available, every capacity question goes through `capacityRefusal`,
 * and the intent transaction re-checks each fact after its awaits so a roll,
 * hold or capacity change that landed meanwhile always wins.
 */
export class FirstDispatch {
  constructor(readonly context: FirstDispatchContext, readonly ports: FirstDispatchPorts) {}
  get store() { return this.context.store; }
  get adapter() { return this.context.adapter; }
  get resolution() { return this.context.resolution; }
  async dispatch(taskId: string, dispatchHeld: boolean): Promise<void> {
    const hostId = this.store.task(taskId).hostId;
    if (hostId) return this.context.withHost(hostId, () => this.dispatchOnHost(taskId, dispatchHeld));
    return this.dispatchOnHost(taskId, dispatchHeld);
  }
  private async dispatchOnHost(taskId: string, dispatchHeld: boolean): Promise<void> {
    if (dispatchGate({ transientWaiting: this.context.gitTransientWaiting(taskId) })) return;
    const transientBefore = this.store.getMeta<GitTransientEpisode | null>(this.context.transientKey(taskId));
    const task = this.store.task(taskId);
    if (!this.context.taskHostAvailable(task)) {
      const reason = task.hostId ? `Waiting for host ${task.hostId}` : "Waiting for a proven host identity";
      if (task.reason !== reason) this.store.update(task.id, { reason });
      return;
    }
    if (dispatchGate({ task })) return;
    if (dispatchGate({ stopped: this.context.stopped, paused: this.context.stopped ? false : this.store.getMeta<boolean>("paused") })) return;
    if (dispatchGate({ task, dispatchHeld })) return;
    if (dispatchGate({ catalogKnown: this.context.profileCatalogKnown() })) return;
    const admission = this.context.admission;
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
    if (task.entrypoint === "review" && !task.agentId) {
      await this.ports.reviewEntryAdmission(task);
      return;
    }
    const proofOnlyNeedsGo = task.entrypoint === 'proof' && Boolean(task.requiresOperatorGo);
    // One availability read for this dispatch: selection and its refusal text
    // read the same instant, so a refusal never names a different pool state.
    const availability = this.store.availability();
    const unavailable = unavailableGroups(availability);
    // The task's own host decides availability: profiles its catalog cannot
    // run (a thinking level or feature value it does not report) are kept out
    // of selection here instead of being refused at launch (nucleus#1139).
    const hostProfiles = this.context.profilesFor(task.hostId);
    const workerProfiles = hostProfiles.filter(profile => !workerProfileIsExcluded(task, profile.id));
    const selection = task.entrypoint === 'proof'
      ? this.resolution.select(task, proofOnlyNeedsGo ? 'reviewer' : 'executor')
      : chooseProfile(task, workerProfiles, this.store.pool(), this.store.counts(), unavailable, 'worker', this.store.recentCounts(), this.store.usageLevel(), this.store.demandRoleOffsets(), true);
    if (dispatchGate({ selectionAvailable: Boolean(selection) })) {
      const reason = task.entrypoint === 'proof'
        ? `No eligible ${proofOnlyNeedsGo ? 'independent reviewer' : 'proof executor'} profile; check the profile pool`
        : eligibilityReasons(task, workerProfiles, this.store.pool(), availability, this.store.usageLevel(), hostProfiles);
      this.context.note(task.id, task.workerExclusions.length ? `No eligible worker remains after recorded exclusions: ${reason}` : reason, 'route_unavailable');
      this.store.markRoutingAttempt(task.id);
      void this.context.cleanContext(() => this.context.wakeRepository(task.repoPath));
      return;
    }
    if (!selection) return; // The route gate above handles this case.
    // Bounded workspace admission (Contract 007): a degraded Paseo or a full
    // Queue-owned workspace budget defers this creation plainly. No durable
    // creation intent is recorded, so the task stays queued and retries
    // instead of minting an uncertain workspace that needs attention.
    if (!task.workspaceId) {
      const pressure = this.context.workspacePressureWait(task);
      if (pressure) { this.context.armWorkspacePressureWake(); return; }
    }
    if (admission && !task.workspaceId) {
      const admitted = admission.workspaceAdmission(owned);
      if (!admitted.admitted) return;
    }
    if (wasWaiting) {
      await this.context.refreshCheckoutSiblings(this.store.task(task.id), "prerequisite_release");
      this.store.event(task.id, "prerequisite_release_refreshed", "checkout siblings refreshed on prerequisite release");
    }
    try {
      if (!task.workspaceId) await this.adapter.preflightWorkspaceStorage?.(task);
      const base = await this.adapter.validate(task);
      if (transientBefore) this.store.deleteMeta(this.context.transientKey(taskId));
      const latest = this.store.task(task.id);
      if (startsNoRuns(this.store, this.context.stopped) || latest.phase !== "queued" || dispatchBlocked(latest) || latest.version !== task.version) return;
      const dependencyWait = this.store.dependencyWait(latest);
      if (dependencyWait) return;
      if (capacityRefusal(this.store, latest)) return;
      const preDispatch = await this.context.hooks.emit("task.pre_dispatch", latest, { event: "task.pre_dispatch", baseCommit: base, summary: latest.reason });
      if (preDispatch.hold) { this.context.notePreDispatchHold(latest.id, preDispatch); return; }
      let loaded = "";
      let inFlightWait = "";
      let loadGuardSkipped = "";
      const admitted = this.store.transaction(() => {
        // Re-sample after awaited checks; pressure admission and its pacing marker
        // commit with the creation intent, so a roll cannot admit a second start.
        const host = !task.workspaceId ? this.adapter.hostLoad?.() : undefined;
        loaded = this.context.workspacePressureWait(this.store.task(task.id), host);
        if (loaded) return false;
        // Re-check the current gate inside the single intent transaction:
        // a hold, disposition fence or capacity change that landed while the
        // remote base and hook checks ran must win over this dispatch.
        const current = this.store.task(task.id);
        if (current.version !== latest.version || startsNoRuns(this.store)) return false;
        if (current.phase !== "queued" || dispatchBlocked(current) || isDispositionActive(current)) throw new Error("Dispatch gate changed; this task is no longer dispatchable");
        inFlightWait = this.resolution.projectInFlightAdmissionReason(current);
        if (inFlightWait) return false;
        if (capacityRefusal(this.store, current)) throw new Error("Concurrent task-slot limit reached");
        this.store.update(task.id, { phase: "dispatching", profile: current.entrypoint === 'proof' ? null : selection.profile,
          profileGroup: current.entrypoint === 'proof' ? null : selection.entry.group, planningBase: base, workspaceIntent: true,
          ...worktreeLinksForIntent(current), reason: current.workspaceId ? "Dispatching in retained workspace" : "Creating isolated workspace" }, "dispatch_intent", selection.profile.name);
        this.store.chargeAssignment(selection.entry.group, selection.profile.id);
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
      this.context.armWorkspacePressureWake();
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
      if (!this.context.stopped) {
        const current = this.store.task(task.id);
        if (current.entrypoint === 'proof') await this.context.launchProofOnly(current, selection.profile);
        else await this.context.launchAgent(current);
      }
      // The workspace exists now: project its title from the recorded phase.
      this.context.enqueueTitle(task.id);
    } catch (error) { this.context.noteStepFailure(task.id, error); }
  }
}
