/** Restrict a phase to its named ports while preserving live overrides and synchronous calls. */
export function closeoutContext<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const context = {} as Pick<T, K>;
  for (const key of keys) Object.defineProperty(context, key, {
    enumerable: true,
    get: () => {
      const value = source[key];
      return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(source[key] as Function, source, args) : value;
    },
  });
  return context;
}
