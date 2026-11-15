/**
 * The live port context: the one way a composition root hands an owner the
 * named ports it calls (`nucleus#1232`).
 *
 * A context is built once and read at every call, so the owner sees the root's
 * current port: a delegate the root replaces later (the runtime wiring its host
 * ports after construction, a test override) is live for the next call without
 * re-wiring the owner. A call keeps the root as its receiver and adds no
 * microtask turn, and a port the owner was not given is not on its context.
 */

/**
 * Limit an owner to `keys` of `source`, read live. `shaped` supplies the ports
 * an owner's own contract narrows (a nested owner's subset, a step the root
 * exposes for it) as values the root already decided.
 */
export function portsContext<T extends object, K extends keyof T, E extends object = Record<never, never>>(
  source: T, keys: readonly K[], shaped?: E,
): Pick<T, K> & E {
  const context = {} as Pick<T, K> & E;
  for (const key of keys) Object.defineProperty(context, key, {
    enumerable: true,
    get: () => {
      const value = source[key];
      return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(source[key] as Function, source, args) : value;
    },
    set: value => { Reflect.set(source, key, value); },
  });
  for (const [key, value] of Object.entries(shaped ?? {}))
    Object.defineProperty(context, key, { enumerable: true, get: () => value });
  return context;
}

/** An engine-side root that also receives only the resolution ports it calls. */
export function enginePorts<T extends { readonly resolution: object }, K extends keyof T, R extends keyof T['resolution']>(
  source: T, keys: readonly K[], resolutionKeys: readonly R[],
): Pick<T, K> & { readonly resolution: Pick<T['resolution'], R> } {
  const context = portsContext(source, keys) as Pick<T, K> & { readonly resolution: Pick<T['resolution'], R> };
  Object.defineProperty(context, 'resolution', {
    enumerable: true,
    get: () => portsContext<T['resolution'], R>(source.resolution, resolutionKeys),
  });
  return context;
}
