/**
 * Folding the Lanes destination into Planning (nucleus#866, lane `nucleus-ui`;
 * Tom, 2026-11-07: Planning is where an operator reads direction and finds a
 * lane). Lane discovery is now a search inside Planning against a project
 * chooser and a clearly labelled all-projects scope.
 *
 * A lane lists repositories, and a project is the records owner for its
 * repositories, so a shared lane belongs to every project that lists one of
 * them. Each project's plan orders that lane separately: a lane can be the top
 * `now` step of one project and `later` in another. Nothing here invents a
 * single global order, and nothing here reads or changes planning authority —
 * it is a view of the same lane records the agent CLI uses.
 */
import type { LaneView, Project, ProjectPlan } from "./contracts";
import { effectiveSelection } from "./project-scope";

export type LaneHorizon = "now" | "next" | "later";

/** A lane's place in one project's own plan. `horizon` is null when that project's plan does not list the lane. */
export type LanePlace = {
  key: string;
  name: string;
  parked: boolean;
  horizon: LaneHorizon | null;
  /** 1-based position within the horizon group, and that group's size; null when the lane is not in the plan. */
  position: number | null;
  size: number | null;
};

export type LaneFinderRow = {
  key: string;
  title: string;
  aim: string;
  status: LaneView["status"];
  /** Every project that lists one of the lane's repositories, with that project's own plan position. */
  places: LanePlace[];
  /** True when more than one project lists the lane: its order is per project, never global. */
  shared: boolean;
  lastActivityAt: string | null;
};

const HORIZONS: LaneHorizon[] = ["now", "next", "later"];
const statusOrder: Record<LaneView["status"], number> = {
  active: 0,
  paused: 1,
  done: 2,
  abandoned: 3,
};

/** A project's repository may have no known origin; a lane's always does (Spec 019). */
type RepositoryHint = { origin: string | null; path: string };
const sameRepository = (a: RepositoryHint, b: RepositoryHint) =>
  a.origin && b.origin
    ? a.origin === b.origin
    : Boolean(a.path && b.path && a.path === b.path);

/** Every project that lists one of the lane's repositories. */
export function laneProjects(
  lane: { repositories: RepositoryHint[] },
  projects: readonly Project[],
): Project[] {
  return projects.filter((project) =>
    project.repositories.some((repo) =>
      lane.repositories.some((listed) => sameRepository(repo, listed)),
    ),
  );
}

/** One project's plan position for the lane: its horizon, its 1-based place in that group, and the group's size. */
export function planPosition(
  plan: Pick<ProjectPlan, "entries"> | undefined,
  lane: string,
) {
  const entries = plan?.entries ?? [];
  const entry = entries.find((item) => item.lane === lane);
  if (!entry) return null;
  const group = entries.filter((item) => item.horizon === entry.horizon);
  return {
    horizon: entry.horizon as LaneHorizon,
    position: group.findIndex((item) => item.lane === lane) + 1,
    size: group.length,
  };
}

/** The lane's places across projects, in project-name order. A project whose plan does not list the lane still appears, without a position. */
export function lanePlaces(
  lane: Pick<LaneView, "key" | "repositories">,
  projects: readonly Project[],
  plans: readonly ProjectPlan[],
): LanePlace[] {
  return laneProjects(lane, projects)
    .map((project) => ({
      project,
      position: planPosition(
        plans.find((plan) => plan.project === project.key),
        lane.key,
      ),
    }))
    .sort((a, b) => a.project.name.localeCompare(b.project.name))
    .map(({ project, position }) => ({
      key: project.key,
      name: project.name,
      parked: project.visibility === "parked",
      horizon: position?.horizon ?? null,
      position: position?.position ?? null,
      size: position?.size ?? null,
    }));
}

/** "All projects", one project's name, or "N projects": the same words the header selector uses. */
export function laneFinderScopeLabel(
  projects: readonly Project[],
  selection: readonly string[],
): string {
  const chosen = effectiveSelection([...projects], selection);
  if (!chosen.length) return "All projects";
  if (chosen.length === 1)
    return (
      projects.find((project) => project.key === chosen[0])?.name ?? "1 project"
    );
  return `${chosen.length} projects`;
}

/**
 * The lane list behind "Find lanes". The scope is the chosen projects, or every
 * non-parked project when nothing is chosen (the board's long-standing All
 * projects rule, Spec 027), so a parked project's lanes are found by choosing
 * that project. A query matches the title, aim, key and project names; an empty
 * query lists every lane in scope. Open lanes come first, then paused, then the
 * closed ones, each by title.
 */
export function laneFinderRows(input: {
  lanes: readonly LaneView[];
  projects: readonly Project[];
  plans: readonly ProjectPlan[];
  selection?: readonly string[];
  query?: string;
}): LaneFinderRow[] {
  const selection = effectiveSelection(
    [...input.projects],
    input.selection ?? [],
  );
  const needle = (input.query ?? "").trim().toLowerCase();
  const inScope = (place: LanePlace) =>
    selection.length ? selection.includes(place.key) : !place.parked;
  return input.lanes
    .map((lane) => {
      const places = lanePlaces(lane, input.projects, input.plans);
      return {
        key: lane.key,
        title: lane.title,
        aim: lane.aim,
        status: lane.status,
        places,
        shared: places.length > 1,
        lastActivityAt: lane.lastActivityAt,
      } satisfies LaneFinderRow;
    })
    .filter((row) => row.places.some(inScope))
    .filter(
      (row) =>
        !needle ||
        [row.title, row.aim, row.key, ...row.places.map((place) => place.name)]
          .join("\n")
          .toLowerCase()
          .includes(needle),
    )
    .sort(
      (a, b) =>
        statusOrder[a.status] - statusOrder[b.status] ||
        a.title.localeCompare(b.title) ||
        a.key.localeCompare(b.key),
    );
}

/** The finder's count line: results always come from every lane record read, never a first page. */
export function laneFinderCount(shown: number, scope: number): string {
  if (shown === scope) return scope === 1 ? "1 lane" : `${scope} lanes`;
  return `${shown} of ${scope} lanes`;
}

/** The plan position in the operator's words, for a lane's project list and for a search result. */
export function lanePlaceLabel(place: LanePlace): string {
  if (!place.horizon) return "Not in the plan";
  const horizon = place.horizon[0].toUpperCase() + place.horizon.slice(1);
  return place.position !== null && place.size !== null
    ? `${horizon} · step ${place.position} of ${place.size}`
    : horizon;
}

/** Projects in the order a chooser shows them: active by name, then parked by name. */
export function chooserProjects(projects: readonly Project[]): Project[] {
  return [...projects].sort(
    (a, b) =>
      Number(a.visibility === "parked") - Number(b.visibility === "parked") ||
      a.name.localeCompare(b.name),
  );
}
