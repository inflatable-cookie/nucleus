import { z } from "zod";
import { HOST_KIND_LABELS, hostKindOf } from "./host-kind";
import { DEFAULT_HOST_OUTAGE_NOTICE_MINUTES, MAX_HOST_OUTAGE_NOTICE_MINUTES } from "./schema/settings";

/**
 * A host that went away mid-session (Tom, 2026-11-14; T3 lane document v18,
 * "Rulings (Tom, 2026-11-14)", host dropout option 1: wait).
 *
 * A task's host is part of its identity. While the host is unavailable the task
 * waits visibly on that host, spends no budget and starts no recovery; when the
 * host is back the task resumes on the same host and threads. Moving a task to
 * another host stays an explicit owner decision. The outage record is durable
 * (`hostOutages` meta) so a service restart during the outage neither resets
 * the wait's start nor repeats the one long-outage notice.
 */
export const hostOutageSchema = z.object({
  /** When this pass first saw the host unavailable; the wait's one start time. */
  since: z.string().datetime({ offset: true }),
  /** Set once the long-outage notice was raised for this outage; never reset while it lasts. */
  noticeSentAt: z.string().datetime({ offset: true }).nullable().default(null),
}).strict();
export type HostOutage = z.infer<typeof hostOutageSchema>;

/** Open outages by host id. A host that is back has no entry. */
export const hostOutagesSchema = z.record(z.string().min(1), hostOutageSchema);
export type HostOutages = z.infer<typeof hostOutagesSchema>;

/** Re-exported so the outage record's one bound has one home (dispatch limits). */
export { DEFAULT_HOST_OUTAGE_NOTICE_MINUTES, MAX_HOST_OUTAGE_NOTICE_MINUTES };

/**
 * Stops that keep their own owner and question when a host goes away. Those are
 * owner-facing answers (a budget extension, an operator decision, a ladder
 * answer, a hold, a proof wait, an interactive turn) that a host outage neither
 * raises nor answers; the wait simply stops sending until the host returns. Any
 * other stop is the host's own absence, so the host wait replaces it.
 */
export const HOST_WAIT_PRESERVED_STOPS = [
  "awaiting_proof", "budget", "escalated", "held", "interactive",
  "operator_needed", "paused_stop", "responsible_question", "run_stalled",
] as const;

/** The meta key the outage record lives under. */
export const HOST_OUTAGES_META_KEY = "hostOutages";

/**
 * The host as a person reads it on a card: the host kind's own name plus a short
 * stable suffix of its native identity. The durable record and the planner
 * notice keep the whole identity; a card must not print a raw UUID (the board
 * reduces identifiers to readable words).
 */
export function hostDisplayLabel(hostId: string): string {
  const kind = HOST_KIND_LABELS[hostKindOf(hostId)];
  const index = hostId.indexOf(":");
  const native = (index >= 0 ? hostId.slice(index + 1) : hostId).trim();
  if (!native) return kind;
  const suffix = /^[0-9a-f-]{24,}$/i.test(native) ? native.slice(0, 8) : native;
  return `${kind} host ${suffix}`;
}

/**
 * The one stop detail every task on an unavailable host records. It names the
 * host and the time it went offline, and it is stable for the outage so a pass
 * that observes the same outage never rewrites the task.
 */
export const hostUnavailableDetail = (hostId: string, since: string) =>
  `Waiting on ${hostDisplayLabel(hostId)} since ${since}`;

/** A whole-minute outage duration for the notice ("2h 05m", "7m"). */
export function outageDuration(from: string, to: number): string {
  const minutes = Math.max(0, Math.floor((to - Date.parse(from)) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/**
 * A project-level notice's durable id, and the only parsing of it. Parts are
 * separated by `|` because a host identity carries its own `:` (`t3code:<env>`),
 * and the outage start is read from the end so no part is ambiguous.
 */
export const hostOutageNoticeId = (hostId: string, projectKey: string, since: string) =>
  `host-outage|${hostId}|${projectKey}|${since}`;

export function parseHostOutageNoticeId(id: string): { hostId: string; projectKey: string; since: string } | null {
  if (!id.startsWith("host-outage|")) return null;
  const sinceAt = id.lastIndexOf("|");
  if (sinceAt <= 0) return null;
  const since = id.slice(sinceAt + 1);
  const projectAt = id.lastIndexOf("|", sinceAt - 1);
  if (projectAt <= "host-outage".length) return null;
  const projectKey = id.slice(projectAt + 1, sinceAt);
  const hostId = id.slice("host-outage|".length, projectAt);
  return hostId && projectKey && Number.isFinite(Date.parse(since)) ? { hostId, projectKey, since } : null;
}
