import type { Task } from "./schema/tasks";

/** Response-only field names; the updated task already carries their new values. */
export function taskControlChanges(before: Task, after: Task): string[] {
  return (Object.keys(after) as Array<keyof Task>).filter(field =>
    !["version", "updatedAt", "briefVersions", "handoffText", "laneContext"].includes(field)
    && JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}
