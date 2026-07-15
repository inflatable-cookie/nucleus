<script lang="ts">
  import { Icon, Menu, Text, type MenuItem } from "@poodle/svelte";
  import {
    bot,
    chevronDown,
    chevronRight,
    folder,
    ellipsis,
    messageCircle,
    plus,
    refreshCw,
  } from "@poodle/icons-lucide";
  import { onMount } from "svelte";
  import {
    buildStateListQuery,
    buildControlCommandEnvelope,
    projectRecordsFromResponse,
    queryTaskWorkProgress,
    submitControlEnvelope,
    type ControlProjectRecordDto,
    type TaskAgentWorkUnitDiagnosticDto,
  } from "./control";

  type Props = {
    selectedProjectId: string | null;
    selectedProject: ControlProjectRecordDto | null;
  };

  let { selectedProjectId = $bindable(null), selectedProject = $bindable(null) }: Props = $props();

  let loading = $state(false);
  let failure = $state<string | null>(null);
  let projects = $state<ControlProjectRecordDto[]>([]);
  let workUnits = $state<TaskAgentWorkUnitDiagnosticDto[]>([]);
  let openProjectIds = $state<string[]>([]);
  let creating = $state(false);
  let createName = $state("");
  let renamingProjectId = $state<string | null>(null);
  let renameName = $state("");
  let pendingDeleteProjectId = $state<string | null>(null);
  let mutatingProjectId = $state<string | null>(null);
  let mutationFailure = $state<string | null>(null);

  const projectCountLabel = $derived(
    loading
      ? "Loading"
      : failure
        ? "Unavailable"
        : `${projects.length} project${projects.length === 1 ? "" : "s"}`,
  );

  $effect(() => {
    selectedProject =
      projects.find((project) => project.project_id === selectedProjectId) ?? null;
  });

  function isProjectOpen(projectId: string) {
    return openProjectIds.includes(projectId);
  }

  function workUnitsForProject(projectId: string) {
    return workUnits.filter((workUnit) => workUnit.project_id === projectId);
  }

  function toggleProject(projectId: string) {
    selectedProjectId = projectId;

    if (isProjectOpen(projectId)) {
      openProjectIds = openProjectIds.filter((id) => id !== projectId);
    } else {
      openProjectIds = [...openProjectIds, projectId];
    }
  }

  function projectMenuItems(project: ControlProjectRecordDto): MenuItem[] {
    return [
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

  function handleProjectAction(project: ControlProjectRecordDto, action: string) {
    mutationFailure = null;
    pendingDeleteProjectId = null;
    if (action === "rename") {
      renamingProjectId = project.project_id;
      renameName = project.display_name;
      return;
    }
    if (action === "delete") {
      pendingDeleteProjectId = project.project_id;
      return;
    }
    void mutateProject(project, action as "park" | "archive" | "restore");
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
    if (!displayName || mutatingProjectId) return;
    await mutateProject(project, "rename", displayName);
    if (!mutationFailure) {
      renamingProjectId = null;
      renameName = "";
    }
  }

  async function mutateProject(
    project: ControlProjectRecordDto,
    action: "rename" | "park" | "archive" | "restore" | "delete",
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
      projects = projectRecordsFromResponse(projectsResponse);

      const progress = await queryTaskWorkProgress();
      workUnits = progress.state === "records" ? progress.records : [];

      if (!projects.some((project) => project.project_id === selectedProjectId)) {
        selectedProjectId = projects[0]?.project_id ?? null;
      }
      if (selectedProjectId && openProjectIds.length === 0) {
        openProjectIds = [selectedProjectId];
      }
    } catch (error) {
      projects = [];
      workUnits = [];
      selectedProjectId = null;
      openProjectIds = [];
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadProjectRail();
  });
</script>

<section class="project-rail-list" aria-label="Projects">
  <header class="project-rail-head">
    <div>
      <h2>Projects</h2>
      <Text tone="muted">{projectCountLabel}</Text>
    </div>
    <div class="project-rail-actions">
      <button class="icon-button" type="button" aria-label="New project" onclick={() => (creating = true)}>
        <Icon icon={plus} size="sm" />
      </button>
      <button
        class="icon-button"
        type="button"
        aria-label="Refresh projects"
        disabled={loading}
        onclick={loadProjectRail}
      >
        <Icon icon={refreshCw} size="sm" />
      </button>
    </div>
  </header>

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
      <Text tone="muted">Loading projects.</Text>
    </div>
  {:else if projects.length === 0}
    <div class="rail-message">
      <Text tone="muted">No projects available.</Text>
    </div>
  {:else}
    <div class="project-stack">
      {#each projects as project}
        {@const open = isProjectOpen(project.project_id)}
        {@const active = project.project_id === selectedProjectId}
        {@const projectWorkUnits = workUnitsForProject(project.project_id)}
        <section class:active class="project-node">
          <div class="project-node-row">
            <button
              class="project-node-button"
              type="button"
              aria-expanded={open}
              aria-controls={`project-work-${project.project_id}`}
              onclick={() => toggleProject(project.project_id)}
            >
              <span class="project-node-icon" aria-hidden="true"><Icon icon={folder} size="sm" /></span>
              <span class="project-node-label">
                <span class="project-name">{project.display_name}</span>
                <span class="project-meta">{project.status} · {project.importance_level}</span>
              </span>
              <span class="project-chevron" aria-hidden="true"><Icon icon={open ? chevronDown : chevronRight} size="sm" /></span>
            </button>
            <Menu
              items={projectMenuItems(project)}
              ariaLabel={`Project actions for ${project.display_name}`}
              placement="bottom-end"
              onAction={(action) => handleProjectAction(project, action)}
            >
              {#snippet trigger()}
                <button class="project-menu-button" type="button" aria-label={`Project actions for ${project.display_name}`} disabled={mutatingProjectId !== null}>
                  <Icon icon={ellipsis} size="sm" />
                </button>
              {/snippet}
            </Menu>
          </div>

          {#if renamingProjectId === project.project_id}
            <form class="inline-project-form nested" onsubmit={(event) => { event.preventDefault(); void renameProject(project); }}>
              <input bind:value={renameName} aria-label="New project name" />
              <button type="submit" disabled={!renameName.trim() || mutatingProjectId !== null}>Save</button>
              <button type="button" onclick={() => (renamingProjectId = null)}>Cancel</button>
            </form>
          {/if}

          {#if pendingDeleteProjectId === project.project_id}
            <div class="delete-confirmation">
              <span>Delete only if this project has no retained work?</span>
              <button type="button" class="danger-action" onclick={() => void mutateProject(project, "delete")}>Delete</button>
              <button type="button" onclick={() => (pendingDeleteProjectId = null)}>Cancel</button>
            </div>
          {/if}

          {#if open}
            <div class="project-work-list" id={`project-work-${project.project_id}`}>
              {#if projectWorkUnits.length === 0}
                <div class="work-empty">
                  <Icon icon={bot} size="xs" />
                  <span>No active AI threads</span>
                </div>
              {:else}
                {#each projectWorkUnits as workUnit}
                  <div class="work-row">
                    <Icon icon={messageCircle} size="xs" />
                    <span class="work-copy">
                      <span class="work-title">{workUnit.summary}</span>
                      <span class="work-meta">{workUnit.runtime} · {workUnit.review}</span>
                    </span>
                  </div>
                {/each}
              {/if}
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

  .project-rail-actions,
  .project-node-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
  }

  .project-rail-head h2 {
    margin: 0;
    color: var(--poodle-color-text-primary);
    font-size: 0.8125rem;
    font-weight: 700;
    line-height: 1.2;
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
    gap: 0.25rem;
    min-width: 0;
    min-height: 0;
    flex: 1;
    overflow: auto;
  }

  .project-node {
    min-width: 0;
  }

  .project-node-button {
    flex: 1;
    display: grid;
    grid-template-columns: 1.25rem minmax(0, 1fr) 1.25rem;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-height: 2.5rem;
    padding: 0.375rem 0.5rem;
    color: var(--poodle-color-text-primary);
    text-align: left;
    border: 1px solid transparent;
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
  }

  .project-menu-button {
    display: inline-grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    flex: 0 0 auto;
    padding: 0;
    color: var(--poodle-color-text-muted);
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
  }

  .project-menu-button:hover:not(:disabled) {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-surface);
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

  .inline-project-form.nested,
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

  .project-node-button:hover {
    background: var(--poodle-color-background-surface);
    border-color: var(--poodle-color-border-subtle);
  }

  .project-node.active .project-node-button {
    background: var(--poodle-color-background-elevated);
    border-color: var(--poodle-color-border-default);
  }

  .project-node-icon,
  .project-chevron {
    display: inline-grid;
    place-items: center;
    color: var(--poodle-color-text-secondary);
  }

  .project-node.active .project-node-icon,
  .project-node.active .project-chevron {
    color: var(--poodle-color-text-primary);
  }

  .project-node-label,
  .work-copy {
    display: grid;
    min-width: 0;
  }

  .project-name,
  .work-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-name {
    font-size: 0.8125rem;
    font-weight: 650;
    line-height: 1.25;
  }

  .project-meta,
  .work-meta {
    overflow: hidden;
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-work-list {
    display: grid;
    gap: 0.25rem;
    margin: 0.125rem 0 0.375rem 1.25rem;
    padding-left: 0.625rem;
    border-left: 1px solid var(--poodle-color-border-subtle);
  }

  .work-row,
  .work-empty {
    display: grid;
    grid-template-columns: 1rem minmax(0, 1fr);
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    min-height: 1.75rem;
    padding: 0.25rem 0.375rem;
    color: var(--poodle-color-text-secondary);
    border-radius: var(--poodle-radius-control);
  }

  .work-row {
    background: color-mix(in srgb, var(--poodle-color-background-surface) 65%, transparent);
  }

  .work-empty {
    color: var(--poodle-color-text-muted);
    font-size: 0.75rem;
  }

  .work-title {
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
    line-height: 1.2;
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
