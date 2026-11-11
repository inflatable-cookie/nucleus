import { AsyncLocalStorage } from "node:async_hooks";

/** Times one Paseo SDK request on behalf of the admitted run that owns the context. */
export type PaseoCallRecorder = <T>(request: () => Promise<T>) => Promise<T>;

const context = new AsyncLocalStorage<PaseoCallRecorder>();

/**
 * Run admitted work with `record` timing each Paseo SDK request inside it, or,
 * with no recorder, with any enclosing timing context cleared, so a request is
 * sampled by exactly one admitted run.
 */
export function withPaseoCallTiming<T>(record: PaseoCallRecorder | undefined, work: () => Promise<T>): Promise<T> {
  return record ? context.run(record, work) : context.exit(work);
}

/**
 * One Paseo SDK request. Inside an inner-timed admitted run it is that run's
 * latency sample; anywhere else it runs unchanged. The request itself runs
 * outside the context, so a nested helper is never sampled twice.
 */
export function paseoCall<T>(request: () => Promise<T>): Promise<T> {
  const record = context.getStore();
  if (!record) return request();
  return context.exit(() => record(request));
}


export const hasPaseoCallTiming = () => Boolean(context.getStore());
