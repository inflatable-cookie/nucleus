<script lang="ts">
  import { Tabs, type TabItem } from "@poodle/svelte";
  import { files, folderTree, gitBranch, messagesSquare } from "@poodle/icons-lucide";
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
  }: {
    selectedProjectId: string | null;
    selectedProject: ControlProjectRecordDto | null;
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
</script>

<section class="workspace-sidebar" aria-label="Workspace sidebar">
  <div class="sidebar-tabs">
    <Tabs
      {items}
      value={activeMode}
      variant="pill"
      size="xs"
      density="compact"
      fullWidth
      ariaLabel="Sidebar views"
      onValueChange={selectMode}
    />
  </div>

  <div class="sidebar-content">
    <div hidden={activeMode !== "projects"}>
      <ProjectRail bind:selectedProjectId bind:selectedProject />
    </div>
    {#if activeMode === "threads"}
      <ThreadsSidebarView bind:selectedProjectId />
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
  }

  .sidebar-tabs {
    min-width: 0;
    padding: 0.375rem 0.375rem 0;
  }

  .sidebar-content,
  .sidebar-content > div {
    min-width: 0;
    min-height: 0;
    height: 100%;
  }
</style>
