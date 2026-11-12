import { historicalWireLabel } from "../../shared/wire-labels";
import { settledThreadStatuses } from "../../shared/host";
import type { Adapter, OriginAgent } from '../host/adapter';
import { HostFacade } from '../host/host-facade';
import type { Run, Task } from '../../shared/contracts';
import { isDispositionActive } from '../../shared/contracts';
import { Store, now } from '../store/store';
import { AdmissionDeferred, admissionOf } from '../host/admission';
import { ArchiveNotDeliveredError } from './archive-delivery';
import { isTransportFailure } from '../../shared/transport';
import { formatAgentId } from '../../shared/agent-identity';
import { supersededIdleBinding } from '../recovery/fence-settlement';
import { blockingRecoveryEffectsRefusal } from '../recovery/recovery-effects';
import { observationAdvanceSince, runsUnchangedSince } from '../recovery/observation-advance';

type ArchiveEffect = { status: 'intent' | 'ready' | 'archived' | 'uncertain'; at: string; detail?: string; retries?: number; nextRetryAt?: number; retryable?: boolean;
  /** The cleanup this record names: archive the thread, or remove it (nucleus#1155). */
  op?: 'archive' | 'delete' };
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
export function terminalThreadCleanup(task: Task, proofOnlyDone = proofOnlyComplete(task)): boolean {
  if (task.removedAt) return false;
  if (task.phase === 'done') return Boolean(task.resolution.mergedCommit || proofOnlyDone);
  return task.phase === 'cancelled' && task.disposition?.status === 'complete';
}

/**
 * A host that can remove a thread keeps a task's support threads settled and
 * visible while the task is open, and removes them at closeout (Tom,
 * 2026-11-12; nucleus#1155). Nothing they hold is the only copy: review text,
 * verdicts, recovery reports and decisions already live in Nucleus's records and
 * on the pull request, and the thread's runs are released before the removal.
 * Paseo has no removal, so its support threads keep the archive behaviour they
 * have today: there they stay hidden on the workspace once archived.
 */
export const removesThreads = (adapter: Adapter): boolean => typeof adapter.deleteAgent === 'function';

/**
 * The host's own answer that the recorded cleanup finished. A removed or absent
 * thread finishes either operation; an archived one finishes an archive only —
 * a removal still owes the thread's deletion. Only a direct per-agent answer
 * counts.
 */
function cleanupComplete(origin: OriginAgent | null, op: 'archive' | 'delete' = 'archive'): boolean {
  if (!origin || origin.deleted === true) return true;
  return op === 'archive' && origin.archived === true;
}

/**
 * Whether this task owns the thread: it carries the task label, or the decider
 * label the ladder created a recorded decider thread with. Any other label is
 * another task's thread and is never touched.
 */
function ownedByTask(labels: Record<string, string> | undefined, taskId: string, agentId: string, deciders: ReadonlySet<string>): boolean {
  if (historicalWireLabel(labels, 'task') === taskId) return true;
  return deciders.has(agentId) && historicalWireLabel(labels, 'decider') === taskId;
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

/**
 * Fence a deliberately replaced reviewer before releasing its ownership.
 *
 * On a host that can remove a thread the displaced thread is kept until
 * closeout (nucleus#1155 review): the fence is a stopped turn that is observed
 * idle, with its run released and its credential revoked, so nothing can address
 * it again, and the terminal lane removes the thread with the rest of the task's
 * support threads. On a host that cannot remove a thread the archive is that
 * fence, exactly as before.
 */
export async function archiveReplacedReviewer(store: Store, adapter: Adapter, run: Run): Promise<boolean> {
  if (!run.agentId) return false;
  const key = store.threadArchiveKey(run.agentId, run.hostId);
  if (!key || !adapter.originAgent) return false;
  const stoppedAndIdle = async (): Promise<boolean> => {
    const state = await new HostFacade({ adapter }).observe(run.agentId!);
    return state.id === run.agentId && state.workspaceId === run.workspaceId && !state.active && !state.activeTurnId
      && !state.permissions && settledThreadStatuses.includes(state.status);
  };
  if (removesThreads(adapter)) {
    // The fence is the displaced thread's removal, recorded durably: an idle
    // observation alone would let it take another turn, and an archive would
    // break the "nothing archived while the task is open" lifecycle
    // (nucleus#1155 review). The verb has already stopped the turn, and every
    // attempt re-proves it idle before anything is sent.
    let effect = store.getMeta<ArchiveEffect>(key);
    if (effect?.status === 'archived') return true;
    if (!effect) {
      store.putThreadArchiveEffect(key, run.agentId, { status: 'ready', at: now(), op: 'delete' } satisfies ArchiveEffect);
      store.event(run.taskId, 'thread_delete_intent', `replaced reviewer: ${run.agentId}`);
      effect = store.getMeta<ArchiveEffect>(key);
      if (!effect) return false;
    }
    if ((effect.retries ?? 0) >= 3) return false;
    try { if (!await stoppedAndIdle()) return false; } catch { return false; }
    await settleArchive(store, adapter, run.taskId, run.agentId, key, effect.status === 'ready', effect, effect.status !== 'ready');
    return store.getMeta<ArchiveEffect>(key)?.status === 'archived';
  }
  let effect = store.getMeta<ArchiveEffect>(key);
  const fresh = !effect;
  if (!effect) {
    // Record the replacement before observing the stopped turn. A successful
    // stop reply can precede inactivity; `ready` proves no archive was sent and
    // lets observation finish the same replacement once the turn becomes idle.
    effect = { status: 'ready', at: now() };
    store.putThreadArchiveEffect(key, run.agentId, effect);
    store.event(run.taskId, 'thread_archive_intent', `reviewer: ${run.agentId}`);
  }
  if (effect.status === 'ready' && !await stoppedAndIdle()) return false;
  if (effect.status !== 'archived') await settleArchive(store, adapter, run.taskId, run.agentId, key, fresh, effect);
  return store.getMeta<ArchiveEffect>(key)?.status === 'archived';
}

/**
 * Whether the host itself reports this thread archived or gone: the proof the
 * ordinary archive path accepts (`Observed archived or absent`). Only a direct
 * per-agent answer counts. An unsupported or unreadable read proves nothing, and
 * a list that does not mention the identity is never read as absence.
 */
export async function threadArchivedOrGone(adapter: Adapter, agentId: string): Promise<boolean> {
  if (!adapter.originAgent) return false;
  const observed = await new HostFacade({ adapter }).originAgent(agentId);
  return !observed || observed.archived === true || observed.deleted === true;
}

/**
 * Release one superseded or replaced run whose thread its host reports archived
 * or gone. Such a thread can never report or take another turn, so leaving the
 * lease held only fences the next launch: observation releases it here under the
 * same proof the archive path accepts, and the run then also stops being a
 * relaunch candidate. The run keeps its status, head and history; no completion
 * is invented and no credential is reused. When the task still names this
 * thread's agent as its retained reviewer, that binding is cleared so the next
 * launch selects a reader that can actually report (the reviewer route stays).
 * Returns whether this call released the run.
 */
export async function releaseUnreachableRun(store: Store, adapter: Adapter, run: Run, stopped: () => boolean = () => false): Promise<boolean> {
  if (run.released || run.completion || !run.agentId) return false;
  if (run.status !== 'superseded' && run.replacedAt === undefined) return false;
  // A service shutdown is not permission to write: the next process re-observes.
  if (stopped()) return false;
  // The host's answer is evidence about the identity and lease read here, so the
  // facts it was read against are captured before the await: a stop, a callback,
  // a release or a new lease while Queue watches wins over that stale answer.
  const admittedTask = store.task(run.taskId);
  const admittedVersion = admittedTask.version, admittedRuns = store.runs(run.taskId);
  let unreachable = false;
  try { unreachable = await threadArchivedOrGone(adapter, run.agentId); } catch { return false; }
  if (!unreachable || stopped()) return false;
  return store.transaction(() => {
    // A shutdown that landed during the read settles nothing; the next pass and
    // the next process re-observe the same facts.
    if (stopped()) return false;
    const latest = store.run(run.id);
    if (!latest || latest.released || latest.completion) return false;
    const task = store.task(run.taskId);
    // Nothing but the lifecycle's own observation writes may have happened since
    // the archive read: any substantive task change (a stop, a phase, a hold, a
    // route) or any run change (a result, a delivery, an effect, a released or
    // re-leased run) refuses the release and leaves it to a later pass.
    if (!observationAdvanceSince(task, admittedVersion) || !runsUnchangedSince(admittedRuns, store.runs(run.taskId))) return false;
    if (latest.agentId !== run.agentId || latest.workspaceId !== run.workspaceId) return false;
    // The ordinary superseded release owns the binding rules: a creation intent,
    // uncertain delivery, pending authenticated delivery, current binding, stop
    // intent or checkpoint intent is never released by observation alone. A
    // proven archived thread is the closed proof a replaced reviewer's own
    // settlement accepts (planner ruling, 2026-11-09), so it settles that claim
    // and nothing else: the archive proves the thread cannot take a turn, never
    // what an unsettled delivery or effect already did.
    const binding = supersededIdleBinding(store, run.taskId, latest, { settledClaim: latest.replacedAt !== undefined });
    if (!binding.superseded) return false;
    if (blockingRecoveryEffectsRefusal(store, task, { runId: latest.id })) return false;
    const at = now();
    // The archived thread is the terminal observation the closed-agent path
    // records: no same-agent continuation can ever land on it, so the relaunch
    // selections stop naming this run.
    const closed = latest.role === 'reviewer' ? { retainedAgentClosedAt: latest.retainedAgentClosedAt ?? at } : {};
    store.putRun({ ...latest, status: 'superseded', released: true, active: false, ...closed });
    store.event(run.taskId, 'run_released_from_observed_liveness', `${latest.role} ${latest.id}: its thread is archived or gone on its host`.slice(0, 2000));
    if (latest.role === 'reviewer' && latest.agentId) {
      store.event(run.taskId, 'reviewer_agent_closed', JSON.stringify({ runId: latest.id, agentId: latest.agentId,
        workspaceId: latest.workspaceId, head: latest.head, checkpointOrdinal: latest.reviewCheckpoints?.at(-1)?.ordinal ?? null, observedAt: at }));
      const current = store.task(run.taskId);
      if (current.resolution.reviewerAgentId === latest.agentId)
        store.update(current.id, { resolution: { ...current.resolution, reviewerAgentId: null } }, 'reviewer_thread_released', latest.agentId);
    }
    return true;
  });
}

/** A pending replacement archive remains owned until ordinary observation settles it. */
export async function observeReviewerReplacement(store: Store, adapter: Adapter, run: Run): Promise<boolean> {
  const key = run.agentId && store.threadArchiveKey(run.agentId, run.hostId);
  if (run.role !== 'reviewer' || run.released || run.completion || !key || !store.getMeta<ArchiveEffect>(key)) return false;
  if (await archiveReplacedReviewer(store, adapter, run)) {
    store.transaction(() => {
      const latest = store.run(run.id)!;
      if (latest.completion || latest.released) return;
      store.putRun({ ...latest, status: 'superseded', released: true, active: false, replacedAt: now() });
      const task = store.task(run.taskId);
      if (task.resolution.currentRunId === run.id)
        store.update(task.id, { phase: 'awaiting_review', resolution: { ...task.resolution, currentRunId: null,
          reviewerAgentId: null, reviewerProfile: null, attention: false, recoveryActive: false } }, 'restart_review_fresh');
    });
  }
  return true;
}

/** Release a finished role binding before its thread is archived. An intent fences restart. */
export async function archiveFinishedThreads(store: Store, adapter: Adapter, taskId: string, retryProof?: RetryProof): Promise<void> {
  const host = new HostFacade({ adapter });
  const task = store.task(taskId);
  if (isDispositionActive(task) || task.removedAt || store.getMeta('paused') || !adapter.originAgent) return;
  const proofOnlyDone = proofOnlyComplete(task);
  if (terminalThreadCleanup(task, proofOnlyDone)) return archiveTerminalTaskThreads(store, adapter, task, retryProof);
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

/** Observe, then archive or remove at most once, one thread whose cleanup intent is recorded. */
async function settleArchive(store: Store, adapter: Adapter, taskId: string, agentId: string, key: string, fresh: boolean, effect: ArchiveEffect, retry = false): Promise<void> {
  const host = new HostFacade({ adapter });
  if (!adapter.originAgent) return;
  // The record names the operation: an intent keeps the operation that may
  // already have been sent, so a recorded archive is never reissued as a delete.
  const op = effect.op ?? 'archive';
  const remove = op === 'delete';
  const done = remove ? 'Observed deleted or absent' : 'Observed archived or absent';
  let sent = false;
  try {
    const observed = await host.originAgent(agentId);
    if (cleanupComplete(observed, op)) {
      store.putThreadArchiveEffect(key, agentId, { status: 'archived', at: now(), detail: done, ...(effect.op ? { op: effect.op } : {}) } satisfies ArchiveEffect);
      store.deleteMeta(archiveProbeKey(store, taskId, agentId));
      store.event(taskId, 'thread_archive_observed', agentId);
      store.retireThreadScratch(taskId, agentId);
      return;
    }
    // An intent from a previous process has an unknown outcome. Observe it,
    // but do not issue the archive again merely because it still looks live.
    if (!fresh && effect.status !== 'ready' && !retry) {
      if (effect.status === 'intent') {
        store.putThreadArchiveEffect(key, agentId, { status: 'uncertain', at: now(), detail: 'Prior archive intent still appears live', retryable: false, ...(effect.op ? { op: effect.op } : {}) } satisfies ArchiveEffect);
        store.event(taskId, 'thread_archive_uncertain', `${agentId}: prior archive intent still appears live`);
      }
      return;
    }
    // Persist the delivery fence again before the call, including a safe retry.
    const retries = (effect.retries ?? 0) + (retry ? 1 : 0);
    store.putThreadArchiveEffect(key, agentId, { status: 'intent', at: now(), retries, nextRetryAt: Date.now() + 2000 * 2 ** Math.max(0, retries - 1), ...(effect.op ? { op: effect.op } : {}) } satisfies ArchiveEffect);
    sent = true;
    // A retry only reaches here after the caller re-proved the same identity,
    // workspace, idleness and owned tools, so the identical command may be sent
    // again under its own identity; the host replays its recorded receipt.
    if (remove) await host.deleteAgent(agentId, retry ? { resendUnknownAfterRead: true } : undefined);
    else await host.archiveAgent(agentId);
    const after = await host.originAgent(agentId);
    if (!cleanupComplete(after, op)) throw Error(remove ? 'Thread deletion was not confirmed' : 'Archive was not confirmed');
    store.putThreadArchiveEffect(key, agentId, { status: 'archived', at: now(), detail: remove ? 'Deletion observed' : 'Archive observed', ...(effect.op ? { op: effect.op } : {}) } satisfies ArchiveEffect);
    store.deleteMeta(archiveProbeKey(store, taskId, agentId));
    store.event(taskId, 'thread_archive_observed', agentId);
    // The thread can take no further turn, so the leaves its tools started with
    // are done: removal goes through the same recorded-leaf path release uses.
    store.retireThreadScratch(taskId, agentId);
  } catch (error) {
    // A breaker deferral reached no Paseo call. Deferred is a wait, not
    // uncertainty: the withdrawn intent stays retryable, and the unchanged wait
    // is recorded once instead of a `thread_archive_uncertain` every few seconds.
    if (error instanceof AdmissionDeferred) {
      const detail = String(error);
      if (effect.detail !== detail) store.event(taskId, 'thread_archive_wait', `${agentId}: Archive deferred: ${detail}`);
      store.putThreadArchiveEffect(key, agentId, { status: 'ready', at: now(), detail, retries: effect.retries ?? 0, retryable: effect.retryable, ...(effect.op ? { op: effect.op } : {}) } satisfies ArchiveEffect);
      return;
    }
    // A failed read before delivery is safe to try again; after delivery starts
    // its outcome remains unknown and may only be observed.
    store.putThreadArchiveEffect(key, agentId, { status: sent && !(error instanceof ArchiveNotDeliveredError) ? 'uncertain' : effect.status === 'uncertain' || !fresh && effect.status === 'intent' ? 'uncertain' : 'ready', at: now(), detail: String(error), retries: (effect.retries ?? 0) + (retry ? 1 : 0), nextRetryAt: retry ? Date.now() + 2000 * 2 ** (effect.retries ?? 0) : undefined, retryable: sent && !(error instanceof ArchiveNotDeliveredError) && (isTransportFailure(error) || /connection (?:lost|reset)/i.test(String(error))) ? true : effect.retryable, ...(effect.op ? { op: effect.op } : {}) } satisfies ArchiveEffect);
    store.event(taskId, 'thread_archive_uncertain', `${agentId}: ${String(error)}`);
  }
}

/**
 * A thread archive that is waiting says so once per distinct reason, keyed by
 * the same probe record the terminal lane uses. An unchanged wait is not a new
 * event.
 */
function archiveWait(store: Store, taskId: string, agentId: string, detail: string): void {
  const key = archiveProbeKey(store, taskId, agentId);
  if (store.getMeta<string>(key) !== detail) store.event(taskId, 'thread_archive_wait', `${agentId}: ${detail}`);
  store.setMeta(key, detail);
}

export function archiveProbeKey(store: Store, taskId: string, agentId: string): string {
  const hostId = store.task(taskId).hostId;
  return hostId ? `threadArchiveQualifiedProbe:${formatAgentId(hostId, agentId)}` : `threadArchiveUnknownProbe:${JSON.stringify([taskId, agentId])}`;
}

/**
 * Tom, 2026-10-19: once a task is complete it is free to archive. A terminal
 * task needs none of its own threads, whatever their role, idle state or stale
 * tool labels: the worker threads Queue created for this task are archived, and
 * on a host that can remove a thread every support thread (reviewer, recovery,
 * coordinator, decider, executor) is removed (Tom, 2026-11-12; nucleus#1155).
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
  const workerAgents = new Set([task.agentId, ...task.retiredWorkers.map(worker => worker.agentId)]
    .filter((agentId): agentId is string => Boolean(agentId)));
  const supportRemoval = removesThreads(adapter);
  // A decider is not a run: its ownership is recorded when the ladder creates it,
  // and it is a support thread like any other for this cleanup (nucleus#1155).
  const deciderAgents = new Set(supportRemoval ? deciderThreadOwners(store, task) : []);
  for (const agentId of deciderAgents) candidates.add(agentId);
  const opFor = (agentId: string): 'archive' | 'delete' => supportRemoval && !workerAgents.has(agentId) ? 'delete' : 'archive';
  const wait = (agentId: string, detail: string) => archiveWait(store, task.id, agentId, detail);
  const archiveOne = async (agentId: string) => {
    if (taskRuns.some(run => run.agentId === agentId && (!run.hostId || run.hostId !== task.hostId))) { wait(agentId, 'Waiting for proven run host'); return; }
    const key = store.threadArchiveKey(agentId, task.hostId);
    if (!key) { wait(agentId, 'Waiting for proven archive host'); return; }
    const op = opFor(agentId);
    let effect = store.getMeta<ArchiveEffect>(key);
    // A record completes this candidate only when it names the same operation:
    // a support thread archived earlier in the task's life is still removed here.
    if (effect?.status === 'archived' && (effect.op ?? 'archive') === op) { store.deleteMeta(archiveProbeKey(store, task.id, agentId)); return; }
    const fresh = !effect || effect.status === 'archived';
    if (!effect || effect.status === 'ready' || fresh) {
      // A thread still serving anything else is not this task's to archive: an
      // unreleased run on any task, or a live binding on another task (a worker
      // remapped as another task's coordinator) (review #543).
      if (store.unreleasedRunsForAgent(agentId, task.hostId).length) { wait(agentId, 'Thread has an unreleased run'); return; }
      if (store.tasks().some(other => other.id !== task.id && (!other.hostId || !task.hostId || other.hostId === task.hostId) && !['done', 'cancelled'].includes(other.phase) && !other.removedAt
        && [other.agentId, other.coordinatorAgentId, other.resolution.reviewerAgentId].includes(agentId))) { wait(agentId, 'Thread belongs to another active task'); return; }
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
      if (!observed || !ownedByTask(observed.labels, task.id, agentId, deciderAgents)) { store.deleteMeta(archiveProbeKey(store, task.id, agentId)); return; }
      // An active turn or pending permission waits for the next pass (review #543).
      if (observed.active || observed.activeTurnId || observed.permissions || !['idle', 'error', 'closed'].includes(observed.status)) { wait(agentId, 'Thread is active or waiting for permission'); return; }
      store.deleteMeta(archiveProbeKey(store, task.id, agentId));
      // Ownership may have changed while the observation was in flight.
      if (store.getMeta('paused') || store.unreleasedRunsForAgent(agentId, task.hostId).length || store.tasks().some(other => other.id !== task.id && (!other.hostId || !task.hostId || other.hostId === task.hostId) && !['done', 'cancelled'].includes(other.phase) && !other.removedAt
        && [other.agentId, other.coordinatorAgentId, other.resolution.reviewerAgentId].includes(agentId))) return;
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
      const runs = store.runs(task.id).filter(run => run.agentId === agentId);
      const workspaces = new Set(runs.map(run => run.workspaceId).filter(Boolean));
      // A decider has no run row; it worked in the task's own workspace.
      if (deciderAgents.has(agentId) && task.workspaceId) workspaces.add(task.workspaceId);
      if (task.agentId === agentId || task.retiredWorkers.some(worker => worker.agentId === agentId)) {
        if (task.workspaceId) workspaces.add(task.workspaceId);
      }
      if (workspaces.size !== 1 || !retryProof) { wait(agentId, 'Archive outcome uncertain; workspace or owned-tool proof unavailable'); return; }
      const workspaceId = [...workspaces][0]!;
      const safe = async () => {
        admissionOf(adapter)?.invalidate(agentId);
        const state = await host.observe(agentId);
        if (state.id !== agentId || state.workspaceId !== workspaceId || !ownedByTask(state.labels, task.id, agentId, deciderAgents))
          return 'Thread identity or workspace changed';
        if (state.active || state.activeTurnId || state.permissions || !['idle', 'closed'].includes(state.status))
          return 'Thread is active or waiting for permission';
        const current = store.task(task.id);
        if (!terminalThreadCleanup(current) || current.removedAt || store.getMeta('paused') || store.unreleasedRunsForAgent(agentId, task.hostId).length || store.tasks().some(other => other.id !== task.id && (!other.hostId || !task.hostId || other.hostId === task.hostId) && !other.removedAt && !['done', 'cancelled'].includes(other.phase) && [other.agentId, other.coordinatorAgentId, other.resolution.reviewerAgentId].includes(agentId)))
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

/**
 * The decider threads this task owns, recorded when the ladder creates one. A
 * decider is not a run, so the task's own event stream is its durable ownership
 * record (nucleus#1155 review).
 */
export function deciderThreadOwners(store: Store, task: Task): string[] {
  const ids = new Set<string>();
  // The complete history, not the recent-events window: a decider recorded early
  // in a long task's life must still be found at closeout (nucleus#1155 review).
  for (const event of store.eventsAll(task.id)) {
    if (event.kind !== 'decider_thread_owned') continue;
    try {
      const record = JSON.parse(event.detail) as { agentId?: unknown; hostId?: unknown };
      if (typeof record.agentId !== 'string' || !record.agentId) continue;
      if (typeof record.hostId === 'string' && record.hostId && task.hostId && record.hostId !== task.hostId) continue;
      ids.add(record.agentId);
    } catch { /* an unreadable record names no thread */ }
  }
  return [...ids];
}

/**
 * Record one decider thread's ownership once; an unchanged record is the same
 * intent. Written when creation is established (the same durable step that opens
 * the delegation window) and again, idempotently, by the resume path and by the
 * ladder's own retirement, so an interrupted delegation still reaches closeout.
 */
export function recordDeciderThread(store: Store, task: Task, agentId: string): void {
  if (!agentId || deciderThreadOwners(store, task).includes(agentId)) return;
  store.event(task.id, 'decider_thread_owned', JSON.stringify({ agentId, hostId: task.hostId ?? null }));
}

/**
 * Retire a short-lived decider thread once it has answered. Its answer is already
 * durable in the task's own escalation record, so nothing depends on the thread.
 *
 * A host that can remove a thread keeps the decider until closeout (nucleus#1155
 * and its review): nothing is archived or removed while the task is open, so the
 * owned identity is recorded durably here and the terminal lane removes it with
 * the rest of the task's support threads, retries included. A host that cannot
 * remove a thread keeps today's immediate archive (Paseo), which was presentation
 * only, so a failed call is ignored the same way.
 */
export async function retireDeciderThread(store: Store, host: { archiveAgent(id: string): Promise<void>;
  deleteAgent?(id: string, options?: { resendUnknownAfterRead?: boolean }): Promise<void> }, adapter: Adapter, task: Task, agentId: string): Promise<void> {
  if (removesThreads(adapter)) {
    try { recordDeciderThread(store, task, agentId); } catch { /* the decision itself is already durable */ }
    return;
  }
  try { await host.archiveAgent(agentId); } catch { /* presentation only; the decision is durable in the task's records */ }
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
      (task.resolution.review?.eventId === run.completion.eventId ||
        store.events(task.id).some(event => ['review_result_applied', 'review_reapplied'].includes(event.kind) && event.detail === run.id)));
  if (run.role === 'recovery')
    return !task.resolution.recoveryActive && task.resolution.recovery?.status !== 'escalated' &&
      (task.resolution.recovery === null || task.phase === 'done' ||
        task.resolution.recovery?.status === 'resolved' && task.resolution.recoveryAttempts >= 3 && !task.resolution.attention ||
        task.resolution.recovery?.status === 'resolved' &&
        store.events(task.id).some(event => event.kind === 'escalation_resolved' && event.at >= run.createdAt));
  return false;
}
