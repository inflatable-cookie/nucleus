import type { z } from "zod";
import type * as api from "../../shared/contracts";
import { isCanonicalProvider } from "../../shared/profile-vocabulary";
import {
  profileCompatibility,
  type NucleusProfile,
  type NucleusProfileInput,
  type NucleusProfileUpdate,
} from "../../shared/profiles";
import { t3codeVocabulary } from "../../hosts/t3code/vocabulary";
import {
  cachedInstances,
  catalogReadAt,
  profileInstanceCatalog,
  vocabularyCatalog,
} from "./rust-profile-catalog";
import {
  efforts,
  profilesSnapshot,
  providers,
  type RustApi,
  type RustNamedProfile,
  type RustProfileUsage,
} from "./rust-api";

type RustProfilesValue = z.infer<typeof profilesSnapshot>["value"];
type Handler = (input: never) => Promise<unknown>;

const ACTIVE_ROLES = ["worker", "reviewer"] as const;
type ActiveRole = (typeof ACTIVE_ROLES)[number];

/**
 * The subscription group the engine charges: the named group, else the T3
 * instance the launch runs on (a pinned one, or the provider's own).
 */
function subscriptionGroup(profile: RustNamedProfile) {
  const provider = profile.selection.provider;
  return (
    profile.group ??
    profile.providerInstanceId ??
    (isCanonicalProvider(provider)
      ? t3codeVocabulary.providers[provider]?.key
      : undefined) ??
    provider
  );
}

/** A Rust profile as the board's stored profile and its dispatch settings. */
export function boardProfile(profile: RustNamedProfile): {
  profile: NucleusProfile;
  pool: api.PoolEntry;
  view: api.Profile;
} {
  const { selection } = profile;
  // The coordinator role is retired (ruling 1); omitted roles allow both.
  const roles = (profile.roles ?? ACTIVE_ROLES).filter(
    (role): role is ActiveRole => role !== "coordinator",
  );
  const scopes = (profile.scopes ?? []).filter(
    (scope): scope is "general" | "mechanical" | "complex" =>
      scope === "general" || scope === "mechanical" || scope === "complex",
  );
  const stored: NucleusProfile = {
    id: selection.id,
    name: profile.name,
    provider: selection.provider,
    model: selection.model,
    ...(profile.modeId ? { modeId: profile.modeId } : {}),
    ...(selection.effort ? { thinkingOptionId: selection.effort } : {}),
    ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
    notes: profile.notes ?? "",
  };
  return {
    profile: stored,
    pool: {
      profileId: selection.id,
      enabled: profile.enabled ?? true,
      group: subscriptionGroup(profile),
      roles: roles.length ? roles : [...ACTIVE_ROLES],
      capability: selection.capability,
      weight: selection.weight,
      scopes: scopes.length ? scopes : ["general"],
    },
    view: {
      ...stored,
      // Settings rows judge availability from the cached catalogue themselves.
      available: true,
      problem: "",
      supportedThinking: selection.effort ? [selection.effort] : [],
    },
  };
}

function profileCounts(counts: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(counts).map(([id, count]) => [`profile:${id}`, count]),
  );
}

export function boardProfileUsage(usage: RustProfileUsage) {
  const role = ({ counts, sample }: RustProfileUsage["worker"]) => ({
    counts: profileCounts(counts),
    sample,
  });
  return {
    assignments: { ...usage.groupTotals, ...profileCounts(usage.totals) },
    recentAssignments: {
      ...usage.recent.groups,
      ...profileCounts(usage.recent.counts),
    },
    recentAssignmentSample: usage.recent.sample,
    recentAssignmentRoles: {
      worker: role(usage.worker),
      reviewer: role(usage.reviewer),
      coordinator: { counts: {}, sample: 0 },
    },
  };
}

function sameSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value) => b.includes(value));
}

export function createRustProfiles(rust: RustApi) {
  // Identity and pool controls can autosave independently. Order writes from
  // this board so the second edit reads the revision the first edit saved.
  let writes = Promise.resolve();

  function editProfiles(edit: (value: RustProfilesValue) => RustProfilesValue) {
    const next = writes.then(async () => {
      const current = await rust.domain(profilesSnapshot, "profiles");
      return rust.saveDomain(
        profilesSnapshot,
        "profiles",
        current.revision,
        edit(current.value),
      );
    });
    writes = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  const handlers: Record<string, Handler> = {
    "profile.vocabulary": async (input: { refresh?: boolean }) => {
      const cached = await rust.catalog();
      if (input.refresh && cached.status !== "current") {
        throw new Error(
          cached.status === "pending"
            ? "T3 has not published a catalog yet"
            : "T3's catalog is temporarily unavailable",
        );
      }
      return vocabularyCatalog(cached);
    },
    "profile.compatibility": async () => {
      const [cached, current] = await Promise.all([
        rust.catalog(),
        rust.domain(profilesSnapshot, "profiles"),
      ]);
      const instances = cachedInstances(cached);
      const label = t3codeVocabulary.label;
      return {
        hosts: [
          {
            hostId: "t3",
            kind: "t3code" as const,
            label,
            online: cached.status === "current",
            readAt: catalogReadAt(cached),
          },
        ],
        rows: current.value.profiles.map((entry) => {
          const { profile } = boardProfile(entry);
          if (cached.status !== "current")
            return {
              profileId: profile.id,
              hostId: "t3",
              status: "unknown" as const,
              reason: `${label}'s catalog is temporarily unavailable`,
              translated: [],
              launch: null,
            };
          const native = profileInstanceCatalog(
            instances,
            profile,
            entry.providerInstanceId,
          );
          const answer = profileCompatibility(
            profile,
            native,
            t3codeVocabulary,
          );
          return {
            profileId: profile.id,
            hostId: "t3",
            status: answer.status,
            reason: answer.reason,
            translated: answer.translated,
            launch: answer.launch,
          };
        }),
      };
    },
    "profile.list": async () => {
      const current = await rust.domain(profilesSnapshot, "profiles");
      return {
        profiles: current.value.profiles.map(
          (entry) => boardProfile(entry).profile,
        ),
      };
    },
    // A new profile starts off and worker-only, as the shared editor's default
    // dispatch entry shows it. Its subscription stays the engine's default (the
    // T3 instance) until the operator names one.
    "profile.create": async (input: NucleusProfileInput) => {
      const id = input.id ?? crypto.randomUUID();
      const saved = await editProfiles((value) => {
        if (value.profiles.some((entry) => entry.selection.id === id))
          throw new Error(`Profile ${id} already exists`);
        const profile: RustNamedProfile = {
          name: input.name,
          selection: {
            id,
            provider: providers.parse(input.provider),
            model: input.model ?? "",
            effort: efforts.nullish().parse(input.thinkingOptionId) ?? null,
            capability: "worker",
            weight: "default",
          },
          enabled: false,
          roles: ["worker"],
          ...(input.modeId ? { modeId: input.modeId } : {}),
          ...(input.featureValues && Object.keys(input.featureValues).length
            ? { featureValues: input.featureValues }
            : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        };
        return { ...value, profiles: [...value.profiles, profile] };
      });
      const entry = saved.value.profiles.find(
        (profile) => profile.selection.id === id,
      );
      if (!entry) throw new Error("The engine did not keep that profile.");
      return { profile: boardProfile(entry).profile };
    },
    // Every field the update leaves out stays as stored, imported options included.
    "profile.update": async (input: NucleusProfileUpdate) => {
      let found = false;
      const saved = await editProfiles((value) => ({
        ...value,
        profiles: value.profiles.map((entry) => {
          if (entry.selection.id !== input.id) return entry;
          found = true;
          const next: RustNamedProfile = {
            ...entry,
            name: input.name ?? entry.name,
            selection: {
              ...entry.selection,
              provider:
                providers.optional().parse(input.provider) ??
                entry.selection.provider,
              model: input.model ?? entry.selection.model,
              effort:
                input.thinkingOptionId === undefined
                  ? entry.selection.effort
                  : efforts.nullable().parse(input.thinkingOptionId),
            },
          };
          // A pinned T3 instance belongs to its provider.
          if (input.provider && input.provider !== entry.selection.provider)
            delete next.providerInstanceId;
          if (input.modeId !== undefined) {
            if (input.modeId === null) delete next.modeId;
            else next.modeId = input.modeId;
          }
          if (input.featureValues !== undefined) {
            if (
              input.featureValues === null ||
              !Object.keys(input.featureValues).length
            )
              delete next.featureValues;
            else next.featureValues = input.featureValues;
          }
          if (input.notes !== undefined) {
            if (input.notes) next.notes = input.notes;
            else delete next.notes;
          }
          return next;
        }),
      }));
      if (!found) throw new Error(`Profile ${input.id} is not stored.`);
      const entry = saved.value.profiles.find(
        (profile) => profile.selection.id === input.id,
      );
      if (!entry) throw new Error("The engine did not keep that profile.");
      return { profile: boardProfile(entry).profile };
    },
    "profile.remove": async (input: { id: string }) => {
      let removed = false;
      await editProfiles((value) => ({
        ...value,
        profiles: value.profiles.filter((entry) => {
          const keep = entry.selection.id !== input.id;
          removed ||= !keep;
          return keep;
        }),
      }));
      return { removed };
    },
    // The board shows defaults for unset fields (both roles, general scope, the
    // provider as subscription). A value equal to that display leaves the stored
    // field as it was, so an unrelated edit never pins a default or drops an
    // imported value; a changed value is written.
    "queue.profile": async (input: api.PoolEntry) => {
      const saved = await editProfiles((value) => ({
        ...value,
        profiles: value.profiles.map((entry) => {
          if (entry.selection.id !== input.profileId) return entry;
          const shown = boardProfile(entry).pool;
          const roles = input.roles.filter(
            (role): role is ActiveRole => role !== "coordinator",
          );
          const next: RustNamedProfile = {
            ...entry,
            enabled: input.enabled,
            selection: {
              ...entry.selection,
              capability: input.capability ?? entry.selection.capability,
              weight: input.weight,
            },
          };
          if (input.group !== shown.group) next.group = input.group;
          if (roles.length && !sameSet(roles, shown.roles)) next.roles = roles;
          if (!sameSet(input.scopes, shown.scopes)) next.scopes = input.scopes;
          return next;
        }),
      }));
      const entry = saved.value.profiles.find(
        (profile) => profile.selection.id === input.profileId,
      );
      return { ok: true, entry: entry ? boardProfile(entry).pool : undefined };
    },
    "queue.availability": async (
      input:
        | { group: string; unavailable?: boolean }
        | { action: "remove"; group: string },
    ) => {
      const pause = !("action" in input) && input.unavailable !== false;
      await editProfiles((value) => {
        const groups = new Set(value.pausedGroups ?? []);
        if (pause) groups.add(input.group);
        else groups.delete(input.group);
        return { ...value, pausedGroups: [...groups].sort() };
      });
      return { ok: true };
    },
  };

  return { handlers };
}
