<script lang="ts">
  import { Icon, Text } from "@poodle/svelte";
  import { chevronRight, file, folder, refreshCw } from "@poodle/icons-lucide";
  import type { ControlProjectRecordDto, ControlProjectResourceRecordDto } from "./control";
  import { listEditorFiles } from "./control/editorFiles";
  import { buildFileTree, type FileTreeNode } from "./fileTree";

  type ResourceTree = {
    resource: ControlProjectResourceRecordDto;
    nodes: FileTreeNode[];
    error: string | null;
  };

  let {
    selectedProject,
  }: {
    selectedProject: ControlProjectRecordDto | null;
  } = $props();

  let resourceTrees = $state<ResourceTree[]>([]);
  let loading = $state(false);
  let loadSequence = 0;

  const availableResources = $derived(
    selectedProject?.resources.filter((resource) =>
      resource.role === "working"
      && resource.location_status === "present"
      && resource.locator_available
    ) ?? [],
  );

  $effect(() => {
    selectedProject?.project_id;
    selectedProject?.revision_id;
    void loadFiles();
  });

  async function loadFiles(): Promise<void> {
    const sequence = ++loadSequence;
    const project = selectedProject;
    resourceTrees = [];
    if (!project) return;

    loading = true;
    const trees = await Promise.all(availableResources.map(async (resource) => {
      try {
        const files = await listEditorFiles(project.project_id, resource.resource_id);
        return { resource, nodes: buildFileTree(files), error: null };
      } catch (caught) {
        return {
          resource,
          nodes: [],
          error: caught instanceof Error ? caught.message : String(caught),
        };
      }
    }));

    if (sequence === loadSequence && selectedProject?.project_id === project.project_id) {
      resourceTrees = trees;
      loading = false;
    }
  }

  function openFile(resourceId: string, node: FileTreeNode): void {
    if (!selectedProject || !node.file) return;
    window.dispatchEvent(new CustomEvent("nucleus:open-file", {
      detail: {
        projectId: selectedProject.project_id,
        resourceId,
        fileRef: node.file.file_ref,
      },
    }));
  }
</script>

<section class="sidebar-view" aria-label="Files">
  <header class="sidebar-view-head">
    <div>
      <h2>Files</h2>
      <Text tone="muted">{selectedProject?.display_name ?? "No project"}</Text>
    </div>
    <button type="button" aria-label="Refresh files" title="Refresh files" disabled={loading || !selectedProject} onclick={() => void loadFiles()}>
      <Icon icon={refreshCw} size="sm" />
    </button>
  </header>

  {#if !selectedProject}
    <div class="sidebar-message"><Text tone="muted">Select a project to browse files.</Text></div>
  {:else if loading && resourceTrees.length === 0}
    <div class="sidebar-message"><Text tone="muted">Loading files.</Text></div>
  {:else if availableResources.length === 0}
    <div class="sidebar-message"><Text tone="muted">This project has no available working resources.</Text></div>
  {:else}
    <div class="resource-trees">
      {#each resourceTrees as tree (tree.resource.resource_id)}
        <details class="resource-tree" open>
          <summary>
            <Icon icon={chevronRight} size="xs" />
            <Icon icon={folder} size="sm" />
            <span>
              <strong>{tree.resource.display_name}</strong>
              <small>{tree.resource.kind.replaceAll("_", " ")}</small>
            </span>
          </summary>
          {#if tree.error}
            <div class="resource-message"><Text tone="danger">{tree.error}</Text></div>
          {:else if tree.nodes.length === 0}
            <div class="resource-message"><Text tone="muted">No admitted text files.</Text></div>
          {:else}
            <div class="tree-root">
              {@render FileNodes(tree.nodes, tree.resource.resource_id)}
            </div>
          {/if}
        </details>
      {/each}
    </div>
  {/if}
</section>

{#snippet FileNodes(nodes: FileTreeNode[], resourceId: string)}
  {#each nodes as node (`${resourceId}:${node.path}`)}
    {#if node.kind === "directory"}
      <details class="tree-directory">
        <summary>
          <Icon icon={chevronRight} size="xs" />
          <Icon icon={folder} size="xs" />
          <span>{node.name}</span>
        </summary>
        <div class="tree-children">
          {@render FileNodes(node.children, resourceId)}
        </div>
      </details>
    {:else}
      <button class="tree-file" type="button" title={node.path} onclick={() => openFile(resourceId, node)}>
        <Icon icon={file} size="xs" />
        <span>{node.name}</span>
      </button>
    {/if}
  {/each}
{/snippet}

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

  .sidebar-view-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .sidebar-view-head h2 {
    margin: 0;
    font-size: 0.8125rem;
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

  .resource-trees {
    min-height: 0;
    overflow: auto;
  }

  summary {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    cursor: pointer;
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  details[open] > summary :global(svg:first-child) {
    transform: rotate(90deg);
  }

  .resource-tree {
    padding: 0.375rem 0;
    border-bottom: 1px solid var(--poodle-color-border-subtle);
  }

  .resource-tree > summary {
    min-height: 2rem;
  }

  .resource-tree summary span {
    display: grid;
    min-width: 0;
  }

  strong,
  small,
  .tree-file span,
  .tree-directory summary span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 0.8125rem;
  }

  small {
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
  }

  .tree-root,
  .tree-children {
    display: grid;
    min-width: 0;
  }

  .tree-root {
    padding: 0.25rem 0 0.25rem 0.5rem;
  }

  .tree-children {
    padding-left: 1rem;
  }

  .tree-directory summary,
  .tree-file {
    min-height: 1.625rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .tree-file {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    min-width: 0;
    padding: 0 0.25rem 0 1.125rem;
    text-align: left;
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
  }

  .tree-file:hover {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-surface);
  }

  .sidebar-message,
  .resource-message {
    padding: 0.75rem 0;
  }

  .resource-message {
    padding-left: 1.25rem;
  }
</style>
