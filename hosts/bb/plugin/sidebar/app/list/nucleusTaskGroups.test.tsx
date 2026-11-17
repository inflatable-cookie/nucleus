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
}: {
  id: string;
  title: string;
  environmentId: string;
  originPluginId: string | null;
  parentThreadId?: string | null;
  hasPendingInteraction?: boolean;
}): SidebarThread {
  return makeSidebarThread({
    id,
    title,
    titleFallback: title,
    projectId: "proj_test",
    parentThreadId,
    hasPendingInteraction,
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
function preferenceValues(overrides: Partial<PreferenceValues> = {}): PreferenceValues {
  return { ...defaultPreferences(), ...overrides };
}

interface RenderOptions {
  /** The store a test hydrated before mounting, so the mount sees those values. */
  store?: ReturnType<typeof createStore>;
  groups?: ReadonlyArray<SidebarGroups["groups"][number]>;
  /** Omit the handler entirely: the read fails, as it does with the service away. */
  failRead?: boolean;
  onSetPreference?: (key: string, value: unknown) => void;
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
      const { key, value } = input as unknown as { key: string; value: unknown };
      options.onSetPreference?.(key, value);
      return { key, value } as never;
    },
    resetPreference: async (input: never) => input as never,
  } as unknown as PluginRpcTestHandlers<never>;
  if (options.failRead !== true) {
    (rpc as unknown as Record<string, unknown>).sidebarGroups = async () => ({
      groups: options.groups ?? [GROUP],
      threads: [],
    });
  }
  const slot = renderSlot(
    { component: Harness },
    {
      store,
      children: (
        <NucleusSidebarGroupsProvider>
          <ProjectRow
            project={makeSidebarProject({ id: "proj_test" })}
            threadListState={{ status: "ready", threads: THREADS }}
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
        threads: THREADS,
        projects: [makeSidebarProject({ id: "proj_test" })],
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
      header.querySelector("[data-nucleus-task-group-state-label]")?.textContent,
    ).toBe("Reviewing");
    expect(
      header.querySelector("[data-nucleus-task-group-wait]")?.textContent,
    ).toBe("Waiting for QA capacity (position 2)");
    const pullRequest = header.querySelector("[data-nucleus-task-group-pr]");
    expect(pullRequest?.textContent).toBe("#191OPEN");
    expect(within(pullRequest as HTMLElement).getByText("OPEN")).not.toBeNull();
    // Collapsed by default, with no `collapsedEnvironments` entry: the fork's own
    // preference decides, so the two group classes cannot disagree.
    expect(header.getAttribute("data-nucleus-task-group-collapsed")).toBe("true");
    // The collapsed roll-up is the host's own: `experimental_resolveThreadStatus`
    // over the hidden threads names the indicator, and upstream's glyph draws it.
    // The row-level glyph sits beside the name block, like upstream's chevron.
    expect(
      taskGroupRow(NUCLEUS_ENVIRONMENT).querySelector(
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
      expect(writes.some((write) => write.key === "expandedTaskGroups")).toBe(true);
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
          ? { preferences: preferenceValues({ expandedTaskGroups: [NUCLEUS_ENVIRONMENT] }) }
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
