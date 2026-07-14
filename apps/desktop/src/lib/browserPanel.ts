import { invoke } from "@tauri-apps/api/core";
import { Webview } from "@tauri-apps/api/webview";

export const DEFAULT_BROWSER_URL = "https://example.com";

export interface BrowserViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserRuntimeEvent {
  label: string;
  url: string;
  loading: boolean | null;
  notice: string | null;
}

export function browserWebviewLabel(panelId: string): string {
  const safePanelId = panelId.replace(/[^a-zA-Z0-9\-/:_]/g, "-");
  return `nucleus-browser-${safePanelId}`;
}

export async function findBrowserWebview(panelId: string): Promise<Webview | null> {
  return Webview.getByLabel(browserWebviewLabel(panelId));
}

export async function ensureBrowserWebview(
  panelId: string,
  url: string,
  bounds: BrowserViewportBounds,
): Promise<string> {
  return invoke<string>("browser_panel_ensure", {
    label: browserWebviewLabel(panelId),
    url,
    bounds,
  });
}

export async function positionBrowserWebview(
  panelId: string,
  bounds: BrowserViewportBounds,
): Promise<void> {
  return invoke("browser_panel_set_bounds", {
    label: browserWebviewLabel(panelId),
    bounds,
  });
}

export async function hideBrowserWebview(webview: Webview | null): Promise<void> {
  await webview?.hide();
}

export async function resetBrowserCursor(panelId: string): Promise<void> {
  return invoke("browser_panel_reset_cursor", {
    label: browserWebviewLabel(panelId),
  });
}

export async function showBrowserWebview(webview: Webview): Promise<void> {
  await webview.show();
}

export async function destroyBrowserWebview(panelId: string): Promise<void> {
  const webview = await findBrowserWebview(panelId);
  if (webview) {
    await resetBrowserCursor(panelId);
  }
  await webview?.close();
}

export async function navigateBrowserWebview(panelId: string, url: string): Promise<string> {
  return invoke<string>("browser_panel_navigate", {
    label: browserWebviewLabel(panelId),
    url,
  });
}

export async function runBrowserAction(
  panelId: string,
  action: "back" | "forward" | "reload",
): Promise<void> {
  return invoke("browser_panel_action", {
    label: browserWebviewLabel(panelId),
    action,
  });
}

export async function readBrowserUrl(panelId: string): Promise<string> {
  return invoke<string>("browser_panel_current_url", {
    label: browserWebviewLabel(panelId),
  });
}
