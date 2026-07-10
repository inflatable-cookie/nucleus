<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    DockRegion,
    IconButton,
    Surface,
    SplitView,
    Tabs,
    Text,
    type DockEdge,
    type PanelTabItem,
    type TabItem,
  } from "@poodle/svelte";
  import { pencil, plus } from "@poodle/icons-lucide";
  import AgentChatPanel from "./AgentChatPanel.svelte";
  import TaskListPanel from "./TaskListPanel.svelte";
  import type {
    ControlGoalRecordDto,
    ControlProjectRecordDto,
    ControlTaskRecordDto,
  } from "./control";
  import {
    createWorkspaceSurface,
    createWorkspacePanel,
    defaultRegionForPanelKind,
    loadWorkspaceUiConfig,
    saveWorkspaceUiConfig,
    type RegionKey,
    type WorkspacePanelDto,
    type WorkspaceSurfaceDto,
    type WorkspaceUiConfigDto,
  } from "./workspaceUi";

  let { selectedProject }: { selectedProject: ControlProjectRecordDto | null } = $props();

  let config = $state<WorkspaceUiConfigDto | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let draggedPanelId = $state<string | null>(null);
  let dropTargetRegion = $state<RegionKey | null>(null);
  let activePanels = $state<Record<RegionKey, string | null>>({
    left: null,
    right: null,
    center_top: null,
    center_bottom: null,
  });
  let selectedTaskId = $state<string | null>(null);
  let selectedTask = $state<ControlTaskRecordDto | null>(null);
  let selectedGoalId = $state<string | null>(null);
  let selectedGoal = $state<ControlGoalRecordDto | null>(null);

  const activeSurface = $derived(
    config?.surfaces.find((surface) => surface.id === config?.active_surface_id) ??
      config?.surfaces[0] ??
      null,
  );
  const surfaceTabs = $derived<TabItem[]>(
    config?.surfaces.map((surface) => ({
      value: surface.id,
      label: surface.title,
      icon: "layout-panel-top",
      closable: (config?.surfaces.length ?? 0) > 1,
    })) ?? [],
  );
  const panelDropTargetRegions = $derived.by<Set<RegionKey>>(() => {
    const panelId = draggedPanelId;
    if (!panelId) {
      return new Set();
    }

    return new Set(
      regionKeys().filter((region) => canDropPanelInRegion(panelId, region)),
    );
  });
  const visibleRegions = $derived.by<Record<RegionKey, boolean>>(() => ({
    left: regionShouldRender("left"),
    right: regionShouldRender("right"),
    center_top: regionShouldRender("center_top"),
    center_bottom: regionShouldRender("center_bottom"),
  }));
  const hasLeftRegion = $derived(visibleRegions.left);

  onMount(() => {
    void loadConfig();
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
    selectedProject?.project_id;
    selectedTaskId = null;
    selectedTask = null;
    selectedGoalId = null;
    selectedGoal = null;
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

  async function loadConfig(): Promise<void> {
    loading = true;
    error = null;

    try {
      config = await loadWorkspaceUiConfig();
    } catch (caught) {
      error = formatError(caught);
    } finally {
      loading = false;
    }
  }

  async function persist(nextConfig: WorkspaceUiConfigDto): Promise<void> {
    config = nextConfig;
    error = null;

    try {
      config = await saveWorkspaceUiConfig(nextConfig);
    } catch (caught) {
      error = formatError(caught);
    }
  }

  function persistLayout(nextConfig: WorkspaceUiConfigDto): void {
    config = nextConfig;
    error = null;

    if (layoutPersistTimer) {
      clearTimeout(layoutPersistTimer);
    }

    layoutPersistTimer = setTimeout(() => {
      layoutPersistTimer = null;
      void saveWorkspaceUiConfig(nextConfig).catch((caught) => {
        error = formatError(caught);
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
    if (!activeSurface) {
      return;
    }
    for (const region of regionKeys()) {
      const panel = activeSurface.regions[region].find((candidate) => candidate.kind === kind);
      if (panel) {
        activePanels = { ...activePanels, [region]: panel.id };
        return;
      }
    }
  }

  function handlePanelDragStart(event: DragEvent, sourceRegion: RegionKey): void {
    if (!event.dataTransfer || !activeSurface) {
      return;
    }

    const tab = (event.target as HTMLElement | null)?.closest?.("[role='tab']");
    const panel = tab
      ? activeSurface.regions[sourceRegion].find((candidate) =>
          tab.id.endsWith(`-${candidate.id}`),
        )
      : null;

    if (!panel?.movable) {
      return;
    }

    draggedPanelId = panel.id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "application/x-nucleus-workspace-panel-drag",
      JSON.stringify({ panelId: panel.id, sourceRegion }),
    );
  }

  function handleRegionDragOver(event: DragEvent, targetRegion: RegionKey): void {
    const panelId = currentDraggedPanelId(event);
    if (!panelId) {
      return;
    }

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
    dropTargetRegion = null;
  }

  function setActiveSurface(surfaceId: string): void {
    if (!config || config.active_surface_id === surfaceId) {
      return;
    }

    void persist({
      ...config,
      active_surface_id: surfaceId,
    });
  }

  function addSurface(): void {
    if (!config) {
      return;
    }

    const nextSurface = createWorkspaceSurface(config.surfaces.length + 1);
    void persist({
      ...config,
      active_surface_id: nextSurface.id,
      surfaces: [...config.surfaces, nextSurface],
    });
  }

  function addPanel(kind: string): void {
    if (!config || !activeSurface) {
      return;
    }

    const targetRegion = defaultRegionForPanelKind(kind);
    const existingCount = regionKeys()
      .flatMap((region) => activeSurface.regions[region])
      .filter((panel) => panel.kind === kind).length;
    const panel = createWorkspacePanel(activeSurface.id, kind, existingCount + 1);

    activePanels = {
      ...activePanels,
      [targetRegion]: panel.id,
    };

    void persist({
      ...config,
      surfaces: config.surfaces.map((surface) =>
        surface.id === activeSurface.id
          ? {
              ...surface,
              regions: {
                ...surface.regions,
                [targetRegion]: [...surface.regions[targetRegion], panel],
              },
            }
          : surface,
      ),
    });
  }

  function promptRenameActiveSurface(): void {
    if (!activeSurface) {
      return;
    }

    const nextTitle = window.prompt("Rename surface", activeSurface.title);
    if (nextTitle === null) {
      return;
    }

    renameActiveSurface(nextTitle);
  }

  function renameActiveSurface(nextTitle: string): void {
    if (!config || !activeSurface) {
      return;
    }

    const title = nextTitle.trim() || "Untitled";
    void persist({
      ...config,
      surfaces: config.surfaces.map((surface) =>
        surface.id === activeSurface.id ? { ...surface, title } : surface,
      ),
    });
  }

  function removeSurface(surfaceId: string): void {
    if (!config || config.surfaces.length <= 1) {
      return;
    }

    const surfaces = config.surfaces.filter((surface) => surface.id !== surfaceId);
    void persist({
      ...config,
      active_surface_id:
        config.active_surface_id === surfaceId ? surfaces[0].id : config.active_surface_id,
      surfaces,
    });
  }

  function reorderSurfaces(order: string[]): void {
    if (!config) {
      return;
    }

    const surfacesById = new Map(config.surfaces.map((surface) => [surface.id, surface]));
    const surfaces = order
      .map((surfaceId) => surfacesById.get(surfaceId))
      .filter((surface): surface is WorkspaceSurfaceDto => Boolean(surface));

    if (surfaces.length !== config.surfaces.length) {
      return;
    }

    void persist({
      ...config,
      surfaces,
    });
  }

  function panelsFor(surface: WorkspaceSurfaceDto, region: RegionKey): WorkspacePanelDto[] {
    return surface.regions[region];
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
    const saved = activePanels[region];
    return items.some((item) => item.value === saved) ? saved : items[0]?.value ?? null;
  }

  function setActivePanel(region: RegionKey, panelId: string): void {
    activePanels = {
      ...activePanels,
      [region]: panelId,
    };
  }

  function closePanel(region: RegionKey, panelId: string): void {
    if (!config || !activeSurface) {
      return;
    }

    const panels = panelsFor(activeSurface, region);
    const panel = panels.find((candidate) => candidate.id === panelId);
    if (!panel?.closeable) {
      return;
    }

    void persist({
      ...config,
      surfaces: config.surfaces.map((surface) =>
        surface.id === activeSurface.id
          ? {
              ...surface,
              regions: {
                ...surface.regions,
                [region]: panels.filter((candidate) => candidate.id !== panelId),
              },
            }
          : surface,
      ),
    });
  }

  function reorderPanels(region: RegionKey, order: string[]): void {
    if (!config || !activeSurface) {
      return;
    }

    const panels = panelsFor(activeSurface, region);
    const panelsById = new Map(panels.map((panel) => [panel.id, panel]));
    const reorderedPanels = order
      .map((panelId) => panelsById.get(panelId))
      .filter((panel): panel is WorkspacePanelDto => Boolean(panel));

    if (reorderedPanels.length !== panels.length) {
      return;
    }

    void persist({
      ...config,
      surfaces: config.surfaces.map((surface) =>
        surface.id === activeSurface.id
          ? {
              ...surface,
              regions: {
                ...surface.regions,
                [region]: reorderedPanels,
              },
            }
          : surface,
      ),
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
    if (!config || !activeSurface || !canMovePanelToRegion(panelId, targetRegion)) {
      return;
    }

    const sourceRegion = findPanelRegion(panelId);
    if (!sourceRegion || sourceRegion === targetRegion) {
      return;
    }

    const panel = activeSurface.regions[sourceRegion].find(
      (candidate) => candidate.id === panelId,
    );
    if (!panel) {
      return;
    }

    const nextRegions = {
      ...activeSurface.regions,
      [sourceRegion]: activeSurface.regions[sourceRegion].filter(
        (candidate) => candidate.id !== panelId,
      ),
      [targetRegion]: [...activeSurface.regions[targetRegion], panel],
    };

    activePanels = {
      ...activePanels,
      [sourceRegion]: activePanels[sourceRegion] === panelId ? null : activePanels[sourceRegion],
      [targetRegion]: panelId,
    };

    void persist({
      ...config,
      surfaces: config.surfaces.map((surface) =>
        surface.id === activeSurface.id ? { ...surface, regions: nextRegions } : surface,
      ),
    });
  }

  function updateActiveSurfaceLayout(
    patch: Partial<WorkspaceSurfaceDto["layout"]>,
  ): void {
    if (!config || !activeSurface) {
      return;
    }

    persistLayout({
      ...config,
      surfaces: config.surfaces.map((surface) =>
        surface.id === activeSurface.id
          ? {
              ...surface,
              layout: {
                ...surface.layout,
                ...patch,
              },
            }
          : surface,
      ),
    });
  }

  function findPanel(panelId: string): WorkspacePanelDto | null {
    if (!activeSurface) {
      return null;
    }

    const region = findPanelRegion(panelId);
    return region
      ? activeSurface.regions[region].find((panel) => panel.id === panelId) ?? null
      : null;
  }

  function findPanelRegion(panelId: string): RegionKey | null {
    if (!activeSurface) {
      return null;
    }

    for (const region of regionKeys()) {
      if (activeSurface.regions[region].some((panel) => panel.id === panelId)) {
        return region;
      }
    }

    return null;
  }

  function regionKeys(): RegionKey[] {
    return ["left", "right", "center_top", "center_bottom"];
  }

  function regionShouldRender(region: RegionKey): boolean {
    return (
      (activeSurface?.regions[region].length ?? 0) > 0 ||
      panelDropTargetRegions.has(region)
    );
  }

  function panelFor(panels: WorkspacePanelDto[], activeItem: PanelTabItem | null): WorkspacePanelDto | null {
    return panels.find((panel) => panel.id === activeItem?.value) ?? panels[0] ?? null;
  }

  function iconForPanel(kind: string): string {
    switch (kind) {
      case "agentChat":
        return "message-square-text";
      case "tasks":
        return "list-checks";
      case "terminal":
        return "terminal";
      case "context":
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
  {#if loading}
    <Surface tone="canvas" border="none" padding="md" asRole="region" label="Workspace loading">
      <Text tone="muted">Loading workspace</Text>
    </Surface>
  {:else if !config || !activeSurface}
    <Surface tone="canvas" border="none" padding="md" asRole="region" label="Workspace unavailable">
      <Text tone="muted">Workspace unavailable</Text>
    </Surface>
  {:else}
    <div class="surface-tabs-shell">
      <Tabs
        items={surfaceTabs}
        value={activeSurface.id}
        variant="block"
        reorderable
        ariaLabel="Workspace surfaces"
        onValueChange={setActiveSurface}
        onClose={removeSurface}
        onReorder={reorderSurfaces}
      >
        {#snippet actions()}
          {#if error}
            <Text as="span" size="xs" tone="danger">{error}</Text>
          {/if}
          <IconButton
            variant="ghost"
            size="xs"
            icon={pencil}
            ariaLabel="Rename active surface"
            tooltip="Rename surface"
            onClick={promptRenameActiveSurface}
          />
          <IconButton
            variant="secondary"
            size="xs"
            icon={plus}
            ariaLabel="Create surface"
            tooltip="Create surface"
            onClick={addSurface}
          />
        {/snippet}
      </Tabs>
    </div>

    <div class="surface-body">
      {#if hasLeftRegion}
        <SplitView
          orientation="horizontal"
          ratio={activeSurface.layout.left_center_ratio}
          minPrimarySize={140}
          minSecondarySize={240}
          ariaLabel="Left and main workspace regions"
          onRatioChange={(ratio) =>
            updateActiveSurfaceLayout({ left_center_ratio: ratio })}
        >
          {#snippet primary()}
            {@render RegionShell("left", "left", activeSurface, "left")}
          {/snippet}
          {#snippet secondary()}
            {@render MainRegions(activeSurface)}
          {/snippet}
        </SplitView>
      {:else}
        {@render MainRegions(activeSurface)}
      {/if}
    </div>
  {/if}
</section>

{#snippet MainRegions(surface: WorkspaceSurfaceDto)}
  {@const centerVisible = visibleRegions.center_top || visibleRegions.center_bottom}
  {@const rightVisible = visibleRegions.right}
  {#if !centerVisible && !rightVisible}
    <Surface tone="canvas" border="none" padding="md" asRole="region" label="Empty workspace">
      <Text tone="muted">No panels open</Text>
    </Surface>
  {:else}
    <div
      class="center-right-frame"
      class:center-right-frame--single={!centerVisible || !rightVisible}
    >
      <SplitView
        orientation="horizontal"
        ratio={surface.layout.center_right_ratio}
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
          updateActiveSurfaceLayout({ center_right_ratio: ratio })}
      >
        {#snippet primary()}
          {@render CenterRegions(surface)}
        {/snippet}

        {#snippet secondary()}
          {@render RegionShell("right", "right", surface, "right")}
        {/snippet}
      </SplitView>
    </div>
  {/if}
{/snippet}

{#snippet CenterRegions(surface: WorkspaceSurfaceDto)}
  {@const topVisible = visibleRegions.center_top}
  {@const bottomVisible = visibleRegions.center_bottom}
  {#if topVisible || bottomVisible}
    <div
      class="center-stack-frame"
      class:center-stack-frame--single={!topVisible || !bottomVisible}
    >
    <SplitView
      orientation="vertical"
      ratio={surface.layout.center_stack_ratio}
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
        updateActiveSurfaceLayout({ center_stack_ratio: ratio })}
    >
      {#snippet primary()}
        {@render RegionShell("centerTop", "top", surface, "center_top")}
      {/snippet}
      {#snippet secondary()}
        {@render RegionShell("centerBottom", "bottom", surface, "center_bottom")}
      {/snippet}
    </SplitView>
    </div>
  {/if}
{/snippet}

{#snippet RegionShell(label: string, edge: DockEdge, surface: WorkspaceSurfaceDto, region: RegionKey)}
  {@const panels = panelsFor(surface, region)}
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

{#snippet PanelPlaceholder(panel: WorkspacePanelDto | null)}
  {#if panel?.kind === "agentChat"}
    <AgentChatPanel
      conversationId={`${selectedProject?.project_id ?? "unselected"}:${panel.id}`}
      projectId={selectedProject?.project_id ?? null}
      activeTask={selectedTask}
      activeGoal={selectedGoal}
      onClearActiveTask={() => (selectedTaskId = null)}
      onClearActiveGoal={() => (selectedGoalId = null)}
    />
  {:else if panel?.kind === "tasks"}
    <TaskListPanel
      selectedProjectId={selectedProject?.project_id ?? null}
      bind:selectedGoalId
      bind:selectedGoal
      bind:selectedTaskId
      bind:selectedTask
    />
  {:else}
    <Surface tone="canvas" border="none" padding="md" asRole="region" label={panel?.title ?? "Empty panel"}>
      <div class="panel-placeholder">
        {#if panel}
        <Text weight="semibold">{panel.title}</Text>
        <Text tone="muted">{panel.kind}{panel.closeable ? "" : " · system"}</Text>
        {:else}
          <Text tone="muted">Empty</Text>
        {/if}
      </div>
    </Surface>
  {/if}
{/snippet}

<style>
  .workspace-stage-shell {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--poodle-color-background-canvas);
  }

  .surface-tabs-shell {
    min-width: 0;
    border-bottom: 1px solid var(--poodle-color-border-subtle);
  }

  .surface-body {
    display: block;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .region-cell {
    position: relative;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .center-right-frame,
  .center-stack-frame {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  .center-right-frame--single :global(.poodle-split-view__divider),
  .center-stack-frame--single :global(.poodle-split-view__divider) {
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

  .region-cell :global(.poodle-tabs[data-variant="strip"]) {
    --poodle-tabs-control-height: 1.75rem !important;
    --poodle-tabs-strip-inline-padding: 0 !important;
    --poodle-tabs-strip-tab-x: 0.5rem !important;
    height: 100%;
  }

  .region-cell :global(.poodle-tabs[data-variant="strip"] .poodle-tabs__list) {
    height: 100%;
    padding: 0 !important;
    border-bottom: 0 !important;
  }

  .region-cell :global(.poodle-tabs[data-variant="strip"] .poodle-tabs__tab) {
    min-height: 1.75rem !important;
  }

  .panel-placeholder {
    display: grid;
    align-content: start;
    gap: var(--poodle-space-stack-sm);
    min-width: 0;
    min-height: 100%;
  }

  @media (max-width: 1040px) {
    .surface-body {
      overflow: auto;
    }

    .region-cell {
      min-height: 10rem;
    }
  }
</style>
