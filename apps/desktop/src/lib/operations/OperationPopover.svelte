<script lang="ts">
  import {
    Icon,
    Popover,
    type OverlaySurfaceGeometryChangeHandler,
  } from "@inflatable-cookie/poodle-svelte";
  import { activity } from "../../icons.generated";
  import { OperationPanel } from "@inflatable-cookie/longhorn-poodle-svelte/operation/poodle";
  import type { OperationSession } from "@inflatable-cookie/longhorn-poodle-svelte/operation/svelte";

  let {
    session,
    onOpenChange,
    onSurfaceGeometryChange,
  }: {
    session: OperationSession;
    onOpenChange?: (open: boolean) => void;
    onSurfaceGeometryChange?: OverlaySurfaceGeometryChangeHandler;
  } = $props();

  const retainedCount = $derived(session.active.length + session.recent.length);
</script>

{#if retainedCount > 0}
  <Popover
    placement="bottom-end"
    initialFocus="content"
    ariaLabel="Background operations"
    surfaceMinWidth="22rem"
    {onOpenChange}
    {onSurfaceGeometryChange}
  >
    {#snippet trigger()}
      <button class="operation-trigger" type="button" aria-label="Background operations">
        <Icon icon={activity} size="sm" />
        {#if session.active.length > 0}
          <span>{session.active.length}</span>
        {/if}
      </button>
    {/snippet}
    <div class="operation-popover">
      <OperationPanel
        {session}
        title="Background operations"
        activeTitle="Active"
        recentTitle="Recent"
      />
    </div>
  </Popover>
{/if}

<style>
  .operation-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    min-width: 2rem;
    height: 2rem;
    padding: 0 0.5rem;
    color: var(--poodle-color-text-secondary);
    border: 0.0625rem solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
  }

  .operation-trigger:hover {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-surface);
  }

  .operation-trigger span {
    color: var(--poodle-color-text-primary);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }

  .operation-popover {
    max-height: min(34rem, 70vh);
    overflow: auto;
  }
</style>
