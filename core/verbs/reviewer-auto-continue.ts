import type { Task } from "../../shared/contracts";
import {
  isDispositionActive,
  taskControlInputSchema,
  type TaskControlInput,
} from "../../shared/contracts";
import { WORKER_REPLACEMENT_CEILING } from "../../shared/schema/task-holds";
import { dispatchBlocked } from "../dispatch/capacity";
import type { Engine } from "../engine";
import { matchingInactiveParticipant } from "../intake/run-settlement";
import { reviewContinuationCauseId } from "../questions/ladder/causes";
import {
  plannerEscalations,
  type LadderEvent,
} from "../questions/ladder/records";
import {
  reviewContinuationState,
  reviewResultFencesRun,
  reviewerCannotFinish,
} from "../review/review-continuation";

/** How long a refused automatic reviewer continuation waits before Queue tries it again. */
const REVIEW_AUTO_CONTINUE_RETRY_MS = 5 * 60_000;

/**
 * The two fences a refused continuation can name, read as facts rather than as
 * the refusal's words. A fence open at the refusal that is closed later lets the
 * next pass try immediately instead of waiting out the retry interval.
 */
type ContinuationFences = { runs: boolean; incident: boolean };

/** Whether any run other than the reviewer's own is still unreleased. */
function otherRunOpen(engine: Engine, taskId: string, runId: string): boolean {
  return engine.store
    .runs(taskId)
    .some((run) => !run.released && run.id !== runId);
}

/** Whether the task still carries the unresolved incident or recovery fence the continuation must settle. */
function incidentFenceOpen(task: Task): boolean {
  const { resolution } = task;
  return Boolean(
    resolution.attention ||
      resolution.recoveryActive ||
      (resolution.recovery && resolution.recovery.status !== "resolved") ||
      (resolution.incident && resolution.incident.status !== "resolved") ||
      (resolution.stalledTurnStop &&
        resolution.stalledTurnStop.status !== "completed"),
  );
}

/**
 * A reviewer checkpoint continues by itself, as a worker checkpoint does (Tom,
 * 2026-10-31): once the reader's turn has ended, Queue applies the ordinary
 * retained `restart role=reviewer`, so the delivery keeps its one admission
 * path and at-most-once identity. It runs as Queue, not the owner, so an
 * owner's stop hold still holds it. A refusal waits for a later pass, or retries
 * at once when the fence it named has since cleared.
 *
 * An exhausted reader — one that reported it cannot finish — is answered by the
 * same pass through `replaceExhaustedReviewers`, which takes the fresh-review
 * exit rather than a continuation.
 */
export class ReviewerAutoContinue {
  constructor(readonly engine: Engine) {}
  get store() {
    return this.engine.store;
  }
  /** The last refusal per reviewer run and checkpoint; memory only, so a restart retries at once. */
  private readonly refusals = new Map<
    string,
    {
      detail: string;
      at: number;
      repeated: boolean;
      fences: ContinuationFences;
    }
  >();

  /**
   * An exhausted reader — one that reported it cannot finish the remaining
   * reading — is ruled out at this head (Spec 050; Tom's one-retained-reviewer
   * rule, applied by the planner on nucleus#1358). Once its own agent is
   * observed settled, Queue performs the ordinary `restart role=reviewer fresh`
   * the board already offers: the same rule, the same exact head, and the same
   * retirement ceiling as every other fresh worker replacement. A refused
   * replacement, or a spent ceiling, opens the planner escalation with that verb
   * in the question instead. Either way the reader is answered on the pass that
   * observes it; it never sits silently (nucleus#1372).
   */
  async replaceExhaustedReviewers(
    tasks: Task[],
    scopedHost?: string,
  ): Promise<void> {
    if (this.engine.stopped) return;
    if (!scopedHost) {
      for (const host of new Set(
        tasks.flatMap((task) => (task.hostId ? [task.hostId] : [])),
      ))
        await this.engine.withHost(host, () =>
          this.replaceExhaustedReviewers(tasks, host),
        );
      return;
    }
    const eligible = (taskId: string) => {
      const task = this.store.task(taskId);
      if (task.hostId !== scopedHost) return null;
      if (!this.engine.taskHostAvailable(task)) return null;
      if (
        task.removedAt ||
        isDispositionActive(task) ||
        dispatchBlocked(task) ||
        task.resolution.deferredVerb ||
        // A replacement already applied for this reader and is waiting for its
        // thread archive: re-issuing it each pass would only repeat that wait.
        task.resolution.pendingReviewReason
      )
        return null;
      if (reviewContinuationState(task, this.store) !== "exhausted")
        return null;
      const run = task.resolution.currentRunId
        ? this.store.run(task.resolution.currentRunId)
        : null;
      if (!run?.agentId || !reviewerCannotFinish(run)) return null;
      // The ladder already owns this reader: its escalation names why the
      // ordinary replacement could not act, so a later pass owes it no new
      // observation, restart attempt or record.
      const cause = reviewContinuationCauseId(task.id, "exhausted", run.id);
      if (
        plannerEscalations(this.store.eventsAll(task.id) as LadderEvent[]).some(
          (escalation) => escalation.cause === cause,
        )
      )
        return null;
      return { task, run };
    };
    for (const initial of tasks) {
      if (this.engine.stopped) return;
      const before = eligible(initial.id);
      if (!before) continue;
      // The retirement ceiling is the automatic loop breaker every fresh
      // replacement answers to. Past it, the ladder decides, with the verb named.
      if (before.task.retiredWorkers.length >= WORKER_REPLACEMENT_CEILING) {
        this.escalateExhaustedReader(
          before.task,
          before.run.id,
          `Nucleus retired ${before.task.retiredWorkers.length} workers, the replacement ceiling of ${WORKER_REPLACEMENT_CEILING}; an operator-relayed restart role=worker fresh is required to replace another`,
        );
        continue;
      }
      // The reader's own settled observation is the trigger, with the same three
      // states every reviewer continuation accepts: idle, errored and closed are
      // the existing REVIEW_AGENT_ERRORED and REVIEW_AGENT_CLOSED exits, not a
      // new reading. A busy, permission-pending or unreadable reader proves
      // nothing settled, so a later pass answers it.
      const state = await this.engine.host
        .observe(before.run.agentId!)
        .catch(() => null);
      if (!state || !matchingInactiveParticipant(before.run, state)) continue;
      const found = eligible(initial.id);
      if (!found || found.run.id !== before.run.id) continue;
      const { task, run } = found;
      try {
        await this.engine.performTaskControl(
          taskControlInputSchema.parse({
            taskId: task.id,
            version: task.version,
            action: "restart",
            role: "reviewer",
            fresh: true,
            reason: `Queue replaces the reviewer that reported it cannot finish (run ${run.id} at ${run.head})`,
          }) as TaskControlInput,
        );
        this.store.event(
          task.id,
          "review_exhausted_replaced",
          `${run.id} at ${run.head}`,
        );
      } catch (error) {
        const detail = `${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 1800);
        // The ordinary replacement could not happen. The reader is still answered
        // now: the ladder hears the cause once, naming why the verb could not act.
        this.escalateExhaustedReader(task, run.id, detail);
      }
    }
  }

  /** One escalation per exhausted reader, with the reason the automatic exit did not run. */
  private escalateExhaustedReader(
    task: Task,
    runId: string,
    detail: string,
  ): void {
    const current = this.store.task(task.id);
    if (
      current.resolution.currentRunId &&
      current.resolution.currentRunId !== runId
    )
      return;
    this.engine.resolution.openReviewContinuationEscalation(
      current,
      "exhausted",
      detail,
    );
    const named = `${runId}: ${detail}`.slice(0, 2000);
    const previous = this.store
      .events(task.id)
      .findLast((event) => event.kind === "review_exhausted_escalated");
    if (previous?.detail !== named)
      this.store.event(task.id, "review_exhausted_escalated", named);
  }

  /**
   * The ordinary observation pass skips a reader behind a review fence, so its
   * saved activity is stale here; the reader's own idle observation is the
   * trigger. Anything else (busy, permission, closed, unreadable) waits.
   */
  async continueAwaitingReviewers(
    tasks: Task[],
    scopedHost?: string,
  ): Promise<void> {
    if (this.engine.stopped) return;
    if (!scopedHost) {
      for (const host of new Set(
        tasks.flatMap((task) => (task.hostId ? [task.hostId] : [])),
      ))
        await this.engine.withHost(host, () =>
          this.continueAwaitingReviewers(tasks, host),
        );
      return;
    }
    const eligible = (taskId: string) => {
      const task = this.store.task(taskId);
      if (task.hostId !== scopedHost) return null;
      if (!this.engine.taskHostAvailable(task)) return null;
      if (
        task.removedAt ||
        isDispositionActive(task) ||
        dispatchBlocked(task) ||
        task.resolution.deferredVerb
      )
        return null;
      if (reviewContinuationState(task, this.store) !== "awaiting") return null;
      const run = this.store.run(task.resolution.currentRunId!);
      const checkpoint = run?.reviewCheckpoints?.at(-1);
      return run?.agentId && checkpoint ? { task, run, checkpoint } : null;
    };
    for (const initial of tasks) {
      if (this.engine.stopped) return;
      const before = eligible(initial.id);
      if (!before) continue;
      // A refusal is retried on the next pass; the same refusal twice in a row
      // waits out a retry interval before Queue observes the reader and runs the
      // restart checks (a forge read among them) again — unless the fence it
      // named has since cleared.
      const key = `${before.run.id}:${before.checkpoint.ordinal}`;
      let refused = this.refusals.get(key);
      const fenceCleared = Boolean(
        refused &&
          ((refused.fences.runs &&
            !otherRunOpen(this.engine, before.task.id, before.run.id)) ||
            (refused.fences.incident && !incidentFenceOpen(before.task))),
      );
      if (fenceCleared) {
        this.refusals.delete(key);
        refused = undefined;
      }
      if (
        refused &&
        refused.repeated &&
        Date.now() - refused.at < REVIEW_AUTO_CONTINUE_RETRY_MS
      )
        continue;
      const state = await this.engine.host
        .observe(before.run.agentId!)
        .catch(() => null);
      if (
        !state ||
        state.id !== before.run.agentId ||
        state.workspaceId !== before.run.workspaceId ||
        state.status !== "idle" ||
        state.active ||
        state.permissions ||
        state.activeTurnId
      )
        continue;
      const found = eligible(initial.id);
      if (
        !found ||
        found.run.id !== before.run.id ||
        found.checkpoint.ordinal !== before.checkpoint.ordinal
      )
        continue;
      const { task, run, checkpoint } = found;
      const fences: ContinuationFences = {
        runs: otherRunOpen(this.engine, task.id, run.id),
        incident: incidentFenceOpen(task),
      };
      const reason = `Queue continues the reviewer from checkpoint ${checkpoint.ordinal}`;
      const markFencedReaderStopped = () => {
        const latestRun = this.store.run(run.id);
        if (
          latestRun &&
          !latestRun.released &&
          !latestRun.completion &&
          latestRun.status !== "superseded" &&
          reviewResultFencesRun(this.store, this.store.task(task.id), latestRun)
        ) {
          const observedAt = new Date().toISOString();
          this.store.putRun({
            ...latestRun,
            status: "stopped",
            active: false,
            idleSince: latestRun.idleSince ?? observedAt,
            lastObservedAt: observedAt,
          });
        }
      };
      try {
        await this.engine.replayingDeferredVerb.run(true, () =>
          this.engine.performTaskControl(
            taskControlInputSchema.parse({
              taskId: task.id,
              version: task.version,
              action: "restart",
              role: "reviewer",
              reason,
            }) as TaskControlInput,
          ),
        );
        // A hold or pause that landed meanwhile records the verb instead of sending it.
        const sent = ["reserved", "continuing"].includes(
          reviewContinuationState(this.store.task(task.id), this.store) ?? "",
        );
        if (sent)
          this.store.event(
            task.id,
            "review_auto_continued",
            `${checkpoint.ordinal} run ${run.id} at ${run.head}`,
          );
        else markFencedReaderStopped();
      } catch (error) {
        const detail =
          `${checkpoint.ordinal} run ${run.id}: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            2000,
          );
        markFencedReaderStopped();
        const last = this.refusals.get(`${run.id}:${checkpoint.ordinal}`);
        this.refusals.set(`${run.id}:${checkpoint.ordinal}`, {
          detail,
          at: Date.now(),
          repeated: last?.detail === detail,
          fences,
        });
        const previous = this.store
          .events(task.id)
          .findLast((event) => event.kind === "review_auto_continue_deferred");
        if (previous?.detail !== detail)
          this.store.event(task.id, "review_auto_continue_deferred", detail);
      }
    }
  }
}
