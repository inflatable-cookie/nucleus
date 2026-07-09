import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const NON_DRAG_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[data-no-window-drag]",
].join(", ");

export function beginWindowDrag(event: MouseEvent): void {
  if (event.button !== 0) {
    return;
  }

  const target = event.target;
  if (target instanceof HTMLElement && target.closest(NON_DRAG_SELECTOR)) {
    return;
  }

  event.preventDefault();
  void getCurrentWebviewWindow().startDragging().catch((error) => {
    console.error("nucleus.window_drag_failed", error);
  });
}
