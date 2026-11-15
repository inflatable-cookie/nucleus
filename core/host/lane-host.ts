/** Lane key for one task's exclusive quantum (Spec 012). */
export const TASK_LANE_PREFIX = 'task:';
/** Lane key for one task's runtime-retirement quantum. */
export const RUNTIME_RETIREMENT_LANE_PREFIX = 'runtime-retirement:';

/**
 * The task id a host-scoped lane names, or undefined when the key is not a
 * task or runtime-retirement lane (or names an empty id). Prefix match, not a
 * regex over the key: `task:` and `runtime-retirement:` are the two owners.
 */
export function taskIdFromLaneKey(key: string): string | undefined {
  if (key.startsWith(TASK_LANE_PREFIX)) {
    const id = key.slice(TASK_LANE_PREFIX.length);
    return id.length > 0 ? id : undefined;
  }
  if (key.startsWith(RUNTIME_RETIREMENT_LANE_PREFIX)) {
    const id = key.slice(RUNTIME_RETIREMENT_LANE_PREFIX.length);
    return id.length > 0 ? id : undefined;
  }
  return undefined;
}
