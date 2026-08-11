import { readable, type Readable } from "svelte/store";
import type { ToastHostStore, ToastHostStoreItem } from "@inflatable-cookie/poodle-svelte";
import type { NotificationSession } from "@inflatable-cookie/longhorn-poodle-svelte/notifications/svelte";

/**
 * Poodle `ToastHost` store over the session's toast projection.
 *
 * The host owns auto-dismiss timers and stickiness; this module owns only the
 * projection from `session.toasts` (longhorn's toast shape) to
 * `ToastHostStoreItem` (poodle's store shape) and the session wiring for
 * dismiss and action requests.
 */
export function createNotificationToastStore(session: NotificationSession): ToastHostStore {
  return {
    toasts: readable<ToastHostStoreItem[]>([], (set) => {
      const sync = (): void => {
        set(
          session.toasts.map((toast) => ({
            id: toast.id,
            title: toast.title,
            message: toast.description,
            tone: toast.tone,
            actionLabel: toast.action?.label ?? null,
          })),
        );
      };
      sync();
      return session.observe(sync);
    }),
    dismiss: (id) => session.dismissToast(id),
  };
}

/**
 * Fire a toast's action request against the session. Admission is enforced
 * by `invokeAction` (via `nucleusNotificationActionExecutor`); rejection is
 * swallowed like every other request-style notification callback.
 */
export function executeNotificationToastAction(session: NotificationSession, id: string): void {
  const toast = session.toasts.find((candidate) => candidate.id === id);
  const action = toast?.action;
  if (action) void session.invokeAction(toast.notificationId, action.referenceId).catch(() => undefined);
}
