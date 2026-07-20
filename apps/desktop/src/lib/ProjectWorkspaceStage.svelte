<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    DockRegion,
    Surface,
    SplitView,
    Text,
    type DockEdge,
    type PanelTabItem,
  } from "@poodle/svelte";
  import AgentChatPanel from "./AgentChatPanel.svelte";
  import BrowserPanel from "./BrowserPanel.svelte";
  import DiffPanel from "./DiffPanel.svelte";
  import EditorPanel from "./EditorPanel.svelte";
  import MemoryPanel from "./MemoryPanel.svelte";
  import PanelResourceTargetControl from "./PanelResourceTargetControl.svelte";
  import TaskListPanel from "./TaskListPanel.svelte";
  import TerminalPanel from "./TerminalPanel.svelte";
  import { destroyBrowserWebview } from "./browserPanel";
  import { closeTerminalPanel } from "./terminalClient";
  import type {
    ControlGoalRecordDto,
    ControlProjectRecordDto,
    ControlTaskRecordDto,
  } from "./control";
  import {
    createWorkspacePanel,
    defaultRegionForPanelKind,
    loadWorkspaceUiConfig,
    saveWorkspaceUiConfig,
    workspacePanelFor,
    workspaceWindowForProject,
    type RegionKey,
    type WorkspacePanelDto,
    type WorkspaceWindowDto,
    type WorkspaceUiConfigDto,
  } from "./workspaceUi";

  let {
    selectedProject,
    onOpenPanelKindsChange,
  }: {
    selectedProject: ControlProjectRecordDto | null;
    onOpenPanelKindsChange?: (kinds: string[]) => void;
  } = $props();

  let config = $state<WorkspaceUiConfigDto | null>(null);
  let configProjectId = $state<string | null>(null);
  let loadSequence = 0;
  let lastSelectedProjectId: string | null = null;
  let loading = $state(true);
  let error = $state<string | null>(null);
  let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let draggedPanelId = $state<string | null>(null);
  let panelDropTargetsVisible = $state(false);
  let dropTargetRegion = $state<RegionKey | null>(null);
  let selectedTaskId = $state<string | null>(null);
  let selectedTask = $state<ControlTaskRecordDto | null>(null);
  let selectedGoalId = $state<string | null>(null);
  let selectedGoal = $state<ControlGoalRecordDto | null>(null);
  let editorFileRef = $state<string | null>(null);

  const workspaceWindow = $derived(
    workspaceWindowForProject(
      config,
      configProjectId,
      selectedProject?.project_id ?? null,
    ),
  );
  const panelDropTargetRegions = $derived.by<Set<RegionKey>>(() => {
    const panelId = draggedPanelId;
    if (!panelId || !panelDropTargetsVisible) {
      return new Set();
    }

    return new Set(
      regionKeys().filter((region) => canDropPanelInRegion(panelId, region)),
    );
  });
  const visibleRegions = $derived.by<Record<RegionKey, boolean>>(() => ({
    left: regionShouldRender("left"),
    center_top: regionShouldRender("center_top"),
    center_bottom: regionShouldRender("center_bottom"),
    right_top: regionShouldRender("right_top"),
    right_bottom: regionShouldRender("right_bottom"),
  }));
  const hasLeftRegion = $derived(visibleRegions.left);
  const openPanelKinds = $derived.by<string[]>(() =>
    workspaceWindow
      ? [...new Set(regionKeys().flatMap((region) =>
          workspaceWindow.regions[region].map((panel) => panel.kind),
        ))]
      : [],
  );

  onMount(() => {
    window.addEventListener("nucleus:create-workspace-panel", handleCreateWorkspacePanel);
    window.addEventListener("nucleus:open-task", handleOpenTask);
    window.addEventListener("nucleus:open-goal", handleOpenGoal);

    return () => {
      window.removeEventListener("nucleus:create-workspace-panel", handleCreateWorkspacePanel);
      window.removeEventListener("nucleus:open-task", handleOpenTask);
      window.removeEventListener("nucleus:open-goal", handleOpenGoal);
    };
  });

  $effect(() => {
    const projectId = selectedProject?.project_id ?? null;
    if (projectId === lastSelectedProjectId) return;
    lastSelectedProjectId = projectId;
    void loadConfig(projectId);
    selectedTaskId = null;
    selectedTask = null;
    selectedGoalId = null;
    selectedGoal = null;
  });

  $effect(() => {
    onOpenPanelKindsChange?.(openPanelKinds);
  });

  $effect(() => {
    if (!selectedTaskId) {
      selectedTask = null;
    }
  });

  $effect(() => {
    if (!selectedGoalId) {
      selectedGoal = null;
    }
  });

  onDestroy(() => {
    if (layoutPersistTimer) {
      clearTimeout(layoutPersistTimer);
    }
  });

  async function loadConfig(projectId: string | null): Promise<void> {
    const sequence = ++loadSequence;
    config = null;
    configProjectId = null;
    loading = Boolean(projectId);
    error = null;

    if (!projectId) {
      return;
    }

    try {
      const loaded = await loadWorkspaceUiConfig(projectId);
      if (sequence === loadSequence && selectedProject?.project_id === projectId) {
        config = loaded;
        configProjectId = projectId;
      }
    } catch (caught) {
      if (sequence === loadSequence) {
        error = formatError(caught);
      }
    } finally {
      if (sequence === loadSequence) {
        loading = false;
      }
    }
  }

  async function persist(nextConfig: WorkspaceUiConfigDto): Promise<void> {
    const projectId = configProjectId;
    if (!projectId) return;
    config = nextConfig;
    error = null;

    try {
      const saved = await saveWorkspaceUiConfig(projectId, nextConfig);
      if (configProjectId === projectId && selectedProject?.project_id === projectId) {
        config = saved;
      }
    } catch (caught) {
      if (configProjectId === projectId) {
        error = formatError(caught);
      }
    }
  }

  function persistLayout(nextConfig: WorkspaceUiConfigDto): void {
    const projectId = configProjectId;
    if (!projectId) return;
    config = nextConfig;
    error = null;

    if (layoutPersistTimer) {
      clearTimeout(layoutPersistTimer);
    }

    layoutPersistTimer = setTimeout(() => {
      layoutPersistTimer = null;
      void saveWorkspaceUiConfig(projectId, nextConfig).catch((caught) => {
        if (configProjectId === projectId) {
          error = formatError(caught);
        }
      });
    }, 200);
  }

  function handleCreateWorkspacePanel(event: Event): void {
    const kind =
      event instanceof CustomEvent && typeof event.detail?.kind === "string"
        ? event.detail.kind
        : null;
    if (!kind) {
      return;
    }

    addPanel(kind);
  }

  function handleOpenTask(event: Event): void {
    if (!(event instanceof CustomEvent) || event.detail?.projectId !== selectedProject?.project_id) {
      return;
    }
    selectedTaskId = typeof event.detail.taskId === "string" ? event.detail.taskId : null;
    focusPanelKind("tasks");
  }

  function handleOpenGoal(event: Event): void {
    if (!(event instanceof CustomEvent) || event.detail?.projectId !== selectedProject?.project_id) {
      return;
    }
    selectedGoalId = typeof event.detail.goalId === "string" ? event.detail.goalId : null;
    selectedTaskId = typeof event.detail.taskId === "string" ? event.detail.taskId : null;
    focusPanelKind("tasks");
  }

  function focusPanelKind(kind: string): void {
    if (!workspaceWindow) {
      return;
    }
    for (const region of regionKeys()) {
      const panel = workspaceWindow.regions[region].find((candidate) => candidate.kind === kind);
      if (panel) {
        setActivePanel(region, panel.id);
        return;
      }
    }
  }

  function openFileInEditor(fileRef: string): void {
    editorFileRef = fileRef;
    const hasEditor = regionKeys().some((region) =>
      workspaceWindow?.regions[region].some((panel) => panel.kind === "editor"),
    );
    if (hasEditor) {
      focusPanelKind("editor");
    } else {
      addPanel("editor");
    }
  }

  function handlePanelDragStart(event: DragEvent, sourceRegion: RegionKey): void {
    if (!event.dataTransfer || !workspaceWindow) {
      return;
    }

    const tab = (event.target as HTMLElement | null)?.closest?.("[role='tab']");
    const panel = tab
      ? workspaceWindow.regions[sourceRegion].find((candidate) =>
          tab.id.endsWith(`-${candidate.id}`),
        )
      : null;

    if (!panel?.movable) {
      return;
    }

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "application/x-nucleus-workspace-panel-drag",
      JSON.stringify({ panelId: panel.id, sourceRegion }),
    );
    window.dispatchEvent(new CustomEvent("nucleus:native-panels-hide"));
    queueMicrotask(() => {
      draggedPanelId = panel.id;
    });
  }

  function handleRegionDragOver(event: DragEvent, targetRegion: RegionKey): void {
    const panelId = currentDraggedPanelId(event);
    if (!panelId) {
      return;
    }

    // WebKit can cancel a native drag if revealing a zero-width split pane
    // resizes the source during dragstart. The first dragover proves that the
    // native drag is established, so collapsed targets can safely open now.
    panelDropTargetsVisible = true;

    if (!canDropPanelInRegion(panelId, targetRegion)) {
      if (isCrossRegionPanelDrag(panelId, targetRegion)) {
        event.stopPropagation();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "none";
        }
      }
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    dropTargetRegion = targetRegion;
  }

  function handleRegionDragLeave(event: DragEvent, targetRegion: RegionKey): void {
    const currentTarget = event.currentTarget as HTMLElement;
    const relatedTarget = event.relatedTarget as Node | null;
    if (relatedTarget && currentTarget.contains(relatedTarget)) {
      return;
    }

    if (dropTargetRegion === targetRegion) {
      dropTargetRegion = null;
    }
  }

  function handleRegionDrop(event: DragEvent, targetRegion: RegionKey): void {
    const panelId = currentDraggedPanelId(event);
    if (!panelId) {
      return;
    }

    if (!canDropPanelInRegion(panelId, targetRegion)) {
      if (isCrossRegionPanelDrag(panelId, targetRegion)) {
        event.preventDefault();
        event.stopPropagation();
      }
      clearPanelDragState();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    movePanelToRegion(panelId, targetRegion);
    clearPanelDragState();
  }

  function clearPanelDragState(): void {
    draggedPanelId = null;
    panelDropTargetsVisible = false;
    dropTargetRegion = null;
    window.dispatchEvent(new CustomEvent("nucleus:native-panels-show"));
  }

  function addPanel(kind: string): void {
    if (!config || !workspaceWindow) {
      return;
    }

    if (kind === "tasks" && openPanelKinds.includes("tasks")) {
      focusPanelKind("tasks");
      return;
    }

    const targetRegion = defaultRegionForPanelKind(kind);
    const existingCount = regionKeys()
      .flatMap((region) => workspaceWindow.regions[region])
      .filter((panel) => panel.kind === kind).length;
    const panel = createWorkspacePanel(workspaceWindow.id, kind, existingCount + 1);

    void persist({
      ...config,
      window: {
        ...workspaceWindow,
        active_panels: {
          ...workspaceWindow.active_panels,
          [targetRegion]: panel.id,
        },
        regions: {
          ...workspaceWindow.regions,
          [targetRegion]: [...workspaceWindow.regions[targetRegion], panel],
        },
      },
    });
  }

  function panelsFor(window: WorkspaceWindowDto | null, region: RegionKey): WorkspacePanelDto[] {
    return window?.regions?.[region] ?? [];
  }

  function panelResourceTarget(panel: WorkspacePanelDto): string | null {
    const projectId = selectedProject?.project_id;
    return projectId ? (panel.resource_targets ?? {})[projectId] ?? null : null;
  }

  function effectivePanelResourceTarget(panel: WorkspacePanelDto): string | null {
    const explicit = panelResourceTarget(panel);
    if (explicit || !selectedProject) return explicit;
    if (selectedProject.default_working_resource_id) {
      return selectedProject.default_working_resource_id;
    }
    const available = selectedProject.resources.filter(
      (resource) =>
        resource.role === "working"
        && resource.location_status === "present"
        && resource.locator_available,
    );
    return available.length === 1 ? available[0].resource_id : null;
  }

  async function setPanelResourceTarget(
    panel: WorkspacePanelDto,
    resourceId: string | null,
  ): Promise<void> {
    const projectId = selectedProject?.project_id;
    if (!config || !workspaceWindow || !projectId) return;
    if (panel.kind === "terminal") {
      try {
        await closeTerminalPanel(projectId, panel.id);
      } catch (caught) {
        error = formatError(caught);
        return;
      }
    }
    const resourceTargets = { ...(panel.resource_targets ?? {}) };
    if (resourceId) resourceTargets[projectId] = resourceId;
    else delete resourceTargets[projectId];
    const regions = Object.fromEntries(
      regionKeys().map((region) => [
        region,
        workspaceWindow.regions[region].map((candidate) =>
          candidate.id === panel.id
            ? { ...candidate, resource_targets: resourceTargets }
            : candidate,
        ),
      ]),
    ) as WorkspaceWindowDto["regions"];
    await persist({
      ...config,
      window: { ...workspaceWindow, regions },
    });
  }

  function panelTabsFor(panels: WorkspacePanelDto[]): PanelTabItem[] {
    return panels.map((panel) => ({
      value: panel.id,
      label: panel.title,
      icon: iconForPanel(panel.kind),
      closable: panel.closeable,
    }));
  }

  function activePanelValue(region: RegionKey, items: PanelTabItem[]): string | null {
    const saved = workspaceWindow?.active_panels[region];
    return saved && items.some((item) => item.value === saved)
      ? saved
      : items[0]?.value ?? null;
  }

  function setActivePanel(region: RegionKey, panelId: string): void {
    if (!config || !workspaceWindow || workspaceWindow.active_panels[region] === panelId) {
      return;
    }
    void persist({
      ...config,
      window: {
        ...workspaceWindow,
        active_panels: { ...workspaceWindow.active_panels, [region]: panelId },
      },
    });
  }

  function closePanel(region: RegionKey, panelId: string): void {
    if (!config || !workspaceWindow) {
      return;
    }

    const panels = panelsFor(workspaceWindow, region);
    const panel = panels.find((candidate) => candidate.id === panelId);
    if (!panel?.closeable) {
      return;
    }

    if (panel.kind === "browser") {
      void destroyBrowserWebview(panel.id).catch((caught) => {
        error = formatError(caught);
      });
    } else if (panel.kind === "terminal" && selectedProject?.project_id) {
      void closeTerminalPanel(selectedProject.project_id, panel.id).catch((caught) => {
        error = formatError(caught);
      });
    }

    const activePanels = { ...workspaceWindow.active_panels };
    if (activePanels[region] === panelId) {
      delete activePanels[region];
    }
    void persist({
      ...config,
      window: {
        ...workspaceWindow,
        active_panels: activePanels,
        regions: {
          ...workspaceWindow.regions,
          [region]: panels.filter((candidate) => candidate.id !== panelId),
        },
      },
    });
  }

  function reorderPanels(region: RegionKey, order: string[]): void {
    if (!config || !workspaceWindow) {
      return;
    }

    const panels = panelsFor(workspaceWindow, region);
    const panelsById = new Map(panels.map((panel) => [panel.id, panel]));
    const reorderedPanels = order
      .map((panelId) => panelsById.get(panelId))
      .filter((panel): panel is WorkspacePanelDto => Boolean(panel));

    if (reorderedPanels.length !== panels.length) {
      return;
    }

    void persist({
      ...config,
      window: {
        ...workspaceWindow,
        regions: {
          ...workspaceWindow.regions,
          [region]: reorderedPanels,
        },
      },
    });
  }

  function canMovePanelToRegion(panelId: string, targetRegion: RegionKey): boolean {
    const panel = findPanel(panelId);
    return Boolean(
      panel?.movable &&
        (panel.allowed_regions.length === 0 || panel.allowed_regions.includes(targetRegion)),
    );
  }

  function canDropPanelInRegion(panelId: string, targetRegion: RegionKey): boolean {
    const sourceRegion = findPanelRegion(panelId);
    return Boolean(
      sourceRegion &&
        sourceRegion !== targetRegion &&
        canMovePanelToRegion(panelId, targetRegion),
    );
  }

  function isCrossRegionPanelDrag(panelId: string, targetRegion: RegionKey): boolean {
    const sourceRegion = findPanelRegion(panelId);
    return Boolean(sourceRegion && sourceRegion !== targetRegion);
  }

  function movePanelToRegion(panelId: string, targetRegion: RegionKey): void {
    if (!config || !workspaceWindow || !canMovePanelToRegion(panelId, targetRegion)) {
      return;
    }

    const sourceRegion = findPanelRegion(panelId);
    if (!sourceRegion || sourceRegion === targetRegion) {
      return;
    }

    const panel = workspaceWindow.regions[sourceRegion].find(
      (candidate) => candidate.id === panelId,
    );
    if (!panel) {
      return;
    }

    const nextRegions = {
      ...workspaceWindow.regions,
      [sourceRegion]: workspaceWindow.regions[sourceRegion].filter(
        (candidate) => candidate.id !== panelId,
      ),
      [targetRegion]: [...workspaceWindow.regions[targetRegion], panel],
    };

    const activePanels = { ...workspaceWindow.active_panels };
    if (activePanels[sourceRegion] === panelId) {
      delete activePanels[sourceRegion];
    }
    activePanels[targetRegion] = panelId;

    void persist({
      ...config,
      window: { ...workspaceWindow, regions: nextRegions, active_panels: activePanels },
    });
  }

  function updateWindowLayout(patch: Partial<WorkspaceWindowDto["layout"]>): void {
    if (!config || !workspaceWindow) {
      return;
    }

    persistLayout({
      ...config,
      window: {
        ...workspaceWindow,
        layout: {
          ...workspaceWindow.layout,
          ...patch,
        },
      },
    });
  }

  function findPanel(panelId: string): WorkspacePanelDto | null {
    if (!workspaceWindow) {
      return null;
    }

    const region = findPanelRegion(panelId);
    return region
      ? workspaceWindow.regions[region].find((panel) => panel.id === panelId) ?? null
      : null;
  }

  function findPanelRegion(panelId: string): RegionKey | null {
    if (!workspaceWindow) {
      return null;
    }

    for (const region of regionKeys()) {
      if (workspaceWindow.regions[region].some((panel) => panel.id === panelId)) {
        return region;
      }
    }

    return null;
  }

  function regionKeys(): RegionKey[] {
    return ["left", "center_top", "center_bottom", "right_top", "right_bottom"];
  }

  function regionShouldRender(region: RegionKey): boolean {
    return (
      (workspaceWindow?.regions[region].length ?? 0) > 0 ||
      panelDropTargetRegions.has(region)
    );
  }

  function panelFor(panels: WorkspacePanelDto[], activeItem: PanelTabItem | null): WorkspacePanelDto {
    return workspacePanelFor(panels, activeItem?.value ?? null);
  }

  function iconForPanel(kind: string): string {
    switch (kind) {
      case "agentChat":
        return "message-square-text";
      case "tasks":
        return "list-checks";
      case "terminal":
        return "terminal";
      case "memory":
        return "panel-right";
      default:
        return "panel-top";
    }
  }

  function formatError(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  function currentDraggedPanelId(event: DragEvent): string | null {
    if (draggedPanelId) {
      return draggedPanelId;
    }

    const raw = event.dataTransfer?.getData("application/x-nucleus-workspace-panel-drag");
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as { panelId?: unknown };
      return typeof parsed.panelId === "string" ? parsed.panelId : null;
    } catch {
      return null;
    }
  }
</script>

<section class="workspace-stage-shell" aria-label="Workspace">
  {#key selectedProject?.project_id ?? "unselected"}
    {#if loading}
      <Surface tone="canvas" border="none" padding="md" asRole="region" label="Workspace loading">
        <Text tone="muted">Loading workspace</Text>
      </Surface>
    {:else if !config || !workspaceWindow}
      <Surface tone="canvas" border="none" padding="md" asRole="region" label="Workspace unavailable">
        <Text tone="muted">Workspace unavailable</Text>
      </Surface>
    {:else}
      <div class="window-body">
        {#if error}
          <div class="layout-error"><Text size="xs" tone="danger">{error}</Text></div>
        {/if}
        <div
          class="left-main-frame"
          class:left-main-frame--single={!hasLeftRegion}
        >
          <SplitView
            orientation="horizontal"
            ratio={workspaceWindow.layout.left_center_ratio}
            primaryCollapsed={!hasLeftRegion}
            primaryCollapsedSize={0}
            collapsePrimaryBelowSize={0}
            minPrimarySize={140}
            minSecondarySize={240}
            ariaLabel="Left and main workspace regions"
            onRatioChange={(ratio) =>
              updateWindowLayout({ left_center_ratio: ratio })}
          >
            {#snippet primary()}
              {@render RegionShell("left", "left", workspaceWindow, "left")}
            {/snippet}
            {#snippet secondary()}
              {@render MainRegions(workspaceWindow)}
            {/snippet}
          </SplitView>
        </div>
        {#if !hasLeftRegion && !visibleRegions.center_top && !visibleRegions.center_bottom && !visibleRegions.right_top && !visibleRegions.right_bottom}
          <Surface tone="canvas" border="none" padding="md" asRole="region" label="Empty workspace">
            <Text tone="muted">No panels open</Text>
          </Surface>
        {/if}
      </div>
    {/if}
  {/key}
</section>

{#snippet MainRegions(window: WorkspaceWindowDto | null)}
  {#if window}
    {@const centerVisible = visibleRegions.center_top || visibleRegions.center_bottom}
    {@const rightVisible = visibleRegions.right_top || visibleRegions.right_bottom}
    <div
      class="center-right-frame"
      class:center-right-frame--single={!centerVisible || !rightVisible}
    >
    <SplitView
      orientation="horizontal"
      ratio={window.layout.center_right_ratio}
      primaryCollapsed={!centerVisible}
      secondaryCollapsed={!rightVisible}
      primaryCollapsedSize={0}
      secondaryCollapsedSize={0}
      collapsePrimaryBelowSize={0}
      collapseSecondaryBelowSize={0}
      minPrimarySize={260}
      minSecondarySize={180}
      ariaLabel="Center and right workspace regions"
      onRatioChange={(ratio) =>
        updateWindowLayout({ center_right_ratio: ratio })}
    >
      {#snippet primary()}
        {@render CenterRegions(window)}
      {/snippet}

      {#snippet secondary()}
        {@render RightRegions(window)}
      {/snippet}
    </SplitView>
    </div>
  {/if}
{/snippet}

{#snippet RightRegions(window: WorkspaceWindowDto | null)}
  {#if window}
    {@const topVisible = visibleRegions.right_top}
    {@const bottomVisible = visibleRegions.right_bottom}
    <div
      class="right-stack-frame"
      class:right-stack-frame--single={!topVisible || !bottomVisible}
    >
    <SplitView
      orientation="vertical"
      ratio={window.layout.right_stack_ratio}
      primaryCollapsed={!topVisible}
      secondaryCollapsed={!bottomVisible}
      primaryCollapsedSize={0}
      secondaryCollapsedSize={0}
      collapsePrimaryBelowSize={0}
      collapseSecondaryBelowSize={0}
      minPrimarySize={180}
      minSecondarySize={120}
      ariaLabel="Right top and right bottom workspace regions"
      onRatioChange={(ratio) =>
        updateWindowLayout({ right_stack_ratio: ratio })}
    >
      {#snippet primary()}
        {@render RegionShell("rightTop", "top", window, "right_top")}
      {/snippet}
      {#snippet secondary()}
        {@render RegionShell("rightBottom", "bottom", window, "right_bottom")}
      {/snippet}
    </SplitView>
    </div>
  {/if}
{/snippet}

{#snippet CenterRegions(window: WorkspaceWindowDto | null)}
  {#if window}
    {@const topVisible = visibleRegions.center_top}
    {@const bottomVisible = visibleRegions.center_bottom}
    <div
      class="center-stack-frame"
      class:center-stack-frame--single={!topVisible || !bottomVisible}
    >
    <SplitView
      orientation="vertical"
      ratio={window.layout.center_stack_ratio}
      primaryCollapsed={!topVisible}
      secondaryCollapsed={!bottomVisible}
      primaryCollapsedSize={0}
      secondaryCollapsedSize={0}
      collapsePrimaryBelowSize={0}
      collapseSecondaryBelowSize={0}
      minPrimarySize={180}
      minSecondarySize={120}
      ariaLabel="Center top and center bottom workspace regions"
      onRatioChange={(ratio) =>
        updateWindowLayout({ center_stack_ratio: ratio })}
    >
      {#snippet primary()}
        {@render RegionShell("centerTop", "top", window, "center_top")}
      {/snippet}
      {#snippet secondary()}
        {@render RegionShell("centerBottom", "bottom", window, "center_bottom")}
      {/snippet}
    </SplitView>
    </div>
  {/if}
{/snippet}

{#snippet RegionShell(label: string, edge: DockEdge, window: WorkspaceWindowDto | null, region: RegionKey)}
  {@const panels = panelsFor(window, region)}
  {@const items = panelTabsFor(panels)}
  <section
    class="region-cell"
    class:region-cell--drop-target={panelDropTargetRegions.has(region)}
    class:region-cell--drop-hover={dropTargetRegion === region}
    aria-label={`${label} region`}
    ondragstartcapture={(event) => handlePanelDragStart(event, region)}
    ondragovercapture={(event) => handleRegionDragOver(event, region)}
    ondragleavecapture={(event) => handleRegionDragLeave(event, region)}
    ondropcapture={(event) => handleRegionDrop(event, region)}
    ondragendcapture={clearPanelDragState}
  >
    <DockRegion
      {edge}
      sizing="flexible"
      emphasis="quiet"
      size="xs"
      density="compact"
      tabVariant="block"
      items={items}
      value={activePanelValue(region, items)}
      ariaLabel={`${label} panels`}
      canAcceptPanel={(panelId) => canMovePanelToRegion(panelId, region)}
      onValueChange={(panelId) => setActivePanel(region, panelId)}
      onClose={(panelId) => closePanel(region, panelId)}
      onReorder={(order) => reorderPanels(region, order)}
      onPanelDrop={({ panel }) => movePanelToRegion(panel.panelId, region)}
    >
      {#snippet children(activeItem)}
        {@render PanelPlaceholder(panelFor(panels, activeItem))}
      {/snippet}
    </DockRegion>
  </section>
{/snippet}

{#snippet PanelPlaceholder(panel: WorkspacePanelDto)}
  {#if panel.kind === "agentChat"}
    <div class="resource-panel-shell">
      {@render ResourceTargetControl(panel)}
      <div class="resource-panel-body">
        <AgentChatPanel
          conversationId={`${selectedProject?.project_id ?? "unselected"}:${panel.id}`}
          projectId={selectedProject?.project_id ?? null}
          resourceId={effectivePanelResourceTarget(panel)}
          activeTask={selectedTask}
          activeGoal={selectedGoal}
          onClearActiveTask={() => (selectedTaskId = null)}
          onClearActiveGoal={() => (selectedGoalId = null)}
        />
      </div>
    </div>
  {:else if panel.kind === "tasks"}
    <TaskListPanel
      selectedProjectId={selectedProject?.project_id ?? null}
      bind:selectedGoalId
      bind:selectedGoal
      bind:selectedTaskId
      bind:selectedTask
    />
  {:else if panel.kind === "editor"}
    <div class="resource-panel-shell">
      {@render ResourceTargetControl(panel)}
      <div class="resource-panel-body">
        <EditorPanel
          projectId={selectedProject?.project_id ?? null}
          resourceId={effectivePanelResourceTarget(panel)}
          requestedFileRef={editorFileRef}
        />
      </div>
    </div>
  {:else if panel.kind === "browser"}
    <BrowserPanel panelId={panel.id} />
  {:else if panel.kind === "terminal"}
    <div class="resource-panel-shell">
      {@render ResourceTargetControl(panel)}
      <div class="resource-panel-body">
        {#key `${selectedProject?.revision_id ?? "unselected"}:${effectivePanelResourceTarget(panel) ?? "host-default"}`}
          <TerminalPanel
            panelId={panel.id}
            projectId={selectedProject?.project_id ?? null}
            resourceId={effectivePanelResourceTarget(panel)}
          />
        {/key}
      </div>
    </div>
  {:else if panel.kind === "diff"}
    <DiffPanel
      projectId={selectedProject?.project_id ?? null}
      task={selectedTask}
      onOpenEditor={openFileInEditor}
      onReviewed={() => focusPanelKind("diff")}
    />
  {:else if panel.kind === "memory"}
    <MemoryPanel projectId={selectedProject?.project_id ?? null} />
  {:else}
    <Surface tone="canvas" border="none" padding="md" asRole="region" label={panel.title}>
      <div class="panel-placeholder">
        {#if panel.kind !== "empty"}
        <Text weight="semibold">{panel.title}</Text>
        <Text tone="muted">{panel.kind}{panel.closeable ? "" : " · system"}</Text>
        {:else}
          <Text tone="muted">Empty</Text>
        {/if}
      </div>
    </Surface>
  {/if}
{/snippet}

{#snippet ResourceTargetControl(panel: WorkspacePanelDto)}
  {#if selectedProject}
    <PanelResourceTargetControl
      project={selectedProject}
      resourceId={panelResourceTarget(panel)}
      onValueChange={(resourceId) => void setPanelResourceTarget(panel, resourceId)}
    />
  {/if}
{/snippet}

<style>
  .workspace-stage-shell {
    display: block;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--poodle-color-background-canvas);
  }

  .window-body {
    position: relative;
    display: block;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .layout-error {
    position: absolute;
    top: 0.25rem;
    right: 0.5rem;
    z-index: 5;
  }

  .region-cell {
    position: relative;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .left-main-frame,
  .center-right-frame,
  .center-stack-frame,
  .right-stack-frame {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  .left-main-frame--single > :global(.poodle-split-view) > :global(.poodle-split-view__divider),
  .center-right-frame--single > :global(.poodle-split-view) > :global(.poodle-split-view__divider),
  .center-stack-frame--single > :global(.poodle-split-view) > :global(.poodle-split-view__divider),
  .right-stack-frame--single > :global(.poodle-split-view) > :global(.poodle-split-view__divider) {
    display: none;
  }

  .region-cell--drop-target::after {
    content: "";
    position: absolute;
    inset: 0.25rem;
    z-index: 4;
    pointer-events: none;
    border: 0.125rem solid var(--poodle-color-accent-base);
    border-radius: var(--poodle-radius-surface);
    background: color-mix(in srgb, var(--poodle-color-accent-base) 9%, transparent);
    box-shadow: inset 0 0 0 0.0625rem
      color-mix(in srgb, var(--poodle-color-accent-base) 42%, transparent);
  }

  .region-cell--drop-hover::after {
    background: color-mix(in srgb, var(--poodle-color-accent-base) 14%, transparent);
    box-shadow:
      inset 0 0 0 0.0625rem color-mix(in srgb, var(--poodle-color-accent-base) 60%, transparent),
      0 0 0 0.0625rem color-mix(in srgb, var(--poodle-color-accent-base) 28%, transparent);
  }

  .workspace-stage-shell :global(.poodle-split-view__divider) {
    position: relative;
    background: transparent;
  }

  .workspace-stage-shell :global(.poodle-split-view__divider[data-orientation="horizontal"]) {
    width: 0.25rem;
  }

  .workspace-stage-shell :global(.poodle-split-view__divider[data-orientation="vertical"]) {
    height: 0.25rem;
  }

  .workspace-stage-shell :global(.poodle-split-view__divider::before) {
    content: "";
    position: absolute;
    border-radius: var(--poodle-radius-pill);
    background: color-mix(in srgb, var(--poodle-color-text-secondary) 7%, transparent);
  }

  .workspace-stage-shell :global(.poodle-split-view__divider[data-orientation="horizontal"]::before) {
    top: 0;
    bottom: 0;
    left: 50%;
    width: 0.0625rem;
    transform: translateX(-50%);
  }

  .workspace-stage-shell :global(.poodle-split-view__divider[data-orientation="vertical"]::before) {
    top: 50%;
    right: 0;
    left: 0;
    height: 0.0625rem;
    transform: translateY(-50%);
  }

  .region-cell :global(.poodle-dock-region__strip[data-orientation="horizontal"]) {
    gap: 0 !important;
    align-items: stretch !important;
    min-height: 1.75rem !important;
    height: 1.75rem !important;
    padding-right: 0 !important;
  }

  .region-cell :global(.poodle-dock-region__tabs) {
    display: flex;
    align-self: stretch;
    height: 100%;
  }

  .region-cell :global(.poodle-tabs[data-variant="block"]) {
    --poodle-tabs-control-height: 1.75rem;
    height: 100%;
  }

  .region-cell :global(.poodle-tabs[data-variant="block"] .poodle-tabs__list) {
    height: 100%;
    padding: 0;
    border-bottom: 0 !important;
  }

  .panel-placeholder {
    display: grid;
    align-content: start;
    gap: var(--poodle-space-stack-sm);
    min-width: 0;
    min-height: 100%;
  }

  .resource-panel-shell,
  .resource-panel-body {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  .resource-panel-body {
    flex: 1;
  }

  @media (max-width: 1040px) {
    .window-body {
      overflow: auto;
    }

    .region-cell {
      min-height: 10rem;
    }
  }
</style>
