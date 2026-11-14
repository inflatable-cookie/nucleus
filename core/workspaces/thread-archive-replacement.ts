import type { Adapter } from '../host/adapter';
import { HostFacade } from '../host/host-facade';
import type { Run } from '../../shared/contracts';
import { Store, now } from '../store/store';
import { observationAdvanceSince, runsUnchangedSince } from '../recovery/observation-advance';
import { supersededIdleBinding } from '../recovery/fence-settlement';
import { blockingRecoveryEffectsRefusal } from '../recovery/recovery-effects';
import { ownedByTask, threadHasUnreleasedRun, threadServesAnotherTask } from './thread-ownership';
import { settleArchive, removesThreads, threadArchivedOrGone, type ArchiveEffect } from './thread-archive-effect';

/**
 * The mid-task thread lanes: a thread this task deliberately replaced.
 *
 * A replaced reviewer or a routed-superseded worker is fenced the moment its
 * replacement isolates it, and archived or removed once observation proves it
 * can take no further turn. Nothing here runs at closeout; the terminal lane in
 * `thread-archive.ts` owns that.
 */

/**
 * Fence a deliberately replaced reviewer before releasing its ownership.
 *
 * A host that can remove a thread keeps the displaced thread settled until
 * closeout and removes it there with the rest of the support set (brief v3: no
 * in-flight deletion or archive): the fence is the displaced run's release plus a
 * settled thread, which can no longer report into the task. A host that cannot
 * remove a thread keeps the archive fence it has today, exactly as before.
 */
export async function archiveReplacedReviewer(store: Store, adapter: Adapter, run: Run): Promise<boolean> {
  if (!run.agentId) return false;
  const key = store.threadArchiveKey(run.agentId, run.hostId);
  if (!key || !adapter.originAgent) return false;
  const stoppedAndIdle = async (): Promise<boolean> => {
    const state = await new HostFacade({ adapter }).observe(run.agentId!);
    return state.id === run.agentId && state.workspaceId === run.workspaceId && !state.active && !state.activeTurnId
      && !state.permissions && ['idle', 'error', 'closed'].includes(state.status);
  };
  if (removesThreads(adapter)) {
    // A stop reply may precede its turn becoming idle. Reuse the existing ready
    // observation marker so the sweep finishes that replacement after the stop;
    // ready proves that no archive or delete was sent. A prior unknown effect
    // keeps its own identity and delivery history.
    if (!store.getMeta<ArchiveEffect>(key))
      store.putThreadArchiveEffect(key, run.agentId, { status: 'ready', at: now() } satisfies ArchiveEffect);
    try {
      if (!await stoppedAndIdle()) return false;
      // Presentation only: the thread stays visible and settled until closeout.
      await adapter.settleReportedThread?.(run.agentId, run.id).catch(() => undefined);
      if (store.getMeta<ArchiveEffect>(key)?.status === 'ready') store.deleteMeta(key);
      return true;
    } catch { return false; }
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

/**
 * Archive a superseded worker thread at once (Tom, 2026-11-13; nucleus#1181),
 * as an exception to #1155's "nothing archived while open": when a worker run
 * is replaced on a different profile — an owner `route now`, an approval
 * reroute or failover to another profile — the old worker thread is archived
 * as soon as its run is released and no live run remains on it. Only a host
 * that can remove a thread (T3Code) archives mid-task; Paseo keeps its
 * existing behaviour. The archive is the same durable, idempotent
 * observation-first effect the terminal lane uses: an unknown outcome is
 * never resent, and each thread is archived exactly once.
 */
export async function archiveSupersededWorkers(store: Store, adapter: Adapter, taskId: string): Promise<void> {
  const task = store.task(taskId);
  if (task.removedAt || store.getMeta('paused')) return;
  // Terminal tasks belong to the closeout lane, which archives every worker.
  if (['done', 'cancelled'].includes(task.phase)) return;
  // T3-only from here: check the host kind before touching its reads, so
  // other hosts (and their pinned quantum order) see no new adapter access.
  if (!removesThreads(adapter) || !adapter.originAgent) return;
  const host = new HostFacade({ adapter });
  const live = new Set([task.agentId, task.coordinatorAgentId, task.resolution.reviewerAgentId].filter((id): id is string => Boolean(id)));
  for (const worker of task.retiredWorkers) {
    const agentId = worker.agentId;
    // The current worker, or a thread still serving an unreleased run, stays.
    if (!agentId || live.has(agentId)) continue;
    if (threadHasUnreleasedRun(store, task, agentId)) continue;
    const key = store.threadArchiveKey(agentId, task.hostId);
    if (!key) continue;
    const effect = store.getMeta<ArchiveEffect>(key);
    if (effect?.status === 'archived' && (effect.op ?? 'archive') === 'archive') continue;
    // Archive only what this task owns and what has already ended its turn:
    // a live run or a pending permission waits for the next pass.
    let observed;
    try { observed = await host.observe(agentId); }
    catch { continue; }
    if (!observed || !ownedByTask(observed.labels, task.id)) continue;
    if (observed.active || observed.activeTurnId || observed.permissions || !['idle', 'error', 'closed'].includes(observed.status)) continue;
    const fresh = !effect || effect.status === 'archived';
    if (!effect || fresh) {
      if (threadServesAnotherTask(store, task, agentId)) continue;
      store.putThreadArchiveEffect(key, agentId, { status: 'intent', at: now(), op: 'archive' } satisfies ArchiveEffect);
      store.event(taskId, 'thread_archive_intent', `superseded worker: archive ${agentId}`);
    }
    const current = store.getMeta<ArchiveEffect>(key);
    if (!current) continue;
    await settleArchive(store, adapter, taskId, agentId, key, fresh, current);
  }
}

