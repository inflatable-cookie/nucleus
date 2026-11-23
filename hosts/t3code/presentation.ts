import { isHostOperationTimeout } from "../../core/host";
import type { RowSnoozeVisibility } from "../../core/host";
import { formatTaskNumber } from "../../shared/contracts";
import { capT3Title } from "./titles";
import { WIRE_LABEL_KEYS } from "../../shared/wire-labels";
import {
  HostUnknownDeliveryError,
  ProvenPreSendRefusalError,
} from "../../core/host";
import type { Task } from "../../shared/contracts";
import type { TaskAttention } from "../../shared/task-attention";
import type { T3State, T3StateFile } from "./state";
import { canonical } from "./state";
import type { T3Reads, Projection } from "./reads";
import { activeStatuses } from "./reads";
import {
  identity,
  intentKindOf,
  intentThreadId,
  isIntent,
  presentationThread,
} from "./intents";
import type { T3IntentLedger } from "./intents";
import {
  isSupportRole,
  labelRole,
  labelTask,
  needsInputStep,
  rowStep,
  rowTitle,
} from "./one-row";

/** A settled or refused command never runs again, so its identity is spent. */
const settledOrRefused = (intent: T3State["intents"][string]) =>
  Boolean(intent) &&
  (intent.status === "refused" || intent.status === "settled");
/** The nightly's newest run: its ordinal when reported, the list order otherwise. */
const latestRun = (projection: Projection) =>
  projection.runs.reduce(
    (best: Projection["runs"][number] | undefined, run) =>
      !best || (run.ordinal ?? -1) >= (best.ordinal ?? -1) ? run : best,
    undefined,
  );

/**
 * When one continuous implicit snooze episode began (nucleus#1417). A record
 * written before the field existed proves its own start: the horizon it read back
 * is exactly one horizon after the send that wrote it.
 */
export function snoozeEpisodeStart(
  record: NonNullable<T3State["snoozes"]>[string],
): string {
  if (record.episodeStartedAt) return record.episodeStartedAt;
  const until = Date.parse(record.until);
  return Number.isFinite(until)
    ? new Date(until - SNOOZE_HORIZON_MS).toISOString()
    : record.recordedAt;
}

/**
 * What one task row's visibility is now, as this host's durable snooze ownership
 * and a fresh native read prove it (nucleus#1417). The hidden-row notice reads
 * this instead of guessing from the task: only a row this host snoozed is
 * Nucleus-owned, and an unreadable row is unknown rather than clear.
 */
export type { RowSnoozeVisibility };

/**
 * How long one snooze horizon lasts (nucleus#1366). Nucleus waits are open-ended,
 * so the row is snoozed for a bounded horizon and the ordinary sweep renews it
 * before it lapses: the row never wakes itself while the task still waits.
 */
export const SNOOZE_HORIZON_MS = 48 * 60 * 60_000;
/** The sweep renews once less than this remains, leaving a day of slack for a paused queue. */
export const SNOOZE_RENEW_BEFORE_MS = 24 * 60 * 60_000;

/**
 * How many times the delivery gate reads a thread back after its unsettle, and the
 * gap between reads, before a message waits for the next pass (T3 may apply it late).
 */
export const UNSETTLE_READ_ATTEMPTS = 4;
export const UNSETTLE_READ_GAP_MS = 250;

/**
 * One task's row: the parent thread this host's own record still binds to the task
 * (nucleus#1445). Presentation never addresses a row from a task id alone, so a
 * stale or foreign binding can never reach a planner, the inbox or another task.
 */
type TaskRow = {
  threadId: string;
  parent: NonNullable<T3State["parents"]>[string];
};

/** One task row's recorded snooze: the occurrence this host wrote and read back. */
type SnoozeRecord = NonNullable<T3State["snoozes"]>[string];

/** The collaborators a presentation write needs: durable state, the ledger and the reads. */
export interface T3PresentationContext {
  state: T3StateFile;
  hostId(): string;
  requireConnection(): void;
  reads: T3Reads;
  intents: T3IntentLedger;
  /**
   * The task's parent thread when this host nests it: the parent is the task's one
   * operator-visible row, so titles and the row's shown/snoozed state belong to it
   * (nucleus#1305). A task with no parent record has no row on this host.
   */
  parentThreadOf?(taskId: string): string | undefined;
}

/**
 * What the T3 board shows: the task's one row — its title and whether the row is
 * shown or snoozed — and never a settled thread.
 *
 * Every write here is a presentation command recorded in the ledger before it is
 * sent, so an unknown delivery is never resent and a deletion retires the work it
 * would have shown. The row's state comes from the one attention projection the
 * board and `task.next` read; nothing here decides whether a task is done, and
 * Nucleus never issues `thread.settle` for a task thread (Tom, 2026-11-19).
 */
export class T3Presentation {
  /**
   * The attention state each task's row last reconciled to (nucleus#1437). The title
   * written between passes reads the same ownership of a role's fault as the row does.
   */
  private readonly rowAttention = new Map<string, TaskAttention["state"]>();
  constructor(private readonly core: T3PresentationContext) {}

  retireDeletedPresentationIntents(observedId?: string): void {
    const snapshot = this.core.state.read();
    const observeKey = observedId ? identity("delete", observedId) : undefined;
    const observedIntent = observeKey
      ? snapshot.intents[observeKey]
      : undefined;
    let observeDelete = false;
    if (
      observedIntent?.status === "unknown" &&
      !observedIntent.deletionObservedAt &&
      observedId
    ) {
      observeDelete =
        isIntent("thread.delete", observedIntent) &&
        intentThreadId(observedIntent) === observedId;
    }
    // `apply` is false for the pre-write scan: the state this adapter reads is the
    // service's live record, so a scan must never mutate it. Nothing awaits between
    // the scan and the write, so the planned retirements are the ones applied.
    const retire = (state: T3State, apply: boolean): boolean => {
      let changed = false;
      for (const [key, intent] of Object.entries(state.intents)) {
        if (intent.status !== "unknown") continue;
        const id = presentationThread(intent);
        const deletion = id
          ? this.core.intents.confirmedDeletion(state, id)
          : undefined;
        if (!deletion) continue;
        if (apply)
          state.intents[key] = {
            ...intent,
            status: "moot",
            retiredByDeletion: deletion,
          };
        changed = true;
      }
      // A row this host snoozed on a thread T3 confirmed removing keeps no
      // scheduled wake: the thread is gone, and the record only names a command.
      for (const threadId of Object.keys(state.snoozes ?? {})) {
        if (!this.core.intents.confirmedDeletion(state, threadId)) continue;
        if (apply) delete state.snoozes![threadId];
        changed = true;
      }
      // A retired thread the host confirmed removing keeps its launch identity and
      // records the removal: the identity is what keeps a removed thread out of
      // observation once its live record is gone, and it costs one short record.
      for (const [agentId, retired] of Object.entries(
        state.retiredAgents ?? {},
      )) {
        if (
          retired.deletedAt ||
          !this.core.intents.confirmedDeletion(state, agentId)
        )
          continue;
        if (apply)
          state.retiredAgents![agentId] = {
            ...retired,
            deletedAt: new Date().toISOString(),
          };
        changed = true;
      }
      return changed;
    };
    if (!observeDelete && !retire(snapshot, false)) return;
    this.core.state.update((state) => {
      if (
        observeDelete &&
        state.intents[observeKey!]?.payload === observedIntent!.payload &&
        state.intents[observeKey!].status === "unknown"
      )
        state.intents[observeKey!].deletionObservedAt ??=
          new Date().toISOString();
      retire(state, true);
    });
  }

  /**
   * The step the task's role threads are doing right now, from their own native
   * projections: a pending question or permission wins, then a thread whose latest
   * run ended with a fault, then a live role. Only the thread each role currently
   * uses counts: a superseded reviewer or recovery thread's last failed run is
   * history, never the task's attention. Empty when nothing of the task is running.
   */
  async rowStepFor(taskId: string, faultsOwned = false): Promise<string> {
    const state = this.core.state.read();
    const support = Object.entries(state.agents).filter(
      ([id, agent]) =>
        labelTask(agent.labels) === taskId &&
        isSupportRole(labelRole(agent.labels)) &&
        !this.core.intents.confirmedDeletion(state, id),
    );
    if (!support.length) return "";
    const observed: Array<{
      role: string;
      pending: boolean;
      live: boolean;
      faulted: boolean;
    }> = [];
    for (const { id, role } of this.currentSupportThreads(taskId, support)) {
      try {
        // A support thread that has left observation names no step: its role is no
        // longer running on this host, and reading it would cost a full snapshot
        // (nucleus#1328).
        if (!(await this.core.reads.isObserved(id))) continue;
        const projection = await this.core.reads.readProjection(
          id,
          "observation",
        );
        if (projection.thread.deletedAt) continue;
        const latest = latestRun(projection);
        observed.push({
          role,
          pending: projection.runtimeRequests.some(
            (request) => request.status === "pending",
          ),
          live: Boolean(latest) && activeStatuses.has(latest!.status),
          faulted:
            Boolean(latest) &&
            ["failed", "interrupted"].includes(latest!.status),
        });
      } catch (error) {
        if (isHostOperationTimeout(error)) throw error;
        /* an unreadable support thread names no step */
      }
    }
    return rowStep(observed, faultsOwned);
  }

  /**
   * One thread per role: the thread this adapter last created for that task and
   * role. A role with no recorded replacement keeps every thread it has, so state
   * written before the marker existed still names its live step.
   */
  private currentSupportThreads(
    taskId: string,
    support: ReadonlyArray<[string, T3State["agents"][string]]>,
  ): Array<{ id: string; role: string }> {
    const current = this.core.state.read().supportCurrent ?? {};
    const byRole = new Map<string, Array<{ id: string; role: string }>>();
    for (const [id, agent] of support) {
      const role = labelRole(agent.labels)!;
      byRole.set(role, [...(byRole.get(role) ?? []), { id, role }]);
    }
    const chosen: Array<{ id: string; role: string }> = [];
    for (const [role, threads] of byRole) {
      const marker = current[`${taskId}:${role}`];
      chosen.push(
        ...(marker && threads.some((thread) => thread.id === marker)
          ? threads.filter((thread) => thread.id === marker)
          : threads),
      );
    }
    return chosen;
  }

  /**
   * Record which thread a task's role now uses, so a displaced thread's last run
   * is history rather than the task's attention.
   */
  noteRoleThread(taskId: string, role: string, threadId: string): void {
    const key = `${taskId}:${role}`;
    if (this.core.state.read().supportCurrent?.[key] === threadId) return;
    this.core.state.update((state) => {
      state.supportCurrent = { ...state.supportCurrent, [key]: threadId };
    });
  }

  /**
   * The task's one row, from the one attention projection (nucleus#1366) and the
   * step its role threads report. A person who must act — the projection's own
   * attention, or a role asking a question or ending with a fault — gets the row
   * shown; a task that waits on nothing Nucleus runs and needs no one gets it
   * snoozed; a running role leaves it shown. A row an operator settled by hand is
   * theirs and is left exactly as it is here; a message or re-entry for it still goes
   * through `wakeBeforeDelivery`, which unsettles it first.
   *
   * The title rides the same pass: the task's own state title plus the step, so a
   * role that starts, needs input or stalls shows without a task title change.
   */
  async reconcileTaskRow(
    taskId: string,
    attention: TaskAttention,
  ): Promise<void> {
    const row = this.rowOf(taskId);
    // A confirmed deletion retires the presentation work it would have shown, even
    // when the task is already finished.
    this.retireDeletedPresentationIntents();
    if (!row) return;
    const { threadId } = row;
    if (attention.state === "finished") {
      this.rowAttention.delete(taskId);
      this.forgetSnooze(threadId);
      return;
    }
    this.core.requireConnection();
    this.rowAttention.set(taskId, attention.state);
    // A role's fault names the row only while the task's own attention owns it. A
    // role that failed earlier, under a wait or a settled incident, is history
    // (nucleus#1437), so the row reads the wait and the fault does not hold it.
    const step = await this.rowStepFor(taskId, attention.state === "attention");
    const base = this.core.state.read().parents?.[taskId]?.title;
    if (base) {
      const desired = capT3Title(rowTitle(base, step));
      if (this.core.state.read().rowTitles?.[threadId] !== desired) {
        try {
          await this.writeWorkerRow(threadId, desired);
        } catch (error) {
          if (isHostOperationTimeout(error)) throw error;
          /* the step keeps for the next pass */
        }
      }
    }
    // The projection's own attention is the person who must act; a role waiting on a
    // current question or permission is one too (nucleus#1437).
    if (attention.state === "attention" || needsInputStep(step)) {
      await this.unsnoozeRow(taskId, row);
      return;
    }
    if (attention.state === "active") {
      await this.unsnoozeRow(taskId, row);
      return;
    }
    await this.snoozeRow(taskId, row, attention.cause ?? "Waiting");
  }

  /**
   * The task's row, only while this host's own record still binds that thread to
   * this task (nucleus#1445). A task with no parent record (the provider was
   * missing or not ready, so the parent was never launched) has no row, and its
   * wait is the task's visible reason. The inbox and another task's parent thread
   * are never this task's row, however a legacy record names them.
   */
  private rowOf(taskId: string): TaskRow | null {
    const state = this.core.state.read();
    const parent = state.parents?.[taskId];
    const threadId = this.core.parentThreadOf?.(taskId);
    if (
      !parent ||
      parent.taskId !== taskId ||
      !parent.threadId ||
      parent.threadId !== threadId
    )
      return null;
    if (!this.rowIsExclusive(threadId)) return null;
    return { threadId, parent };
  }

  /**
   * The task whose row this thread is, when exactly one recorded parent binding
   * names it. The inbox is nobody's row, and two claims are ambiguous, so neither
   * is ever addressed as a task row.
   */
  private rowTaskOf(threadId: string): string | undefined {
    const owners = this.rowOwners(threadId);
    return owners.length === 1 ? owners[0] : undefined;
  }

  private rowIsExclusive(threadId: string): boolean {
    return this.rowOwners(threadId).length === 1;
  }

  /** The task ids whose recorded parent binding still names this exact thread. */
  private rowOwners(threadId: string): string[] {
    const state = this.core.state.read();
    if (!threadId || state.inbox?.threadId === threadId) return [];
    return Object.entries(state.parents ?? {})
      .filter(
        ([taskId, row]) => row.taskId === taskId && row.threadId === threadId,
      )
      .map(([taskId]) => taskId);
  }

  /**
   * Whether a recorded snooze is the occurrence the row shows now (Tom's ruling,
   * 2026-11-20; nucleus#1445). Ownership is the exact horizon this host asked for
   * and read back, bound to this task: a changed horizon, a cleared row and a
   * record another task's row wrote all belong to someone else and are never
   * renewed or cleared here. A record written before the binding was stored proves
   * itself only by that exact horizon, never by its shape alone.
   */
  private ownsSnooze(
    record: SnoozeRecord | undefined,
    taskId: string,
    snoozedUntil: string | null | undefined,
  ): boolean {
    if (!record || record.state === "refused" || !snoozedUntil) return false;
    if (record.until !== snoozedUntil) return false;
    return record.taskId === undefined || record.taskId === taskId;
  }

  /**
   * The task row's visibility right now (nucleus#1417): this host's own durable
   * snooze record says whether the row is Nucleus-owned, and a fresh read of the
   * thread proves T3 still shows it snoozed. A row this host never snoozed, a row
   * an operator settled or snoozed, and a row whose horizon already lapsed are all
   * clear. A row T3 cannot be read for is unknown, never clear: the recorded snooze
   * is then the only evidence and it is kept as it is.
   */
  async rowSnoozeVisibility(taskId: string): Promise<RowSnoozeVisibility> {
    const row = this.rowOf(taskId);
    if (!row) return { kind: "clear" };
    const { threadId } = row;
    const record = this.core.state.read().snoozes?.[threadId];
    // A refused snooze never hid the row, and a record this host forgot no longer
    // owns one.
    if (!record || record.state === "refused") return { kind: "clear" };
    if (record.taskId !== undefined && record.taskId !== taskId)
      return { kind: "clear" };
    const episodeStartedAt = snoozeEpisodeStart(record);
    const cause = record.cause ?? "";
    if (this.core.intents.confirmedDeletion(this.core.state.read(), threadId))
      return { kind: "clear" };
    let projection: Projection;
    try {
      this.core.requireConnection();
      if (!(await this.core.reads.isObserved(threadId)))
        return { kind: "clear" };
      projection = await this.core.reads.readProjection(
        threadId,
        "observation",
      );
    } catch (error) {
      if (isHostOperationTimeout(error)) throw error;
      return {
        kind: "unknown",
        threadId,
        episodeStartedAt,
        cause,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (projection.thread.deletedAt || projection.thread.archivedAt)
      return { kind: "clear" };
    const wakeAt = projection.thread.snoozedUntil
      ? Date.parse(projection.thread.snoozedUntil)
      : Number.NaN;
    if (!Number.isFinite(wakeAt) || wakeAt <= Date.now())
      return { kind: "clear" };
    // Only the occurrence this host wrote is Nucleus-owned (nucleus#1445): a
    // changed horizon is the operator's snooze, not a hidden Nucleus row.
    if (!this.ownsSnooze(record, taskId, projection.thread.snoozedUntil))
      return { kind: "clear" };
    return { kind: "snoozed", threadId, episodeStartedAt, cause };
  }

  /**
   * Send one row title. A title the row already sent once gets a fresh command
   * identity when it comes back: round two's `· reviewing` is the same string as
   * round one's, a sent command never runs again, and the fresh projection read
   * above is the row's proof it still needs sending. An unknown delivery keeps its
   * identity and is reconciled by that same read, never repeated blindly.
   */
  private async writeWorkerRow(threadId: string, title: string): Promise<void> {
    if (this.core.intents.confirmedDeletion(this.core.state.read(), threadId))
      return;
    if (!(await this.core.reads.isObserved(threadId))) return;
    const projection = await this.core.reads.readProjection(
      threadId,
      "observation",
    );
    if (projection.thread.archivedAt || projection.thread.deletedAt) return;
    const record = () =>
      this.core.state.update((current) => {
        current.rowTitles = { ...current.rowTitles, [threadId]: title };
      });
    if (projection.thread.title === title) {
      record();
      return;
    }
    const key = this.commandIdFor(
      "row-title",
      [this.core.hostId(), threadId, title],
      settledOrRefused,
    );
    await this.rowTitleEffect(key, {
      type: "thread.metadata.update",
      commandId: key,
      threadId,
      title,
    });
    record();
  }

  /**
   * One row-title send. A pre-send refusal names the row title, not a reviewer
   * continuation: this command is presentation of the task's row (nucleus#1366).
   */
  private async rowTitleEffect(
    key: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.core.intents.effect(
        key,
        "orchestration.dispatchCommand",
        payload,
        undefined,
        undefined,
        { resendUnknownAfterRead: true },
      );
    } catch (error) {
      if (error instanceof ProvenPreSendRefusalError)
        throw new ProvenPreSendRefusalError(error.reason, "Row title");
      throw error;
    }
  }

  numberedThreadTitle(
    taskNumber: number | null | undefined,
    role: string | undefined,
    title: string,
  ): string {
    if (!taskNumber) return title;
    const runRole = role && role !== "worker" ? role : undefined;
    const titleRole = runRole === "reviewer" ? "review" : runRole;
    const numberedPrefix = `${formatTaskNumber(taskNumber)}${titleRole ? ` ${titleRole}` : ""}: `;
    let taskTitle = title;
    while (taskTitle.startsWith(numberedPrefix))
      taskTitle = taskTitle.slice(numberedPrefix.length);
    const legacyRolePrefix = runRole ? `${runRole}: ` : "";
    if (legacyRolePrefix && taskTitle.startsWith(legacyRolePrefix))
      taskTitle = taskTitle.slice(legacyRolePrefix.length);
    return capT3Title(`${numberedPrefix}${taskTitle}`);
  }

  async setTaskWorkspaceTitle(
    task: Task,
    title: string,
    requestId: string,
    _uncertain: boolean,
  ): Promise<void> {
    this.retireDeletedPresentationIntents();
    title = capT3Title(title);
    const threadId = this.core.parentThreadOf?.(task.id);
    if (!threadId) throw Error("Task worker thread is missing");
    const state = this.core.state.read();
    if (this.core.intents.confirmedDeletion(state, threadId)) return;
    // A row that left observation keeps the title it has: nothing is sent to a
    // thread whose task is over or that T3 reports archived (nucleus#1328).
    if (!(await this.core.reads.isObserved(threadId))) return;
    // The task's own state title is the row's base; the step its role threads are
    // doing rides after it, so the one visible row names both (one row per task,
    // Tom 2026-11-15).
    const step = await this.rowStepFor(
      task.id,
      this.rowAttention.get(task.id) === "attention",
    );
    const desired = capT3Title(rowTitle(title, step));
    let projection: Projection;
    try {
      projection = await this.core.reads.readProjection(
        threadId,
        "observation",
      );
    } catch (error) {
      // A thread that left observation proves nothing: the recorded intent stays
      // exactly as recorded, and nothing is sent to a row nothing can read
      // (nucleus#1328).
      if (isHostOperationTimeout(error)) throw error;
      return;
    }
    // A title legitimately changes, so the desired title is part of the command
    // identity: reusing one key for a new title would be refused as a changed
    // payload under a spent command (nucleus#1366 live on nucleus#1363).
    const key = identity(
      "thread-title",
      canonical({ threadId, requestId, title: desired }),
    );
    const recordBase = () =>
      this.core.state.update((current) => {
        if (current.parents?.[task.id]) current.parents[task.id].title = title;
        current.rowTitles = { ...current.rowTitles, [threadId]: desired };
      });
    if (
      !projection.thread.archivedAt &&
      !projection.thread.deletedAt &&
      projection.thread.title === desired
    ) {
      this.core.state.update((current) => {
        const prior = current.intents[key];
        if (prior?.status === "unknown")
          current.intents[key] = {
            ...prior,
            status: "settled",
            result: { title: desired },
          };
      });
      recordBase();
    } else if (!projection.thread.archivedAt && !projection.thread.deletedAt) {
      await this.rowTitleEffect(key, {
        type: "thread.metadata.update",
        commandId: key,
        threadId,
        title: desired,
      });
      recordBase();
    }
  }

  /**
   * The one delivery gate for a message, decision, re-entry or follow-up (Tom,
   * 2026-11-19: "I explicitly want nucleus to unsettle threads like that"). It
   * freshly observes the target. A thread the operator settled is unsettled first,
   * by a recorded `thread.unsettle` under the message's own identity, and read back
   * until T3 shows it active; only then does the caller send. Nucleus never issues
   * `thread.settle`. An archived or removed thread is fenced and never unsettled.
   *
   * Resolves once the thread is active. Otherwise it throws a proven pre-send refusal:
   * nothing was sent, so the message stays queued. An unknown unsettle is reconciled
   * by a fresh read before anything repeats, and never resent blindly.
   *
   * A thread the operator snoozed is never woken by a Nucleus message (Tom's ruling,
   * 2026-11-20; nucleus#1445): T3 clears `snoozedUntil` on an ordinary delivery, so
   * the send is refused before it leaves and the durable notice waits for that
   * thread to wake. The one snooze this gate delivers over is a task row this host
   * snoozed itself, proven by the exact horizon the read shows.
   */
  async wakeBeforeDelivery(id: string, messageId: string): Promise<void> {
    if (this.core.intents.confirmedDeletion(this.core.state.read(), id))
      throw new ProvenPreSendRefusalError(
        "T3Code thread deletion is confirmed; nothing was sent",
      );
    const observed = await this.observeFresh(id);
    if (observed.thread.archivedAt || observed.thread.deletedAt)
      throw new ProvenPreSendRefusalError(
        "T3Code thread is archived or removed; nothing was sent",
      );
    if (observed.thread.settledOverride !== "settled") {
      this.refuseManuallySnoozed(id, observed);
      return;
    }

    const key = identity("unsettle", canonical([id, messageId]));
    let resendUnknown = false;
    if (this.core.state.read().intents[key]?.status === "unknown") {
      // A prior unsettle with an unknown outcome: a fresh read decides whether it landed.
      const reread = await this.observeFresh(id);
      if (reread.thread.settledOverride !== "settled") {
        this.core.state.update((current) => {
          const intent = current.intents[key];
          if (intent?.status === "unknown")
            current.intents[key] = {
              ...intent,
              status: "settled",
              result: null,
            };
        });
        this.refuseManuallySnoozed(id, reread);
        return;
      }
      resendUnknown = true;
    }

    try {
      await this.core.intents.effect(
        key,
        "orchestration.dispatchCommand",
        {
          type: "thread.unsettle",
          commandId: key,
          threadId: id,
          reason: "user",
        },
        undefined,
        undefined,
        { retryRefusedBeforeSend: true, resendUnknownAfterRead: resendUnknown },
      );
    } catch (error) {
      if (error instanceof ProvenPreSendRefusalError)
        throw new ProvenPreSendRefusalError(
          `T3Code unsettle was refused before send (${error.reason}); nothing was sent`,
        );
      // The unsettle may or may not have landed. The message is not sent either way,
      // so it waits, and the next pass reads the thread before anything repeats.
      throw new ProvenPreSendRefusalError(
        "T3Code unsettle outcome is unknown; nothing was sent and the thread is read again before the message is retried",
      );
    }

    // T3 may show the unsettle a moment after the command returns: read it back.
    for (let attempt = 0; attempt < UNSETTLE_READ_ATTEMPTS; attempt++) {
      if (attempt)
        await new Promise((done) => setTimeout(done, UNSETTLE_READ_GAP_MS));
      const read = await this.observeFresh(id);
      if (read.thread.settledOverride !== "settled") {
        this.refuseManuallySnoozed(id, read);
        return;
      }
    }
    throw new ProvenPreSendRefusalError(
      "T3Code still shows the thread settled after its unsettle; nothing was sent and the message waits for the next pass",
    );
  }

  /**
   * A thread the operator snoozed keeps that snooze: an ordinary delivery would
   * clear it, so the message waits for the wake instead (nucleus#1445). Only a task
   * row this host snoozed itself, proven by the exact horizon this read shows, is
   * delivered over; a cleared row is not snoozed and delivers as it always did.
   */
  private refuseManuallySnoozed(
    id: string,
    observed: { thread: Projection["thread"] },
  ): void {
    const snoozedUntil = observed.thread.snoozedUntil ?? null;
    const wakeAt = snoozedUntil ? Date.parse(snoozedUntil) : Number.NaN;
    if (!snoozedUntil || !Number.isFinite(wakeAt) || wakeAt <= Date.now())
      return;
    const taskId = this.rowTaskOf(id);
    const record = this.core.state.read().snoozes?.[id];
    if (taskId && this.ownsSnooze(record, taskId, snoozedUntil)) return;
    throw new ProvenPreSendRefusalError(
      `T3Code thread is snoozed until ${snoozedUntil}; the message waits for that snooze to wake`,
      "T3Code message",
    );
  }

  /**
   * One thread's current record. T3's live shell row is current to its stream and
   * carries every field this gate reads (archive, removal, settle and snooze), so a
   * thread it lists that no command has gone to since answers from that row
   * (Spec 069 batch 5). Otherwise — a thread the shell does not list, or one just
   * written to — one exact read by id answers, after forgetting any held snapshot.
   */
  private async observeFresh(
    id: string,
  ): Promise<{ thread: Projection["thread"] }> {
    const row = await this.core.reads.currentShellRow(id);
    if (row) return { thread: row };
    this.core.reads.forget?.(id);
    return this.core.reads.readDirectProjection(id, "observation", true);
  }

  /**
   * The first command identity for this purpose and these facts that no command
   * owns. Commands get a fresh identity rather than a second send: `owns` skips
   * every identity that reached an outcome, while `settledOrRefused` keeps an
   * unknown delivery for the projection to reconcile under the same id.
   */
  private commandIdFor(
    purpose: string,
    facts: readonly unknown[],
    owns: (intent: T3State["intents"][string]) => boolean,
  ): string {
    const intents = this.core.state.read().intents;
    const identityFor = (attempt: number) =>
      identity(purpose, canonical(attempt ? [...facts, attempt] : facts));
    if (!owns(intents[identityFor(0)])) return identityFor(0);
    for (let attempt = 1; ; attempt++) {
      if (!owns(intents[identityFor(attempt)])) return identityFor(attempt);
    }
  }

  // ------------------------------------------------------------------ the row

  /**
   * Snooze the row while the task waits (nucleus#1366). The horizon is bounded and
   * renewed on the sweep before it lapses, so the row never wakes itself while the
   * task still waits. The command identity is deterministic per wait episode and
   * horizon, the send is verified by reading `snoozedUntil` back, and a refusal is
   * "stay active" for this episode: never a retry loop.
   *
   * Only the occurrence this host wrote is this host's (nucleus#1445): a row that
   * shows another horizon is the operator's snooze, and a read-back that is not the
   * horizon this command asked for is never adopted as ours.
   */
  private async snoozeRow(
    taskId: string,
    row: TaskRow,
    cause: string,
  ): Promise<void> {
    const { threadId } = row;
    if (this.core.intents.confirmedDeletion(this.core.state.read(), threadId))
      return;
    if (!(await this.core.reads.isObserved(threadId))) return;
    const projection = await this.core.reads.readProjection(
      threadId,
      "observation",
    );
    // An archived row is the terminal lane's, and an operator's manual settle is the
    // operator's own list: Nucleus leaves both alone.
    if (
      projection.thread.archivedAt ||
      projection.thread.deletedAt ||
      projection.thread.settledOverride === "settled"
    ) {
      this.forgetSnooze(threadId);
      return;
    }
    const now = Date.now();
    const shown = projection.thread.snoozedUntil ?? null;
    const wakeAt = shown ? Date.parse(shown) : Number.NaN;
    let record = this.core.state.read().snoozes?.[threadId];
    const snoozed = Number.isFinite(wakeAt) && wakeAt > now;
    if (record?.state === "refused") return;
    // A record this row did not write, or a record whose own occurrence the host
    // no longer shows, is not this row's: it is dropped, never renewed.
    if (record && record.taskId !== undefined && record.taskId !== taskId) {
      this.forgetSnooze(threadId);
      record = undefined;
    }
    if (
      record?.state === "unknown" &&
      record.ended &&
      Date.parse(record.until) <= now
    ) {
      // A late delivery cannot snooze beyond its own expired horizon. A later
      // wait can now start a fresh episode without replaying the uncertain send.
      this.forgetSnooze(threadId);
      record = undefined;
    }
    const episodeStartedAt = record
      ? snoozeEpisodeStart(record)
      : new Date(now).toISOString();
    if (record?.state === "unknown") {
      if (snoozed && this.ownsSnooze(record, taskId, shown))
        this.recordSnooze(threadId, {
          ...record,
          taskId,
          state: "snoozed",
          episodeStartedAt,
        });
      return;
    }
    // A snooze this host cannot prove it wrote — the operator's, or a horizon that
    // changed under us — is always left alone (Tom, 2026-11-20; nucleus#1445).
    if (snoozed && !this.ownsSnooze(record, taskId, shown)) {
      if (record) this.forgetSnooze(threadId);
      return;
    }
    if (snoozed && wakeAt - now > SNOOZE_RENEW_BEFORE_MS) {
      // Still well inside the horizon. Our own record is the fact, so a repeated
      // pass sends nothing.
      this.recordSnooze(threadId, {
        ...record!,
        taskId,
        until: shown!,
        state: "snoozed",
        cause,
        episodeStartedAt,
      });
      return;
    }
    // A renewal inside the same wait gets the horizon's own command id, so a
    // returning identical wait never reuses a spent command. The episode start
    // stays: a renewal is not a new episode (nucleus#1417).
    const episode = record?.episode ?? 0;
    const until = new Date(now + SNOOZE_HORIZON_MS).toISOString();
    const commandId = this.commandIdFor(
      "snooze",
      [this.core.hostId(), threadId, until, episode],
      settledOrRefused,
    );
    this.recordSnooze(threadId, {
      episode,
      commandId,
      until,
      state: "unknown",
      cause,
      taskId,
      episodeStartedAt,
      recordedAt: new Date().toISOString(),
    });
    try {
      await this.core.intents.effect(
        commandId,
        "orchestration.dispatchCommand",
        { type: "thread.snooze", commandId, threadId, snoozedUntil: until },
        undefined,
        undefined,
        {},
      );
    } catch (error) {
      if (error instanceof ProvenPreSendRefusalError) {
        this.recordSnooze(threadId, {
          episode,
          commandId,
          until,
          state: "refused",
          cause,
          taskId,
          episodeStartedAt,
          recordedAt: new Date().toISOString(),
        });
      }
      if (isHostOperationTimeout(error)) throw error;
      return;
    }
    let observed: Projection;
    try {
      observed = await this.core.reads.readProjection(threadId, "observation");
    } catch (error) {
      if (isHostOperationTimeout(error)) throw error;
      return;
    }
    const landed = observed.thread.snoozedUntil ?? null;
    if (landed !== null && landed !== until) {
      // The row shows an occurrence this command did not write: someone else's
      // snooze replaced it, so this host owns nothing here any more.
      this.forgetSnooze(threadId);
      return;
    }
    this.recordSnooze(threadId, {
      episode,
      commandId,
      until,
      state: landed === until ? "snoozed" : "refused",
      cause,
      taskId,
      episodeStartedAt,
      recordedAt: new Date().toISOString(),
    });
  }

  /**
   * Show the row again because a person must act or a role is running. Only a row
   * this host snoozed is unsnoozed: an operator's own settle is never touched, and
   * Nucleus never sends `thread.settle`.
   *
   * This host keeps its snooze record until a fresh T3 read proves `snoozedUntil`
   * is cleared. If a settled unsnooze has not cleared it (delayed apply, stale
   * snapshot or an ack that did not land), the next pass re-observes and retries as
   * a new occurrence; an unknown delivery keeps its identity and is never resent
   * blindly.
   *
   * The occurrence this host clears is the one it wrote (nucleus#1445): a row that
   * shows another horizon was replaced by the operator, and is never unsnoozed
   * here.
   */
  private async unsnoozeRow(taskId: string, row: TaskRow): Promise<void> {
    const { threadId } = row;
    let record = this.core.state.read().snoozes?.[threadId];
    if (!record || record.state === "refused") {
      // Nothing this host snoozed: the row is already shown, so a repeated pass
      // sends nothing.
      if (record) this.forgetSnooze(threadId);
      return;
    }
    // A record another task's row wrote is not this row's snooze.
    if (record.taskId !== undefined && record.taskId !== taskId) {
      this.forgetSnooze(threadId);
      return;
    }
    if (this.core.intents.confirmedDeletion(this.core.state.read(), threadId))
      return;
    if (!(await this.core.reads.isObserved(threadId))) return;
    // Drop any cached snapshot before reading: a held snapshot from earlier in the
    // pass must never hide a still-snoozed row or settle an unsnooze early.
    this.core.reads.forget?.(threadId);
    const projection = await this.core.reads.readProjection(
      threadId,
      "observation",
    );
    if (
      projection.thread.archivedAt ||
      projection.thread.deletedAt ||
      projection.thread.settledOverride === "settled"
    ) {
      this.forgetSnooze(threadId);
      return;
    }
    if (
      record.state === "unknown" &&
      this.ownsSnooze(record, taskId, projection.thread.snoozedUntil)
    ) {
      record = { ...record, taskId, state: "snoozed" };
      this.recordSnooze(threadId, record);
    }
    if (
      projection.thread.snoozedUntil === null ||
      projection.thread.snoozedUntil === undefined
    ) {
      this.settleObservedUnsnooze(threadId, record.commandId);
      if (record.state === "unknown") {
        if (Date.parse(record.until) <= Date.now()) this.forgetSnooze(threadId);
        else this.recordSnooze(threadId, { ...record, ended: true });
      } else this.forgetSnooze(threadId);
      return;
    }
    // The row now shows a horizon this record did not write: the operator replaced
    // this host's occurrence, so this host clears nothing (Tom, 2026-11-20).
    if (!this.ownsSnooze(record, taskId, projection.thread.snoozedUntil)) {
      if (record.state !== "unknown") this.forgetSnooze(threadId);
      return;
    }
    const commandId = this.commandIdFor(
      "unsnooze",
      [this.core.hostId(), threadId, record.commandId],
      settledOrRefused,
    );
    try {
      await this.core.intents.effect(
        commandId,
        "orchestration.dispatchCommand",
        { type: "thread.unsnooze", commandId, threadId, reason: "user" },
        undefined,
        undefined,
        { resendUnknownAfterRead: true },
      );
    } catch (error) {
      if (isHostOperationTimeout(error)) throw error;
      /* the next pass re-reads the row before it decides again */
      return;
    }
    // Never forget on the ack alone: T3's own `snoozedUntil` read-back proves the
    // row is shown. Keep the record when `snoozedUntil` is still set so the next
    // pass re-observes and retries under a fresh occurrence if still needed.
    this.core.reads.forget?.(threadId);
    let observed: Projection;
    try {
      observed = await this.core.reads.readProjection(threadId, "observation");
    } catch (error) {
      if (isHostOperationTimeout(error)) throw error;
      return;
    }
    if (
      observed.thread.snoozedUntil === null ||
      observed.thread.snoozedUntil === undefined
    ) {
      this.forgetSnooze(threadId);
    }
  }

  /** Settle an uncertain unsnooze once a fresh T3 read proves `snoozedUntil` cleared. */
  private settleObservedUnsnooze(
    threadId: string,
    snoozeCommandId: string,
  ): void {
    const key = this.commandIdFor(
      "unsnooze",
      [this.core.hostId(), threadId, snoozeCommandId],
      settledOrRefused,
    );
    if (this.core.state.read().intents[key]?.status !== "unknown") return;
    this.core.state.update((current) => {
      const prior = current.intents[key];
      if (prior?.status === "unknown")
        current.intents[key] = {
          ...prior,
          status: "settled",
          result: { snoozedUntil: null },
        };
    });
  }

  /** Record the row's snooze by thread id; an unchanged record is the same fact, never a write. */
  private recordSnooze(threadId: string, entry: SnoozeRecord): void {
    const current = this.core.state.read().snoozes?.[threadId];
    if (
      current &&
      current.commandId === entry.commandId &&
      current.state === entry.state &&
      current.until === entry.until &&
      current.episode === entry.episode &&
      current.ended === entry.ended &&
      current.taskId === entry.taskId &&
      current.episodeStartedAt === entry.episodeStartedAt
    )
      return;
    this.core.state.update((state) => {
      state.snoozes = { ...state.snoozes, [threadId]: entry };
    });
  }

  private forgetSnooze(threadId: string): void {
    if (!this.core.state.read().snoozes?.[threadId]) return;
    this.core.state.update((state) => {
      if (state.snoozes) delete state.snoozes[threadId];
    });
  }
}
