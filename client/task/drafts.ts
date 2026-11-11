import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * Unsaved task-detail drafts (reasons, notes, the routing form), held by the board in a
 * ref so typing never re-renders it. A tab reads its drafts back when it mounts, so a
 * draft survives a tab switch, a closed dialog and a board refresh, as it did when the
 * board owned these fields as state.
 */
export type TaskDrafts = Record<string, unknown>;

/** Drafts the board clears when the selected task or the board tab changes; the rest persist. */
const PER_TASK_DRAFTS = ["disposeReason", "escalationAnswer", "replacementId", "workDisposition", "coordinationNote"];

/** The board's draft store. Changing `scope` (selected task and board tab) clears the per-task drafts before any tab reads them. */
export function useTaskDraftStore(scope: string): TaskDrafts {
  const drafts = useRef<TaskDrafts>({}).current;
  const lastScope = useRef(scope);
  if (lastScope.current !== scope) {
    lastScope.current = scope;
    for (const key of PER_TASK_DRAFTS) delete drafts[key];
  }
  return drafts;
}

/** One draft field: local state for the tab, mirrored into the board's store. */
export function useTaskDraft<T>(drafts: TaskDrafts, key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => key in drafts ? drafts[key] as T : initial);
  const set = useCallback<Dispatch<SetStateAction<T>>>(next => setValue(previous => {
    const updated = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
    drafts[key] = updated;
    return updated;
  }), [drafts, key]);
  return [value, set];
}
