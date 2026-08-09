<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { Icon, IconButton, IconProvider, Menu, Popover, SplitView, type MenuItem } from "@inflatable-cookie/poodle-svelte";
  import { icons, info, plus, settings as settingsIcon } from "./icons.generated";
  import ProjectWorkspaceStage from "./lib/ProjectWorkspaceStage.svelte";
  import CommandPalette from "./lib/commands/CommandPalette.svelte";
  import { NucleusCommandRuntime } from "./lib/commands/runtime.svelte";
  import OperationPopover from "./lib/operations/OperationPopover.svelte";
  import { createNucleusOperationSession } from "./lib/operations/runtime.svelte";
  import NotificationPopover from "./lib/notifications/NotificationPopover.svelte";
  import { NotificationToastHost } from "@inflatable-cookie/longhorn-poodle-svelte/notifications/poodle";
  import { createNucleusNotificationSession } from "./lib/notifications/runtime.svelte";
  import SettingsDialog from "./lib/settings/SettingsDialog.svelte";
  import WorkspaceSidebar from "./lib/WorkspaceSidebar.svelte";
  import type { ControlProjectRecordDto } from "./lib/control";
  import {
    watchEditorFiles,
    type EditorFileWatchEvent,
  } from "./lib/control/editorFileWatch";
  import { beginWindowDrag } from "./lib/windowChrome";
  import {
    createNativePanelOverlayId,
    setNativePanelOverlayOpen,
    setNativePanelOverlayVisibility,
    updateNativePanelOverlayGeometry,
  } from "./lib/nativePanelVisibility";
  import {
    watchDesktopPreferences,
    type AgentChatDefaults,
    type DesktopPreferencesProjection,
  } from "./lib/settings/client";

  let startupError = $state<string | null>(null);
  let fixturePosture = $state(false);
  let selectedProjectId = $state<string | null>(null);
  let selectedProject = $state<ControlProjectRecordDto | null>(null);
  let selectedConversationId = $state<string | null>(null);
  let activePanelKind = $state<string | null>(null);
  let editorDirty = $state(false);
  let agentTurnRunning = $state(false);
  let projectRailRatio = $state(0.18);
  let pendingProjectRailRatio: number | null = null;
  let projectRailPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let splitResizeActive = false;
  let projectRailPrimaryCollapsed = $state(false);
  let projectRailSecondaryCollapsed = $state(false);
  let openPanelKinds = $state<string[]>([]);
  let settingsOpen = $state(false);
  let interfaceDensity = $state<"compact" | "comfortable">("compact");
  let showFixtureStatus = $state(true);
  let agentChatDefaults = $state<AgentChatDefaults>({
    providerInstanceId: "codex:local-default",
    providerId: null,
    model: "gpt-5.4-mini",
    reasoningEffort: "low",
    harnessMode: "normal",
  });
  const projectDetailsOverlayId = createNativePanelOverlayId("project-details");
  const newPanelOverlayId = createNativePanelOverlayId("new-panel");
  const settingsOverlayId = createNativePanelOverlayId("settings");
  const commandPaletteOverlayId = createNativePanelOverlayId("command-palette");
  const operationsOverlayId = createNativePanelOverlayId("operations");
  const notificationsOverlayId = createNativePanelOverlayId("notifications");
  const commandRuntime = new NucleusCommandRuntime({
    openSettings: () => (settingsOpen = true),
  });
  const operationSession = createNucleusOperationSession();
  const notificationSession = createNucleusNotificationSession(commandRuntime.session);
  const projectRailRatioStorageKey = "nucleus:desktop:project-rail-ratio";
  const newPanelItems = $derived<MenuItem[]>([
    { value: "agentChat", label: "Agent Chat" },
    { value: "tasks", label: "Tasks", disabled: openPanelKinds.includes("tasks") },
    { value: "terminal", label: "Terminal" },
    { value: "browser", label: "Browser" },
    { value: "editor", label: "Editor" },
    { value: "diff", label: "Diff" },
    { value: "memory", label: "Memory" },
  ]);

  onMount(() => {
    void commandRuntime.session.start();
    void operationSession.start();
    void notificationSession.start();
    void Promise.all([
      invoke<{ fixture_backed: boolean; startup_error: string | null }>(
        "desktop_startup_status",
      ),
      invoke("desktop_window_page_ready"),
    ])
      .then(([status]) => {
        fixturePosture = status.fixture_backed;
        startupError = status.startup_error;
      })
      .catch((error) => {
        startupError = `desktop startup unavailable: ${String(error)}`;
      });
    const storedRatio = Number.parseFloat(
      window.localStorage.getItem(projectRailRatioStorageKey) ?? "",
    );
    if (Number.isFinite(storedRatio)) {
      projectRailRatio = clampProjectRailRatio(storedRatio);
    }

    window.addEventListener("mousedown", beginSplitResize, true);
    window.addEventListener("mouseup", commitProjectRailResize);
    window.addEventListener("mouseup", finishSplitResize);
    window.addEventListener("blur", finishSplitResize);
    window.addEventListener("nucleus:editor-command-state", handleEditorCommandState);
    window.addEventListener("nucleus:agent-turn-command-state", handleAgentTurnCommandState);

    return () => {
      void commandRuntime.session.stop();
      void operationSession.stop();
      void notificationSession.stop();
      window.removeEventListener("mousedown", beginSplitResize, true);
      window.removeEventListener("mouseup", commitProjectRailResize);
      window.removeEventListener("mouseup", finishSplitResize);
      window.removeEventListener("blur", finishSplitResize);
      window.removeEventListener("nucleus:editor-command-state", handleEditorCommandState);
      window.removeEventListener("nucleus:agent-turn-command-state", handleAgentTurnCommandState);
      commitProjectRailResize();
      finishSplitResize();
    };
  });

  onMount(() => {
    let disposed = false;
    let stop: (() => void | Promise<void>) | null = null;
    void watchDesktopPreferences(
      applyDesktopPreferences,
      (error) => console.warn("desktop settings unavailable", error),
    ).then((watchStop) => {
      if (disposed) void watchStop();
      else stop = watchStop;
    }).catch((error) => {
      if (!disposed) console.warn("desktop settings listener unavailable", error);
    });
    return () => {
      disposed = true;
      void stop?.();
    };
  });

  $effect(() => {
    setNativePanelOverlayVisibility(settingsOverlayId, settingsOpen);
  });

  $effect(() => {
    setNativePanelOverlayVisibility(commandPaletteOverlayId, commandRuntime.session.open);
  });

  $effect(() => {
    selectedProject?.project_id;
    openPanelKinds = [];
    activePanelKind = null;
  });

  $effect(() => {
    commandRuntime.updateFacts({
      selectedProjectId: selectedProject?.project_id ?? null,
      activePanelKind,
      openPanelKinds,
      activeThread: selectedConversationId !== null,
      editorDirty,
      agentTurnRunning,
    });
  });

  $effect(() => {
    const projectId = selectedProject?.project_id ?? null;
    const resourceIds = selectedProject?.resources
      .filter((resource) =>
        resource.role === "working"
        && resource.location_status === "present"
        && resource.locator_available
      )
      .map((resource) => resource.resource_id) ?? [];
    if (!projectId || resourceIds.length === 0) return;

    let disposed = false;
    let stop: (() => Promise<void>) | null = null;
    void watchEditorFiles(projectId, resourceIds, publishEditorFileWatchEvent)
      .then((watchStop) => {
        if (disposed) {
          void watchStop();
        } else {
          stop = watchStop;
        }
      })
      .catch((caught) => {
        console.warn("editor file watch unavailable", caught);
      });

    return () => {
      disposed = true;
      void stop?.().catch(() => undefined);
    };
  });

  function publishEditorFileWatchEvent(event: EditorFileWatchEvent): void {
    if (event.kind === "failed") {
      console.warn(event.message);
    }
    if (event.kind === "scm_changed") {
      window.dispatchEvent(new CustomEvent("nucleus:scm-working-copy-changed", {
        detail: event,
      }));
      return;
    }
    window.dispatchEvent(new CustomEvent("nucleus:editor-files-changed", {
      detail: event,
    }));
  }

  function createWorkspacePanel(kind: string) {
    if (kind === "tasks" && openPanelKinds.includes("tasks")) {
      return;
    }
    window.dispatchEvent(
      new CustomEvent("nucleus:create-workspace-panel", {
        detail: { kind },
      }),
    );
  }

  function handleEditorCommandState(event: Event): void {
    editorDirty = event instanceof CustomEvent && event.detail?.dirty === true;
  }

  function handleAgentTurnCommandState(event: Event): void {
    agentTurnRunning = event instanceof CustomEvent && event.detail?.running === true;
  }

  function applyDesktopPreferences(preferences: DesktopPreferencesProjection): void {
    showFixtureStatus = preferences.showFixtureStatus;
    interfaceDensity = preferences.density;
    agentChatDefaults = preferences.agent;
  }

  function resizeProjectRail(ratio: number) {
    pendingProjectRailRatio = clampProjectRailRatio(ratio);

    if (projectRailPersistTimer) {
      clearTimeout(projectRailPersistTimer);
    }
    projectRailPersistTimer = setTimeout(commitProjectRailResize, 200);
  }

  function beginSplitResize(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('[role="separator"]') || splitResizeActive) {
      return;
    }

    splitResizeActive = true;
    document.documentElement.setAttribute("data-nucleus-split-resizing", "");
    window.dispatchEvent(new CustomEvent("nucleus:native-panels-hide"));
  }

  function finishSplitResize(): void {
    if (!splitResizeActive) {
      return;
    }

    splitResizeActive = false;
    document.documentElement.removeAttribute("data-nucleus-split-resizing");
    window.dispatchEvent(new CustomEvent("nucleus:native-panels-show"));
  }

  function commitProjectRailResize() {
    if (projectRailPersistTimer) {
      clearTimeout(projectRailPersistTimer);
      projectRailPersistTimer = null;
    }
    if (pendingProjectRailRatio === null) {
      return;
    }

    projectRailRatio = pendingProjectRailRatio;
    pendingProjectRailRatio = null;
    window.localStorage.setItem(projectRailRatioStorageKey, String(projectRailRatio));
  }

  function keepProjectRailSplitOpen() {
    projectRailPrimaryCollapsed = false;
    projectRailSecondaryCollapsed = false;
    if ((pendingProjectRailRatio ?? projectRailRatio) < 0.12) {
      resizeProjectRail(0.18);
    }
  }

  function clampProjectRailRatio(ratio: number): number {
    return Math.min(0.4, Math.max(0.12, ratio));
  }
</script>

<IconProvider {icons}>
<main
  class="app-root"
  data-theme="cobalt"
  data-density={interfaceDensity}
  data-control-size="sm"
  data-poodle-theme-root
>
  {#if startupError}
    <div class="startup-error" role="alert">
      Nucleus started without its local seed data: {startupError}. Panels may
      be empty until storage is writable.
    </div>
  {/if}
  {#if fixturePosture && showFixtureStatus}
    <div class="posture-badge" title="This build serves fixture-backed local state; no live server is connected.">
      fixture-backed
    </div>
  {/if}
  <SplitView
    orientation="horizontal"
    ratio={projectRailRatio}
    minRatio={0.12}
    maxRatio={0.4}
    bind:primaryCollapsed={projectRailPrimaryCollapsed}
    bind:secondaryCollapsed={projectRailSecondaryCollapsed}
    minPrimarySize={192}
    minSecondarySize={520}
    collapsePrimaryBelowSize={0}
    collapseSecondaryBelowSize={0}
    ariaLabel="Project rail and workspace"
    onRatioChange={resizeProjectRail}
    onPrimaryCollapsedChange={keepProjectRailSplitOpen}
    onSecondaryCollapsedChange={keepProjectRailSplitOpen}
  >
    {#snippet primary()}
      <aside class="project-rail" aria-label="Project panel">
        <WorkspaceSidebar
          bind:selectedProjectId
          bind:selectedProject
          bind:selectedConversationId
        />
      </aside>
    {/snippet}

    {#snippet secondary()}
      <div class="app-work-area">
        <header
          class="app-titlebar"
          role="toolbar"
          tabindex="-1"
          aria-label="Workspace titlebar"
          data-tauri-drag-region
          onmousedown={beginWindowDrag}
        >
          <div class="titlebar-lead" data-tauri-drag-region>
            <div class="titlebar-title-block" data-tauri-drag-region>
              <div class="titlebar-title-line">
                <h1>{selectedProject?.display_name ?? "Nucleus"}</h1>
                <Popover
                  placement="bottom-start"
                  initialFocus="content"
                  ariaLabel="Project details"
                  surfaceMinWidth="18rem"
                  onOpenChange={(open) => setNativePanelOverlayOpen(projectDetailsOverlayId, open)}
                  onSurfaceGeometryChange={(change) => updateNativePanelOverlayGeometry(projectDetailsOverlayId, change)}
                >
                  {#snippet trigger()}
                    <span
                      class="project-info-trigger"
                      aria-label="Project details"
                      data-no-window-drag
                    >
                      <Icon icon={info} size="xs" />
                    </span>
                  {/snippet}
                  <div class="project-info-popover" data-no-window-drag>
                    <h2>{selectedProject?.display_name ?? "No project selected"}</h2>
                    <dl>
                      <div>
                        <dt>Project id</dt>
                        <dd>{selectedProject?.project_id ?? "none"}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{selectedProject?.status ?? "idle"}</dd>
                      </div>
                      <div>
                        <dt>Importance</dt>
                        <dd>{selectedProject?.importance_level ?? "none"}</dd>
                      </div>
                      <div>
                        <dt>Revision</dt>
                        <dd>{selectedProject?.revision_id ?? "none"}</dd>
                      </div>
                      <div>
                        <dt>Retention</dt>
                        <dd>{selectedProject?.retention ?? "none"}</dd>
                      </div>
                      <div>
                        <dt>Resource health</dt>
                        <dd>{selectedProject?.location_status ?? "not_recorded"}</dd>
                      </div>
                      <div>
                        <dt>Resources</dt>
                        <dd>{selectedProject?.resource_count ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Repositories</dt>
                        <dd>{selectedProject?.repository_count ?? 0}</dd>
                      </div>
                    </dl>
                  </div>
                </Popover>
              </div>
            </div>
          </div>

          <div class="titlebar-drag-lane" aria-hidden="true" data-tauri-drag-region>
          </div>

          <div class="titlebar-actions" data-no-window-drag>
            <NotificationPopover
              session={notificationSession}
              onOpenChange={(open) => setNativePanelOverlayOpen(notificationsOverlayId, open)}
              onSurfaceGeometryChange={(change) => updateNativePanelOverlayGeometry(notificationsOverlayId, change)}
            />
            <OperationPopover
              session={operationSession}
              onOpenChange={(open) => setNativePanelOverlayOpen(operationsOverlayId, open)}
              onSurfaceGeometryChange={(change) => updateNativePanelOverlayGeometry(operationsOverlayId, change)}
            />
            <IconButton
              variant="secondary"
              icon={settingsIcon}
              ariaLabel="Settings"
              tooltip="Settings"
              onClick={() => (settingsOpen = true)}
            />
            <Menu
              items={newPanelItems}
              ariaLabel="New workspace panel"
              placement="bottom-end"
              onAction={createWorkspacePanel}
              onOpenChange={(open) => setNativePanelOverlayOpen(newPanelOverlayId, open)}
              onSurfaceGeometryChange={(change) => updateNativePanelOverlayGeometry(newPanelOverlayId, change)}
            >
              {#snippet trigger()}
                <IconButton
                  variant="secondary"
                  icon={plus}
                  ariaLabel="New workspace panel"
                  tooltip="New panel"
                />
              {/snippet}
            </Menu>
          </div>
        </header>

        <div class="product-shell">
          <section class="workspace-stage" aria-label="Workspace">
            {#key selectedProject?.project_id ?? "no-project"}
              <ProjectWorkspaceStage
                {selectedProject}
                bind:selectedConversationId
                {agentChatDefaults}
                onOpenPanelKindsChange={(kinds) => (openPanelKinds = kinds)}
                onCommandContextChange={(kind) => (activePanelKind = kind)}
              />
            {/key}
          </section>
        </div>
      </div>
    {/snippet}
  </SplitView>
  {#if settingsOpen}
    <SettingsDialog
      commandSession={commandRuntime.session}
      onOpenChange={(open) => (settingsOpen = open)}
    />
  {/if}
  <CommandPalette session={commandRuntime.session} />
  <NotificationToastHost
    session={notificationSession}
    autoDismissMs={6000}
    stickyTones={["danger"]}
    placement="bottom-end"
  />
</main>
</IconProvider>

<style>
  .app-root {
    display: block;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    color: var(--poodle-color-text-secondary);
    background: var(--poodle-color-background-canvas);
  }

  .app-work-area {
    display: grid;
    grid-template-rows: 3rem minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  .app-titlebar {
    display: flex;
    align-items: center;
    gap: 1rem;
    min-width: 0;
    min-height: 3rem;
    padding: 0.375rem 1rem;
    background: var(--poodle-color-background-elevated);
    border-bottom: 0.0625rem solid var(--poodle-color-border-subtle);
    flex-shrink: 0;
    user-select: none;
    -webkit-user-select: none;
  }

  .titlebar-lead,
  .titlebar-actions {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .titlebar-lead {
    flex: 0 1 auto;
    gap: 0.75rem;
  }

  .titlebar-title-block {
    display: grid;
    min-width: 0;
  }

  .titlebar-title-line {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }

  .titlebar-title-block h1 {
    margin: 0;
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-size: 0.9375rem;
    font-weight: 700;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-info-trigger {
    display: inline-grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    color: var(--poodle-color-text-muted);
    border-radius: var(--poodle-radius-control);
    cursor: pointer;
    -webkit-app-region: no-drag;
  }

  .project-info-trigger:hover {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-surface);
  }

  .project-info-popover {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

  .project-info-popover h2 {
    margin: 0;
    color: var(--poodle-color-text-primary);
    font-size: 0.875rem;
    line-height: 1.25;
  }

  .project-info-popover dl {
    display: grid;
    gap: 0.5rem;
    margin: 0;
  }

  .project-info-popover div {
    display: grid;
    gap: 0.125rem;
    min-width: 0;
  }

  .project-info-popover dt {
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
    line-height: 1.2;
  }

  .project-info-popover dd {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--poodle-color-text-secondary);
    font-size: 0.8125rem;
    line-height: 1.3;
  }

  .titlebar-drag-lane {
    flex: 1 1 0;
    min-width: 4rem;
    min-height: 2rem;
    cursor: grab;
  }

  .titlebar-drag-lane:active {
    cursor: grabbing;
  }

  .titlebar-actions {
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .product-shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: var(--poodle-color-background-canvas);
  }

  .project-rail,
  .workspace-stage {
    min-width: 0;
    min-height: 0;
  }

  .project-rail {
    box-sizing: border-box;
    height: 100%;
    padding-top: 3rem;
    background: var(--poodle-color-background-panel);
  }

  .workspace-stage {
    background: var(--poodle-color-background-canvas);
  }

  @media (max-width: 780px) {
    .app-titlebar {
      flex-wrap: wrap;
    }

    .titlebar-drag-lane {
      order: 4;
      flex-basis: 100%;
      min-height: 1rem;
    }

  }
  .startup-error {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
    padding: 6px 12px;
    color: var(--poodle-color-text-danger);
    border-bottom: 1px solid var(--poodle-color-status-danger);
    background: color-mix(
      in srgb,
      var(--poodle-color-status-danger) 16%,
      var(--poodle-color-background-elevated)
    );
    font-size: 12px;
  }

  .posture-badge {
    position: fixed;
    right: 10px;
    bottom: 8px;
    z-index: 90;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.45);
    font-size: 10px;
    letter-spacing: 0.04em;
    pointer-events: none;
  }
</style>
