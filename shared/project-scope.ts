import { readMigratedValue, type KeyValueStorage } from "./storage-migration";
import {
  projectDormant,
  type LeadListFacts,
  type Project,
  type ProjectPlan,
  type TaskSummary,
} from "./contracts";
import { projectPlanningCounts } from "./planning-tab";
import { hiddenQueuedByProject } from "./queued-more";

/**
 * Spec 026 Board "Scope": one project selector scopes Pipeline, Lanes,
 * Papercuts and Planning. It is single-select by default (nucleus#1421): a
 * plain press replaces the selection, Shift-press toggles one project. An
 * empty selection means all projects. The
 * Pipeline view has its own filter switch; off shows everything and keeps the selection.
 */
export type ProjectScope = { projects: string[]; statusFilter: boolean };
export const defaultProjectScope: ProjectScope = {
  projects: [],
  statusFilter: true,
};

/** Selected keys that still name a project; unknown keys are ignored once projects load. */
export function effectiveSelection(
  projects: Project[],
  selection: readonly string[],
): string[] {
  if (!projects.length) return [...selection];
  return selection.filter((key) =>
    projects.some((project) => project.key === key),
  );
}

/** The projects a scoped view shows, by name. Empty selection means all. */
export function scopedProjects(
  projects: Project[],
  selection: readonly string[],
): Project[] {
  const keys = effectiveSelection(projects, selection);
  return projects
    .filter((project) =>
      keys.length
        ? keys.includes(project.key)
        : project.visibility !== "parked",
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Match a repository by origin when both have one, otherwise by path. */
export function projectHasRepository(
  project: Project,
  repoPath: string,
  origin?: string | null,
): boolean {
  return project.repositories.some((repo) =>
    origin && repo.origin
      ? repo.origin === origin
      : Boolean(repo.path && repo.path === repoPath),
  );
}

/** Whether a record's repository falls inside the selection. Empty selection matches everything. */
export function scopeContains(
  projects: Project[],
  selection: readonly string[],
): (repoPath: string, origin?: string | null) => boolean {
  const keys = effectiveSelection(projects, selection);
  if (!keys.length)
    return (repoPath, origin) =>
      projects.every(
        (project) =>
          project.visibility !== "parked" ||
          !projectHasRepository(project, repoPath, origin),
      );
  const selected = projects.filter((project) => keys.includes(project.key));
  return (repoPath, origin) =>
    selected.some((project) => projectHasRepository(project, repoPath, origin));
}

/** The Pipeline view's selection: the kept selection when its filter switch is on, all projects when off. */
/**
 * The selection every scoped view uses. The selector's "Enabled" switch (Tom,
 * 2026-09-28; formerly the Pipeline-only "Filter by project") turns filtering off
 * everywhere without clearing the selection. `statusFilter` is the stored field.
 */
export function activeSelection(scope: ProjectScope): string[] {
  return scope.statusFilter ? scope.projects : [];
}
/** Kept for callers written before the switch moved into the selector. */
export const pipelineSelection = activeSelection;
/** Kept for callers written before the 2026-09-27 board retirement: the Pipeline filter switch owns this now. */
export const statusSelection = pipelineSelection;

export function toggleProject(
  selection: readonly string[],
  key: string,
): string[] {
  return selection.includes(key)
    ? selection.filter((item) => item !== key)
    : [...selection, key];
}

/** Spec 026 Board "Scope" (nucleus#1421): the selector is single-select by
 * default. A plain press replaces the selection with that project; pressing
 * the sole selected project keeps it selected. Shift-press toggles through
 * {@link toggleProject} and leaves every other selection intact. */
export function selectProject(
  selection: readonly string[],
  key: string,
): string[] {
  if (selection.length === 1 && selection[0] === key) return [...selection];
  return [key];
}

/** The press-event shapes that carry the Shift modifier. React Native passes
 * the DOM event under `nativeEvent` while React Native Web also exposes the
 * modifier at the top level; touch and keyboard activation carry neither. */
export type ProjectPressEvent =
  | {
      shiftKey?: unknown;
      nativeEvent?: unknown;
    }
  | null
  | undefined;

/** True when the actual web press/activation event carries Shift (nucleus#1421).
 * Read from the press event itself, never from component state, so the
 * modifier survives React Native Web's event wrapping. */
export function isAdditivePress(event: ProjectPressEvent): boolean {
  if (!event || typeof event !== "object") return false;
  if ((event as { shiftKey?: unknown }).shiftKey === true) return true;
  const native = (event as { nativeEvent?: unknown }).nativeEvent;
  return Boolean(
    native &&
      typeof native === "object" &&
      (native as { shiftKey?: unknown }).shiftKey === true,
  );
}

export function selectionLabel(
  projects: Project[],
  selection: readonly string[],
): string {
  const keys = effectiveSelection(projects, selection);
  if (!keys.length) return "All projects";
  if (keys.length === 1)
    return projects.find((project) => project.key === keys[0])?.name ?? keys[0];
  return keys.length ===
    projects.filter((project) => project.visibility !== "parked").length &&
    keys.every(
      (key) =>
        projects.find((project) => project.key === key)?.visibility !==
        "parked",
    )
    ? `All ${keys.length} projects`
    : `${keys.length} projects`;
}

export type ProjectSelectorRow = {
  key: string;
  name: string;
  primary: string;
  tasks: number;
  leads: number;
  checked: boolean;
  visibility: Project["visibility"];
  version: number;
  dormant: boolean;
};
/** Selector popover rows: every project matching the filter box, with its primary repository and counts. */
export function projectSelectorRows(
  projects: Project[],
  selection: readonly string[],
  search: string,
  tasks: TaskSummary[],
  leads: readonly LeadListFacts[],
  queuedCounts: readonly { repoPath: string; count: number }[] = [],
): ProjectSelectorRow[] {
  const needle = search.trim().toLowerCase();
  const hiddenQueued = hiddenQueuedByProject(queuedCounts, tasks);
  return [...projects]
    .sort(
      (a, b) =>
        Number(a.visibility === "parked") - Number(b.visibility === "parked") ||
        Number(projectDormant(a)) - Number(projectDormant(b)) ||
        a.name.localeCompare(b.name),
    )
    .flatMap((project) => {
      const primary = project.primary.origin ?? project.primary.path;
      if (
        needle &&
        !`${project.name} ${primary}`.toLowerCase().includes(needle)
      )
        return [];
      const counts = projectPlanningCounts(project, tasks, leads);
      const hidden = hiddenQueued.reduce(
        (total, item) =>
          project.repositories.some((repo) => repo.path === item.repoPath)
            ? total + item.hidden
            : total,
        0,
      );
      return [
        {
          key: project.key,
          name: project.name,
          primary,
          ...counts,
          tasks: counts.tasks + hidden,
          checked: selection.includes(project.key),
          visibility: project.visibility,
          version: project.version,
          dormant: projectDormant(project),
        },
      ];
    });
}

type ScopeStorage = KeyValueStorage;
const storageKey = "nucleus:project-scope";
// Rows saved under the old plugin name stay readable; no new write uses it.
const legacyStorageKey = "northstar-queue:project-scope";
let sessionScope: ProjectScope = defaultProjectScope;

/** Persisted across plugin reloads when the surface has local storage; otherwise kept for the session. Never written to Queue's store. */
export function readProjectScope(
  storage: ScopeStorage | undefined,
): ProjectScope {
  try {
    const scope = readMigratedValue(
      storage,
      storageKey,
      legacyStorageKey,
      (raw) => {
        const value = JSON.parse(raw) as Partial<ProjectScope>;
        return {
          projects: Array.isArray(value.projects)
            ? value.projects.filter(
                (key): key is string => typeof key === "string",
              )
            : [],
          statusFilter:
            typeof value.statusFilter === "boolean" ? value.statusFilter : true,
        };
      },
    );
    if (!scope) return sessionScope;
    return scope;
  } catch {
    return sessionScope;
  }
}

export function writeProjectScope(
  storage: ScopeStorage | undefined,
  scope: ProjectScope,
): void {
  sessionScope = scope;
  try {
    storage?.setItem(storageKey, JSON.stringify(scope));
  } catch {
    /* session copy stands */
  }
}

/** Lanes the Planning tab may show for the selection: every lane in a selected
 * project's plan, plus lanes listing a selected project's repository. */
export function planningScopeLanes(
  projects: Project[],
  selection: readonly string[],
  plans: ProjectPlan[],
  lanes: Array<{
    key: string;
    repositories: Array<{ origin: string; path: string }>;
  }>,
): string[] {
  const keys = new Set(
    scopedProjects(projects, selection).map((project) => project.key),
  );
  const contains = scopeContains(projects, selection);
  return [
    ...new Set([
      ...plans
        .filter((plan) => keys.has(plan.project))
        .flatMap((plan) => plan.entries.map((entry) => entry.lane)),
      ...lanes
        .filter((lane) =>
          lane.repositories.some((repo) => contains(repo.path, repo.origin)),
        )
        .map((lane) => lane.key),
    ]),
  ];
}

/** Open leads on a lane, limited to the selected projects' repositories. A lane shared
 * across projects shows only the in-scope projects' leads. */
export function planningLaneLeads(
  leads: readonly LeadListFacts[],
  lane: string,
  projects: Project[],
  selection: readonly string[],
): LeadListFacts[] {
  const contains = scopeContains(projects, selection);
  return leads.filter(
    (lead) =>
      lead.state === "open" &&
      lead.lanes.includes(lane) &&
      lead.repositories.some((repo) => contains(repo.path, repo.origin)),
  );
}
