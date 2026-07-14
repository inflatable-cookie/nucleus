let nextOverlayId = 0;
let nextMeasurementId = 0;
const pendingMeasurements = new Map<string, number>();

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

export function setNativePanelOverlayIntersection(
  id: string,
  open: boolean,
  overlayRoot?: HTMLElement | null,
): void {
  if (!open || !overlayRoot) {
    pendingMeasurements.delete(id);
    dispatchNativePanelOverlay(id, open);
    return;
  }

  nextMeasurementId += 1;
  const measurementId = nextMeasurementId;
  pendingMeasurements.set(id, measurementId);
  requestAnimationFrame(() => {
    if (pendingMeasurements.get(id) !== measurementId) {
      return;
    }
    pendingMeasurements.delete(id);

    const overlay = overlayRoot.querySelector<HTMLElement>(
      '.poodle-popover__surface, [role="menu"]',
    );
    const overlayRect = overlay?.getBoundingClientRect();
    const panelIds = overlayRect
      ? Array.from(document.querySelectorAll<HTMLElement>("[data-native-browser-viewport]"))
          .filter((viewport) => rectanglesIntersect(overlayRect, viewport.getBoundingClientRect()))
          .map((viewport) => viewport.dataset.nativeBrowserPanelId)
          .filter((panelId): panelId is string => Boolean(panelId))
      : [];

    dispatchNativePanelOverlay(id, panelIds.length > 0, panelIds);
  });
}

function rectanglesIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.width > 0
    && a.height > 0
    && b.width > 0
    && b.height > 0
    && a.left < b.right
    && a.right > b.left
    && a.top < b.bottom
    && a.bottom > b.top;
}

function dispatchNativePanelOverlay(id: string, open: boolean, panelIds?: string[]): void {
  window.dispatchEvent(
    new CustomEvent<NativePanelOverlayEventDetail>(NATIVE_PANEL_OVERLAY_EVENT, {
      detail: { id, open, panelIds },
    }),
  );
}
