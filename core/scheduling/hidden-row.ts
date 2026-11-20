import type { Notice, Task } from "../../shared/contracts";
import { blockingHoldFence, taskOwner } from "../../shared/contracts";
import type {
  HoldKind,
  HoldUntil,
  PlannerHoldAnswer,
  TaskHolds,
} from "../../shared/contracts";
import {
  plannerHoldNeedingAnswer,
  syncHoldProjection,
} from "../../shared/holds";
import type { TaskAttention } from "../../shared/task-attention";
import { isHostOperationTimeout } from "../host";
import type { Adapter, RowSnoozeVisibility } from "../host";
import { taskRowAttention } from "../workspaces/task-row-attention";
import {
  noticeId as attentionNoticeId,
  originRecipient,
} from "../questions/origin";
import type { Store } from "../store/store";

/**
 * A task that stays hidden behind a Nucleus-owned row snooze (nucleus#1417).
 *
 * On T3 a waiting task's row is snoozed by Nucleus itself, so a row that keeps
 * reading snoozed is normally the design working. It stops being normal in two
 * ways, and both are silent today:
 *
 * - the wait has gone on for half an hour with nobody told, so a wait that was
 *   really a missed transition (a role that should be running, a person who must
 *   act) stays invisible; and
 * - an explicit owner hold parks the task for hours, and the planner never learns
 *   the task is sitting behind a fence it did not place.
 *
 * This module owns the reading, the two time bounds and the notice text. It
 * reads only facts other owners already keep: the shared attention projection,
 * the host's durable snooze ownership (`RowSnoozeVisibility`) and the hold fence.
 * It never changes a hold, a snooze, a phase or a run.
 */

/** A wait hidden for this long is reported to the planner (nucleus#1417). */
export const ROW_HIDDEN_MINUTES = 30;
/** A continuous effective hold hidden for this long gets one informational nudge. */
export const ROW_HIDDEN_HOLD_MINUTES = 180;
/**
 * The planner's answer window for its own hold (nucleus#1419): after its nudge is
 * due and delivered, this long with the hold still in place means the planner did
 * not answer, so the row is shown again and the task needs its planner.
 */
export const HOLD_ANSWER_MINUTES = 30;

/**
 * The episode one task's hidden row is being measured for. It is durable (store
 * meta) so a service roll or a daemon restart resumes the same episode instead of
 * restarting its clock or notifying twice.
 */
export interface RowHiddenEpisode {
  /** The host's recorded snooze episode (`RowSnoozeVisibility.episodeStartedAt`). */
  episode: string;
  /** When this episode's hidden time began accruing, on the store's clock. */
  since: string;
  /** The row was hidden behind an explicit hold at the last pass, so hold time does not accrue. */
  held: boolean;
  /** The notice this episode owes once its bound is reached, or null while none is due. */
  noticeId: string | null;
}

/** One task's hidden-row record; a task with no record has no hidden episode. */
export const rowHiddenKey = (taskId: string) => `rowHiddenEpisode:${taskId}`;

/** The notice one implicit hidden episode owns: one per continuous episode. */
export const rowHiddenNoticeId = (taskId: string, episode: string) =>
  `row-hidden:${taskId}:${episode}`;

/** The notice one continuous hold generation owns. */
export const rowHiddenHoldNoticeId = (
  taskId: string,
  kind: HoldKind,
  generation: number,
) => `row-hidden-hold:${taskId}:${kind}:${generation}`;

/** The hold fence a hidden row is parked behind, as the notice names it. */
export interface RowHiddenHold {
  kind: HoldKind;
  generation: number;
  since: string;
  reason: string;
  until: HoldUntil | null;
}

/**
 * The effective hold this task's row is hidden behind, or null. A hold that does
 * not block the current phase (a merge fence beside a queued task, say) is not
 * what the row waits on, so it does not move the task onto the hold rule.
 */
export function rowHiddenHold(task: Task): RowHiddenHold | null {
  const blocking = blockingHoldFence(task);
  if (!blocking) return null;
  return {
    kind: blocking.kind,
    generation: blocking.fence.generation,
    since: blocking.fence.at,
    reason: blocking.fence.reason,
    until: blocking.fence.until ?? null,
  };
}

export type RowHiddenPlan =
  /** Nothing hides this row: reset any recorded episode. */
  | { kind: "clear" }
  /** Hidden, but inside its bound: keep accruing, nothing to send. */
  | { kind: "accruing"; record: RowHiddenEpisode }
  /** Hidden past its bound: this episode owes one notice. */
  | {
      kind: "due";
      record: RowHiddenEpisode;
      noticeId: string;
      minutes: number;
      /** Why the row should be visible, or that its state is unreadable. */
      failure: "missed" | "unknown";
      /** The host's own answer when the row could not be read. */
      reason?: string;
      hold: RowHiddenHold | null;
      /**
       * This nudge opens the planner's answer window (nucleus#1419): true only for
       * the planner's own hold, whose notice the hold answer cycle raises. A hold
       * another participant placed is only reported.
       */
      answerWindow?: boolean;
    };

const minutesBetween = (since: string, at: number): number => {
  const start = Date.parse(since);
  return Number.isFinite(start)
    ? Math.max(0, Math.floor((at - start) / 60_000))
    : 0;
};

/** A start time this clock has not reached yet is this clock's own answer. */
const boundedStart = (since: string, at: number): string => {
  const parsed = Date.parse(since);
  return Number.isFinite(parsed) && parsed <= at
    ? since
    : new Date(at).toISOString();
};

/**
 * One task's hidden-row plan from the facts its owners already keep. `prior` is
 * the durable record from the last pass, so a renewal, a roll or a repeated sweep
 * never restarts the clock; an episode the host no longer reports clears it.
 */
export function rowHiddenPlan(input: {
  task: Task;
  attention: TaskAttention;
  visibility: RowSnoozeVisibility;
  prior: RowHiddenEpisode | undefined;
  /** The planner's current recipient for this task, when one is provable. */
  reminderReachedPlanner?: boolean;
  /**
   * The nudge a planner's own hold already owns for this generation
   * (nucleus#1419). The hold answer cycle raises and keeps it, so this plan records
   * it as the episode's live notice instead of raising a second one.
   */
  holdNudgeId?: string | null;
  at: number;
}): RowHiddenPlan {
  const { task, attention, visibility, prior, at } = input;
  // A finished task's row is the terminal lane's, whatever T3 still shows.
  if (attention.state === "finished" || task.removedAt)
    return { kind: "clear" };
  if (visibility.kind === "clear") return { kind: "clear" };
  const hold = rowHiddenHold(task);
  const episode = visibility.episodeStartedAt;
  const resumed = prior && prior.episode === episode ? prior : undefined;

  if (hold) {
    // Hold time never accrues toward the implicit episode: the note about a hold
    // is the hold's own, and its clock starts when the row was hidden behind it.
    const record: RowHiddenEpisode = {
      episode,
      since: resumed?.held ? resumed.since : boundedStart(episode, at),
      held: true,
      noticeId: null,
    };
    // A planner's own manual hold owes both the nudge and the planner's answer
    // window to the hold answer cycle (nucleus#1419), reconciled by this same pass.
    if (plannerHoldNeedingAnswer(task))
      return {
        kind: "accruing",
        record: { ...record, noticeId: input.holdNudgeId ?? null },
      };
    const minutes = minutesBetween(hold.since, at);
    if (minutes < ROW_HIDDEN_HOLD_MINUTES || input.reminderReachedPlanner)
      return { kind: "accruing", record };
    const noticeId = rowHiddenHoldNoticeId(task.id, hold.kind, hold.generation);
    return {
      kind: "due",
      record: { ...record, noticeId },
      noticeId,
      minutes,
      failure: visibility.kind === "unknown" ? "unknown" : "missed",
      ...(visibility.kind === "unknown" ? { reason: visibility.reason } : {}),
      hold,
    };
  }

  const record: RowHiddenEpisode = {
    episode,
    since: !resumed
      ? boundedStart(episode, at)
      : resumed.held
        ? new Date(at).toISOString()
        : resumed.since,
    held: false,
    noticeId: null,
  };
  const minutes = minutesBetween(record.since, at);
  if (minutes < ROW_HIDDEN_MINUTES) return { kind: "accruing", record };
  const noticeId = rowHiddenNoticeId(task.id, episode);
  return {
    kind: "due",
    record: { ...record, noticeId },
    noticeId,
    minutes,
    failure: visibility.kind === "unknown" ? "unknown" : "missed",
    ...(visibility.kind === "unknown" ? { reason: visibility.reason } : {}),
    hold: null,
  };
}

/** The task reference and title a notice names. */
const taskLines = (task: Task): string =>
  `Task: ${task.title} (${task.reference ?? task.id})`;

const holdUntilLine = (until: HoldUntil | null): string => {
  if (!until)
    return "Release condition: none recorded; the hold stays until its owner releases it.";
  return until.kind === "time"
    ? `Release condition: the hold lifts at ${until.at}; keep it only if the reason still applies.`
    : `Release condition: the hold lifts when task ${until.taskId} is done.`;
};

const actionLine = (verb: string): string =>
  `Action: ${verb}. This is a plugin notice, not new planning authority.`;

/**
 * The one planner notice for a row hidden past its bound. It names the age, what
 * the task waits on, the last meaningful transition and one supported action, and
 * it says which of the two cases this is: a wait that is genuinely waiting, or
 * evidence that the row should already be visible.
 */
export function rowHiddenNoticeText(input: {
  task: Task;
  attention: TaskAttention;
  plan: Extract<RowHiddenPlan, { kind: "due" }>;
  transition: string;
}): { text: string; kind: "wait" | "missed" | "unknown" | "hold" } {
  const { task, attention, plan, transition } = input;
  const age = `${plan.minutes} minutes`;
  if (plan.hold) {
    return {
      kind: "hold",
      text: [
        "Nucleus: a hold still hides a task row on T3",
        taskLines(task),
        `Held for: ${age} (since ${plan.hold.since})`,
        `Hold kind: ${plan.hold.kind}; generation ${plan.hold.generation}`,
        `Hold reason: ${plan.hold.reason}`,
        holdUntilLine(plan.hold.until),
        `Last transition: ${transition}`,
        "Row: T3 reads the row snoozed while the task waits on this hold, so nothing else surfaces it.",
        ...(plan.answerWindow
          ? [
              `Answer window: release the hold with queue.task action "release", or keep it with "keep_hold" and a fresh reason, within ${HOLD_ANSWER_MINUTES} minutes of this nudge; otherwise the row is shown again and the task needs your answer.`,
            ]
          : [
              actionLine(
                'release the hold with queue.task action "release", or keep it with "keep_hold" and a fresh reason, once its condition no longer applies',
              ),
            ]),
      ].join("\n"),
    };
  }
  const waitReason = "cause" in attention ? attention.cause : task.reason;
  if (plan.failure === "unknown") {
    return {
      kind: "unknown",
      text: [
        "Nucleus: a task row has stayed hidden on T3 and its state cannot be read",
        taskLines(task),
        `Hidden for: ${age} (since ${plan.record.since})`,
        `Recorded wait: ${waitReason || "not recorded"}`,
        `Last transition: ${transition}`,
        `Row: T3 could not answer for this row (${plan.reason ?? "no source answered"}), so Nucleus keeps the recorded snooze as its evidence and does not claim the row is clear.`,
        actionLine(
          `inspect the task's row in T3 and the task with task.next (${task.id}), and use next/stop/route if it should move`,
        ),
      ].join("\n"),
    };
  }
  const visible =
    attention.state === "active" || attention.state === "attention";
  return {
    kind: visible ? "missed" : "wait",
    text: [
      visible
        ? "Nucleus: a task row should be visible on T3 and still reads snoozed"
        : "Nucleus: a task row has stayed snoozed on T3",
      taskLines(task),
      `Hidden for: ${age} (since ${plan.record.since})`,
      `Wait reason: ${waitReason || "not recorded"}`,
      `Last transition: ${transition}`,
      visible
        ? `Row: this task ${attention.state === "active" ? "has a role running" : "needs a person"}, so Nucleus keeps sending the ordinary unsnooze every pass and T3 still shows the row snoozed.`
        : "Row: Nucleus keeps the row snoozed while the task genuinely waits, and renews the snooze horizon until the wait ends.",
      actionLine(
        visible
          ? `inspect the row in T3 and act on the task with task.next (${task.id}): next, stop or route`
          : `inspect the task with task.next (${task.id}) or the board, and use next/stop/route if this wait is a missed transition rather than a real one`,
      ),
    ].join("\n"),
  };
}

/** The last meaningful task transition, as a notice line names it. */
export function rowHiddenTransition(store: Store, task: Task): string {
  const event = store.events(task.id).at(-1);
  return event ? `${event.kind} at ${event.at}` : `phase ${task.phase}`;
}

/**
 * Whether the ordinary attention delivery already reached this task's planner for
 * its current state (nucleus#1417). Only confirmed delivery to that planner
 * coalesces: a pending, intent or uncertain attention notice has not been proved
 * to reach the planner, so the hidden-row notice still surfaces through the
 * ordinary durable delivery fences.
 */
export function attentionDeliveryRecorded(
  store: Store,
  task: Task,
  planner: string | null = rowHiddenRecipient(store, task),
): boolean {
  if (!planner) return false;
  const current = attentionNoticeId(task);
  return store
    .notices(task.id)
    .some(
      (notice: Notice) =>
        notice.kind === "attention" &&
        notice.id === current &&
        notice.status === "delivered" &&
        notice.agentId === planner,
    );
}

/**
 * Spec 040's own hold prompt for a hold generation that already reached this
 * task's planner, when one did. The prompt is due once per generation and reviewed
 * head, so the existing reminder is reused as this generation's nudge rather than
 * repeated, and its delivery is the evidence the answer window counts from.
 */
export function holdReminderNotice(
  store: Store,
  task: Task,
  hold: RowHiddenHold,
  planner: string | null,
): Notice | null {
  if (!planner) return null;
  const prompted = store
    .events(task.id)
    .some(
      (event) =>
        (event.kind === "hold_ready_notified" ||
          event.kind === "hold_reminded") &&
        event.detail.includes(`generation ${hold.generation}`),
    );
  if (!prompted) return null;
  return (
    store
      .notices(task.id)
      .find(
        (notice) =>
          notice.kind === "hold" &&
          notice.status === "delivered" &&
          notice.agentId === planner,
      ) ?? null
  );
}

/**
 * Whether a durable notice carrying a hold nudge reached this task's planner, and
 * the delivery path's own reason when it has not. A pending, intent or uncertain
 * notice has not been proved to reach the planner.
 */
export function holdNoticeDelivery(
  store: Store,
  task: Task,
  noticeId: string,
  planner: string | null,
): { delivered: boolean; error: string } {
  if (!planner)
    return { delivered: false, error: "No planner thread is recorded" };
  const notice = store
    .notices(task.id)
    .find((candidate) => candidate.id === noticeId);
  if (!notice) return { delivered: false, error: "The nudge is not recorded" };
  return {
    delivered: notice.status === "delivered" && notice.agentId === planner,
    error: notice.error,
  };
}

/** What one pass leaves on the fence for the planner's own hold. */
export interface HoldAnswerOutcome {
  /** The record to store on the fence, or null when this pass changes nothing. */
  answer: PlannerHoldAnswer | null;
  /** The nudge is due for the first time: its durable notice has to be created. */
  raise: boolean;
  /** The answer window closed with the hold still in place. */
  escalation: { fault: "planner" | "delivery"; detail: string } | null;
}

/**
 * The planner's own hold answer cycle (nucleus#1419), from facts this pass already
 * read. A generation first owes its nudge once the row has been hidden behind it
 * for the hold bound; the nudge is the notice Spec 040 already delivered when
 * there is one, else this pass raises it. From the later of the due time and a
 * confirmed delivery, the planner has the answer window to release the hold or
 * keep it into a fresh generation. The window closing with the hold still in place
 * is the escalation: the hold is untouched and the row stays visible.
 *
 * Reads, sweeps and unchanged state are not an answer: only a released hold or a
 * new generation answers, so nothing here changes a hold, a phase or a run.
 */
export function holdAnswerPlan(input: {
  /** The notice this generation's nudge would carry when nothing else does. */
  ownNoticeId: string;
  /** Start of this generation: the fence's own placement or its first keep. */
  since: string;
  prior: PlannerHoldAnswer | null;
  /** Whether the row is still hidden behind this hold. */
  hidden: boolean;
  /** Spec 040's prompt for this generation, already delivered to this planner. */
  reminder: Notice | null;
  /** Delivery of the notice this generation's record names. */
  delivery: { delivered: boolean; error: string };
  at: number;
}): HoldAnswerOutcome {
  const { prior, hidden, reminder, delivery, at } = input;
  const now = new Date(at).toISOString();
  if (prior?.unansweredAt)
    return { answer: null, raise: false, escalation: null };
  const dueMs = Date.parse(input.since) + ROW_HIDDEN_HOLD_MINUTES * 60_000;
  const dueAt = new Date(dueMs).toISOString();
  if (!prior) {
    // Nothing is owed until the row has hidden behind this generation, and a
    // planner nudge that never hid anything is not the row's news.
    if (!hidden || at < dueMs)
      return { answer: null, raise: false, escalation: null };
    return {
      answer: {
        since: input.since,
        dueAt,
        noticeId: reminder?.id ?? input.ownNoticeId,
        // A reminder Spec 040 already delivered is the nudge; this pass is the
        // first pass that can prove the planner has it.
        deliveredAt: reminder ? now : null,
        unansweredAt: null,
        deliveryFault: "",
      },
      raise: !reminder,
      escalation: null,
    };
  }
  const deliveredAt = prior.deliveredAt ?? (delivery.delivered ? now : null);
  const windowStart = deliveredAt
    ? Math.max(Date.parse(deliveredAt), Date.parse(prior.dueAt))
    : Date.parse(prior.dueAt);
  if (at < windowStart + HOLD_ANSWER_MINUTES * 60_000)
    return {
      answer:
        deliveredAt !== prior.deliveredAt ? { ...prior, deliveredAt } : null,
      raise: false,
      escalation: null,
    };
  return {
    answer: {
      ...prior,
      deliveredAt,
      unansweredAt: now,
      deliveryFault: deliveredAt ? "" : delivery.error,
    },
    raise: false,
    escalation: deliveredAt
      ? {
          fault: "planner",
          detail: `the planner did not release or keep the hold within ${HOLD_ANSWER_MINUTES} minutes of the nudge delivered at ${deliveredAt}`,
        }
      : {
          fault: "delivery",
          detail: `the nudge due at ${prior.dueAt} was not delivered${delivery.error ? `: ${delivery.error}` : ""}`,
        },
  };
}

/** The planner a hidden row's notice reaches: the ordinary attention route. */
export function rowHiddenRecipient(store: Store, task: Task): string | null {
  return originRecipient(store, task) ?? taskOwner(task) ?? null;
}

/**
 * The tasks one host's hidden-row pass visits: every task it still keeps a record
 * for. A finished task is visited too, because the terminal lane is the fact that
 * ends its episode — its record and any pending notice are cleared there.
 */
export function rowHiddenTasks(store: Store, hostId: string): Task[] {
  return store
    .tasks()
    .filter((task) => task.hostId === hostId && task.removedAt == null);
}

/** The ports one host pass gives the hidden-row reconciliation. */
export interface HiddenRowsContext {
  store: Store;
  adapter: Pick<Adapter, "rowSnoozeVisibility">;
}

/**
 * The hidden-row pass (nucleus#1417): one reading per open task of one host, from
 * the row visibility that host owns and the shared attention projection. It is
 * the only writer of the durable episode record and of the episode's notice; the
 * notice's own delivery is the ordinary durable notice path's job, so an
 * undelivered notice stays visible and a failed presentation pass never suppresses
 * it.
 */
export class HiddenRows {
  constructor(private readonly context: HiddenRowsContext) {}
  private get store() {
    return this.context.store;
  }

  /** Reconcile every open task of one host. A task that cannot be read keeps its recorded episode. */
  async observe(hostId: string): Promise<void> {
    const visibility = this.context.adapter.rowSnoozeVisibility;
    if (!visibility) return;
    for (const task of rowHiddenTasks(this.store, hostId)) {
      let read: RowSnoozeVisibility;
      try {
        read = await visibility.call(this.context.adapter, task.id);
      } catch (error) {
        // A host that cannot answer owns that answer; anything else keeps the
        // recorded episode as evidence and is retried on the next pass.
        if (isHostOperationTimeout(error)) throw error;
        continue;
      }
      this.reconcile(task, read);
    }
  }

  /** One task's hidden-row fact from the row visibility its host just reported. */
  reconcile(task: Task, visibility: RowSnoozeVisibility): void {
    const key = rowHiddenKey(task.id);
    const prior = this.store.getMeta<RowHiddenEpisode>(key);
    const attention = taskRowAttention(this.store, task);
    const hold = rowHiddenHold(task);
    const planner = rowHiddenRecipient(this.store, task);
    // The planner's own hold owes a nudge and then an answer (nucleus#1419). This
    // runs first, so a nudge it raises is the same notice the episode records and
    // an escalation is in place before this pass's rows reconcile.
    const answer = this.reconcileHoldAnswer(task, visibility, planner);
    const plan = rowHiddenPlan({
      task,
      attention,
      visibility,
      prior,
      at: Date.now(),
      holdNudgeId: answer?.noticeId ?? null,
      reminderReachedPlanner: hold
        ? Boolean(holdReminderNotice(this.store, task, hold, planner))
        : false,
    });
    if (plan.kind === "clear") {
      this.clear(task);
      return;
    }
    this.supersedeStale(task, plan.record.noticeId);
    if (plan.kind === "accruing") {
      this.record(key, plan.record);
      return;
    }
    // The ordinary attention delivery already reached this planner for this
    // state: the hidden row is recorded as evidence, never as a second message.
    if (!plan.hold && attentionDeliveryRecorded(this.store, task, planner)) {
      this.supersedeStale(task, null);
      this.eventOnce(
        task,
        plan.noticeId,
        "row_hidden_visibility_failure",
        `${plan.noticeId}: ${plan.minutes} minutes hidden behind a Nucleus snooze while ${attention.state} was due; the ordinary notice already reached the planner`,
      );
      this.record(key, { ...plan.record, noticeId: null });
      return;
    }
    const existing = this.store
      .notices(task.id)
      .find((notice) => notice.id === plan.noticeId);
    if (!existing || existing.status === "superseded") {
      const { text, kind } = rowHiddenNoticeText({
        task,
        attention,
        plan,
        transition: rowHiddenTransition(this.store, task),
      });
      this.store.putNotice({
        id: plan.noticeId,
        taskId: task.id,
        agentId: planner ?? taskOwner(task),
        recipientAgentId: "",
        workspaceId: null,
        sources: [],
        originEntry: true,
        kind: "row_hidden",
        status: "pending",
        error: "",
        text,
      });
      this.store.event(
        task.id,
        "row_hidden_notified",
        `${plan.noticeId}: ${kind}; ${plan.minutes} minutes hidden\n${text}`.slice(
          0,
          4000,
        ),
      );
    }
    this.record(key, plan.record);
  }

  /**
   * The planner's own hold's nudge and answer window for this pass
   * (nucleus#1419). It reads the row's visibility and the durable notice evidence,
   * writes the answer record on the hold's own fence (a new generation clears it)
   * and records one event when the window closes. Nothing here touches the hold's
   * reason, owner, condition or generation: only the planner's own `hold` or
   * `keep_hold` answers it.
   */
  private reconcileHoldAnswer(
    task: Task,
    visibility: RowSnoozeVisibility,
    planner: string | null,
  ): PlannerHoldAnswer | null {
    const subject = plannerHoldNeedingAnswer(task);
    if (!subject) return null;
    const { kind, fence } = subject;
    const hold: RowHiddenHold = {
      kind,
      generation: fence.generation,
      since: fence.at,
      reason: fence.reason,
      until: fence.until ?? null,
    };
    const prior = fence.plannerAnswer ?? null;
    const reminder = holdReminderNotice(this.store, task, hold, planner);
    const ownNoticeId = rowHiddenHoldNoticeId(task.id, kind, fence.generation);
    const outcome = holdAnswerPlan({
      ownNoticeId,
      since: prior?.since ?? fence.at,
      prior,
      hidden: visibility.kind !== "clear",
      reminder,
      delivery: holdNoticeDelivery(
        this.store,
        task,
        prior?.noticeId ?? reminder?.id ?? ownNoticeId,
        planner,
      ),
      at: Date.now(),
    });
    if (outcome.raise) {
      const attention = taskRowAttention(this.store, task);
      const { text } = rowHiddenNoticeText({
        task,
        attention,
        plan: {
          kind: "due",
          record: {
            episode:
              visibility.kind === "clear"
                ? fence.at
                : visibility.episodeStartedAt,
            since: fence.at,
            held: true,
            noticeId: ownNoticeId,
          },
          noticeId: ownNoticeId,
          answerWindow: true,
          minutes: Math.max(
            0,
            Math.floor((Date.now() - Date.parse(fence.at)) / 60_000),
          ),
          failure: visibility.kind === "unknown" ? "unknown" : "missed",
          ...(visibility.kind === "unknown"
            ? { reason: visibility.reason }
            : {}),
          hold,
        },
        transition: rowHiddenTransition(this.store, task),
      });
      if (
        !this.store.notices(task.id).some((notice) => notice.id === ownNoticeId)
      ) {
        this.store.putNotice({
          id: ownNoticeId,
          taskId: task.id,
          agentId: planner ?? taskOwner(task),
          recipientAgentId: "",
          workspaceId: null,
          sources: [],
          originEntry: true,
          kind: "row_hidden",
          status: "pending",
          error: "",
          text,
        });
        this.store.event(
          task.id,
          "row_hidden_notified",
          `${ownNoticeId}: hold; ${hold.generation} generation\n${text}`.slice(
            0,
            4000,
          ),
        );
      }
    }
    if (outcome.escalation)
      this.eventOnce(
        task,
        `${kind}-${fence.generation}`,
        outcome.escalation.fault === "delivery"
          ? "row_hidden_hold_undelivered"
          : "row_hidden_hold_unanswered",
        `hold generation ${fence.generation} (${kind}): ${outcome.escalation.detail}; the row is shown again until the planner releases or keeps this generation`,
      );
    if (outcome.answer) {
      const latest = this.store.task(task.id);
      const holds: TaskHolds = { ...(latest.holds ?? {}) };
      const current = holds[kind];
      if (current && current.generation === fence.generation)
        this.store.update(
          task.id,
          syncHoldProjection({
            ...holds,
            [kind]: { ...current, plannerAnswer: outcome.answer },
          }),
        );
    }
    return outcome.answer ?? prior;
  }

  /** The row is shown, finished or no longer ours: no episode and no owed notice. */
  clear(task: Task): void {
    this.supersedeStale(task, null);
    const key = rowHiddenKey(task.id);
    if (this.store.getMeta(key) !== undefined) this.store.deleteMeta(key);
  }

  /** Supersede pending notices this task's row no longer owes. */
  private supersedeStale(task: Task, liveNoticeId: string | null): void {
    for (const notice of this.store.notices(task.id)) {
      if (notice.kind !== "row_hidden" || notice.status !== "pending") continue;
      if (notice.id === liveNoticeId) continue;
      this.store.putNotice({
        ...notice,
        status: "superseded",
        error: "The row is no longer hidden for this episode",
      });
    }
  }

  private record(key: string, episode: RowHiddenEpisode): void {
    const current = this.store.getMeta<RowHiddenEpisode>(key);
    if (
      current &&
      current.episode === episode.episode &&
      current.since === episode.since &&
      current.held === episode.held &&
      current.noticeId === episode.noticeId
    )
      return;
    this.store.setMeta(key, episode);
  }

  /** One evidence line per episode: a repeated pass records nothing new. */
  private eventOnce(
    task: Task,
    key: string,
    kind: string,
    detail: string,
  ): void {
    if (
      this.store
        .events(task.id)
        .some(
          (event) => event.kind === kind && event.detail.startsWith(`${key}:`),
        )
    )
      return;
    this.store.event(task.id, kind, detail.slice(0, 4000));
  }
}
