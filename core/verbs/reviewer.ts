import { archiveReplacedReviewer, threadArchivedOrGone } from '../workspaces/thread-archive';
import { incidentBindsCurrentWork, type Run, type Task, type TaskControlInput } from "../../shared/contracts";
import type { Engine } from "../engine";
import { isReviewerRelaunchTarget, plainHandoverFreshRestart, RestartRefusal, settledReviewerHistory, unreleasedLaunchFence } from "./owner-verbs";
import { reviewerIdentityAtHead } from "../review/review-continuation";
import { DurableFenceRefusal, matchingInactiveParticipant } from "../intake/run-settlement";
import type { AgentObservation } from "../host/adapter";
import { digest, now } from "../store/store";

/**
 * The owner verbs that keep or replace a task's reviewer: continuing the retained
 * reviewer from its checkpoint, preserving a valid reader through a move, and
 * restarting review. Same-name `Engine` methods delegate here.
 */
export class ReviewerControls {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  /**
   * One retained-reviewer continuation: the ordinary admission and delivery
   * path shared by `restart role=reviewer` and a `move to=review` that preserves
   * the valid reader it found (Tom, 2026-10-27). The caller owns the shape and
   * the deferrable control; this is the only place a reviewer continuation is
   * admitted and sent, so a preserved reader never gets a second send path.
   */
  async continueRetainedReviewer(task: Task, options: {
    version: number; reason: string; instruction: string; ownerStopYields: boolean;
    deferrable: TaskControlInput; verb: "restart" | "move";
  }, operationId?: string): Promise<Task> {
    const reason = options.reason, instruction = options.instruction, version = options.version;
    const run = task.resolution.currentRunId ? this.store.run(task.resolution.currentRunId) : null;
    const checkpoint = run?.reviewCheckpoints?.at(-1);
    if (!run || run.role !== "reviewer" || !checkpoint) throw Error("The reviewer checkpoint is no longer current");
    // A bound run continues under pause; dispatch holds still fence delivery.
    const wait = this.engine.dispatchWaitsFor(task, options.ownerStopYields, true);
    if (wait) return this.engine.deferOwnerVerb(task, options.deferrable, wait, { runId: run.id, checkpointOrdinal: checkpoint.ordinal, head: run.head });
    const continuation = { taskId: task.id, version, runId: run.id, head: run.head, checkpointOrdinal: checkpoint.ordinal, reason, instruction, ownerStopYields: options.ownerStopYields };
    const operation = operationId ?? `${options.verb === "move" ? "move-review" : "restart"}-${digest(`${task.id}:${version}:${run.id}:${checkpoint.ordinal}`).slice(0, 40)}`;
    // Spec 050 (#3569): finished runs of other roles settle by observation
    // before the run fence; one that cannot settle refuses here, with its
    // own reason and nothing written. Check this before inspecting an existing
    // delivery too: replay evidence cannot bypass a separate unknown run fence.
    const finished = await this.engine.collectVerbFinishedRuns(task.id, run => run.role === "reviewer" || run.id === this.engine.openEpisodeRunId(task.id));
    if (finished.fenced.length) throw new DurableFenceRefusal(this.engine.verbRunFenceRefusal(finished.fenced[0]!));
    const inspected = await this.resolution.inspectReviewContinuation(continuation, operation);
    if (inspected) return inspected;
    const runIds = finished.settleable.map(item => item.id);
    // The episode this checkpoint awaits is settled by the continuation
    // itself, so its reporting coordinator run never fences it. Planning does
    // not cancel: the whole continuation admission runs first.
    const displacement = await this.engine.planEpisodeDisplacement(task.id, version, `${options.verb} reviewer`);
    // Only an incident bound to the current work suppresses the continuation's
    // own fence settlement: one recorded against a released run was superseded
    // by the run that replaced it (papercuts 89643af2, 6ff5e903).
    const reconciling = incidentBindsCurrentWork(task, this.store.runs(task.id)) && task.resolution.incident?.status === "reconciling";
    const detail = `${options.verb === "move" ? "move review" : "restart reviewer"}: ${reason}`;
    const admitted = { ...continuation, ...(reconciling ? {} : { settleFences: { detail, runIds, displacedRunIds: displacement.runIds } }) };
    return this.engine.control(() => this.engine.executeEpisodeRestart(task.id, displacement, async () => {
      await this.resolution.admitReviewContinuation(admitted, operation);
      return () => this.resolution.continueReview(admitted, operation);
    }, runIds), `task:${task.id}`);
  }

  /**
   * `move to=review` preserving a valid reader it must not replace (Tom,
   * 2026-10-27, decision 029a631e): the reader keeps its lease, its checkpoints
   * and its delivered turn, the fences the move supersedes settle with it, and
   * no review message is sent. Reading, reserved or already-delivered work sends
   * nothing merely because no verdict exists.
   */
  async preserveRetainedReviewer(input: { taskId: string; version: number; reason: string; caller?: string }, task: Task, reader: Run,
    pr: { url: string; head: string }, finished: { settleable: Run[] }, state: string): Promise<Task> {
    const displacement = await this.engine.planEpisodeDisplacement(task.id, input.version, "move review");
    return this.engine.control(() => this.engine.executeEpisodeRestart(task.id, displacement, async () => {
      this.engine.requireOwnerControlCurrent(this.store.task(task.id), input.version, "Task changed; refresh before retrying");
      return () => this.store.transaction(() => {
        const latestTask = this.store.task(task.id);
        this.engine.requireOwnerControlCurrent(latestTask, input.version, "Task changed; refresh before retrying");
        const latest = this.store.run(reader.id);
        if (!latest || latest.released || latest.completion || latest.head !== pr.head || latest.agentId !== reader.agentId
          || latestTask.resolution.currentRunId !== latest.id)
          throw Error("The retained reviewer changed during the move; refresh before retrying");
        // Recheck the one identity result at the commit boundary: a source,
        // receipt or brief binding that changed after the observation is refused
        // here, before anything is preserved or replaced.
        const recheck = reviewerIdentityAtHead(latestTask, this.store, pr.head);
        if (recheck.kind === 'refused') throw Error(recheck.refusal);
        this.engine.settleVerbFences(task.id, { detail: `move review: ${input.reason}`, runIds: finished.settleable.map(run => run.id), displacedRunIds: displacement.runIds });
        const settled = this.store.task(task.id);
        return this.store.update(settled.id, { prHead: pr.head, prUrl: pr.url, phase: "reviewing",
          reason: `Owner move to review preserved retained reviewer ${latest.id} (agent ${latest.agentId}) at ${latest.head}; no new review turn was sent: ${input.reason}`.slice(0, 2000),
          resolution: { ...settled.resolution, currentRunId: latest.id, pendingReviewReason: input.reason, attention: false, recoveryActive: false },
        }, input.caller ? "move_review_retained" : "owner_control",
        JSON.stringify({ verb: "move", to: "review", preserved: latest.id, head: pr.head,
          checkpointOrdinal: latest.reviewCheckpoints?.at(-1)?.ordinal ?? null, continuation: state, reason: input.reason }));
      });
    }, finished.settleable.map(run => run.id)), `task:${task.id}`);
  }

  /**
   * Restart a reviewer on the retained agent or a fresh agent: release any stopped or
   * checkpointed reviewer run without a verdict, keeping its history, and
   * return the task to `awaiting_review` so the ordinary selection launches the
   * next reviewer at the same exact head.
   */
  async restartReview(taskId: string, reason: string, instruction: string, fresh = true): Promise<Task> {
    const currentRunId = this.store.task(taskId).resolution.currentRunId;
    const uncertainReviewer = currentRunId ? this.store.run(currentRunId) : null;
    if (fresh && uncertainReviewer?.role === 'reviewer' && uncertainReviewer.status === 'uncertain' && uncertainReviewer.agentId)
      await this.resolution.reconcileArchivedReviewerDispatch(taskId, uncertainReviewer.id);
    // Spec 050 (#3569): finished runs of other roles settle by observation
    // before the live-run check; a run that cannot settle keeps fencing the
    // ordinary paths. A superseded reviewer run is history, never this restart's
    // relaunch target: its lease goes through the same fence settlement (or is
    // reported), so the archive proof and every durable effect keep their own
    // rules. The task's own current run stays this restart's subject. The
    // settlement lands inside the restart's transaction, so a refused restart
    // changes nothing.
    const finished = await this.engine.collectVerbFinishedRuns(taskId, run =>
      (run.role === "reviewer" && !(settledReviewerHistory(run) && run.id !== currentRunId))
      || run.id === this.engine.openEpisodeRunId(taskId));
    if (finished.fenced.length) throw new DurableFenceRefusal(this.engine.verbRunFenceRefusal(finished.fenced[0]!));
    // The coordinator episode this stopped review waits on settles with the same
    // restart instead of fencing it. It is planned here and cancelled only after
    // the live-reviewer checks below, so a refused restart does not interrupt it.
    const displacement = await this.engine.planEpisodeDisplacement(taskId, this.store.task(taskId).version, "restart reviewer");
    return this.engine.control(() => this.engine.executeEpisodeRestart(taskId, displacement, async () => {
      // A live reviewer turn is not a restart target: releasing its lease while
      // the agent is still working would orphan the run. Refuse instead, so the
      // owner stops the turn (or routes with `now`) first.
      const before = this.store.task(taskId), runsBefore = this.store.runs(taskId);
      if(!fresh){const refusal=plainHandoverFreshRestart(before,runsBefore);if(refusal)throw new RestartRefusal(refusal);}
      // The reader a relaunch keeps is never a superseded run: superseded work is
      // history whatever its lease says, and its lease is settled (or reported)
      // by the fence collection above. Prefer the task's current reader, then the
      // latest unreleased reader, then the latest reader this restart may act on.
      const candidates = this.store.runs(taskId).filter(isReviewerRelaunchTarget);
      const live = (before.resolution.currentRunId ? candidates.find(candidate => candidate.id === before.resolution.currentRunId) : undefined)
        ?? candidates.findLast(candidate => !candidate.released) ?? candidates.at(-1) ?? null;
      // The run this restart may release is the reader it keeps, else the task's
      // own current reviewer even when that is superseded history. A superseded
      // run is no relaunch target, but its lease still guards durable effects and
      // callback authority, so the fence and the liveness proof below apply to it
      // exactly as they do to a kept reader.
      const currentRun = before.resolution.currentRunId ? this.store.run(before.resolution.currentRunId) : null;
      const lease = live ?? (currentRun?.role === 'reviewer' && !currentRun.completion ? currentRun : null);
      // A same-agent restart keeps the task's recorded reviewer while its thread
      // can still take a turn; that binding belongs to the task, not to a
      // superseded run. With no reader left there is nothing to observe here.
      const retainedAgent = live?.agentId ?? before.resolution.reviewerAgentId ?? null;
      const retainedProfile = live?.profile ?? before.resolution.reviewerProfile ?? null;
      if (!fresh && (!retainedAgent || !retainedProfile)) throw Error("Same-agent reviewer restart requires a retained reviewer; use fresh");
      const observe = async () => {
        // A durable side effect is never released by a restart, whoever owns the
        // run: unknown or pending delivery, a blocking recovery effect or an
        // unsettled authenticated delivery keeps its callback authority.
        if (lease && !lease.released) {
          const why = this.engine.runDurableFence(this.store.task(taskId), this.store.run(lease.id) ?? lease);
          if (why) throw new DurableFenceRefusal(this.engine.displaceRefusal({ run: lease, why }));
        }
        if (lease && lease.role === 'reviewer' && !lease.completion) {
          if (!lease.agentId) throw Error('The reviewer identity cannot be observed; no restart');
          let observed: AgentObservation | null = null;
          try { observed = await this.engine.host.observe(lease.agentId); }
          catch (error) {
            // An unreadable live observation falls back to the host's own archive
            // answer: an archived or gone thread is terminal, so no same-agent
            // turn can land on it; anything weaker is unobservable and refuses.
            if (!await threadArchivedOrGone(this.adapter, lease.agentId)) throw error;
            threadArchived = true;
          }
          if (observed) {
            if (!matchingInactiveParticipant(lease, observed, fresh ? ['idle', 'error', 'closed'] : ['idle', 'error']))
              throw Error('The reviewer run is still live; stop its turn before restarting it');
            observedClosed = observed.status === 'closed';
          }
        } else if (!fresh && retainedAgent) {
          // No reader run to observe, but a same-agent restart still owes the
          // retained thread the same proof: a proven archived or gone thread
          // cannot continue, and a live, busy, permission-blocked, drifted or
          // closed one is never displaced by the restart.
          if (await threadArchivedOrGone(this.adapter, retainedAgent)) threadArchived = true;
          else {
            const observed = await this.engine.host.observe(retainedAgent);
            if (!matchingInactiveParticipant({ agentId: retainedAgent, workspaceId: before.workspaceId ?? null }, observed, ['idle', 'error']))
              throw Error('The reviewer run is still live; stop its turn before restarting it');
          }
        }
        this.engine.assertUnchangedBeforeCancel(taskId, before.version, runsBefore);
      };
      let observedClosed = false, threadArchived = false;
      await observe();
      return async () => {
        await observe();
        const archivePending = fresh && live?.role === 'reviewer' && !live.completion && !observedClosed
          && !await archiveReplacedReviewer(this.store, this.adapter, live);
        this.engine.assertUnchangedBeforeCancel(taskId, before.version, runsBefore);
        if (archivePending) return this.store.update(taskId, {
          reason: 'Reviewer replacement archive is not confirmed; waiting for observation',
          resolution: { ...this.store.task(taskId).resolution, pendingReviewReason: instruction },
        }, 'restart_review_archive_wait');
        let launchFence: string | null = null;
        const settled = this.store.transaction(() => {
          this.engine.assertUnchangedBeforeCancel(taskId, before.version, runsBefore);
          this.engine.settleVerbFences(taskId, { detail: `restart reviewer: ${reason}`, runIds: finished.settleable.map(item => item.id), displacedRunIds: displacement.runIds });
          const current = this.store.task(taskId);
          const run = lease ? this.store.run(lease.id) : null;
          // A thread proven archived or gone is terminal: there is nothing to
          // continue there, so the lease releases even for an ordinary restart
          // and the next reader takes the retained reviewer route on a fresh
          // agent. The superseded run is history, never the reader that starts.
          const terminal = threadArchived || Boolean(run?.retainedAgentClosedAt) || Boolean(live?.retainedAgentClosedAt);
          if (run && run.role === "reviewer" && !run.completion && !run.released) {
            this.store.putRun({ ...run, status: "superseded", released: fresh || observedClosed || terminal || run.retainedAgentClosedAt !== undefined,
              active: false, replacedAt: now(), ...(terminal && !run.retainedAgentClosedAt ? { retainedAgentClosedAt: now() } : {}) });
          }
          const updated = this.store.update(current.id, {
            phase: "awaiting_review",
            reason: `Restarted with ${fresh ? 'a fresh' : 'the retained'} reviewer: ${reason}`,
            resolution: { ...current.resolution, currentRunId: null, reviewerAgentId: fresh || terminal ? null : retainedAgent, reviewerProfile: fresh ? null : retainedProfile,
              integrationTurn: null, attention: false, recoveryActive: false, pendingReviewReason: instruction },
          }, fresh ? "restart_review_fresh" : "restart_review_retained");
          // A run the restart could not release still owns the task, so nothing
          // launches. Say so in the reply, with the rule and what releases it,
          // instead of reporting a restart that started no reader.
          launchFence = unreleasedLaunchFence(this.store, this.store.task(updated.id), "reviewer");
          if (launchFence) this.resolution.waiting(this.store.task(updated.id), `Restarted with ${fresh ? 'a fresh' : 'the retained'} reviewer, but the launch waits on ${launchFence}: ${reason}`, "lifecycle");
          return this.store.task(updated.id);
        });
        // The participant lease the dispatch reads is checked here too
        // (nucleus#1100): a restart that hands the task to a new reviewer names
        // a busy participant in its reply, the way the unreleased-run fence
        // above already does, instead of reporting success while nothing
        // launches. A finished run's recorded completion keeps this read quiet:
        // finished work is not a live participant.
        const decline = launchFence ? null : await this.resolution.leaseDeclineReason(this.store.task(settled.id));
        if (decline) this.resolution.waiting(this.store.task(settled.id), `${settled.reason}, but the launch waits on ${decline}`, 'lifecycle');
        return this.store.task(settled.id);
      };
    }, finished.settleable.map(run => run.id)), `task:${taskId}`);
  }
}
