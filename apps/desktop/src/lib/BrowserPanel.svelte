<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Icon, Text } from "@poodle/svelte";
  import { arrowLeft, arrowRight, externalLink, rotateCw } from "@poodle/icons-lucide";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import type { Webview } from "@tauri-apps/api/webview";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import {
    DEFAULT_BROWSER_URL,
    browserWebviewLabel,
    ensureBrowserWebview,
    findBrowserWebview,
    hideBrowserWebview,
    navigateBrowserWebview,
    positionBrowserWebview,
    readBrowserUrl,
    resetBrowserCursor,
    runBrowserAction,
    showBrowserWebview,
    type BrowserViewportBounds,
    type BrowserRuntimeEvent,
  } from "./browserPanel";
  import {
    NATIVE_PANEL_OVERLAY_EVENT,
    type NativePanelOverlayEventDetail,
  } from "./nativePanelVisibility";

  let { panelId }: { panelId: string } = $props();

  let viewport = $state<HTMLDivElement | null>(null);
  let address = $state(DEFAULT_BROWSER_URL);
  let failure = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let loading = $state(true);
  let webview: Webview | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let syncFrame: number | null = null;
  let mounted = false;
  let workspaceVisible = true;
  const openOverlays = new Set<string>();
  let nativeVisible = false;
  let lastBounds: BrowserViewportBounds | null = null;
  let unlistenRuntime: UnlistenFn | null = null;

  onMount(() => {
    mounted = true;
    resizeObserver = new ResizeObserver(queueBoundsSync);
    if (viewport) {
      resizeObserver.observe(viewport);
    }
    window.addEventListener("resize", queueBoundsSync);
    window.addEventListener("nucleus:native-panels-hide", hideForWorkspaceInteraction);
    window.addEventListener("nucleus:native-panels-show", showAfterWorkspaceInteraction);
    window.addEventListener(NATIVE_PANEL_OVERLAY_EVENT, handleOverlayVisibility);
    void mountWebview();

    return () => {
      mounted = false;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", queueBoundsSync);
      window.removeEventListener("nucleus:native-panels-hide", hideForWorkspaceInteraction);
      window.removeEventListener("nucleus:native-panels-show", showAfterWorkspaceInteraction);
      window.removeEventListener(NATIVE_PANEL_OVERLAY_EVENT, handleOverlayVisibility);
      if (syncFrame !== null) {
        cancelAnimationFrame(syncFrame);
      }
      unlistenRuntime?.();
      nativeVisible = false;
      void resetBrowserCursor(panelId).catch(() => undefined);
      void hideBrowserWebview(webview).catch(() => undefined);
    };
  });

  onDestroy(() => {
    mounted = false;
  });

  async function mountWebview(): Promise<void> {
    loading = true;
    failure = null;
    try {
      const bounds = viewportBounds();
      if (!bounds) {
        throw new Error("browser viewport is not ready");
      }

      unlistenRuntime = await listen<BrowserRuntimeEvent>(
        "nucleus://browser-state",
        handleRuntimeState,
      );
      const existingWebview = await findBrowserWebview(panelId);
      address = await ensureBrowserWebview(panelId, DEFAULT_BROWSER_URL, bounds);
      webview = existingWebview ?? await findBrowserWebview(panelId);
      if (!webview) {
        throw new Error("browser view was not created");
      }
      if (existingWebview) {
        loading = false;
      }

      if (!mounted) {
        await hideBrowserWebview(webview);
        return;
      }
      await positionBrowserWebview(panelId, bounds);
      lastBounds = bounds;
      if (canShowNativeView()) {
        await showBrowserWebview(webview);
        nativeVisible = true;
      }
    } catch (caught) {
      failure = formatError(caught);
      loading = false;
    }
  }

  function queueBoundsSync(): void {
    if (syncFrame !== null) {
      cancelAnimationFrame(syncFrame);
    }
    syncFrame = requestAnimationFrame(() => {
      syncFrame = null;
      void syncBounds();
    });
  }

  async function syncBounds(): Promise<void> {
    if (!webview || !canShowNativeView() || !mounted) {
      return;
    }
    const bounds = viewportBounds();
    if (!bounds) {
      nativeVisible = false;
      await hideBrowserWebview(webview).catch(() => undefined);
      return;
    }
    if (!sameBounds(lastBounds, bounds)) {
      try {
        await positionBrowserWebview(panelId, bounds);
      } catch (caught) {
        failure = formatError(caught);
        return;
      }
      lastBounds = bounds;
    }
    if (canShowNativeView() && mounted && !nativeVisible) {
      await showBrowserWebview(webview).catch((caught) => {
        failure = formatError(caught);
      });
      nativeVisible = true;
    }
  }

  function viewportBounds(): BrowserViewportBounds | null {
    const rect = viewport?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) {
      return null;
    }
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  }

  async function navigate(): Promise<void> {
    failure = null;
    notice = null;
    loading = true;
    try {
      address = await navigateBrowserWebview(panelId, address);
    } catch (caught) {
      failure = formatError(caught);
      loading = false;
    }
  }

  async function runAction(action: "back" | "forward" | "reload"): Promise<void> {
    failure = null;
    notice = null;
    try {
      await runBrowserAction(panelId, action);
    } catch (caught) {
      failure = formatError(caught);
    }
  }

  async function openExternally(): Promise<void> {
    failure = null;
    try {
      const currentUrl = await readBrowserUrl(panelId);
      await openUrl(currentUrl);
    } catch (caught) {
      failure = formatError(caught);
    }
  }

  function handleAddressKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void navigate();
    }
  }

  function handleRuntimeState(event: { payload: BrowserRuntimeEvent }): void {
    if (event.payload.label !== browserWebviewLabel(panelId)) {
      return;
    }
    if (event.payload.loading !== null) {
      address = event.payload.url;
      loading = event.payload.loading;
    }
    if (event.payload.notice) {
      notice = event.payload.notice;
    } else if (event.payload.loading === true) {
      notice = null;
    }
  }

  function hideForWorkspaceInteraction(): void {
    workspaceVisible = false;
    nativeVisible = false;
    void resetBrowserCursor(panelId).catch(() => undefined);
    void hideBrowserWebview(webview).catch(() => undefined);
  }

  function showAfterWorkspaceInteraction(): void {
    workspaceVisible = true;
    if (!webview || !mounted || !canShowNativeView()) {
      return;
    }
    queueBoundsSync();
  }

  function handleOverlayVisibility(event: Event): void {
    const detail = (event as CustomEvent<NativePanelOverlayEventDetail>).detail;
    if (!detail?.id) return;
    if (detail.open) {
      if (detail.panelIds && !detail.panelIds.includes(panelId)) return;
      openOverlays.add(detail.id);
      nativeVisible = false;
      void resetBrowserCursor(panelId).catch(() => undefined);
      void hideBrowserWebview(webview).catch(() => undefined);
      return;
    }
    openOverlays.delete(detail.id);
    if (canShowNativeView()) queueBoundsSync();
  }

  function canShowNativeView(): boolean {
    return workspaceVisible && openOverlays.size === 0;
  }

  function formatError(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  function sameBounds(
    left: BrowserViewportBounds | null,
    right: BrowserViewportBounds,
  ): boolean {
    return Boolean(
      left &&
        left.x === right.x &&
        left.y === right.y &&
        left.width === right.width &&
        left.height === right.height,
    );
  }
</script>

<section class="browser-panel" aria-label="Browser">
  <header class="browser-toolbar">
    <div class="browser-actions">
      <button type="button" class="browser-button" aria-label="Back" onclick={() => void runAction("back")}>
        <Icon icon={arrowLeft} size="xs" />
      </button>
      <button type="button" class="browser-button" aria-label="Forward" onclick={() => void runAction("forward")}>
        <Icon icon={arrowRight} size="xs" />
      </button>
      <button type="button" class="browser-button" class:browser-button--loading={loading} aria-label="Reload" onclick={() => void runAction("reload")}>
        <Icon icon={rotateCw} size="xs" />
      </button>
    </div>
    <input
      class="browser-address"
      bind:value={address}
      aria-label="Browser address"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      onkeydown={handleAddressKeydown}
    />
    <button type="button" class="browser-button" aria-label="Open in system browser" onclick={() => void openExternally()}>
      <Icon icon={externalLink} size="xs" />
    </button>
  </header>
  <div
    class="browser-status"
    class:browser-status--visible={Boolean(failure) || Boolean(notice)}
    class:browser-status--error={Boolean(failure)}
    role={failure ? "alert" : undefined}
  >
    {#if failure}
      <Text size="xs" tone="danger">{failure}</Text>
    {:else if notice}
      <Text size="xs" tone="muted">{notice}</Text>
    {/if}
  </div>
  <div
    class="browser-viewport"
    bind:this={viewport}
    aria-label="Browser content"
    data-native-browser-viewport
    data-native-browser-panel-id={panelId}
  ></div>
</section>

<style>
  .browser-panel {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--poodle-color-background-canvas);
  }

  .browser-toolbar {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    padding: 0.35rem 0.45rem;
    border-bottom: 0.0625rem solid var(--poodle-color-border-subtle);
    background: var(--poodle-color-background-surface);
  }

  .browser-actions {
    display: flex;
    align-items: center;
    gap: 0.1rem;
  }

  .browser-button {
    display: inline-grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    flex: 0 0 auto;
    padding: 0;
    color: var(--poodle-color-text-secondary);
    border: 0;
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
  }

  .browser-button:hover {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-elevated);
  }

  .browser-button--loading :global(svg) {
    animation: browser-spin 0.9s linear infinite;
  }

  .browser-button:focus-visible,
  .browser-address:focus-visible {
    outline: 0.0625rem solid var(--poodle-color-accent-focus);
    outline-offset: 0.0625rem;
  }

  .browser-address {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    height: 1.75rem;
    padding: 0 0.65rem;
    color: var(--poodle-color-text-primary);
    font: inherit;
    font-size: 0.75rem;
    border: 0.0625rem solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-pill);
    background: var(--poodle-color-background-canvas);
  }

  .browser-status {
    min-height: 0;
  }

  .browser-status--visible {
    padding: 0.2rem 0.65rem;
    border-bottom: 0.0625rem solid var(--poodle-color-border-subtle);
  }

  .browser-status--error {
    background: color-mix(in srgb, var(--poodle-color-status-danger) 7%, transparent);
  }

  .browser-viewport {
    position: relative;
    min-width: 0;
    min-height: 0;
    background: var(--poodle-color-background-canvas);
  }

  @keyframes browser-spin {
    to { transform: rotate(360deg); }
  }
</style>
