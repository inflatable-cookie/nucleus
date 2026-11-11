/**
 * The durable records behind the host-run retained-output sweep (task 444,
 * continuing 443).
 *
 * Task 443 recorded every run whose expired output could not be established,
 * with its run id, epoch, reason, first/last sighting, attempts and next bounded
 * retry — but it stored them as one Queue-internal meta value capped at 100
 * identities. The live service then reported `100 retained-output failures (+30
 * more not listed)` and advanced the sweep cursor: the identities past the cap
 * were gone, with their retry history, and nothing said where. A summary may be
 * bounded; the failure set may not.
 *
 * These shapes are Queue-private (no contract 008/009/010 wire, digest or
 * export shape), and this module owns them so the endpoint, the store and the tests read one definition. The durable rows live in the
 * `host_run_output_failures` table; this file holds no SQL.
 */
import { z } from "zod";

/**
 * One retained stream's honest state: a readable file's true size (zero
 * included), an absent path with the reason it is absent, or a refused read.
 * A missing stream is never a zero-length one.
 */
export const hostRunRetainedStreamSchema = z.object({
  state: z.enum(["absent", "present", "unreadable"]),
  size: z.number().int().nonnegative().optional(),
  reason: z.string().min(1).max(300).optional(),
}).strict();
export type HostRunRetainedStream = z.infer<typeof hostRunRetainedStreamSchema>;

/**
 * One run whose expired output could not be established. This is a
 * Queue-private durable record, not a contract-010 shape: the pinned marker
 * keeps its exact byte counts and is never written for an unknown stream.
 * `firstSeen` is where the run entered the set, `lastSeen` and `attempts` where
 * it was last tried, and `nextRetryAt` its next bounded retry.
 */
export const hostRunOutputFailureSchema = z.object({
  runId: z.string().min(1).max(160),
  epoch: z.number().int(),
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
  attempts: z.number().int().positive(),
  nextRetryAt: z.string().datetime(),
  reason: z.string().min(1).max(400),
  streams: z.object({ stdout: hostRunRetainedStreamSchema, stderr: hostRunRetainedStreamSchema }).strict().optional(),
}).strict();
export type HostRunOutputFailure = z.infer<typeof hostRunOutputFailureSchema>;

/** Re-read one durable row; a row that no longer parses is a fault, never an all-clear. */
export function parseHostRunOutputFailureRow(row: Record<string, unknown>): HostRunOutputFailure {
  let streams: unknown;
  const rawStreams = row.streams;
  if (typeof rawStreams === "string") {
    try { streams = JSON.parse(rawStreams); } catch { throw new Error(`Retained-output failure ${String(row.runId)} has an unreadable stream observation`); }
  } else if (rawStreams !== null && rawStreams !== undefined) streams = rawStreams;
  const parsed = hostRunOutputFailureSchema.safeParse({
    runId: row.runId, epoch: Number(row.epoch), firstSeen: String(row.firstSeen), lastSeen: String(row.lastSeen),
    attempts: Number(row.attempts), nextRetryAt: String(row.nextRetryAt), reason: String(row.reason),
    ...(streams === undefined ? {} : { streams }),
  });
  if (!parsed.success) throw new Error(`Retained-output failure ${String(row.runId)} is unreadable (${parsed.error.issues[0]?.message ?? "invalid"})`);
  return parsed.data;
}

/**
 * Failed rows retried per pass, independent of the sweep page, so the work stays
 * bounded. Records past any summary cap are reached by this due page, never by
 * parsing the table.
 */
export const HOST_RUN_OUTPUT_FAILURE_DUE_PAGE = 25;
/** Failed rows are retried on their own bounded cadence, never once per pass. */
export const HOST_RUN_RETENTION_RETRY_BASE_MS = 60_000;
export const HOST_RUN_RETENTION_RETRY_MAX_MS = 10 * 60_000;
/** A failed row's next attempt: bounded exponential backoff, never a per-pass loop. */
export const retentionRetryDelayMs = (attempts: number): number =>
  Math.min(HOST_RUN_RETENTION_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), HOST_RUN_RETENTION_RETRY_MAX_MS);

/**
 * How many unresolved failures a summary may name. The total count is always
 * the durable truth; when it exceeds this, the summary says how many more are
 * recorded and only withheld from the *summary*, so a bounded health answer can
 * never read as a dropped identity.
 */
export const HOST_RUN_OUTPUT_FAILURE_SUMMARY_EXAMPLES = 5;

/** One named unresolved failure, for the bounded summary and `service.health`. */
export interface HostRunOutputFailureExample {
  runId: string;
  epoch: number;
  reason: string;
  firstSeen: string;
  lastSeen: string;
  attempts: number;
}

/**
 * The honest shape of the durable failure set: the exact total, its sighting
 * window, and a bounded named sample. `examplesOmitted` is summary truncation
 * only — those rows are still stored, still retried and still visible as a count.
 */
export interface HostRunOutputFailureSummary {
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  examples: HostRunOutputFailureExample[];
  examplesOmitted: number;
  /**
   * Set when the stored set could not be read at all. The count is then unknown
   * (and reported as 0), so a reader must treat this as "not clear" rather than
   * as an all-clear: the durable truth is that there may be unresolved rows.
   */
  unreadable?: string;
}

/** Build the bounded summary from an exact total and its named sample. */
export function hostRunOutputFailureSummary(
  totals: { count: number; firstSeen: string | null; lastSeen: string | null },
  examples: readonly HostRunOutputFailure[],
): HostRunOutputFailureSummary {
  return {
    count: totals.count, firstSeen: totals.firstSeen, lastSeen: totals.lastSeen,
    examples: examples.map(entry => ({ runId: entry.runId, epoch: entry.epoch, reason: entry.reason,
      firstSeen: entry.firstSeen, lastSeen: entry.lastSeen, attempts: entry.attempts })),
    examplesOmitted: Math.max(0, totals.count - examples.length),
  };
}

/**
 * Durable evidence of one false-positive failure cleared by positive ownership
 * (task 444 amendment). Bounded: a total plus the most recent entries, so the
 * classification is auditable without a second unbounded history table.
 */
export const HOST_RUN_OUTPUT_RECLASSIFICATION_LIMIT = 20;
export const HOST_RUN_OUTPUT_RECLASSIFICATIONS_META = "hostRunOutputOwnerReclassifications";
const reclassificationCommon = {
  runId: z.string().min(1).max(160),
  epoch: z.number().int(),
  repository: z.string().min(1).max(1024),
  caller: z.string().min(1).max(300),
  /** What the evidence says — and does not say — about the bytes. */
  detail: z.string().min(1).max(400),
  at: z.string().datetime(),
};
export const hostRunOutputReclassificationSchema = z.discriminatedUnion("owner", [
  /** The producer that owns this run's output instead of the generic host-run supervisor. */
  z.object({
    ...reclassificationCommon,
    owner: z.literal("project_qa"),
    qaRunId: z.string().min(1).max(160),
    key: z.string().min(1).max(320),
  }).strict(),
  /** Merge-time project validation: its own supervisor, its own per-run state. */
  z.object({
    ...reclassificationCommon,
    owner: z.literal("project_validation"),
    taskId: z.string().min(1).max(160),
    head: z.string().min(1).max(160),
  }).strict(),
]);
export type HostRunOutputReclassification = z.infer<typeof hostRunOutputReclassificationSchema>;
export const hostRunOutputReclassificationLogSchema = z.object({
  format: z.literal("host.run.output.owner-reclassifications"),
  version: z.literal(1),
  updatedAt: z.string().datetime(),
  total: z.number().int().nonnegative(),
  recent: z.array(hostRunOutputReclassificationSchema).max(HOST_RUN_OUTPUT_RECLASSIFICATION_LIMIT),
}).strict();
export type HostRunOutputReclassificationLog = z.infer<typeof hostRunOutputReclassificationLogSchema>;
