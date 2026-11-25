import { z } from "zod";
import * as api from "../../shared/contracts";
import { DEFAULT_HOST_KIND } from "../../shared/host-kind";
import type { RpcContract } from "../../shared/rpc";
import { capacityBounds } from "../../shared/schema/settings/capacity";
import {
  createRustApi,
  dispatchSnapshot,
  hostsView,
  namedProfile,
  project as rustProject,
  projectsView,
  storageView,
  type RustAllSettings,
  type RustBrowserSession,
  type RustApi,
  type RustDispatch,
  type RustDispatchMode,
  type RustProject,
  type RustProjects,
  type RustRepository,
} from "./rust-api";
import {
  boardProfile,
  boardProfileUsage,
  boardSubscriptionAvailability,
  createRustProfiles,
} from "./rust-profiles";
import { createRustPlanning } from "./rust-planning";
import { errorText } from "../error-text";
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

const PROJECT_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// Reserve the prefix even for literal IDs that already look like encoded keys.
const ENCODED_PROJECT = "rust-id-";
export function projectKey(id: string) {
  if (PROJECT_KEY.test(id) && !id.startsWith(ENCODED_PROJECT)) return id;
  return ENCODED_PROJECT + Array.from(id, char => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

export function projectId(key: string) {
  if (!PROJECT_KEY.test(key)) throw new Error("Invalid project key.");
  if (!key.startsWith(ENCODED_PROJECT)) return key;
  const hex = key.slice(ENCODED_PROJECT.length);
  if (!/^(?:[0-9a-f]{2}){1,240}$/.test(hex)) throw new Error("Invalid encoded project key.");
  const id = String.fromCharCode(...(hex.match(/../g) ?? []).map(pair => parseInt(pair, 16)));
  if (!/^(?!\.{1,2}$)[a-zA-Z0-9._-]+$/.test(id) || projectKey(id) !== key) throw new Error("Invalid encoded project key.");
  return id;
}

/** A persisted legacy slug identifies a project only when it has one possible owner.
 * The previous allocator also numbered collisions, so reserve those suffixes. */
function legacyScopeOwners(ids: string[]) {
  const owners = new Map<string, string>();
  const ambiguousStems = new Set<string>();
  for (const id of ids) {
    const slug = PROJECT_KEY.test(id) ? id :
      "p-" + (id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project");
    if (owners.has(slug)) ambiguousStems.add(slug.replace(/-\d+$/, ""));
    owners.set(slug, id);
  }
  const unambiguous = new Map<string, string>();
  for (const [slug, id] of owners) {
    if (!ambiguousStems.has(slug.replace(/-\d+$/, ""))) unambiguous.set(id, slug);
  }
  return unambiguous;
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
    globalLimit: dispatch.globalSlots,
    projectLimit: dispatch.projectDefaultSlots,
    hostCallLimit: 1,
    operatorDefaultHostKind: DEFAULT_HOST_KIND,
  };
}

export function createRustAdapter(rust: RustApi = createRustApi()) {
  let revision = 0;
  const keys = { key: projectKey, id: projectId };
  let currentSession: RustBrowserSession | undefined;
  let sessionRead: Promise<RustBrowserSession> | undefined;
  const planning = createRustPlanning(rust, settings, () => keys, session);

  function loadSession() {
    sessionRead ??= rust.session()
      .then((next) => {
        if (
          currentSession?.id === next.id &&
          currentSession.canEditSettings === next.canEditSettings &&
          JSON.stringify(currentSession.planningProjects) === JSON.stringify(next.planningProjects)
        ) return currentSession;
        currentSession = next;
        return next;
      })
      .finally(() => { sessionRead = undefined; });
    return sessionRead;
  }

  function session() {
    return sessionRead ?? (currentSession ? Promise.resolve(currentSession) : loadSession());
  }

  async function refreshSession() {
    const previous = currentSession;
    const next = await loadSession();
    return previous !== undefined && previous !== next;
  }
  const profilesAdapter = createRustProfiles(rust);

  async function readSettings() {
    const all = await rust.settings();
    const registry = all.projects.settings;
    const removed = z.record(z.string(), z.unknown()).optional().parse(registry.value.removed);
    const legacyScopes = legacyScopeOwners([...new Set([
      ...Object.keys(registry.value.projects), ...Object.keys(removed ?? {}),
    ])]);
    const projectIssues = new Map<string, string>();
    const projects = Object.fromEntries(Object.entries(registry.value.projects).flatMap(([id, raw]) => {
      try {
        const project = rustProject.parse(raw);
        const board = boardProject(keys.key(id), project);
        if (board) api.projectSchema.parse(board);
        return [[id, project] as const];
      } catch (error) {
        projectIssues.set(id, `Project ${id}: ${errorText(error)}`);
        return [];
      }
    }));
    const profileIssues: string[] = [];
    const profiles = all.profiles.value.profiles.flatMap((raw, index) => {
      try {
        const profile = namedProfile.parse(raw);
        const { view, pool } = boardProfile(profile, all.profiles.effectiveGroups);
        api.profileSchema.parse(view);
        api.poolSchema.parse(pool);
        return [profile];
      } catch (error) {
        const label = z.object({ name: z.string().min(1) }).safeParse(raw).data?.name;
        profileIssues.push(`Profile ${label ?? `#${index + 1}`}: ${errorText(error)}`);
        return [];
      }
    });
    return {
      ...all, projectIssues, profileIssues, legacyScopes,
      projects: { ...all.projects, settings: { ...registry, value: { ...registry.value, projects } } },
      profiles: { ...all.profiles, value: { ...all.profiles.value, profiles } },
    };
  }

  let settingsRead: ReturnType<typeof readSettings> | undefined;
  function settings() {
    settingsRead ??= readSettings().finally(() => { settingsRead = undefined; });
    return settingsRead;
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

  async function editProjects(edit: (value: RustProjects) => RustProjects) {
    const current = await rust.domain(projectsView, "projects");
    return rust.saveDomain(
      projectsView,
      "projects",
      current.settings.revision,
      edit(current.settings.value),
    );
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
    const [all, caller] = await Promise.all([settings(), session()]);
    const dispatch = all.dispatch.value;
    const effectiveProfileGroups = all.profiles.effectiveGroups;
    const profiles = all.profiles.value.profiles.map((entry) =>
      boardProfile(entry, effectiveProfileGroups),
    );
    const rows = projectRows(all).filter(({ id }) =>
      caller.planningProjects === null || caller.planningProjects.includes(id),
    );
    revision += 1;
    return {
      revision,
      prStates: {},
      canEditSettings: caller.canEditSettings,
      connected: all.hosts.active.status !== "unavailable",
      hostId: "t3",
      ...modeFlags(dispatch.mode),
      drained: false,
      boundRuns: [],
      error: [
        ...all.profileIssues,
        ...Array.from(all.projectIssues).flatMap(([id, issue]) =>
          caller.planningProjects === null || caller.planningProjects.includes(id) ? [issue] : []),
      ].join("\n"),
      quiet: false,
      activeWorkers: 0,
      unsettled: 0,
      stoppedThreads: 0,
      resumedThreads: 0,
      ...capacityValues(dispatch),
      usage: usageView(dispatch),
      projectLimitOverrides: Object.fromEntries(
        rows.flatMap(({ id, board, project }) => {
          if (project.archived || !Object.hasOwn(dispatch.projectSlotOverrides, id)) return [];
          return [[board.key, dispatch.projectSlotOverrides[id]]];
        }),
      ),
      projectCapacities: [],
      operationLimit: 64,
      operationBacklog: 0,
      operations: [],
      backup: { newestSnapshotAt: null, localError: null },
      tasks: [],
      profiles: profiles.map((entry) => entry.view),
      pool: profiles.map((entry) => entry.pool),
      effectiveProfileGroups,
      availability: boardSubscriptionAvailability(
        all.profiles.value.pausedGroups ?? [],
        {},
      ),
      assignments: {},
      recentAssignments: {},
      recentAssignmentSample: 0,
      recentAssignmentRoles: {
        worker: { counts: {}, sample: 0 },
        reviewer: { counts: {}, sample: 0 },
        coordinator: { counts: {}, sample: 0 },
      },
      projectActivity: [],
      queuedCounts: [],
      lanes: [],
      projects: rows
        .filter(({ project }) => !project.archived)
        .map(({ board, id }) => ({ ...board, legacyScopeKey: all.legacyScopes.get(id) ?? null })),
      pendingSubmissions: [],
      projectBadges: undefined,
      // A saved T3 title refines the generated Nucleus project badge once bound.
      repositoryBadges: Object.fromEntries(
        rows.flatMap(({ project, board }) => {
          const fallback = generatedProjectBadge(board.name.trim() || board.key);
          return project.repositories.map((repo) => [
            repo.path,
            repo.hostProjectTitle?.trim() ? generatedProjectBadge(repo.hostProjectTitle) : fallback,
          ]);
        }),
      ),
    } as api.UiBoard;
  }

  const plannerRevisions = new Map<string, string>();
  async function projectSettings(input: { project?: string }) {
    const all = await settings();
    const rows = projectRows(all).filter(
      ({ board }) => !input.project || board.key === input.project,
    );
    return {
      defaultSlots: all.dispatch.value.projectDefaultSlots,
      projects: rows.map(({ id, project, board }) => {
        plannerRevisions.set(id, all.projects.settings.revision);
        const planner = project.plannerClaim?.thread;
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
          slots: {
            value: all.dispatch.value.projectDefaultSlots,
            override: null,
          },
          plannerLive: planner ? all.projects.verifiedPlanners?.[id]?.includes(planner) ?? null : null,
          plannerTicket: null,
          problems: [],
          archived: project.archived,
        };
      }),
    };
  }

  const handlers: Record<string, Handler> = {
    "queue.ui-snapshot": snapshot,
    "rust.profile-usage": async () => {
      const usage = await rust.profileUsage();
      return {
        ...boardProfileUsage(usage),
        availability: boardSubscriptionAvailability([], usage.limitedGroups ?? {}),
      };
    },
    "queue.capacity-state": async () => {
      const dispatch = await rust.domain(dispatchSnapshot, "dispatch");
      return { revision: dispatch.revision, effective: capacityValues(dispatch.value), changes: [] };
    },
    "queue.capacity": async (input: api.CapacityInput) => {
      if (!("revision" in input)) throw new Error("Refresh Limits before saving.");
      const current = await rust.domain(dispatchSnapshot, "dispatch");
      if (current.revision !== input.revision)
        throw new Error("Dispatch limits changed. Review the current values and edit again.");
      await rust.saveDomain(dispatchSnapshot, "dispatch", input.revision, {
        ...current.value,
        globalSlots: input.globalLimit ?? current.value.globalSlots,
        projectDefaultSlots: input.projectLimit ?? current.value.projectDefaultSlots,
      });
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
      const all = await settings();
      const id = keys.id(input.projectKey);
      if (!Object.hasOwn(all.projects.settings.value.projects, id))
        throw new Error(`Project ${input.projectKey} is not registered.`);
      await editDispatch((value) => {
        const projectSlotOverrides = input.limit === null
          ? { ...value.projectSlotOverrides }
          : { ...value.projectSlotOverrides, [id]: input.limit };
        if (input.limit === null) delete projectSlotOverrides[id];
        return { ...value, projectSlotOverrides };
      });
      return { ok: true };
    },
    ...profilesAdapter.handlers,
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
        const known = new Set(existing.repositories.map((repo) => repo.origin));
        if (
          input.repositories.length !== known.size ||
          input.repositories.some((repo) => !repo.origin || !known.has(repo.origin))
        )
          throw new Error(
            "Repositories register on a planner's first dispatch. Move one here from another project instead.",
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
    "project.management-preview": async (input: { key: string; target?: string }) => {
      if (input.target) throw new RustUnsupported("Project reassignment preview");
      const id = keys.id(input.key);
      const { project, digest, tasks } = await rust.previewProjectRemoval(id);
      const current = boardProject(input.key, project);
      if (!current) throw new Error("The project has no repository for this board.");
      return {
        project: current, target: null, digest, cancellation: null,
        tasks: tasks.map(({ taskId, version }) => ({ taskId, version })),
        items: tasks.map(({ taskId, label }) => ({ kind: "task", id: taskId, label, shared: false })),
      } satisfies api.ProjectManagementPreview;
    },
    "project.manage-remove": async (input: api.ProjectManageInput) => {
      if (input.target || input.cancellationOperationId) throw new RustUnsupported("Project cancellation or reassignment");
      const id = keys.id(input.key);
      const result = await rust.removeProject(id, { digest: input.digest, reason: input.reason });
      return {
        key: input.key, reason: input.reason, removedAt: new Date(result.removedAtMs).toISOString(),
        repositories: result.repositories,
      } satisfies api.ProjectTombstone;
    },
    "project.set-planner": async (input: { key: string; agentId: string | null }) => {
      if (input.agentId !== null) throw new RustUnsupported("Use nucleus planner.claim in the planner thread");
      const id = keys.id(input.key);
      const revision = plannerRevisions.get(id);
      if (!revision) throw new Error("Reopen the project to clear its planner.");
      const saved = await rust.clearPlanner(id, revision);
      const row = saved.settings.value.projects[id];
      const project = row && boardProject(input.key, row);
      if (!project) throw new Error("Project is no longer registered.");
      return project;
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
    "project.merge-check": async () => ({ blockers: [], carried: [] }),
    // The shared Add repository flow moves one registered repository.
    "project.merge": async (input: {
      source: string;
      target: string;
      repository?: string;
    }) => {
      if (!input.repository) throw new RustUnsupported("Moving a whole project");
      const current = await rust.domain(projectsView, "projects");
      const sourceId = keys.id(input.source);
      const targetId = keys.id(input.target);
      const source = current.settings.value.projects[sourceId];
      if (!source) throw new Error(`Project ${input.source} is not registered.`);
      const repository = source.repositories.find(
        (repo) => repo.origin === input.repository || repo.path === input.repository,
      );
      if (!repository) throw new Error(`${input.repository} is not in ${source.name}.`);
      const saved = await rust.reassign(current.settings.revision, repository.origin, targetId);
      const after = saved.settings.value.projects;
      const target = after[targetId] && boardProject(keys.key(targetId), after[targetId]);
      if (!target) throw new Error("The engine did not keep the destination project.");
      const remaining = after[sourceId] && boardProject(keys.key(sourceId), after[sourceId]);
      return { project: target, source: remaining ?? null, tombstone: null };
    },
    "project.reassign": async (input: { origin: string; project: string }) => {
      const current = await rust.domain(projectsView, "projects");
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
      placement?: "internal" | "barge";
    }) => {
      const current = await rust.domain(storageView, "storage");
      await rust.saveDomain(storageView, "storage", current.settings.revision, {
        ...current.settings.value,
        ...(input.workRoot !== undefined ? { workRoot: input.workRoot } : {}),
        ...(input.scratchRoot !== undefined ? { scratchRoot: input.scratchRoot } : {}),
        ...(input.logRoot !== undefined ? { logRoot: input.logRoot } : {}),
        ...(input.buildsRoot !== undefined ? { buildsRoot: input.buildsRoot } : {}),
        ...(input.placement ? { placement: input.placement } : {}),
      });
      return storageState();
    },
    ...planning.handlers,
  };

  async function storageState() {
    const storage = await rust.storage();
    const { active, settings: stored } = storage;
    return {
      workRoot: active.workRoot,
      workVolumeId: stored.value.workVolume?.volumeId ?? null,
      worktreesRoot: active.bargePaths?.worktrees ?? active.workRoot,
      ...(active.buildsRoot ? { buildsRoot: active.buildsRoot } : {}),
      ...(stored.value.placement ?? active.placement
        ? { placement: stored.value.placement ?? active.placement }
        : {}),
      ...(active.placement ? { activePlacement: active.placement } : {}),
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
    refreshSession,
  };
}

export type RustAdapter = ReturnType<typeof createRustAdapter>;
