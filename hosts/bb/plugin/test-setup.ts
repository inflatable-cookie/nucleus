/**
 * The test environment's browser storage (Spec 062, decision 5a).
 *
 * The fork's own suites read `window.localStorage` for the preferences mirror.
 * jsdom supplies it when a window has an origin; under this repository's jsdom
 * the window reaches the test without one, so the mirror's storage is installed
 * here as the same in-memory `Storage` the host's browser provides. Nothing else
 * is faked: the tests drive real React, real jotai and the real preference sync.
 */
if (typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined") {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key) { return store.has(key) ? store.get(key)! : null; },
    key(index) { return [...store.keys()][index] ?? null; },
    removeItem(key) { store.delete(key); },
    setItem(key, value) { store.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true, writable: true });
  }
}
export {};
