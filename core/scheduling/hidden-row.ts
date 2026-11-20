import type { Notice, Task } from "../../shared/contracts";
import { blockingHoldFence, taskOwner } from "../../shared/contracts";
import type { HoldKind, HoldUntil } from "../../shared/contracts";
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
        actionLine(
          'release the hold with queue.task action "release", or keep it with "keep_hold" and a fresh reason, once its condition no longer applies',
        ),
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
 * Whether Spec 040's own hold reminder already reached this task's planner for
 * this hold generation. The prompt is due once per generation and reviewed head,
 * so the existing reminder is reused rather than repeated as a hidden-row nudge.
 */
export function holdReminderReachedPlanner(
  store: Store,
  task: Task,
  hold: RowHiddenHold,
  planner: string | null,
): boolean {
  if (!planner) return false;
  const prompted = store
    .events(task.id)
    .some(
      (event) =>
        (event.kind === "hold_ready_notified" ||
          event.kind === "hold_reminded") &&
        event.detail.includes(`generation ${hold.generation}`),
    );
  if (!prompted) return false;
  return store
    .notices(task.id)
    .some(
      (notice) =>
        notice.kind === "hold" &&
        notice.status === "delivered" &&
        notice.agentId === planner,
    );
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
    const plan = rowHiddenPlan({
      task,
      attention,
      visibility,
      prior,
      at: Date.now(),
      reminderReachedPlanner: hold
        ? holdReminderReachedPlanner(this.store, task, hold, planner)
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
