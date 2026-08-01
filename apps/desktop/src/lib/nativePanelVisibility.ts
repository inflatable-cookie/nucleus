import type {
  OverlaySurfaceGeometry,
  OverlaySurfaceGeometryChange,
  OverlayViewportRect,
} from "@poodle/svelte";

let nextOverlayId = 0;

const geometryOverlays = new Map<string, {
  open: boolean;
  surfaces: Map<string, OverlaySurfaceGeometry>;
  lastPanelIds: string[];
}>();
const browserViewports = new Map<string, OverlayViewportRect>();

export const NATIVE_PANEL_OVERLAY_EVENT = "nucleus:native-panel-overlay";

export interface NativePanelOverlayEventDetail {
  id: string;
  open: boolean;
  panelIds?: string[];
}

export function createNativePanelOverlayId(prefix: string): string {
  nextOverlayId += 1;
  return `${prefix}:${nextOverlayId}`;
}

export function setNativePanelOverlayOpen(id: string, open: boolean): void {
  const state = overlayState(id);
  state.open = open;
  if (!open) state.surfaces.clear();
  publishGeometryOverlay(id, state);
}

export function updateNativePanelOverlayGeometry(
  id: string,
  change: OverlaySurfaceGeometryChange,
): void {
  const state = overlayState(id);
  if (change.type === "upsert") state.surfaces.set(change.surface.surfaceId, change.surface);
  else state.surfaces.delete(change.surfaceId);
  publishGeometryOverlay(id, state);
}

export function setNativeBrowserViewportGeometry(
  panelId: string,
  rect: OverlayViewportRect | null,
): void {
  if (rect) browserViewports.set(panelId, rect);
  else browserViewports.delete(panelId);
  for (const [id, state] of geometryOverlays) publishGeometryOverlay(id, state);
}

export function setNativePanelOverlayVisibility(
  id: string,
  open: boolean,
  panelIds?: string[],
): void {
  dispatchNativePanelOverlay(id, open, panelIds);
}

export function resetNativePanelGeometryForTests(): void {
  geometryOverlays.clear();
  browserViewports.clear();
}

function overlayState(id: string) {
  let state = geometryOverlays.get(id);
  if (!state) {
    state = { open: false, surfaces: new Map(), lastPanelIds: [] };
    geometryOverlays.set(id, state);
  }
  return state;
}

function publishGeometryOverlay(
  id: string,
  state: ReturnType<typeof overlayState>,
): void {
  const panelIds = state.open
    ? [...browserViewports]
        .filter(([, viewport]) =>
          [...state.surfaces.values()].some(
            (surface) => surface.visible && rectanglesIntersect(surface.rect, viewport),
          ),
        )
        .map(([panelId]) => panelId)
        .sort()
    : [];
  if (sameIds(panelIds, state.lastPanelIds)) return;
  state.lastPanelIds = panelIds;
  dispatchNativePanelOverlay(id, panelIds.length > 0, panelIds);
}

function rectanglesIntersect(a: OverlayViewportRect, b: OverlayViewportRect): boolean {
  return a.width > 0
    && a.height > 0
    && b.width > 0
    && b.height > 0
    && a.left < b.right
    && a.right > b.left
    && a.top < b.bottom
    && a.bottom > b.top;
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function dispatchNativePanelOverlay(id: string, open: boolean, panelIds?: string[]): void {
  window.dispatchEvent(
    new CustomEvent<NativePanelOverlayEventDetail>(NATIVE_PANEL_OVERLAY_EVENT, {
      detail: { id, open, panelIds },
    }),
  );
}
