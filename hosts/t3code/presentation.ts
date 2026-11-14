import { formatTaskNumber } from '../../shared/contracts';
import { capPaseoTitle } from '../../shared/paseo-title';
import { WIRE_LABEL_KEYS } from '../../shared/wire-labels';
import { HostUnknownDeliveryError, ProvenPreSendRefusalError } from '../../core/host';
import type { Task } from '../../shared/contracts';
import type { T3State, T3SettleIntent, T3StateFile } from './state';
import { canonical } from './state';
import type { T3Reads, Projection } from './reads';
import { activeStatuses } from './reads';
import { identity, intentKindOf, intentThreadId, isIntent, presentationThread } from './intents';
import type { T3IntentLedger } from './intents';

/** A settled or refused command never runs again, so its identity is spent. */
const settledOrRefused = (intent: T3State['intents'][string]) => Boolean(intent) && (intent.status === 'refused' || intent.status === 'settled');
/** Same, but an unknown delivery is kept: its identity is reconciled by a fresh read. */
const decidedCommand = (intent: T3State['intents'][string]) => Boolean(intent) && intent.status !== 'unknown';
/** A handover settle that never found an ended turn is retired rather than retried forever. */
const SETTLE_INTENT_TTL_MS = 24 * 60 * 60_000;
/** The nightly's newest run: its ordinal when reported, the list order otherwise. */
const latestRun = (projection: Projection) => projection.runs.reduce((best: Projection['runs'][number] | undefined, run) =>
  !best || (run.ordinal ?? -1) >= (best.ordinal ?? -1) ? run : best, undefined);

/** The collaborators a presentation write needs: durable state, the ledger and the reads. */
export interface T3PresentationContext {
  state: T3StateFile;
  hostId(): string;
  requireConnection(): void;
  reads: T3Reads;
  intents: T3IntentLedger;
}

/**
 * What the T3 board shows: thread titles and settle state.
 *
 * Every write here is a presentation command recorded in the ledger before it is
 * sent, so an unknown delivery is never resent and a deletion retires the work it
 * would have shown. The settled marker tells a later settle that the thread needs
 * settling again; nothing here decides whether a task is done.
 */
export class T3Presentation {
  constructor(private readonly core: T3PresentationContext) {}

  noteThreadSettled(agentId: string, commandId: string): void {
    if (this.core.state.read().settledThreads?.[agentId] === commandId) return;
    this.core.state.update(state => {
      state.settledThreads = { ...state.settledThreads, [agentId]: commandId };
    });
  }
  /** An unsettle clears the settled marker before the send, so a later settle
   * re-reads the thread even when this send's own reply is lost. A spurious
   * clear only costs one extra projection read on the next settle. */
  clearThreadSettled(agentId: string): void {
    if (!this.core.state.read().settledThreads?.[agentId]) return;
    this.core.state.update(state => { if (state.settledThreads) delete state.settledThreads[agentId]; });
  }
  retireDeletedPresentationIntents(observedId?: string): void {
    const snapshot = this.core.state.read();
    const observeKey = observedId ? identity('delete', observedId) : undefined;
    const observedIntent = observeKey ? snapshot.intents[observeKey] : undefined;
    let observeDelete = false;
    if (observedIntent?.status === 'unknown' && !observedIntent.deletionObservedAt && observedId) {
      observeDelete = isIntent('thread.delete', observedIntent) && intentThreadId(observedIntent) === observedId;
    }
    const retire = (state: T3State): boolean => {
      let changed = false;
      for (const [key, intent] of Object.entries(state.intents)) {
        if (intent.status !== 'unknown') continue;
        const id = presentationThread(intent);
        const deletion = id ? this.core.intents.confirmedDeletion(state, id) : undefined;
        if (!deletion) continue;
        state.intents[key] = { ...intent, status: 'moot', retiredByDeletion: deletion };
        changed = true;
      }
      for (const [key, entry] of Object.entries(state.pendingSettles ?? {})) {
        if (!this.core.intents.confirmedDeletion(state, entry.agentId)) continue;
        delete state.pendingSettles![key];
        changed = true;
      }
      for (const agentId of Object.keys(state.settledThreads ?? {})) {
        if (!this.core.intents.confirmedDeletion(state, agentId)) continue;
        delete state.settledThreads![agentId];
        changed = true;
      }
      return changed;
    };
    if (!observeDelete && !retire(snapshot)) return;
    this.core.state.update(state => {
      if (observeDelete && state.intents[observeKey!]?.payload === observedIntent!.payload
          && state.intents[observeKey!].status === 'unknown')
        state.intents[observeKey!].deletionObservedAt ??= new Date().toISOString();
      retire(state);
    });
  }


  numberedThreadTitle(taskNumber: number | null | undefined, role: string | undefined, title: string): string {
    if (!taskNumber) return title;
    const runRole = role && role !== 'worker' ? role : undefined;
    const titleRole = runRole === 'reviewer' ? 'review' : runRole;
    const numberedPrefix = `${formatTaskNumber(taskNumber)}${titleRole ? ` ${titleRole}` : ''}: `;
    let taskTitle = title;
    while (taskTitle.startsWith(numberedPrefix)) taskTitle = taskTitle.slice(numberedPrefix.length);
    const legacyRolePrefix = runRole ? `${runRole}: ` : '';
    if (legacyRolePrefix && taskTitle.startsWith(legacyRolePrefix)) taskTitle = taskTitle.slice(legacyRolePrefix.length);
    return capPaseoTitle(`${numberedPrefix}${taskTitle}`);
  }
  async setTaskWorkspaceTitle(task: Task, title: string, requestId: string, _uncertain: boolean): Promise<void> {
    this.retireDeletedPresentationIntents();
    title = capPaseoTitle(title);
    const state = this.core.state.read();
    const taskLabel = WIRE_LABEL_KEYS.task, runLabel = WIRE_LABEL_KEYS.run, roleLabel = WIRE_LABEL_KEYS.role;
    const taskAgents = Object.entries(state.agents).filter(([, agent]) => agent.labels[taskLabel] === task.id);
    const threadId = task.agentId && state.agents[task.agentId]?.labels[taskLabel] === task.id
      ? task.agentId
      : taskAgents.find(([id, agent]) => agent.labels[roleLabel] === 'worker'
        || agent.labels[roleLabel] === undefined && (id === task.agentId || task.runId !== undefined && agent.labels[runLabel] === task.runId))?.[0];
    if (!threadId) throw Error('Task worker thread is missing');
    if (this.core.intents.confirmedDeletion(state, threadId)) return;
    const projection = await this.core.reads.readProjection(threadId, 'observation');
    const key = identity('thread-title', canonical({ threadId, requestId }));
    if (!projection.thread.archivedAt && !projection.thread.deletedAt && projection.thread.title === title) {
      this.core.state.update(current => {
        const prior = current.intents[key];
        if (prior?.status === 'unknown') current.intents[key] = { ...prior, status: 'settled', result: { title } };
        if (current.agents[threadId]) current.agents[threadId].title = title;
      });
    } else if (!projection.thread.archivedAt && !projection.thread.deletedAt) {
      await this.core.intents.effect(key, 'orchestration.dispatchCommand', { type: 'thread.metadata.update', commandId: key, threadId, title }, undefined, undefined,
        { resendUnknownAfterRead: true });
      this.core.state.update(current => { if (current.agents[threadId]) current.agents[threadId].title = title; });
    }

    // Task state sync also repairs the number-and-role prefix on existing support
    // threads. Their current remote title is the source of the task title, so a
    // restart can safely catch up threads created before numbered titles landed.
    if (task.number) for (const [supportId, agent] of taskAgents) {
      const role = agent.labels[roleLabel];
      if (!role || role === 'worker' || this.core.intents.confirmedDeletion(this.core.state.read(), supportId)) continue;
      const support = await this.core.reads.readProjection(supportId, 'observation');
      if (support.thread.archivedAt || support.thread.deletedAt) continue;
      const supportTitle = this.numberedThreadTitle(task.number, role, support.thread.title);
      if (support.thread.title === supportTitle) continue;
      const supportKey = identity('thread-title', canonical({ threadId: supportId, requestId, title: supportTitle }));
      await this.core.intents.effect(supportKey, 'orchestration.dispatchCommand', {
        type: 'thread.metadata.update', commandId: supportKey, threadId: supportId, title: supportTitle,
      }, undefined, undefined, { resendUnknownAfterRead: true });
      this.core.state.update(current => { if (current.agents[supportId]) current.agents[supportId].title = supportTitle; });
    }
  }
  async settleReportedThread(agentId: string, runId: string): Promise<void> {
    this.core.requireConnection();
    if (this.core.intents.confirmedDeletion(this.core.state.read(), agentId)) { this.retireDeletedPresentationIntents(); return; }
    // Settled, and no unsettle since: no projection read, no second command.
    if (this.core.state.read().settledThreads?.[agentId]) return;
    // At most one stale bind retires per call; the fresh bind for the current
    // latest run follows in the same pass.
    for (let round = 0; round < 2; round++) {
      const baseCommandId = identity('settle', canonical([this.core.hostId(), agentId, runId]));
      let commandId = baseCommandId;
      let prior = this.core.state.read().intents[commandId];
      const projection = await this.core.reads.readProjection(agentId, 'observation');
      if (projection.thread.settledOverride === 'settled') {
        if (prior?.status === 'unknown') this.markSettleObserved(commandId);
        this.noteThreadSettled(agentId, prior?.status === 'settled' ? commandId : baseCommandId);
        return;
      }
      // An archived thread is hidden; settling it is pointless and the Nightly
      // may refuse it. The terminal lane owns archived threads.
      if (projection.thread.archivedAt || projection.thread.deletedAt) return;
      const latest = latestRun(projection);
      // A fresh run owns the thread now. Never settle it because an older report arrived late.
      if (!latest || activeStatuses.has(latest.status)) return;
      // A decided command never runs again: the unsettled thread gets a fresh
      // command identity. Unknown delivery still goes through the projection
      // reconciliation below.
      commandId = this.commandIdFor('settle', [this.core.hostId(), agentId, runId], decidedCommand);
      prior = this.core.state.read().intents[commandId];
      if (prior) {
        const outcome = await this.reconcileSettleIntent(commandId, prior).catch(() => null);
        if (outcome !== 'retired') return;
        continue; // Stale bind retired; re-read and settle the current latest.
      }
      await this.core.intents.effect(commandId, 'orchestration.dispatchCommand',
        { type: 'thread.settle', commandId, threadId: agentId, expectedLatestRunId: latest.id });
      this.noteThreadSettled(agentId, commandId);
      return;
    }
  }
  async reconcileReportedSettlements(): Promise<void> {
    this.retireDeletedPresentationIntents();
    const state = this.core.state.read();
    const workerSettles = state.workerSettles ?? {};
    const pending = Object.entries(state.intents).filter(([key, intent]) => {
      if (intent.status !== 'unknown') return false;
      // A worker handover settle is never resent (nucleus#1154): an unknown
      // outcome stays unknown, and only a settle that was never sent may be
      // retried from its pending record. Resending here would turn one unknown
      // mutation into a second.
      if (workerSettles[key]) return false;
      // A legacy entry with no recorded kind and an unreadable wire stays unknown
      // delivery, exactly as a malformed command does.
      if (!intentKindOf(intent)) throw new HostUnknownDeliveryError();
      return isIntent('thread.settle', intent);
    });
    for (const [key, intent] of pending) {
      try { await this.reconcileSettleIntent(key, intent); } catch { /* retain unknown delivery for the next sweep */ }
    }
  }

  markSettleObserved(key: string, result: unknown = { settled: true }) {
    this.core.state.update(state => {
      const intent = state.intents[key];
      if (intent?.status === 'unknown') state.intents[key] = { ...intent, status: 'settled', result };
    });
  }
  /**
   * Reconcile one uncertain settle against T3, and report what it proves.
   * `settled` means the thread is settled (or the resend landed) and there is
   * nothing more to do; `retired` means this command no longer owns the latest
   * run — the caller settles the current latest run under a fresh command
   * instead of leaving the thread unsettled (nucleus#1181; #227's reviewer
   * thread). A bind that never named a latest run cannot be verified either
   * way, so it retires the same way instead of looping invisibly; a malformed
   * intent with no thread stays unknown delivery and is never resent.
   */
  async reconcileSettleIntent(key: string, intent: T3State['intents'][string]): Promise<'settled' | 'retired'> {
    const threadId = intentThreadId(intent);
    if (!isIntent('thread.settle', intent) || !threadId) throw new HostUnknownDeliveryError();
    const payload = JSON.parse(intent.payload) as { payload?: { expectedLatestRunId?: string } };
    const projection = await this.core.reads.readProjection(threadId, 'observation');
    if (projection.thread.settledOverride === 'settled') { this.markSettleObserved(key); this.noteThreadSettled(threadId, key); return 'settled'; }
    if (projection.thread.archivedAt || projection.thread.deletedAt) {
      // Hidden threads are the terminal lane's; this bind can prove nothing more.
      this.markSettleObserved(key, { settled: false, superseded: true });
      return 'retired';
    }
    const latest = latestRun(projection);
    if (!payload.payload?.expectedLatestRunId || !latest || latest.id !== payload.payload.expectedLatestRunId || activeStatuses.has(latest.status)) {
      // The old report no longer owns the latest run; retire this intent without touching it.
      this.markSettleObserved(key, { settled: false, superseded: true });
      return 'retired';
    }
    await this.core.intents.effect(key, 'orchestration.dispatchCommand', JSON.parse(intent.payload).payload, undefined, undefined, { resendUnknownAfterRead: true });
    return 'settled';
  }

  async unsettleBeforeMessage(id: string, messageId: string) {
    if (this.core.intents.confirmedDeletion(this.core.state.read(), id)) throw new ProvenPreSendRefusalError('T3Code thread deletion is confirmed');
    // A message wakes the thread: a later settle must re-read and settle again.
    this.clearThreadSettled(id);
    const projection = await this.core.reads.readProjection(id, 'observation');
    if (projection.thread.settledOverride !== 'settled') return;
    const commandId = identity('unsettle', canonical([this.core.hostId(), id, messageId]));
    await this.core.intents.effect(commandId, 'orchestration.dispatchCommand', { type: 'thread.unsettle', commandId, threadId: id, reason: 'user' });
  }
  /**
   * Surface a stuck task's worker thread (nucleus#1181): when a T3-bound task
   * enters `blocked`, `needs_attention` or an escalation, its worker thread is
   * unsettled so it shows in T3's main list instead of the settled list. Only
   * the worker thread surfaces; support threads keep their settled state and
   * the title already shows the task state. When the task leaves attention the
   * sweep's ordinary settles put the thread back, under a fresh command (the
   * settled marker was cleared here). Idempotent: an already-active thread
   * sends nothing, and each attention episode gets its own command identity.
   */

  async unsettleWorkerThread(agentId: string, taskId: string): Promise<void> {
    this.core.requireConnection();
    if (this.core.intents.confirmedDeletion(this.core.state.read(), agentId)) { this.retireDeletedPresentationIntents(); return; }
    // Clear before the read: a later settle re-reads even when this send's
    // own reply is lost.
    this.clearThreadSettled(agentId);
    const projection = await this.core.reads.readProjection(agentId, 'observation');
    if (projection.thread.settledOverride !== 'settled' || projection.thread.archivedAt || projection.thread.deletedAt) return;
    const commandId = this.attentionUnsettleCommandId(agentId, taskId);
    await this.core.intents.effect(commandId, 'orchestration.dispatchCommand',
      { type: 'thread.unsettle', commandId, threadId: agentId, reason: 'user' },
      undefined, undefined, { resendUnknownAfterRead: true });
  }
  /** First unused attention-unsettle id for this thread and task. Settled and
   * refused commands never run again, so each attention episode after a
   * re-settle gets its own identity; an unknown one is reconciled by re-read. */
  attentionUnsettleCommandId(agentId: string, taskId: string): string {
    return this.commandIdFor('attention-unsettle', [this.core.hostId(), agentId, taskId], settledOrRefused);
  }

  /**
   * The first command identity for this purpose and these facts that no command
   * owns. Commands get a fresh identity rather than a second send: `decidedCommand`
   * skips every identity that reached an outcome, while `settledOrRefused` keeps
   * an unknown delivery for the projection to reconcile under the same id.
   */
  private commandIdFor(purpose: string, facts: readonly unknown[], owns: (intent: T3State['intents'][string]) => boolean): string {
    const intents = this.core.state.read().intents;
    const identityFor = (attempt: number) => identity(purpose, canonical(attempt ? [...facts, attempt] : facts));
    if (!owns(intents[identityFor(0)])) return identityFor(0);
    for (let attempt = 1; ; attempt++) {
      if (!owns(intents[identityFor(attempt)])) return identityFor(attempt);
    }
  }

  /**
   * Settle a worker thread once Nucleus accepted its handover and moved the task
   * to review (Tom, 2026-11-12). `expectedLatestRunId` names the run this
   * handover ended, so a thread a later run already owns is never settled.
   *
   * The accepted receipt is durable before this presentation effect, and the
   * handover's turn may still be ending when it arrives: an active run is never
   * settled (the next turn would clear the marker anyway), so the intent is
   * recorded and the ordinary host sweep retries it once that run has ended.
   * A recorded command is left exactly as recorded — an unknown delivery is not
   * permission to resend, and a settled one is the same settle again. T3 clears
   * the marker when a new message wakes the thread, so a revision round makes the
   * worker active and its next handover settles it again; an attention surfacing
   * in between clears the marker too, so the return to review settles again
   * under a fresh command identity (nucleus#1181).
   */
  async settleWorkerThread(agentId: string, runId: string): Promise<void> {
    this.core.requireConnection();
    if (this.core.intents.confirmedDeletion(this.core.state.read(), agentId)) { this.retireDeletedPresentationIntents(); return; }
    // Settled, and no unsettle since: no projection read, no second command.
    if (this.core.state.read().settledThreads?.[agentId]) return;
    const baseCommandId = identity('settle', canonical([this.core.hostId(), agentId, runId]));
    const existing = this.core.state.read().pendingSettles?.[baseCommandId];
    const commandId = this.workerSettleCommandId(agentId, runId);
    const intent = this.core.state.read().intents[commandId];
    if (intent?.status === 'unknown') throw new HostUnknownDeliveryError(intent.diagnostic);
    if (intent && intent.status !== 'refused') return;
    await this.attemptWorkerSettle(existing ?? { agentId, runId, commandId, recordedAt: new Date().toISOString() });
  }

  /** Retry durable worker settle intents during the ordinary host sweep. */
  async reconcileSettledThreads(): Promise<void> {
    this.retireDeletedPresentationIntents();
    this.pruneWorkerSettles();
    const pending = Object.values(this.core.state.read().pendingSettles ?? {});
    if (!pending.length) return;
    this.core.requireConnection();
    for (const entry of pending) {
      try { await this.attemptWorkerSettle(entry); }
      catch { /* an unreadable thread or unknown delivery keeps its record for the next pass */ }
    }
  }

  /** One worker settle: send when the handover's own run has ended, else retain the intent. */
  async attemptWorkerSettle(entry: T3SettleIntent): Promise<void> {
    if (this.core.intents.confirmedDeletion(this.core.state.read(), entry.agentId)) { this.retireDeletedPresentationIntents(); return; }
    const intent = this.core.state.read().intents[entry.commandId];
    if (intent?.status === 'settled') {
      const hadPending = Boolean(this.core.state.read().pendingSettles?.[entry.commandId]);
      this.forgetSettle(entry.commandId);
      // The send landed: a pending record is the crash window between the
      // receipt and its cleanup. Without one this handover already settled,
      // and only an unsettle since (attention, revision message) earns a
      // fresh command below.
      if (hadPending || this.core.state.read().settledThreads?.[entry.agentId] === entry.commandId) {
        this.noteThreadSettled(entry.agentId, entry.commandId);
        return;
      }
      entry = { ...entry, commandId: this.workerSettleCommandId(entry.agentId, entry.runId) };
    } else {
      // Unknown delivery is never resent for worker handovers. A proven refusal
      // gets a new id on the next pass; it was known not to reach T3.
      if (intent && intent.status !== 'refused') { this.forgetSettle(entry.commandId); return; }
      if (intent?.status === 'refused') {
        this.forgetSettle(entry.commandId);
        entry = { ...entry, commandId: this.workerSettleCommandId(entry.agentId, entry.runId) };
      }
    }
    if (Date.now() - Date.parse(entry.recordedAt) > SETTLE_INTENT_TTL_MS) { this.forgetSettle(entry.commandId); return; }
    const projection = await this.core.reads.readProjection(entry.agentId, 'observation');
    // Already settled, or retired: the handover needs no further presentation.
    if (projection.thread.settledOverride === 'settled' || projection.thread.archivedAt || projection.thread.deletedAt) {
      this.noteThreadSettled(entry.agentId, entry.commandId);
      this.forgetSettle(entry.commandId); return;
    }
    const latest = latestRun(projection);
    // A later run owns the thread now; this handover must not settle it.
    if (entry.expectedLatestRunId && (!latest || latest.id !== entry.expectedLatestRunId)) { this.forgetSettle(entry.commandId); return; }
    // Still live, or the run has not appeared yet: keep the recorded intent.
    if (!latest || activeStatuses.has(latest.status)) { this.recordSettle({ ...entry, expectedLatestRunId: latest?.id }); return; }
    this.recordSettle({ ...entry, expectedLatestRunId: latest.id });
    this.markWorkerSettle(entry.commandId, entry.recordedAt);
    await this.core.intents.effect(entry.commandId, 'orchestration.dispatchCommand',
      { type: 'thread.settle', commandId: entry.commandId, threadId: entry.agentId, expectedLatestRunId: latest.id });
    this.noteThreadSettled(entry.agentId, entry.commandId);
    this.forgetSettle(entry.commandId);
  }

  /** First unused worker settle id: after a proven pre-send refusal, or after an
   * unsettle cleared the settled marker (attention, revision message), so the
   * return to review settles again under a fresh command. */
  workerSettleCommandId(agentId: string, runId: string): string {
    return this.commandIdFor('settle', [this.core.hostId(), agentId, runId], settledOrRefused);
  }

  /**
   * Record that this command id is a worker handover settle. The mark is written
   * before the send so a crash cannot leave an unknown worker settle looking like
   * a support report's settle to the support reconciler.
   */

  markWorkerSettle(commandId: string, recordedAt: string): void {
    if (this.core.state.read().workerSettles?.[commandId]) return;
    this.core.state.update(state => { state.workerSettles = { ...state.workerSettles, [commandId]: recordedAt }; });
  }

  /** Drop marks whose command has an outcome; an unknown one stays, so it is never resent. */

  pruneWorkerSettles(): void {
    const state = this.core.state.read();
    const done = Object.keys(state.workerSettles ?? {}).filter(key => state.intents[key]?.status !== 'unknown');
    if (!done.length) return;
    this.core.state.update(next => { for (const key of done) delete next.workerSettles?.[key]; });
  }

  /** Record one pending settle; an unchanged record is the same intent, never a rewrite. */

  recordSettle(entry: T3SettleIntent): void {
    const current = this.core.state.read().pendingSettles?.[entry.commandId];
    if (current && current.expectedLatestRunId === entry.expectedLatestRunId) return;
    this.core.state.update(state => {
      state.pendingSettles = { ...state.pendingSettles, [entry.commandId]: { ...entry, recordedAt: current?.recordedAt ?? entry.recordedAt } };
    });
  }

  forgetSettle(commandId: string): void {
    if (!this.core.state.read().pendingSettles?.[commandId]) return;
    this.core.state.update(state => { if (state.pendingSettles) delete state.pendingSettles[commandId]; });
  }
}
