<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Icon, Text } from "@inflatable-cookie/poodle-svelte";
  import { arrowLeft, arrowRight, externalLink, rotateCw } from "@inflatable-cookie/poodle-icons-lucide";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import {
    NativeContentSession,
    nativeContentViewport,
    resolveNativeContentVisibility,
  } from "@inflatable-cookie/longhorn-native-content-svelte";
  import {
    DEFAULT_BROWSER_URL,
    browserIslandId,
    createBrowserNativeContentClient,
    hideBrowserIslandForUnmount,
    navigateBrowserIsland,
    readBrowserUrl,
    resetBrowserCursor,
    runBrowserAction,
    type BrowserRuntimeEvent,
  } from "./browserPanel";
  import {
    NATIVE_PANEL_OVERLAY_EVENT,
    setNativeBrowserViewportGeometry,
    type NativePanelOverlayEventDetail,
  } from "./nativePanelVisibility";

  let { panelId, active }: { panelId: string; active: boolean } = $props();
  const stablePanelId = untrack(() => panelId);

  const session = new NativeContentSession({
    client: createBrowserNativeContentClient(stablePanelId),
    scale: browserScale(),
    visibility: { state: "hidden", reason: "nucleus:unmounted" },
    focus: "unchanged",
    inputRouting: "native_direct",
  });

  let viewport = $state<HTMLDivElement | null>(null);
  let address = $state(DEFAULT_BROWSER_URL);
  let failure = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let loading = $state(true);
  let resizeObserver: ResizeObserver | null = null;
  let syncFrame: number | null = null;
  let mounted = false;
  let viewportReady = false;
  let workspaceVisible = true;
  const openOverlays = new Set<string>();
  let unlistenRuntime: UnlistenFn | null = null;

  $effect(() => {
    const status = session.status;
    if (status.kind === "failed") failure = formatError(status.error);
    else if (status.kind === "rejected") failure = status.rejection.message;
    if (session.snapshot?.observed.readiness === "ready") loading = false;
  });

  $effect(() => {
    if (active) queueViewportSync();
    else syncVisibility();
  });

  onMount(() => {
    mounted = true;
    resizeObserver = new ResizeObserver(queueViewportSync);
    if (viewport) resizeObserver.observe(viewport);
    window.addEventListener("resize", queueViewportSync);
    window.addEventListener("mouseup", showAfterWorkspaceInteraction);
    window.addEventListener("pointerup", showAfterWorkspaceInteraction);
    window.addEventListener("nucleus:native-panels-hide", hideForWorkspaceInteraction);
    window.addEventListener("nucleus:native-panels-show", showAfterWorkspaceInteraction);
    window.addEventListener(NATIVE_PANEL_OVERLAY_EVENT, handleOverlayVisibility);

    syncViewport();
    void startSession();

    return () => {
      mounted = false;
      viewportReady = false;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", queueViewportSync);
      window.removeEventListener("mouseup", showAfterWorkspaceInteraction);
      window.removeEventListener("pointerup", showAfterWorkspaceInteraction);
      window.removeEventListener("nucleus:native-panels-hide", hideForWorkspaceInteraction);
      window.removeEventListener("nucleus:native-panels-show", showAfterWorkspaceInteraction);
      window.removeEventListener(NATIVE_PANEL_OVERLAY_EVENT, handleOverlayVisibility);
      if (syncFrame !== null) cancelAnimationFrame(syncFrame);
      unlistenRuntime?.();
      setNativeBrowserViewportGeometry(stablePanelId, null);
      session.setVisibilityPolicy({ state: "hidden", reason: "nucleus:unmounted" });
      void hideBrowserIslandForUnmount(stablePanelId).then(() => session.stop()).catch((error) => {
        failure = formatError(error);
      });
      void resetBrowserCursor(stablePanelId).catch(() => undefined);
    };
  });

  async function startSession(): Promise<void> {
    loading = true;
    failure = null;
    try {
      unlistenRuntime?.();
      unlistenRuntime = null;
      unlistenRuntime = await listen<BrowserRuntimeEvent>(
        "nucleus://browser-state",
        handleRuntimeState,
      );
      if (!mounted) {
        unlistenRuntime();
        unlistenRuntime = null;
        return;
      }
      await session.start();
      queueViewportSync();
    } catch (error) {
      failure = formatError(error);
      loading = false;
    }
  }

  function queueViewportSync(): void {
    if (syncFrame !== null) return;
    syncFrame = requestAnimationFrame(() => {
      syncFrame = null;
      syncViewport();
    });
  }

  function syncViewport(): void {
    session.setScale(browserScale());
    const rect = viewport?.getBoundingClientRect();
    viewportReady = Boolean(rect && rect.width >= 1 && rect.height >= 1);
    if (!rect || !viewportReady) {
      setNativeBrowserViewportGeometry(stablePanelId, null);
    } else {
      setNativeBrowserViewportGeometry(stablePanelId, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      });
      try {
        session.refreshViewport();
      } catch (error) {
        failure = formatError(error);
      }
    }
    syncVisibility();
  }

  function syncVisibility(): void {
    session.setVisibilityPolicy(resolveNativeContentVisibility([
      { reason: "nucleus:unmounted", active: !mounted },
      { reason: "nucleus:inactive-panel", active: !active },
      { reason: "nucleus:empty-viewport", active: !viewportReady },
      { reason: "nucleus:workspace-gesture", active: !workspaceVisible },
      { reason: "nucleus:overlay", active: openOverlays.size > 0 },
    ]));
  }

  async function navigate(): Promise<void> {
    failure = null;
    notice = null;
    loading = true;
    try {
      address = await navigateBrowserIsland(stablePanelId, address);
    } catch (error) {
      failure = formatError(error);
      loading = false;
    }
  }

  async function runAction(action: "back" | "forward" | "reload"): Promise<void> {
    failure = null;
    notice = null;
    try {
      await runBrowserAction(stablePanelId, action);
    } catch (error) {
      failure = formatError(error);
    }
  }

  async function openExternally(): Promise<void> {
    failure = null;
    try {
      await openUrl(await readBrowserUrl(stablePanelId));
    } catch (error) {
      failure = formatError(error);
    }
  }

  function handleAddressKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void navigate();
    }
  }

  function handleRuntimeState(event: { payload: BrowserRuntimeEvent }): void {
    if (event.payload.islandId !== browserIslandId(stablePanelId)) return;
    if (event.payload.loading !== null) {
      address = event.payload.url;
      loading = event.payload.loading;
    }
    if (event.payload.notice) notice = event.payload.notice;
    else if (event.payload.loading === true) notice = null;
  }

  function hideForWorkspaceInteraction(): void {
    workspaceVisible = false;
    syncVisibility();
    void resetBrowserCursor(stablePanelId).catch(() => undefined);
  }

  function showAfterWorkspaceInteraction(): void {
    workspaceVisible = true;
    queueViewportSync();
  }

  function handleOverlayVisibility(event: Event): void {
    const detail = (event as CustomEvent<NativePanelOverlayEventDetail>).detail;
    if (!detail?.id) return;
    const shouldHide = detail.open && (!detail.panelIds || detail.panelIds.includes(stablePanelId));
    if (shouldHide) {
      openOverlays.add(detail.id);
      void resetBrowserCursor(stablePanelId).catch(() => undefined);
    } else {
      openOverlays.delete(detail.id);
    }
    syncVisibility();
  }

  function browserScale(): number {
    const ratio = globalThis.devicePixelRatio;
    return Math.max(1, Math.round((Number.isFinite(ratio) ? ratio : 1) * 1000));
  }

  function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
    role={failure ? "alert" : notice ? "status" : undefined}
    aria-live={failure ? "assertive" : notice ? "polite" : undefined}
  >
    {#if failure}
      <div class="browser-status-content">
        <Text size="xs" tone="danger">{failure}</Text>
        <button type="button" class="browser-status-action" onclick={() => void startSession()}>
          Retry
        </button>
      </div>
    {:else if notice}
      <Text size="xs" tone="muted">{notice}</Text>
    {/if}
  </div>
  <div
    class="browser-viewport"
    bind:this={viewport}
    use:nativeContentViewport={session}
    aria-label="Browser content"
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

  .browser-status-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .browser-status-action {
    flex: 0 0 auto;
    padding: 0.15rem 0.4rem;
    color: var(--poodle-color-text-secondary);
    font: inherit;
    font-size: 0.6875rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
  }

  .browser-status-action:hover {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-elevated);
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
