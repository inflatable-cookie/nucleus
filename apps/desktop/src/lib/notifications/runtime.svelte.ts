import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventTransport } from "@longhorn/core";
import type { CommandSession } from "@longhorn/commands/svelte";
import type { NotificationActionExecutor } from "@longhorn/notifications";
import { createTauriNotificationPort } from "@longhorn/notifications/tauri";
import { NotificationSession } from "@longhorn/notifications/svelte";

const OPERATIONS_SOURCE = "nucleus:operations";
const OPEN_FORGE_ACTION = "nucleus:sidebar.show-forge";
let requestSequence = 0;

export function createNucleusNotificationSession(
  commandSession: Pick<CommandSession, "select">,
): NotificationSession {
  const transport: EventTransport = {
    invoke: (command, arguments_) => invoke(command, arguments_),
    listen: async (event, listener) => {
      const unlisten = await listen<unknown>(event, ({ payload }) => listener(payload));
      return unlisten;
    },
  };
  return new NotificationSession({
    port: createTauriNotificationPort({
      transport,
      nextRequestId: () => `request:nucleus-notification:renderer:${++requestSequence}`,
    }),
    toast: { select: shouldToastNotification },
    actions: nucleusNotificationActionExecutor(commandSession),
  });
}

export function shouldToastNotification(record: { draft: { severity: string } }): boolean {
  return record.draft.severity === "warning"
    || record.draft.severity === "error"
    || record.draft.severity === "critical";
}

export function nucleusNotificationActionExecutor(
  commandSession: Pick<CommandSession, "select">,
): NotificationActionExecutor {
  return {
    admitAndExecute: async ({ sourceId, referenceId }) => {
      if (sourceId !== OPERATIONS_SOURCE || referenceId !== OPEN_FORGE_ACTION) {
        throw new Error("Notification action is not admitted by Nucleus.");
      }
      const outcome = await commandSession.select(referenceId);
      if (
        typeof outcome !== "object"
        || outcome === null
        || !("status" in outcome)
        || outcome.status !== "succeeded"
      ) {
        throw new Error("Notification action is unavailable in the current context.");
      }
    },
  };
}
