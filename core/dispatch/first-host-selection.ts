import type {
  PoolEntry,
  Profile,
  Task,
  UsageLevel,
} from "../../shared/contracts";
import { chooseProfile } from "./routing";
import { workerProfileIsExcluded } from "../../shared/contracts";
import {
  HOST_KIND_LABELS,
  hostKindOf,
  type HostKind,
} from "../../shared/host-kind";

/** A catalog snapshot from an online host. Unread and offline hosts must be omitted. */
export type WorkerHostCatalog = { hostId: string; profiles: Profile[] };

/**
 * What one dispatch read beside its selection. Omitted evidence is never proof
 * of incompatibility, so the reason names the hosts it could not read and whether
 * the effective target's ready catalog positively lacks the profile.
 */
export type WorkerHostObservation = {
  unreadHostIds?: readonly string[];
  targetKind?: HostKind | null;
};

export function formatWorkerHostSelectionReason(
  profileName: string,
  hostId: string,
  capableHostIds: readonly string[],
  preferredHostId?: string | null,
  observation: WorkerHostObservation = {},
): string {
  const unread = observation.unreadHostIds ?? [];
  const targetKind = observation.targetKind ?? null;
  const targetAbsent =
    targetKind !== null &&
    !capableHostIds.some((id) => hostKindOf(id) === targetKind);
  const placement =
    capableHostIds.length === 1
      ? `${unread.length ? "runs" : "can run only"} on online host ${hostId}`
      : `runs on ${capableHostIds.join(", ")}; selected ${hostId}${hostId === preferredHostId ? " by host preference" : ""}`;
  const absent = targetAbsent
    ? `is absent from the ready ${HOST_KIND_LABELS[targetKind]} catalog; it `
    : "";
  return `Profile ${profileName} ${absent}${placement}${unreadHostsNote(unread)}`;
}

/** The clause that keeps an unread host from reading as proof of incompatibility. */
export function unreadHostsNote(unreadHostIds: readonly string[]): string {
  return unreadHostIds.length
    ? `; not ruled out on ${unreadHostIds.join(", ")}, which ${unreadHostIds.length === 1 ? "is" : "are"} not ready`
    : "";
}

export function resolveWorkerHostForProfile(
  task: Pick<Task, "hostId" | "hostSelection">,
  hosts: readonly WorkerHostCatalog[],
  profileId: string,
  thinkingOptionId = "",
  preferredKinds: readonly (HostKind | null | undefined)[] = [],
  preferCurrentHost = true,
) {
  const capable = hosts.filter((host) =>
    host.profiles.some(
      (profile) =>
        profile.id === profileId &&
        profile.available &&
        (!thinkingOptionId ||
          profile.supportedThinking.includes(thinkingOptionId)),
    ),
  );
  if (!capable.length) return null;
  const explicit =
    task.hostSelection?.basis === "explicit"
      ? capable.find((candidate) => candidate.hostId === task.hostId)
      : undefined;
  const current =
    preferCurrentHost && task.hostId
      ? capable.find((candidate) => candidate.hostId === task.hostId)
      : undefined;
  const host =
    explicit ??
    current ??
    preferredKinds.flatMap((kind) =>
      kind
        ? capable.filter((candidate) => hostKindOf(candidate.hostId) === kind)
        : [],
    )[0] ??
    capable.find((candidate) => candidate.hostId === task.hostId) ??
    capable[0];
  if (!host) return null;
  const raw = host.profiles.find((candidate) => candidate.id === profileId)!;
  const profile: Profile = {
    ...raw,
    thinkingOptionId: thinkingOptionId || raw.thinkingOptionId,
  };
  const capableHostIds = capable.map((candidate) => candidate.hostId);
  return {
    hostId: host.hostId,
    profile,
    capableHostIds,
    hostSelection: {
      hostId: host.hostId,
      basis: "worker_profile" as const,
      reason: formatWorkerHostSelectionReason(
        profile.name,
        host.hostId,
        capableHostIds,
        task.hostId,
      ),
    },
  };
}

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
  const resolved = resolveWorkerHostForProfile(
    task,
    hosts,
    selected.profile.id,
    selected.profile.thinkingOptionId,
    preferredKinds,
    false,
  );
  if (!resolved) return null;
  return {
    ...selected,
    profile: {
      ...resolved.profile,
      thinkingOptionId: selected.profile.thinkingOptionId,
    },
    hostId: resolved.hostId,
    capableHostIds: resolved.capableHostIds,
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
