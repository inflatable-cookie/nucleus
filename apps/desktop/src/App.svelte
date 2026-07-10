<script lang="ts">
  import { onMount } from "svelte";
  import { Icon, IconButton, Menu, Popover, SplitView, Text, type MenuItem } from "@poodle/svelte";
  import { info, plus, testTube } from "@poodle/icons-lucide";
  import CommandDiagnosticsPanel from "./lib/CommandDiagnosticsPanel.svelte";
  import ControlDiagnosticsPanel from "./lib/ControlDiagnosticsPanel.svelte";
  import DiagnosticsProofPanel from "./lib/DiagnosticsProofPanel.svelte";
  import ProductWorkflowProofPanel from "./lib/ProductWorkflowProofPanel.svelte";
  import ProviderReadinessOverviewPanel from "./lib/ProviderReadinessOverviewPanel.svelte";
  import PlanningResearchProofPanel from "./lib/PlanningResearchProofPanel.svelte";
  import ProjectRail from "./lib/ProjectRail.svelte";
  import ProjectSwitcherPanel from "./lib/ProjectSwitcherPanel.svelte";
  import ProjectWorkspaceStage from "./lib/ProjectWorkspaceStage.svelte";
  import RuntimeReadinessPanel from "./lib/RuntimeReadinessPanel.svelte";
  import TaskDetailPanel from "./lib/TaskDetailPanel.svelte";
  import TaskListPanel from "./lib/TaskListPanel.svelte";
  import TaskWorkflowDrilldownProofPanel from "./lib/TaskWorkflowDrilldownProofPanel.svelte";
  import TaskWorkProgressPanel from "./lib/TaskWorkProgressPanel.svelte";
  import type {
    ControlGoalRecordDto,
    ControlProjectRecordDto,
    ControlTaskRecordDto,
  } from "./lib/control";
  import { beginWindowDrag } from "./lib/windowChrome";

  let selectedProjectId = $state<string | null>(null);
  let selectedProject = $state<ControlProjectRecordDto | null>(null);
  let selectedTaskId = $state<string | null>(null);
  let selectedTask = $state<ControlTaskRecordDto | null>(null);
  let selectedGoalId = $state<string | null>(null);
  let selectedGoal = $state<ControlGoalRecordDto | null>(null);
  let taskRefreshToken = $state(0);
  let proofHarnessOpen = $state(false);
  let projectRailRatio = $state(0.18);
  let projectRailPrimaryCollapsed = $state(false);
  let projectRailSecondaryCollapsed = $state(false);
  const projectRailRatioStorageKey = "nucleus:desktop:project-rail-ratio";
  const newPanelItems: MenuItem[] = [
    { value: "agentChat", label: "New chat" },
    { value: "terminal", label: "New terminal" },
    { value: "browser", label: "New browser" },
    { value: "editor", label: "New editor" },
    { value: "diff", label: "New diff" },
    { value: "context", label: "New context panel" },
  ];

  onMount(() => {
    const storedRatio = Number.parseFloat(
      window.localStorage.getItem(projectRailRatioStorageKey) ?? "",
    );
    if (Number.isFinite(storedRatio)) {
      projectRailRatio = clampProjectRailRatio(storedRatio);
    }
  });

  function openProofHarness() {
    proofHarnessOpen = true;
  }

  function closeProofHarness() {
    proofHarnessOpen = false;
  }

  function createWorkspacePanel(kind: string) {
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
    return Math.min(0.34, Math.max(0.12, ratio));
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape") {
      closeProofHarness();
    }
  }}
/>

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
              <div class="titlebar-title-line">
                <h1>{selectedProject?.display_name ?? "Nucleus"}</h1>
                <Popover
                  placement="bottom-start"
                  initialFocus="content"
                  ariaLabel="Project details"
                  surfaceMinWidth="18rem"
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

          <div class="titlebar-actions" data-no-window-drag>
            <Menu
              items={newPanelItems}
              ariaLabel="New workspace panel"
              placement="bottom-end"
              onAction={createWorkspacePanel}
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
            <IconButton
              variant="secondary"
              icon={testTube}
              ariaLabel="Open proof harness"
              tooltip="Proof harness"
              pressed={proofHarnessOpen}
              onClick={openProofHarness}
            />
          </div>
        </header>

        <div class="product-shell">
          <section class="workspace-stage" aria-label="Workspace">
            <ProjectWorkspaceStage {selectedProject} />
          </section>
        </div>
      </div>
    {/snippet}
  </SplitView>

  {#if proofHarnessOpen}
    <button
      class="proof-modal-backdrop"
      type="button"
      aria-label="Close proof harness"
      onclick={closeProofHarness}
    ></button>
    <dialog class="proof-modal proof-harness-modal" open aria-labelledby="proof-harness-title">
      <header class="proof-modal-head">
        <div>
          <h2 id="proof-harness-title">Proof harness</h2>
          <Text tone="muted">Disposable diagnostics</Text>
        </div>
        <button class="shell-button" type="button" onclick={closeProofHarness}>
          Close
        </button>
      </header>

      <div class="proof-modal-body proof-harness-body">
        <div class="panel-grid">
          <ProjectSwitcherPanel bind:selectedProjectId />
          <TaskListPanel
            {selectedProjectId}
            {taskRefreshToken}
            bind:selectedGoalId
            bind:selectedGoal
            bind:selectedTaskId
            bind:selectedTask
          />
          <TaskDetailPanel
            {selectedTask}
            onTaskChanged={() => {
              taskRefreshToken += 1;
            }}
          />
          <RuntimeReadinessPanel />
          <TaskWorkProgressPanel />
          <ProductWorkflowProofPanel {selectedProjectId} />
          <PlanningResearchProofPanel />
          <ProviderReadinessOverviewPanel />
          <CommandDiagnosticsPanel />
          <DiagnosticsProofPanel />
          <ControlDiagnosticsPanel />
          <TaskWorkflowDrilldownProofPanel
            {selectedTask}
            onTaskCommandChanged={() => {
              taskRefreshToken += 1;
            }}
          />
        </div>
      </div>
    </dialog>
  {/if}
</main>

<!--
  The proof harness keeps all throwaway diagnostics reachable while normal
  operation starts from a clean product shell.
-->

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

  .shell-button {
    min-height: var(--poodle-size-control-height);
    min-width: var(--poodle-size-control-minWidth);
    padding: var(--poodle-space-control-y) var(--poodle-space-control-x);
    color: var(--poodle-color-text-primary);
    font: inherit;
    line-height: 1;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
    cursor: pointer;
    -webkit-app-region: no-drag;
  }

  .shell-button:hover {
    border-color: var(--poodle-color-border-default);
    background: var(--poodle-color-background-elevated);
  }

  .shell-button:focus-visible {
    outline: 2px solid var(--poodle-color-accent-focusRing);
    outline-offset: 2px;
  }

  .proof-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    padding: 0;
    border: 0;
    background: rgb(0 0 0 / 58%);
    cursor: default;
  }

  .proof-modal {
    position: fixed;
    inset: 2rem;
    z-index: 21;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-background-panel);
    box-shadow: 0 1.5rem 3rem rgb(0 0 0 / 35%);
  }

  .proof-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--poodle-space-inline-lg);
    padding: var(--poodle-space-panel-y) var(--poodle-space-panel-x);
    border-bottom: 1px solid var(--poodle-color-border-subtle);
  }

  .proof-modal-body {
    min-width: 0;
    overflow: auto;
    padding: var(--poodle-space-panel-y) var(--poodle-space-panel-x);
  }

  .proof-harness-body .panel-grid {
    overflow: visible;
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

    .proof-modal {
      inset: 0.75rem;
    }
  }
</style>
