<script lang="ts">
  import { Icon, Text } from "@poodle/svelte";
  import { gitBranch, gitFork, refreshCw } from "@poodle/icons-lucide";
  import { onMount } from "svelte";
  import {
    buildStateListQuery,
    projectRecordsFromResponse,
    submitControlEnvelope,
    type ControlProjectRecordDto,
  } from "./control";

  let {
    selectedProjectId = $bindable(null),
  }: {
    selectedProjectId: string | null;
  } = $props();

  let projects = $state<ControlProjectRecordDto[]>([]);
  let loading = $state(false);
  let failure = $state<string | null>(null);

  const repositoryProjects = $derived(projects
    .map((project) => ({
      project,
      repositories: project.resources.filter((resource) => resource.kind === "git_repository"),
    }))
    .filter((entry) => entry.repositories.length > 0));
  const repositoryCount = $derived(
    repositoryProjects.reduce((total, entry) => total + entry.repositories.length, 0),
  );

  onMount(() => {
    void loadRepositories();
  });

  async function loadRepositories(): Promise<void> {
    loading = true;
    failure = null;
    try {
      const response = await submitControlEnvelope(buildStateListQuery("projects"));
      projects = projectRecordsFromResponse(response);
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    } finally {
      loading = false;
    }
  }
</script>

<section class="sidebar-view" aria-label="Forge">
  <header class="sidebar-view-head">
    <Text tone="muted">{loading ? "Loading" : `${repositoryCount} repositories`}</Text>
    <button type="button" aria-label="Refresh repositories" title="Refresh repositories" disabled={loading} onclick={() => void loadRepositories()}>
      <Icon icon={refreshCw} size="sm" />
    </button>
  </header>

  {#if failure}
    <div class="sidebar-message"><Text tone="danger">{failure}</Text></div>
  {:else if !loading && repositoryProjects.length === 0}
    <div class="sidebar-message"><Text tone="muted">No Git resources are attached.</Text></div>
  {:else}
    <div class="forge-list">
      {#each repositoryProjects as entry (entry.project.project_id)}
        <section class="forge-project" class:active={entry.project.project_id === selectedProjectId}>
          <button
            class="forge-project-head"
            type="button"
            disabled={entry.project.status !== "active"}
            onclick={() => (selectedProjectId = entry.project.project_id)}
          >
            <span>{entry.project.display_name}</span>
            <small>{entry.project.status}</small>
          </button>
          {#each entry.repositories as repository (repository.resource_id)}
            <div class="repository-row">
              <Icon icon={gitFork} size="sm" />
              <span>
                <strong>{repository.display_name}</strong>
                <small>{repository.location_status}</small>
              </span>
              {#if repository.default_branch}
                <span class="branch-hint" title="Recorded default branch">
                  <Icon icon={gitBranch} size="xs" />
                  {repository.default_branch}
                </span>
              {/if}
            </div>
          {/each}
        </section>
      {/each}
    </div>
  {/if}
</section>

<style>
  .sidebar-view {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    height: 100%;
    min-width: 0;
    min-height: 0;
    padding: 0.75rem;
    overflow: hidden;
  }

  .sidebar-view-head,
  .forge-project-head,
  .repository-row,
  .branch-hint {
    display: flex;
    align-items: center;
  }

  .sidebar-view-head {
    justify-content: space-between;
    gap: 0.75rem;
  }

  .sidebar-view-head button {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    color: var(--poodle-color-text-secondary);
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
  }

  .forge-list {
    display: grid;
    align-content: start;
    gap: 0.5rem;
    min-height: 0;
    overflow: auto;
  }

  .forge-project {
    display: grid;
    gap: 0.25rem;
    padding: 0.375rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
  }

  .forge-project.active {
    border-color: var(--poodle-color-border-selected);
  }

  .forge-project-head {
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.125rem;
    color: var(--poodle-color-text-tertiary);
    text-align: left;
    border: 0;
    background: transparent;
  }

  .forge-project-head:hover:not(:disabled) {
    color: var(--poodle-color-text-secondary);
  }

  .forge-project.active .forge-project-head {
    color: var(--poodle-color-text-primary);
  }

  .repository-row {
    gap: 0.5rem;
    min-width: 0;
    padding: 0.375rem;
    color: var(--poodle-color-text-tertiary);
    background: var(--poodle-color-background-surface);
    border-radius: var(--poodle-radius-control);
  }

  .repository-row > span:not(.branch-hint) {
    display: grid;
    min-width: 0;
    flex: 1;
  }

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 0.75rem;
  }

  small {
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
  }

  .branch-hint {
    gap: 0.25rem;
    max-width: 40%;
    overflow: hidden;
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sidebar-message {
    padding: 0.75rem 0;
  }
</style>
