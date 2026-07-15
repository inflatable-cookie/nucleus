<script lang="ts">
  import { Icon, Select } from "@poodle/svelte";
  import { folderCog, triangleAlert } from "@poodle/icons-lucide";
  import type { ControlProjectRecordDto } from "./control";
  import { resourceIsAvailable, resourceTargetPresentation } from "./resourceTargetSupport";

  let {
    project,
    resourceId,
    onValueChange,
  }: {
    project: ControlProjectRecordDto;
    resourceId: string | null;
    onValueChange: (resourceId: string | null) => void;
  } = $props();

  const presentation = $derived(resourceTargetPresentation(project, resourceId));
  const workingResources = $derived(presentation.workingResources);
  const options = $derived(
    workingResources.map((resource) => ({
      value: resource.resource_id,
      label: resource.display_name,
      disabled: !resourceIsAvailable(resource),
    })),
  );

  $effect(() => {
    if (resourceId && !workingResources.some((resource) => resource.resource_id === resourceId)) {
      onValueChange(null);
    }
  });

  function openResourceManager() {
    window.dispatchEvent(
      new CustomEvent("nucleus:manage-project-resources", {
        detail: { projectId: project.project_id },
      }),
    );
  }
</script>

{#if presentation.show}
  <div class:resource-target-control--warning={presentation.repairCount > 0} class="resource-target-control">
    {#if presentation.repairCount > 0}
      <span class="repair-notice">
        <Icon icon={triangleAlert} size="xs" />
        <span>{presentation.repairCount} resource{presentation.repairCount === 1 ? "" : "s"} need attention</span>
      </span>
    {/if}
    {#if presentation.showSelector}
      <Select
        value={presentation.selectedResourceId}
        {options}
        variant="ghost"
        size="sm"
        native={false}
        menuMinWidth="13rem"
        ariaLabel="Panel resource"
        onValueChange={(value) => onValueChange(value)}
      />
    {/if}
    <button type="button" aria-label="Manage project resources" onclick={openResourceManager}>
      <Icon icon={folderCog} size="xs" />
      <span>{presentation.repairCount > 0 ? "Repair" : "Resources"}</span>
    </button>
  </div>
{/if}

<style>
  .resource-target-control {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.375rem;
    min-height: 2rem;
    padding: 0.125rem 0.5rem;
    border-bottom: 1px solid var(--poodle-color-border-subtle);
    background: color-mix(in srgb, var(--poodle-color-background-surface) 72%, transparent);
  }

  .repair-notice {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    margin-right: auto;
    color: var(--poodle-color-text-warning, #d9a441);
    font-size: 0.6875rem;
  }

  button {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 1.625rem;
    padding: 0.2rem 0.45rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.6875rem;
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
  }

  button:hover {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-elevated);
  }
</style>
