import type { Adapter, OriginAgent } from '../host/adapter';
import { HostFacade } from '../host/host-facade';
import { Store, now } from '../store/store';
import { AdmissionDeferred } from '../host/admission';
import { ArchiveNotDeliveredError } from './archive-delivery';
import { isTransportOrConnectionLoss } from '../../shared/transport';
import { formatAgentId } from '../../shared/agent-identity';

/**
 * The durable thread archive effect: observe, then archive or remove a thread
 * at most once, and record what the host proved.
 *
 * One effect record per thread names the operation it may already have
 * delivered, so an unknown outcome is never reissued as the other operation.
 * A read that failed before delivery is safely retryable; a delivery whose
 * outcome is unknown is observation-only until the host itself reports the
 * thread archived or gone.
 */

/** The recorded effect for one thread: what was asked, what was proved. */
export type ArchiveEffect = { status: 'intent' | 'ready' | 'archived' | 'uncertain'; at: string; detail?: string; retries?: number; nextRetryAt?: number; retryable?: boolean;
  /** The cleanup this record names: archive the thread, or remove it (nucleus#1155). */
  op?: 'archive' | 'delete' };

/** Observe, then archive or remove at most once, one thread whose cleanup intent is recorded. */
export async function settleArchive(store: Store, adapter: Adapter, taskId: string, agentId: string, key: string, fresh: boolean, effect: ArchiveEffect, retry = false): Promise<void> {
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
    if (remove) await host.deleteAgent(agentId);
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
    if (remove && error instanceof ArchiveNotDeliveredError && (fresh || effect.status === 'ready')) {
      // The adapter proved this occurrence never reached the host. Keep the
      // existing terminal lane ready; no prior unknown delivery is reopened.
      store.putThreadArchiveEffect(key, agentId, { status: 'ready', at: now(), detail: String(error),
        retries: effect.retries ?? 0, ...(effect.op ? { op: effect.op } : {}) } satisfies ArchiveEffect);
      store.event(taskId, 'thread_archive_wait', `${agentId}: ${String(error)}`);
      return;
    }
    // A failed read before delivery is safe to try again; after delivery starts
    // its outcome remains unknown and may only be observed.
    store.putThreadArchiveEffect(key, agentId, { status: sent && !(error instanceof ArchiveNotDeliveredError) ? 'uncertain' : effect.status === 'uncertain' || !fresh && effect.status === 'intent' ? 'uncertain' : 'ready', at: now(), detail: String(error), retries: (effect.retries ?? 0) + (retry ? 1 : 0), nextRetryAt: retry ? Date.now() + 2000 * 2 ** (effect.retries ?? 0) : undefined, retryable: sent && !(error instanceof ArchiveNotDeliveredError) && isTransportOrConnectionLoss(error) ? true : effect.retryable, ...(effect.op ? { op: effect.op } : {}) } satisfies ArchiveEffect);
    store.event(taskId, 'thread_archive_uncertain', `${agentId}: ${String(error)}`);
  }
}

/**
 * A thread archive that is waiting says so once per distinct reason, keyed by
 * the same probe record the terminal lane uses. An unchanged wait is not a new
 * event.
 */
export function archiveWait(store: Store, taskId: string, agentId: string, detail: string): void {
  const key = archiveProbeKey(store, taskId, agentId);
  if (store.getMeta<string>(key) !== detail) store.event(taskId, 'thread_archive_wait', `${agentId}: ${detail}`);
  store.setMeta(key, detail);
}

export function archiveProbeKey(store: Store, taskId: string, agentId: string): string {
  const hostId = store.task(taskId).hostId;
  return hostId ? `threadArchiveQualifiedProbe:${formatAgentId(hostId, agentId)}` : `threadArchiveUnknownProbe:${JSON.stringify([taskId, agentId])}`;
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

/** A host that can remove a thread keeps a task's support threads settled and removed at closeout. */
export const removesThreads = (adapter: Adapter): boolean => typeof adapter.deleteAgent === 'function';

/**
 * The host's own answer that the recorded cleanup finished. A removed or absent
 * thread finishes either operation; an archived one finishes an archive only —
 * a removal still owes the thread's deletion. Only a direct per-agent answer
 * counts.
 */
export function cleanupComplete(origin: OriginAgent | null, op: 'archive' | 'delete' = 'archive'): boolean {
  if (!origin || origin.deleted === true) return true;
  return op === 'archive' && origin.archived === true;
}
