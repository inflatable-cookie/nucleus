/** A browser store may be absent or refuse access. Callers decide how to surface failures. */
export type KeyValueStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem?(key: string): void };

/** Read the current key, or parse and migrate the old key once. */
export function readMigratedValue<T>(storage: KeyValueStorage | undefined, key: string, legacyKey: string, parse: (raw: string) => T, serialize: (value: T) => string = JSON.stringify): T | null {
  const current = storage?.getItem(key);
  const raw = current ?? storage?.getItem(legacyKey);
  if (raw == null) return null;
  const value = parse(raw);
  if (current == null) {
    storage?.setItem(key, serialize(value));
    storage?.removeItem?.(legacyKey);
  }
  return value;
}
