<script lang="ts">
  import { tick } from "svelte";
  import { MessageCenter, type MessageCenterItem, type OverlaySurfaceGeometryChangeHandler } from "@inflatable-cookie/poodle-svelte";
  import { createInstanceId, observeOverlaySurfaceGeometry } from "@inflatable-cookie/poodle-core";
  import { notificationStatusTone } from "@inflatable-cookie/longhorn-poodle-svelte/notifications/poodle";
  import type { NotificationSession } from "@inflatable-cookie/longhorn-poodle-svelte/notifications/svelte";
  import { isAdmittedNotificationAction } from "./runtime.svelte";

  let {
    session,
    onOpenChange,
    onSurfaceGeometryChange,
  }: {
    session: NotificationSession;
    onOpenChange?: (open: boolean) => void;
    onSurfaceGeometryChange?: OverlaySurfaceGeometryChangeHandler;
  } = $props();

  const items = $derived<MessageCenterItem[]>(
    session.records.map((record) => ({
      id: record.notificationId,
      title: record.draft.title,
      message: record.draft.summary,
      meta: record.draft.sourceId,
      timestamp: record.draft.presentationTimeUnixMs,
      read: record.readState === "seen",
      tone: notificationStatusTone(record.draft.severity),
    })),
  );

  function handleReadChange(id: string, read: boolean): void {
    // The port has no mark-unseen mutation (`NotificationMutationCommand`
    // carries only per-record `markSeen`), so only the read direction is
    // acted on; the request-style callback swallows the other.
    if (read) void session.markSeen(id).catch(() => undefined);
  }

  function handleRemove(id: string): void {
    void session.dismiss(id).catch(() => undefined);
  }

  function handleMarkAllRead(): void {
    // No bulk read-state mutation on the port; mark each unseen record.
    for (const record of session.records) {
      if (record.readState !== "seen") {
        void session.markSeen(record.notificationId).catch(() => undefined);
      }
    }
  }

  function handleItemSelect(id: string): void {
    session.select(id);
    const record = session.records.find((candidate) => candidate.notificationId === id);
    const action = record?.draft.actions.find((candidate) =>
      isAdmittedNotificationAction(record.draft.sourceId, candidate.referenceId),
    );
    if (action) void session.invokeAction(id, action.referenceId).catch(() => undefined);
  }

  // MessageCenter renders its own Popover and does not forward surface
  // geometry changes, so the adapter observes the portalled surface directly
  // to keep `onSurfaceGeometryChange` (native overlay plumbing) intact.
  let surfaceObserver: ReturnType<typeof observeOverlaySurfaceGeometry> | null = null;

  function findSurfaceElement(): HTMLElement | null {
    const section = document.querySelector<HTMLElement>(".poodle-message-center");
    return section?.closest<HTMLElement>(".poodle-popover__surface") ?? null;
  }

  async function attachSurfaceObserver(): Promise<void> {
    if (!onSurfaceGeometryChange) return;
    surfaceObserver?.destroy();
    surfaceObserver = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const surface = findSurfaceElement();
      if (surface) {
        surfaceObserver = observeOverlaySurfaceGeometry(surface, createInstanceId("notification-surface"), {
          placement: "bottom-end",
          onChange: onSurfaceGeometryChange,
        });
        return;
      }
      if (typeof requestAnimationFrame === "function") {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } else {
        await tick();
      }
    }
  }

  function handleOpenChange(open: boolean): void {
    onOpenChange?.(open);
    if (open) {
      void attachSurfaceObserver();
    } else {
      surfaceObserver?.destroy();
      surfaceObserver = null;
    }
  }

  $effect(() => () => {
    surfaceObserver?.destroy();
    surfaceObserver = null;
  });
</script>

<MessageCenter
  {items}
  title="Notifications"
  onOpenChange={handleOpenChange}
  onItemSelect={handleItemSelect}
  onReadChange={handleReadChange}
  onRemove={handleRemove}
  onMarkAllRead={handleMarkAllRead}
/>
