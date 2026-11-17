/**
 * The Nucleus task-group seam of the forked sidebar (Spec 062, decision 5a/5b).
 *
 * This is the fork's own file, not an upstream one. It owns four things and
 * nothing else:
 *
 * 1. the batched read — one `sidebarGroups` RPC call for every Nucleus task group,
 *    refetched when the backend publishes a board revision change, never one call
 *    per group;
 * 2. the join — the read is keyed by environment id, which every sidebar row
 *    already carries, so a group costs no per-thread metadata read and an unknown
 *    environment costs nothing at all;
 * 3. the collapsed/expanded decision — a Nucleus task group is collapsed unless its
 *    environment id is in the fork's own `expandedTaskGroups` preference.
 *    `collapsedEnvironments` governs every other group and is never written for a
 *    task group, so the two group classes cannot disagree;
 * 4. the project-row board link (Spec 062, decision 5d) — the same read names the
 *    BB projects Nucleus recorded for each Nucleus project, so a project row whose
 *    BB project resolves gets one "Board" menu item linking to
 *    `/plugins/nucleus/board/project/<nucleus-project-key>`; every other project
 *    row's menu is upstream's.
 *
 * A group the read does not name — an unknown environment, a task whose first
 * thread has not attached, or a read that has not landed — takes upstream's path
 * exactly: no state line, no extra preference and no other read. A task's state
 * line is an addition, never a precondition for the sidebar drawing.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAtom } from "jotai";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { ActionMenuItem, type ActionMenuSurface } from "@/components/ui/action-menu-items";
import {
  BOARD_SIGNAL_CHANNEL,
  projectBoardHref,
  sidebarGroupsContract,
  type SidebarGroup,
  type SidebarProject,
} from "../../../sidebar-groups.js";
import { expandedTaskGroupsAtom } from "../preferences/atoms.js";

interface NucleusTaskGroupsValue {
  groups: ReadonlyMap<string, SidebarGroup>;
  /** The Nucleus project each recorded BB project id stands for. */
  projects: ReadonlyMap<string, SidebarProject>;
  /** `loading` and `unavailable` both render upstream's group. */
  status: "loading" | "ready" | "unavailable";
}

const EMPTY: NucleusTaskGroupsValue = { groups: new Map(), projects: new Map(), status: "loading" };

/** Index the read's projects by the BB project ids they name; the first project wins a shared id. */
function projectsByBbProject(projects: readonly SidebarProject[]): Map<string, SidebarProject> {
  const index = new Map<string, SidebarProject>();
  for (const project of projects) for (const id of project.bbProjectIds) if (!index.has(id)) index.set(id, project);
  return index;
}

const NucleusTaskGroupsContext = createContext<NucleusTaskGroupsValue | null>(null);

/**
 * Reads the batched projection once, and again whenever the backend publishes a
 * board revision change. One component owns the read for the whole list, so a
 * hundred groups still cost one call.
 */
export function NucleusSidebarGroupsProvider({ children }: { children: ReactNode }) {
  const rpc = useRpc<typeof sidebarGroupsContract>();
  const [value, setValue] = useState<NucleusTaskGroupsValue>(EMPTY);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const answer = await rpc.call("sidebarGroups", null);
      if (!mounted.current) return;
      setValue({
        groups: new Map(answer.groups.map((group) => [group.environmentId, group])),
        projects: projectsByBbProject(answer.projects),
        status: "ready",
      });
    } catch {
      // A refused or failed read keeps a landed answer rather than blanking the
      // sidebar; with nothing landed, every group renders upstream's header.
      if (!mounted.current) return;
      setValue((current) =>
        current.status === "ready" ? current : { groups: new Map(), projects: new Map(), status: "unavailable" },
      );
    }
  }, [rpc]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  useRealtime(BOARD_SIGNAL_CHANNEL, () => {
    void load();
  });

  return (
    <NucleusTaskGroupsContext.Provider value={value}>
      {children}
    </NucleusTaskGroupsContext.Provider>
  );
}

export interface NucleusTaskGroup {
  group: SidebarGroup;
  isCollapsed: boolean;
  toggleExpanded: (environmentId: string) => void;
}

/**
 * One group's state, or `null` for every group that is not a Nucleus task group.
 * The caller renders upstream's header unchanged when this returns `null`.
 */
export function useNucleusTaskGroup(environmentId: string): NucleusTaskGroup | null {
  const context = useContext(NucleusTaskGroupsContext);
  const [expanded, setExpanded] = useAtom(expandedTaskGroupsAtom);
  const group = context?.groups.get(environmentId) ?? null;
  const toggleExpanded = useCallback(
    (id: string) => {
      setExpanded((current) =>
        current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
      );
    },
    [setExpanded],
  );
  return useMemo(() => {
    if (!group) return null;
    return { group, isCollapsed: !expanded.includes(environmentId), toggleExpanded };
  }, [group, expanded, environmentId, toggleExpanded]);
}

/** The one line the header adds: `#12 A title` over the task's state and its PR. */
const PR_LABEL_CLASS = "rounded-sm border border-current px-1 text-[10px] leading-4";
const STATE_LINE_CLASS = "min-w-0 truncate text-[11px] leading-4 text-subtle-foreground";

/** `#12 Fix the flaky lane`, or the task's title alone before it has a number. */
export function taskGroupTitle(group: SidebarGroup): string {
  const title = group.title.trim();
  return group.number === null ? title : `#${group.number} ${title}`;
}

/** The third line's PR chip: `#1296 OPEN`, `#1296 MERGED`, or nothing. */
export function TaskGroupPullRequest({ group }: { group: SidebarGroup }) {
  if (group.prNumber === null || group.prState === null) return null;
  return (
    <span
      data-nucleus-task-group-pr=""
      className="inline-flex shrink-0 items-center gap-1 text-[10px] leading-4 text-muted-foreground"
      title={group.prUrl ?? undefined}
    >
      <span className="truncate">#{group.prNumber}</span>
      <span className={PR_LABEL_CLASS}>{group.prState}</span>
    </span>
  );
}

/**
 * The task group's state block: the state label from the shared title helper (the
 * service sends the string the Paseo board names the same state with), the recorded
 * wait when there is one, and the task's pull request when it has one. It renders
 * exactly the facts the service publishes and invents no check list or QA position.
 */
export function NucleusTaskGroupStateLine({ group }: { group: SidebarGroup }) {
  return (
    <span
      data-nucleus-task-group-state=""
      className="flex min-w-0 items-center gap-1.5"
      aria-label={`${group.reference ?? group.taskId}: ${group.stateLabel}${group.waitLabel ? `, ${group.waitLabel}` : ""}${group.prState ? `, pull request ${group.prState}` : ""}`}
    >
      <span className={STATE_LINE_CLASS} data-nucleus-task-group-state-label="">
        {group.stateLabel}
      </span>
      {group.waitLabel === null ? null : (
        <span className={STATE_LINE_CLASS} data-nucleus-task-group-wait="">
          {group.waitLabel}
        </span>
      )}
      <TaskGroupPullRequest group={group} />
    </span>
  );
}

/**
 * The project row's board link: one "Board" menu item when the read names this BB
 * project's Nucleus project, and nothing otherwise, so an unknown project's menu
 * is upstream's. The link's key is the Nucleus project key (decision 5d), so a
 * multi-repository project's rows all open the one board.
 */
export function NucleusProjectBoardMenuItem({ projectId, surface }: { projectId: string; surface: ActionMenuSurface }) {
  const project = useContext(NucleusTaskGroupsContext)?.projects.get(projectId) ?? null;
  if (!project) return null;
  return (
    <ActionMenuItem surface={surface} icon="LayoutDashboard" href={projectBoardHref(project.key)}>
      Board
    </ActionMenuItem>
  );
}
