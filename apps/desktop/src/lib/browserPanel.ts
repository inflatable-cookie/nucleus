import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventTransport } from "@inflatable-cookie/longhorn/core";
import { NativeContentClient } from "@inflatable-cookie/longhorn/native-content";
import { createTauriNativeContentPort } from "@inflatable-cookie/longhorn-tauri/native-content";

export const DEFAULT_BROWSER_URL = "https://example.com";

export interface BrowserRuntimeEvent {
  islandId: string;
  url: string;
  loading: boolean | null;
  notice: string | null;
}

export function browserIslandId(panelId: string): string {
  const safePanelId = panelId.replace(/[^a-zA-Z0-9\-/:_.]/g, "-");
  return `island:nucleus-browser:${safePanelId}`;
}

export function createBrowserNativeContentClient(panelId: string): NativeContentClient {
  const islandId = browserIslandId(panelId);
  let requestSequence = 0;
  const transport: EventTransport = {
    invoke: (command, args) => invoke(command, args),
    listen: async (event, listener) => {
      const unlisten = await listen<unknown>(event, ({ payload }) => listener(payload));
      return unlisten;
    },
  };
  return new NativeContentClient(
    createTauriNativeContentPort({
      transport,
      nextRequestId: () => {
        requestSequence += 1;
        return `request:nucleus-browser:${requestSequence}`;
      },
    }),
    islandId,
  );
}

export async function destroyBrowserIsland(panelId: string): Promise<void> {
  return invoke("browser_panel_destroy", { islandId: browserIslandId(panelId) });
}

export async function hideBrowserIslandForUnmount(panelId: string): Promise<void> {
  return invoke("browser_panel_hide_for_unmount", { islandId: browserIslandId(panelId) });
}

export async function resetBrowserCursor(panelId: string): Promise<void> {
  return invoke("browser_panel_reset_cursor", { islandId: browserIslandId(panelId) });
}

export async function navigateBrowserIsland(panelId: string, url: string): Promise<string> {
  return invoke<string>("browser_panel_navigate", {
    islandId: browserIslandId(panelId),
    url,
  });
}

export async function runBrowserAction(
  panelId: string,
  action: "back" | "forward" | "reload",
): Promise<void> {
  return invoke("browser_panel_action", {
    islandId: browserIslandId(panelId),
    action,
  });
}

export async function readBrowserUrl(panelId: string): Promise<string> {
  return invoke<string>("browser_panel_current_url", {
    islandId: browserIslandId(panelId),
  });
}
