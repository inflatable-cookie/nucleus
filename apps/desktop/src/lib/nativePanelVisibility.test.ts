import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  NATIVE_PANEL_OVERLAY_EVENT,
  resetNativePanelGeometryForTests,
  setNativeBrowserViewportGeometry,
  setNativePanelOverlayOpen,
  updateNativePanelOverlayGeometry,
  type NativePanelOverlayEventDetail,
} from "./nativePanelVisibility";

const originalWindow = globalThis.window;
let events: NativePanelOverlayEventDetail[];

beforeEach(() => {
  events = [];
  resetNativePanelGeometryForTests();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent(event: CustomEvent<NativePanelOverlayEventDetail>) {
        if (event.type === NATIVE_PANEL_OVERLAY_EVENT) events.push(event.detail);
        return true;
      },
    },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("native panel geometry", () => {
  test("recomputes final Popover intersection when its surface moves", () => {
    setNativeBrowserViewportGeometry("browser:a", rect(0, 0, 100, 100));
    setNativeBrowserViewportGeometry("browser:b", rect(200, 0, 100, 100));
    setNativePanelOverlayOpen("popover:1", true);
    updateNativePanelOverlayGeometry("popover:1", {
      type: "upsert",
      surface: surface("surface:popover", 10, 10, 20, 20),
    });
    updateNativePanelOverlayGeometry("popover:1", {
      type: "upsert",
      surface: surface("surface:popover", 210, 10, 20, 20),
    });

    expect(events.slice(-2)).toEqual([
      { id: "popover:1", open: true, panelIds: ["browser:a"] },
      { id: "popover:1", open: true, panelIds: ["browser:b"] },
    ]);
  });

  test("recomputes Menu surface maps when Browser geometry changes", () => {
    setNativeBrowserViewportGeometry("browser:a", rect(0, 0, 100, 100));
    setNativePanelOverlayOpen("menu:1", true);
    updateNativePanelOverlayGeometry("menu:1", {
      type: "upsert",
      surface: surface("surface:root", 150, 0, 30, 30),
    });
    updateNativePanelOverlayGeometry("menu:1", {
      type: "upsert",
      surface: surface("surface:submenu", 220, 0, 30, 30),
    });
    setNativeBrowserViewportGeometry("browser:a", rect(200, 0, 100, 100));

    expect(events.at(-1)).toEqual({
      id: "menu:1",
      open: true,
      panelIds: ["browser:a"],
    });
  });
});

function rect(left: number, top: number, width: number, height: number) {
  return {
    x: left,
    y: top,
    width,
    height,
    top,
    right: left + width,
    bottom: top + height,
    left,
  };
}

function surface(surfaceId: string, left: number, top: number, width: number, height: number) {
  return {
    surfaceId,
    rect: rect(left, top, width, height),
    placement: "bottom-start" as const,
    visible: true,
  };
}
