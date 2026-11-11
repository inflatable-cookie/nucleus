/** Limit a recovery owner to named live ports, preserving synchronous calls and overrides. */
export function recoveryContext<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
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

/** Engine-owned recovery also receives only the resolution ports it calls. */
export function recoveryEngineContext<T extends { readonly resolution: object }, K extends keyof T, R extends keyof T['resolution']>(
  source: T, keys: readonly K[], resolutionKeys: readonly R[],
): Pick<T, K> & { readonly resolution: Pick<T['resolution'], R> } {
  const context = recoveryContext(source, keys) as Pick<T, K> & { readonly resolution: Pick<T['resolution'], R> };
  Object.defineProperty(context, 'resolution', {
    enumerable: true,
    get: () => recoveryContext<T['resolution'], R>(source.resolution, resolutionKeys),
  });
  return context;
}
