import type { PoolEntry, Profile, Task, UsageLevel } from "../../shared/contracts";
import { chooseProfile } from "./routing";
import { workerProfileIsExcluded } from "../../shared/contracts";
import { hostKindOf, type HostKind } from "../../shared/host-kind";

/** A catalog snapshot from an online host. Unread and offline hosts must be omitted. */
export type WorkerHostCatalog = { hostId: string; profiles: Profile[] };

/**
 * Select once across profiles, not once per host: duplicate host routes must not
 * give a profile extra weight in rotation. Once the profile is chosen, prefer
 * the task's admission host if it supports the actual selected thinking option.
 */
export function chooseFirstWorkerHost(
  task: Task,
  hosts: WorkerHostCatalog[],
  pool: PoolEntry[],
  counts: Record<string, number>,
  unavailable: Set<string>,
  recent: Record<string, number>,
  usage: UsageLevel,
  preferredKinds: readonly (HostKind | null | undefined)[] = [],
) {
  const profiles = combineWorkerHostProfiles(hosts).filter(
    (profile) => !workerProfileIsExcluded(task, profile.id),
  );
  const selected = chooseProfile(
    task,
    profiles,
    pool,
    counts,
    unavailable,
    "worker",
    recent,
    usage,
    true,
  );
  if (!selected) return null;
  const capable = hosts.filter((host) =>
    host.profiles.some(
      (profile) =>
        profile.id === selected.profile.id &&
        profile.available &&
        (!selected.profile.thinkingOptionId ||
          profile.supportedThinking.includes(
            selected.profile.thinkingOptionId,
          )),
    ),
  );
  const explicit =
    task.hostSelection?.basis === "explicit"
      ? capable.find((candidate) => candidate.hostId === task.hostId)
      : undefined;
  const host =
    explicit ??
    preferredKinds.flatMap((kind) =>
      kind
        ? capable.filter((candidate) => hostKindOf(candidate.hostId) === kind)
        : [],
    )[0] ??
    capable.find((candidate) => candidate.hostId === task.hostId) ??
    capable[0];
  if (!host) return null;
  const profile = host.profiles.find(
    (candidate) => candidate.id === selected.profile.id,
  )!;
  return {
    ...selected,
    profile: {
      ...profile,
      thinkingOptionId: selected.profile.thinkingOptionId,
    },
    hostId: host.hostId,
    capableHostIds: capable.map((candidate) => candidate.hostId),
  };
}

/** One row per profile, with options available on any supplied host. */
export function combineWorkerHostProfiles(
  hosts: readonly WorkerHostCatalog[],
): Profile[] {
  const profiles = new Map<string, Profile>();
  for (const host of hosts)
    for (const profile of host.profiles) {
      const existing = profiles.get(profile.id);
      if (!existing || (!existing.available && profile.available))
        profiles.set(profile.id, profile);
      else if (existing.available && profile.available)
        profiles.set(profile.id, {
          ...existing,
          supportedThinking: [
            ...new Set([
              ...existing.supportedThinking,
              ...profile.supportedThinking,
            ]),
          ],
        });
    }
  return [...profiles.values()];
}
