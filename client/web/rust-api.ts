import { z } from "zod";
import { capabilityLevels } from "../../shared/schema/settings/capability";
import { plannerModelSchema } from "../../shared/schema/settings/capacity";
import {
  CANONICAL_PROVIDERS,
  THINKING_LEVELS,
} from "../../shared/profile-vocabulary";
import { createRustBoardTransport } from "./rust-board";

/**
 * The Rust engine's paired browser API (`/api/engine/*`), as the engine writes
 * it. The board's data adapter (`rust-adapter.ts`) reads these shapes and maps
 * them onto the existing board contracts. Every read is parsed, so a changed
 * engine response fails loudly instead of rendering a guess.
 */

export const providers = z.enum(CANONICAL_PROVIDERS);
export const efforts = z.enum(THINKING_LEVELS);
export const capabilities = z.enum([
  "mechanical",
  "worker",
  "heavyweight",
  "frontier",
]);
export const weights = z.enum(["fewest", "fewer", "default", "more", "most"]);
export const usage = z.enum(["low", "normal", "high", "extra_high", "maximum"]);
export const dispatchMode = z.enum(["running", "held", "paused", "stopped"]);

const integer = z.number().int().nonnegative();
// Settings writes send the whole domain value back, so every object the board
// writes keeps the fields this client does not know (`loose`).
export const namedProfile = z
  .object({
    name: z.string(),
    selection: z
      .object({
        id: z.string(),
        provider: providers,
        model: z.string(),
        effort: efforts.nullable(),
        capability: capabilities,
        weight: weights,
      })
      .loose(),
    group: z.string().optional(),
    providerInstanceId: z.string().optional(),
    enabled: z.boolean().optional(),
    modeId: z.string().optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().optional(),
    unrated: z.boolean().optional(),
  })
  .loose();
const profiles = z
  .object({
    profiles: z.array(namedProfile),
    pausedGroups: z.array(z.string()).optional(),
  })
  .loose();
const dispatch = z
  .object({
    usage,
    usageUntilMs: integer.nullable(),
    globalSlots: integer,
    projectDefaultSlots: integer,
    projectSlotOverrides: z.record(z.string(), integer),
    mode: dispatchMode.default("running"),
    plannerModel: plannerModelSchema.optional(),
  })
  .loose();
const repository = z
  .object({
    origin: z.string(),
    path: z.string(),
    base: z.string(),
    hostProject: z.string().optional(),
    hostProjectTitle: z.string().optional(),
    plannerThreads: z.array(z.string()).optional(),
  })
  .loose();
export const project = z
  .object({
    plannerClaim: z
      .object({
        thread: z.string(),
        occurrence: z.string(),
        replaced: z.string().optional(),
      })
      .optional(),
    name: z.string(),
    archived: z.boolean(),
    repositories: z.array(repository),
  })
  .loose();
const projects = z.object({ projects: z.record(z.string(), project) }).loose();
const host = z
  .object({ endpoint: z.string(), credentialRef: z.string() })
  .loose();
const hosts = z.object({ t3: host.nullable() }).loose();
const storage = z
  .object({
    enabled: z.boolean(),
    // Ruling 19 (2026-11-24): an opt-in Barge placement replaces the pinned volume.
    workVolume: z
      .object({ volumeId: z.string(), mount: z.string() })
      .nullable()
      .optional(),
    placement: z.enum(["internal", "barge"]).optional(),
    buildsRoot: z.string().nullable().optional(),
    workRoot: z.string().nullable(),
    scratchRoot: z.string().nullable(),
    logRoot: z.string().nullable(),
    retention: z.object({
      keepNewest: integer,
      maxAgeDays: integer.nullable(),
    }),
  })
  .loose();

function snapshot<T>(value: z.ZodType<T>) {
  return z.object({ value, revision: z.string(), configured: z.boolean() });
}

export const profilesSnapshot = snapshot(profiles).extend({
  effectiveGroups: z.record(z.string(), z.string()),
});
export const dispatchSnapshot = snapshot(dispatch);
export const projectsView = z.object({
  settings: snapshot(projects),
  verifiedPlanners: z.record(z.string(), z.array(z.string())).optional(),
  resolvedPlanners: z.record(z.string(), z.string().nullable()),
});
export const hostsView = z.object({
  settings: snapshot(hosts),
  active: z.object({
    endpoint: z.string(),
    status: z.enum(["unknown", "reachable", "unavailable"]),
  }),
});
const backupInventory = z.object({
  complete: z.boolean(),
  issues: integer,
  verified: z.array(z.object({ id: z.string(), createdAt: z.string() })),
});
export const storageView = z.object({
  settings: snapshot(storage),
  active: z
    .object({
      databaseRoot: z.string(),
      workRoot: z.string(),
      backupRoot: z.string(),
      scratchRoot: z.string(),
      logRoot: z.string(),
      home: z.string().optional(),
      placement: z.enum(["internal", "barge"]).optional(),
      buildsRoot: z.string().optional(),
      bargePaths: z
        .object({
          worktrees: z.string().optional(),
          scratch: z.string().optional(),
          builds: z.string().optional(),
        })
        .optional(),
    })
    .loose(),
  backups: backupInventory.optional(),
  configBackups: backupInventory.optional(),
});
export const allSettings = z.object({
  profiles: profilesSnapshot,
  dispatch: dispatchSnapshot,
  projects: projectsView,
  hosts: hostsView,
  storage: storageView,
});
// Whole-domain edits still use the strict domain snapshots above. Board reads
// decode the individual records so one invalid row can be reported in place.
const boardSettings = allSettings.extend({
  projects: projectsView.extend({
    settings: snapshot(
      projects.extend({ projects: z.record(z.string(), z.unknown()) }),
    ),
  }),
  profiles: profilesSnapshot.extend({
    value: profiles.extend({ profiles: z.array(z.unknown()) }),
  }),
});
const browserSession = z.object({
  id: z.string(),
  canEditSettings: z.boolean(),
  // null is an unscoped controller; an empty list has no live project binding.
  planningProjects: z.array(z.string()).nullable(),
});
export type RustBrowserSession = z.infer<typeof browserSession>;

const cachedCatalog = z.object({
  providers: z.array(z.unknown()).nullable(),
  readAtMs: integer.nullable(),
  status: z.enum(["pending", "current", "stale"]),
});
const countMap = z.record(z.string(), integer);
const usageWindow = z.object({
  counts: countMap,
  groups: countMap,
  sample: integer,
});
const profileUsage = z.object({
  recent: usageWindow,
  worker: usageWindow,
  reviewer: usageWindow,
  totals: countMap,
  groupTotals: countMap,
  limitedGroups: countMap.optional(),
  fallbackGroups: z.array(z.string()).optional(),
});
export type RustCachedCatalog = z.infer<typeof cachedCatalog>;
export type RustProfileUsage = z.infer<typeof profileUsage>;

const horizon = z.enum(["now", "next", "later"]);
export const plan = z.object({
  version: integer,
  lanes: z.array(
    z.object({
      key: z.string(),
      horizon,
      doneWhen: z.string(),
      statusNote: z.string(),
    }),
  ),
});
export const lane = z.object({
  key: z.string(),
  version: integer,
  title: z.string(),
  aim: z.string(),
  document: z.string(),
  status: z.enum(["open", "done", "dropped"]),
  note: z.string().optional(),
});
export const planView = plan.extend({
  documents: z.array(lane),
  idle: z.boolean(),
});
export const item = z.object({
  id: z.string(),
  kind: z.enum(["lead", "papercut"]),
  author: z.string(),
  authorLabel: z.string().default("Agent thread"),
  authorProjectId: z.string().optional(),
  taskLinks: z.array(z.string()).optional(),
  title: z.string(),
  createdAtMs: integer.nullish(),
  updatedAtMs: integer.nullish(),
  version: z.number().int().positive().optional(),
  body: z.string(),
  lanes: z.array(z.string()),
  /** Imported items name their member repositories within the project, by origin. */
  repositories: z.array(z.string()).optional(),
  state: z.enum(["open", "parked", "promoted", "dropped"]),
  reason: z.string().nullable().optional(),
  disposition: z.enum(["completed", "deprecated"]).optional(),
  revisitAt: z.string().nullable().optional(),
  taskId: z.string().optional(),
  /** A lead's brief complexity, parsed by the engine's brief policy (board reads only). */
  complexity: z.enum(capabilityLevels).optional(),
});
export const decision = z.object({
  authorLabel: z.string().default("Agent thread"),
  id: z.string(),
  projectId: z.string(),
  question: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  author: z.string(),
  createdAtMs: integer,
  answer: z
    .object({
      optionId: z.string().optional(),
      answer: z.string().optional(),
      basedOnOptionId: z.string().optional(),
      note: z.string().nullable(),
      author: z.string(),
      answeredAtMs: integer,
    })
    .nullable(),
  task: z.object({ taskId: z.string(), taskVersion: z.number() }).optional(),
  withdrawn: z.boolean().optional(),
});
export const themeInputs = z.object({
  theme: z.object({ settings: z.unknown(), theme: z.unknown() }).nullable(),
});

export type RustProfiles = z.infer<typeof profiles>;
export type RustNamedProfile = z.infer<typeof namedProfile>;
export type RustDispatch = z.infer<typeof dispatch>;
export type RustDispatchMode = z.infer<typeof dispatchMode>;
export type RustProjects = z.infer<typeof projects>;
export type RustProject = z.infer<typeof project>;
export type RustRepository = z.infer<typeof repository>;
export type RustAllSettings = z.infer<typeof allSettings>;
export type RustStorage = z.infer<typeof storage>;
export type RustPlanView = z.infer<typeof planView>;
export type RustPlan = z.infer<typeof plan>;
export type RustLane = z.infer<typeof lane>;
export type RustItem = z.infer<typeof item>;
export type RustDecision = z.infer<typeof decision>;

export type SettingsDomain =
  | "profiles"
  | "dispatch"
  | "projects"
  | "hosts"
  | "storage";

function shareRead<T>(read: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= read().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

export function createRustApi(fetcher: typeof fetch = fetch) {
  const board = createRustBoardTransport(fetcher);
  const json = (method: string, body: unknown) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const planning = (project: string, path: string) =>
    `/planning/${encodeURIComponent(project)}${path}`;
  return {
    board,
    session: () => board.read(browserSession, "/session"),
    settings: () => board.read(boardSettings, "/settings"),
    domain: <T>(schema: z.ZodType<T>, domain: SettingsDomain) =>
      board.read(schema, `/settings/${domain}`),
    saveDomain: <T>(
      schema: z.ZodType<T>,
      domain: SettingsDomain,
      revision: string,
      value: unknown,
    ) =>
      board.read(
        schema,
        `/settings/${domain}`,
        json("PUT", { revision, value }),
      ),
    clearPlanner: (id: string, revision: string) =>
      board.read(
        projectsView,
        `/settings/projects/${encodeURIComponent(id)}/clear-planner`,
        json("POST", { revision }),
      ),
    reassign: (revision: string, origin: string, toProject: string) =>
      board.read(
        projectsView,
        "/settings/projects/reassign",
        json("POST", { revision, origin, toProject }),
      ),
    previewProjectRemoval: (id: string) =>
      board.read(
        z.object({
          project,
          digest: z.string(),
          tasks: z.array(
            z.object({
              taskId: z.string(),
              version: integer,
              label: z.string(),
            }),
          ),
        }),
        `/settings/projects/${encodeURIComponent(id)}/removal`,
      ),
    removeProject: (id: string, input: { digest: string; reason: string }) =>
      board.read(
        z.object({
          repositories: z.array(
            z.object({ origin: z.string(), path: z.string() }),
          ),
          removedAtMs: integer,
        }),
        `/settings/projects/${encodeURIComponent(id)}/removal`,
        json("POST", input),
      ),
    theme: () => board.read(themeInputs, "/theme"),
    catalog: shareRead(() => board.read(cachedCatalog, "/profiles/catalog")),
    storage: shareRead(() => board.read(storageView, "/settings/storage")),
    storedProfiles: shareRead(() =>
      board.read(profilesSnapshot, "/settings/profiles"),
    ),
    profileUsage: () => board.read(profileUsage, "/profiles/usage"),
    clearFallbackPause: (group: string, untilMs: number) =>
      board.read(
        z.object({ ok: z.literal(true) }),
        `/profiles/pauses/${encodeURIComponent(group)}/clear`,
        json("POST", { untilMs }),
      ),
    plan: (project: string) => board.read(planView, planning(project, "/plan")),
    setPlan: (project: string, value: RustPlan) =>
      board.read(plan, planning(project, "/plan"), json("PUT", value)),
    putLane: (
      project: string,
      key: string,
      value: { version: number; title: string; aim: string; document: string },
    ) =>
      board.read(
        lane,
        planning(project, `/lanes/${encodeURIComponent(key)}`),
        json("PUT", value),
      ),
    laneStatus: (
      project: string,
      key: string,
      value: { status: "open" } | { status: "done" | "dropped"; note: string },
    ) =>
      board.read(
        lane,
        planning(project, `/lanes/${encodeURIComponent(key)}/status`),
        json("POST", value),
      ),
    items: (project: string) =>
      board.read(z.array(item), planning(project, "/items")),
    editItem: (
      project: string,
      id: string,
      value: {
        version: number;
        title: string;
        body: string;
        lanes: string[];
      },
    ) =>
      board.read(
        item.extend({ version: z.number().int().positive() }),
        planning(project, `/items/${encodeURIComponent(id)}`),
        json("PUT", value),
      ),
    parkItem: (
      project: string,
      id: string,
      value: { reason: string; revisitAt: string | null },
    ) =>
      board.read(
        item,
        planning(project, `/items/${encodeURIComponent(id)}/park`),
        json("POST", value),
      ),
    reopenItem: (
      project: string,
      id: string,
      value: { note?: string; version?: number },
    ) =>
      board.read(
        item.extend({ version: z.number().int().positive() }),
        planning(project, `/items/${encodeURIComponent(id)}/reopen`),
        json("POST", value),
      ),
    dropItem: (
      project: string,
      id: string,
      reason: string | null,
      disposition?: RustItem["disposition"],
    ) =>
      board.read(
        item,
        planning(project, `/items/${encodeURIComponent(id)}/drop`),
        json("POST", { reason, disposition }),
      ),
    assessItem: (
      project: string,
      id: string,
      value: { version: number },
    ) =>
      board.read(
        item.extend({ version: z.number().int().positive() }),
        planning(project, `/items/${encodeURIComponent(id)}/assess`),
        json("POST", value),
      ),
    decisions: (project: string) =>
      board.read(z.array(decision), planning(project, "/decisions")),
    answerDecision: (
      project: string,
      id: string,
      value: {
        optionId?: string;
        answer?: string;
        basedOnOptionId?: string;
        note: string | null;
      },
    ) =>
      board.read(
        decision,
        planning(project, `/decisions/${encodeURIComponent(id)}/answer`),
        json("POST", value),
      ),
  };
}

export type RustApi = ReturnType<typeof createRustApi>;
