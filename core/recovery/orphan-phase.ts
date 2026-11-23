import type { Run, Task } from "../../shared/contracts";
import { holdsOf, isDispositionActive } from "../../shared/contracts";
import { revisionAllowanceExhausted, taskActivity } from "../../shared/task-activity";
import { blockingHold } from "../../shared/task-state";
import { TaskChangedRefusal } from "../../shared/task-version";
import { activityReadContext } from "../telemetry/task-activity-observation";
import { proofWaitApplies } from "../qa/proof-wait";
import { resultApplied } from "../intake/applied-result";
import type { Engine } from "../engine";
import type { Resolution } from "../resolution";

/**
 * Spec 068 §4 orphan phases (Spec 066 R3's four-state rule): a non-terminal
 * phase with no live run, no stop and no hold has no owner, and reads
 * "progressing" forever. After a grace with nothing changing, the sweep returns
 * it to ordinary admission for its role through the owner's own `move` verb
 * (worker phases to `move to=work`, review phases to `move to=review`), or
 * records a typed stop naming why it can't, with the explicit command.
 *
 * The detector is the activity reading itself: the task must read
 * `unclassified` with no participant, so whatever `next` and the board show is
 * what this acts on. A deliberate hold, an owner stop, a disposition, a pause, a
 * prerequisite wait and a recovery episode are never orphans.
 */
export const ORPHAN_PHASE_GRACE_MS = 5 * 60_000;
/** Readmissions of one orphan before it becomes a person's question (Spec 068 §5). */
export const ORPHAN_READMISSION_BOUND = 3;
export const ORPHAN_PHASE_READMITTED = "orphan_phase_readmitted";
export const ORPHAN_PHASE_STOPPED = "orphan_phase_stopped";

type OrphanMove = "work" | "review";
const orphanPhases: Partial<Record<Task["phase"], { role: "worker" | "reviewer"; move: OrphanMove }>> = {
  working: { role: "worker", move: "work" },
  changes_requested: { role: "worker", move: "work" },
  awaiting_review: { role: "reviewer", move: "review" },
  reviewing: { role: "reviewer", move: "review" },
};

export interface OrphanPhase {
  phase: Task["phase"];
  role: "worker" | "reviewer";
  move: OrphanMove;
  /** What must stay unchanged across the grace for the orphan to be the same one. */
  key: string;
  /**
   * The worker's released, authenticated result nothing applied. A pushed head
   * (`ready_for_review`) goes on to its reviewer; any other report is a typed stop.
   */
  result?: Run;
}

/** Owner and orphan writes that answer a released result: after one, the result is no longer pending. */
const RESULT_ANSWERS = new Set(["owner_control", "owner_resolution", "move_work_requested", "run_result_applied", ORPHAN_PHASE_READMITTED]);

/**
 * The worker's latest run, when it is a released revision whose own
 * authenticated completion no pass or owner has applied since it arrived.
 */
export function unappliedWorkerResult(store: Engine["store"], task: Task, runs: readonly Run[], events: ReadonlyArray<{ kind: string; at: string; detail: string }>): Run | null {
  const latest = runs.reduce<Run | null>((newest, run) => !newest || run.createdAt > newest.createdAt ? run : newest, null);
  if (!latest || latest.role !== "revision" || !latest.released || latest.completion?.runId !== latest.id) return null;
  if (resultApplied(store, task.id, latest.id)) return null;
  const arrived = Date.parse(latest.completionReceivedAt ?? latest.lastObservedAt ?? latest.createdAt);
  return events.some((event) => RESULT_ANSWERS.has(event.kind) && Date.parse(event.at) > arrived) ? null : latest;
}

/** The orphan shape this task is in now, or null. Pure over the store's current facts. */
export function orphanPhase(store: Engine["store"], task: Task, paused: boolean): OrphanPhase | null {
  const route = orphanPhases[task.phase];
  if (!route || paused || task.removedAt || task.interactive) return null;
  const { resolution } = task;
  if (resolution.stop || resolution.ownerStop || resolution.attention || resolution.recoveryActive ||
      resolution.recovery || resolution.hostWait || (resolution.stalledTurnStop && resolution.stalledTurnStop.status !== "completed"))
    return null;
  if (isDispositionActive(task) || blockingHold(task) || holdsOf(task).dispatch || holdsOf(task).merge || task.held) return null;
  if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt) return null;
  if (task.agentIntent || task.workspaceIntent || !task.workspaceId || proofWaitApplies(task)) return null;
  // A bound worker is the reconciler's, live or dead (Spec 068 batch 3b).
  if (task.phase === "working" && (task.agentId || task.completion)) return null;
  const runs = store.runs(task.id);
  if (runs.some((run: Run) => !run.released)) return null;
  const events = store.eventsAll(task.id);
  const activity = taskActivity({ task, runs, events, stop: null, read: activityReadContext(store), now: Date.now() });
  if (activity.state !== "unclassified" || activity.role !== null) return null;
  const key = [task.phase, task.agentId, task.runId, resolution.currentRunId, runs.length].join("|");
  // A revision that reported and was released, with nothing applying its result
  // (bovine-accelerator#6935): its own report decides the next role.
  const result = task.phase === "changes_requested" ? unappliedWorkerResult(store, task, runs, events) : null;
  if (result)
    return result.completion?.status === "ready_for_review"
      ? { phase: task.phase, role: "reviewer", move: "review", key, result }
      : { phase: task.phase, ...route, key, result };
  // A spent revision allowance is a typed cap stop's, not a readmission's.
  if (route.role === "worker" && revisionAllowanceExhausted(task, runs, events)) return null;
  return { phase: task.phase, ...route, key };
}

export type OrphanPhaseContext = Pick<Engine, "hostAvailable" | "moveToReview" | "moveToWork" | "store"> & {
  readonly resolution: Pick<Resolution, "recordStop">;
};

/**
 * The sweep's orphan owner. The grace is kept in memory: a restart starts it
 * again, which costs one grace and writes nothing.
 */
export class OrphanPhases {
  graceMs = ORPHAN_PHASE_GRACE_MS;
  private seen = new Map<string, { key: string; since: number }>();
  constructor(private readonly context: OrphanPhaseContext) {}

  async settle(taskId: string, paused: boolean): Promise<void> {
    const { store } = this.context;
    const task = store.task(taskId);
    // An unavailable host is its health owner's wait, never an orphan.
    const hostDown = Boolean(task.hostId && !this.context.hostAvailable(task.hostId));
    const orphan = orphanPhase(store, task, paused || hostDown);
    if (!orphan) {
      this.seen.delete(taskId);
      return;
    }
    const seen = this.seen.get(taskId);
    if (!seen || seen.key !== orphan.key) {
      this.seen.set(taskId, { key: orphan.key, since: Date.now() });
      if (this.graceMs > 0) return;
    } else if (Date.now() - seen.since < this.graceMs) return;
    this.seen.delete(taskId);
    const what = `${task.phase} with no live run, stop or hold`;
    const command = orphan.move === "work" ? "move to=work" : "move to=review";
    const latestRun = Math.max(0, ...store.runs(taskId).map((run) => Date.parse(run.createdAt) || 0));
    const readmissions = store.eventsAll(taskId).filter((event) =>
      event.kind === ORPHAN_PHASE_READMITTED && Date.parse(event.at) >= latestRun).length;
    const result = orphan.result?.completion;
    if (result && result.status !== "ready_for_review") {
      this.stop(task, orphan, `Worker run ${orphan.result!.id} reported ${result.status} and was released, but nothing applied its report: ${result.summary}`.slice(0, 3000) +
        ` Answer the report, then use ${command} with an instruction or run.start worker fresh.`);
      return;
    }
    if (readmissions >= ORPHAN_READMISSION_BOUND) {
      this.stop(task, orphan, `The task was ${what} again after ${readmissions} automatic readmissions, and no ${orphan.role} started. Check why, then use ${command} or run.start ${orphan.role} fresh.`);
      return;
    }
    const reason = result
      ? `Spec 068 orphan phase: worker run ${orphan.result!.id} reported ready_for_review at ${result.head ?? "its head"} and was released, but nothing applied it; returned to reviewer admission`
      : `Spec 068 orphan phase: the task was ${what}; returned to ${orphan.role} admission`;
    try {
      if (orphan.move === "work") await this.context.moveToWork({ taskId, version: task.version, reason });
      else await this.context.moveToReview({ taskId, version: task.version, reason });
    } catch (error) {
      // A write that landed meanwhile is the task moving on, not a refusal.
      if (error instanceof TaskChangedRefusal || store.task(taskId).version !== task.version) return;
      const message = error instanceof Error ? error.message : String(error);
      this.stop(store.task(taskId), orphan, `The task was ${what}, and Nucleus could not return it to ${orphan.role} admission: ${message}. Settle that, then use ${command} or run.start ${orphan.role} fresh.`);
      return;
    }
    store.event(taskId, ORPHAN_PHASE_READMITTED, JSON.stringify({
      phase: orphan.phase, move: orphan.move, attempt: readmissions + 1, ...(orphan.result ? { result: orphan.result.id } : {}),
    }));
  }

  private stop(task: Task, orphan: OrphanPhase, detail: string): void {
    this.context.resolution.recordStop(task, "operator_needed", detail, ["move", "restart"], undefined, {
      code: "orphan_phase",
      subject: orphan.phase,
    });
    this.context.store.event(task.id, ORPHAN_PHASE_STOPPED, detail.slice(0, 4000));
  }
}
