import { resolve } from "node:path";
import { hookStateIsTerminal, type HookRecord } from "../../shared/hooks";

/**
 * How many hook-cleanup errors a health read carries. Audit A10: the stored record
 * accumulated 4,432 "Task history was purged" strings (425 KB) and every `health()`
 * call read it on every push and every RPC. The count stays exact and each carried
 * entry keeps its event identity and the reason, so nothing actionable is lost.
 */
export const HOOK_CLEANUP_ERROR_LIMIT = 20;

/**
 * True when a task's retention must wait for this hook record (audit B5). Hook
 * records are the only proof of ownership for an isolated checkout, so the purge
 * deletes a task's rows only when every record is settled:
 *
 * - a record still naming a checkout that exists may own that directory;
 * - a record whose execution has not settled may own a derived one that no caller
 *   has proved absent, and unknown delivery is never read as gone. `uncertain` is
 *   deliberately not terminal here even though the reaper may reap it;
 * - a settled record with no recorded checkout is Queue's own statement that it
 *   holds none: every path clears the handle only after the directory is removed.
 */
export function hookRetentionBlocksPurge(record: HookRecord, exists: (path: string) => boolean): boolean {
  const recorded = record.workspace?.path;
  if (recorded && exists(resolve(recorded))) return true;
  return !hookStateIsTerminal(record.state);
}

/**
 * The record shape the reaper may dispose of and the shape the purge gate trusts:
 * one closed integration-write occurrence of an event-owned checkout. A read-only,
 * prospective-merge or advisory occurrence owns no checkout this reaper removes.
 */
export function hookRecordOwnsIntegrationCheckout(record: HookRecord): boolean {
  return record.mode === "integration_write" && record.target === "integration_base"
    && hookStateIsTerminal(record.state);
}
