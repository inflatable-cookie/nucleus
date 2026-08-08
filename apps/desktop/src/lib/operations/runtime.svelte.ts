import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventTransport } from "@inflatable-cookie/longhorn-core";
import { createTauriOperationPort } from "@inflatable-cookie/longhorn-operation/tauri";
import { OperationSession } from "@inflatable-cookie/longhorn-operation/svelte";

let requestSequence = 0;

export function createNucleusOperationSession(): OperationSession {
  const transport: EventTransport = {
    invoke: (command, arguments_) => invoke(command, arguments_),
    listen: async (event, listener) => {
      const unlisten = await listen<unknown>(event, ({ payload }) => listener(payload));
      return unlisten;
    },
  };
  return new OperationSession({
    port: createTauriOperationPort({
      transport,
      nextRequestId: () => `request:nucleus-operation:renderer:${++requestSequence}`,
    }),
  });
}
