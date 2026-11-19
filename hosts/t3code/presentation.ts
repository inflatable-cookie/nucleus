import { isHostOperationTimeout } from "../../core/host";
import { formatTaskNumber } from "../../shared/contracts";
import { capPaseoTitle } from "../../shared/paseo-title";
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
import { attentionStep, isSupportRole, labelRole, labelTask, rowStep, rowTitle } from "./one-row";

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
 * How long one snooze horizon lasts (nucleus#1366). Nucleus waits are open-ended,
 * so the row is snoozed for a bounded horizon and the ordinary sweep renews it
 * before it lapses: the row never wakes itself while the task still waits.
 */
export const SNOOZE_HORIZON_MS = 48 * 60 * 60_000;
/** The sweep renews once less than this remains, leaving a day of slack for a paused queue. */
export const SNOOZE_RENEW_BEFORE_MS = 24 * 60 * 60_000;

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
  async rowStepFor(taskId: string): Promise<string> {
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
    return rowStep(observed);
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
   * theirs and is left exactly as it is.
   *
   * The title rides the same pass: the task's own state title plus the step, so a
   * role that starts, needs input or stalls shows without a task title change.
   */
  async reconcileTaskRow(
    taskId: string,
    attention: TaskAttention,
  ): Promise<void> {
    const threadId = this.workerThreadFor(taskId);
    // A confirmed deletion retires the presentation work it would have shown, even
    // when the task is already finished.
    this.retireDeletedPresentationIntents();
    if (!threadId) return;
    if (attention.state === "finished") {
      this.forgetSnooze(threadId);
      return;
    }
    this.core.requireConnection();
    const step = await this.rowStepFor(taskId);
    const base = this.core.state.read().parents?.[taskId]?.title;
    if (base) {
      const desired = capPaseoTitle(rowTitle(base, step));
      if (this.core.state.read().rowTitles?.[threadId] !== desired) {
        try {
          await this.writeWorkerRow(threadId, desired);
        } catch (error) {
          if (isHostOperationTimeout(error)) throw error;
          /* the step keeps for the next pass */
        }
      }
    }
    // A role that asks a question or ended with a fault is a person who must act,
    // exactly as the projection's own attention is.
    if (attention.state === "attention" || attentionStep(step)) {
      await this.unsnoozeRow(threadId);
      return;
    }
    if (attention.state === "active") {
      await this.unsnoozeRow(threadId);
      return;
    }
    await this.snoozeRow(threadId, attention.cause ?? "Waiting");
  }

  /**
   * The task's row thread: its parent thread on this host. A task with no parent
   * record (the provider was missing or not ready, so the parent was never
   * launched) has no row, and its wait is the task's visible reason.
   */
  workerThreadFor(taskId: string): string | undefined {
    return this.core.parentThreadOf?.(taskId);
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
    return capPaseoTitle(`${numberedPrefix}${taskTitle}`);
  }

  async setTaskWorkspaceTitle(
    task: Task,
    title: string,
    requestId: string,
    _uncertain: boolean,
  ): Promise<void> {
    this.retireDeletedPresentationIntents();
    title = capPaseoTitle(title);
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
    const step = await this.rowStepFor(task.id);
    const desired = capPaseoTitle(rowTitle(title, step));
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

  async unsettleBeforeMessage(id: string, messageId: string) {
    if (this.core.intents.confirmedDeletion(this.core.state.read(), id))
      throw new ProvenPreSendRefusalError(
        "T3Code thread deletion is confirmed",
      );
    // A settled thread does not start a run, and T3 does not clear an operator's
    // manual settle on `message.dispatch`: the one wake a message needs is the
    // unsettle, and it is the only `thread.unsettle` this host keeps. A row this
    // host snoozed is not settled, so a snooze never blocks a run.
    const projection = await this.core.reads.readProjection(id, "observation");
    if (projection.thread.settledOverride !== "settled") return;
    const commandId = identity(
      "unsettle",
      canonical([this.core.hostId(), id, messageId]),
    );
    await this.core.intents.effect(commandId, "orchestration.dispatchCommand", {
      type: "thread.unsettle",
      commandId,
      threadId: id,
      reason: "user",
    });
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
   */
  private async snoozeRow(threadId: string, cause: string): Promise<void> {
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
    const wakeAt = projection.thread.snoozedUntil
      ? Date.parse(projection.thread.snoozedUntil)
      : Number.NaN;
    const record = this.core.state.read().snoozes?.[threadId];
    const snoozed = Number.isFinite(wakeAt) && wakeAt > now;
    if (record?.state === "refused") return;
    if (snoozed && wakeAt - now > SNOOZE_RENEW_BEFORE_MS) {
      // Still well inside the horizon. Our own record is the fact, so a repeated
      // pass sends nothing; a snooze nobody here recorded is the operator's, and is
      // left alone too.
      if (!record) return;
      this.recordSnooze(threadId, {
        ...record,
        until: projection.thread.snoozedUntil!,
        state: "snoozed",
        cause,
      });
      return;
    }
    // A renewal inside the same wait gets the horizon's own command id, so a
    // returning identical wait never reuses a spent command.
    const episode = record?.episode ?? 0;
    const until = new Date(now + SNOOZE_HORIZON_MS).toISOString();
    const commandId = identity(
      "snooze",
      canonical([this.core.hostId(), threadId, until, episode]),
    );
    try {
      await this.core.intents.effect(
        commandId,
        "orchestration.dispatchCommand",
        { type: "thread.snooze", commandId, threadId, snoozedUntil: until },
        undefined,
        undefined,
        { resendUnknownAfterRead: true },
      );
    } catch (error) {
      // A timeout keeps the record for the next pass; anything else is a proven
      // refusal (a pending approval, a queued run) or an unknown outcome that the
      // next pass re-reads. Either way the row stays visible and nothing retries
      // this episode.
      if (isHostOperationTimeout(error)) throw error;
      this.recordSnooze(threadId, {
        episode,
        commandId,
        until,
        state: "refused",
        cause,
        recordedAt: new Date().toISOString(),
      });
      return;
    }
    let observed: Projection;
    try {
      observed = await this.core.reads.readProjection(threadId, "observation");
    } catch (error) {
      if (isHostOperationTimeout(error)) throw error;
      return;
    }
    const landed = observed.thread.snoozedUntil;
    this.recordSnooze(threadId, {
      episode,
      commandId,
      until: landed ?? until,
      state: landed ? "snoozed" : "refused",
      cause,
      recordedAt: new Date().toISOString(),
    });
  }

  /**
   * Show the row again because a person must act or a role is running. Only a row
   * this host snoozed is unsnoozed: an operator's own settle is never touched, and
   * Nucleus never sends `thread.settle`.
   */
  private async unsnoozeRow(threadId: string): Promise<void> {
    const record = this.core.state.read().snoozes?.[threadId];
    if (!record || record.state !== "snoozed") {
      // Nothing this host snoozed: the row is already shown, so a repeated pass
      // sends nothing.
      if (record) this.forgetSnooze(threadId);
      return;
    }
    if (this.core.intents.confirmedDeletion(this.core.state.read(), threadId))
      return;
    if (!(await this.core.reads.isObserved(threadId))) return;
    const projection = await this.core.reads.readProjection(
      threadId,
      "observation",
    );
    if (projection.thread.snoozedUntil === null || projection.thread.snoozedUntil === undefined) {
      this.forgetSnooze(threadId);
      return;
    }
    const commandId = identity(
      "unsnooze",
      canonical([this.core.hostId(), threadId, record.commandId]),
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
    this.forgetSnooze(threadId);
  }

  /** Record the row's snooze by thread id; an unchanged record is the same fact, never a write. */
  private recordSnooze(
    threadId: string,
    entry: NonNullable<T3State["snoozes"]>[string],
  ): void {
    const current = this.core.state.read().snoozes?.[threadId];
    if (
      current &&
      current.commandId === entry.commandId &&
      current.state === entry.state &&
      current.until === entry.until &&
      current.episode === entry.episode
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
