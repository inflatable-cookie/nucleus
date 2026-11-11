import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * How focus last arrived: by keyboard or by pointer. One tracker for the whole
 * client, fed by document-level keydown and pointer events, the way the web's
 * `:focus-visible` decides (nucleus#968). A key press without Meta, Ctrl or Alt
 * means keyboard; a mouse, pen or touch press means pointer. Hosts without a DOM
 * (native) have no pointer focus to hide, so they stay on keyboard.
 */
export type Modality = "keyboard" | "pointer";

type Listener = (event: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) => void;
type DocumentHost = { addEventListener: (type: string, listener: Listener, capture?: boolean) => void; removeEventListener: (type: string, listener: Listener, capture?: boolean) => void };

let modality: Modality = "keyboard";
const subscribers = new Set<() => void>();
// Mounted trackers keep the document listeners attached; only subscribers re-render.
let holders = 0;
let detach: (() => void) | null = null;

function set(next: Modality) {
  if (next === modality) return;
  modality = next;
  for (const notify of subscribers) notify();
}

const onKey: Listener = event => { if (!event?.metaKey && !event?.ctrlKey && !event?.altKey) set("keyboard"); };
const onPointer: Listener = () => set("pointer");
const pointerEvents = ["pointerdown", "mousedown", "touchstart"] as const;

function hold() {
  holders += 1;
  if (!detach) {
    const documentHost = (globalThis as { document?: DocumentHost }).document;
    if (documentHost?.addEventListener) {
      // Capture phase, so a handler that stops propagation still leaves the modality right.
      documentHost.addEventListener("keydown", onKey, true);
      for (const type of pointerEvents) documentHost.addEventListener(type, onPointer, true);
      detach = () => {
        documentHost.removeEventListener("keydown", onKey, true);
        for (const type of pointerEvents) documentHost.removeEventListener(type, onPointer, true);
      };
    }
  }
  return () => {
    holders -= 1;
    if (!holders && detach) { detach(); detach = null; }
  };
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  const release = hold();
  return () => { subscribers.delete(notify); release(); };
}
const subscribeNever = () => () => undefined;
const keyboard = (): Modality => "keyboard";

/** How many controls re-render on a modality change: the focused ones only. */
export const modalitySubscriberCount = () => subscribers.size;

/** The current modality, for code outside a component. */
export const currentModality = () => modality;

/** The modality as React state: re-renders when a key or pointer press changes it. */
export function useModality(): Modality {
  return useSyncExternalStore(subscribe, currentModality, currentModality);
}

/**
 * Focus state for a control that draws the focus ring: `visible` is true only
 * while the control has focus and the last input was the keyboard. A control
 * clicked into shows no ring; a key pressed while it holds focus shows it, as
 * `:focus-visible` does. Screen readers are untouched: focusability, roles and
 * labels never depend on it.
 */
export function useFocusVisible() {
  const [focused, setFocused] = useState(false);
  // Every control keeps the tracker listening, so a pointer press before focus is seen;
  // only the focused control subscribes, so a modality change re-renders it alone (client audit C23).
  useEffect(hold, []);
  const current = useSyncExternalStore(focused ? subscribe : subscribeNever, focused ? currentModality : keyboard, focused ? currentModality : keyboard);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);
  return { focused, visible: focused && current === "keyboard", onFocus, onBlur };
}
