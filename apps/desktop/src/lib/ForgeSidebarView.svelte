<script lang="ts">
  import { Button, Icon, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import { onMount } from "svelte";
  import {
    buildStateListQuery,
    commitScmWorkingCopy,
    inspectScmWorkingCopies,
    mutateScmWorkingCopy,
    projectRecordsFromResponse,
    submitControlEnvelope,
    type ControlProjectRecordDto,
    type ScmWorkingCopyFileStatus,
    type ScmWorkingCopyInspection,
    type ScmWorkingCopyMutationAction,
  } from "./control";
  import ForgeRepositoryNode from "./ForgeRepositoryNode.svelte";

  let {
    selectedProjectId = $bindable(null),
  }: {
    selectedProjectId: string | null;
  } = $props();

  let projects = $state<ControlProjectRecordDto[]>([]);
  let inspections = $state<Record<string, ScmWorkingCopyInspection>>({});
  let expandedRepositories = $state<Set<string>>(new Set());
  let loading = $state(false);
  let failure = $state<string | null>(null);
  let mutationKey = $state<string | null>(null);
  let mutationFailure = $state<string | null>(null);
  let commitMessages = $state<Record<string, string>>({});
  let repositoryNotices = $state<Record<string, string>>({});
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const repositoryProjects = $derived(projects
    .map((project) => ({
      project,
      repositories: project.resources.filter((resource) => resource.kind === "git_repository"),
    }))
    .filter((entry) => entry.repositories.length > 0));
  const repositoryCount = $derived(
    repositoryProjects.reduce((total, entry) => total + entry.repositories.length, 0),
  );
  const changeCount = $derived(
    Object.values(inspections).reduce((total, inspection) => total + inspection.files.length, 0),
  );

  onMount(() => {
    void loadRepositories();
    window.addEventListener("nucleus:editor-files-changed", scheduleStatusRefresh);
    window.addEventListener("nucleus:scm-working-copy-changed", scheduleStatusRefresh);
    window.addEventListener("nucleus:command-forge-refresh", commandRefreshForge);
    return () => {
      window.removeEventListener("nucleus:editor-files-changed", scheduleStatusRefresh);
      window.removeEventListener("nucleus:scm-working-copy-changed", scheduleStatusRefresh);
      window.removeEventListener("nucleus:command-forge-refresh", commandRefreshForge);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  });

  async function loadRepositories(): Promise<void> {
    loading = true;
    failure = null;
    try {
      const response = await submitControlEnvelope(buildStateListQuery("projects"));
      const loadedProjects = projectRecordsFromResponse(response);
      projects = loadedProjects;
      await loadStatuses(loadedProjects);
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    } finally {
      loading = false;
    }
  }

  function commandRefreshForge(): void {
    void loadRepositories();
  }

  async function loadStatuses(sourceProjects = projects): Promise<void> {
    const requests = sourceProjects.flatMap((project) =>
      project.resources
        .filter((resource) =>
          resource.kind === "git_repository"
          && resource.location_status === "present"
          && resource.locator_available
        )
        .map((resource) => ({
          project_id: project.project_id,
          resource_id: resource.resource_id,
        }))
    );
    if (requests.length === 0) {
      inspections = {};
      return;
    }
    const results = await inspectScmWorkingCopies(requests);
    inspections = Object.fromEntries(results.map((result) => [
      repositoryKey(result.project_id, result.resource_id),
      result,
    ]));
  }

  function scheduleStatusRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void loadStatuses().catch((caught) => {
        failure = caught instanceof Error ? caught.message : String(caught);
      });
    }, 250);
  }

  function repositoryKey(projectId: string, resourceId: string): string {
    return `${projectId}:${resourceId}`;
  }

  function toggleRepository(projectId: string, resourceId: string): void {
    const key = repositoryKey(projectId, resourceId);
    const next = new Set(expandedRepositories);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedRepositories = next;
  }

  function openChangedDiff(
    projectId: string,
    resourceId: string,
    file: ScmWorkingCopyFileStatus,
    scope: "staged" | "working",
  ): void {
    selectedProjectId = projectId;
    window.dispatchEvent(new CustomEvent("nucleus:open-forge-diff", {
      detail: {
        projectId,
        resourceId,
        path: file.path,
        scope,
      },
    }));
  }

  async function mutatePaths(
    projectId: string,
    resourceId: string,
    inspection: ScmWorkingCopyInspection,
    paths: string[],
    action: ScmWorkingCopyMutationAction,
  ): Promise<void> {
    const statusFingerprint = inspection.status_fingerprint;
    if (!statusFingerprint) {
      mutationFailure = "Refresh the repository before changing its staging state.";
      return;
    }
    const repository = repositoryKey(projectId, resourceId);
    const operationKey = `${repository}:${action}:${paths.join("\0")}`;
    mutationKey = operationKey;
    mutationFailure = null;
    repositoryNotices = { ...repositoryNotices, [repository]: "" };
    try {
      const result = await mutateScmWorkingCopy({
        project_id: projectId,
        resource_id: resourceId,
        action,
        paths,
        expected_status_fingerprint: statusFingerprint,
        idempotency_key: `forge:${action}:${crypto.randomUUID()}`,
      });
      inspections = {
        ...inspections,
        [repository]: result.inspection,
      };
      window.dispatchEvent(new CustomEvent("nucleus:scm-working-copy-changed", {
        detail: {
          project_id: projectId,
          resource_id: resourceId,
          paths,
        },
      }));
    } catch (caught) {
      mutationFailure = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (mutationKey === operationKey) mutationKey = null;
    }
  }

  function setCommitMessage(repository: string, message: string): void {
    commitMessages = { ...commitMessages, [repository]: message };
  }

  async function commitRepository(
    projectId: string,
    resourceId: string,
    inspection: ScmWorkingCopyInspection,
  ): Promise<void> {
    const repository = repositoryKey(projectId, resourceId);
    const message = commitMessages[repository] ?? "";
    const statusFingerprint = inspection.status_fingerprint;
    if (!statusFingerprint || !message.trim()) {
      mutationFailure = "Refresh the repository and enter a commit message.";
      return;
    }
    const operationKey = `${repository}:commit`;
    mutationKey = operationKey;
    mutationFailure = null;
    repositoryNotices = { ...repositoryNotices, [repository]: "" };
    try {
      const result = await commitScmWorkingCopy({
        project_id: projectId,
        resource_id: resourceId,
        message,
        expected_status_fingerprint: statusFingerprint,
        idempotency_key: `forge:commit:${crypto.randomUUID()}`,
      });
      inspections = { ...inspections, [repository]: result.inspection };
      commitMessages = { ...commitMessages, [repository]: "" };
      repositoryNotices = {
        ...repositoryNotices,
        [repository]: `Committed ${result.receipt.commit_oid.slice(0, 8)}`,
      };
      window.dispatchEvent(new CustomEvent("nucleus:scm-working-copy-changed", {
        detail: {
          project_id: projectId,
          resource_id: resourceId,
          paths: result.receipt.staged_paths,
        },
      }));
    } catch (caught) {
      mutationFailure = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (mutationKey === operationKey) mutationKey = null;
    }
  }

</script>

<section class="sidebar-view" aria-label="Forge">
  <header class="sidebar-view-head">
    <span class="sidebar-dimmed" role="status" aria-live="polite">
      {loading
        ? "Loading"
        : `${repositoryCount} ${repositoryCount === 1 ? "repository" : "repositories"}${changeCount > 0 ? ` · ${changeCount} changed` : ""}`}
    </span>
    <button
      type="button"
      aria-label="Refresh repositories"
      title="Refresh repositories"
      disabled={loading}
      onclick={() => void loadRepositories()}
    >
      <Icon icon={refreshCw} size="sm" />
    </button>
  </header>

  {#if failure}
    <div class="sidebar-message" role="alert">
      <Text tone="danger">{failure}</Text>
      <Button variant="secondary" size="xs" onClick={() => void loadRepositories()}>Retry</Button>
    </div>
  {/if}
  {#if mutationFailure}
    <div class="sidebar-message" role="alert"><Text tone="danger">{mutationFailure}</Text></div>
  {/if}
  {#if !failure && !loading && repositoryProjects.length === 0}
    <div class="sidebar-message"><span class="sidebar-dimmed">No Git resources are attached.</span></div>
  {:else if !failure}
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
            {@const key = repositoryKey(entry.project.project_id, repository.resource_id)}
            {@const inspection = inspections[key]}
            {@const expanded = expandedRepositories.has(key)}
            <ForgeRepositoryNode
              {repository}
              {inspection}
              {expanded}
              {mutationKey}
              commitBusy={mutationKey === `${key}:commit`}
              commitMessage={commitMessages[key] ?? ""}
              notice={repositoryNotices[key] ?? ""}
              onToggle={() => toggleRepository(entry.project.project_id, repository.resource_id)}
              onOpen={(file, scope) =>
                openChangedDiff(
                  entry.project.project_id,
                  repository.resource_id,
                  file,
                  scope,
                )}
              onMutate={(paths, action) =>
                void mutatePaths(
                  entry.project.project_id,
                  repository.resource_id,
                  inspection,
                  paths,
                  action,
                )}
              onCommitMessageChange={(message) => setCommitMessage(key, message)}
              onCommit={() =>
                void commitRepository(
                  entry.project.project_id,
                  repository.resource_id,
                  inspection,
                )}
            />
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
  .forge-project-head {
    display: flex;
    align-items: center;
  }

  .sidebar-view-head {
    justify-content: space-between;
    gap: 0.75rem;
  }

  .sidebar-dimmed,
  small {
    color: var(--poodle-color-text-muted);
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
    gap: 0.75rem;
    min-height: 0;
    overflow: auto;
  }

  .forge-project {
    display: grid;
    gap: 0.125rem;
    min-width: 0;
  }

  .forge-project-head {
    justify-content: space-between;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.25rem 0.375rem;
    color: var(--poodle-color-text-muted);
    text-align: left;
    border: 0;
    background: transparent;
  }

  .forge-project-head:hover:not(:disabled),
  .forge-project.active .forge-project-head {
    color: var(--poodle-color-text-primary);
  }

  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    font-size: 0.6875rem;
  }

  .sidebar-message {
    padding: 0.5rem 0.375rem;
    font-size: 0.75rem;
  }
</style>
