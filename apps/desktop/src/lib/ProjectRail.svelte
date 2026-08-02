<script lang="ts">
  import {
    Dialog,
    EditableLabel,
    Icon,
    Menu,
    SegmentedControl,
    Text,
    type MenuItem,
  } from "@poodle/svelte";
  import {
    chevronDown,
    chevronRight,
    folder,
    ellipsis,
    folderCog,
    plus,
    refreshCw,
  } from "@poodle/icons-lucide";
  import { onDestroy, onMount, tick } from "svelte";
  import {
    buildStateListQuery,
    buildControlCommandEnvelope,
    projectRecordsFromResponse,
    submitControlEnvelope,
    type ControlProjectRecordDto,
  } from "./control";
  import {
    createNativePanelOverlayId,
    setNativePanelOverlayVisibility,
  } from "./nativePanelVisibility";
  import {
    listAgentChatThreads,
    type AgentChatThreadSummary,
  } from "./control/agentChat";
  import ProjectResourceManager from "./ProjectResourceManager.svelte";
  import ProjectSharedFilesManager from "./ProjectSharedFilesManager.svelte";

  type Props = {
    selectedProjectId: string | null;
    selectedProject: ControlProjectRecordDto | null;
    selectedConversationId: string | null;
  };

  let {
    selectedProjectId = $bindable(null),
    selectedProject = $bindable(null),
    selectedConversationId = $bindable(null),
  }: Props = $props();

  let loading = $state(false);
  let failure = $state<string | null>(null);
  let projects = $state<ControlProjectRecordDto[]>([]);
  let creating = $state(false);
  let createName = $state("");
  let renamingProjectId = $state<string | null>(null);
  let renamingSurface = $state<"rail" | "manager" | null>(null);
  let renameName = $state("");
  let renameInput = $state<HTMLInputElement | null>(null);
  let pendingDeleteProjectId = $state<string | null>(null);
  let mutatingProjectId = $state<string | null>(null);
  let mutationFailure = $state<string | null>(null);
  let projectManagerOpen = $state(false);
  let projectManagerView = $state<"all" | "parked" | "archived">("all");
  let managingResourcesProjectId = $state<string | null>(null);
  let managingSharedFilesProjectId = $state<string | null>(null);
  let threads = $state<AgentChatThreadSummary[]>([]);
  let loadingThreads = $state(false);
  let threadFailure = $state<string | null>(null);
  let expandedProjectIds = $state<Set<string>>(new Set());
  const projectManagerOverlayId = createNativePanelOverlayId("project-manager");

  const activeProjects = $derived(projects.filter((project) => project.status === "active"));
  const namedProjects = $derived(activeProjects.filter((project) => project.retention !== "transient"));
  const managedProjects = $derived(
    projectManagerView === "all"
      ? projects
      : projects.filter((project) => project.status === projectManagerView),
  );
  const managedResourceProject = $derived(
    projects.find((project) => project.project_id === managingResourcesProjectId) ?? null,
  );
  const managedSharedFilesProject = $derived(
    projects.find((project) => project.project_id === managingSharedFilesProjectId) ?? null,
  );

  const projectCountLabel = $derived(
    loading
      ? "Loading"
      : failure
        ? "Unavailable"
        : `${namedProjects.length} project${namedProjects.length === 1 ? "" : "s"}`,
  );

  $effect(() => {
    selectedProject =
      activeProjects.find((project) => project.project_id === selectedProjectId) ?? null;
  });

  $effect(() => {
    setNativePanelOverlayVisibility(projectManagerOverlayId, projectManagerOpen);
  });

  $effect(() => {
    if (!selectedConversationId) return;
    const selectedThread = threads.find(
      (thread) => thread.conversation_id === selectedConversationId,
    );
    if (!selectedThread) return;
    if (selectedThread.project_id !== selectedProjectId) {
      selectedConversationId = null;
      return;
    }
    if (!expandedProjectIds.has(selectedThread.project_id)) {
      expandedProjectIds = new Set([...expandedProjectIds, selectedThread.project_id]);
    }
  });

  function selectProject(projectId: string) {
    selectedProjectId = projectId;
    if (
      selectedConversationId
      && !threads.some(
        (thread) =>
          thread.conversation_id === selectedConversationId
          && thread.project_id === projectId,
      )
    ) {
      selectedConversationId = null;
    }
  }

  function toggleProjectThreads(projectId: string): void {
    const next = new Set(expandedProjectIds);
    if (next.has(projectId)) {
      next.delete(projectId);
    } else {
      next.add(projectId);
    }
    expandedProjectIds = next;
  }

  function projectThreads(projectId: string): AgentChatThreadSummary[] {
    return threads.filter((thread) => thread.project_id === projectId);
  }

  function openThread(thread: AgentChatThreadSummary): void {
    selectedConversationId = thread.conversation_id;
    selectedProjectId = thread.project_id;
    window.dispatchEvent(
      new CustomEvent("nucleus:open-agent-chat-thread", {
        detail: {
          projectId: thread.project_id,
          conversationId: thread.conversation_id,
        },
      }),
    );
  }

  function projectMenuItems(project: ControlProjectRecordDto): MenuItem[] {
    return [
      { value: "resources", label: "Resources" },
      { value: "shared-files", label: "Shared project files" },
      { value: "separator-resources", label: "", kind: "separator" },
      { value: "rename", label: "Rename" },
      project.status === "active"
        ? { value: "park", label: "Park" }
        : { value: "restore", label: "Restore" },
      ...(project.status === "archived"
        ? []
        : [{ value: "archive", label: "Archive" } satisfies MenuItem]),
      { value: "separator", label: "", kind: "separator" },
      { value: "delete", label: "Delete", tone: "danger" },
    ];
  }

  function handleProjectAction(
    project: ControlProjectRecordDto,
    action: string,
    surface: "rail" | "manager",
  ) {
    mutationFailure = null;
    pendingDeleteProjectId = null;
    if (action === "resources") {
      managingSharedFilesProjectId = null;
      managingResourcesProjectId = project.project_id;
      projectManagerOpen = true;
      return;
    }
    if (action === "shared-files") {
      managingResourcesProjectId = null;
      managingSharedFilesProjectId = project.project_id;
      projectManagerOpen = true;
      return;
    }
    if (action === "rename") {
      void beginProjectRename(project, surface);
      return;
    }
    if (action === "delete") {
      pendingDeleteProjectId = project.project_id;
      return;
    }
    void mutateProject(project, action as "park" | "archive" | "restore");
  }

  function changeProjectManagerView(view: string) {
    projectManagerView = view as "all" | "parked" | "archived";
    renamingProjectId = null;
    renamingSurface = null;
    pendingDeleteProjectId = null;
    mutationFailure = null;
    managingResourcesProjectId = null;
    managingSharedFilesProjectId = null;
  }

  function handleManageProjectResources(event: Event) {
    const projectId =
      event instanceof CustomEvent && typeof event.detail?.projectId === "string"
        ? event.detail.projectId
        : null;
    if (!projectId || !projects.some((project) => project.project_id === projectId)) return;
    managingSharedFilesProjectId = null;
    managingResourcesProjectId = projectId;
    projectManagerOpen = true;
  }

  async function createProject() {
    const displayName = createName.trim();
    if (!displayName || mutatingProjectId) return;
    const previousIds = new Set(projects.map((project) => project.project_id));
    const idempotencyKey = `project-create:${crypto.randomUUID()}`;
    mutatingProjectId = "create";
    mutationFailure = null;
    try {
      await submitProjectCommand({
        kind: "project_create",
        command_id: `command:${idempotencyKey}`,
        display_name: displayName,
        transient: null,
        actor_ref: "operator:desktop",
        authority_host_ref: "host:embedded-desktop",
        idempotency_key: idempotencyKey,
      });
      createName = "";
      creating = false;
      await loadProjectRail();
      selectedProjectId = projects.find((project) => !previousIds.has(project.project_id))?.project_id
        ?? selectedProjectId;
    } catch (error) {
      mutationFailure = error instanceof Error ? error.message : String(error);
    } finally {
      mutatingProjectId = null;
    }
  }

  async function renameProject(project: ControlProjectRecordDto) {
    const displayName = renameName.trim();
    if (!displayName) {
      cancelProjectRename();
      return;
    }
    if (mutatingProjectId) return;
    await mutateProject(project, "rename", displayName);
    if (!mutationFailure) {
      cancelProjectRename();
    }
  }

  async function beginProjectRename(
    project: ControlProjectRecordDto,
    surface: "rail" | "manager",
  ): Promise<void> {
    renamingProjectId = project.project_id;
    renamingSurface = surface;
    renameName = project.display_name;
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  function cancelProjectRename(): void {
    renamingProjectId = null;
    renamingSurface = null;
    renameName = "";
    renameInput = null;
  }

  function handleRenameKeydown(
    event: KeyboardEvent,
    project: ControlProjectRecordDto,
  ): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void renameProject(project);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelProjectRename();
    }
  }

  async function commitProjectName(
    project: ControlProjectRecordDto,
    value: string,
  ): Promise<void> {
    const displayName = value.trim();
    if (
      !displayName
      || displayName === project.display_name
      || mutatingProjectId
    ) {
      return;
    }
    await mutateProject(project, "rename", displayName);
  }

  async function mutateProject(
    project: ControlProjectRecordDto,
    action: "rename" | "park" | "archive" | "restore" | "delete" | "promote",
    displayName: string | null = null,
  ) {
    if (mutatingProjectId) return;
    const idempotencyKey = `project-${action}:${crypto.randomUUID()}`;
    mutatingProjectId = project.project_id;
    mutationFailure = null;
    try {
      await submitProjectCommand({
        kind: "project_lifecycle",
        command_id: `command:${idempotencyKey}`,
        project_id: project.project_id,
        action,
        expected_revision: project.revision_id,
        display_name: displayName,
        actor_ref: "operator:desktop",
        authority_host_ref: project.authority_host_ref,
        idempotency_key: idempotencyKey,
      });
      pendingDeleteProjectId = null;
      await loadProjectRail();
    } catch (error) {
      mutationFailure = error instanceof Error ? error.message : String(error);
    } finally {
      mutatingProjectId = null;
    }
  }

  async function submitProjectCommand(command: Parameters<typeof buildControlCommandEnvelope>[0]) {
    const response = await submitControlEnvelope(buildControlCommandEnvelope(command));
    if (response.body.type !== "command_receipt") {
      throw new Error("Project command returned an unexpected response.");
    }
    if (response.body.status !== "accepted_for_state_mutation") {
      throw new Error(response.body.error_reason ?? "Project command was refused.");
    }
  }

  async function loadProjectRail() {
    loading = true;
    failure = null;

    try {
      const projectsResponse = await submitControlEnvelope(buildStateListQuery("projects"));
      const loadedProjects = projectRecordsFromResponse(projectsResponse);
      const loadedActiveProjects = loadedProjects.filter((project) => project.status === "active");
      projects = loadedProjects;

      if (!loadedActiveProjects.some((project) => project.project_id === selectedProjectId)) {
        selectedProjectId = loadedActiveProjects[0]?.project_id ?? null;
      }
    } catch (error) {
      projects = [];
      selectedProjectId = null;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  async function loadProjectThreads(): Promise<void> {
    loadingThreads = true;
    threadFailure = null;
    try {
      threads = await listAgentChatThreads();
    } catch (error) {
      threads = [];
      threadFailure = error instanceof Error ? error.message : String(error);
    } finally {
      loadingThreads = false;
    }
  }

  function refreshProjectRail(): void {
    void loadProjectRail();
    void loadProjectThreads();
  }

  function selectedProjectRecord(): ControlProjectRecordDto | null {
    return projects.find(({ project_id }) => project_id === selectedProjectId) ?? null;
  }

  function commandCreateProject(): void { creating = true; }
  function commandManageProjects(): void { projectManagerOpen = true; }
  function commandRenameProject(): void {
    const project = selectedProjectRecord();
    if (project) void beginProjectRename(project, "rail");
  }
  function commandManageResources(): void {
    const project = selectedProjectRecord();
    if (project) handleProjectAction(project, "resources", "rail");
  }
  function commandParkProject(): void {
    const project = selectedProjectRecord();
    if (project) void mutateProject(project, "park");
  }
  function commandArchiveProject(): void {
    const project = selectedProjectRecord();
    if (project) void mutateProject(project, "archive");
  }

  onMount(() => {
    refreshProjectRail();
    window.addEventListener("nucleus:manage-project-resources", handleManageProjectResources);
    window.addEventListener("nucleus:projects-changed", refreshProjectRail);
    window.addEventListener("nucleus:threads-changed", refreshProjectRail);
    window.addEventListener("nucleus:command-create-project", commandCreateProject);
    window.addEventListener("nucleus:command-manage-projects", commandManageProjects);
    window.addEventListener("nucleus:command-rename-project", commandRenameProject);
    window.addEventListener("nucleus:command-manage-project-resources", commandManageResources);
    window.addEventListener("nucleus:command-park-project", commandParkProject);
    window.addEventListener("nucleus:command-archive-project", commandArchiveProject);
  });

  onDestroy(() => {
    window.removeEventListener("nucleus:manage-project-resources", handleManageProjectResources);
    window.removeEventListener("nucleus:projects-changed", refreshProjectRail);
    window.removeEventListener("nucleus:threads-changed", refreshProjectRail);
    window.removeEventListener("nucleus:command-create-project", commandCreateProject);
    window.removeEventListener("nucleus:command-manage-projects", commandManageProjects);
    window.removeEventListener("nucleus:command-rename-project", commandRenameProject);
    window.removeEventListener("nucleus:command-manage-project-resources", commandManageResources);
    window.removeEventListener("nucleus:command-park-project", commandParkProject);
    window.removeEventListener("nucleus:command-archive-project", commandArchiveProject);
    setNativePanelOverlayVisibility(projectManagerOverlayId, false);
  });
</script>

<section class="project-rail-list" aria-label="Projects">
  <header class="project-rail-head">
    <span class="sidebar-dimmed">{projectCountLabel}</span>
    <div class="project-rail-actions">
      <button class="icon-button" type="button" aria-label="New project" onclick={() => (creating = true)}>
        <Icon icon={plus} size="sm" />
      </button>
      <button class="icon-button" type="button" aria-label="Manage projects" title="Manage projects" onclick={() => (projectManagerOpen = true)}>
        <Icon icon={folderCog} size="sm" />
      </button>
      <button
        class="icon-button"
        type="button"
        aria-label="Refresh projects"
        disabled={loading}
        onclick={refreshProjectRail}
      >
        <Icon icon={refreshCw} size="sm" />
      </button>
    </div>
  </header>

  <Dialog
    bind:open={projectManagerOpen}
    title={managedSharedFilesProject
      ? "Shared project files"
      : managedResourceProject
        ? "Project resources"
        : "Manage projects"}
    description={managedSharedFilesProject
      ? "Optional Git-backed projection"
      : managedResourceProject
        ? "Folders and repositories"
        : `${projects.length} total`}
    width="sm"
    size="sm"
    showCloseButton
    onOpenChange={(open) => {
      projectManagerOpen = open;
      if (!open) {
        renamingProjectId = null;
        renamingSurface = null;
        pendingDeleteProjectId = null;
        mutationFailure = null;
        managingResourcesProjectId = null;
        managingSharedFilesProjectId = null;
      }
    }}
  >
    {#if managedSharedFilesProject}
      <ProjectSharedFilesManager
        project={managedSharedFilesProject}
        onBack={() => (managingSharedFilesProjectId = null)}
        onChanged={loadProjectRail}
        onManageResources={() => {
          managingSharedFilesProjectId = null;
          managingResourcesProjectId = managedSharedFilesProject.project_id;
        }}
      />
    {:else if managedResourceProject}
      <ProjectResourceManager
        project={managedResourceProject}
        onBack={() => (managingResourcesProjectId = null)}
        onChanged={loadProjectRail}
      />
    {:else}
    <section class="project-manager">
      <SegmentedControl
        value={projectManagerView}
        options={[
          { value: "all", label: "All" },
          { value: "parked", label: "Parked" },
          { value: "archived", label: "Archived" },
        ]}
        size="sm"
        ariaLabel="Project status filter"
        onValueChange={changeProjectManagerView}
      />
      {#if mutationFailure}
        <div class="manager-message"><Text tone="danger">{mutationFailure}</Text></div>
      {/if}
      <div class="project-manager-list">
        {#each managedProjects as project (project.project_id)}
          <section class="managed-project">
            <div class="managed-project-row">
              <span class="managed-project-copy">
                {#if renamingProjectId === project.project_id && renamingSurface === "manager"}
                  <input
                    class="project-name-input"
                    bind:this={renameInput}
                    bind:value={renameName}
                    aria-label="Project name"
                    maxlength="80"
                    onblur={() => void renameProject(project)}
                    onkeydown={(event) => handleRenameKeydown(event, project)}
                  />
                {:else}
                  <strong>{project.display_name}</strong>
                {/if}
                <small>{project.status}</small>
              </span>
              <Menu
                items={projectMenuItems(project)}
                ariaLabel={`Project actions for ${project.display_name}`}
                placement="bottom-end"
                onAction={(action) => handleProjectAction(project, action, "manager")}
              >
                {#snippet trigger()}
                  <span class="project-menu-button" aria-label={`Project actions for ${project.display_name}`}>
                    <Icon icon={ellipsis} size="sm" />
                  </span>
                {/snippet}
              </Menu>
            </div>
            {#if pendingDeleteProjectId === project.project_id}
              <div class="delete-confirmation manager-confirmation">
                <span>Delete only if this project has no retained work?</span>
                <button type="button" class="danger-action" onclick={() => void mutateProject(project, "delete")}>Delete</button>
                <button type="button" onclick={() => (pendingDeleteProjectId = null)}>Cancel</button>
              </div>
            {/if}
          </section>
        {:else}
          <div class="manager-empty"><span class="sidebar-dimmed">No {projectManagerView} projects.</span></div>
        {/each}
      </div>
    </section>
    {/if}
  </Dialog>

  {#if creating}
    <form class="inline-project-form" onsubmit={(event) => { event.preventDefault(); void createProject(); }}>
      <input bind:value={createName} aria-label="Project name" placeholder="Project name" />
      <button type="submit" disabled={!createName.trim() || mutatingProjectId !== null}>Create</button>
      <button type="button" onclick={() => { creating = false; createName = ""; }}>Cancel</button>
    </form>
  {/if}

  {#if mutationFailure}
    <div class="rail-message rail-message-error"><Text tone="danger">{mutationFailure}</Text></div>
  {/if}

  {#if failure}
    <div class="rail-message rail-message-error">
      <Text tone="danger">{failure}</Text>
    </div>
  {:else if loading && projects.length === 0}
    <div class="rail-message">
      <span class="sidebar-dimmed">Loading projects.</span>
    </div>
  {:else if namedProjects.length === 0}
    <div class="rail-message">
      <span class="sidebar-dimmed">No active projects. Create one to get started.</span>
    </div>
  {:else}
    <div class="project-stack">
      {#each namedProjects as project}
        {@const active = project.project_id === selectedProjectId}
        {@const expanded = expandedProjectIds.has(project.project_id)}
        {@const associatedThreads = projectThreads(project.project_id)}
        <section class:active class="project-node">
          <div class="project-node-row">
            <button
              class="project-thread-toggle"
              type="button"
              aria-label={`${expanded ? "Hide" : "Show"} threads for ${project.display_name}`}
              aria-expanded={expanded}
              onclick={() => toggleProjectThreads(project.project_id)}
            >
              <Icon icon={expanded ? chevronDown : chevronRight} size="xs" />
            </button>
            <button
              class="project-node-select"
              type="button"
              aria-label={`Select ${project.display_name}`}
              onclick={() => selectProject(project.project_id)}
            >
              <span class="project-node-icon" aria-hidden="true"><Icon icon={folder} size="sm" /></span>
            </button>
            <span
              class="project-name"
              onpointerdown={() => selectProject(project.project_id)}
              onfocusin={() => selectProject(project.project_id)}
            >
              {#if renamingProjectId === project.project_id && renamingSurface === "rail"}
                <input
                  class="project-name-input"
                  bind:this={renameInput}
                  bind:value={renameName}
                  aria-label="Project name"
                  maxlength="80"
                  onblur={() => void renameProject(project)}
                  onkeydown={(event) => handleRenameKeydown(event, project)}
                />
              {:else}
                <EditableLabel
                  value={project.display_name}
                  ariaLabel={`Rename ${project.display_name}`}
                  activationMode="doubleClick"
                  variant="flush"
                  maxLength={80}
                  disabled={mutatingProjectId !== null}
                  onCommit={({ value }) => void commitProjectName(project, value)}
                />
              {/if}
            </span>
            <Menu
              items={projectMenuItems(project)}
              ariaLabel={`Project actions for ${project.display_name}`}
              placement="bottom-end"
              onAction={(action) => handleProjectAction(project, action, "rail")}
            >
              {#snippet trigger()}
                <button class="project-menu-button" type="button" aria-label={`Project actions for ${project.display_name}`} disabled={mutatingProjectId !== null}>
                  <Icon icon={ellipsis} size="sm" />
                </button>
              {/snippet}
            </Menu>
          </div>

          {#if expanded}
            <div class="project-thread-list">
              {#if loadingThreads && threads.length === 0}
                <div class="project-thread-message">Loading threads.</div>
              {:else if threadFailure}
                <div class="project-thread-message project-thread-error">{threadFailure}</div>
              {:else}
                {#each associatedThreads as thread (thread.conversation_id)}
                  <button
                    class="project-thread-row"
                    class:active={thread.conversation_id === selectedConversationId}
                    type="button"
                    aria-current={thread.conversation_id === selectedConversationId
                      ? "true"
                      : undefined}
                    onclick={() => openThread(thread)}
                  >
                    <span>{thread.title}</span>
                    <small>{thread.turn_count} {thread.turn_count === 1 ? "turn" : "turns"}</small>
                  </button>
                {:else}
                  <div class="project-thread-message">No agent threads.</div>
                {/each}
              {/if}
            </div>
          {/if}

          {#if pendingDeleteProjectId === project.project_id}
            <div class="delete-confirmation">
              <span>Delete only if this project has no retained work?</span>
              <button type="button" class="danger-action" onclick={() => void mutateProject(project, "delete")}>Delete</button>
              <button type="button" onclick={() => (pendingDeleteProjectId = null)}>Cancel</button>
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</section>

<style>
  .project-rail-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    height: 100%;
    min-width: 0;
    min-height: 0;
    padding: 0.75rem;
    overflow: hidden;
  }

  .project-rail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    min-width: 0;
  }

  .sidebar-dimmed {
    color: var(--poodle-color-text-secondary);
    opacity: var(--poodle-state-opacity-muted);
  }

  .project-rail-actions,
  .project-node-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
  }

  .icon-button {
    display: inline-grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    color: var(--poodle-color-text-secondary);
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
    cursor: pointer;
  }

  .icon-button:hover:not(:disabled) {
    color: var(--poodle-color-text-primary);
    border-color: var(--poodle-color-border-default);
    background: var(--poodle-color-background-elevated);
  }

  .icon-button:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .project-stack {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    min-height: 0;
    flex: 1;
    overflow: auto;
  }

  .project-node {
    min-width: 0;
  }

  .project-node-row {
    gap: 0.125rem;
    padding: 0 0.125rem;
    border-radius: var(--poodle-radius-control);
  }

  .project-node-row:hover,
  .project-node.active > .project-node-row {
    background: var(--poodle-color-background-surface);
  }

  .project-node-select {
    display: inline-grid;
    place-items: center;
    width: 1.25rem;
    min-height: 2rem;
    padding: 0.25rem 0.125rem;
    color: var(--poodle-color-text-secondary);
    border: 0;
    background: transparent;
    cursor: pointer;
    opacity: var(--poodle-state-opacity-muted);
  }

  .project-thread-toggle {
    display: inline-grid;
    place-items: center;
    width: 1.25rem;
    height: 2rem;
    flex: 0 0 auto;
    padding: 0;
    color: var(--poodle-color-icon-muted);
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
    opacity: var(--poodle-state-opacity-muted);
  }

  .project-thread-toggle:hover {
    color: var(--poodle-color-text-primary);
    opacity: 1;
  }

  .project-menu-button {
    display: inline-grid;
    place-items: center;
    width: 1.5rem;
    height: 2rem;
    flex: 0 0 auto;
    padding: 0;
    color: var(--poodle-color-icon-muted);
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    transition: opacity 120ms ease;
  }

  .project-node-row:hover .project-menu-button,
  .project-node-row:focus-within .project-menu-button {
    opacity: 1;
    visibility: visible;
  }

  .project-menu-button:hover:not(:disabled) {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-elevated);
    opacity: 1;
  }

  .project-manager {
    display: grid;
    gap: 0.75rem;
  }

  .managed-project-copy {
    display: grid;
    min-width: 0;
  }

  .managed-project-copy strong {
    color: var(--poodle-color-text-secondary);
    font-size: 0.8125rem;
  }

  .project-name-input {
    width: 100%;
    min-width: 0;
    padding: 0;
    color: var(--poodle-color-text-primary);
    border: 0;
    border-bottom: 1px solid var(--poodle-color-accent-focusRing);
    outline: 0;
    background: transparent;
    font: inherit;
    font-weight: inherit;
  }

  .managed-project-copy .project-name-input {
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .managed-project-copy small {
    color: var(--poodle-color-text-secondary);
    font-size: 0.6875rem;
    text-transform: capitalize;
    opacity: var(--poodle-state-opacity-muted);
  }

  .project-manager-list {
    display: grid;
    gap: 0.25rem;
    max-height: min(24rem, 55vh);
    overflow: auto;
  }

  .managed-project {
    min-width: 0;
    padding: 0.375rem 0.25rem;
    border-bottom: 1px solid var(--poodle-color-border-subtle);
  }

  .managed-project:last-child {
    border-bottom: 0;
  }

  .managed-project-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .managed-project-copy {
    flex: 1;
  }

  .manager-message,
  .manager-empty {
    padding: 0.5rem 0.25rem;
  }

  .delete-confirmation.manager-confirmation {
    margin: 0.375rem 0 0;
  }

  .inline-project-form,
  .delete-confirmation {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    padding: 0.5rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
  }

  .delete-confirmation {
    margin: 0.25rem 0 0.375rem 1.25rem;
  }

  .inline-project-form input {
    min-width: 0;
    flex: 1;
    padding: 0.375rem 0.5rem;
    color: var(--poodle-color-text-primary);
    border: 1px solid var(--poodle-color-border-default);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-base);
    font: inherit;
  }

  .inline-project-form button,
  .delete-confirmation button {
    padding: 0.3rem 0.45rem;
    color: var(--poodle-color-text-secondary);
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
  }

  .delete-confirmation {
    flex-wrap: wrap;
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .delete-confirmation .danger-action {
    color: var(--poodle-color-status-danger);
  }

  .project-node-select:hover {
    color: var(--poodle-color-text-secondary);
    opacity: 1;
  }

  .project-node.active .project-node-select {
    color: var(--poodle-color-text-primary);
    opacity: 1;
  }

  .project-node-icon {
    display: inline-grid;
    place-items: center;
    color: inherit;
  }

  .project-node.active .project-node-icon {
    color: var(--poodle-color-text-secondary);
  }

  .project-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--poodle-color-text-secondary);
    font-size: 0.8125rem;
    font-weight: 600;
    line-height: 1.25;
    opacity: var(--poodle-state-opacity-muted);
  }

  .project-name:hover,
  .project-node.active .project-name,
  .project-name:focus-within {
    color: var(--poodle-color-text-primary);
    opacity: 1;
  }

  .project-name :global(.poodle-editable-label),
  .project-name :global(.poodle-editable-label__display),
  .project-name :global(.poodle-editable-label__input) {
    width: 100%;
    min-width: 0;
  }

  .project-name :global(.poodle-editable-label__display) {
    justify-content: flex-start;
    color: inherit;
    font: inherit;
  }

  .project-name :global(.poodle-editable-label__text) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-thread-list {
    display: grid;
    gap: 0.125rem;
    margin: 0.125rem 1.75rem 0.375rem 1.625rem;
    padding-left: 0.5rem;
    border-left: 1px solid var(--poodle-color-border-subtle);
  }

  .project-thread-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    min-height: 1.75rem;
    padding: 0.25rem 0.375rem;
    color: var(--poodle-color-text-secondary);
    text-align: left;
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
    opacity: var(--poodle-state-opacity-muted);
  }

  .project-thread-row:hover {
    color: var(--poodle-color-text-secondary);
    background: var(--poodle-color-background-surface);
    opacity: 1;
  }

  .project-thread-row.active {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-selected);
    opacity: 1;
  }

  .project-thread-row.active small {
    color: var(--poodle-color-text-secondary);
  }

  .project-thread-row span,
  .project-thread-row small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-thread-row span {
    font-size: 0.75rem;
  }

  .project-thread-row small,
  .project-thread-message {
    color: var(--poodle-color-text-secondary);
    font-size: 0.6875rem;
  }

  .project-thread-message {
    padding: 0.35rem 0.4rem;
    opacity: var(--poodle-state-opacity-muted);
  }

  .project-thread-error {
    color: var(--poodle-color-status-danger);
  }

  .rail-message {
    padding: 0.75rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-background-surface);
  }

  .rail-message-error {
    border-color: var(--poodle-color-status-danger);
  }
</style>
