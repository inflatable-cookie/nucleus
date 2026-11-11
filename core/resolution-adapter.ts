import type { Adapter } from './host/adapter';
import type { Task } from '../shared/contracts';

/** Observe adapter retry witnesses without changing synchronous return values. */
export function resolutionAdapter(adapter: Adapter, gitFailureSources: WeakMap<object, string>, gitTransientRecovered: (task: Task, source: string) => void): Adapter {
  // A successful call to the same adapter operation is a retry witness even
  // when a read leaves the task phase untouched. Skipped calls prove nothing.
  return new Proxy(adapter, { get: (target, property, receiver) => {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function' || typeof property !== 'string') return value;
    return (...args: unknown[]) => {
      const task = args.find((arg): arg is Task => Boolean(arg && typeof arg === 'object' && 'id' in arg && 'repoPath' in arg && 'resolution' in arg));
      const source = `resolution.${property}`;
      const failed = (error: unknown) => { if (error && typeof error === 'object') gitFailureSources.set(error, source); throw error; };
      const succeeded = (result: unknown) => { if (task) gitTransientRecovered(task, source); return result; };
      try {
        const result = Reflect.apply(value, target, args);
        return result && typeof (result as PromiseLike<unknown>).then === 'function' ? Promise.resolve(result).then(succeeded, failed) : succeeded(result);
      } catch (error) { return failed(error); }
    };
  } });
}
