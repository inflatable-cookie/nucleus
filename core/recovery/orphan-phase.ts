import type { Run, Task } from "../../shared/contracts";
import { holdsOf, isDispositionActive } from "../../shared/contracts";
import { revisionAllowanceExhausted } from "../../shared/task-activity";
import { blockingHold } from "../../shared/task-state";
import { taskDetailView } from "../../shared/task-view";
import { TaskChangedRefusal } from "../../shared/task-version";
import { activityReadContext } from "../telemetry/task-activity-observation";
import { proofWaitApplies } from "../qa/proof-wait";
import { resultApplied } from "../intake/applied-result";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { WorkerSourceRefusal } from "../git/git-refusals";
import { ForeignPrIdentity } from "../forge/pr-identity";
import { ProvenPreSendRefusalError } from "../host/errors";
import { RetainedRunRefusal } from "./task-reasons/refusals";
import { blockingRecoveryEffectsRefusal } from "./recovery-effects";
import { operatorReplacementPending, PR_HEAD_CHANGED_REASON } from "./task-reasons";
import { taskWaitStateContext, taskWithCurrentWait } from "./wait-context";
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
 * The detector is the activity reading the board and `next` show: the task
 * must read `unclassified` with no participant. Every state another owner is
 * known to hold is excluded, so a deferral that owner records nothing for is
 * never mistaken for an orphan: a hold, an owner stop, a disposition, a pause,
 * an unavailable host, a prerequisite wait, a recovery episode, an armed worker
 * replacement or failover (the fleet's replacement step owns it), a provider
 * retry, a blocking side effect and a spent revision allowance.
 *
 * This is the backstop. A state that reaches it means some owner deferred
 * silently; the cause belongs in that owner (as bovine-accelerator#6935's did,
 * in result application's lease), and the readmission keeps the task moving
 * meanwhile.
 */
export const ORPHAN_PHASE_GRACE_MS = 5 * 60_000;
/** Readmissions of one orphan episode before it becomes a person's question (Spec 068 §5). */
export const ORPHAN_READMISSION_BOUND = 3;
/** An episode is never longer than this: older readmissions do not count against a new one. */
export const ORPHAN_EPISODE_WINDOW_MS = 2 * 60 * 60_000;
export const ORPHAN_PHASE_READMITTED = "orphan_phase_readmitted";
export const ORPHAN_PHASE_STOPPED = "orphan_phase_stopped";

type OrphanMove = "work" | "review" | "result";
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
  /** The worker's released, authenticated result nothing applied: ordinary result application owns it. */
  result?: WorkerResult;
}

/**
 * A worker result nothing applied: a released revision run's own completion, or
 * the initial worker's recorded completion (it has no run record) after its
 * binding was released.
 */
export type WorkerResult =
  | { kind: "revision"; run: Run }
  | { kind: "initial"; completion: NonNullable<Task["completion"]> };

/**
 * Writes after a released result that mean someone answered it: an owner,
 * planner or coordinator verb, a recovery action, an applied result, a new
 * worker turn or an earlier readmission.
 */
const RESULT_ANSWERS = new Set([
  "owner_control", "owner_resolution", "operator_control", "move_work_requested", "move_review_requested",
  "run_result_applied", "review_result_applied", "coordinator_action_applied", "coordinator_action_refused",
  "recovery_action_bound", "planner_escalation", "planner_escalation_applied", "planner_escalation_answered",
  "worker_resume_requested", "revision_requested", "agent_created", "run_intent", ORPHAN_PHASE_READMITTED,
]);

/**
 * The worker's latest run, when it is a released revision whose own
 * authenticated completion no pass, owner, planner or coordinator has answered
 * since it arrived.
 */
export function unappliedWorkerResult(store: Engine["store"], task: Task, runs: readonly Run[], events: ReadonlyArray<{ kind: string; at: string; detail: string }>): Run | null {
  const latest = runs.reduce<Run | null>((newest, run) => !newest || run.createdAt > newest.createdAt ? run : newest, null);
  if (!latest || latest.role !== "revision" || !latest.released || latest.completion?.runId !== latest.id) return null;
  if (resultApplied(store, task.id, latest.id)) return null;
  if (task.resolution.currentRunId && task.resolution.currentRunId !== latest.id) return null;
  const arrived = Date.parse(latest.completionReceivedAt ?? latest.lastObservedAt ?? latest.createdAt);
  return events.some((event) => RESULT_ANSWERS.has(event.kind) && Date.parse(event.at) > arrived) ? null : latest;
}

/**
 * Writes after an initial worker's released result that mean the task moved on
 * from it: an applied result, a new worker turn or an earlier readmission. A
 * generic owner command is not one: `run.release` of the worker, a cleared stop
 * or a reviewer started at its head never apply the result, and a control that
 * decides it moves the phase off `working` or records its own stop.
 */
const INITIAL_RESULT_ANSWERS = new Set([
  "run_result_applied", "workspace_released", "agent_created", "worker_resume_requested", "revision_requested",
  "move_work_requested", "move_review_requested", "coordinator_action_applied", "planner_escalation_applied",
  ORPHAN_PHASE_READMITTED,
]);

/**
 * The initial worker's authenticated completion, when its binding was released
 * before the result applied: the task is still `working` with no worker bound,
 * so no reconciler observes the worker and nothing applies the report. A bound
 * worker stays the reconciler's, and a later worker turn supersedes the result.
 */
export function unappliedInitialWorkerResult(store: Engine["store"], task: Task, runs: readonly Run[], events: ReadonlyArray<{ kind: string; at: string; detail: string }>): NonNullable<Task["completion"]> | null {
  const completion = task.completion;
  if (task.phase !== "working" || !completion || task.agentId || (task.runId && task.runId !== completion.runId)) return null;
  if (runs.some((run) => run.id === completion.runId) || resultApplied(store, task.id, completion.runId)) return null;
  const arrivedAt = events.findLast((event) => event.kind === "completion_received")?.at;
  if (!arrivedAt) return null;
  const arrived = Date.parse(arrivedAt);
  if (runs.some((run) => run.role === "revision" && Date.parse(run.createdAt) > arrived)) return null;
  return events.some((event) => INITIAL_RESULT_ANSWERS.has(event.kind) && Date.parse(event.at) > arrived) ? null : completion;
}

/** The activity the board and `next` show for this task now. */
function shownActivity(store: Engine["store"], task: Task, runs: Run[], events: Array<{ kind: string; at: string; detail: string }>) {
  const decisionId = store.listDecisions({ status: "open", task: task.id })[0]?.id ?? null;
  const context = taskWaitStateContext(store, task, decisionId);
  return taskDetailView(taskWithCurrentWait(store, task, context), context, runs, events,
    store.canonicalRepository(task.repoPath, task.repository), Date.now(), activityReadContext(store)).activity;
}

/** The orphan shape this task is in now, or null. Pure over the store's current facts. */
export function orphanPhase(store: Engine["store"], task: Task, paused: boolean): OrphanPhase | null {
  const route = orphanPhases[task.phase];
  if (!route || paused || task.removedAt || task.interactive) return null;
  const { resolution } = task;
  // A resolved recovery episode is history; only a live one owns the task.
  const liveRecovery = resolution.recovery && resolution.recovery.status !== "resolved";
  if (resolution.ownerStop || resolution.attention || resolution.recoveryActive ||
      liveRecovery || resolution.hostWait || (resolution.stalledTurnStop && resolution.stalledTurnStop.status !== "completed"))
    return null;
  if (isDispositionActive(task) || blockingHold(task) || holdsOf(task).dispatch || holdsOf(task).merge || task.held) return null;
  if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt) return null;
  // An intent is unresolved only while its creation has bound nothing: a settled
  // creation keeps its intent flag beside the bound id.
  if ((task.agentIntent && !task.agentId) || (task.workspaceIntent && !task.workspaceId) || !task.workspaceId || proofWaitApplies(task)) return null;
  // An armed replacement or failover belongs to the fleet's replacement step,
  // and a provider retry to its own backoff: the excluded worker is never revised.
  if (task.failoverReason || operatorReplacementPending(task) || task.transientProviderRetry) return null;
  const runs = store.runs(task.id);
  if (runs.some((run: Run) => !run.released)) return null;
  if (blockingRecoveryEffectsRefusal(store, task)) return null;
  const events = store.eventsAll(task.id);
  const key = [task.phase, task.agentId, task.runId, resolution.currentRunId, runs.length].join("|");
  // A worker result that reported and was released, with nothing applying it:
  // ordinary result application owns its next step, ladder included.
  const revision = !resolution.stop && task.phase === "changes_requested" ? unappliedWorkerResult(store, task, runs, events) : null;
  if (revision) return { phase: task.phase, role: "worker", move: "result", key, result: { kind: "revision", run: revision } };
  // The initial worker's result has no owner at all once its binding is gone:
  // no worker is bound to observe, and no run record carries it. A lifecycle
  // wait does not own it either; there it is the lifecycle saying it can't go
  // on without the result (a verdict on a PR the result never recorded).
  const initial = !resolution.stop || resolution.stop.reason === "lifecycle"
    ? unappliedInitialWorkerResult(store, task, runs, events) : null;
  if (initial) return { phase: task.phase, role: "worker", move: "result", key, result: { kind: "initial", completion: initial } };
  if (resolution.stop) return null;
  // A bound worker is the reconciler's, live or dead (Spec 068 batch 3b).
  if (task.phase === "working" && (task.agentId || task.completion)) return null;
  const activity = shownActivity(store, task, runs, events);
  if (!activity || activity.state !== "unclassified" || activity.role !== null) return null;
  // A spent revision allowance is a typed cap stop's, not a readmission's.
  if (route.role === "worker" && revisionAllowanceExhausted(task, runs, events)) return null;
  return { phase: task.phase, ...route, key };
}

/** The refusals that answer a result application, as opposed to a read that failed and is retried. */
function typedRefusal(error: unknown): boolean {
  return error instanceof WorkerSourceRefusal || error instanceof ForeignPrIdentity || error instanceof DurableFenceRefusal ||
    error instanceof RetainedRunRefusal || error instanceof ProvenPreSendRefusalError ||
    // The worker's result acceptance refuses a PR whose head moved after the report.
    (error instanceof Error && error.message === PR_HEAD_CHANGED_REASON);
}

export type OrphanPhaseContext = Pick<Engine, "acceptWorkerResult" | "hostAvailable" | "moveToReview" | "moveToWork" | "stopped" | "store"> & {
  readonly resolution: Pick<Resolution, "advance" | "recordStop" | "update">;
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
    if (orphan.result) {
      await this.applyResult(task, orphan, orphan.result);
      return;
    }
    const command = orphan.move === "work" ? "move to=work" : "move to=review";
    const readmissions = this.episodeReadmissions(taskId);
    if (readmissions >= ORPHAN_READMISSION_BOUND) {
      this.stop(task, orphan, `The task was ${what} again after ${readmissions} automatic readmissions, and no ${orphan.role} started. Check why, then use ${command} or run.start ${orphan.role} fresh.`);
      return;
    }
    const reason = `Spec 068 orphan phase: the task was ${what}; returned to ${orphan.role} admission`;
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
    store.event(taskId, ORPHAN_PHASE_READMITTED, JSON.stringify({ phase: orphan.phase, move: orphan.move, attempt: readmissions + 1 }));
  }

  /**
   * Run ordinary result application for a released worker result nothing
   * applied, rebinding it when nothing else is bound. A revision run becomes the
   * current run and the task's advance applies it; the initial worker's
   * completion gets back the run binding its release cleared, and the worker's
   * own result acceptance applies it, verifying the PR it names at the exact
   * head. That path owns the outcome: a pushed head goes on to review, a blocked
   * report climbs the blocker ladder, and a participant still in its turn
   * records its wait. Only when it applies and records nothing is the typed stop
   * written.
   */
  private async applyResult(task: Task, orphan: OrphanPhase, result: WorkerResult): Promise<void> {
    const { store } = this.context;
    const completion = result.kind === "revision" ? result.run.completion! : result.completion;
    const runId = completion.runId;
    const status = completion.status;
    const label = result.kind === "revision" ? `${result.run.role} run ${runId}` : `initial worker run ${runId}`;
    let current = task;
    try {
      if (result.kind === "revision") {
        if (!current.resolution.currentRunId)
          current = this.context.resolution.update(current, { currentRunId: runId }, {}, "orphan_result_rebound",
            `${label} reported ${status} and was released with nothing applying it; ordinary result application takes it`);
        await this.context.resolution.advance(current);
      } else {
        if (!current.runId)
          current = this.context.resolution.update(current, {}, { runId }, "orphan_result_rebound",
            `${label} reported ${status} and its binding was released with nothing applying it; ordinary result application takes it`);
        await this.context.acceptWorkerResult(current, current);
      }
    } catch (error) {
      // Only a typed refusal is an answer. Anything else (a forge read that
      // failed, a timeout) leaves the rebinding for the next pass to retry, as
      // the ordinary path does.
      if (!typedRefusal(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.stop(store.task(task.id), orphan, `Worker ${label} reported ${status} and was released, and applying its report was refused: ${message}`.slice(0, 3000) + ` ${this.resultCommand(status)}`);
      return;
    }
    // A pass that ended because the service is stopping, or its host left,
    // applied nothing by design: that is no evidence against the result.
    if (this.context.stopped || (task.hostId && !this.context.hostAvailable(task.hostId))) return;
    const after = store.task(task.id);
    const answered = JSON.stringify(after.resolution.stop) !== JSON.stringify(task.resolution.stop) ||
      (after.resolution.attention && !task.resolution.attention);
    if (resultApplied(store, task.id, runId) || after.phase !== task.phase || answered) {
      store.event(task.id, ORPHAN_PHASE_READMITTED, JSON.stringify({ phase: orphan.phase, move: orphan.move, result: runId }));
      return;
    }
    // A lifecycle wait that stands unchanged is still its owner's visible wait.
    if (after.resolution.stop?.reason === "lifecycle") return;
    this.stop(after, orphan, `Worker ${label} reported ${status} and was released, but applying its report changed nothing: ${completion.summary}`.slice(0, 3000) + ` ${this.resultCommand(status)}`);
  }

  private resultCommand(status: string): string {
    return status === "ready_for_review"
      ? "Use move to=review to review its head, or move to=work with an instruction."
      : "Answer the report, then use move to=work with an instruction or run.start worker fresh.";
  }

  /** Readmissions since the latest participant started, within one episode window. */
  private episodeReadmissions(taskId: string): number {
    const { store } = this.context;
    const events = store.eventsAll(taskId);
    const started = Math.max(
      Date.now() - ORPHAN_EPISODE_WINDOW_MS,
      ...store.runs(taskId).map((run) => Date.parse(run.createdAt) || 0),
      ...events.filter((event) => event.kind === "agent_created").map((event) => Date.parse(event.at) || 0),
    );
    return events.filter((event) => event.kind === ORPHAN_PHASE_READMITTED && Date.parse(event.at) >= started).length;
  }

  private stop(task: Task, orphan: OrphanPhase, detail: string): void {
    this.context.resolution.recordStop(task, "operator_needed", detail, ["move", "restart"], undefined, {
      code: "orphan_phase",
      subject: orphan.phase,
    });
    this.context.store.event(task.id, ORPHAN_PHASE_STOPPED, detail.slice(0, 4000));
  }
}
