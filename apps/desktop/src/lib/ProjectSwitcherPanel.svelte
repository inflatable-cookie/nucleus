<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import { onMount } from "svelte";
  import {
    buildStateListQuery,
    projectRecordsFromResponse,
    submitControlEnvelope,
    type ControlProjectRecordDto,
  } from "./control";

  type Props = {
    selectedProjectId: string | null;
  };

  let { selectedProjectId = $bindable(null) }: Props = $props();
  let loading = $state(false);
  let projects = $state<ControlProjectRecordDto[]>([]);
  let failure = $state<string | null>(null);

  const selectedProject = $derived(
    projects.find((project) => project.project_id === selectedProjectId) ?? null,
  );
  const statusLabel = $derived(
    loading ? "loading" : failure ? "error" : `${projects.length} project${projects.length === 1 ? "" : "s"}`,
  );
  const statusTone = $derived(loading ? "pending" : failure ? "danger" : "success");

  async function loadProjects() {
    loading = true;
    failure = null;

    try {
      const response = await submitControlEnvelope(buildStateListQuery("projects"));
      projects = projectRecordsFromResponse(response);
      if (!projects.some((project) => project.project_id === selectedProjectId)) {
        selectedProjectId = projects[0]?.project_id ?? null;
      }
    } catch (error) {
      projects = [];
      selectedProjectId = null;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadProjects();
  });
</script>

<Surface>
  <section class="project-switcher" aria-label="Project Switcher">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Projects</h2>
        <Text tone="muted">Read-only server-owned project records.</Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    {#if failure}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{failure}</Text>
      </div>
    {:else if loading}
      <div class="panel-message">
        <Text tone="muted">Loading projects.</Text>
      </div>
    {:else if projects.length === 0}
      <div class="panel-message">
        <Text tone="muted">No projects available.</Text>
      </div>
    {:else}
      <div class="project-list">
        {#each projects as project}
          <button
            class:selected={project.project_id === selectedProjectId}
            type="button"
            onclick={() => (selectedProjectId = project.project_id)}
          >
            <span>{project.display_name}</span>
            <small>{project.status} · {project.importance_level}</small>
          </button>
        {/each}
      </div>
    {/if}

    <div class="panel-actions">
      <Text tone="muted">
        {selectedProject ? selectedProject.project_id : "No project selected"}
      </Text>
      <Button variant="secondary" leadingIcon={refreshCw} onClick={loadProjects} disabled={loading}>
        Refresh
      </Button>
    </div>
  </section>
</Surface>
