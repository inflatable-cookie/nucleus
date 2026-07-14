<script lang="ts">
  import { onMount } from "svelte";
  import { Icon, IconButton, Menu, Popover, SplitView, type MenuItem } from "@poodle/svelte";
  import { info, plus } from "@poodle/icons-lucide";
  import ProjectRail from "./lib/ProjectRail.svelte";
  import ProjectWorkspaceStage from "./lib/ProjectWorkspaceStage.svelte";
  import type { ControlProjectRecordDto } from "./lib/control";
  import { beginWindowDrag } from "./lib/windowChrome";
  import {
    createNativePanelOverlayId,
    setNativePanelOverlayIntersection,
  } from "./lib/nativePanelVisibility";

  let selectedProjectId = $state<string | null>(null);
  let selectedProject = $state<ControlProjectRecordDto | null>(null);
  let projectRailRatio = $state(0.18);
  let projectRailPrimaryCollapsed = $state(false);
  let projectRailSecondaryCollapsed = $state(false);
  let openPanelKinds = $state<string[]>([]);
  let projectDetailsOverlayRoot = $state<HTMLElement | null>(null);
  let newPanelOverlayRoot = $state<HTMLElement | null>(null);
  const projectDetailsOverlayId = createNativePanelOverlayId("project-details");
  const newPanelOverlayId = createNativePanelOverlayId("new-panel");
  const projectRailRatioStorageKey = "nucleus:desktop:project-rail-ratio";
  const newPanelItems = $derived<MenuItem[]>([
    { value: "agentChat", label: "Agent Chat" },
    { value: "tasks", label: "Tasks", disabled: openPanelKinds.includes("tasks") },
    { value: "terminal", label: "Terminal" },
    { value: "browser", label: "Browser" },
    { value: "editor", label: "Editor" },
    { value: "diff", label: "Diff" },
    { value: "context", label: "Context" },
  ]);

  onMount(() => {
    const storedRatio = Number.parseFloat(
      window.localStorage.getItem(projectRailRatioStorageKey) ?? "",
    );
    if (Number.isFinite(storedRatio)) {
      projectRailRatio = clampProjectRailRatio(storedRatio);
    }
  });

  function createWorkspacePanel(kind: string) {
    if (kind === "tasks" && openPanelKinds.includes("tasks")) {
      return;
    }
    window.dispatchEvent(
      new CustomEvent("nucleus:create-workspace-panel", {
        detail: { kind },
      }),
    );
  }

  function resizeProjectRail(ratio: number) {
    projectRailRatio = clampProjectRailRatio(ratio);
    window.localStorage.setItem(projectRailRatioStorageKey, String(projectRailRatio));
  }

  function keepProjectRailSplitOpen() {
    projectRailPrimaryCollapsed = false;
    projectRailSecondaryCollapsed = false;
    if (projectRailRatio < 0.12) {
      resizeProjectRail(0.18);
    }
  }

  function clampProjectRailRatio(ratio: number): number {
    return Math.min(0.4, Math.max(0.12, ratio));
  }
</script>

<main
  class="app-root"
  data-theme="dark"
  data-density="compact"
  data-control-size="sm"
  data-poodle-theme-root
>
  <SplitView
    orientation="horizontal"
    ratio={projectRailRatio}
    maxRatio={0.4}
    bind:primaryCollapsed={projectRailPrimaryCollapsed}
    bind:secondaryCollapsed={projectRailSecondaryCollapsed}
    minPrimarySize={192}
    minSecondarySize={520}
    collapsePrimaryBelowSize={0}
    collapseSecondaryBelowSize={0}
    ariaLabel="Project rail and workspace"
    onRatioChange={resizeProjectRail}
    onPrimaryCollapsedChange={keepProjectRailSplitOpen}
    onSecondaryCollapsedChange={keepProjectRailSplitOpen}
  >
    {#snippet primary()}
      <aside class="project-rail" aria-label="Project panel">
        <ProjectRail bind:selectedProjectId bind:selectedProject />
      </aside>
    {/snippet}

    {#snippet secondary()}
      <div class="app-work-area">
        <header
          class="app-titlebar"
          role="toolbar"
          tabindex="-1"
          aria-label="Workspace titlebar"
          data-tauri-drag-region
          onmousedown={beginWindowDrag}
        >
          <div class="titlebar-lead" data-tauri-drag-region>
            <div class="titlebar-title-block" data-tauri-drag-region>
              <div class="titlebar-title-line" bind:this={projectDetailsOverlayRoot}>
                <h1>{selectedProject?.display_name ?? "Nucleus"}</h1>
                <Popover
                  placement="bottom-start"
                  initialFocus="content"
                  ariaLabel="Project details"
                  surfaceMinWidth="18rem"
                  onOpenChange={(open) => setNativePanelOverlayIntersection(projectDetailsOverlayId, open, projectDetailsOverlayRoot)}
                >
                  {#snippet trigger()}
                    <span
                      class="project-info-trigger"
                      aria-label="Project details"
                      data-no-window-drag
                    >
                      <Icon icon={info} size="xs" />
                    </span>
                  {/snippet}
                  <div class="project-info-popover" data-no-window-drag>
                    <h2>{selectedProject?.display_name ?? "No project selected"}</h2>
                    <dl>
                      <div>
                        <dt>Project id</dt>
                        <dd>{selectedProject?.project_id ?? "none"}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{selectedProject?.status ?? "idle"}</dd>
                      </div>
                      <div>
                        <dt>Importance</dt>
                        <dd>{selectedProject?.importance_level ?? "none"}</dd>
                      </div>
                      <div>
                        <dt>Revision</dt>
                        <dd>{selectedProject?.revision_id ?? "none"}</dd>
                      </div>
                      <div>
                        <dt>Location</dt>
                        <dd>{selectedProject?.primary_location ?? "No repo location recorded."}</dd>
                      </div>
                      <div>
                        <dt>Location status</dt>
                        <dd>{selectedProject?.location_status ?? "not_recorded"}</dd>
                      </div>
                      <div>
                        <dt>Repos</dt>
                        <dd>{selectedProject?.repo_count ?? 0}</dd>
                      </div>
                    </dl>
                  </div>
                </Popover>
              </div>
            </div>
          </div>

          <div class="titlebar-drag-lane" aria-hidden="true" data-tauri-drag-region>
          </div>

          <div class="titlebar-actions" data-no-window-drag bind:this={newPanelOverlayRoot}>
            <Menu
              items={newPanelItems}
              ariaLabel="New workspace panel"
              placement="bottom-end"
              onAction={createWorkspacePanel}
              onOpenChange={(open) => setNativePanelOverlayIntersection(newPanelOverlayId, open, newPanelOverlayRoot)}
            >
              {#snippet trigger()}
                <IconButton
                  variant="secondary"
                  icon={plus}
                  ariaLabel="New workspace panel"
                  tooltip="New panel"
                />
              {/snippet}
            </Menu>
          </div>
        </header>

        <div class="product-shell">
          <section class="workspace-stage" aria-label="Workspace">
            <ProjectWorkspaceStage
              {selectedProject}
              onOpenPanelKindsChange={(kinds) => (openPanelKinds = kinds)}
            />
          </section>
        </div>
      </div>
    {/snippet}
  </SplitView>
</main>

<style>
  .app-root {
    display: block;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-canvas);
  }

  .app-root :global(.poodle-split-view__divider) {
    position: relative;
    background: transparent;
  }

  .app-root :global(.poodle-split-view__divider[data-orientation="horizontal"]) {
    width: 0.25rem;
  }

  .app-root :global(.poodle-split-view__divider[data-orientation="horizontal"]::before) {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 0.0625rem;
    border-radius: var(--poodle-radius-pill);
    background: color-mix(in srgb, var(--poodle-color-text-secondary) 7%, transparent);
    transform: translateX(-50%);
  }

  .app-work-area {
    display: grid;
    grid-template-rows: 3rem minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  .app-titlebar {
    display: flex;
    align-items: center;
    gap: 1rem;
    min-width: 0;
    min-height: 3rem;
    padding: 0.375rem 1rem;
    background: var(--poodle-color-background-elevated);
    border-bottom: 0.0625rem solid var(--poodle-color-border-subtle);
    flex-shrink: 0;
    user-select: none;
    -webkit-user-select: none;
  }

  .titlebar-lead,
  .titlebar-actions {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .titlebar-lead {
    flex: 0 1 auto;
    gap: 0.75rem;
  }

  .titlebar-title-block {
    display: grid;
    min-width: 0;
  }

  .titlebar-title-line {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }

  .titlebar-title-block h1 {
    margin: 0;
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-size: 0.9375rem;
    font-weight: 700;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-info-trigger {
    display: inline-grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    color: var(--poodle-color-text-muted);
    border-radius: var(--poodle-radius-control);
    cursor: pointer;
    -webkit-app-region: no-drag;
  }

  .project-info-trigger:hover {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-surface);
  }

  .project-info-popover {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

  .project-info-popover h2 {
    margin: 0;
    color: var(--poodle-color-text-primary);
    font-size: 0.875rem;
    line-height: 1.25;
  }

  .project-info-popover dl {
    display: grid;
    gap: 0.5rem;
    margin: 0;
  }

  .project-info-popover div {
    display: grid;
    gap: 0.125rem;
    min-width: 0;
  }

  .project-info-popover dt {
    color: var(--poodle-color-text-muted);
    font-size: 0.6875rem;
    line-height: 1.2;
  }

  .project-info-popover dd {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--poodle-color-text-secondary);
    font-size: 0.8125rem;
    line-height: 1.3;
  }

  .titlebar-drag-lane {
    flex: 1 1 0;
    min-width: 4rem;
    min-height: 2rem;
    cursor: grab;
  }

  .titlebar-drag-lane:active {
    cursor: grabbing;
  }

  .titlebar-actions {
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .product-shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: var(--poodle-color-background-canvas);
  }

  .project-rail,
  .workspace-stage {
    min-width: 0;
    min-height: 0;
  }

  .project-rail {
    box-sizing: border-box;
    height: 100%;
    padding-top: 3rem;
    background: var(--poodle-color-background-panel);
  }

  .workspace-stage {
    background: var(--poodle-color-background-canvas);
  }

  @media (max-width: 780px) {
    .app-titlebar {
      flex-wrap: wrap;
    }

    .titlebar-drag-lane {
      order: 4;
      flex-basis: 100%;
      min-height: 1rem;
    }

  }
</style>
