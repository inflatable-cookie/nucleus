<script lang="ts">
  import { Tabs, type TabItem } from "@inflatable-cookie/poodle-svelte";
  import { files, folderTree, gitBranch, messagesSquare } from "../icons.generated";
  import { onMount } from "svelte";
  import type { ControlProjectRecordDto } from "./control";
  import FilesSidebarView from "./FilesSidebarView.svelte";
  import ForgeSidebarView from "./ForgeSidebarView.svelte";
  import ProjectRail from "./ProjectRail.svelte";
  import ThreadsSidebarView from "./ThreadsSidebarView.svelte";

  type SidebarMode = "projects" | "threads" | "files" | "forge";

  let {
    selectedProjectId = $bindable(null),
    selectedProject = $bindable(null),
    selectedConversationId = $bindable(null),
  }: {
    selectedProjectId: string | null;
    selectedProject: ControlProjectRecordDto | null;
    selectedConversationId: string | null;
  } = $props();

  const storageKey = "nucleus:desktop:sidebar-mode";
  const items: TabItem[] = [
    { value: "projects", label: "Projects", icon: folderTree },
    { value: "threads", label: "Threads", icon: messagesSquare },
    { value: "files", label: "Files", icon: files },
    { value: "forge", label: "Forge", icon: gitBranch },
  ];
  let activeMode = $state<SidebarMode>("projects");

  onMount(() => {
    const stored = window.localStorage.getItem(storageKey);
    if (isSidebarMode(stored)) activeMode = stored;
    window.addEventListener("nucleus:reveal-editor-file", handleEditorFileReveal);
    window.addEventListener("nucleus:command-show-projects", showProjects);
    window.addEventListener("nucleus:command-show-threads", showThreads);
    window.addEventListener("nucleus:command-show-files", showFiles);
    window.addEventListener("nucleus:command-show-forge", showForge);
    return () => {
      window.removeEventListener("nucleus:reveal-editor-file", handleEditorFileReveal);
      window.removeEventListener("nucleus:command-show-projects", showProjects);
      window.removeEventListener("nucleus:command-show-threads", showThreads);
      window.removeEventListener("nucleus:command-show-files", showFiles);
      window.removeEventListener("nucleus:command-show-forge", showForge);
    };
  });

  function selectMode(value: string): void {
    if (!isSidebarMode(value)) return;
    activeMode = value;
    window.localStorage.setItem(storageKey, value);
  }

  function isSidebarMode(value: string | null): value is SidebarMode {
    return value === "projects"
      || value === "threads"
      || value === "files"
      || value === "forge";
  }

  function handleEditorFileReveal(): void {
    selectMode("files");
  }

  function showProjects(): void { selectMode("projects"); }
  function showThreads(): void { selectMode("threads"); }
  function showFiles(): void { selectMode("files"); }
  function showForge(): void { selectMode("forge"); }
</script>

<section class="workspace-sidebar" aria-label="Workspace sidebar">
  <div class="sidebar-tabs">
    <Tabs
      bordered
      {items}
      value={activeMode}
      variant="pill"
      size="xs"
      density="compact"
      fullWidth
      ariaLabel="Sidebar views"
      showTooltips
      onValueChange={selectMode}
    />
  </div>

  <div class="sidebar-content">
    <div hidden={activeMode !== "projects"}>
      <ProjectRail
        bind:selectedProjectId
        bind:selectedProject
        bind:selectedConversationId
      />
    </div>
    {#if activeMode === "threads"}
      <ThreadsSidebarView bind:selectedProjectId bind:selectedConversationId />
    {:else if activeMode === "files"}
      <FilesSidebarView {selectedProject} />
    {:else if activeMode === "forge"}
      <ForgeSidebarView bind:selectedProjectId />
    {/if}
  </div>
</section>

<style>
  .workspace-sidebar {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    container-name: workspace-sidebar;
    container-type: inline-size;
  }

  .sidebar-tabs {
    min-width: 0;
    padding: 0.375rem 0.375rem 0;
  }

  .sidebar-tabs :global(.poodle-tabs__tooltip) {
    display: none;
  }

  .sidebar-content,
  .sidebar-content > div {
    min-width: 0;
    min-height: 0;
    height: 100%;
  }

  @container workspace-sidebar (max-width: 21rem) {
    .sidebar-tabs :global(.poodle-tabs__label) {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .sidebar-tabs :global(.poodle-tabs__tooltip) {
      display: block;
    }

    .sidebar-tabs :global(.poodle-tabs__tab > .poodle-icon) {
      width: var(--poodle-size-icon-sm);
      height: var(--poodle-size-icon-sm);
    }
  }
</style>
