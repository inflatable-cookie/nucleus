import { active, assignedThreadWaitReason, coordinative, participantToolRunIds } from '../recovery/task-reasons';
import { recoveryEffects, isBlockingRecoveryEffect, recoveryEffectsRefusal } from '../recovery/recovery-effects';
import { executionParticipants } from '../machine/execution-participants';
import { runBindsCurrentWork, type Run, type Task } from '../../shared/contracts';
import { STALE_INTEGRATION_BASE_PROOF } from '../hooks/hooks';
import { formatHostProcessSweepEvent, reapHostProcesses } from '../machine/host-process-reap';
import { recordedProcessGroupsForTask } from '../machine/host-process-select';
import type { Adapter } from '../host/adapter';
import type { VerifiedEnclosingOperation } from '../planning/enclosing-operation';
import type { Resolution } from '../resolution';

/** Proves a task's participants are settled before its work, merge or closeout goes on. */
export class ParticipantLease {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }

  /**
   * Resolve a stale pending Nucleus question found at dispatch (papercut ee9fc161).
   * When a native question is withdrawn (extension, answer, supersession),
   * Nucleus resolves the host's pending permission or question on that thread
   * as a durable effect, and dispatch never waits on a question Nucleus has
   * withdrawn. Returns true when a withdrawn request was found pending and a
   * dismiss or cancel was sent; the caller records a short resolving wait and
   * the next pass launches once the host clears it. Tool and bash permissions
   * unrelated to a withdrawn question are never touched.
   */
  async resolveWithdrawnPending(t: Task, hint?: { agentId: string; state: Awaited<ReturnType<Adapter['observe']>> }): Promise<boolean> {
    const events = this.store.eventsAll(t.id);
    const withdrawn = new Set<string>();
    for (const event of events) {
      if (event.kind === 'operator_question_superseded' || event.kind === 'native_question_dismiss_intent'
        || event.kind === 'responsible_question_superseded' || event.kind === 'agent_ask_superseded') {
        const id = event.detail.split(':')[0]!;
        if (id) withdrawn.add(id);
      }
    }
    if (!withdrawn.size) return false;
    const recordedRequests = new Map<string, string>();
    for (const event of events) {
      if (event.kind !== 'operator_question_native_request') continue;
      const id = event.detail.split(':')[0]!;
      if (!withdrawn.has(id)) continue;
      const requestId = event.detail.match(/request (\S+)/)?.[1];
      if (requestId && !recordedRequests.has(requestId)) recordedRequests.set(requestId, id);
    }
    const candidates: Array<{ agentId: string; workspaceId: string; state: Awaited<ReturnType<Adapter['observe']>> | null }> = [];
    if (hint) candidates.push({ agentId: hint.agentId, workspaceId: t.workspaceId ?? hint.state.workspaceId ?? '', state: hint.state });
    else {
      const seen = new Set<string>();
      const add = (agentId: string | null | undefined, workspaceId: string | null | undefined) => {
        if (!agentId || seen.has(agentId)) return;
        seen.add(agentId);
        candidates.push({ agentId, workspaceId: workspaceId ?? t.workspaceId ?? '', state: null });
      };
      add(t.agentId, t.workspaceId);
      const runs = this.store.runs(t.id);
      const current = t.resolution.currentRunId ? runs.find(run => run.id === t.resolution.currentRunId) : null;
      add(current?.agentId, current?.workspaceId ?? t.workspaceId);
      add(t.resolution.reviewerAgentId, runs.find(run => run.role === 'reviewer' && run.agentId === t.resolution.reviewerAgentId)?.workspaceId ?? t.workspaceId);
    }
    // A resolving wait is recorded only on a pass that actually sends a dismiss
    // or cancel toward the host; anything already sent falls through to the
    // ordinary wait so the task can never sit in "resolving" with nothing sent.
    const resolving = () => {
      this.resolution.waiting(this.store.task(t.id), 'Resolving a withdrawn Nucleus question still pending on the retained thread; dispatch proceeds once the host clears it', 'lifecycle');
    };
    const dismissed = (match: string, requestId: string) =>
      this.store.eventsAll(t.id).some(item => item.kind === 'native_question_dismissed' && item.detail.startsWith(`${match}:`) && item.detail.includes(requestId));
    const cancelSent = (match: string, intentId: string) =>
      this.store.eventsAll(t.id).some(item => item.kind === 'native_permission_cancel_intent' && item.detail.startsWith(`${match}: ${intentId}`));
    for (const candidate of candidates) {
      let state = candidate.state;
      if (!state) {
        try { state = await this.resolution.host.observe(candidate.agentId); }
        catch { continue; }
      }
      if (!state.permissions && !state.pendingRequest) continue;
      const workspaceId = candidate.workspaceId || state.workspaceId || '';
      // Pending native questions: dismiss by recorded requestId or text prefix.
      if (this.adapter.pendingQuestions && this.adapter.dismissNativeQuestion) {
        let pending: Awaited<ReturnType<NonNullable<Adapter['pendingQuestions']>>> | null = null;
        try { pending = await this.adapter.pendingQuestions(candidate.agentId); }
        catch { pending = null; }
        if (pending) {
          for (const request of pending) {
            const recorded = recordedRequests.get(request.requestId);
            const match = (recorded && withdrawn.has(recorded) ? recorded : null)
              ?? [...withdrawn].find(id => request.questions.some(question => question.question.startsWith(`[Queue decision ${id}]`)));
            if (!match || dismissed(match, request.requestId)) continue;
            try {
              await this.adapter.dismissNativeQuestion(candidate.agentId, workspaceId, request.requestId);
            } catch { return false; }
            this.store.event(t.id, 'native_question_dismissed', `${match}: request ${request.requestId} on ${candidate.agentId} (resolved at dispatch)`);
            resolving();
            return true;
          }
        }
      }
      // Pending permission or question observed on the thread: act only when it
      // is a recorded withdrawn Nucleus request or its text names one, and only
      // with the host call that settles that kind.
      const pendingId = state.pendingRequest?.id ?? null;
      const firstLine = state.pendingRequest?.firstLine ?? '';
      const kind = state.pendingRequest?.kind;
      if (!pendingId) continue;
      const recorded = recordedRequests.get(pendingId);
      const match = (recorded && withdrawn.has(recorded) ? recorded : null)
        ?? [...withdrawn].find(id => firstLine.includes(`[Queue decision ${id}]`) || firstLine.includes(id));
      if (!match) continue;
      if (kind === 'permission' && this.adapter.answerNativePermission) {
        const intentId = `ns-withdrawn-${match}-${pendingId}`;
        if (cancelSent(match, intentId)) continue;
        this.store.event(t.id, 'native_permission_cancel_intent', `${match}: ${intentId} request ${pendingId} on ${candidate.agentId}`);
        try { await this.adapter.answerNativePermission(candidate.agentId, workspaceId, pendingId, 'cancel', intentId); }
        catch { return false; }
        resolving();
        return true;
      }
      if (kind === 'question' && this.adapter.dismissNativeQuestion) {
        if (dismissed(match, pendingId)) continue;
        try { await this.adapter.dismissNativeQuestion(candidate.agentId, workspaceId, pendingId); }
        catch { return false; }
        this.store.event(t.id, 'native_question_dismissed', `${match}: request ${pendingId} on ${candidate.agentId} (resolved at dispatch)`);
        resolving();
        return true;
      }
    }
    return false;
  }

  private async settleStrayTool(t: Task, agentId: string, workspaceId: string, runIds: string[], issue: string): Promise<string | null> {
    const runId = runIds[0];
    if (!runId) return issue;
    const hold = this.store.eventsAll(t.id).findLast(event => event.kind === 'owned_tool_hold' && (() => {
      try { return JSON.parse(event.detail).runId === runId; } catch { return false; }
    })());
    if (!hold) return issue;
    const deadline = Date.parse(hold.at) + Math.max(0, this.resolution.graceMs);
    if (Date.now() < deadline) return `${issue}; stray-tool grace ends at ${new Date(deadline).toISOString()}`;

    // A live turn owns its tools. Recheck immediately before the host sweep so
    // a turn that resumed during the grace is never stopped.
    // The task process sweep can cover the shared task worktree and recorded
    // run groups, so all bound participants must still be settled before it is
    // allowed to stop anything.
    for (const [id, workspace] of executionParticipants(t, this.store.runs(t.id))) {
      let state: Awaited<ReturnType<Adapter['observe']>>;
      try { state = await this.resolution.host.observe(id); }
      catch { return `${issue}; participant ${id} identity could not be rechecked before reaping`; }
      if (state.id !== id || state.workspaceId !== workspace || active(state) || !['idle', 'closed', 'error'].includes(state.status))
        return `${issue}; participant ${id} resumed or its identity changed before reaping`;
    }

    let processes: Awaited<ReturnType<NonNullable<Adapter['hostProcessListing']>>> | undefined;
    try { processes = this.adapter.hostProcessListing ? await this.adapter.hostProcessListing() : undefined; }
    catch { processes = null; }
    let result: Awaited<ReturnType<typeof reapHostProcesses>>;
    try {
      result = await reapHostProcesses({
        directory: t.directory,
        recordedGroups: recordedProcessGroupsForTask(this.store, t),
        processes,
      });
    } catch (error) {
      return `${issue}; host-process reap failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (result.unavailable) return `${issue}; host-process reap could not read the host: ${result.unavailable.reason}`;
    if (result.failed.length) return `${issue}; host-process reap could not prove or stop every target: ${result.failed.map(target => target.reason).join('; ')}`;
    if (result.skippedPaseo.length) {
      const skipped = `Skipped ${result.skippedPaseo.length} Paseo-owned process${result.skippedPaseo.length === 1 ? '' : 'es'}: ${result.skippedPaseo.map(target => `pid=${target.pid} pgid=${target.pgid} cwd=${target.cwd || '-'} command=${target.command || '-'}`).join('; ')}`;
      this.store.event(t.id, 'participant_tool_reap_skipped', skipped);
      return `${issue}; host-process reap ${skipped}`;
    }
    if (result.terminated.length) this.store.event(t.id, 'participant_tool_reaped',
      `Stopped participant ${agentId} after its reported turn ended and stray-tool grace elapsed: ${formatHostProcessSweepEvent(result)}`);
    else this.store.event(t.id, 'participant_tool_reap_empty',
      `Participant ${agentId} still reported ${issue}, but the host-process reap found no live task process after the grace`);
    return await this.resolution.ownedToolHold(agentId, {
      requireCompleteEvidence: true, runId, runIds, taskId: t.id, workspaceId,
    });
  }

  private yieldIntegrationTurn(t: Task): void {
    // A merge request with unknown delivery must retain its turn. Before merge
    // intent, a participant wait yields its FIFO place so another task can land.
    if (!t.resolution.integrationTurn || t.resolution.mergeIntent || t.resolution.mergedCommit) return;
    this.resolution.update(t, { integrationTurn: null }, { reason: t.reason }, 'integration_turn_yielded_for_participant');
  }

  async idle(agentId: string, workspaceId?: string, onBusy?: (state: Awaited<ReturnType<Adapter['observe']>>) => void) {
    const state = await this.resolution.host.observe(agentId);
    if (workspaceId && state.workspaceId !== workspaceId) throw new Error('Agent workspace changed; lease is not safe');
    const idle = !active(state) && ['idle', 'closed', 'error'].includes(state.status);
    if (!idle) onBusy?.(state);
    return idle;
  }
  /**
   * Lease proof over the identities that still own work (Spec 013). A released
   * historical reviewer, revision, recovery, verification or closeout run is
   * audit history: an ordinary lease check does not poll it. Only the current
   * worker and reviewer, an assigned coordinator, unreleased runs and any
   * identity named by a persisted uncertainty require fresh proof.
   *
   * A run whose authenticated completion is already recorded is finished work
   * for the same reason (nucleus#1100): its turn is over, so its agent is not a
   * live participant a new dispatch waits on, whatever release bookkeeping still
   * pends on the run row. What remains uncertain about it — a durable delivery
   * or effect, an episode's pending action, a corrected result — is fenced by
   * the paths that record visible waits (the review-dispatch effect fence,
   * `runDurableFence` in owner verbs, the episode's own observation), never by
   * this liveness read.
   */
  async lease(t: Task, onBusy?: (agentId: string, state: Awaited<ReturnType<Adapter['observe']>>) => void,
    supersededRunId?: string) {
    const runs = this.store.runs(t.id);
    // Expected workspace per identity; null means the identity has no recorded
    // workspace yet, so its idle proof is not workspace-constrained.
    const expected = new Map<string, string | null>();
    const record = (id: string | null | undefined, workspace: string | null | undefined) => {
      if (!id) return;
      const current = expected.get(id);
      if (current === undefined || current === null) expected.set(id, workspace ?? null);
    };
    const currentRun = t.resolution.currentRunId && t.resolution.currentRunId !== supersededRunId
      ? runs.find(r => r.id === t.resolution.currentRunId) : null;
    // The retained worker lives in the task workspace. An assigned coordinator or
    // reviewer enters this set through its own run, so a coordinator that has not
    // been launched yet is bound by the launcher instead of polled here.
    record(t.agentId, t.workspaceId);
    record(currentRun?.agentId, currentRun?.workspaceId ?? t.workspaceId);
    for (const run of runs) {
      if (run.released || run.completion || run.id === supersededRunId) continue;
      record(run.agentId, run.workspaceId ?? t.workspaceId);
    }
    // A persisted incident or recovery episode names the exact run whose result
    // is still uncertain, so that identity keeps its live proof — while the run
    // still binds the current work. A record naming a released run is
    // superseded history and never adds a participant the current work must
    // wait for (papercuts 89643af2, 6ff5e903).
    for (const runId of [t.resolution.recovery?.runId, t.resolution.incident?.runId]) {
      if (runId && runId === supersededRunId) continue;
      if (!runBindsCurrentWork(runs, runId)) continue;
      const named = runId ? runs.find(r => r.id === runId) : null;
      if (named?.completion) continue;
      record(named?.agentId, named?.workspaceId);
    }
    for (const [id, workspace] of expected) {
      const proofWorkspace = workspace ?? t.workspaceId!;
      try{if (!await this.resolution.idle(id,workspace ?? undefined,state=>onBusy?.(id,state))) return false;}
      catch(error){if(!(error instanceof Error) || error.message!=='Agent was not found' || !t.resolution.mergedCommit || !this.adapter.workspaceAvailable || await this.adapter.workspaceAvailable(proofWorkspace))throw error;}
    }
    return true;
  }
  /**
   * The run on this task that binds a lease participant's identity, for the
   * decline text: the current run, else the recovery or incident episode's
   * run, else the latest unreleased unfinished run of that agent. Null when
   * only the task row binds the identity (the retained worker). Read-only.
   */
  participantBinding(t: Task, agentId: string): Run | null {
    const runs = this.store.runs(t.id);
    const current = t.resolution.currentRunId ? runs.find(run => run.id === t.resolution.currentRunId && run.agentId === agentId) : null;
    const episode = [t.resolution.recovery?.runId, t.resolution.incident?.runId]
      .map(id => (id ? runs.find(run => run.id === id) : null))
      .find(run => run && run.agentId === agentId) ?? null;
    const latest = runs.findLast(run => !run.released && !run.completion && run.agentId === agentId) ?? null;
    return current ?? episode ?? latest;
  }

  /**
   * The one visible sentence for a lease decline, shared by the dispatch wait
   * and by the accepting verb's reply (nucleus#1100): the participant that
   * still owns work, what the observation shows, and the owner verbs that exit
   * the wait — so a launch that starts nothing never reads as silent success.
   */
  declineText(t: Task, agentId: string, state: Awaited<ReturnType<Adapter['observe']>>): string {
    const run = this.participantBinding(t, agentId);
    const owner = run ? `${run.role} run ${run.id}` : 'the retained worker';
    // The exits name verbs that actually clear the hold: `restart
    // role=coordinator` settles only finished runs and refuses while the run is
    // unreleased, so a live coordinator turn is stopped or routed now; a live
    // reader or revision turn is stopped or routed the same way.
    const exit = run
      ? coordinative(run)
        ? `stop role=coordinator settles it sooner (it stops that turn), or route role=coordinator with now`
        : `an owner stop of run ${run.id}, or a route with now, settles it sooner`
      : 'an owner restart or route with now settles it sooner';
    return `${owner} (agent ${agentId}) still owns its turn: ${assignedThreadWaitReason(state)}; the dispatch proceeds once that thread settles, ${exit}`;
  }

  /**
   * The first recorded participant a launch's lease would decline, named with
   * `declineText`; null when the lease passes or a read fails (an unreadable
   * participant proves nothing here — the launch itself records its own fault).
   * The accepting review verbs probe this so their reply names a launch fence
   * the way `unreleasedLaunchFence` already does.
   */
  async declineReason(t: Task): Promise<string | null> {
    const captured: { agentId: string; state: Awaited<ReturnType<Adapter['observe']>> }[] = [];
    let passed: boolean;
    try { passed = await this.lease(t, (agentId, state) => captured.push({ agentId, state })); }
    catch { return null; }
    const declined = passed ? undefined : captured[0];
    if (!declined) return null;
    return this.declineText(t, declined.agentId, declined.state);
  }

  refreshingCloseoutHook(t: Task, syncing: boolean) {
    return syncing && t.reason === 'Refreshing main before retrying closeout'
      ? this.store.hookEvents(t.id).findLast(record => record.event === 'task.closeout' && record.state === 'blocked'
        && record.error.includes(STALE_INTEGRATION_BASE_PROOF))
      : undefined;
  }
  /** Merge and closeout observe execution bindings, including retained runs. */
  async executionLease(t: Task, enclosing?: VerifiedEnclosingOperation, syncing = false, probe = false): Promise<boolean> {
    const refreshing = this.resolution.refreshingCloseoutHook(t, syncing);
    const blocking = recoveryEffects(this.store,t,{enclosing,kinds:['operation','hook','run-delivery','review-delivery','publication','attention-notice']})
      .filter(item => isBlockingRecoveryEffect(item) && !(refreshing && item.kind === 'hook' && item.identity === refreshing.id));
    if (blocking.length) {
      // A speculative probe (an external-merge read on a task that is nowhere near
      // a merge) records no wait: its fence is a silent no, and the owning phase
      // keeps its own reason. Real merge gates name what they wait for.
      if (!probe) this.resolution.waiting(t, `Merge waits for ${recoveryEffectsRefusal(blocking)}; settle each with retry_effect or an owner control that supersedes it`, 'lifecycle');
      return false;
    }
    const runs=this.store.runs(t.id);
    for (const [id, workspace] of executionParticipants(t, runs)) {
      // The owner explicitly superseded these exact identities to close an already merged PR.
      if (syncing && t.resolution.externalMerge && t.resolution.mergedCommit
        && t.resolution.ownerCloseoutParticipants.some(item => item.agentId === id && item.workspaceId === workspace)) continue;
      const state = await this.resolution.host.observe(id);
      if (state.id !== id || state.workspaceId !== workspace) {
        if (!probe) this.resolution.waiting(t, `Merge waits for participant ${id} in workspace ${workspace}: current identity, activity or status does not prove it is settled`, 'lifecycle');
        return false;
      }
      if (active(state) || !['idle', 'closed', 'error'].includes(state.status)) {
        if (!probe) this.resolution.waiting(t, `Merge waits for participant ${id} in workspace ${workspace}: ${assignedThreadWaitReason(state)}`, 'lifecycle');
        return false;
      }
      if (!syncing) {
        const participantRunIds=participantToolRunIds(t,runs,id,workspace);
        const why=await this.resolution.ownedToolHold(id,{requireCompleteEvidence:true,runId:participantRunIds[0],runIds:participantRunIds,taskId:t.id,workspaceId:workspace});
        if (why) {
          const stray = !probe && !syncing && !t.resolution.mergeIntent && !t.resolution.mergedCommit
            ? await this.settleStrayTool(t, id, workspace, participantRunIds, why)
            : why;
          if (!stray) continue;
          if (!probe) this.yieldIntegrationTurn(t);
          if (!probe) this.resolution.waiting(t, `Merge waits for participant ${id}: ${stray}`, 'lifecycle');
          return false;
        }
      }
    }
    return true;
  }
  /** Settle a finished-turn shell only when the live host process scan also proves its run and workspace are quiet. */
  async participantToolIssue(taskId: string, agentId: string, workspaceId: string): Promise<string | null> {
    const task = this.store.task(taskId);
    const runIds=participantToolRunIds(task,this.store.runs(taskId),agentId,workspaceId);
    return this.resolution.ownedToolHold(agentId,{requireCompleteEvidence:true,runId:runIds[0],runIds,taskId,workspaceId});
  }
}
