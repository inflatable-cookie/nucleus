import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The hidden parameters of every verb. One per engine, never module-level: tests
 * build a second `Engine` on one store to mimic restart. `Engine` keeps
 * same-name accessors and an `isOwnerCall` delegate.
 */
export class ControlContext {
  readonly selfForceRunId = new AsyncLocalStorage<string>();
  readonly coordinatorActionRunId = new AsyncLocalStorage<string>();
  /** Set within one replayed owner verb's async context: a replay is not the owner's next verb. */
  readonly replayingDeferredVerb = new AsyncLocalStorage<true>();

  /** Round 4: a direct owner call — not a coordinator report and not a deferred replay. */
  isOwnerCall(): boolean {
    return !this.coordinatorActionRunId.getStore() && !this.replayingDeferredVerb.getStore();
  }
}
