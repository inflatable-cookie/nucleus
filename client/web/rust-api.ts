import { z } from "zod";
import type { CapabilityLevel } from "../../shared/contracts";
import { CANONICAL_PROVIDERS, THINKING_LEVELS } from "../../shared/profile-vocabulary";
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
    roles: z.array(z.enum(["worker", "reviewer", "coordinator"])).optional(),
    scopes: z.array(z.string()).optional(),
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
const dispatch = z.object({
  usage,
  usageUntilMs: integer.nullable(),
  globalSlots: integer,
  projectDefaultSlots: integer,
  projectSlotOverrides: z.record(z.string(), integer),
  providerLimitCooldownSeconds: integer.optional(),
  mode: dispatchMode.default("running"),
}).loose();
const repository = z.object({
  origin: z.string(),
  path: z.string(),
  base: z.string(),
  requiredChecks: z.array(z.string()),
  hungToolMinutes: integer,
  hostProject: z.string().optional(),
  hostProjectTitle: z.string().optional(),
  plannerThreads: z.array(z.string()).optional(),
}).loose();
const project = z.object({
  name: z.string(),
  archived: z.boolean(),
  repositories: z.array(repository),
}).loose();
const projects = z.object({ projects: z.record(z.string(), project) }).loose();
const host = z.object({ endpoint: z.string(), credentialRef: z.string() }).loose();
const hosts = z.object({ t3: host.nullable() }).loose();
const storage = z.object({
  enabled: z.boolean(),
  // Ruling 19 (2026-11-24): an opt-in Barge placement replaces the pinned volume.
  workVolume: z.object({ volumeId: z.string(), mount: z.string() }).nullable().optional(),
  placement: z.enum(["internal", "barge"]).optional(),
  buildsRoot: z.string().nullable().optional(),
  workRoot: z.string().nullable(),
  scratchRoot: z.string().nullable(),
  logRoot: z.string().nullable(),
  retention: z.object({ keepNewest: integer, maxAgeDays: integer.nullable() }),
}).loose();

function snapshot<T>(value: z.ZodType<T>) {
  return z.object({ value, revision: z.string(), configured: z.boolean() });
}

export const profilesSnapshot = snapshot(profiles);
export const dispatchSnapshot = snapshot(dispatch);
export const projectsView = z.object({
  settings: snapshot(projects),
  resolvedPlanners: z.record(z.string(), z.string().nullable()),
});
export const hostsView = z.object({
  settings: snapshot(hosts),
  active: z.object({
    endpoint: z.string(),
    status: z.enum(["unknown", "reachable", "unavailable"]),
  }),
});
export const storageView = z.object({
  settings: snapshot(storage),
  active: z.object({
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
  }).loose(),
  backups: z
    .object({
      complete: z.boolean(),
      issues: integer,
      verified: z.array(z.object({ id: z.string(), createdAt: z.string() })),
    })
    .optional(),
});
export const allSettings = z.object({
  profiles: profilesSnapshot,
  dispatch: dispatchSnapshot,
  projects: projectsView,
  hosts: hostsView,
  storage: storageView,
});
export const browserSession = z.object({ canEditSettings: z.boolean() });

const cachedCatalog = z.object({
  providers: z.array(z.unknown()).nullable(),
  readAtMs: integer.nullable(),
  status: z.enum(["pending", "current", "stale"]),
});
const countMap = z.record(z.string(), integer);
const usageWindow = z.object({ counts: countMap, groups: countMap, sample: integer });
const profileUsage = z.object({
  recent: usageWindow,
  worker: usageWindow,
  reviewer: usageWindow,
  totals: countMap,
  groupTotals: countMap,
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
  taskLinks: z.array(z.string()).optional(),
  title: z.string(),
  body: z.string(),
  lanes: z.array(z.string()),
  /** Imported items name their member repositories within the project, by origin. */
  repositories: z.array(z.string()).optional(),
  state: z.enum(["open", "parked", "promoted", "dropped"]),
  reason: z.string().nullable().optional(),
  revisitAt: z.string().nullable().optional(),
  taskId: z.string().optional(),
});
export const decision = z.object({
  id: z.string(),
  projectId: z.string(),
  question: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  author: z.string(),
  createdAtMs: integer,
  answer: z
    .object({
      optionId: z.string(),
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
    settings: () => board.read(allSettings, "/settings"),
    domain: <T>(schema: z.ZodType<T>, domain: SettingsDomain) =>
      board.read(schema, `/settings/${domain}`),
    saveDomain: <T>(
      schema: z.ZodType<T>,
      domain: SettingsDomain,
      revision: string,
      value: unknown,
    ) =>
      board.read(schema, `/settings/${domain}`, json("PUT", { revision, value })),
    reassign: (revision: string, origin: string, toProject: string) =>
      board.read(
        projectsView,
        "/settings/projects/reassign",
        json("POST", { revision, origin, toProject }),
      ),
    theme: () => board.read(themeInputs, "/theme"),
    catalog: () => board.read(cachedCatalog, "/profiles/catalog"),
    profileUsage: () => board.read(profileUsage, "/profiles/usage"),
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
      value: { title: string; body: string; lanes: string[] },
    ) =>
      board.read(
        item,
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
    dropItem: (project: string, id: string, reason: string | null) =>
      board.read(
        item,
        planning(project, `/items/${encodeURIComponent(id)}/drop`),
        json("POST", { reason }),
      ),
    promoteItem: (project: string, id: string, complexity?: CapabilityLevel) =>
      board.read(
        z.object({ identity: z.object({ id: z.string() }) }).loose(),
        planning(project, `/items/${encodeURIComponent(id)}/promote`),
        json("POST", { complexity }),
      ),
    decisions: (project: string) =>
      board.read(z.array(decision), planning(project, "/decisions")),
    answerDecision: (
      project: string,
      id: string,
      value: { optionId: string; note: string | null },
    ) =>
      board.read(
        decision,
        planning(project, `/decisions/${encodeURIComponent(id)}/answer`),
        json("POST", value),
      ),
  };
}

export type RustApi = ReturnType<typeof createRustApi>;
