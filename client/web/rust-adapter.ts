import type { z } from "zod";
import * as api from "../../shared/contracts";
import { DEFAULT_HOST_KIND } from "../../shared/host-kind";
import type { NucleusProfile } from "../../shared/profiles";
import type { RpcContract } from "../../shared/rpc";
import { capacityBounds } from "../../shared/schema/settings/capacity";
import {
  createRustApi,
  dispatchSnapshot,
  hostsView,
  profilesSnapshot,
  projectsView,
  storageView,
  type RustAllSettings,
  type RustApi,
  type RustDispatch,
  type RustDispatchMode,
  type RustNamedProfile,
  type RustProject,
  type RustProjects,
  type RustRepository,
} from "./rust-api";
import { createRustPlanning } from "./rust-planning";
import { generatedProjectBadge } from "../../shared/t3/project-badge";

/**
 * The board's data adapter for the Rust engine (Spec 070, ruling 4). It sits
 * behind the same `rpc(contract, input)` interface as the TypeScript service's
 * web transport, so every existing screen reads the Rust paired API without a
 * parallel UI. Each handler reads only the engine's local store through the
 * paired API (ruling 11), maps its answer onto the board contract and lets the
 * transport parse it. A field the engine has no value for is left at the
 * contract's empty value; the control that would show it is hidden by
 * `RUST_ENGINE_FEATURES` instead.
 */

type Handler = (input: never) => Promise<unknown>;

export class RustUnsupported extends Error {
  constructor(method: string) {
    super(`${method} is not part of the Rust engine.`);
  }
}

const iso = (ms: number | null | undefined) =>
  ms == null ? null : new Date(ms).toISOString();

/** Waits that mean a run is live on the host. */
const EXECUTING = new Set([
  "starting",
  "running",
  "permission",
  "input",
  "idle_without_terminal_run",
  "retained_thread_busy",
]);

const PROJECT_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Rust project IDs allow capitals, dots and underscores; the board's project
 * key does not. Keys that already fit pass through. Others get a stable,
 * readable key, and the adapter maps it back for every write.
 */
export function projectKeys(ids: readonly string[]) {
  const toKey = new Map<string, string>();
  const toId = new Map<string, string>();
  for (const id of ids) {
    let key = PROJECT_KEY.test(id)
      ? id
      : `p-${
          id
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "project"
        }`;
    for (let n = 2; toId.has(key); n++) key = `${key.replace(/-\d+$/, "")}-${n}`;
    toKey.set(id, key);
    toId.set(key, id);
  }
  return {
    key: (id: string) => toKey.get(id) ?? id,
    id: (key: string) => toId.get(key) ?? key,
  };
}

/** One Rust project as the board's project record. */
export function boardProject(
  key: string,
  project: RustProject,
): api.Project | null {
  const repositories = project.repositories.map((repo) => ({
    origin: repo.origin,
    path: repo.path,
  }));
  const primary = repositories[0];
  if (!primary) return null;
  return {
    key,
    name: project.name,
    version: 1,
    repositories,
    primary,
    drain: null,
  };
}

/** The repository settings record the shared editor reads, from the Rust fields. */
export function boardRepositorySettings(
  repo: RustRepository,
): api.RepositorySettings {
  return {
    repository: { origin: repo.origin, path: repo.path },
    scratchNamespace: null,
    closeout: null,
    validation: null,
    reviewer: null,
    qa: null,
    affectedTests: null,
    checksPolicy: null,
    hostKind: null,
    workspaceProvider: null,
    toolQuietLimitMinutes: repo.hungToolMinutes,
    note: "",
    updatedAt: "",
    revision: 0,
    requiredChecks: repo.requiredChecks,
    base: repo.base,
  };
}

/** A Rust profile as the board's stored profile and its dispatch settings. */
export function boardProfile(profile: RustNamedProfile): {
  profile: NucleusProfile;
  pool: api.PoolEntry;
  view: api.Profile;
} {
  const { selection } = profile;
  const group = profile.group ?? selection.provider;
  // Omitted roles allow both active roles; the coordinator role is retired (ruling 1).
  const roles = (profile.roles ?? ["worker", "reviewer"]).filter(
    (role): role is "worker" | "reviewer" => role !== "coordinator",
  );
  const scopes = (profile.scopes ?? []).filter(
    (scope): scope is "general" | "mechanical" | "complex" =>
      scope === "general" || scope === "mechanical" || scope === "complex",
  );
  return {
    profile: {
      id: selection.id,
      name: profile.name,
      provider: selection.provider,
      model: selection.model,
      ...(profile.modeId ? { modeId: profile.modeId } : {}),
      ...(selection.effort ? { thinkingOptionId: selection.effort } : {}),
      ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
      notes: profile.notes ?? "",
    },
    pool: {
      profileId: selection.id,
      enabled: profile.enabled ?? true,
      group,
      roles: roles.length ? roles : ["worker", "reviewer"],
      capability: selection.capability,
      weight: selection.weight,
      scopes: scopes.length ? scopes : ["general"],
    },
    view: {
      id: selection.id,
      name: profile.name,
      provider: selection.provider,
      model: selection.model,
      ...(profile.modeId ? { modeId: profile.modeId } : {}),
      ...(selection.effort ? { thinkingOptionId: selection.effort } : {}),
      ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
      notes: profile.notes ?? "",
      // The engine checks each launch against the scheduler's catalogue read;
      // Settings never reads the host (ruling 11).
      available: true,
      problem: "",
      supportedThinking: selection.effort ? [selection.effort] : [],
    },
  };
}

function usageView(dispatch: RustDispatch, now = Date.now()) {
  const expired =
    dispatch.usageUntilMs !== null && dispatch.usageUntilMs <= now;
  return {
    level: expired ? ("normal" as const) : dispatch.usage,
    setLevel: dispatch.usage,
    until: iso(dispatch.usageUntilMs),
    expired,
  };
}

const modeFlags = (mode: RustDispatchMode) => ({
  paused: mode === "paused" || mode === "stopped",
  dispatchHeld: mode === "held",
});

/** The values the shared Limits section edits, from the Dispatch domain. */
function capacityValues(
  dispatch: RustDispatch,
): api.CapacityAuthorityValues {
  const fallback = Object.fromEntries(
    Object.entries(capacityBounds).map(([field, bound]) => [
      field,
      bound.fallback,
    ]),
  ) as Record<keyof typeof capacityBounds, number>;
  return {
    ...fallback,
    globalLimit: Math.max(1, Math.min(64, dispatch.slots)),
    projectLimit: Math.max(1, Math.min(32, dispatch.slots)),
    hostCallLimit: Math.max(1, dispatch.hostConcurrency),
    operatorDefaultHostKind: DEFAULT_HOST_KIND,
  };
}

export function createRustAdapter(rust: RustApi = createRustApi()) {
  let revision = 0;
  let keys = projectKeys([]);
  const planning = createRustPlanning(rust, () => keys);

  async function settings(): Promise<RustAllSettings> {
    const all = await rust.settings();
    keys = projectKeys(Object.keys(all.projects.settings.value.projects));
    return all;
  }

  async function editDispatch(edit: (value: RustDispatch) => RustDispatch) {
    const current = await rust.domain(dispatchSnapshot, "dispatch");
    return rust.saveDomain(
      dispatchSnapshot,
      "dispatch",
      current.revision,
      edit(current.value),
    );
  }

  async function editProfiles(
    edit: (
      value: z.infer<typeof profilesSnapshot>["value"],
    ) => z.infer<typeof profilesSnapshot>["value"],
  ) {
    const current = await rust.domain(profilesSnapshot, "profiles");
    return rust.saveDomain(
      profilesSnapshot,
      "profiles",
      current.revision,
      edit(current.value),
    );
  }

  async function editProjects(edit: (value: RustProjects) => RustProjects) {
    const current = await rust.domain(projectsView, "projects");
    keys = projectKeys(Object.keys(current.settings.value.projects));
    const saved = await rust.saveDomain(
      projectsView,
      "projects",
      current.settings.revision,
      edit(current.settings.value),
    );
    keys = projectKeys(Object.keys(saved.settings.value.projects));
    return saved;
  }

  function projectRows(all: RustAllSettings) {
    return Object.entries(all.projects.settings.value.projects).flatMap(
      ([id, project]) => {
        const board = boardProject(keys.key(id), project);
        return board ? [{ id, project, board }] : [];
      },
    );
  }

  async function snapshot(): Promise<api.UiBoard> {
    const [all, tasks] = await Promise.all([
      settings(),
      rust.board.list(AbortSignal.timeout(30_000)),
    ]);
    const dispatch = all.dispatch.value;
    const backups = await rust.domain(storageView, "storage").catch(() => null);
    const newest = backups?.backups?.verified
      .map((backup) => backup.createdAt)
      .sort()
      .at(-1);
    const profiles = all.profiles.value.profiles.map(boardProfile);
    const rows = projectRows(all);
    revision += 1;
    return {
      revision,
      prStates: {},
      connected: all.hosts.active.status !== "unavailable",
      hostId: "t3",
      ...modeFlags(dispatch.mode),
      drained: false,
      boundRuns: [],
      error: "",
      quiet: false,
      activeWorkers: tasks.filter((task) => task.wait === "running").length,
      unsettled: 0,
      stoppedThreads: 0,
      resumedThreads: 0,
      ...capacityValues(dispatch),
      globalLimit: dispatch.slots,
      projectLimit: dispatch.slots,
      usage: usageView(dispatch),
      // Every Rust project carries its own slot limit (ruling 8).
      projectLimitOverrides: Object.fromEntries(
        rows
          .filter(({ project }) => !project.archived)
          .map(({ board, project }) => [board.key, Math.min(64, project.slots)]),
      ),
      projectCapacities: [],
      operationLimit: 64,
      operationBacklog: 0,
      operations: [],
      backup: {
        newestSnapshotAt: newest ?? null,
        localError:
          backups?.backups && backups.backups.issues > 0
            ? "Some backups could not be verified."
            : null,
      },
      tasks: [],
      profiles: profiles.map((entry) => entry.view),
      pool: profiles.map((entry) => entry.pool),
      availability: (all.profiles.value.pausedGroups ?? []).map((group) => ({
        group,
        unavailable: true,
        reason: "Paused in Settings",
        retryAt: null,
      })),
      assignments: {},
      recentAssignments: {},
      recentAssignmentSample: 0,
      recentAssignmentRoles: {
        worker: { counts: {}, sample: 0 },
        reviewer: { counts: {}, sample: 0 },
        coordinator: { counts: {}, sample: 0 },
      },
      queuedCounts: [],
      lanes: await planning.laneViews(rows),
      projects: rows
        .filter(({ project }) => !project.archived)
        .map(({ board }) => board),
      // A task with a live run is executing work as of this read. The engine's
      // summaries carry no history times yet, so idle tasks add no activity.
      projectActivity: rows.map(({ board, project }) => {
        const origins = new Set(project.repositories.map((repo) => repo.origin.toLowerCase()));
        const at = new Date().toISOString();
        const items = tasks
          .filter(
            (task) =>
              origins.has(task.identity.repository.toLowerCase()) &&
              task.wait !== null &&
              EXECUTING.has(task.wait),
          )
          .map((task) => ({ id: task.identity.id, at, executing: true }));
        return { key: board.key, items, lastAt: items.length ? at : null };
      }),
      pendingSubmissions: [],
      projectBadges: undefined,
      // The saved T3 project title gives each repository the shared generated badge.
      repositoryBadges: Object.fromEntries(
        rows.flatMap(({ project }) =>
          project.repositories.flatMap((repo) =>
            repo.hostProjectTitle
              ? [[repo.path, generatedProjectBadge(repo.hostProjectTitle)]]
              : [],
          ),
        ),
      ),
    } as api.UiBoard;
  }

  async function projectSettings(input: { project?: string }) {
    const all = await settings();
    const rows = projectRows(all).filter(
      ({ board }) => !input.project || board.key === input.project,
    );
    return {
      defaultSlots: all.dispatch.value.slots,
      projects: rows.map(({ id, project, board }) => {
        const planner = all.projects.resolvedPlanners[id] ?? null;
        return {
          project: {
            ...board,
            ...(planner
              ? {
                  planner: {
                    agentId: planner,
                    setBy: "Nucleus",
                    setAt: "",
                  },
                }
              : {}),
          },
          repositories: project.repositories.map((repo, index) => ({
            repository: { origin: repo.origin, path: repo.path },
            primary: index === 0,
            settings: boardRepositorySettings(repo),
          })),
          slots: { value: project.slots, override: project.slots },
          plannerLive: planner ? true : null,
          plannerTicket: null,
          problems: [],
          archived: project.archived,
        };
      }),
    };
  }

  const handlers: Record<string, Handler> = {
    "queue.ui-snapshot": snapshot,
    "queue.capacity-state": async () => {
      const dispatch = await rust.domain(dispatchSnapshot, "dispatch");
      return { effective: capacityValues(dispatch.value), changes: [] };
    },
    "queue.capacity": async (input: api.CapacityAuthorityValues) => {
      await editDispatch((value) => ({ ...value, slots: input.globalLimit }));
      return { ok: true };
    },
    "queue.usage": async (input: {
      level: RustDispatch["usage"];
      until?: string | null;
    }) => {
      const saved = await editDispatch((value) => ({
        ...value,
        usage: input.level,
        usageUntilMs: input.until ? Date.parse(input.until) : null,
      }));
      return usageView(saved.value);
    },
    "queue.control": async (input: {
      paused?: boolean;
      dispatchHeld?: boolean;
    }) => {
      await editDispatch((value) => {
        let mode = value.mode;
        if (input.paused !== undefined)
          mode = input.paused
            ? mode === "stopped"
              ? "stopped"
              : "paused"
            : "running";
        if (input.dispatchHeld !== undefined && mode !== "paused" && mode !== "stopped")
          mode = input.dispatchHeld ? "held" : "running";
        return { ...value, mode };
      });
      return { ok: true };
    },
    "queue.stop-threads": async () => {
      // The scheduler stops each live run through its normal stop custody.
      await editDispatch((value) => ({ ...value, mode: "stopped" }));
      return { ok: true, stopped: [] };
    },
    "queue.project-dispatch-limit": async (input: {
      projectKey: string;
      limit: number | null;
    }) => {
      const id = keys.id(input.projectKey);
      await editProjects((value) => {
        const project = value.projects[id];
        if (!project) throw new Error(`Project ${input.projectKey} is not registered.`);
        if (input.limit === null || input.limit < 1)
          throw new Error("A project needs a positive slot limit.");
        return {
          projects: {
            ...value.projects,
            [id]: { ...project, slots: input.limit },
          },
        };
      });
      return { ok: true };
    },
    "profile.list": async () => {
      const current = await rust.domain(profilesSnapshot, "profiles");
      return {
        profiles: current.value.profiles.map((entry) => boardProfile(entry).profile),
      };
    },
    "profile.update": async (input: {
      id: string;
      name?: string;
      model?: string;
      thinkingOptionId?: string | null;
    }) => {
      const saved = await editProfiles((value) => ({
        ...value,
        profiles: value.profiles.map((entry) =>
          entry.selection.id === input.id
            ? {
                ...entry,
                name: input.name ?? entry.name,
                selection: {
                  ...entry.selection,
                  model: input.model ?? entry.selection.model,
                  effort:
                    input.thinkingOptionId === undefined
                      ? entry.selection.effort
                      : ((input.thinkingOptionId as RustNamedProfile["selection"]["effort"]) ??
                        null),
                },
              }
            : entry,
        ),
      }));
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
    "queue.profile": async (input: api.PoolEntry) => {
      const saved = await editProfiles((value) => ({
        ...value,
        profiles: value.profiles.map((entry) =>
          entry.selection.id === input.profileId
            ? {
                ...entry,
                group: input.group,
                enabled: input.enabled,
                selection: {
                  ...entry.selection,
                  capability: input.capability ?? entry.selection.capability,
                  weight: input.weight,
                },
              }
            : entry,
        ),
      }));
      const entry = saved.value.profiles.find(
        (profile) => profile.selection.id === input.profileId,
      );
      return { ok: true, entry: entry ? boardProfile(entry).pool : undefined };
    },
    "queue.availability": async (
      input: { group: string; unavailable?: boolean } | { action: "remove"; group: string },
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
    repositories: async () => {
      const all = await settings();
      return Object.values(all.projects.settings.value.projects).flatMap(
        (project) => project.repositories.map(boardRepositorySettings),
      );
    },
    "project.settings": projectSettings,
    "project.upsert": async (input: {
      key: string;
      name: string;
      repositories: Array<{ origin: string | null; path?: string }>;
      create?: boolean;
    }) => {
      const id = keys.id(input.key);
      const saved = await editProjects((value) => {
        const existing = value.projects[id];
        if (!existing)
          throw new Error(
            "Projects register when a planner first dispatches (Spec 070 ruling 23).",
          );
        return {
          projects: {
            ...value.projects,
            [id]: { ...existing, name: input.name },
          },
        };
      });
      const project = saved.settings.value.projects[id];
      const board = project && boardProject(keys.key(id), project);
      if (!board) throw new Error("The engine did not keep that project.");
      return board;
    },
    "rust.dispatch.allowance": async () => {
      const dispatch = await rust.domain(dispatchSnapshot, "dispatch");
      return { minutes: dispatch.value.allowanceMinutes };
    },
    "rust.dispatch.allowance.set": async (input: { minutes: number | null }) => {
      const saved = await editDispatch((value) => ({
        ...value,
        allowanceMinutes: input.minutes,
      }));
      return { minutes: saved.value.allowanceMinutes };
    },
    "rust.project.archive": async (input: { project: string; archived: boolean }) => {
      const id = keys.id(input.project);
      await editProjects((value) => {
        const project = value.projects[id];
        if (!project) throw new Error(`Project ${input.project} is not registered.`);
        return {
          projects: {
            ...value.projects,
            [id]: { ...project, archived: input.archived },
          },
        };
      });
      return { ok: true };
    },
    "repository.set": async (input: {
      repository: string;
      toolQuietLimitMinutes?: number | null;
      requiredChecks?: string[];
      base?: string;
    }) => {
      let updated: RustRepository | undefined;
      await editProjects((value) => ({
        projects: Object.fromEntries(
          Object.entries(value.projects).map(([id, project]) => [
            id,
            {
              ...project,
              repositories: project.repositories.map((repo) => {
                if (repo.origin !== input.repository && repo.path !== input.repository)
                  return repo;
                updated = {
                  ...repo,
                  ...(input.toolQuietLimitMinutes
                    ? { hungToolMinutes: input.toolQuietLimitMinutes }
                    : {}),
                  ...(input.requiredChecks ? { requiredChecks: input.requiredChecks } : {}),
                  ...(input.base ? { base: input.base } : {}),
                };
                return updated;
              }),
            },
          ]),
        ),
      }));
      if (!updated) throw new Error(`${input.repository} is not registered.`);
      return boardRepositorySettings(updated);
    },
    "project.reassign": async (input: { origin: string; project: string }) => {
      const current = await rust.domain(projectsView, "projects");
      keys = projectKeys(Object.keys(current.settings.value.projects));
      await rust.reassign(current.settings.revision, input.origin, keys.id(input.project));
      return { ok: true };
    },
    "host.list": async () => {
      const hosts = await rust.domain(hostsView, "hosts");
      const t3 = hosts.settings.value.t3;
      const state = {
        reachable: "online",
        unavailable: "offline",
        unknown: "unknown",
      } as const;
      return {
        hosts: [
          {
            id: "t3",
            kind: "t3code",
            label: "T3 Code",
            endpoint: t3?.endpoint ?? hosts.active.endpoint,
            state: state[hosts.active.status],
            reason: "",
            isDefault: true,
            versions: [],
            dependents: [],
            removalBlockers: ["T3 is the engine's only host (Spec 070 ruling 5)."],
          },
        ],
        defaultHostKind: "t3code",
        removals: [],
      };
    },
    "queue.work-storage": async () => storageState(),
    "queue.work-storage.set": async (input: {
      workRoot?: string | null;
      scratchRoot?: string | null;
      logRoot?: string | null;
      buildsRoot?: string | null;
    }) => {
      const current = await rust.domain(storageView, "storage");
      await rust.saveDomain(storageView, "storage", current.settings.revision, {
        ...current.settings.value,
        ...(input.workRoot !== undefined ? { workRoot: input.workRoot } : {}),
        ...(input.scratchRoot !== undefined ? { scratchRoot: input.scratchRoot } : {}),
        ...(input.logRoot !== undefined ? { logRoot: input.logRoot } : {}),
        ...(input.buildsRoot !== undefined ? { buildsRoot: input.buildsRoot } : {}),
      });
      return storageState();
    },
    ...planning.handlers,
  };

  async function storageState() {
    const storage = await rust.domain(storageView, "storage");
    const { active, settings: stored } = storage;
    return {
      workRoot: active.workRoot,
      workVolumeId: stored.value.workVolume?.volumeId ?? null,
      worktreesRoot: active.bargePaths?.worktrees ?? active.workRoot,
      ...(active.buildsRoot ? { buildsRoot: active.buildsRoot } : {}),
      ...(active.placement ? { placement: active.placement } : {}),
      ...(active.home ? { home: active.home } : {}),
      backupRoot: active.backupRoot,
      scratchRoot: active.scratchRoot,
      logRoot: active.logRoot,
      databaseRoot: active.databaseRoot,
      defaults: null,
      overrides: {
        workRoot: stored.value.workRoot,
        scratchRoot: stored.value.scratchRoot,
        logRoot: stored.value.logRoot,
        ...(stored.value.buildsRoot !== undefined
          ? { buildsRoot: stored.value.buildsRoot }
          : {}),
      },
      retired: null,
      retainedRoots: [],
      appliesOnRestart: true,
      retention: stored.value.retention,
      backups: {
        verified: storage.backups?.verified.length ?? 0,
        newestAt:
          storage.backups?.verified
            .map((backup) => backup.createdAt)
            .sort()
            .at(-1) ?? null,
        issues: storage.backups?.issues ?? 0,
      },
    };
  }

  return {
    async rpc<Input extends z.ZodType, Output extends z.ZodType>(
      contract: RpcContract<Input, Output>,
      input: z.input<Input>,
    ): Promise<z.output<Output>> {
      const handler = handlers[contract.name];
      if (!handler) throw new RustUnsupported(contract.name);
      const parsed = contract.input.parse(input);
      return contract.output.parse(await handler(parsed as never));
    },
    rust,
  };
}

export type RustAdapter = ReturnType<typeof createRustAdapter>;
