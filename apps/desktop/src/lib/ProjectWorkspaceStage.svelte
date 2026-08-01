<script lang="ts">
  import { Surface, Text } from "@poodle/svelte";
  import {
    LayoutDockRegion,
    LayoutSplitView,
    type PanelRenderContext,
  } from "@longhorn/poodle";
  import type { RegionId } from "@longhorn/layout";

  import AgentChatPanel from "./AgentChatPanel.svelte";
  import BrowserPanel from "./BrowserPanel.svelte";
  import DiffPanel from "./DiffPanel.svelte";
  import EditorPanel from "./EditorPanel.svelte";
  import ForgeDiffPanel from "./ForgeDiffPanel.svelte";
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
    WorkspaceLayoutSession,
  } from "./workspaceLayout.svelte";
  import type {
    WorkspaceEditorFile,
    WorkspaceForgeDiff,
    WorkspacePanelPresentation,
    WorkspacePanelPresentationInput,
  } from "./workspaceLayout";

  let {
    selectedProject,
    onOpenPanelKindsChange,
  }: {
    selectedProject: ControlProjectRecordDto | null;
    onOpenPanelKindsChange?: (kinds: string[]) => void;
  } = $props();

  let session = $state.raw<WorkspaceLayoutSession | null>(null);
  let selectedTaskId = $state<string | null>(null);
  let selectedTask = $state<ControlTaskRecordDto | null>(null);
  let selectedGoalId = $state<string | null>(null);
  let selectedGoal = $state<ControlGoalRecordDto | null>(null);
  let panelConversationIds = $state<Record<string, string>>({});
  let layoutDragActive = $state(false);
  let panelSequence = 0;
  let pendingThreadOpen = $state<{
    projectId: string;
    conversationId: string;
  } | null>(null);
  let pendingFileOpen = $state<{
    projectId: string;
    resourceId: string;
    fileRef: string;
    displayPath: string | null;
  } | null>(null);
  let pendingForgeDiffOpen = $state<{
    projectId: string;
    resourceId: string;
    path: string;
    scope: "all" | "staged" | "working";
  } | null>(null);

  const snapshot = $derived(session?.snapshot);
  const binding = $derived(session?.binding);
  const document = $derived(session?.projected);
  const container = $derived(
    document?.containers.find((candidate) => candidate.id === snapshot?.container_id),
  );
  const openPanelKinds = $derived(
    snapshot ? [...new Set(snapshot.panels.map((panel) => panel.kind))] : [],
  );
  const visibleRegions = $derived.by<Record<WorkspaceRegion, boolean>>(() => ({
    left: regionVisible("left"),
    center_top: regionVisible("center_top"),
    center_bottom: regionVisible("center_bottom"),
    right_top: regionVisible("right_top"),
    right_bottom: regionVisible("right_bottom"),
  }));
  const hasCenter = $derived(visibleRegions.center_top || visibleRegions.center_bottom);
  const hasRight = $derived(visibleRegions.right_top || visibleRegions.right_bottom);
  const hasMain = $derived(hasCenter || hasRight);

  $effect(() => {
    const projectId = selectedProject?.project_id ?? null;
    selectedTaskId = null;
    selectedTask = null;
    selectedGoalId = null;
    selectedGoal = null;
    layoutDragActive = false;
    if (!projectId) {
      session = null;
      return;
    }

    const next = new WorkspaceLayoutSession({
      projectId,
      onPanelClosed: cleanUpClosedPanel,
    });
    session = next;
    void next.start().catch((error) => next.reportError(error));
    return () => {
      void next.destroy().catch(() => undefined);
    };
  });

  $effect(() => {
    onOpenPanelKindsChange?.(openPanelKinds);
  });

  $effect(() => {
    const request = pendingThreadOpen;
    if (!request || request.projectId !== selectedProject?.project_id || !snapshot) return;
    pendingThreadOpen = null;
    void openAgentChatThread(request.conversationId);
  });

  $effect(() => {
    const request = pendingFileOpen;
    if (!request || request.projectId !== selectedProject?.project_id || !snapshot) return;
    pendingFileOpen = null;
    void openFileInEditor(request.fileRef, request.resourceId, request.displayPath);
  });

  $effect(() => {
    const request = pendingForgeDiffOpen;
    if (!request || request.projectId !== selectedProject?.project_id || !snapshot) return;
    pendingForgeDiffOpen = null;
    void openForgeDiff(request.resourceId, request.path, request.scope);
  });

  $effect(() => {
    if (!selectedTaskId) selectedTask = null;
    if (!selectedGoalId) selectedGoal = null;
  });

  $effect(() => {
    window.addEventListener("nucleus:create-workspace-panel", handleCreateWorkspacePanel);
    window.addEventListener("nucleus:open-task", handleOpenTask);
    window.addEventListener("nucleus:open-goal", handleOpenGoal);
    window.addEventListener("nucleus:open-file", handleOpenFile);
    window.addEventListener("nucleus:open-forge-diff", handleOpenForgeDiff);
    window.addEventListener("nucleus:open-agent-chat-thread", handleOpenAgentChatThread);
    return () => {
      window.removeEventListener("nucleus:create-workspace-panel", handleCreateWorkspacePanel);
      window.removeEventListener("nucleus:open-task", handleOpenTask);
      window.removeEventListener("nucleus:open-goal", handleOpenGoal);
      window.removeEventListener("nucleus:open-file", handleOpenFile);
      window.removeEventListener("nucleus:open-forge-diff", handleOpenForgeDiff);
      window.removeEventListener("nucleus:open-agent-chat-thread", handleOpenAgentChatThread);
    };
  });

  function handleCreateWorkspacePanel(event: Event): void {
    const kind = event instanceof CustomEvent && typeof event.detail?.kind === "string"
      ? event.detail.kind
      : null;
    if (kind) void addPanel(kind);
  }

  function handleOpenTask(event: Event): void {
    if (!(event instanceof CustomEvent) || event.detail?.projectId !== selectedProject?.project_id) return;
    selectedTaskId = typeof event.detail.taskId === "string" ? event.detail.taskId : null;
    focusPanelKind("tasks");
  }

  function handleOpenGoal(event: Event): void {
    if (!(event instanceof CustomEvent) || event.detail?.projectId !== selectedProject?.project_id) return;
    selectedGoalId = typeof event.detail.goalId === "string" ? event.detail.goalId : null;
    selectedTaskId = typeof event.detail.taskId === "string" ? event.detail.taskId : null;
    focusPanelKind("tasks");
  }

  function handleOpenFile(event: Event): void {
    if (
      !(event instanceof CustomEvent) ||
      typeof event.detail?.projectId !== "string" ||
      typeof event.detail?.resourceId !== "string" ||
      typeof event.detail?.fileRef !== "string"
    ) return;
    pendingFileOpen = {
      projectId: event.detail.projectId,
      resourceId: event.detail.resourceId,
      fileRef: event.detail.fileRef,
      displayPath: typeof event.detail.displayPath === "string" ? event.detail.displayPath : null,
    };
  }

  function handleOpenForgeDiff(event: Event): void {
    if (
      !(event instanceof CustomEvent) ||
      typeof event.detail?.projectId !== "string" ||
      typeof event.detail?.resourceId !== "string" ||
      typeof event.detail?.path !== "string" ||
      !["all", "staged", "working"].includes(event.detail?.scope)
    ) return;
    pendingForgeDiffOpen = {
      projectId: event.detail.projectId,
      resourceId: event.detail.resourceId,
      path: event.detail.path,
      scope: event.detail.scope,
    };
  }

  function handleOpenAgentChatThread(event: Event): void {
    if (
      !(event instanceof CustomEvent) ||
      typeof event.detail?.projectId !== "string" ||
      typeof event.detail?.conversationId !== "string"
    ) return;
    pendingThreadOpen = {
      projectId: event.detail.projectId,
      conversationId: event.detail.conversationId,
    };
  }

  async function openAgentChatThread(conversationId: string): Promise<void> {
    if (!session || !snapshot || !selectedProject) return;
    const projectId = selectedProject.project_id;
    const candidates = snapshot.panels.filter((panel) => panel.kind === "agentChat");
    const panel = candidates.find(
      (candidate) => defaultConversationId(projectId, candidate) === conversationId,
    ) ?? candidates[0] ?? await addPanel("agentChat");
    if (!panel) return;
    panelConversationIds = {
      ...panelConversationIds,
      [panelConversationKey(projectId, panel)]: conversationId,
    };
    session.binding?.activate(panel.panel_instance_id);
  }

  function focusPanelKind(kind: string): void {
    const panel = snapshot?.panels.find((candidate) => candidate.kind === kind);
    if (panel) session?.binding?.activate(panel.panel_instance_id);
  }

  async function openFileInEditor(
    fileRef: string,
    resourceId: string | null = null,
    displayPath: string | null = null,
  ): Promise<void> {
    if (!session || !snapshot) return;
    const editorFile: WorkspaceEditorFile = {
      resource_id: resourceId,
      file_ref: fileRef,
      display_path: displayPath,
    };
    let editor = snapshot.panels.find(
      (panel) => panel.kind === "editor" && (!resourceId || effectivePanelResourceTarget(panel) === resourceId),
    ) ?? null;
    if (!editor) {
      editor = await addPanel("editor", resourceId, editorFile);
      if (!editor) return;
    } else {
      const resourceTargets = { ...editor.resource_targets };
      const projectId = selectedProject?.project_id;
      if (projectId && resourceId) resourceTargets[projectId] = resourceId;
      await session.updatePanel(editor.panel_instance_id, {
        ...toInput(editor),
        resource_targets: resourceTargets,
        editor_file: editorFile,
      });
    }
    session.binding?.activate(editor.panel_instance_id);
  }

  async function openForgeDiff(
    resourceId: string,
    path: string,
    scope: "all" | "staged" | "working",
  ): Promise<void> {
    if (!session || !snapshot || !selectedProject) return;
    const target: WorkspaceForgeDiff = { resource_id: resourceId, path, scope };
    let panel = snapshot.panels.find((candidate) => candidate.kind === "forgeDiff") ?? null;
    if (!panel) {
      panel = await addPanel("forgeDiff", resourceId, null, target);
      if (!panel) return;
    } else {
      await session.updatePanel(panel.panel_instance_id, {
        ...toInput(panel),
        resource_targets: { ...panel.resource_targets, [selectedProject.project_id]: resourceId },
        forge_diff: target,
      });
    }
    session.binding?.activate(panel.panel_instance_id);
  }

  async function addPanel(
    kind: string,
    resourceId: string | null = null,
    editorFile: WorkspaceEditorFile | null = null,
    forgeDiff: WorkspaceForgeDiff | null = null,
  ): Promise<WorkspacePanelPresentation | null> {
    if (!session || !snapshot) return null;
    if (kind === "tasks") {
      const existing = snapshot.panels.find((panel) => panel.kind === "tasks");
      if (existing) {
        session.binding?.activate(existing.panel_instance_id);
        return existing;
      }
    }
    panelSequence += 1;
    const count = snapshot.panels.filter((panel) => panel.kind === kind).length + 1;
    const projectId = selectedProject?.project_id;
    const resourceTargets: Record<string, string> = {};
    if (projectId && resourceId) resourceTargets[projectId] = resourceId;
    const label = panelLabel(kind);
    const input: WorkspacePanelPresentationInput = {
      external_id: `window:primary:panel:${kind}:${Date.now()}:${panelSequence}`,
      kind,
      title: count === 1 ? label : `${label} ${count}`,
      resource_targets: resourceTargets,
      editor_file: kind === "editor" ? editorFile : null,
      forge_diff: kind === "forgeDiff" ? forgeDiff : null,
    };
    try {
      return await session.createPanel(input);
    } catch (error) {
      session.reportError(error);
      return null;
    }
  }

  async function setPanelResourceTarget(
    panel: WorkspacePanelPresentation,
    resourceId: string | null,
  ): Promise<void> {
    const projectId = selectedProject?.project_id;
    if (!session || !projectId) return;
    if (panel.kind === "terminal") {
      try {
        await closeTerminalPanel(projectId, panel.external_id);
      } catch (error) {
        session.reportError(error);
        return;
      }
    }
    const resourceTargets = { ...panel.resource_targets };
    if (resourceId) resourceTargets[projectId] = resourceId;
    else delete resourceTargets[projectId];
    await session.updatePanel(panel.panel_instance_id, {
      ...toInput(panel),
      resource_targets: resourceTargets,
      editor_file: panel.kind === "editor" ? null : panel.editor_file,
    });
  }

  function persistEditorFile(
    panelInstanceId: string,
    opened: { resourceId: string; fileRef: string; displayPath: string },
  ): void {
    const projectId = selectedProject?.project_id;
    const panel = session?.panel(panelInstanceId);
    if (!session || !panel || !projectId) return;
    const editorFile: WorkspaceEditorFile = {
      resource_id: opened.resourceId,
      file_ref: opened.fileRef,
      display_path: opened.displayPath,
    };
    if (
      panel.editor_file?.resource_id === editorFile.resource_id &&
      panel.editor_file.file_ref === editorFile.file_ref &&
      panel.editor_file.display_path === editorFile.display_path &&
      panel.resource_targets[projectId] === opened.resourceId
    ) return;
    void session.updatePanel(panel.panel_instance_id, {
      ...toInput(panel),
      resource_targets: { ...panel.resource_targets, [projectId]: opened.resourceId },
      editor_file: editorFile,
    });
  }

  function cleanUpClosedPanel(panel: WorkspacePanelPresentation): void {
    if (panel.kind === "browser") {
      void destroyBrowserWebview(panel.external_id).catch((error) => session?.reportError(error));
    } else if (panel.kind === "terminal" && selectedProject?.project_id) {
      void closeTerminalPanel(selectedProject.project_id, panel.external_id)
        .catch((error) => session?.reportError(error));
    }
  }

  function beginLayoutDrag(): void {
    layoutDragActive = true;
    window.dispatchEvent(new CustomEvent("nucleus:native-panels-hide"));
  }

  function endLayoutDrag(): void {
    layoutDragActive = false;
    window.dispatchEvent(new CustomEvent("nucleus:native-panels-show"));
  }

  function regionVisible(regionId: WorkspaceRegion): boolean {
    return layoutDragActive || Boolean(
      container?.regions.find((region) => region.region_id === regionId)?.panel_instance_ids.length,
    );
  }

  function panelFromContext(context: PanelRenderContext): WorkspacePanelPresentation | null {
    return session?.panel(context.instance.id) ?? null;
  }

  function resolvePanel(instance: { id: string }) {
    return session?.presentation(instance.id) ?? null;
  }

  function panelResourceTarget(panel: WorkspacePanelPresentation): string | null {
    const projectId = selectedProject?.project_id;
    return projectId ? panel.resource_targets[projectId] ?? null : null;
  }

  function effectivePanelResourceTarget(panel: WorkspacePanelPresentation): string | null {
    const explicit = panelResourceTarget(panel);
    if (explicit || !selectedProject) return explicit;
    if (selectedProject.default_working_resource_id) return selectedProject.default_working_resource_id;
    const available = selectedProject.resources.filter(
      (resource) =>
        resource.role === "working" &&
        resource.location_status === "present" &&
        resource.locator_available,
    );
    return available.length === 1 ? available[0].resource_id : null;
  }

  function panelConversationId(panel: WorkspacePanelPresentation): string {
    const projectId = selectedProject?.project_id ?? "unselected";
    return panelConversationIds[panelConversationKey(projectId, panel)]
      ?? defaultConversationId(projectId, panel);
  }

  function panelConversationKey(projectId: string, panel: WorkspacePanelPresentation): string {
    return `${projectId}:${panel.external_id}`;
  }

  function defaultConversationId(projectId: string, panel: WorkspacePanelPresentation): string {
    return `${projectId}:${panel.external_id}`;
  }

  function toInput(panel: WorkspacePanelPresentation): WorkspacePanelPresentationInput {
    return {
      external_id: panel.external_id,
      kind: panel.kind,
      title: panel.title,
      resource_targets: { ...panel.resource_targets },
      editor_file: panel.editor_file,
      forge_diff: panel.forge_diff,
    };
  }

  function panelLabel(kind: string): string {
    switch (kind) {
      case "agentChat": return "Agent Chat";
      case "tasks": return "Tasks";
      case "terminal": return "Terminal";
      case "browser": return "Browser";
      case "editor": return "Editor";
      case "diff": return "Diff";
      case "forgeDiff": return "Changes";
      case "memory": return "Memory";
      default: return "Panel";
    }
  }

  function statusMessage(): string {
    const status = session?.status;
    if (!selectedProject) return "Select a project";
    if (!status || status.kind === "idle" || status.kind === "loading") return "Loading workspace";
    if (status.kind === "reconnecting") return "Reconnecting workspace";
    if (status.kind === "unsupported") return status.reason;
    if (status.kind === "failed") return formatError(status.error);
    return "Workspace unavailable";
  }

  function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  type WorkspaceRegion = "left" | "center_top" | "center_bottom" | "right_top" | "right_bottom";
</script>

<section
  class="workspace-stage-shell"
  aria-label="Workspace"
  ondragstart={beginLayoutDrag}
  ondragend={endLayoutDrag}
  ondrop={endLayoutDrag}
>
  {#if !binding || !snapshot || !container || !session}
    <Surface tone="canvas" border="none" padding="md" asRole="region" label="Workspace status">
      <Text tone={session?.status.kind === "failed" ? "danger" : "muted"}>{statusMessage()}</Text>
      {#if session?.status.kind === "failed"}
        <button type="button" class="retry" onclick={() => void session?.reconnect()}>Retry</button>
      {/if}
    </Surface>
  {:else}
    <div class="window-body">
      {#if session.status.kind === "failed"}
        <div class="layout-error"><Text size="xs" tone="danger">{statusMessage()}</Text></div>
      {/if}
      <LayoutSplitView
        {binding}
        containerId={snapshot.container_id}
        sizingSlotId="left-center"
        primaryHidden={!visibleRegions.left}
        secondaryHidden={!hasMain}
        ariaLabel="Left and main workspace regions"
        size="xs"
        density="compact"
      >
        {#snippet primary()}
          {@render RegionShell("left", "left", "left")}
        {/snippet}
        {#snippet secondary()}
          {@render MainRegions()}
        {/snippet}
      </LayoutSplitView>
      {#if !visibleRegions.left && !hasMain}
        <Surface tone="canvas" border="none" padding="md" asRole="region" label="Empty workspace">
          <Text tone="muted">No panels open</Text>
        </Surface>
      {/if}
    </div>
  {/if}
</section>

{#snippet MainRegions()}
  {#if binding && snapshot}
    <LayoutSplitView
      {binding}
      containerId={snapshot.container_id}
      sizingSlotId="center-right"
      primaryHidden={!hasCenter}
      secondaryHidden={!hasRight}
      ariaLabel="Center and right workspace regions"
      size="xs"
      density="compact"
    >
      {#snippet primary()}{@render CenterRegions()}{/snippet}
      {#snippet secondary()}{@render RightRegions()}{/snippet}
    </LayoutSplitView>
  {/if}
{/snippet}

{#snippet CenterRegions()}
  {#if binding && snapshot}
    <LayoutSplitView
      {binding}
      containerId={snapshot.container_id}
      sizingSlotId="center-stack"
      orientation="vertical"
      secondaryRegionId="center_bottom"
      primaryHidden={!visibleRegions.center_top}
      secondaryHidden={!visibleRegions.center_bottom}
      ariaLabel="Center top and center bottom workspace regions"
      size="xs"
      density="compact"
    >
      {#snippet primary()}{@render RegionShell("centerTop", "top", "center_top")}{/snippet}
      {#snippet secondary()}{@render RegionShell("centerBottom", "bottom", "center_bottom")}{/snippet}
    </LayoutSplitView>
  {/if}
{/snippet}

{#snippet RightRegions()}
  {#if binding && snapshot}
    <LayoutSplitView
      {binding}
      containerId={snapshot.container_id}
      sizingSlotId="right-stack"
      orientation="vertical"
      primaryRegionId="right_top"
      secondaryRegionId="right_bottom"
      primaryHidden={!visibleRegions.right_top}
      secondaryHidden={!visibleRegions.right_bottom}
      ariaLabel="Right top and right bottom workspace regions"
      size="xs"
      density="compact"
    >
      {#snippet primary()}{@render RegionShell("rightTop", "top", "right_top")}{/snippet}
      {#snippet secondary()}{@render RegionShell("rightBottom", "bottom", "right_bottom")}{/snippet}
    </LayoutSplitView>
  {/if}
{/snippet}

{#snippet RegionShell(label: string, edge: "left" | "right" | "top" | "bottom", regionId: RegionId)}
  {#if binding && snapshot && session}
    <section class="region-cell" aria-label={`${label} region`}>
      <LayoutDockRegion
        {binding}
        containerId={snapshot.container_id}
        {regionId}
        {edge}
        resolvePanel={resolvePanel}
        ariaLabel={`${label} panels`}
        sizing="flexible"
        emphasis="quiet"
        size="xs"
        density="compact"
        tabVariant="block"
      >
        {#snippet body(context)}
          {@const panel = panelFromContext(context)}
          {#if panel}{@render PanelBody(panel)}{/if}
        {/snippet}
      </LayoutDockRegion>
    </section>
  {/if}
{/snippet}

{#snippet PanelBody(panel: WorkspacePanelPresentation)}
  {#if panel.kind === "agentChat"}
    <div class="resource-panel-shell">
      {@render ResourceTargetControl(panel)}
      <div class="resource-panel-body">
        <AgentChatPanel
          conversationId={panelConversationId(panel)}
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
          requestedFileRef={panel.editor_file?.file_ref ?? null}
          requestedFilePath={panel.editor_file?.display_path ?? null}
          onFileOpen={(opened) => persistEditorFile(panel.panel_instance_id, opened)}
        />
      </div>
    </div>
  {:else if panel.kind === "browser"}
    <BrowserPanel panelId={panel.external_id} />
  {:else if panel.kind === "terminal"}
    <div class="resource-panel-shell">
      {@render ResourceTargetControl(panel)}
      <div class="resource-panel-body">
        {#key `${selectedProject?.revision_id ?? "unselected"}:${effectivePanelResourceTarget(panel) ?? "host-default"}`}
          <TerminalPanel
            panelId={panel.external_id}
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
      onOpenEditor={(fileRef) => void openFileInEditor(fileRef)}
      onReviewed={() => focusPanelKind("diff")}
    />
  {:else if panel.kind === "forgeDiff"}
    <ForgeDiffPanel
      projectId={selectedProject?.project_id ?? null}
      resourceId={panel.forge_diff?.resource_id ?? null}
      path={panel.forge_diff?.path ?? null}
      scope={panel.forge_diff?.scope ?? "all"}
      onOpenEditor={(fileRef, resourceId, path) => void openFileInEditor(fileRef, resourceId, path)}
    />
  {:else if panel.kind === "memory"}
    <MemoryPanel projectId={selectedProject?.project_id ?? null} />
  {:else}
    <Surface tone="canvas" border="none" padding="md" asRole="region" label={panel.title}>
      <div class="panel-placeholder">
        <Text weight="semibold">{panel.title}</Text>
        <Text tone="muted">{panel.kind}</Text>
      </div>
    </Surface>
  {/if}
{/snippet}

{#snippet ResourceTargetControl(panel: WorkspacePanelPresentation)}
  {#if selectedProject}
    <PanelResourceTargetControl
      project={selectedProject}
      resourceId={panelResourceTarget(panel)}
      onValueChange={(resourceId) => void setPanelResourceTarget(panel, resourceId)}
    />
  {/if}
{/snippet}

<style>
  .workspace-stage-shell,
  .window-body,
  .region-cell {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .workspace-stage-shell {
    display: block;
    background: var(--poodle-color-background-canvas);
  }

  .window-body {
    position: relative;
  }

  .layout-error {
    position: absolute;
    top: 0.25rem;
    right: 0.5rem;
    z-index: 5;
  }

  .retry {
    margin-top: 0.75rem;
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
</style>
