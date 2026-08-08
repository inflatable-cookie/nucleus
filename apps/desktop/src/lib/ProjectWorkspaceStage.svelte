<script lang="ts">
  import { Button, Surface, Text } from "@inflatable-cookie/poodle-svelte";
  import {
    LayoutDockRegion,
    LayoutSplitView,
    type PanelRenderContext,
  } from "@inflatable-cookie/longhorn-poodle";
  import type { RegionId } from "@inflatable-cookie/longhorn-layout";

  import AgentChatPanel from "./AgentChatPanel.svelte";
  import BrowserPanel from "./BrowserPanel.svelte";
  import DiffPanel from "./DiffPanel.svelte";
  import EditorPanel from "./EditorPanel.svelte";
  import ForgeDiffPanel from "./ForgeDiffPanel.svelte";
  import MemoryPanel from "./MemoryPanel.svelte";
  import PanelResourceTargetControl from "./PanelResourceTargetControl.svelte";
  import { effectiveResourceTarget } from "./resourceTargetSupport";
  import TaskListPanel from "./TaskListPanel.svelte";
  import TerminalPanel from "./TerminalPanel.svelte";
  import { destroyBrowserIsland } from "./browserPanel";
  import { closeTerminalPanel } from "./terminalClient";
  import {
    buildStateListQuery,
    goalRecordsFromResponse,
    submitControlEnvelope,
    taskRecordsFromResponse,
    type ControlGoalRecordDto,
    type ControlProjectRecordDto,
    type ControlTaskRecordDto,
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
  import type { AgentChatDefaults } from "./settings/client";
  import {
    REVIEW_REWORK_PROMPT,
    type AgentChatDraftRequest,
  } from "./reviewRework";

  let {
    selectedProject,
    selectedConversationId = $bindable(null),
    agentChatDefaults,
    onOpenPanelKindsChange,
    onCommandContextChange,
  }: {
    selectedProject: ControlProjectRecordDto | null;
    selectedConversationId: string | null;
    agentChatDefaults: AgentChatDefaults;
    onOpenPanelKindsChange?: (kinds: string[]) => void;
    onCommandContextChange?: (kind: string | null) => void;
  } = $props();

  let session = $state<WorkspaceLayoutSession | null>(null);
  let selectedTaskId = $state<string | null>(null);
  let selectedGoalId = $state<string | null>(null);
  let goals = $state<ControlGoalRecordDto[]>([]);
  let tasks = $state<ControlTaskRecordDto[]>([]);
  let workLoading = $state(false);
  let workFailure = $state<string | null>(null);
  let workLoadedProjectId = $state<string | null>(null);
  let contextHydratedProjectId = $state<string | null>(null);
  let layoutDragActive = $state(false);
  let layoutDragEpoch = 0;
  let commandActiveRegionId = $state<RegionId | null>(null);
  let panelSequence = 0;
  let workLoadVersion = 0;
  let contextWriteActive = false;
  let contextWriteRequested = false;
  let appliedConversationRequest: string | null = null;
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
  let pendingAgentChatDraft = $state<(
    AgentChatDraftRequest & { panelInstanceId: string }
  ) | null>(null);
  let agentChatDraftSequence = 0;

  const snapshot = $derived(session?.snapshot);
  const binding = $derived(session?.binding);
  const document = $derived(session?.projected);
  const container = $derived(
    document?.containers.find((candidate) => candidate.id === snapshot?.container_id),
  );
  const activePanelsByRegion = $derived.by<Record<WorkspaceRegion, string | null>>(() => {
    const regions = snapshot?.document.containers
      .find((candidate) => candidate.id === snapshot.container_id)
      ?.regions;
    return {
      left: regions?.find(({ region_id }) => region_id === "left")?.active_panel_instance_id ?? null,
      center_top: regions?.find(({ region_id }) => region_id === "center_top")?.active_panel_instance_id ?? null,
      center_bottom: regions?.find(({ region_id }) => region_id === "center_bottom")?.active_panel_instance_id ?? null,
      right_top: regions?.find(({ region_id }) => region_id === "right_top")?.active_panel_instance_id ?? null,
      right_bottom: regions?.find(({ region_id }) => region_id === "right_bottom")?.active_panel_instance_id ?? null,
    };
  });
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
  const selectedGoal = $derived(
    goals.find(
      (goal) =>
        goal.project_id === selectedProject?.project_id && goal.goal_id === selectedGoalId,
    ) ?? null,
  );
  const selectedTask = $derived(
    tasks.find(
      (task) =>
        task.project_id === selectedProject?.project_id && task.task_id === selectedTaskId,
    ) ?? null,
  );

  $effect(() => {
    const projectId = selectedProject?.project_id ?? null;
    selectedTaskId = null;
    selectedGoalId = null;
    goals = [];
    tasks = [];
    workFailure = null;
    workLoadedProjectId = null;
    contextHydratedProjectId = null;
    appliedConversationRequest = null;
    pendingAgentChatDraft = null;
    layoutDragEpoch += 1;
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
    const projectId = selectedProject?.project_id ?? null;
    if (projectId) void loadWork(projectId);
  });

  $effect(() => {
    const current = snapshot;
    const projectId = selectedProject?.project_id ?? null;
    if (!current || !projectId || current.project_id !== projectId) return;
    if (contextHydratedProjectId === projectId) return;
    contextHydratedProjectId = projectId;
    selectedGoalId = current.context.selected_goal_id;
    selectedTaskId = current.context.selected_task_id;
    const requestedConversationId = selectedConversationId;
    selectedConversationId = requestedConversationId ?? current.context.active_conversation_id;
    if (requestedConversationId) {
      appliedConversationRequest = requestedConversationId;
      void openAgentChatThread(requestedConversationId);
    }
  });

  $effect(() => {
    const conversationId = selectedConversationId;
    const projectId = selectedProject?.project_id ?? null;
    if (
      !conversationId
      || !projectId
      || !snapshot
      || contextHydratedProjectId !== projectId
      || appliedConversationRequest === conversationId
    ) return;
    appliedConversationRequest = conversationId;
    void openAgentChatThread(conversationId);
  });

  $effect(() => {
    const projectId = selectedProject?.project_id ?? null;
    const taskId = selectedTaskId;
    const goalId = selectedGoalId;
    if (
      !projectId
      || contextHydratedProjectId !== projectId
      || workLoadedProjectId !== projectId
    ) return;
    const validTaskId = taskId && tasks.some((task) => task.task_id === taskId) ? taskId : null;
    const validGoalId = goalId && goals.some((goal) => goal.goal_id === goalId) ? goalId : null;
    if (validTaskId !== taskId || validGoalId !== goalId) {
      setWorkSelection(validGoalId, validTaskId);
    }
  });

  $effect(() => {
    onOpenPanelKindsChange?.(openPanelKinds);
  });

  $effect(() => {
    const region = container?.regions.find(({ region_id }) => region_id === commandActiveRegionId)
      ?? container?.regions.find(({ active_panel_instance_id }) => active_panel_instance_id !== null);
    const activePanel = snapshot?.panels.find(
      ({ panel_instance_id }) => panel_instance_id === region?.active_panel_instance_id,
    );
    onCommandContextChange?.(activePanel?.kind ?? null);
    if (activePanel?.kind === "agentChat" && activePanel.conversation_id) {
      appliedConversationRequest = activePanel.conversation_id;
      if (selectedConversationId !== activePanel.conversation_id) {
        selectedConversationId = activePanel.conversation_id;
        queueContextWrite();
      }
    }
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
    window.addEventListener("nucleus:create-workspace-panel", handleCreateWorkspacePanel);
    window.addEventListener("nucleus:open-task", handleOpenTask);
    window.addEventListener("nucleus:open-goal", handleOpenGoal);
    window.addEventListener("nucleus:open-file", handleOpenFile);
    window.addEventListener("nucleus:open-forge-diff", handleOpenForgeDiff);
    window.addEventListener("nucleus:open-agent-chat-thread", handleOpenAgentChatThread);
    window.addEventListener("nucleus:agent-chat-thread-deleted", handleAgentChatThreadDeleted);
    window.addEventListener("nucleus:tasks-changed", handleTasksChanged);
    window.addEventListener("nucleus:command-close-active-panel", closeCommandActivePanel);
    return () => {
      window.removeEventListener("nucleus:create-workspace-panel", handleCreateWorkspacePanel);
      window.removeEventListener("nucleus:open-task", handleOpenTask);
      window.removeEventListener("nucleus:open-goal", handleOpenGoal);
      window.removeEventListener("nucleus:open-file", handleOpenFile);
      window.removeEventListener("nucleus:open-forge-diff", handleOpenForgeDiff);
      window.removeEventListener("nucleus:open-agent-chat-thread", handleOpenAgentChatThread);
      window.removeEventListener("nucleus:agent-chat-thread-deleted", handleAgentChatThreadDeleted);
      window.removeEventListener("nucleus:tasks-changed", handleTasksChanged);
      window.removeEventListener("nucleus:command-close-active-panel", closeCommandActivePanel);
    };
  });

  function handleCreateWorkspacePanel(event: Event): void {
    const kind = event instanceof CustomEvent && typeof event.detail?.kind === "string"
      ? event.detail.kind
      : null;
    if (kind) void addPanel(kind);
  }

  function closeCommandActivePanel(): void {
    const region = container?.regions.find(({ region_id }) => region_id === commandActiveRegionId)
      ?? container?.regions.find(({ active_panel_instance_id }) => active_panel_instance_id !== null);
    if (region?.active_panel_instance_id) session?.binding?.close(region.active_panel_instance_id);
  }

  function handleOpenTask(event: Event): void {
    if (!(event instanceof CustomEvent) || event.detail?.projectId !== selectedProject?.project_id) return;
    const taskId = typeof event.detail.taskId === "string" ? event.detail.taskId : null;
    setWorkSelection(taskId ? goalIdForTask(taskId) : null, taskId);
    focusPanelKind("tasks");
  }

  function handleTasksChanged(event: Event): void {
    const projectId = selectedProject?.project_id ?? null;
    const changedProjectId = event instanceof CustomEvent ? event.detail?.projectId : null;
    if (projectId && (!changedProjectId || changedProjectId === projectId)) {
      void loadWork(projectId);
    }
  }

  function handleOpenGoal(event: Event): void {
    if (!(event instanceof CustomEvent) || event.detail?.projectId !== selectedProject?.project_id) return;
    setWorkSelection(
      typeof event.detail.goalId === "string" ? event.detail.goalId : null,
      typeof event.detail.taskId === "string" ? event.detail.taskId : null,
    );
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

  async function handleAgentChatThreadDeleted(event: Event): Promise<void> {
    if (
      !(event instanceof CustomEvent) ||
      typeof event.detail?.conversationId !== "string"
    ) return;
    const deletedId = event.detail.conversationId;
    if (selectedConversationId === deletedId) {
      selectedConversationId = null;
      queueContextWrite(true);
    }
    if (!session || !snapshot) return;
    // A panel bound to the deleted thread keeps no stale transcript: rebind it
    // to a fresh conversation so it becomes a new empty chat.
    for (const panel of snapshot.panels.filter((panel) => panel.kind === "agentChat")) {
      if (panelConversationId(panel) !== deletedId) continue;
      await session.updatePanel(panel.panel_instance_id, {
        ...toInput(panel),
        conversation_id: `conversation:${crypto.randomUUID()}`,
      });
    }
  }

  async function openAgentChatThread(conversationId: string): Promise<void> {
    if (!session || !snapshot || !selectedProject) return;
    const projectId = selectedProject.project_id;
    const candidates = snapshot.panels.filter((panel) => panel.kind === "agentChat");
    const panel = candidates.find(
      (candidate) => panelConversationId(candidate) === conversationId,
    ) ?? candidates[0] ?? await addPanel("agentChat");
    if (!panel) return;
    if (panel.conversation_id !== conversationId) {
      await session.updatePanel(panel.panel_instance_id, {
        ...toInput(panel),
        conversation_id: conversationId,
      });
    }
    appliedConversationRequest = conversationId;
    selectedConversationId = conversationId;
    queueContextWrite(true);
    session.binding?.activate(panel.panel_instance_id);
  }

  async function prepareSelectedTaskRework(): Promise<void> {
    if (!session || !snapshot || !selectedProject || !selectedTask) return;
    const candidates = snapshot.panels.filter((panel) => panel.kind === "agentChat");
    const panel = candidates.find(
      (candidate) => panelConversationId(candidate) === selectedConversationId,
    ) ?? candidates[0] ?? await addPanel("agentChat");
    if (!panel) return;
    agentChatDraftSequence += 1;
    pendingAgentChatDraft = {
      requestId: agentChatDraftSequence,
      panelInstanceId: panel.panel_instance_id,
      projectId: selectedProject.project_id,
      taskId: selectedTask.task_id,
      text: REVIEW_REWORK_PROMPT,
    };
    session.binding?.activate(panel.panel_instance_id);
  }

  function consumeAgentChatDraft(requestId: number): void {
    if (pendingAgentChatDraft?.requestId === requestId) pendingAgentChatDraft = null;
  }

  async function activatePanelConversation(panel: WorkspacePanelPresentation): Promise<void> {
    if (!session || panel.kind !== "agentChat") return;
    const conversationId = panelConversationId(panel);
    if (panel.conversation_id !== conversationId) {
      await session.updatePanel(panel.panel_instance_id, {
        ...toInput(panel),
        conversation_id: conversationId,
      });
    }
    appliedConversationRequest = conversationId;
    selectedConversationId = conversationId;
    queueContextWrite(true);
  }

  function setWorkSelection(goalId: string | null, taskId: string | null): void {
    selectedGoalId = goalId;
    selectedTaskId = taskId;
    queueContextWrite(true);
  }

  function goalIdForTask(taskId: string): string | null {
    return goals.find((goal) => goal.ordered_task_refs.includes(taskId))?.goal_id ?? null;
  }

  async function loadWork(projectId: string): Promise<void> {
    const version = ++workLoadVersion;
    workLoading = true;
    workFailure = null;
    try {
      const [taskResponse, goalResponse] = await Promise.all([
        submitControlEnvelope(buildStateListQuery("tasks")),
        submitControlEnvelope(buildStateListQuery("goals")),
      ]);
      if (version !== workLoadVersion || projectId !== selectedProject?.project_id) return;
      tasks = taskRecordsFromResponse(taskResponse).filter((task) => task.project_id === projectId);
      goals = goalRecordsFromResponse(goalResponse).filter((goal) => goal.project_id === projectId);
      workLoadedProjectId = projectId;
    } catch (error) {
      if (version === workLoadVersion && projectId === selectedProject?.project_id) {
        workFailure = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (version === workLoadVersion) workLoading = false;
    }
  }

  function desiredWorkspaceContext() {
    return {
      selected_goal_id: selectedGoalId,
      selected_task_id: selectedTaskId,
      active_conversation_id: selectedConversationId,
    };
  }

  function sameWorkspaceContext(
    left: ReturnType<typeof desiredWorkspaceContext>,
    right: ReturnType<typeof desiredWorkspaceContext>,
  ): boolean {
    return left.selected_goal_id === right.selected_goal_id
      && left.selected_task_id === right.selected_task_id
      && left.active_conversation_id === right.active_conversation_id;
  }

  function queueContextWrite(explicit = false): void {
    if (
      !snapshot
      || (!explicit && contextHydratedProjectId !== selectedProject?.project_id)
      || sameWorkspaceContext(snapshot.context, desiredWorkspaceContext())
    ) return;
    contextWriteRequested = true;
    if (!contextWriteActive) void flushContextWrites();
  }

  async function flushContextWrites(): Promise<void> {
    if (contextWriteActive) return;
    contextWriteActive = true;
    try {
      while (contextWriteRequested) {
        contextWriteRequested = false;
        const targetSession = session;
        const projectId = selectedProject?.project_id ?? null;
        if (!targetSession || !projectId) continue;
        await targetSession.updateContext(desiredWorkspaceContext());
      }
    } catch (error) {
      session?.reportError(error);
    } finally {
      contextWriteActive = false;
      if (contextWriteRequested) void flushContextWrites();
    }
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
      conversation_id: null,
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
    onOpenPanelKindsChange?.([
      ...new Set(
        (session?.snapshot?.panels ?? [])
          .filter((candidate) => candidate.panel_instance_id !== panel.panel_instance_id)
          .map((candidate) => candidate.kind),
      ),
    ]);
    if (panel.kind === "browser") {
      void destroyBrowserIsland(panel.external_id).catch((error) => session?.reportError(error));
    } else if (panel.kind === "terminal" && selectedProject?.project_id) {
      void closeTerminalPanel(selectedProject.project_id, panel.external_id)
        .catch((error) => session?.reportError(error));
    }
  }

  function beginLayoutDrag(): void {
    // Defer the drop-target reveal past the dragstart default phase:
    // mutating the region layout while WebKit is still establishing the drag
    // session cancels it before the first dragover.
    const epoch = ++layoutDragEpoch;
    requestAnimationFrame(() => {
      if (epoch !== layoutDragEpoch || layoutDragActive) return;
      layoutDragActive = true;
      window.dispatchEvent(new CustomEvent("nucleus:native-panels-hide"));
    });
  }

  function endLayoutDrag(): void {
    layoutDragEpoch += 1;
    if (!layoutDragActive) {
      return;
    }
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

  function panelIsVisible(regionId: RegionId, panelInstanceId: string): boolean {
    const region = container?.regions.find((candidate) => candidate.region_id === regionId);
    return region?.active_panel_instance_id === panelInstanceId && region.collapsed !== true;
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
    return selectedProject ? effectiveResourceTarget(selectedProject, explicit) : explicit;
  }

  function panelConversationId(panel: WorkspacePanelPresentation): string {
    const projectId = selectedProject?.project_id ?? "unselected";
    return panel.conversation_id ?? defaultConversationId(projectId, panel);
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
      conversation_id: panel.conversation_id,
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
      <div
        class="workspace-status"
        role={session?.status.kind === "failed" ? "alert" : "status"}
        aria-live={session?.status.kind === "failed" ? "assertive" : "polite"}
      >
        <Text tone={session?.status.kind === "failed" ? "danger" : "muted"}>{statusMessage()}</Text>
      </div>
      {#if session?.status.kind === "failed"}
        <div class="retry">
          <Button variant="secondary" size="sm" onClick={() => void session?.reconnect()}>Retry</Button>
        </div>
      {/if}
    </Surface>
  {:else if snapshot.panels.length === 0}
    <div class="window-body">
      <div class="empty-workspace">
        <Surface tone="canvas" border="none" padding="md" asRole="region" label="Empty workspace">
          <div class="empty-workspace-content">
            <Text weight="semibold">Empty workspace</Text>
            <Text tone="muted">Open Agent Chat to continue, or use + for another panel.</Text>
            <Button variant="secondary" size="sm" onClick={() => void addPanel("agentChat")}>
              Open Agent Chat
            </Button>
          </div>
        </Surface>
      </div>
    </div>
  {:else}
    <div class="window-body">
      {#if session.status.kind === "failed"}
        <div class="layout-error" role="alert"><Text size="xs" tone="danger">{statusMessage()}</Text></div>
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
        toggleVisibility="hover"
      >
        {#snippet primary()}
          {@render RegionShell("left", "left", "left", activePanelsByRegion.left)}
        {/snippet}
        {#snippet secondary()}
          {@render MainRegions()}
        {/snippet}
      </LayoutSplitView>
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
      toggleVisibility="hover"
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
      toggleVisibility="hover"
    >
      {#snippet primary()}{@render RegionShell("centerTop", "top", "center_top", activePanelsByRegion.center_top)}{/snippet}
      {#snippet secondary()}{@render RegionShell("centerBottom", "bottom", "center_bottom", activePanelsByRegion.center_bottom)}{/snippet}
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
      toggleVisibility="hover"
    >
      {#snippet primary()}{@render RegionShell("rightTop", "top", "right_top", activePanelsByRegion.right_top)}{/snippet}
      {#snippet secondary()}{@render RegionShell("rightBottom", "bottom", "right_bottom", activePanelsByRegion.right_bottom)}{/snippet}
    </LayoutSplitView>
  {/if}
{/snippet}

{#snippet RegionShell(
  label: string,
  edge: "left" | "right" | "top" | "bottom",
  regionId: RegionId,
  activePanelInstanceId: string | null,
)}
  {#if binding && snapshot && session}
    <section
      class="region-cell"
      aria-label={`${label} region`}
      onpointerdown={() => (commandActiveRegionId = regionId)}
      onfocusin={() => (commandActiveRegionId = regionId)}
    >
      {#key activePanelInstanceId}
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
          showCollapseToggle={false}
        >
          {#snippet body(context)}
            {@const panel = panelFromContext(context)}
            {#if panel}{@render PanelBody(
              panel,
              activePanelInstanceId === context.instance.id
                && panelIsVisible(regionId, context.instance.id),
            )}{/if}
          {/snippet}
        </LayoutDockRegion>
      {/key}
    </section>
  {/if}
{/snippet}

{#snippet PanelBody(panel: WorkspacePanelPresentation, active: boolean)}
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
          {agentChatDefaults}
          onClearActiveTask={() => setWorkSelection(selectedGoalId, null)}
          onClearActiveGoal={() => setWorkSelection(null, selectedTaskId)}
          onConversationActive={() => void activatePanelConversation(panel)}
          draftRequest={pendingAgentChatDraft?.panelInstanceId === panel.panel_instance_id
            ? pendingAgentChatDraft
            : null}
          onDraftRequestConsumed={consumeAgentChatDraft}
        />
      </div>
    </div>
  {:else if panel.kind === "tasks"}
    <TaskListPanel
      selectedProjectId={selectedProject?.project_id ?? null}
      {goals}
      {tasks}
      loading={workLoading}
      failure={workFailure}
      onRefresh={() => selectedProject && void loadWork(selectedProject.project_id)}
      onSelectionChange={setWorkSelection}
      bind:selectedGoalId
      bind:selectedTaskId
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
    <BrowserPanel panelId={panel.external_id} {active} />
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
      onOpenEditor={(fileRef, resourceId, displayPath) => void openFileInEditor(fileRef, resourceId, displayPath)}
      onReviewed={() => focusPanelKind("diff")}
      onPrepareRework={() => void prepareSelectedTaskRework()}
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

  .workspace-status {
    display: grid;
  }

  .empty-workspace {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }

  .empty-workspace-content {
    display: grid;
    justify-items: center;
    gap: var(--poodle-space-stack-sm);
    max-width: 24rem;
    text-align: center;
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
