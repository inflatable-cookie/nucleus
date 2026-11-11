/**
 * Queue-internal admission identity for a host run (Spec 035, "Runtime
 * identity").
 *
 * Nucleus decodes `host.run.list` and `host.run.capacity.release` with a strict
 * pinned contract 010 record: a two-valued `submissionSource` and no run id, no
 * runtime binding and no refusal. Writing any of those into the record changes
 * the method's contract digest (so a strict client fences the call) and leaves
 * an older Queue unable to parse `host_run_records.data`.
 *
 * The identity therefore lives beside the row, in the store's internal meta,
 * keyed by run id and carrying the row's epoch. The stored row and every
 * outbound record keep the pinned strict shape, and an admission reservation is
 * written without `submissionSource` rather than claiming to be Queue's own
 * submission: the old record has no way to say "admission", so it says nothing
 * instead of something false.
 *
 * Reading is conservative. Identity applies only when it names the row's own
 * epoch and the row does not itself claim a public submission source. A missing,
 * stale, unreadable or failed write leaves it absent: that reservation is then
 * never observed, its capacity stays held and no settlement is invented. Rows
 * written by the builds that carried these fields in the record still parse, so
 * an upgrade keeps a live reservation's exact binding; they are projected onto
 * the pinned row on their next write.
 */
import {
  hostRunIdentitySchema, hostRunInternalRecordSchema, hostRunRecordSchema,
  type HostRunIdentity, type HostRunInternalRecord, type HostRunRecord,
} from "../../shared/contracts";
import { HOST_RUN_IDENTITY_META_PREFIX, hostRunIdentityMetaKey } from "./host-run-meta-keys";

export { HOST_RUN_IDENTITY_META_PREFIX, hostRunIdentityMetaKey };

/**
 * The identity an internal record carries, or nothing when it carries none.
 * Validated against the private schema, so a half-written binding is absent
 * rather than partly trusted.
 */
export function hostRunIdentityOf(record: HostRunInternalRecord): HostRunIdentity | undefined {
  if (record.submissionSource !== "admission") return undefined;
  const parsed = hostRunIdentitySchema.safeParse({
    epoch: record.epoch,
    submissionSource: "admission",
    ...(record.effigyRunId ? { effigyRunId: record.effigyRunId } : {}),
    ...(record.effigyRuntime ? { effigyRuntime: record.effigyRuntime } : {}),
    ...(record.effigyRuntimeRefusal ? { effigyRuntimeRefusal: record.effigyRuntimeRefusal } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The pinned contract 010 record for one internal record: the identity fields
 * never travel, and only a source the old record can name is written. An
 * admission reservation is unmarked, which is exactly what the pinned optional
 * field allows; Queue's own logic reads the identity beside the row instead.
 */
export function publicHostRunRecord(record: HostRunInternalRecord): HostRunRecord {
  const { submissionSource, effigyRunId: _runId, effigyRuntime: _runtime, effigyRuntimeRefusal: _refusal, ...rest } = record;
  return hostRunRecordSchema.parse({
    ...rest,
    ...(submissionSource === "queue" || submissionSource === "client" ? { submissionSource } : {}),
  });
}

/**
 * Merge the identity read beside a row into one internal record. The identity
 * is used only when it is readable, names this row's own epoch, and the row
 * does not itself claim a public source; anything else is left absent and the
 * row keeps exactly its own fields.
 */
export function hostRunWithIdentity(record: HostRunInternalRecord, stored: unknown): HostRunInternalRecord {
  if (record.submissionSource !== undefined && record.submissionSource !== "admission") return record;
  const identity = hostRunIdentitySchema.safeParse(stored);
  if (!identity.success || identity.data.epoch !== record.epoch) return record;
  // The valid identity is authoritative for these fields: a row written before
  // the identity moved beside it must not keep a half-replaced binding.
  const { effigyRunId: _rowRunId, effigyRuntime: _rowRuntime, effigyRuntimeRefusal: _rowRefusal,
    submissionSource: _rowSource, ...rest } = record;
  const { epoch: _epoch, submissionSource: _source, ...fields } = identity.data;
  return { ...rest, submissionSource: "admission", ...fields };
}

/** Parse the row's stored JSON; a row this build cannot read is a read failure, not an empty row. */
export function parseHostRunRow(data: unknown): HostRunInternalRecord {
  return hostRunInternalRecordSchema.parse(JSON.parse(String(data)));
}
