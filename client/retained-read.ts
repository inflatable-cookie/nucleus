import { useRef } from "react";

/**
 * A planning list that never blanks (task 1030). While a new domain revision loads, the
 * query's `keepPreviousData` placeholder carries the last list; when that read fails, the
 * last loaded list stays on screen and the failure is reported as `stale`. `error` is set
 * only when there is no list to show.
 */
export function useRetainedRead<T>(query: { data?: T; error: unknown }): { data: T | undefined; error: unknown; stale: unknown } {
  const last = useRef<T | undefined>(undefined);
  if (query.data !== undefined) last.current = query.data;
  const data = query.data ?? last.current;
  return { data, error: data === undefined ? query.error : null, stale: data !== undefined && query.error ? query.error : null };
}
