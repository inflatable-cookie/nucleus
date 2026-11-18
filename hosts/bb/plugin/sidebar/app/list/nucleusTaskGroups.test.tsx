// @vitest-environment jsdom
/**
 * Spec 062, phase 5 acceptance (decision 5a/5b): the forked sidebar's Nucleus task
 * group header and its collapse preference.
 *
 * These are the fork's own tests, in the fork's own runner: they mount the real
 * `ProjectRow` under the SDK test runtime, so the header, the preference sync, the
 * RPC read and the realtime signal are the ones the app runs, not a stand-in.
 */
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider, createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginRpcTestHandlers,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { SidebarRenameProvider } from "../rows/SidebarInlineRename.js";
import { ThreadRowNavigationProvider } from "../rows/threadRowNavigation.js";
import { SidebarDraftPresenceSync } from "./sidebarDraftPresence.js";
import { PreferencesSync } from "../preferences/PreferencesSync.js";
import {
  attachPreferencesStore,
  hydratePreferences,
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "../preferences/preferences-sync.js";
import {
  defaultPreferences,
  type PreferenceValues,
} from "../../shared/preferences.js";
import {
  makeSidebarEnvironment,
  makeSidebarProject,
  makeSidebarThread,
} from "../model/fixtures.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { sidebarOrganizationModeAtom } from "../preferences/atoms.js";
import type { SidebarGroups } from "../../../sidebar-groups.js";
import { NucleusSidebarGroupsProvider } from "./nucleusTaskGroups.js";

installTestPluginRuntime();
const { ProjectRow } = await import("./ProjectRow.js");

const NUCLEUS_ENVIRONMENT = "env_nucleus_task";
const SECOND_NUCLEUS_ENVIRONMENT = "env_nucleus_task_2";
const UPSTREAM_ENVIRONMENT = "env_upstream_worktree";

const GROUP: SidebarGroups["groups"][number] = {
  environmentId: NUCLEUS_ENVIRONMENT,
  taskId: "task_1296",
  number: 1296,
  reference: "nucleus#1296",
  repository: "nucleus",
  title: "BB host phase 5",
  phase: "awaiting_review",
  phaseLabel: "Review",
  stateLabel: "Reviewing",
  waitLabel: "Waiting for QA capacity (position 2)",
  prNumber: 191,
  prState: "OPEN",
  prUrl: "https://example.invalid/nucleus/pull/191",
  attention: false,
  held: false,
  stop: null,
};

const SECOND_GROUP: SidebarGroups["groups"][number] = {
  ...GROUP,
  environmentId: SECOND_NUCLEUS_ENVIRONMENT,
  taskId: "task_1297",
  number: 1297,
  reference: "nucleus#1297",
  title: "BB host phase 6",
  phase: "merging",
  phaseLabel: "Merging",
  stateLabel: "Merging",
  waitLabel: null,
  prNumber: 192,
  prState: "MERGED",
};

function environmentThread({
  id,
  title,
  environmentId,
  originPluginId,
  parentThreadId = null,
  hasPendingInteraction = false,
  runtimeStatus = "idle",
  isUnread,
}: {
  id: string;
  title: string;
  environmentId: string;
  originPluginId: string | null;
  parentThreadId?: string | null;
  hasPendingInteraction?: boolean;
  runtimeStatus?: SidebarThread["runtimeStatus"];
  isUnread?: boolean;
}): SidebarThread {
  return makeSidebarThread({
    id,
    title,
    titleFallback: title,
    projectId: "proj_test",
    parentThreadId,
    hasPendingInteraction,
    runtimeStatus,
    ...(isUnread === undefined ? {} : { isUnread }),
    originPluginId,
    environment: makeSidebarEnvironment({
      id: environmentId,
      name: environmentId,
      isWorktree: true,
    }),
  });
}

/**
 * Two Nucleus task groups (a worker and a reviewer in one worktree, as a real task
 * runs them under a planner in another project) and one upstream worktree group.
 * A group forms from two or more top-level threads sharing a worktree environment,
 * which is why each group has two.
 */
const THREADS: SidebarThread[] = [
  environmentThread({
    id: "thr_nucleus_worker",
    title: "Nucleus worker",
    environmentId: NUCLEUS_ENVIRONMENT,
    originPluginId: "nucleus",
  }),
  environmentThread({
    id: "thr_nucleus_reviewer",
    title: "Nucleus reviewer",
    environmentId: NUCLEUS_ENVIRONMENT,
    originPluginId: "nucleus",
    // A hidden thread the host's roll-up resolves: the collapsed header keeps
    // upstream's agent glyph for it.
    hasPendingInteraction: true,
  }),
  environmentThread({
    id: "thr_second_worker",
    title: "Second task worker",
    environmentId: SECOND_NUCLEUS_ENVIRONMENT,
    originPluginId: "nucleus",
  }),
  environmentThread({
    id: "thr_second_reviewer",
    title: "Second task reviewer",
    environmentId: SECOND_NUCLEUS_ENVIRONMENT,
    originPluginId: "nucleus",
  }),
  environmentThread({
    id: "thr_upstream_worker",
    title: "Upstream worker",
    environmentId: UPSTREAM_ENVIRONMENT,
    originPluginId: null,
  }),
  environmentThread({
    id: "thr_upstream_other",
    title: "Upstream other",
    environmentId: UPSTREAM_ENVIRONMENT,
    originPluginId: null,
  }),
];

interface HarnessProps {
  children: ReactNode;
  store: ReturnType<typeof createStore>;
}

function Harness({ children, store }: HarnessProps) {
  return (
    <TooltipProvider>
      <SidebarDraftPresenceSync />
      <PreferencesSync />
      <Provider store={store}>
        <ThreadRowNavigationProvider>
          <SidebarRenameProvider>{children}</SidebarRenameProvider>
        </ThreadRowNavigationProvider>
      </Provider>
    </TooltipProvider>
  );
}

/** The fork's own defaults, with the one preference a test needs overridden. */
function preferenceValues(
  overrides: Partial<PreferenceValues> = {},
): PreferenceValues {
  return { ...defaultPreferences(), ...overrides };
}

interface RenderOptions {
  /** The store a test hydrated before mounting, so the mount sees those values. */
  store?: ReturnType<typeof createStore>;
  groups?: ReadonlyArray<SidebarGroups["groups"][number]>;
  /** Omit the handler entirely: the read fails, as it does with the service away. */
  failRead?: boolean;
  projects?: ReadonlyArray<SidebarGroups["projects"][number]>;
  onSetPreference?: (key: string, value: unknown) => void;
  /** The project row under test. */
  project?: ReturnType<typeof makeSidebarProject>;
  /** What that row's own tree is given (the resolved project's threads). */
  threadListState?: { status: "ready"; threads: SidebarThread[] };
  /** Every thread the live sidebar data carries, across projects. */
  allThreads?: SidebarThread[];
}

function renderTaskGroups(options: RenderOptions = {}): {
  slot: RenderedSlot;
  store: ReturnType<typeof createStore>;
} {
  const store = options.store ?? createStore();
  store.set(sidebarOrganizationModeAtom, "project");
  const rpc: PluginRpcTestHandlers<never> = {
    listPreferences: async () => ({ preferences: preferenceValues }),
    setPreference: async (input: never) => {
      const { key, value } = input as unknown as {
        key: string;
        value: unknown;
      };
      options.onSetPreference?.(key, value);
      return { key, value } as never;
    },
    resetPreference: async (input: never) => input as never,
  } as unknown as PluginRpcTestHandlers<never>;
  if (options.failRead !== true) {
    (rpc as unknown as Record<string, unknown>).sidebarGroups = async () => ({
      groups: options.groups ?? [GROUP],
      threads: [],
      projects: options.projects ?? [],
    });
  }
  const project = options.project ?? makeSidebarProject({ id: "proj_test" });
  const allThreads = options.allThreads ?? THREADS;
  const slot = renderSlot(
    { component: Harness },
    {
      store,
      children: (
        <NucleusSidebarGroupsProvider>
          <ProjectRow
            project={project}
            threadListState={
              options.threadListState ?? { status: "ready", threads: THREADS }
            }
            isActive={false}
            isCollapsed={false}
            compareThreads={() => 0}
            collapsedThreadIds={new Set()}
            collapsedEnvironmentIds={new Set([UPSTREAM_ENVIRONMENT])}
            onToggleProjectCollapsed={vi.fn()}
            onToggleThreadCollapsed={vi.fn()}
            onToggleEnvironmentCollapsed={vi.fn()}
          />
        </NucleusSidebarGroupsProvider>
      ),
    },
    {
      rpc: rpc as never,
      pluginId: "nucleus",
      sidebarThreads: {
        threads: allThreads,
        // Every project a thread names is in the live view; the row under test is
        // the one this harness parameterises.
        projects: [
          ...new Map(
            [
              makeSidebarProject({ id: "proj_test" }),
              project,
              ...allThreads.map((thread) =>
                makeSidebarProject({
                  id: thread.projectId,
                  name:
                    thread.projectId === "proj_personal"
                      ? "Personal"
                      : thread.projectId,
                  isPersonal: thread.projectId === "proj_personal",
                }),
              ),
            ].map((entry) => [entry.id, entry]),
          ).values(),
        ],
      },
    },
  );
  return { slot, store };
}

function taskGroupHeader(environmentId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-nucleus-task-group][data-nucleus-task-group-environment="${environmentId}"]`,
  );
}

/** The whole group row: what carries the drag bindings and the rename anchor. */
function taskGroupRow(environmentId: string): HTMLElement {
  return taskGroupHeader(environmentId)!.closest<HTMLElement>(
    "[data-sidebar-rename-row]",
  )!;
}

/** The block holding a task container's title, state line and chevron. */
function nameBlock(environmentId: string): HTMLElement {
  return taskGroupHeader(environmentId)!.parentElement!;
}

/** The row's leading icon slot: the folder, or the rolled-up status glyph. */
function leadingSlot(environmentId: string): HTMLElement {
  return nameBlock(environmentId).previousElementSibling as HTMLElement;
}

/** The upstream-style group header for an environment, found by its rendered name. */
function upstreamHeaderByEnvironment(environmentId: string): HTMLElement {
  const match = screen
    .getAllByText(environmentId)
    .map((element) => element.closest<HTMLElement>("[data-sidebar-rename-row]"))
    .find((element): element is HTMLElement => element !== null);
  if (!match) throw new Error(`no group header carries ${environmentId}`);
  return match;
}

afterEach(() => {
  cleanup();
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(null);
});

describe("a Nucleus task group's header", () => {
  it("renders collapsed by default with the task number, its title, the shared state label and its pull request", async () => {
    renderTaskGroups({ groups: [GROUP, SECOND_GROUP] });
    await waitFor(() => {
      expect(taskGroupHeader(NUCLEUS_ENVIRONMENT)).not.toBeNull();
    });
    const header = taskGroupHeader(NUCLEUS_ENVIRONMENT)!;
    expect(header.textContent).toContain("#1296 BB host phase 5");
    // The second task group draws its own line from the same one read.
    expect(taskGroupHeader(SECOND_NUCLEUS_ENVIRONMENT)!.textContent).toContain(
      "#1297 BB host phase 6",
    );
    expect(
      header.querySelector("[data-nucleus-task-group-state-label]")
        ?.textContent,
    ).toBe("Reviewing");
    expect(
      header.querySelector("[data-nucleus-task-group-wait]")?.textContent,
    ).toBe("Waiting for QA capacity (position 2)");
    // The PR chip is the state icon plus `#191`; the state rides the label.
    const pullRequest = header.querySelector("[data-nucleus-task-group-pr]");
    expect(pullRequest?.textContent).toBe("#191");
    expect(pullRequest?.getAttribute("aria-label")).toBe(
      "Pull request #191, open",
    );
    // Collapsed by default, with no `collapsedEnvironments` entry: the fork's own
    // preference decides, so the two group classes cannot disagree.
    expect(header.getAttribute("data-nucleus-task-group-collapsed")).toBe(
      "true",
    );
    // The collapsed roll-up is the host's own: `experimental_resolveThreadStatus`
    // over the hidden threads names the indicator, and upstream's glyph draws it
    // in the leading icon slot (nucleus#1336).
    expect(
      leadingSlot(NUCLEUS_ENVIRONMENT).querySelector(
        '[data-thread-status-glyph="waiting-for-input"]',
      ),
    ).not.toBeNull();
  });

  it("draws upstream's header, with no state line and no read, on every other group", async () => {
    const { slot } = renderTaskGroups();
    await waitFor(() => {
      expect(taskGroupHeader(NUCLEUS_ENVIRONMENT)).not.toBeNull();
    });
    const upstream = upstreamHeaderByEnvironment(UPSTREAM_ENVIRONMENT);
    expect(upstream.querySelector("[data-nucleus-task-group]")).toBeNull();
    // One read for the whole list, never one per group.
    expect(
      slot.rpcCalls.filter((call) => call.method === "sidebarGroups"),
    ).toHaveLength(1);
    expect(upstream.textContent).toContain(UPSTREAM_ENVIRONMENT);
    // The upstream group is expanded exactly as upstream decides: it is in no
    // `collapsedEnvironments` entry and has no state line of ours.
    expect(upstream.textContent).not.toContain("Reviewing");
  });

  it("reads every group in one call, refetches on the board signal, and reads nothing per group", async () => {
    const { slot } = renderTaskGroups({ groups: [GROUP, SECOND_GROUP] });
    await waitFor(() => {
      expect(taskGroupHeader(SECOND_NUCLEUS_ENVIRONMENT)).not.toBeNull();
    });
    expect(
      slot.rpcCalls.filter((call) => call.method === "sidebarGroups"),
    ).toHaveLength(1);
    await slot.emitRealtime("nucleus.board-signal", { revision: 7 });
    await waitFor(() => {
      expect(
        slot.rpcCalls.filter((call) => call.method === "sidebarGroups"),
      ).toHaveLength(2);
    });
  });

  it("persists an explicit expand in expandedTaskGroups and never writes collapsedEnvironments for a task group", async () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    renderTaskGroups({
      onSetPreference: (key, value) => writes.push({ key, value }),
    });
    await waitFor(() => {
      expect(taskGroupHeader(NUCLEUS_ENVIRONMENT)).not.toBeNull();
    });
    expect(
      taskGroupHeader(NUCLEUS_ENVIRONMENT)!.getAttribute(
        "data-nucleus-task-group-collapsed",
      ),
    ).toBe("true");
    const expand = taskGroupRow(NUCLEUS_ENVIRONMENT).querySelector<HTMLElement>(
      '[aria-label^="Expand "]',
    );
    expect(expand).not.toBeNull();
    fireEvent.click(expand!);
    await waitFor(() => {
      expect(writes.some((write) => write.key === "expandedTaskGroups")).toBe(
        true,
      );
    });
    expect(
      writes.find((write) => write.key === "expandedTaskGroups")?.value,
    ).toEqual([NUCLEUS_ENVIRONMENT]);
    // `collapsedEnvironments` is never written for a task group: the two group
    // classes each read exactly one preference.
    expect(
      writes.filter((write) => write.key === "collapsedEnvironments"),
    ).toEqual([]);
    await waitFor(() => {
      expect(
        taskGroupHeader(NUCLEUS_ENVIRONMENT)!.getAttribute(
          "data-nucleus-task-group-collapsed",
        ),
      ).toBe("false");
    });
  });

  it("starts a fresh mount expanded when expandedTaskGroups is stored", async () => {
    // The stored preference is hydrated before the mount, as it is on app start.
    resetPreferencesSyncForTest();
    setPreferencesMirrorStorageForTest(null);
    const store = createStore();
    attachPreferencesStore(store, "nucleus");
    await hydratePreferences({
      call: async (method: string) =>
        method === "listPreferences"
          ? {
              preferences: preferenceValues({
                expandedTaskGroups: [NUCLEUS_ENVIRONMENT],
              }),
            }
          : { key: "expandedTaskGroups", value: [] },
    });
    renderTaskGroups({ store });
    await waitFor(() => {
      expect(taskGroupHeader(NUCLEUS_ENVIRONMENT)).not.toBeNull();
    });
    expect(
      taskGroupHeader(NUCLEUS_ENVIRONMENT)!.getAttribute(
        "data-nucleus-task-group-collapsed",
      ),
    ).toBe("false");
  });

  it("renders upstream's header while the read has not landed, and when it fails", async () => {
    const { slot } = renderTaskGroups({ failRead: true });
    await waitFor(() => {
      expect(upstreamHeaderByEnvironment(NUCLEUS_ENVIRONMENT)).not.toBeNull();
    });
    expect(taskGroupHeader(NUCLEUS_ENVIRONMENT)).toBeNull();
    expect(
      slot.rpcCalls.filter((call) => call.method === "sidebarGroups"),
    ).toHaveLength(1);
    // The list drew regardless: a failed read never blocks or blanks the sidebar.
    expect(
      upstreamHeaderByEnvironment(UPSTREAM_ENVIRONMENT).textContent,
    ).toContain(UPSTREAM_ENVIRONMENT);
  });
});

describe("a project row's board link (phase 6, decision 5d)", () => {
  it("adds one Board item linking to the Nucleus project's board when the read names this BB project", async () => {
    renderTaskGroups({
      projects: [
        {
          key: "synthetic",
          name: "Synthetic",
          repositoryPaths: ["/synthetic/repo"],
          threadIds: ["thr_planner"],
          bbProjectIds: ["proj_other", "proj_test"],
        },
      ],
    });
    await waitFor(() => {
      expect(taskGroupHeader(NUCLEUS_ENVIRONMENT)).not.toBeNull();
    });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Test project actions" }),
      { button: 0 },
    );
    const board = await screen.findByRole("menuitem", { name: "Board" });
    // The route key is the Nucleus project key, never the BB project id.
    expect(board.getAttribute("href")).toBe(
      "/plugins/nucleus/board/project/synthetic",
    );
    expect(screen.getAllByRole("menuitem", { name: "Board" })).toHaveLength(1);
  });

  it("leaves a project row the read does not name with upstream's menu", async () => {
    renderTaskGroups({
      projects: [
        {
          key: "elsewhere",
          name: "Elsewhere",
          repositoryPaths: ["/synthetic/elsewhere"],
          threadIds: [],
          bbProjectIds: ["proj_other"],
        },
      ],
    });
    await waitFor(() => {
      expect(taskGroupHeader(NUCLEUS_ENVIRONMENT)).not.toBeNull();
    });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Test project actions" }),
      { button: 0 },
    );
    await screen.findByRole("menuitem", { name: "Project settings" });
    expect(screen.queryByRole("menuitem", { name: "Board" })).toBeNull();
  });
});

/**
 * nucleus#1313 (Tom, 2026-11-17, poodle-lab#029): a task whose planner lives in
 * another project resolves to that project's section (`resolveSidebarProjectId`
 * walks the parent chain), so its own project showed upstream's "No threads" over
 * a live task. The rows below are the live trial's shape: a worker in the task's
 * project, nested under a planner thread in Tom's Personal project.
 */
describe("a project whose task nests under a planner in another project", () => {
  const TASK_PROJECT = makeSidebarProject({
    id: "proj_poodle_lab",
    name: "poodle-lab",
  });
  const TASK_ENVIRONMENT = "env_poodle_task";
  const SECOND_TASK_ENVIRONMENT = "env_poodle_task_2";
  const planner = makeSidebarThread({
    id: "thr_personal_planner",
    projectId: "proj_personal",
    title: "Tom's Personal planner",
    titleFallback: "Planner",
    latestAttentionAt: 5,
  });
  const taskThread = (id: string, title: string, environmentId: string) =>
    makeSidebarThread({
      id,
      projectId: "proj_poodle_lab",
      title,
      titleFallback: title,
      parentThreadId: "thr_personal_planner",
      originPluginId: "nucleus",
      environment: makeSidebarEnvironment({
        id: environmentId,
        name: environmentId,
        isWorktree: true,
      }),
      latestAttentionAt: 6,
    });
  const worker = taskThread(
    "thr_poodle_worker",
    "#1313 BB presentation",
    TASK_ENVIRONMENT,
  );
  const reviewer = taskThread(
    "thr_poodle_reviewer",
    "1313 reviewer",
    TASK_ENVIRONMENT,
  );
  const secondWorker = taskThread(
    "thr_poodle_second",
    "#1314 Second task",
    SECOND_TASK_ENVIRONMENT,
  );

  /** The batched read names both task environments, as the service does for live tasks. */
  const TASK_GROUPS = [GROUP, SECOND_GROUP].map((group, index) => ({
    ...group,
    environmentId: index === 0 ? TASK_ENVIRONMENT : SECOND_TASK_ENVIRONMENT,
  }));

  it("shows a compact pointer to the planner instead of upstream's 'No threads'", async () => {
    renderTaskGroups({
      project: TASK_PROJECT,
      allThreads: [planner, worker],
      threadListState: { status: "ready", threads: [] },
      groups: TASK_GROUPS,
    });
    const pointer = await screen.findByText(
      "1 task under Tom's Personal planner",
    );
    expect(screen.queryByText("No threads")).toBeNull();
    // The pointer is the planner's own app route, so the host routes the click.
    const anchor = pointer.closest("a");
    expect(anchor?.getAttribute("href")).toBe(
      "/projects/proj_personal/threads/thr_personal_planner",
    );
    expect(
      document.querySelectorAll("[data-nucleus-nested-task-pointer]"),
    ).toHaveLength(1);
  });

  it("counts one task once however many of its role threads nest under the planner", async () => {
    renderTaskGroups({
      project: TASK_PROJECT,
      allThreads: [planner, worker, reviewer],
      threadListState: { status: "ready", threads: [] },
      groups: TASK_GROUPS,
    });
    expect(
      await screen.findByText("1 task under Tom's Personal planner"),
    ).not.toBeNull();
  });

  it("counts two tasks under the same planner as two", async () => {
    renderTaskGroups({
      project: TASK_PROJECT,
      allThreads: [planner, worker, secondWorker],
      threadListState: { status: "ready", threads: [] },
      groups: TASK_GROUPS,
    });
    expect(
      await screen.findByText("2 tasks under Tom's Personal planner"),
    ).not.toBeNull();
    expect(screen.queryByText("No threads")).toBeNull();
  });

  it("keeps upstream's empty state for a project with no threads anywhere", async () => {
    renderTaskGroups({
      project: TASK_PROJECT,
      allThreads: [planner],
      threadListState: { status: "ready", threads: [] },
      groups: [],
    });
    expect(await screen.findByText("No threads")).not.toBeNull();
    expect(
      document.querySelector("[data-nucleus-nested-task-pointer]"),
    ).toBeNull();
  });

  it("draws a project's own root thread as a row, never as a pointer", async () => {
    const root = makeSidebarThread({
      id: "thr_poodle_root",
      projectId: "proj_poodle_lab",
      title: "poodle-lab chat",
      latestAttentionAt: 9,
    });
    renderTaskGroups({
      project: TASK_PROJECT,
      allThreads: [planner, worker, root],
      threadListState: { status: "ready", threads: [root] },
      groups: TASK_GROUPS,
    });
    expect(await screen.findByText("poodle-lab chat")).not.toBeNull();
    expect(
      document.querySelector("[data-nucleus-nested-task-pointer]"),
    ).toBeNull();
    expect(screen.queryByText("No threads")).toBeNull();
  });
});

/**
 * nucleus#1313 (Tom, 2026-11-17, live trial poodle-lab#029): the container says what
 * repository the task works on, its PR is the standard icon plus `#39` in the state
 * colour, and the row title and state take the freed menu width.
 */
describe("a task container's repository, PR chip and row width", () => {
  it("leads the state line with the folder icon and the repository", async () => {
    renderTaskGroups({ groups: [{ ...GROUP, repository: "poodle-lab" }] });
    const repository = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        "[data-nucleus-task-group-repository]",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(repository.textContent).toBe("poodle-lab");
    expect(repository.querySelector('[data-icon="Folder"]')).not.toBeNull();
    // The chip keeps the PR state in the label, not in visible text.
    const chip = document.querySelector<HTMLElement>(
      "[data-nucleus-task-group-pr]",
    )!;
    expect(chip.textContent).toBe("#191");
  });

  it("draws the PR as the state icon and #39 with the state in the label, never as text", async () => {
    renderTaskGroups({ groups: [GROUP] });
    const chip = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        "[data-nucleus-task-group-pr]",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(chip.textContent).toBe("#191");
    expect(chip.textContent).not.toContain("OPEN");
    expect(chip.querySelector('[data-icon="GitPullRequest"]')).not.toBeNull();
    expect(chip.getAttribute("data-nucleus-task-group-pr-tone")).toBe(
      "success",
    );
    expect(chip.getAttribute("aria-label")).toBe("Pull request #191, open");
  });

  it("uses the merged glyph and the merged tone, and the closed one for closed", async () => {
    renderTaskGroups({ groups: [{ ...GROUP, prState: "MERGED" }] });
    const merged = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        "[data-nucleus-task-group-pr]",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(merged.querySelector('[data-icon="GitMerge"]')).not.toBeNull();
    expect(merged.getAttribute("data-nucleus-task-group-pr-tone")).toBe(
      "accent",
    );

    cleanup();
    renderTaskGroups({ groups: [{ ...GROUP, prState: "CLOSED" }] });
    const closed = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        "[data-nucleus-task-group-pr]",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(
      closed.querySelector('[data-icon="GitPullRequestClosed"]'),
    ).not.toBeNull();
    expect(closed.getAttribute("data-nucleus-task-group-pr-tone")).toBe(
      "danger",
    );
  });

  it("removes the task container menu and gives the title and state line the row width", async () => {
    renderTaskGroups({ groups: [GROUP] });
    await waitFor(() => {
      expect(taskGroupHeader(NUCLEUS_ENVIRONMENT)).not.toBeNull();
    });
    // The task row no longer reserves the action area left by its removed menu.
    const container = taskGroupRow(NUCLEUS_ENVIRONMENT);
    expect(
      within(container).queryByRole("button", {
        name: "New thread in environment",
      }),
    ).toBeNull();
    expect(
      within(container).queryByRole("button", { name: "Environment actions" }),
    ).toBeNull();
    expect(
      within(container).queryByRole("button", { name: "Task actions" }),
    ).toBeNull();
    expect(within(container).queryByRole("menu")).toBeNull();
    // No hover-actions slot is rendered, so nothing reserves width beside the name
    // block; the only hover-revealed control is the chevron inside it (nucleus#1336).
    const hoverRevealed = [
      ...container.querySelectorAll("[data-sidebar-hover-actions-mobile]"),
    ];
    expect(hoverRevealed).toHaveLength(1);
    expect(hoverRevealed[0]!.getAttribute("aria-label")).toMatch(
      /^Expand .* threads$/,
    );
    const nameBlock = container.querySelector<HTMLElement>(
      "[data-nucleus-task-group]",
    );
    expect(nameBlock).not.toBeNull();
    expect(nameBlock!.className).toContain("flex-1");
    expect(nameBlock!.className).toContain("min-w-0");
    expect(
      nameBlock!.querySelector<HTMLElement>("[data-nucleus-task-group-state]")!
        .className,
    ).toContain("min-w-0");
    // nucleus#1336: the collapsed container's roll-up (this fixture has a thread
    // waiting for input) moves into the leading slot, so the row grows no trailing
    // slot for it: the name block is the row's last element and the title keeps
    // the width #1323 reclaimed.
    expect(
      leadingSlot(NUCLEUS_ENVIRONMENT).getAttribute(
        "data-nucleus-task-group-status",
      ),
    ).toBe("waiting-for-input");
    expect(nameBlock!.parentElement!.nextElementSibling).toBeNull();
    expect(
      container.querySelectorAll("[data-thread-status-glyph]"),
    ).toHaveLength(1);
  });

  it("leaves an ordinary worktree group with upstream's actions", async () => {
    renderTaskGroups({ groups: [] });
    await waitFor(() => {
      expect(upstreamHeaderByEnvironment(UPSTREAM_ENVIRONMENT)).not.toBeNull();
    });
    // Upstream's new-thread control is present on the ordinary group, and its own
    // environment menu keeps Rename and Archive.
    const ordinary = upstreamHeaderByEnvironment(UPSTREAM_ENVIRONMENT);
    // The hover-actions slot the task container no longer renders is upstream's own.
    expect(
      ordinary.querySelector("[data-sidebar-hover-actions-mobile]"),
    ).not.toBeNull();
    expect(
      within(ordinary).getByRole("button", {
        name: "New thread in environment",
      }),
    ).not.toBeNull();
    fireEvent.pointerDown(
      within(ordinary).getByRole("button", { name: "Environment actions" }),
      { button: 0 },
    );
    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Archive" })).not.toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Detach from planner" }),
    ).toBeNull();
  });
});

/**
 * nucleus#1336 (Tom, 2026-11-18): the collapsed container's status glyph and its
 * reveal chevron shared the trailing slot and overlapped. The status takes the
 * leading icon instead, and the trailing slot holds only the hover chevron.
 */
describe("a task container's status in the leading icon", () => {
  function threadsWith(nucleus: {
    runtimeStatus?: SidebarThread["runtimeStatus"];
    hasPendingInteraction?: boolean;
  }): SidebarThread[] {
    return [
      environmentThread({
        id: "thr_nucleus_worker",
        title: "Nucleus worker",
        environmentId: NUCLEUS_ENVIRONMENT,
        originPluginId: "nucleus",
        runtimeStatus: nucleus.runtimeStatus,
        isUnread: false,
      }),
      environmentThread({
        id: "thr_nucleus_reviewer",
        title: "Nucleus reviewer",
        environmentId: NUCLEUS_ENVIRONMENT,
        originPluginId: "nucleus",
        hasPendingInteraction: nucleus.hasPendingInteraction,
        isUnread: false,
      }),
      environmentThread({
        id: "thr_upstream_worker",
        title: "Upstream worker",
        environmentId: UPSTREAM_ENVIRONMENT,
        originPluginId: null,
        runtimeStatus: "active",
      }),
      environmentThread({
        id: "thr_upstream_other",
        title: "Upstream other",
        environmentId: UPSTREAM_ENVIRONMENT,
        originPluginId: null,
      }),
    ];
  }

  function renderWith(threads: SidebarThread[], groups = [GROUP]) {
    renderTaskGroups({
      groups,
      threadListState: { status: "ready", threads },
      allThreads: threads,
    });
  }

  async function collapsedContainer(): Promise<HTMLElement> {
    return waitFor(() => {
      const header = taskGroupHeader(NUCLEUS_ENVIRONMENT);
      expect(header).not.toBeNull();
      expect(header!.getAttribute("data-nucleus-task-group-collapsed")).toBe(
        "true",
      );
      return taskGroupRow(NUCLEUS_ENVIRONMENT);
    });
  }

  it("draws the spinner in the leading slot while a participant works, with nothing status-like trailing", async () => {
    renderWith(threadsWith({ runtimeStatus: "active" }));
    const row = await collapsedContainer();
    const leading = leadingSlot(NUCLEUS_ENVIRONMENT);
    expect(leading.getAttribute("data-nucleus-task-group-status")).toBe(
      "runtime",
    );
    expect(
      leading.querySelector('[data-thread-status-glyph="runtime"]'),
    ).not.toBeNull();
    // The folder gives way to the glyph rather than sitting beside it.
    expect(leading.querySelector("[data-icon]")).toBeNull();
    // The only status glyph on the row is the leading one, and nothing follows the
    // name block, whose last control is the chevron.
    expect(row.querySelectorAll("[data-thread-status-glyph]")).toHaveLength(1);
    expect(nameBlock(NUCLEUS_ENVIRONMENT).nextElementSibling).toBeNull();
    const chevron = within(row).getByRole("button", {
      name: /^Expand .* threads$/,
    });
    expect(nameBlock(NUCLEUS_ENVIRONMENT).lastElementChild).toBe(chevron);
  });

  it("keeps an accessible status label when the glyph replaces the folder", async () => {
    renderWith(threadsWith({ runtimeStatus: "active" }));
    const row = await collapsedContainer();
    const status = within(row).getByRole("img", { name: "Thread working" });
    expect(status).toBe(leadingSlot(NUCLEUS_ENVIRONMENT));
    expect(status.getAttribute("aria-hidden")).toBeNull();
  });

  it("draws the needs-you glyph in the leading slot when a participant waits for the operator", async () => {
    // Attention outranks work, as on thread rows.
    renderWith(
      threadsWith({ runtimeStatus: "active", hasPendingInteraction: true }),
    );
    const row = await collapsedContainer();
    const leading = leadingSlot(NUCLEUS_ENVIRONMENT);
    expect(leading.getAttribute("data-nucleus-task-group-status")).toBe(
      "waiting-for-input",
    );
    expect(
      leading.querySelector('[data-thread-status-glyph="waiting-for-input"]'),
    ).not.toBeNull();
    expect(
      within(row).getByRole("img", { name: "Thread needs user input" }),
    ).toBe(leading);
  });

  it("draws the needs-you glyph when Nucleus marks the task for attention while every thread is idle", async () => {
    // e.g. an escalated resolution: no thread has a pending interaction.
    renderWith(threadsWith({}), [{ ...GROUP, attention: true }]);
    const row = await collapsedContainer();
    const leading = leadingSlot(NUCLEUS_ENVIRONMENT);
    expect(leading.getAttribute("data-nucleus-task-group-status")).toBe(
      "waiting-for-input",
    );
    expect(
      leading.querySelector('[data-thread-status-glyph="waiting-for-input"]'),
    ).not.toBeNull();
    expect(leading.querySelector("[data-icon]")).toBeNull();
    expect(
      within(row).getByRole("img", { name: "Task needs your attention" }),
    ).toBe(leading);
    expect(row.querySelectorAll("[data-thread-status-glyph]")).toHaveLength(1);
  });

  it("toggles when the row body is clicked, not only the chevron", async () => {
    const writes: unknown[] = [];
    renderTaskGroups({
      groups: [GROUP],
      threadListState: { status: "ready", threads: threadsWith({}) },
      allThreads: threadsWith({}),
      onSetPreference: (key, value) => {
        if (key === "expandedTaskGroups") writes.push(value);
      },
    });
    await collapsedContainer();
    fireEvent.click(
      within(taskGroupHeader(NUCLEUS_ENVIRONMENT)!).getByText(
        "#1296 BB host phase 5",
      ),
    );
    await waitFor(() => {
      expect(
        taskGroupHeader(NUCLEUS_ENVIRONMENT)!.getAttribute(
          "data-nucleus-task-group-collapsed",
        ),
      ).toBe("false");
    });
    await waitFor(() => {
      expect(writes.at(-1)).toEqual([NUCLEUS_ENVIRONMENT]);
    });
    fireEvent.click(leadingSlot(NUCLEUS_ENVIRONMENT));
    await waitFor(() => {
      expect(
        taskGroupHeader(NUCLEUS_ENVIRONMENT)!.getAttribute(
          "data-nucleus-task-group-collapsed",
        ),
      ).toBe("true");
    });
  });

  it("keeps the folder while the task is idle", async () => {
    renderWith(threadsWith({}));
    const row = await collapsedContainer();
    const leading = leadingSlot(NUCLEUS_ENVIRONMENT);
    expect(leading.getAttribute("data-nucleus-task-group-status")).toBeNull();
    expect(leading.getAttribute("aria-hidden")).toBe("true");
    expect(leading.getAttribute("role")).toBeNull();
    expect(leading.querySelector("[data-icon]")).not.toBeNull();
    expect(row.querySelector("[data-thread-status-glyph]")).toBeNull();
  });

  it("reveals the chevron only on hover or focus, collapsed and expanded, and the chevron toggles", async () => {
    let expanded: unknown = null;
    renderTaskGroups({
      groups: [GROUP],
      threadListState: {
        status: "ready",
        threads: threadsWith({ runtimeStatus: "active" }),
      },
      allThreads: threadsWith({ runtimeStatus: "active" }),
      onSetPreference: (key, value) => {
        if (key === "expandedTaskGroups") expanded = value;
      },
    });
    const row = await collapsedContainer();
    const collapsedChevron = within(row).getByRole("button", {
      name: /^Expand .* threads$/,
    });
    // Upstream's hover-reveal class: hidden until the row is hovered or focused.
    expect(collapsedChevron.className).toContain("bb-sidebar-hover-actions");
    fireEvent.click(collapsedChevron);
    await waitFor(() => {
      expect(
        taskGroupHeader(NUCLEUS_ENVIRONMENT)!.getAttribute(
          "data-nucleus-task-group-collapsed",
        ),
      ).toBe("false");
    });
    await waitFor(() => {
      expect(expanded).toEqual([NUCLEUS_ENVIRONMENT]);
    });
    const expandedChevron = within(taskGroupRow(NUCLEUS_ENVIRONMENT)).getByRole(
      "button",
      { name: /^Collapse .* threads$/ },
    );
    expect(expandedChevron.className).toContain("bb-sidebar-hover-actions");
    // Expanded, each thread row shows its own status, so the container is the folder again.
    expect(
      leadingSlot(NUCLEUS_ENVIRONMENT).querySelector("[data-icon]"),
    ).not.toBeNull();
    expect(
      leadingSlot(NUCLEUS_ENVIRONMENT).getAttribute(
        "data-nucleus-task-group-status",
      ),
    ).toBeNull();
  });

  it("leaves an ordinary collapsed group's header exactly as upstream draws it", async () => {
    renderWith(threadsWith({ runtimeStatus: "active" }));
    await collapsedContainer();
    const ordinary = upstreamHeaderByEnvironment(UPSTREAM_ENVIRONMENT);
    const name =
      within(ordinary).getByText(UPSTREAM_ENVIRONMENT).parentElement!;
    // Leading slot: upstream's icon, hidden from assistive technology, no status.
    const leading = name.previousElementSibling as HTMLElement;
    expect(leading.getAttribute("aria-hidden")).toBe("true");
    expect(leading.getAttribute("role")).toBeNull();
    expect(leading.getAttribute("data-nucleus-task-group-status")).toBeNull();
    expect(leading.querySelector("[data-icon]")).not.toBeNull();
    expect(leading.querySelector("[data-thread-status-glyph]")).toBeNull();
    // Collapsed, upstream keeps the chevron visible (no hover-reveal class) and
    // draws the roll-up in its trailing slot beside the hover actions.
    const chevron = within(ordinary).getByRole("button", {
      name: /^Expand .* threads$/,
    });
    expect(chevron.className).not.toContain("bb-sidebar-hover-actions");
    const trailing = name.nextElementSibling as HTMLElement;
    expect(trailing).not.toBeNull();
    const glyph = trailing.querySelector(
      '[data-thread-status-glyph="runtime"]',
    );
    expect(glyph).not.toBeNull();
    expect(glyph!.parentElement!.className).toContain(
      "bb-sidebar-hover-actions-fade",
    );
    expect(
      trailing.querySelector("[data-sidebar-hover-actions-mobile]"),
    ).not.toBeNull();
  });
});
