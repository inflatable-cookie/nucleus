<script lang="ts">
  import { Button, Icon, Menu, Text, type MenuItem } from "@poodle/svelte";
  import { chevronRight, ellipsis, file, folder, refreshCw } from "@poodle/icons-lucide";
  import { onMount, tick, untrack } from "svelte";
  import type { ControlProjectRecordDto, ControlProjectResourceRecordDto } from "./control";
  import type { EditorFileWatchEvent } from "./control/editorFileWatch";
  import {
    createEditorDirectory,
    createEditorFile,
    deleteEditorDirectory,
    deleteEditorFile,
    listEditorDirectory,
    renameEditorDirectory,
    renameEditorFile,
    type EditorDirectoryEntry,
    type EditorFileEntry,
    type EditorFileSnapshot,
  } from "./control/editorFiles";
  import {
    fileTreeRefreshDirectories,
    moveFileTreeExpansionPaths,
    parseFileTreeExpansionState,
    removeFileTreeExpansionPaths,
    serializeFileTreeExpansionState,
  } from "./fileTree";
  import {
    consumeEditorFileReveal,
    getActiveEditorFile,
    type ActiveEditorFile,
  } from "./editorNavigation";

  type LazyFileTreeNode = {
    name: string;
    path: string;
    kind: "directory" | "file";
    file: EditorFileEntry | null;
    children: LazyFileTreeNode[] | null;
    expanded: boolean;
    loading: boolean;
    error: string | null;
  };

  type ResourceTree = {
    resource: ControlProjectResourceRecordDto;
    nodes: LazyFileTreeNode[] | null;
    expanded: boolean;
    loading: boolean;
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
  let expandedResourceIds = new Set<string>();
  let expandedDirectoryPaths: Record<string, Set<string>> = {};
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let createTarget = $state<{
    resourceId: string;
    directoryPath: string;
    kind: "directory" | "file";
  } | null>(null);
  let renameTarget = $state<{
    resourceId: string;
    fileRef: string | null;
    displayPath: string;
    kind: "directory" | "file";
  } | null>(null);
  let deleteTarget = $state<{
    resourceId: string;
    fileRef: string | null;
    displayPath: string;
    name: string;
    kind: "directory" | "file";
  } | null>(null);
  let mutationName = $state("");
  let mutationKey = $state<string | null>(null);
  let mutationFailure = $state<string | null>(null);
  let mutationInput: HTMLInputElement;
  let sidebarElement: HTMLElement;
  let activeEditorFile = $state<ActiveEditorFile | null>(null);
  let revealTarget: ActiveEditorFile | null = null;
  const pendingRefreshPaths = new Map<string, Set<string>>();
  const rootMenuItems: MenuItem[] = [
    { value: "create-file", label: "New file…" },
    { value: "create-directory", label: "New folder…" },
  ];
  const directoryMenuItems: MenuItem[] = [
    ...rootMenuItems,
    { value: "separator", label: "", kind: "separator" },
    { value: "rename", label: "Rename…" },
    { value: "delete", label: "Delete", tone: "danger" },
  ];

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
    untrack(() => void loadFiles());
  });

  onMount(() => {
    activeEditorFile = getActiveEditorFile();
    window.addEventListener("nucleus:editor-files-changed", handleEditorFilesChanged);
    window.addEventListener("nucleus:active-editor-file-changed", handleActiveEditorFileChanged);
    window.addEventListener("nucleus:reveal-editor-file", handleEditorFileReveal);
    const pendingReveal = consumeEditorFileReveal();
    if (pendingReveal) queueEditorFileReveal(pendingReveal);
    return () => {
      window.removeEventListener("nucleus:editor-files-changed", handleEditorFilesChanged);
      window.removeEventListener("nucleus:active-editor-file-changed", handleActiveEditorFileChanged);
      window.removeEventListener("nucleus:reveal-editor-file", handleEditorFileReveal);
      cancelPendingRefresh();
    };
  });

  async function loadFiles(): Promise<void> {
    cancelPendingRefresh();
    const sequence = ++loadSequence;
    const project = selectedProject;
    resourceTrees = [];
    loading = false;
    if (!project) return;

    restoreExpansionState(project.project_id, availableResources);
    resourceTrees = availableResources.map((resource) => ({
      resource,
      nodes: null,
      expanded: expandedResourceIds.has(resource.resource_id),
      loading: false,
      error: null,
    }));
    loading = resourceTrees.some((tree) => tree.expanded);

    await Promise.all(
      resourceTrees
        .filter((tree) => tree.expanded)
        .map((tree) => loadResourceRoot(tree, sequence, project.project_id)),
    );

    if (requestIsCurrent(sequence, project.project_id)) {
      loading = false;
    }
  }

  async function loadResourceRoot(
    tree: ResourceTree,
    sequence: number,
    projectId: string,
  ): Promise<void> {
    tree.loading = true;
    tree.error = null;
    try {
      const entries = await listEditorDirectory(projectId, tree.resource.resource_id, null);
      if (!requestIsCurrent(sequence, projectId)) return;
      tree.nodes = entries.map((entry) => fileTreeNode(entry, tree.resource.resource_id));
      await hydrateExpandedDirectories(tree, tree.nodes, sequence, projectId);
    } catch (caught) {
      if (requestIsCurrent(sequence, projectId)) {
        tree.nodes = [];
        tree.error = formatError(caught);
      }
    } finally {
      if (requestIsCurrent(sequence, projectId)) {
        tree.loading = false;
      }
    }
  }

  async function loadDirectoryChildren(
    tree: ResourceTree,
    node: LazyFileTreeNode,
    sequence: number,
    projectId: string,
  ): Promise<void> {
    if (node.kind !== "directory") return;
    node.loading = true;
    node.error = null;
    try {
      const entries = await listEditorDirectory(
        projectId,
        tree.resource.resource_id,
        node.path,
      );
      if (!requestIsCurrent(sequence, projectId)) return;
      node.children = entries.map((entry) => fileTreeNode(entry, tree.resource.resource_id));
      await hydrateExpandedDirectories(tree, node.children, sequence, projectId);
    } catch (caught) {
      if (requestIsCurrent(sequence, projectId)) {
        node.children = [];
        node.error = formatError(caught);
      }
    } finally {
      if (requestIsCurrent(sequence, projectId)) {
        node.loading = false;
      }
    }
  }

  async function hydrateExpandedDirectories(
    tree: ResourceTree,
    nodes: LazyFileTreeNode[],
    sequence: number,
    projectId: string,
  ): Promise<void> {
    await Promise.all(
      nodes
        .filter((node) => node.kind === "directory" && node.expanded)
        .map((node) => loadDirectoryChildren(tree, node, sequence, projectId)),
    );
  }

  function fileTreeNode(
    entry: EditorDirectoryEntry,
    resourceId: string,
  ): LazyFileTreeNode {
    return {
      name: entry.name,
      path: entry.display_path,
      kind: entry.kind,
      file: entry.file ?? null,
      children: null,
      expanded: entry.kind === "directory"
        && (expandedDirectoryPaths[resourceId]?.has(entry.display_path) ?? false),
      loading: false,
      error: null,
    };
  }

  function toggleResource(tree: ResourceTree): void {
    tree.expanded = !tree.expanded;
    const next = new Set(expandedResourceIds);
    if (tree.expanded) {
      next.add(tree.resource.resource_id);
    } else {
      next.delete(tree.resource.resource_id);
    }
    expandedResourceIds = next;
    persistExpansionState();

    const projectId = selectedProject?.project_id;
    if (tree.expanded && tree.nodes === null && projectId) {
      void loadResourceRoot(tree, loadSequence, projectId);
    }
  }

  function toggleDirectory(tree: ResourceTree, node: LazyFileTreeNode): void {
    node.expanded = !node.expanded;
    const resourceId = tree.resource.resource_id;
    const next = new Set(expandedDirectoryPaths[resourceId] ?? []);
    if (node.expanded) {
      next.add(node.path);
    } else {
      next.delete(node.path);
    }
    expandedDirectoryPaths = { ...expandedDirectoryPaths, [resourceId]: next };
    persistExpansionState();

    const projectId = selectedProject?.project_id;
    if (node.expanded && node.children === null && projectId) {
      void loadDirectoryChildren(tree, node, loadSequence, projectId);
    }
  }

  function restoreExpansionState(
    projectId: string,
    resources: ControlProjectResourceRecordDto[],
  ): void {
    const stored = parseFileTreeExpansionState(
      window.localStorage.getItem(expansionStorageKey(projectId)),
    );
    expandedResourceIds = new Set(
      stored?.expandedResources ?? resources.map((resource) => resource.resource_id),
    );
    expandedDirectoryPaths = Object.fromEntries(
      Object.entries(stored?.expandedDirectories ?? {})
        .map(([resourceId, paths]) => [resourceId, new Set(paths)]),
    );
  }

  function persistExpansionState(): void {
    const projectId = selectedProject?.project_id;
    if (!projectId) return;
    try {
      window.localStorage.setItem(
        expansionStorageKey(projectId),
        serializeFileTreeExpansionState(expandedResourceIds, expandedDirectoryPaths),
      );
    } catch {
      // Tree expansion is convenience state; storage failure must not block browsing.
    }
  }

  function expansionStorageKey(projectId: string): string {
    return `nucleus:desktop:file-tree:v1:${projectId}`;
  }

  function requestIsCurrent(sequence: number, projectId: string): boolean {
    return sequence === loadSequence && selectedProject?.project_id === projectId;
  }

  function openFile(resourceId: string, node: LazyFileTreeNode): void {
    if (!selectedProject || !node.file) return;
    window.dispatchEvent(new CustomEvent("nucleus:open-file", {
      detail: {
        projectId: selectedProject.project_id,
        resourceId,
        fileRef: node.file.file_ref,
        displayPath: node.file.display_path,
      },
    }));
  }

  function handleActiveEditorFileChanged(event: Event): void {
    if (!(event instanceof CustomEvent)) return;
    activeEditorFile = event.detail as ActiveEditorFile | null;
  }

  function handleEditorFileReveal(): void {
    const target = consumeEditorFileReveal();
    if (target) queueEditorFileReveal(target);
  }

  function queueEditorFileReveal(target: ActiveEditorFile): void {
    activeEditorFile = target;
    revealTarget = target;
    void revealEditorFile(target);
  }

  async function revealEditorFile(target: ActiveEditorFile): Promise<void> {
    const projectId = selectedProject?.project_id;
    if (!projectId || target.projectId !== projectId) return;

    let tree = resourceTrees.find(
      (candidate) => candidate.resource.resource_id === target.resourceId,
    );
    if (!tree) {
      await loadFiles();
      if (revealTarget !== target) return;
      tree = resourceTrees.find(
        (candidate) => candidate.resource.resource_id === target.resourceId,
      );
    }
    if (!tree || !requestIsCurrent(loadSequence, projectId)) return;

    tree.expanded = true;
    expandedResourceIds = new Set(expandedResourceIds).add(target.resourceId);
    if (tree.nodes === null) {
      await loadResourceRoot(tree, loadSequence, projectId);
    }
    if (revealTarget !== target || !tree.nodes) return;

    const directoryPaths = parentDirectories(target.displayPath);
    for (const directoryPath of directoryPaths) {
      const directory = findDirectoryNode(tree.nodes, directoryPath);
      if (!directory) break;
      directory.expanded = true;
      const expanded = new Set(expandedDirectoryPaths[target.resourceId] ?? []);
      expanded.add(directory.path);
      expandedDirectoryPaths = {
        ...expandedDirectoryPaths,
        [target.resourceId]: expanded,
      };
      if (directory.children === null) {
        await loadDirectoryChildren(tree, directory, loadSequence, projectId);
      }
      if (revealTarget !== target) return;
    }

    persistExpansionState();
    await tick();
    if (revealTarget !== target) return;
    revealTarget = null;
    const row = Array.from(
      sidebarElement.querySelectorAll<HTMLElement>("[data-file-path]"),
    ).find((candidate) =>
      candidate.dataset.resourceId === target.resourceId
      && candidate.dataset.filePath === target.displayPath
    );
    row?.scrollIntoView({ block: "nearest" });
  }

  function parentDirectories(displayPath: string): string[] {
    const segments = displayPath.split("/").filter(Boolean);
    segments.pop();
    return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
  }

  function beginCreate(
    resourceId: string,
    directoryPath: string,
    kind: "directory" | "file",
  ): void {
    createTarget = { resourceId, directoryPath, kind };
    renameTarget = null;
    deleteTarget = null;
    mutationName = "";
    mutationFailure = null;
    void focusMutationInput();
  }

  function beginRename(resourceId: string, node: LazyFileTreeNode): void {
    createTarget = null;
    renameTarget = {
      resourceId,
      fileRef: node.file?.file_ref ?? null,
      displayPath: node.path,
      kind: node.kind,
    };
    deleteTarget = null;
    mutationName = node.name;
    mutationFailure = null;
    void focusMutationInput(true);
  }

  function beginDelete(resourceId: string, node: LazyFileTreeNode): void {
    createTarget = null;
    renameTarget = null;
    deleteTarget = {
      resourceId,
      fileRef: node.file?.file_ref ?? null,
      displayPath: node.path,
      name: node.name,
      kind: node.kind,
    };
    mutationFailure = null;
  }

  function cancelMutation(): void {
    createTarget = null;
    renameTarget = null;
    deleteTarget = null;
    mutationName = "";
    mutationFailure = null;
  }

  async function focusMutationInput(select = false): Promise<void> {
    await tick();
    mutationInput?.focus();
    if (select) mutationInput?.select();
  }

  function validFileName(): string | null {
    const name = mutationName.trim();
    return name
      && name !== "."
      && name !== ".."
      && !name.includes("/")
      && !name.includes("\\")
      ? name
      : null;
  }

  async function createEntry(): Promise<void> {
    const projectId = selectedProject?.project_id;
    const target = createTarget;
    const name = validFileName();
    if (!projectId || !target || !name || mutationKey) return;
    mutationKey = `create:${target.kind}:${target.resourceId}:${target.directoryPath}:${name}`;
    mutationFailure = null;
    try {
      const displayPath = joinPath(target.directoryPath, name);
      const opened = target.kind === "file"
        ? await createEditorFile({
            project_id: projectId,
            resource_id: target.resourceId,
            display_path: displayPath,
            content: "",
          })
        : null;
      if (target.kind === "directory") {
        await createEditorDirectory({
          project_id: projectId,
          resource_id: target.resourceId,
          display_path: displayPath,
        });
      }
      createTarget = null;
      mutationName = "";
      await refreshMutationDirectory(target.resourceId, target.directoryPath, true);
      if (opened) dispatchOpenFile(opened);
    } catch (caught) {
      mutationFailure = formatError(caught);
    } finally {
      mutationKey = null;
    }
  }

  async function renameEntry(): Promise<void> {
    const projectId = selectedProject?.project_id;
    const target = renameTarget;
    const name = validFileName();
    if (!projectId || !target || !name || mutationKey) return;
    const directoryPath = parentPath(target.displayPath);
    const targetPath = joinPath(directoryPath, name);
    if (targetPath === target.displayPath) {
      cancelMutation();
      return;
    }
    mutationKey = `rename:${target.kind}:${target.resourceId}:${target.displayPath}`;
    mutationFailure = null;
    try {
      if (target.kind === "file" && target.fileRef) {
        const renamed = await renameEditorFile({
          project_id: projectId,
          resource_id: target.resourceId,
          file_ref: target.fileRef,
          display_path: target.displayPath,
          target_display_path: targetPath,
        });
        window.dispatchEvent(new CustomEvent("nucleus:editor-file-renamed", {
          detail: {
            projectId,
            resourceId: target.resourceId,
            fileRef: target.fileRef,
            displayPath: target.displayPath,
            snapshot: renamed,
          },
        }));
      } else if (target.kind === "directory") {
        const renamed = await renameEditorDirectory({
          project_id: projectId,
          resource_id: target.resourceId,
          display_path: target.displayPath,
          target_display_path: targetPath,
        });
        migrateExpandedDirectoryPaths(target.resourceId, target.displayPath, targetPath);
        window.dispatchEvent(new CustomEvent("nucleus:editor-directory-renamed", {
          detail: {
            projectId: renamed.project_id,
            resourceId: renamed.resource_id,
            displayPath: renamed.display_path,
            targetDisplayPath: renamed.target_display_path,
            files: renamed.files,
          },
        }));
      } else {
        throw new Error("File rename target is unavailable.");
      }
      renameTarget = null;
      mutationName = "";
      await refreshMutationDirectory(target.resourceId, directoryPath);
    } catch (caught) {
      mutationFailure = formatError(caught);
    } finally {
      mutationKey = null;
    }
  }

  async function deleteEntry(): Promise<void> {
    const projectId = selectedProject?.project_id;
    const target = deleteTarget;
    if (!projectId || !target || mutationKey) return;
    mutationKey = `delete:${target.kind}:${target.resourceId}:${target.displayPath}`;
    mutationFailure = null;
    try {
      if (target.kind === "file" && target.fileRef) {
        const deleted = await deleteEditorFile({
          project_id: projectId,
          resource_id: target.resourceId,
          file_ref: target.fileRef,
          display_path: target.displayPath,
        });
        window.dispatchEvent(new CustomEvent("nucleus:editor-file-deleted", {
          detail: {
            projectId: deleted.project_id,
            resourceId: deleted.resource_id,
            fileRef: deleted.file_ref,
            displayPath: deleted.display_path,
          },
        }));
      } else if (target.kind === "directory") {
        const deleted = await deleteEditorDirectory({
          project_id: projectId,
          resource_id: target.resourceId,
          display_path: target.displayPath,
        });
        removeExpandedDirectoryPaths(target.resourceId, target.displayPath);
        window.dispatchEvent(new CustomEvent("nucleus:editor-directory-deleted", {
          detail: {
            projectId: deleted.project_id,
            resourceId: deleted.resource_id,
            displayPath: deleted.display_path,
            files: deleted.files,
          },
        }));
      } else {
        throw new Error("File delete target is unavailable.");
      }
      deleteTarget = null;
      await refreshMutationDirectory(target.resourceId, parentPath(target.displayPath));
    } catch (caught) {
      mutationFailure = formatError(caught);
    } finally {
      mutationKey = null;
    }
  }

  function migrateExpandedDirectoryPaths(
    resourceId: string,
    displayPath: string,
    targetDisplayPath: string,
  ): void {
    const expanded = moveFileTreeExpansionPaths(
      expandedDirectoryPaths[resourceId] ?? [],
      displayPath,
      targetDisplayPath,
    );
    expandedDirectoryPaths = { ...expandedDirectoryPaths, [resourceId]: expanded };
    persistExpansionState();
  }

  function removeExpandedDirectoryPaths(resourceId: string, displayPath: string): void {
    const expanded = removeFileTreeExpansionPaths(
      expandedDirectoryPaths[resourceId] ?? [],
      displayPath,
    );
    expandedDirectoryPaths = { ...expandedDirectoryPaths, [resourceId]: expanded };
    persistExpansionState();
  }

  async function refreshMutationDirectory(
    resourceId: string,
    directoryPath: string,
    expand = false,
  ): Promise<void> {
    const projectId = selectedProject?.project_id;
    const tree = resourceTrees.find(
      (candidate) => candidate.resource.resource_id === resourceId,
    );
    if (!projectId || !tree) return;
    if (!directoryPath) {
      await loadResourceRoot(tree, loadSequence, projectId);
      return;
    }
    const node = tree.nodes ? findDirectoryNode(tree.nodes, directoryPath) : null;
    if (!node) return;
    if (expand && !node.expanded) {
      node.expanded = true;
      const paths = new Set(expandedDirectoryPaths[resourceId] ?? []);
      paths.add(node.path);
      expandedDirectoryPaths = { ...expandedDirectoryPaths, [resourceId]: paths };
      persistExpansionState();
    }
    if (node.expanded || node.children !== null) {
      await loadDirectoryChildren(tree, node, loadSequence, projectId);
    }
  }

  function dispatchOpenFile(opened: EditorFileSnapshot): void {
    window.dispatchEvent(new CustomEvent("nucleus:open-file", {
      detail: {
        projectId: opened.project_id,
        resourceId: opened.resource_id,
        fileRef: opened.file_ref,
        displayPath: opened.display_path,
      },
    }));
  }

  function joinPath(directoryPath: string, name: string): string {
    return directoryPath ? `${directoryPath}/${name}` : name;
  }

  function parentPath(displayPath: string): string {
    const separator = displayPath.lastIndexOf("/");
    return separator < 0 ? "" : displayPath.slice(0, separator);
  }

  function handleNodeAction(
    resourceId: string,
    node: LazyFileTreeNode,
    action: string,
  ): void {
    if (action === "create-file" && node.kind === "directory") {
      beginCreate(resourceId, node.path, "file");
    } else if (action === "create-directory" && node.kind === "directory") {
      beginCreate(resourceId, node.path, "directory");
    } else if (action === "rename") {
      beginRename(resourceId, node);
    } else if (action === "delete") {
      beginDelete(resourceId, node);
    }
  }

  function fileMenuItems(node: LazyFileTreeNode): MenuItem[] {
    const disabled = !node.file?.writable;
    return [
      { value: "rename", label: "Rename…", disabled },
      { value: "separator", label: "", kind: "separator" },
      { value: "delete", label: "Delete", tone: "danger", disabled },
    ];
  }

  function handleEditorFilesChanged(event: Event): void {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as EditorFileWatchEvent;
    if (
      detail.kind !== "changed"
      || detail.project_id !== selectedProject?.project_id
    ) {
      return;
    }
    const pending = pendingRefreshPaths.get(detail.resource_id) ?? new Set<string>();
    detail.paths.forEach((path) => pending.add(path));
    pendingRefreshPaths.set(detail.resource_id, pending);
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshChangedDirectories();
    }, 120);
  }

  function cancelPendingRefresh(): void {
    pendingRefreshPaths.clear();
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  async function refreshChangedDirectories(): Promise<void> {
    const projectId = selectedProject?.project_id;
    if (!projectId) {
      pendingRefreshPaths.clear();
      return;
    }
    const sequence = loadSequence;
    const refreshes = [...pendingRefreshPaths.entries()];
    pendingRefreshPaths.clear();
    await Promise.all(refreshes.map(async ([resourceId, paths]) => {
      const tree = resourceTrees.find(
        (candidate) => candidate.resource.resource_id === resourceId,
      );
      const nodes = tree?.nodes;
      if (!tree || !nodes) return;
      const directories = fileTreeRefreshDirectories([...paths]);
      if (directories.includes("")) {
        await loadResourceRoot(tree, sequence, projectId);
        return;
      }
      await Promise.all(directories.map(async (directory) => {
        const node = findDirectoryNode(nodes, directory);
        if (node && node.children !== null) {
          await loadDirectoryChildren(tree, node, sequence, projectId);
        }
      }));
    }));
  }

  function findDirectoryNode(
    nodes: LazyFileTreeNode[],
    path: string,
  ): LazyFileTreeNode | null {
    for (const node of nodes) {
      if (node.kind !== "directory") continue;
      if (node.path === path) return node;
      if (node.children) {
        const found = findDirectoryNode(node.children, path);
        if (found) return found;
      }
    }
    return null;
  }

  function formatError(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  function retryResourceRoot(tree: ResourceTree): void {
    if (!selectedProject) return;
    void loadResourceRoot(tree, loadSequence, selectedProject.project_id);
  }

  function retryDirectory(tree: ResourceTree, node: LazyFileTreeNode): void {
    if (!selectedProject) return;
    void loadDirectoryChildren(tree, node, loadSequence, selectedProject.project_id);
  }
</script>

<section bind:this={sidebarElement} class="sidebar-view" aria-label="Files">
  <header class="sidebar-view-head">
    <span class="sidebar-dimmed">{selectedProject?.display_name ?? "No project"}</span>
    <button type="button" aria-label="Refresh files" title="Refresh files" disabled={loading || !selectedProject} onclick={() => void loadFiles()}>
      <Icon icon={refreshCw} size="sm" />
    </button>
  </header>

  {#if mutationFailure}
    <div class="mutation-error" role="alert"><Text tone="danger">{mutationFailure}</Text></div>
  {/if}

  {#if !selectedProject}
    <div class="sidebar-message"><span class="sidebar-dimmed">Select a project to browse files.</span></div>
  {:else if loading && resourceTrees.length === 0}
    <div class="sidebar-message" role="status" aria-live="polite"><span class="sidebar-dimmed">Loading files.</span></div>
  {:else if availableResources.length === 0}
    <div class="sidebar-message"><span class="sidebar-dimmed">This project has no available working resources.</span></div>
  {:else}
    <div class="resource-trees">
      {#each resourceTrees as tree (tree.resource.resource_id)}
        <section class="resource-tree">
          <div class="resource-summary-row">
            <button
              class="resource-summary"
              type="button"
              aria-expanded={tree.expanded}
              onclick={() => toggleResource(tree)}
            >
              <span class:expanded={tree.expanded} class="tree-chevron">
                <Icon icon={chevronRight} size="xs" />
              </span>
              <Icon icon={folder} size="sm" />
              <span class="resource-copy">
                <strong>{tree.resource.display_name}</strong>
                <small>{tree.resource.kind.replaceAll("_", " ")}</small>
              </span>
            </button>
            <Menu
              items={rootMenuItems}
              ariaLabel={`File actions for ${tree.resource.display_name}`}
              placement="bottom-end"
              onAction={(action) => {
                if (action === "create-file") {
                  beginCreate(tree.resource.resource_id, "", "file");
                } else if (action === "create-directory") {
                  beginCreate(tree.resource.resource_id, "", "directory");
                }
              }}
            >
              {#snippet trigger()}
                <button
                  class="tree-menu-button"
                  type="button"
                  aria-label={`File actions for ${tree.resource.display_name}`}
                  disabled={mutationKey !== null}
                >
                  <Icon icon={ellipsis} size="sm" />
                </button>
              {/snippet}
            </Menu>
          </div>
          {#if createTarget?.resourceId === tree.resource.resource_id && createTarget.directoryPath === ""}
            {@render FileNameForm("create")}
          {/if}
          {#if tree.expanded}
            {#if tree.loading && tree.nodes === null}
              <div class="resource-message" role="status"><span class="sidebar-dimmed">Loading.</span></div>
            {:else if tree.error}
              <div class="resource-message" role="alert">
                <Text tone="danger">{tree.error}</Text>
                <Button variant="secondary" size="xs" onClick={() => retryResourceRoot(tree)}>Retry</Button>
              </div>
            {:else if tree.nodes?.length === 0}
              <div class="resource-message"><span class="sidebar-dimmed">No admitted text files.</span></div>
            {:else if tree.nodes}
              <div class="tree-root">
                {@render FileNodes(tree.nodes, tree)}
              </div>
            {/if}
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</section>

{#snippet FileNodes(nodes: LazyFileTreeNode[], tree: ResourceTree)}
  {#each nodes as node (`${tree.resource.resource_id}:${node.path}`)}
    {#if node.kind === "directory"}
      <section class="tree-directory">
        {#if renameTarget?.resourceId === tree.resource.resource_id && renameTarget.displayPath === node.path}
          {@render FileNameForm("rename")}
        {:else}
          <div class="tree-node-row">
            <button
              class="tree-directory-row"
              type="button"
              aria-expanded={node.expanded}
              onclick={() => toggleDirectory(tree, node)}
            >
              <span class:expanded={node.expanded} class="tree-chevron">
                <Icon icon={chevronRight} size="xs" />
              </span>
              <Icon icon={folder} size="xs" />
              <span>{node.name}</span>
            </button>
            <Menu
              items={directoryMenuItems}
              ariaLabel={`File actions for ${node.path}`}
              placement="bottom-end"
              onAction={(action) => handleNodeAction(tree.resource.resource_id, node, action)}
            >
              {#snippet trigger()}
                <button
                  class="tree-menu-button"
                  type="button"
                  aria-label={`File actions for ${node.path}`}
                  disabled={mutationKey !== null}
                >
                  <Icon icon={ellipsis} size="xs" />
                </button>
              {/snippet}
            </Menu>
          </div>
        {/if}
        {#if deleteTarget?.resourceId === tree.resource.resource_id && deleteTarget.displayPath === node.path}
          {@render DeleteConfirmation()}
        {/if}
        {#if createTarget?.resourceId === tree.resource.resource_id && createTarget.directoryPath === node.path}
          {@render FileNameForm("create")}
        {/if}
        {#if node.expanded}
          {#if node.loading && node.children === null}
            <div class="tree-message" role="status">Loading.</div>
          {:else if node.error}
            <div class="tree-message tree-error" role="alert">
              <span>{node.error}</span>
              <Button variant="secondary" size="xs" onClick={() => retryDirectory(tree, node)}>Retry</Button>
            </div>
          {:else if node.children?.length === 0}
            <div class="tree-message">Empty.</div>
          {:else if node.children}
            <div class="tree-children">
              {@render FileNodes(node.children, tree)}
            </div>
          {/if}
        {/if}
      </section>
    {:else}
      <div class="tree-file-shell">
        {#if renameTarget?.resourceId === tree.resource.resource_id && renameTarget.displayPath === node.path}
          {@render FileNameForm("rename")}
        {:else}
          <button
            class:active={activeEditorFile?.projectId === selectedProject?.project_id
              && activeEditorFile?.resourceId === tree.resource.resource_id
              && activeEditorFile?.fileRef === node.file?.file_ref
              && activeEditorFile?.displayPath === node.path}
            class="tree-file"
            type="button"
            title={node.path}
            aria-current={activeEditorFile?.projectId === selectedProject?.project_id
              && activeEditorFile?.resourceId === tree.resource.resource_id
              && activeEditorFile?.fileRef === node.file?.file_ref
              && activeEditorFile?.displayPath === node.path
              ? "page"
              : undefined}
            data-resource-id={tree.resource.resource_id}
            data-file-path={node.path}
            onclick={() => openFile(tree.resource.resource_id, node)}
          >
            <Icon icon={file} size="xs" />
            <span>{node.name}</span>
          </button>
          <Menu
            items={fileMenuItems(node)}
            ariaLabel={`File actions for ${node.path}`}
            placement="bottom-end"
            onAction={(action) => handleNodeAction(tree.resource.resource_id, node, action)}
          >
            {#snippet trigger()}
              <button
                class="tree-menu-button"
                type="button"
                aria-label={`File actions for ${node.path}`}
                disabled={mutationKey !== null}
              >
                <Icon icon={ellipsis} size="xs" />
              </button>
            {/snippet}
          </Menu>
        {/if}
      </div>
      {#if deleteTarget?.resourceId === tree.resource.resource_id && deleteTarget.displayPath === node.path}
        {@render DeleteConfirmation()}
      {/if}
    {/if}
  {/each}
{/snippet}

{#snippet FileNameForm(mode: "create" | "rename")}
  <form
    class="file-name-form"
    onsubmit={(event) => {
      event.preventDefault();
      if (mode === "create") void createEntry();
      else void renameEntry();
    }}
  >
    <input
      bind:this={mutationInput}
      bind:value={mutationName}
      aria-label={mode === "create"
        ? `New ${createTarget?.kind === "directory" ? "folder" : "file"} name`
        : `Rename ${renameTarget?.kind === "directory" ? "folder" : "file"}`}
      placeholder={createTarget?.kind === "directory" || renameTarget?.kind === "directory"
        ? "Folder name"
        : "File name"}
      disabled={mutationKey !== null}
      onkeydown={(event) => {
        if (event.key === "Escape") cancelMutation();
      }}
    />
    <button type="submit" disabled={!validFileName() || mutationKey !== null}>
      {mode === "create" ? "Create" : "Rename"}
    </button>
    <button type="button" disabled={mutationKey !== null} onclick={cancelMutation}>Cancel</button>
  </form>
{/snippet}

{#snippet DeleteConfirmation()}
  {#if deleteTarget}
    <div class="entry-delete-confirmation">
      <span>
        {deleteTarget.kind === "directory"
          ? `Delete ${deleteTarget.name} and all contents?`
          : `Delete ${deleteTarget.name}?`}
      </span>
      <button class="danger-action" type="button" disabled={mutationKey !== null} onclick={() => void deleteEntry()}>Delete</button>
      <button type="button" disabled={mutationKey !== null} onclick={cancelMutation}>Cancel</button>
    </div>
  {/if}
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

  .sidebar-dimmed {
    color: var(--poodle-color-text-secondary);
    opacity: var(--poodle-state-opacity-muted);
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

  .mutation-error {
    font-size: 0.75rem;
  }

  .resource-trees {
    min-height: 0;
    overflow: auto;
  }

  .resource-summary,
  .tree-directory-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    min-width: 0;
    padding: 0;
    color: inherit;
    text-align: left;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .resource-summary-row,
  .tree-node-row,
  .tree-file-shell {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .resource-summary,
  .tree-directory-row,
  .tree-file {
    flex: 1;
  }

  .tree-chevron {
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    transition: transform 100ms ease;
  }

  .tree-chevron.expanded {
    transform: rotate(90deg);
  }

  .resource-tree {
    padding: 0.375rem 0;
    border-bottom: 1px solid var(--poodle-color-border-subtle);
  }

  .resource-summary {
    min-height: 2rem;
    color: var(--poodle-color-text-secondary);
  }

  .resource-copy {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  strong,
  small,
  .tree-file span,
  .tree-directory-row > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 0.8125rem;
  }

  small {
    color: var(--poodle-color-text-secondary);
    font-size: 0.6875rem;
    opacity: var(--poodle-state-opacity-muted);
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

  .tree-directory-row,
  .tree-file {
    min-height: 1.625rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
    opacity: var(--poodle-state-opacity-muted);
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

  .tree-menu-button {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    color: var(--poodle-color-text-muted);
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
    opacity: 0;
    cursor: pointer;
  }

  .resource-summary-row:hover .tree-menu-button,
  .tree-node-row:hover .tree-menu-button,
  .tree-file-shell:hover .tree-menu-button,
  .tree-menu-button:focus {
    opacity: 1;
  }

  .tree-menu-button:hover {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-surface);
  }

  .file-name-form,
  .entry-delete-confirmation {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    padding: 0.25rem 0 0.25rem 1.125rem;
    font-size: 0.6875rem;
  }

  .file-name-form input {
    flex: 1;
    min-width: 0;
    padding: 0.25rem 0.375rem;
    color: var(--poodle-color-text-primary);
    font: inherit;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    outline: none;
    background: var(--poodle-color-background-canvas);
  }

  .file-name-form input:focus {
    border-color: var(--poodle-color-border-strong);
  }

  .file-name-form button,
  .entry-delete-confirmation button {
    padding: 0.25rem 0.375rem;
    color: var(--poodle-color-text-secondary);
    font: inherit;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
  }

  .entry-delete-confirmation {
    justify-content: flex-end;
    color: var(--poodle-color-text-secondary);
  }

  .entry-delete-confirmation span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entry-delete-confirmation .danger-action {
    color: var(--poodle-color-status-danger);
  }

  .tree-directory-row {
    border-radius: var(--poodle-radius-control);
  }

  .tree-file:hover {
    color: var(--poodle-color-text-secondary);
    background: var(--poodle-color-background-surface);
    opacity: 1;
  }

  .tree-file.active {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-surface);
    opacity: 1;
  }

  .tree-directory-row:hover {
    background: var(--poodle-color-background-surface);
    opacity: 1;
  }

  .sidebar-message,
  .resource-message {
    padding: 0.75rem 0;
  }

  .resource-message {
    padding-left: 1.25rem;
  }

  .tree-message {
    padding: 0.25rem 0 0.25rem 2.125rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.6875rem;
    opacity: var(--poodle-state-opacity-muted);
  }

  .tree-error {
    color: var(--poodle-color-status-danger);
  }
</style>
