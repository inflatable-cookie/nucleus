import type { DemandRoleOffsets, PoolEntry, Profile, Task, UsageLevel } from '../../shared/contracts';
import { chooseProfile } from './routing';

/** A catalog snapshot from an online host. Unread and offline hosts must be omitted. */
export type WorkerHostCatalog = { hostId: string; profiles: Profile[] };

/**
 * Select once across profiles, not once per host: duplicate host routes must not
 * give a profile extra weight in rotation. Once the profile is chosen, prefer
 * the task's admission host if it supports the actual selected thinking option.
 */
export function chooseFirstWorkerHost(
  task: Task, hosts: WorkerHostCatalog[], pool: PoolEntry[], counts: Record<string, number>,
  unavailable: Set<string>, recent: Record<string, number>, usage: UsageLevel, offsets: DemandRoleOffsets,
) {
  const profiles = new Map<string, Profile>();
  for (const host of hosts) for (const profile of host.profiles) {
    if (!profile.available) continue;
    const existing = profiles.get(profile.id);
    profiles.set(profile.id, existing ? {
      ...existing,
      supportedThinking: [...new Set([...existing.supportedThinking, ...profile.supportedThinking])],
    } : profile);
  }
  const selected = chooseProfile(task, [...profiles.values()], pool, counts, unavailable, 'worker', recent, usage, offsets, true);
  if (!selected) return null;
  const capable = hosts.filter(host => host.profiles.some(profile => profile.id === selected.profile.id && profile.available &&
    (!selected.profile.thinkingOptionId || profile.supportedThinking.includes(selected.profile.thinkingOptionId))));
  const host = capable.find(candidate => candidate.hostId === task.hostId) ?? capable[0];
  if (!host) return null;
  const profile = host.profiles.find(candidate => candidate.id === selected.profile.id)!;
  return { ...selected, profile: { ...profile, thinkingOptionId: selected.profile.thinkingOptionId }, hostId: host.hostId,
    capableHostIds: capable.map(candidate => candidate.hostId) };
}
