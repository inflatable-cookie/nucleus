/**
 * The Nucleus task-group seam of the forked sidebar (Spec 062, decision 5a/5b).
 *
 * This is the fork's own file, not an upstream one. It owns five things and
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
 *    row's menu is upstream's;
 * 5. the cross-project pointer (nucleus#1313, Tom 2026-11-17) — a task thread whose
 *    planner lives in another project resolves to that project's section, so its
 *    own project would show upstream's "No threads" over a live task. That project
 *    gets one compact pointer row, "N tasks under <planner title>", linking to the
 *    planner the threads nest under. Upstream's empty state stays for a project
 *    with no threads anywhere.
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
import { Icon } from "@/components/ui/icon";
import {
  BOARD_SIGNAL_CHANNEL,
  projectBoardHref,
  sidebarGroupsContract,
  sidebarTaskActionContract,
  type SidebarGroup,
  type SidebarProject,
} from "../../../sidebar-groups.js";
import { expandedTaskGroupsAtom } from "../preferences/atoms.js";
import { resolveSidebarProjectId } from "../model/project-thread-groups.js";
import {
  pullRequestBadge,
  pullRequestBadgeLabel,
  pullRequestNumberLabel,
  type PullRequestTone,
} from "../../../../../../shared/pull-request-badge.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { useSidebarData } from "../model/use-sidebar-data.js";

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
const PR_CHIP_CLASS = "inline-flex shrink-0 items-center gap-1 text-[10px] leading-4";
const STATE_LINE_CLASS = "min-w-0 truncate text-[11px] leading-4 text-subtle-foreground";
/**
 * The tone palette, in the host app's own tokens: the board's theme roles
 * (success/accent/danger/warning/muted) as CSS variables, so one shared mapping
 * drives both surfaces (nucleus#1313, Tom 2026-11-17). `--pr-merged` is BB's
 * universal merged colour; `--success` its open-PR colour.
 */
const PR_TONE_COLOR: Record<PullRequestTone, string> = {
  success: "var(--success)",
  accent: "var(--pr-merged)",
  danger: "var(--destructive)",
  warning: "var(--warning-text)",
  muted: "var(--muted-foreground)",
};

/** `#12 Fix the flaky lane`, or the task's title alone before it has a number. */
export function taskGroupTitle(group: SidebarGroup): string {
  const title = group.title.trim();
  return group.number === null ? title : `#${group.number} ${title}`;
}

/**
 * The third line's PR chip: the standard state icon plus `#39` in the state
 * colour, with no visible state word — the state is the accessible label
 * (nucleus#1313, Tom 2026-11-17). `shared/pull-request-badge.ts` is the one
 * mapping, shared with the board's `PullRequestBadge`.
 */
export function TaskGroupPullRequest({ group }: { group: SidebarGroup }) {
  if (group.prNumber === null || group.prState === null) return null;
  const badge = pullRequestBadge({ state: group.prState, blocked: group.attention });
  const color = PR_TONE_COLOR[badge.tone];
  return (
    <span
      data-nucleus-task-group-pr=""
      data-nucleus-task-group-pr-state={group.prState.toLowerCase()}
      data-nucleus-task-group-pr-tone={badge.tone}
      className={PR_CHIP_CLASS}
      style={{ color }}
      title={group.prUrl ?? undefined}
      role="img"
      aria-label={pullRequestBadgeLabel(group.prNumber, badge)}
    >
      <Icon name={badge.icon} className="size-3.5" aria-hidden />
      <span className="truncate">{pullRequestNumberLabel(group.prNumber)}</span>
    </span>
  );
}

/**
 * The task group's state block: the repository the task works on, then the state
 * label from the shared title helper (the service sends the string the Paseo board
 * names the same state with), the recorded wait when there is one, and the task's
 * pull request when it has one. It renders exactly the facts the service publishes
 * and invents no check list or QA position. The repository leads because a task can
 * nest under a planner from another BB project, one Nucleus project can span several
 * repositories, and a standalone container has no planner context at all
 * (nucleus#1313, Tom 2026-11-17).
 */
export function NucleusTaskGroupStateLine({ group }: { group: SidebarGroup }) {
  return (
    <span
      data-nucleus-task-group-state=""
      className="flex min-w-0 items-center gap-1.5"
      aria-label={`${group.repository}, ${group.reference ?? group.taskId}: ${group.stateLabel}${group.waitLabel ? `, ${group.waitLabel}` : ""}${group.prState ? `, pull request ${group.prState}` : ""}`}
    >
      <span className={`${STATE_LINE_CLASS} inline-flex shrink-0 items-center gap-1`} data-nucleus-task-group-repository="">
        <Icon name="Folder" className="size-3" aria-hidden />
        <span className="truncate">{group.repository}</span>
      </span>
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
 * One project's nested-elsewhere work, grouped by the thread it nests under.
 * `count` is how many tasks (or, for a thread the read does not name as a Nucleus
 * task, how many threads) of this project sit under that parent, `parentTitle` is
 * the parent row's own display title (the planner a Nucleus task nests under), and
 * `href` is the app route of that parent, so the pointer opens the nested group.
 */
export interface NestedTaskPointer {
  /** The parent thread's id: one pointer per planner row. */
  key: string;
  count: number;
  parentTitle: string;
  href: string;
}

/**
 * nucleus#1313: the threads that belong to `projectId` but are drawn under another
 * project's row, because their parent chain resolves there. The sidebar attributes a
 * nested thread to its root ancestor's project (`resolveSidebarProjectId`), so a
 * task whose planner lives in another project leaves its own project looking empty.
 * A thread whose parent is not in the list is not a pointer: there is no row to
 * point at, and upstream's empty state is the honest answer.
 */
export function nestedTaskPointers(
  projectId: string | null | undefined,
  threads: readonly SidebarThread[],
  taskEnvironmentIds: ReadonlySet<string> = new Set(),
): NestedTaskPointer[] {
  if (!projectId) return [];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const pointers = new Map<string, { pointer: NestedTaskPointer; tasks: Set<string> }>();
  for (const thread of threads) {
    if (thread.projectId !== projectId || thread.isHidden) continue;
    if (resolveSidebarProjectId(thread, byId) === projectId) continue;
    const parent = thread.parentThreadId === null ? null : byId.get(thread.parentThreadId) ?? null;
    if (parent === null) continue;
    // Every role thread of one task shares its environment, which the batched read
    // names: the pointer counts the task once, however many of its threads nest here.
    const environmentId = thread.environment?.id ?? null;
    const identity = environmentId !== null && taskEnvironmentIds.has(environmentId) ? environmentId : thread.id;
    const entry = pointers.get(parent.id);
    if (entry === undefined) {
      pointers.set(parent.id, {
        pointer: { key: parent.id, count: 0, parentTitle: parent.displayTitle, href: parent.href },
        tasks: new Set([identity]),
      });
    } else {
      entry.tasks.add(identity);
    }
  }
  return [...pointers.values()]
    .map(({ pointer, tasks }) => ({ ...pointer, count: tasks.size }))
    .sort((left, right) =>
      left.parentTitle.localeCompare(right.parentTitle) || left.key.localeCompare(right.key),
    );
}

/** The same read, from the live sidebar data: `[]` outside a host-backed list. */
export function useNucleusNestedTaskPointers(projectId: string | null | undefined): NestedTaskPointer[] {
  const { projects } = useSidebarData();
  const taskGroups = useContext(NucleusTaskGroupsContext)?.groups;
  return useMemo(() => {
    if (!projectId) return [];
    return nestedTaskPointers(
      projectId,
      projects.flatMap((project) => project.threads),
      new Set(taskGroups?.keys() ?? []),
    );
  }, [projectId, projects, taskGroups]);
}

/** `1 task under <planner>` / `3 tasks under <planner>`. */
export function nestedTaskPointerLabel(pointer: NestedTaskPointer): string {
  return `${pointer.count} task${pointer.count === 1 ? "" : "s"} under ${pointer.parentTitle}`;
}

/**
 * A project's compact pointer list: one row per parent its threads nest under. It
 * is a plain anchor on the parent's own app route, so the host routes the click and
 * middle-click, copy-link and open-in-new-window keep working.
 */
export function NucleusNestedTaskPointers({ pointers }: { pointers: readonly NestedTaskPointer[] }) {
  if (pointers.length === 0) return null;
  return (
    <div data-nucleus-nested-task-pointers="" className="flex flex-col gap-0.5 px-2 py-1">
      {pointers.map((pointer) => (
        <a
          key={pointer.key}
          href={pointer.href}
          data-nucleus-nested-task-pointer={pointer.key}
          title={nestedTaskPointerLabel(pointer)}
          className="min-w-0 truncate rounded-sm text-[11px] leading-4 text-subtle-foreground hover:text-foreground"
        >
          {nestedTaskPointerLabel(pointer)}
        </a>
      ))}
    </div>
  );
}

/**
 * A Nucleus task group's own actions, in place of upstream's environment actions
 * (nucleus#1313, Tom 2026-11-17: "Can we get rid of it?"). The three upstream
 * actions are wrong for a task container: a new thread would add a participant
 * Nucleus does not know about, Edit renames an environment the header no longer
 * shows, and Archive would archive live role threads behind Nucleus's back. Instead
 * the menu opens the task, opens its pull request when it has one, and detaches the
 * group from its planner through the service's own `detach` owner control.
 */
export function NucleusTaskGroupMenuItems({ group, taskHref, surface }: {
  group: SidebarGroup;
  /** The representative role thread's app route: where the task-detail tab lives. */
  taskHref: string;
  surface: ActionMenuSurface;
}) {
  const rpc = useRpc<typeof sidebarTaskActionContract>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detach = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("detachTask", { taskId: group.taskId, reason: "Detached from the BB sidebar" });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ActionMenuItem surface={surface} icon="PanelRightOpen" href={taskHref}>
        Open task
      </ActionMenuItem>
      {group.prUrl === null ? null : (
        <ActionMenuItem surface={surface} icon="GitPullRequest" href={group.prUrl}>
          Open pull request
        </ActionMenuItem>
      )}
      <ActionMenuItem
        surface={surface}
        icon="Unlink"
        disabled={busy}
        onSelect={(event) => {
          event.preventDefault();
          void detach();
        }}
      >
        Detach from planner
      </ActionMenuItem>
      {error === null ? null : (
        <div role="alert" data-nucleus-task-group-action-error="" className="px-2 py-1 text-[11px] leading-4 text-destructive">
          {error}
        </div>
      )}
    </>
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
