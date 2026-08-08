<script lang="ts">
  import {
    Icon,
    Popover,
    type OverlaySurfaceGeometryChangeHandler,
  } from "@inflatable-cookie/poodle-svelte";
  import { bell } from "@inflatable-cookie/poodle-icons-lucide";
  import { NotificationPanel } from "@inflatable-cookie/longhorn-notifications/poodle";
  import type { NotificationSession } from "@inflatable-cookie/longhorn-notifications/svelte";

  let {
    session,
    onOpenChange,
    onSurfaceGeometryChange,
  }: {
    session: NotificationSession;
    onOpenChange?: (open: boolean) => void;
    onSurfaceGeometryChange?: OverlaySurfaceGeometryChangeHandler;
  } = $props();

  const retainedCount = $derived(session.snapshot?.retainedCount ?? session.records.length);
  const unseenCount = $derived(session.snapshot?.unseenCount ?? 0);
</script>

{#if retainedCount > 0}
  <Popover
    placement="bottom-end"
    initialFocus="content"
    ariaLabel="Notifications"
    surfaceMinWidth="22rem"
    {onOpenChange}
    {onSurfaceGeometryChange}
  >
    {#snippet trigger()}
      <button class:has-unseen={unseenCount > 0} class="notification-trigger" type="button" aria-label={`${unseenCount} unseen notifications`}>
        <Icon icon={bell} size="sm" />
        {#if unseenCount > 0}
          <span>{unseenCount}</span>
        {/if}
      </button>
    {/snippet}
    <div class="notification-popover">
      <NotificationPanel {session} title="Notifications" />
    </div>
  </Popover>
{/if}

<style>
  .notification-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    min-width: 2rem;
    height: 2rem;
    padding: 0 0.5rem;
    color: var(--poodle-color-text-muted);
    border: 0.0625rem solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
  }

  .notification-trigger:hover,
  .notification-trigger.has-unseen {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-surface);
  }

  .notification-trigger span {
    color: var(--poodle-color-text-primary);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }

  .notification-popover {
    max-height: min(34rem, 70vh);
    overflow: auto;
  }
</style>
