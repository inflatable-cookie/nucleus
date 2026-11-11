import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Fixed internal bound on concurrently spawned processes (Spec 012).
 *
 * Queue has no global lane cap: many independent quanta may start at once, so
 * the processes they spawn - Git and hook programs - need their own bound where
 * they are actually spawned. Work that waits for a slot waits here, not for a
 * lane. Long work (project validation) holds a slot for its whole run by design;
 * the bound is chosen so a handful of long validations cannot starve ordinary
 * Git.
 */
export const SPAWN_CONCURRENCY = 16;

class SpawnGate {
  private running = 0;
  private readonly waiting: ((release: () => void) => void)[] = [];
  constructor(readonly limit: number) {}
  get inFlight(): number { return this.running; }
  get queued(): number { return this.waiting.length; }
  run<T>(work: () => Promise<T> | T): Promise<T> {
    return this.acquire().then(release => {
      let result: Promise<T>;
      try { result = Promise.resolve(work()); }
      catch (error) { release(); return Promise.reject(error); }
      return result.finally(release);
    });
  }
  private acquire(): Promise<() => void> {
    if (this.running < this.limit) { this.running++; return Promise.resolve(this.release()); }
    return new Promise<() => void>(resolve => this.waiting.push(resolve));
  }
  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next(this.release());
      else this.running--;
    };
  }
}

export const spawnGate = new SpawnGate(SPAWN_CONCURRENCY);
const held = new AsyncLocalStorage<true>();

/**
 * Run one spawned process under the shared fixed bound. Reentrant: code already
 * inside a slot runs inline, so a nested Git call can never wait for a slot it
 * already holds.
 */
export function withSpawnSlot<T>(work: () => Promise<T> | T): Promise<T> {
  if (held.getStore()) return Promise.resolve().then(work);
  return spawnGate.run(() => held.run(true, work));
}
