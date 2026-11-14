import type { Adapter, OriginAgent } from '../host/adapter';
import { HostFacade } from '../host/host-facade';
import type { Run, Task } from '../../shared/contracts';
import { isDispositionActive } from '../../shared/contracts';
import { Store, now } from '../store/store';
import { reviewVerdictApplied } from '../review/review-publication';
import { admissionOf } from '../host/admission';
import { finishedThreadCleanupKey } from '../store/store-core';
import {
  ownedByTask, threadBoundToAnotherLiveTask, threadHasUnreleasedRun, threadOperation, threadServesAnotherTask, workerThreadIds,
} from './thread-ownership';
import { archiveProbeKey, archiveWait, cleanupComplete, removesThreads, settleArchive, type ArchiveEffect } from './thread-archive-effect';

/** The workspace archive path's own retry proof, used before reissuing a deletion. */
type RetryProof = (agentId: string, workspaceId: string) => Promise<string | null>;

/** A proof-only task whose recorded proof is the outcome it was dispatched for. */
function proofOnlyComplete(task: Task): boolean {
  return Boolean(task.entrypoint === 'proof' && task.proofOnly && task.proofOnlyResult
    && task.proofOnlyResult.commit === task.proofOnly.commit);
}

/**
 * A task that has ended and so owes its threads their terminal cleanup: merged, a
 * completed proof, or a completed cancellation (nucleus#1155 review). A cancelled
 * task's workspace is retired by its own path; its threads are archived and
 * removed here, under the same durable effects and retries.
 */
export function terminalThreadCleanup(task: Task, removal = false): boolean {
  if (task.removedAt) return false;
  if (task.phase === 'done') return Boolean(task.resolution.mergedCommit || proofOnlyComplete(task));
  return removal && task.phase === 'cancelled' && task.disposition?.status === 'complete';
}

/** Exhausted thread attempts block the existing workspace archive effect. */
export function exhaustedThreadArchives(store: Store, task: Task, runs: Run[], workspaceId: string): string[] {
  if (task.phase !== 'done') return [];
  const ids = new Set(runs.filter(run => run.workspaceId === workspaceId).map(run => run.agentId));
  if (task.workspaceId === workspaceId) {
    ids.add(task.agentId);
    for (const worker of task.retiredWorkers) ids.add(worker.agentId);
  }
  return [...ids].filter((id): id is string => {
    if (!id) return false;
    const key = store.threadArchiveKey(id, task.hostId);
    return !key || (store.getMeta<ArchiveEffect>(key)?.retries ?? 0) >= 3;
  });
}


/** Release a finished role binding before its thread is archived. An intent fences restart. */
export async function archiveFinishedThreads(store: Store, adapter: Adapter, taskId: string, retryProof?: RetryProof): Promise<void> {
  const host = new HostFacade({ adapter });
  const task = store.task(taskId);
  if (isDispositionActive(task) || task.removedAt || store.getMeta('paused') || !adapter.originAgent) return;
  if (terminalThreadCleanup(task, removesThreads(adapter))) {
    await archiveTerminalTaskThreads(store, adapter, task, retryProof);
    // Ordinary completion can finish before the catch-up query gets here. The
    // common terminal lane owns this marker, so neither route can miss it.
    const current = store.task(taskId), completionKey = finishedThreadCleanupKey(taskId);
    if (removesThreads(adapter) && current.hostId && terminalThreadCleanup(current, true)
        && !threadCleanupPending(store, current, true) && !store.getMeta(completionKey))
      store.setMeta(completionKey, now());
    return;
  }
  // A host that can remove a thread keeps every support thread of an open task
  // settled, never archived (nucleus#1155): the retained reviewer and recovery
  // bindings stay exactly as they are, so the next review round or recovery
  // episode continues the same thread instead of leaving an archived one behind
  // and opening a new one. Closeout is where they are removed.
  if (removesThreads(adapter)) return;
  for (const run of store.runs(taskId)) {
    if (!run.agentId || !run.released || !['reviewer', 'recovery', 'executor'].includes(run.role)) continue;
    const agentId = run.agentId;
    const key = store.threadArchiveKey(agentId, run.hostId);
    if (!key || run.hostId !== task.hostId || store.unreleasedRunsForAgent(agentId, run.hostId).length) continue;
    let effect = store.getMeta<ArchiveEffect>(key);
    const current = store.task(taskId);
    if (!effect && !finished(store, current, run)) continue;
    const fresh = !effect;
    if (effect?.status === 'archived') continue;
    if (!effect) {
      store.transaction(() => {
        const latest = store.task(taskId);
        if (!finished(store, latest, run)) return;
        if (run.role === 'reviewer' && latest.resolution.reviewerAgentId === agentId)
          store.update(taskId, { resolution: { ...latest.resolution, reviewerAgentId: null } }, 'reviewer_thread_released', agentId);
        if (run.role === 'recovery' && latest.coordinatorAgentId === agentId)
          store.update(taskId, { coordinatorAgentId: undefined }, 'recovery_thread_released', agentId);
        store.putThreadArchiveEffect(key, agentId, { status: 'intent', at: now() } satisfies ArchiveEffect);
        store.event(taskId, 'thread_archive_intent', `${run.role}: ${agentId}`);
      });
      effect = store.getMeta<ArchiveEffect>(key);
    }
    if (!effect) continue;
    await settleArchive(store, adapter, taskId, agentId, key, fresh, effect);
  }
}


/**
 * Tom, 2026-10-19: once a task is complete it is free to archive. A terminal
 * task needs none of its own threads, whatever their role, idle state or stale
 * tool labels: the worker threads Queue created for this task are archived, and
 * on a host that can remove a thread every support thread (reviewer, recovery,
 * coordinator, executor) is removed (Tom, 2026-11-12; nucleus#1155).
 * Removal loses nothing durable: those runs are released, their verdicts,
 * reports and decisions are already in Nucleus's records and on the pull
 * request, and the thread can take no further turn. Threads Queue does not own
 * (a review-entry author, an origin or external coordinator) carry no `task`
 * label and are never touched.
 */
async function archiveTerminalTaskThreads(store: Store, adapter: Adapter, task: Task, retryProof?: RetryProof): Promise<void> {
  const host = new HostFacade({ adapter });
  const taskRuns = store.runs(task.id);
  const candidates = new Set([task.agentId, ...task.retiredWorkers.map(worker => worker.agentId), ...taskRuns.filter(run => run.hostId === task.hostId && task.hostId).map(run => run.agentId)]
    .filter((agentId): agentId is string => Boolean(agentId)));
  // The task's own worker threads stay as archive history: the worker's thread
  // is where its work happened, and the task keeps it. Every other identity this
  // task ran on is a support thread and is removed where the host can.
  const workerAgents = workerThreadIds(task, taskRuns);
  const supportRemoval = removesThreads(adapter);
  // Read the stored namespace through the shared keys; the ownership owner
  // decides which operation this task owes each thread.
  const opFor = (agentId: string, labels?: Record<string, string>): 'archive' | 'delete' =>
    threadOperation(agentId, labels, workerAgents, supportRemoval);
  const wait = (agentId: string, detail: string) => archiveWait(store, task.id, agentId, detail);
  const archiveOne = async (agentId: string) => {
    if (taskRuns.some(run => run.agentId === agentId && (!run.hostId || run.hostId !== task.hostId))) { wait(agentId, 'Waiting for proven run host'); return; }
    const key = store.threadArchiveKey(agentId, task.hostId);
    if (!key) { wait(agentId, 'Waiting for proven archive host'); return; }
    let op = opFor(agentId);
    let effect = store.getMeta<ArchiveEffect>(key);
    // A record completes this candidate only when it names the same operation:
    // a support thread archived earlier in the task's life is still removed here.
    if (effect?.status === 'archived' && (effect.op ?? 'archive') === op) { store.deleteMeta(archiveProbeKey(store, task.id, agentId)); return; }
    const fresh = !effect || effect.status === 'archived';
    if (!effect || effect.status === 'ready' || fresh) {
      // A thread still serving anything else is not this task's to archive: an
      // unreleased run on any task, or a live binding on another task (a worker
      // remapped as another task's coordinator) (review #543).
      if (threadHasUnreleasedRun(store, task, agentId)) { wait(agentId, 'Thread has an unreleased run'); return; }
      if (threadBoundToAnotherLiveTask(store, task, agentId)) { wait(agentId, 'Thread belongs to another active task'); return; }
      let observed;
      try { observed = await host.observe(agentId); }
      catch (error) {
        // A thread the host already reports archived, removed or absent is done,
        // even when its own projection can no longer be read (a removed T3
        // thread has no projection). Anything else waits for a readable pass.
        let origin: OriginAgent | null = null, readable = false;
        try { origin = await host.originAgent(agentId); readable = true; } catch { /* the same outage keeps the wait */ }
        if (readable && cleanupComplete(origin, op)) {
          store.putThreadArchiveEffect(key, agentId, { status: 'archived', at: now(), detail: 'Observed archived, removed or absent', op } satisfies ArchiveEffect);
          store.deleteMeta(archiveProbeKey(store, task.id, agentId));
          store.event(task.id, 'thread_archive_observed', agentId);
          return;
        }
        wait(agentId, String(error));
        return;
      }
      // A thread Queue does not own is never touched.
      if (!observed || !ownedByTask(observed.labels, task.id)) { store.deleteMeta(archiveProbeKey(store, task.id, agentId)); return; }
      op = opFor(agentId, observed.labels);
      // An active turn or pending permission waits for the next pass (review #543).
      if (observed.active || observed.activeTurnId || observed.permissions || !['idle', 'error', 'closed'].includes(observed.status)) { wait(agentId, 'Thread is active or waiting for permission'); return; }
      store.deleteMeta(archiveProbeKey(store, task.id, agentId));
      // Ownership may have changed while the observation was in flight.
      if (store.getMeta('paused') || threadServesAnotherTask(store, task, agentId)) return;
      // A ready record has never delivered anything: a stopped-reviewer
      // observation marker may safely take the terminal role's desired operation.
      if (effect?.status === 'ready' && (effect.op ?? 'archive') !== op) {
        effect = { ...effect, op };
        store.putThreadArchiveEffect(key, agentId, effect);
      }
      if (!effect || fresh) {
        store.putThreadArchiveEffect(key, agentId, { status: 'intent', at: now(), op } satisfies ArchiveEffect);
        store.event(task.id, 'thread_archive_intent', `terminal task thread: ${op === 'delete' ? 'remove' : 'archive'} ${agentId}`);
        effect = store.getMeta<ArchiveEffect>(key);
        if (!effect) return;
      }
    }
    if (store.getMeta('paused')) return;
    if (!fresh && (effect.status === 'intent' || effect.status === 'uncertain')) {
      // A lost response can only be reconciled by the same identity. Observe
      // before reissuing; the task lane and the durable count fence retries.
      let origin;
      try { origin = await host.originAgent(agentId); }
      catch (error) { wait(agentId, `Archive outcome uncertain: ${String(error)}`); return; }
      if (origin && origin.id !== agentId) { wait(agentId, 'Archive outcome uncertain; thread identity changed'); return; }
      if (cleanupComplete(origin, effect.op ?? 'archive')) { await settleArchive(store, adapter, task.id, agentId, key, false, effect); return; }
      if (effect.status === 'intent' || effect.retryable !== true) {
        wait(agentId, 'Archive outcome uncertain; prior intent has no proven transport-loss result and remains observation-only');
        return;
      }
      const retries = effect.retries ?? 0;
      if (retries >= 3) { wait(agentId, 'Archive outcome uncertain; retry limit reached, owner reconciliation required'); return; }
      if ((effect.nextRetryAt ?? 0) > Date.now()) { wait(agentId, 'Archive outcome uncertain; waiting for retry backoff'); return; }
      if (effect.op === 'delete') {
        // A deletion's unknown outcome is only ever read back: no resend flag, no
        // second command. The observation above proved the thread is still listed.
        wait(agentId, 'Deletion outcome uncertain; observed still present, observation-only');
        return;
      }
      const runs = store.runs(task.id).filter(run => run.agentId === agentId);
      const workspaces = new Set(runs.map(run => run.workspaceId).filter(Boolean));
      if (task.agentId === agentId || task.retiredWorkers.some(worker => worker.agentId === agentId)) {
        if (task.workspaceId) workspaces.add(task.workspaceId);
      }
      if (workspaces.size !== 1 || !retryProof) { wait(agentId, 'Archive outcome uncertain; workspace or owned-tool proof unavailable'); return; }
      const workspaceId = [...workspaces][0]!;
      const safe = async () => {
        admissionOf(adapter)?.invalidate(agentId);
        const state = await host.observe(agentId);
        if (state.id !== agentId || state.workspaceId !== workspaceId || !ownedByTask(state.labels, task.id))
          return 'Thread identity or workspace changed';
        if (state.active || state.activeTurnId || state.permissions || !['idle', 'closed'].includes(state.status))
          return 'Thread is active or waiting for permission';
        const current = store.task(task.id);
        if (!terminalThreadCleanup(current, supportRemoval) || current.removedAt || store.getMeta('paused') || threadServesAnotherTask(store, current, agentId))
          return 'Thread ownership or terminal state changed';
        return null;
      };
      try {
        const first = await safe(); if (first) { wait(agentId, first); return; }
        const tools = await retryProof(agentId, workspaceId); if (tools) { wait(agentId, `Owned-tool proof: ${tools}`); return; }
        await new Promise(resolve => setTimeout(resolve, 250));
        const second = await safe(); if (second) { wait(agentId, second); return; }
        const latest = await host.originAgent(agentId);
        if (latest && latest.id !== agentId) { wait(agentId, 'Thread identity changed'); return; }
        if (cleanupComplete(latest, effect.op ?? 'archive')) { await settleArchive(store, adapter, task.id, agentId, key, false, effect); return; }
        if (!latest || latest.workspaceId !== workspaceId) { wait(agentId, 'Thread identity or workspace changed'); return; }
        wait(agentId, 'Archive outcome uncertain; reissuing after identity, idleness and owned-tool proof');
        await settleArchive(store, adapter, task.id, agentId, key, false, effect, true);
      } catch (error) { wait(agentId, `Archive outcome uncertain: ${String(error)}`); }
      return;
    }
    await settleArchive(store, adapter, task.id, agentId, key, fresh, effect);
  };
  // Two pipelines may overlap, but every outbound call still enters the
  // shared admission controller and its per-class and global limits.
  const pending = [...candidates];
  await Promise.all(Array.from({ length: Math.min(2, pending.length) }, async () => {
    while (pending.length) await archiveOne(pending.shift()!);
  }));
}


export { finishedThreadCleanupKey } from '../store/store-core';

/**
 * Whether this task still owes any of its own threads their terminal cleanup:
 * the worker threads an archive, and on a host that can remove a thread the
 * support threads a removal. The same candidate set and operation the terminal
 * lane uses, read from the durable effect records.
 */
export function threadCleanupPending(store: Store, task: Task, removal: boolean): boolean {
  const runs = store.runs(task.id);
  const workerAgents = workerThreadIds(task, runs);
  const agents = new Set(workerAgents);
  for (const run of runs) if (run.agentId && run.hostId === task.hostId) agents.add(run.agentId);
  return [...agents].some(agentId => {
    const key = store.threadArchiveKey(agentId, task.hostId);
    if (!key) return false;
    const op = threadOperation(agentId, undefined, workerAgents, removal);
    const effect = store.getMeta<ArchiveEffect>(key);
    return !(effect?.status === 'archived' && (effect.op ?? 'archive') === op);
  });
}

/**
 * Finished tasks on this host whose threads this rule has not cleaned up yet.
 * The selection is the store's own query over the durable effect records
 * (`Store.finishedTasksOwingThreadCleanup`), so the meta-key format lives in the
 * store that writes it.
 */
export function finishedThreadCleanupCatchUp(store: Store, hostId: string, removal: boolean): Task[] {
  return store.finishedTasksOwingThreadCleanup(hostId, removal);
}

/** One finished task's cleanup, called on its existing task lane by the sweep. */
export async function catchUpFinishedTaskThreads(store: Store, adapter: Adapter, taskId: string): Promise<void> {
  if (store.getMeta('paused') || !removesThreads(adapter)) return;
  const task = store.task(taskId);
  if (!terminalThreadCleanup(task, true) || store.getMeta(finishedThreadCleanupKey(taskId))) return;
  try { await archiveFinishedThreads(store, adapter, taskId); }
  catch (error) { store.event(taskId, 'thread_cleanup_catch_up_error', String(error).slice(0, 2000)); }
}


function finished(store: Store, task: Task, run: Run): boolean {
  if (run.role === 'executor') {
    // The latest executor agent is retained for the next proof head. Earlier
    // agents are released helpers and can be archived once no run still uses them.
    const retained = store.runs(task.id).findLast(item => item.role === 'executor' && item.agentId)?.agentId;
    return Boolean(retained && retained !== run.agentId);
  }
  // A reviewer retained by any unfinished task remains a live task binding,
  // including review-entry and external-owner reviews. Those source types do
  // not make a released historical review safe to archive while it is still
  // the task's reviewer identity.
  if (run.role === 'reviewer' && task.resolution.reviewerAgentId === run.agentId
      && !['done', 'cancelled'].includes(task.phase) && !task.removedAt) return false;
  if (run.role === 'reviewer')
    return Boolean(run.completion && ['ready_to_merge', 'changes_required'].includes(run.completion.status) &&
      task.resolution.currentRunId !== run.id &&
      (task.resolution.review?.eventId === run.completion.eventId || reviewVerdictApplied(store, task.id, run.id)));
  if (run.role === 'recovery')
    return !task.resolution.recoveryActive && task.resolution.recovery?.status !== 'escalated' &&
      (task.resolution.recovery === null || task.phase === 'done' ||
        task.resolution.recovery?.status === 'resolved' && task.resolution.recoveryAttempts >= 3 && !task.resolution.attention ||
        task.resolution.recovery?.status === 'resolved' &&
        store.events(task.id).some(event => event.kind === 'escalation_resolved' && event.at >= run.createdAt));
  return false;
}

