/**
 * The bounded recovery loop's measured facts — which coordinator launches are
 * charged to the task's current work, when the bound was last deliberately
 * re-armed, and the work basis those launches belong to (Tom, 2026-10-27).
 *
 * It lives on its own so the read view (`next`, task detail) and recovery's own
 * dispatch share one derivation without importing the recovery class: the count
 * an owner reads is the count that stops the loop. Nothing here writes.
 */
import type { Task } from '../../shared/contracts';
import { digest, type Store } from '../store/store';

/** Consecutive coordinator runs that moved no work before Queue stops launching them (Tom, 2026-10-19). */
export const COORDINATOR_LOOP_LIMIT = 3;
export const COORDINATOR_LOOP_SUMMARY = `Coordinator recovery stopped: ${COORDINATOR_LOOP_LIMIT} coordinator runs in a row moved no work, so Queue launches no more for this task. Read next and apply the verb this task needs; work, source or coverage progress resets the count, and so does one explicit restart role=coordinator, while ordinary retained restarts and route changes do not.`;

/**
 * The task's work identity for the recovery loop only: the exact source head,
 * the approved instruction source and the merge state, with the highest review
 * coverage reached at that head across reviewer runs. A fresh reviewer restarts
 * coverage at checkpoint 1, so replacing the reviewer is not progress; a
 * retained reviewer that reviews further than any reviewer already did is.
 * Recovery counts repeated recovery that moves no work against this identity, so
 * neither bookkeeping nor a new reviewer identity can stand in for work
 * (Tom, 2026-10-27).
 *
 * This is deliberately not the report intent guard: reviewer coverage belongs to
 * the loop's progress measure, and the same retained reviewer evolving its
 * coverage at one head never removes the ordinary move authority an episode was
 * opened with (review 5668519775).
 */
export function taskWorkIdentity(t: Task, store: Pick<Store, 'runs'>): string {
  const head = t.prHead ?? t.planningBase;
  const coverage = reviewCoverageAtHead(t, store);
  return digest(JSON.stringify([head, t.briefVersions.at(-1)?.digest ?? null, t.resolution.mergeIntent, t.resolution.mergedCommit, coverage]));
}

/** Where each launched coordinator run recorded the work identity it was asked about, and where that launch sits in the event history. */
const coordinatorLaunches = (store: Pick<Store, 'eventsAll'>, taskId: string): Map<string, { work: string | undefined; eventId: number; outage: boolean }> => {
  const launched = new Map<string, { work: string | undefined; eventId: number; outage: boolean }>();
  for (const event of store.eventsAll(taskId)) {
    if (event.kind !== 'telemetry_recovery') continue;
    try {
      const detail = JSON.parse(event.detail) as { runId?: string; work?: string; outage?: boolean };
      if (detail.runId) launched.set(detail.runId, { work: typeof detail.work === 'string' ? detail.work : undefined, eventId: event.id, outage: detail.outage === true });
    } catch { /* a legacy launch detail names no work identity; its run is charged only at this head */ }
  }
  return launched;
};

/**
 * The last reset of the recovery budget: the merge that moves a task into
 * closeout recovery, or one explicit owner `restart role=coordinator` (Tom,
 * 2026-10-27). Both are deliberate re-arms. A routine retained restart, a route
 * change or a bookkeeping success at unchanged work is not: those used to refill
 * the bound silently, so owner reviewer restarts bought a fourth coordinator
 * launch for the same unchanged work.
 */
const lastRecoveryReset = (store: Pick<Store, 'eventsAll'>, taskId: string): { eventId: number; at: string } | null => store.eventsAll(taskId)
  .filter(event => event.kind === 'closeout_recovery_budget'
    // The explicit coordinator restart records its re-arm inside the successful
    // transition, so the reset never depends on the best-effort owner_control
    // audit line or on that line's prose surviving its length bound.
    || event.kind === 'coordinator_rearm'
    || (event.kind === 'owner_control' && (() => {
      try {
        const detail = JSON.parse(event.detail) as { verb?: unknown; identities?: { restart?: { role?: unknown } } };
        return detail.verb === 'restart' && detail.identities?.restart?.role === 'coordinator';
      } catch { return false; }
    })()))
  // Ordered by the durable event id, never by a millisecond timestamp.
  .reduce<{ eventId: number; at: string } | null>((latest, event) => !latest || event.id > latest.eventId ? { eventId: event.id, at: event.at } : latest, null);

/**
 * Accepted review coverage at one exact head, ordered by the durable event that
 * accepted each checkpoint. Queue writes each `review_checkpoint` line with its
 * ordinal, receipt, run and head; a line that cannot be read that way makes the
 * whole history undatable, which is reported as `null` and never read as
 * progress (the charge is kept instead).
 */
function checkpointCoverageAtHead(store: Pick<Store, 'eventsAll'>, taskId: string, head: string): { eventId: number; ordinal: number }[] | null {
  const timeline: { eventId: number; ordinal: number }[] = [];
  for (const event of store.eventsAll(taskId)) {
    if (event.kind !== 'review_checkpoint') continue;
    const match = /^(\d+)\/\d+ \S+ run \S+ at (\S+)$/.exec(event.detail.trim());
    if (!match) return null;
    if (match[2] !== head) continue;
    timeline.push({ eventId: event.id, ordinal: Number(match[1]) });
  }
  return timeline;
}

/** The highest accepted checkpoint ordinal any reader reached at one exact head. */
function reviewCoverageAtHead(task: Task, store: Pick<Store, 'runs'>): number {
  const head = task.prHead ?? task.planningBase;
  return store.runs(task.id).filter(run => run.role === 'reviewer' && run.head === head)
    .flatMap(run => run.reviewCheckpoints ?? []).reduce((max, record) => Math.max(max, record.ordinal), 0);
}

/**
 * Coordinator runs charged to the task's current work: the trailing chain, from
 * the newest launch back, of runs made for this work identity. A launch that
 * recorded another work identity, or was made at another exact head, proves the
 * work moved after it, so neither it nor anything older can be charged to the
 * current work — that is how a new head, a further retained-reviewer checkpoint
 * or a merge resets the bound while bookkeeping, a new reviewer identity and a
 * repeated move to the same review state do not (Tom, 2026-10-27).
 *
 * Launches are ordered against the last reset by their own durable launch event
 * id, not by millisecond timestamps: a coordinator created after an explicit
 * re-arm in the same millisecond is still after it, so it is charged. A run with
 * no recorded launch event cannot be dated against the reset; it is charged
 * unless it is provably older (its `createdAt` precedes the reset), because
 * dropping an undatable launch could buy another recovery at unchanged work
 * (review 5673243357).
 *
 * A launch that recorded no work identity predates the field. It is charged
 * while it stands at the same exact head unless the *cross-reader maximum*
 * coverage at that head demonstrably rose after it: a replacement reader
 * reaching a lower or equal checkpoint is not progress, so it cannot buy more
 * recovery at unchanged work, while a genuinely higher maximum (or a new source
 * head, which leaves the launch behind) still releases the bound. Undatable
 * checkpoint history is never read as progress. It is never re-labelled with a
 * newer identity and no episode binding is reconstructed.
 */
export function unproductiveCoordinatorRuns(store: Store, taskId: string): number {
  const task = store.task(taskId), work = taskWorkIdentity(task, store), launched = coordinatorLaunches(store, taskId);
  const head = task.prHead ?? task.planningBase, reset = lastRecoveryReset(store, taskId);
  const coverage = reviewCoverageAtHead(task, store), coverageTimeline = checkpointCoverageAtHead(store, taskId, head);
  const runs = store.runs(taskId).filter(run => {
    if (run.role !== 'recovery') return false;
    if (!reset) return true;
    const launch = launched.get(run.id);
    // Durable order when the launch event exists; otherwise charge anything not
    // provably older than the reset.
    return launch ? launch.eventId > reset.eventId : run.createdAt >= reset.at;
  });
  let charged = 0;
  for (const run of runs.reverse()) {
    const launch = launched.get(run.id);
    if (launch?.outage) continue;
    if (!launch) {
      // No launch record at all: nothing dates it, so it cannot be shown to predate
      // the current work. Charge it while it stands at this exact head.
      if (run.head !== head) break;
      charged++;
      continue;
    }
    if (launch.work === undefined) {
      if (run.head !== head) break;
      // Charge unless the maximum coverage at this head rose after this launch.
      const before = coverageTimeline === null ? null
        : coverageTimeline.filter(entry => entry.eventId < launch.eventId).reduce((max, entry) => Math.max(max, entry.ordinal), 0);
      if (before !== null && coverage > before) break;
      charged++;
      continue;
    }
    if (launch.work !== work) break;
    charged++;
  }
  return charged;
}

/** The current work basis in words, so `next` explains what the count is charged to. */
function recoveryWorkBasis(task: Task, store: Pick<Store, 'runs'>): string {
  const head = task.prHead ?? task.planningBase;
  const coverage = reviewCoverageAtHead(task, store);
  const brief = task.briefVersions.at(-1)?.version ?? null;
  const merge = task.resolution.mergedCommit ? 'merged' : task.resolution.mergeIntent ? 'merge requested' : 'not merging';
  return `${head ? `head ${head}` : 'no source head'}, brief ${brief ?? 'none'}, coverage checkpoint ${coverage}, ${merge}`;
}

/** The charged launch count, the bound, and the work basis `next` and task detail report. */
export function recoveryBoundStatus(store: Store, task: Task): { charged: number; limit: number; basis: string } {
  return { charged: unproductiveCoordinatorRuns(store, task.id), limit: COORDINATOR_LOOP_LIMIT, basis: recoveryWorkBasis(task, store) };
}
