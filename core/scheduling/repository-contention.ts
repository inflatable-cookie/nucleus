import type { Task } from "../../shared/contracts";
import { digest, now, type Store } from "../store/store";

/**
 * Canonical-main movement is ordinary repository contention. A Chatterbox
 * editing main, a just-landed merge, or a temporarily dirty integration
 * checkout must not create one attention episode per task.
 */
export const REPOSITORY_CONTENTION_GRACE_MS = 5 * 60_000;

const patterns = [
  /Integration checkout is dirty/i,
  /Integration checkout is on a different branch/i,
  /Local integration branch differs from origin/i,
  /Local integration branch must match origin before merge/i,
  /Preserving dirty or switched integration checkout/i,
  /Integration synchronization did not leave a clean expected head/i,
  /Integration write requires a clean synchronized base/i,
  /Prospective merge requires a clean synchronized integration base/i,
  /Local integration base differs from origin/i,
];

export function isRepositoryContention(reason: string): boolean {
  // Hook holds have their own pinned occurrence, replay and refusal contract.
  // The nested Git diagnostic must not replace that lifecycle authority.
  if (/^Repository hook\b/i.test(reason)) return false;
  return patterns.some(pattern => pattern.test(reason));
}

interface RepositoryContentionEpisode {
  taskId: string;
  since: string;
  reason: string;
}

const key = (repoPath: string) => `repositoryContention:${digest(repoPath)}`;

/**
 * Return true only for the one repository leader after the durable grace.
 * A completed or recovered leader closes the old episode; the next contention
 * starts a fresh grace instead of inheriting stale age.
 */
export function repositoryContentionNeedsAttention(store: Store, task: Task, reason: string, at = Date.now()): boolean {
  if (!isRepositoryContention(reason)) return true;
  const metaKey = key(task.repoPath);
  let episode = store.getMeta<RepositoryContentionEpisode>(metaKey);
  if (episode) {
    let leader: Task | null = null;
    try { leader = store.task(episode.taskId); } catch { /* Purged leader closes the episode. */ }
    if (!leader || leader.repoPath !== task.repoPath || leader.phase === "done" || leader.phase === "cancelled" || !isRepositoryContention(leader.reason)) episode = undefined;
  }
  if (!episode) {
    episode = { taskId: task.id, since: now(), reason: reason.slice(0, 2000) };
    store.setMeta(metaKey, episode);
    store.event(task.id, "repository_contention_started", reason.slice(0, 2000));
    return false;
  } else if (episode.taskId === task.id && episode.reason !== reason) {
    episode = { ...episode, reason: reason.slice(0, 2000) };
    store.setMeta(metaKey, episode);
  }
  return episode.taskId === task.id && at - Date.parse(episode.since) >= REPOSITORY_CONTENTION_GRACE_MS;
}
