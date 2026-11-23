/**
 * Spec 068 §2, Spec 065 §3: each automatic repair attempt's identity and its one
 * settlement fact.
 *
 * An attempt is named by its episode and its index under that episode
 * (`repair:<episode>:<n>`). Attempts are numbered in journal order: each coordinator
 * launch (`telemetry_recovery`) and each reservation that ended before a run was bound
 * (`recovery_attempt_settled`) is the next attempt of its episode. Both events carry
 * that index, so a reader keys every attempt on the fact that names it.
 *
 * Settlement is one fact per attempt. A bound attempt settles with its own run row (its
 * report, release or supersession). A reserved attempt (an episode with no run bound)
 * settles with exactly one `recovery_attempt_settled` event, which the task store writes
 * in the same transaction as the task write that ends the reservation, whichever path
 * made that write: an escalation, an admission or capacity wait, a resolve, a clear or a
 * newer episode replacing it. Nothing else settles an attempt: no reading, no absence and
 * no fact about another attempt under the same episode.
 */
import type { Task } from "../../shared/contracts";

/** The launch journal line each coordinator run records. */
export const REPAIR_LAUNCHED = "telemetry_recovery";
/** The settlement of a reserved attempt that ended before a run was bound. */
export const REPAIR_ATTEMPT_SETTLED = "recovery_attempt_settled";
/** A pre-send host-read refusal released and refunded this launch's run. */
const REPAIR_LAUNCH_REFUNDED = "recovery_transient_read_released";

type Episode = NonNullable<Task["resolution"]["recovery"]>;

const LIVE_EPISODE = new Set<Episode["status"]>([
  "pending",
  "running",
  "nudged",
  "uncertain",
]);

/** A live episode with no run bound: its next attempt is reserved and in progress. */
export function isReservedRepair(
  episode: Episode | null | undefined,
): episode is Episode {
  return Boolean(episode && LIVE_EPISODE.has(episode.status) && !episode.runId);
}

/** How a reserved attempt ended. */
export type RepairAttemptOutcome =
  /** The episode escalated before a run was bound. */
  | "escalated"
  /** The episode resolved before a run was bound. */
  | "resolved"
  /** An admission or capacity wait cleared the episode (`recovery_waiting`). */
  | "waiting"
  /** Another write cleared the episode (an owner control, a restart, a resumed worker). */
  | "cleared"
  /** A newer episode replaced it. */
  | "superseded";

/**
 * What ends the reserved attempt in one task write, or null when the write leaves it
 * reserved or binds its run (the bound attempt then settles with that run's own row).
 */
export function reservationOutcome(
  before: Task["resolution"],
  after: Task["resolution"],
  kind?: string,
): RepairAttemptOutcome | null {
  const reserved = before.recovery;
  if (!isReservedRepair(reserved)) return null;
  const next = after.recovery;
  if (!next) return kind === "recovery_waiting" ? "waiting" : "cleared";
  if (next.id !== reserved.id) return "superseded";
  if (next.status === "escalated") return "escalated";
  if (next.status === "resolved") return "resolved";
  return null;
}

/** The words a reserved attempt was shown with, kept on its settlement fact. */
export function reservationWords(resolution: Task["resolution"]): {
  cause: string;
  targetRole: string;
  action: string;
} {
  const incident =
    resolution.incident?.status === "resolved" ? null : resolution.incident;
  return {
    cause: incident?.detail || resolution.recovery?.summary || "",
    targetRole: incident?.role ?? "",
    action: incident?.action ?? "",
  };
}

/** One attempt, read from the journal fact that names it. */
export interface RepairAttemptRecord {
  episodeId: string;
  attempt: number;
  /** Charged launches of this episode recorded before this attempt (Spec 068 §5). */
  chargedBefore: number;
  cause: string;
  targetRole: string;
  action: string;
  /** A bound attempt: its launch, which no outage or pre-send refusal charged when `uncharged`. */
  launch?: { runId: string; uncharged: boolean };
  /** A reserved attempt that ended before a run was bound. */
  outcome?: RepairAttemptOutcome;
}

export interface RepairJournal {
  /** Bound attempts, by their run id. */
  byRun: Map<string, RepairAttemptRecord>;
  /** Reserved attempts that ended before a run was bound, in journal order. */
  settled: RepairAttemptRecord[];
  /** The highest attempt index recorded for the episode (0 when none). */
  attempts(episodeId: string): number;
  /** The episode's charged launches so far. */
  charged(episodeId: string): number;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const index = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
const outcomes = new Set<string>([
  "escalated",
  "resolved",
  "waiting",
  "cleared",
  "superseded",
]);

/**
 * Read every repair attempt from the task's journal. A launch recorded before launches
 * named their index takes the next index of its episode.
 */
export function readRepairJournal(
  events: readonly { kind: string; detail: string }[] | undefined,
): RepairJournal {
  const refunded = new Set<string>();
  for (const event of events ?? [])
    if (event.kind === REPAIR_LAUNCH_REFUNDED && event.detail.trim())
      refunded.add(event.detail.trim());
  const byRun = new Map<string, RepairAttemptRecord>();
  const settled: RepairAttemptRecord[] = [];
  const highest = new Map<string, number>();
  const charged = new Map<string, number>();
  for (const event of events ?? []) {
    if (event.kind !== REPAIR_LAUNCHED && event.kind !== REPAIR_ATTEMPT_SETTLED)
      continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(event.detail) as Record<string, unknown>;
    } catch {
      continue;
    }
    const episodeId = text(value.episodeId);
    if (!episodeId) continue;
    const attempt = index(value.attempt) ?? (highest.get(episodeId) ?? 0) + 1;
    highest.set(episodeId, Math.max(highest.get(episodeId) ?? 0, attempt));
    const record: RepairAttemptRecord = {
      episodeId,
      attempt,
      chargedBefore: charged.get(episodeId) ?? 0,
      cause: text(value.cause),
      targetRole: text(value.targetRole),
      action: text(value.action),
    };
    if (event.kind === REPAIR_LAUNCHED) {
      const runId = text(value.runId);
      if (!runId) continue;
      const uncharged = value.outage === true || refunded.has(runId);
      record.launch = { runId, uncharged };
      if (!uncharged) charged.set(episodeId, record.chargedBefore + 1);
      byRun.set(runId, record);
    } else {
      const outcome = text(value.outcome);
      if (!outcomes.has(outcome)) continue;
      record.outcome = outcome as RepairAttemptOutcome;
      settled.push(record);
    }
  }
  return {
    byRun,
    settled,
    attempts: (episodeId) => highest.get(episodeId) ?? 0,
    charged: (episodeId) => charged.get(episodeId) ?? 0,
  };
}

/**
 * The settlement fact for the reserved attempt one task write ends, or null when the
 * write leaves no reserved attempt behind it. `events` reads the task's journal before
 * the write (only when an attempt ends), so the reserved attempt's index is the one every reader showed.
 */
export function repairAttemptSettlement(
  before: Task["resolution"],
  after: Task["resolution"],
  kind: string | undefined,
  events: () => readonly { kind: string; detail: string }[],
): string | null {
  const outcome = reservationOutcome(before, after, kind);
  if (!outcome) return null;
  const episodeId = before.recovery!.id;
  return JSON.stringify({
    episodeId,
    attempt: readRepairJournal(events()).attempts(episodeId) + 1,
    outcome,
    ...reservationWords(before),
  });
}
