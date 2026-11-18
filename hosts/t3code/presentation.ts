import { isHostOperationTimeout } from "../../core/host/errors";
import { formatTaskNumber } from "../../shared/contracts";
import { capPaseoTitle } from "../../shared/paseo-title";
import { WIRE_LABEL_KEYS } from "../../shared/wire-labels";
import {
  HostUnknownDeliveryError,
  ProvenPreSendRefusalError,
} from "../../core/host";
import type { Task } from "../../shared/contracts";
import type { T3State, T3SettleIntent, T3StateFile } from "./state";
import { agentRecord, canonical } from "./state";
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
  attentionStep,
  isSupportRole,
  labelRole,
  labelRun,
  labelTask,
  roleWord,
  rowStep,
  rowTitle,
  SUPPORT_THREAD_TAG,
} from "./one-row";

/** A settled or refused command never runs again, so its identity is spent. */
const settledOrRefused = (intent: T3State["intents"][string]) =>
  Boolean(intent) &&
  (intent.status === "refused" || intent.status === "settled");
/** Same, but an unknown delivery is kept: its identity is reconciled by a fresh read. */
const decidedCommand = (intent: T3State["intents"][string]) =>
  Boolean(intent) && intent.status !== "unknown";
/** A handover settle that never found an ended turn is retired rather than retried forever. */
const SETTLE_INTENT_TTL_MS = 24 * 60 * 60_000;
/** The nightly's newest run: its ordinal when reported, the list order otherwise. */
const latestRun = (projection: Projection) =>
  projection.runs.reduce(
    (best: Projection["runs"][number] | undefined, run) =>
      !best || (run.ordinal ?? -1) >= (best.ordinal ?? -1) ? run : best,
    undefined,
  );

/** The collaborators a presentation write needs: durable state, the ledger and the reads. */
export interface T3PresentationContext {
  state: T3StateFile;
  hostId(): string;
  requireConnection(): void;
  reads: T3Reads;
  intents: T3IntentLedger;
  /**
   * The task's parent thread when this host nests it: the parent is the task's one
   * operator-visible row, so titles, settles and attention belong to it rather than
   * to a child T3 draws inside it (nucleus#1305).
   */
  parentThreadOf?(taskId: string): string | undefined;
  /** Whether this thread is a nested child; a child's own row is T3's to draw. */
  nestedChild?(threadId: string): boolean;
}

/** One recorded support-thread effect pair, as the state file holds it. */
type T3SupportRow = NonNullable<T3State["supportRows"]>[string];

/**
 * What the T3 board shows: thread titles and settle state.
 *
 * Every write here is a presentation command recorded in the ledger before it is
 * sent, so an unknown delivery is never resent and a deletion retires the work it
 * would have shown. The settled marker tells a later settle that the thread needs
 * settling again; nothing here decides whether a task is done.
 */
export class T3Presentation {
  constructor(private readonly core: T3PresentationContext) {}

  noteThreadSettled(agentId: string, commandId: string): void {
    if (this.core.state.read().settledThreads?.[agentId] === commandId) return;
    this.core.state.update((state) => {
      state.settledThreads = { ...state.settledThreads, [agentId]: commandId };
    });
  }
  /** An unsettle clears the settled marker before the send, so a later settle
   * re-reads the thread even when this send's own reply is lost. A spurious
   * clear only costs one extra projection read on the next settle. */
  clearThreadSettled(agentId: string): void {
    if (!this.core.state.read().settledThreads?.[agentId]) return;
    this.core.state.update((state) => {
      if (state.settledThreads) delete state.settledThreads[agentId];
    });
  }
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
      for (const [key, entry] of Object.entries(state.pendingSettles ?? {})) {
        if (!this.core.intents.confirmedDeletion(state, entry.agentId))
          continue;
        if (apply) delete state.pendingSettles![key];
        changed = true;
      }
      for (const agentId of Object.keys(state.settledThreads ?? {})) {
        if (!this.core.intents.confirmedDeletion(state, agentId)) continue;
        if (apply) delete state.settledThreads![agentId];
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
   * The step the task's support threads are doing right now, from their own
   * native projections: a pending question or permission wins, then a thread
   * whose latest run ended with a fault, then a live role. Only the thread each
   * role currently uses counts: a superseded reviewer or recovery thread's last
   * failed run is history, never the task's attention. Empty when nothing of the
   * task is running, which is the state the row settles in.
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
      } catch {
        /* an unreadable support thread names no step */
      }
    }
    return rowStep(observed);
  }

  /**
   * One support thread per role: the thread this adapter last created for that
   * task and role. A role with no recorded replacement keeps every thread it has,
   * so state written before the marker existed still names its live step.
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
   * The worker row's title, kept current without a task title change: a support
   * role that starts, needs input or stalls changes the row's step, and the row
   * must say so on the ordinary host sweep. The task's own state title stays the
   * base it was last given.
   */
  async reconcileWorkerRows(tasks: readonly Task[]): Promise<void> {
    this.core.requireConnection();
    this.retireDeletedPresentationIntents();
    for (const task of tasks) {
      if (task.removedAt != null || ["done", "cancelled"].includes(task.phase))
        continue;
      const threadId = this.workerThreadFor(task.id);
      const base = threadId
        ? (this.core.state.read().agents[threadId]?.title ??
          this.core.state.read().parents?.[task.id]?.title)
        : undefined;
      if (!threadId || !base) continue;
      const step = await this.rowStepFor(task.id);
      const desired = capPaseoTitle(rowTitle(base, step));
      if (this.core.state.read().rowTitles?.[threadId] !== desired) {
        try {
          await this.writeWorkerRow(threadId, desired);
        } catch {
          /* the step keeps for the next pass */
        }
      }
      // A support thread that needs input or ended with a fault surfaces the row
      // even when its own run is not live: a hidden thread's pending approval is
      // T3's to show, and Nucleus's own attention covers the row instead.
      if (attentionStep(step)) {
        try {
          await this.unsettleWorkerThread(threadId, task.id);
        } catch {
          /* the next pass retries */
        }
      }
    }
  }

  /** The task a recorded thread belongs to, from its launch labels. */
  private taskOf(threadId: string): string | undefined {
    return labelTask(this.core.state.read().agents[threadId]?.labels);
  }

  /**
   * The thread one role agent is presented on: the task's parent row when that agent
   * is a recorded nested child, and the agent's own thread otherwise. A worker or
   * revision run that fell back to a top-level thread of a parented task is its own
   * row, so its title, settle and unsettle are never written to the parent
   * (nucleus#1305 review).
   */
  private rowFor(agentId: string): string {
    if (!this.core.nestedChild?.(agentId)) return agentId;
    const owner = this.taskOf(agentId);
    return (owner ? this.core.parentThreadOf?.(owner) : undefined) ?? agentId;
  }

  /**
   * The task's worker-shaped thread: no role label, else a revision thread
   * (nucleus#1154) — and, when that thread is a recorded nested child, the parent row
   * it is drawn inside (nucleus#1305). A worker that fell back to a top-level thread
   * of a parented task stays its own row. With no recorded worker-shaped thread the
   * parent, when there is one, is still the task's row.
   */
  workerThreadFor(taskId: string): string | undefined {
    const agents = Object.entries(this.core.state.read().agents).filter(
      ([, agent]) => labelTask(agent.labels) === taskId,
    );
    const noRole = agents.find(
      ([, agent]) => labelRole(agent.labels) === undefined,
    );
    const shaped =
      noRole?.[0] ??
      agents.find(([, agent]) => labelRole(agent.labels) === "revision")?.[0];
    return shaped ? this.rowFor(shaped) : this.core.parentThreadOf?.(taskId);
  }

  /**
   * Send one row title. A title the row already sent once gets a fresh command
   * identity when it comes back: round two's `· reviewing` is the same string as
   * round one's, a settled command never runs again, and the fresh projection
   * read above is the row's proof it still needs sending. An unknown delivery
   * keeps its identity and is reconciled by that same read, never repeated
   * blindly.
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
    await this.core.intents.effect(
      key,
      "orchestration.dispatchCommand",
      { type: "thread.metadata.update", commandId: key, threadId, title },
      undefined,
      undefined,
      { resendUnknownAfterRead: true },
    );
    record();
  }

  /**
   * A support thread the one-row model owes work on: its `nucleus-support` tag
   * and the `thread_created` card in the worker's conversation. Recorded before
   * the sends, completed by the ordinary host sweep when they cannot be done
   * now (a worker run that has not appeared yet, a refused send, a lost reply).
   */
  async registerSupportThread(entry: {
    taskId: string;
    threadId: string;
    role: string;
  }): Promise<void> {
    // A nested child is already drawn inside the parent row by T3 itself: no tag and
    // no `thread_created` card, because the parent is not an agent conversation that
    // could carry one. Only the recorded child is skipped — a role thread of a parented
    // task that fell back to a top-level launch keeps the one-row model (nucleus#1305).
    if (this.core.nestedChild?.(entry.threadId)) return;
    this.core.state.update((state) => {
      // This thread is the one the role now uses; any earlier thread for the same
      // task and role is displaced and stops naming the row's step.
      state.supportCurrent = {
        ...state.supportCurrent,
        [`${entry.taskId}:${entry.role}`]: entry.threadId,
      };
      if (state.supportRows?.[entry.threadId]) return;
      state.supportRows = {
        ...state.supportRows,
        [entry.threadId]: {
          ...entry,
          recordedAt: new Date().toISOString(),
          tag: "pending",
          card: "pending",
        },
      };
    });
    await this.reconcileSupportRows();
  }

  /** Retry the recorded one-row effects during the ordinary host sweep. */
  async reconcileSupportRows(): Promise<void> {
    const rows = Object.values(this.core.state.read().supportRows ?? {});
    if (!rows.length) return;
    this.core.requireConnection();
    this.retireDeletedPresentationIntents();
    for (const row of rows) {
      if (
        this.core.intents.confirmedDeletion(
          this.core.state.read(),
          row.threadId,
        )
      ) {
        this.forgetSupportRow(row.threadId);
        continue;
      }
      if (row.tag !== "settled" && row.tag !== "unknown") {
        try {
          await this.tagSupportThread(row);
        } catch {
          /* the record keeps for the next pass */
        }
      }
      if (row.card !== "settled" && row.card !== "unknown") {
        try {
          await this.recordCreatedThread(row);
        } catch {
          /* the record keeps for the next pass */
        }
      }
      const current = this.core.state.read().supportRows?.[row.threadId];
      if (
        current &&
        ["settled", "unknown"].includes(current.tag ?? "") &&
        ["settled", "unknown"].includes(current.card ?? "")
      )
        this.forgetSupportRow(row.threadId);
    }
  }

  private forgetSupportRow(threadId: string): void {
    if (!this.core.state.read().supportRows?.[threadId]) return;
    this.core.state.update((state) => {
      if (state.supportRows) delete state.supportRows[threadId];
    });
  }

  private supportRowOutcome(
    threadId: string,
    field: "tag" | "card",
    outcome: "settled" | "unknown",
  ): void {
    this.core.state.update((state) => {
      const row = state.supportRows?.[threadId];
      if (row) state.supportRows![threadId] = { ...row, [field]: outcome };
    });
  }

  /**
   * Tag the support thread so the client's own hide setting can leave it out of
   * the sidebar. Unknown delivery is never resent: the projection carries no tag
   * to read back, so the recorded intent is the only proof, and the row works
   * without the tag (the card and the title do not depend on it).
   */
  private async tagSupportThread(row: T3SupportRow): Promise<void> {
    const commandId = identity(
      "support-tag",
      canonical([this.core.hostId(), row.threadId, SUPPORT_THREAD_TAG]),
    );
    const prior = this.core.state.read().intents[commandId];
    if (prior?.status === "settled") {
      this.supportRowOutcome(row.threadId, "tag", "settled");
      return;
    }
    if (prior?.status === "unknown") {
      this.supportRowOutcome(row.threadId, "tag", "unknown");
      return;
    }
    await this.core.intents.effect(
      commandId,
      "orchestration.dispatchCommand",
      {
        type: "thread.tag.set",
        commandId,
        threadId: row.threadId,
        tag: SUPPORT_THREAD_TAG,
        tagged: true,
      },
      undefined,
      undefined,
      { retryRefusedBeforeSend: true },
    );
    this.supportRowOutcome(row.threadId, "tag", "settled");
  }

  /**
   * Record the role card in the worker's conversation: the nightly's
   * `thread.created.record` needs the worker's latest run and that run's own root
   * node, and it writes one completed `thread_created` card titled with the
   * support thread's title. Retried on the ordinary sweep until the worker run
   * exists, and an unknown delivery is only resent after a fresh read proves the
   * card absent.
   */
  private async recordCreatedThread(row: T3SupportRow): Promise<void> {
    const workerId = this.workerThreadFor(row.taskId);
    if (!workerId) return;
    const commandId = identity(
      "created-record",
      canonical([this.core.hostId(), workerId, row.threadId]),
    );
    const prior = this.core.state.read().intents[commandId];
    if (prior?.status === "settled") {
      this.supportRowOutcome(row.threadId, "card", "settled");
      return;
    }
    let resendUnknown = false;
    if (prior?.status === "unknown") {
      let present: boolean;
      try {
        present = await this.cardPresent(workerId, row.threadId);
      } catch {
        return;
      }
      if (present) {
        this.core.state.update((state) => {
          const intent = state.intents[commandId];
          if (intent?.status === "unknown")
            state.intents[commandId] = {
              ...intent,
              status: "settled",
              result: { observed: true },
            };
        });
        this.supportRowOutcome(row.threadId, "card", "settled");
        return;
      }
      resendUnknown = true;
    }
    const parent = await this.workerRootRun(workerId);
    if (!parent) return;
    await this.core.intents.effect(
      commandId,
      "orchestration.dispatchCommand",
      {
        type: "thread.created.record",
        commandId,
        parentThreadId: workerId,
        parentRunId: parent.id,
        parentNodeId: parent.rootNodeId,
        targetThreadId: row.threadId,
        targetRunId: null,
      },
      undefined,
      undefined,
      {
        retryRefusedBeforeSend: true,
        ...(resendUnknown ? { resendUnknownAfterRead: true } : {}),
      },
    );
    this.supportRowOutcome(row.threadId, "card", "settled");
  }

  /** The worker thread's latest run that names its own root node, which the card must ride. */
  private async workerRootRun(
    workerId: string,
  ): Promise<{ id: string; rootNodeId: string } | null> {
    const projection = await this.core.reads.readProjection(
      workerId,
      "observation",
    );
    if (projection.thread.deletedAt) return null;
    const runs = projection.runs.filter(
      (run) => typeof run.rootNodeId === "string" && run.rootNodeId,
    );
    const latest = runs.reduce(
      (best: Projection["runs"][number] | undefined, run) =>
        !best || (run.ordinal ?? -1) >= (best.ordinal ?? -1) ? run : best,
      undefined,
    );
    return latest ? { id: latest.id, rootNodeId: latest.rootNodeId! } : null;
  }

  /** Whether the worker's conversation already carries the card for this thread. */
  private async cardPresent(
    workerId: string,
    supportThreadId: string,
  ): Promise<boolean> {
    const projection = await this.core.reads.readProjection(
      workerId,
      "observation",
    );
    if (projection.thread.deletedAt) return false;
    return projection.turnItems.some(
      (item) =>
        item.type === "thread_created" &&
        (item as { targetThreadId?: unknown }).targetThreadId ===
          supportThreadId,
    );
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
    const state = this.core.state.read();
    const taskLabel = WIRE_LABEL_KEYS.task,
      runLabel = WIRE_LABEL_KEYS.run,
      roleLabel = WIRE_LABEL_KEYS.role;
    const taskAgents = Object.entries(state.agents).filter(
      ([, agent]) => agent.labels[taskLabel] === task.id,
    );
    const recordedParent = this.core.parentThreadOf?.(task.id);
    const shaped =
      task.agentId && state.agents[task.agentId]?.labels[taskLabel] === task.id
        ? task.agentId
        : taskAgents.find(
            ([id, agent]) =>
              agent.labels[roleLabel] === "worker" ||
              (agent.labels[roleLabel] === undefined &&
                (id === task.agentId ||
                  (task.runId !== undefined &&
                    agent.labels[runLabel] === task.runId))),
          )?.[0];
    // The row is the parent only when the recorded worker thread is a nested child; a
    // worker that fell back to a top-level thread is titled on its own thread.
    const threadId = shaped ? this.rowFor(shaped) : recordedParent;
    if (!threadId) throw Error("Task worker thread is missing");
    const onParent =
      recordedParent !== undefined && threadId === recordedParent;
    if (this.core.intents.confirmedDeletion(state, threadId)) return;
    // A row that left observation keeps the title it has: nothing is sent to a
    // thread whose task is over or that T3 reports archived (nucleus#1328).
    if (!(await this.core.reads.isObserved(threadId))) return;
    // The task's own state title is the row's base; the step its support threads
    // are doing rides after it, so the one visible row names both (one row per
    // task, Tom 2026-11-15). The agent record keeps the base.
    const step = await this.rowStepFor(task.id);
    const desired = capPaseoTitle(rowTitle(title, step));
    const projection = await this.core.reads.readProjection(
      threadId,
      "observation",
    );
    const key = identity("thread-title", canonical({ threadId, requestId }));
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
        if (current.agents[threadId]) current.agents[threadId].title = title;
        if (onParent && current.parents?.[task.id])
          current.parents[task.id].title = title;
        current.rowTitles = { ...current.rowTitles, [threadId]: desired };
      });
    } else if (!projection.thread.archivedAt && !projection.thread.deletedAt) {
      await this.core.intents.effect(
        key,
        "orchestration.dispatchCommand",
        {
          type: "thread.metadata.update",
          commandId: key,
          threadId,
          title: desired,
        },
        undefined,
        undefined,
        { resendUnknownAfterRead: true },
      );
      this.core.state.update((current) => {
        if (current.agents[threadId]) current.agents[threadId].title = title;
        if (onParent && current.parents?.[task.id])
          current.parents[task.id].title = title;
        current.rowTitles = { ...current.rowTitles, [threadId]: desired };
      });
    }

    // Task state sync also repairs the number-and-role prefix on existing support
    // threads. Their current remote title is the source of the task title, so a
    // restart can safely catch up threads created before numbered titles landed.
    if (task.number && !onParent)
      for (const [supportId, agent] of taskAgents) {
        const role = agent.labels[roleLabel];
        if (
          !role ||
          role === "worker" ||
          this.core.intents.confirmedDeletion(this.core.state.read(), supportId)
        )
          continue;
        if (!(await this.core.reads.isObserved(supportId))) continue;
        const support = await this.core.reads.readProjection(
          supportId,
          "observation",
        );
        if (support.thread.archivedAt || support.thread.deletedAt) continue;
        const supportTitle = this.numberedThreadTitle(
          task.number,
          role,
          support.thread.title,
        );
        if (support.thread.title === supportTitle) continue;
        const supportKey = identity(
          "thread-title",
          canonical({ threadId: supportId, requestId, title: supportTitle }),
        );
        await this.core.intents.effect(
          supportKey,
          "orchestration.dispatchCommand",
          {
            type: "thread.metadata.update",
            commandId: supportKey,
            threadId: supportId,
            title: supportTitle,
          },
          undefined,
          undefined,
          { resendUnknownAfterRead: true },
        );
        this.core.state.update((current) => {
          if (current.agents[supportId])
            current.agents[supportId].title = supportTitle;
        });
      }
  }
  async settleReportedThread(agentId: string, runId: string): Promise<void> {
    this.core.requireConnection();
    // A nested child is drawn inside its parent's row, so its settle state is not how
    // the task is presented: the parent's held turn owns that (nucleus#1305).
    if (this.core.nestedChild?.(agentId)) return;
    if (this.core.intents.confirmedDeletion(this.core.state.read(), agentId)) {
      this.retireDeletedPresentationIntents();
      return;
    }
    // Settled, and no unsettle since: no projection read, no second command.
    if (this.core.state.read().settledThreads?.[agentId]) return;
    // A thread that left observation has no report to settle: its task is over, or
    // T3 reports it archived or removed, and the terminal lane owns it (nucleus#1328).
    if (!(await this.core.reads.isObserved(agentId))) return;
    const baseCommandId = identity(
      "settle",
      canonical([this.core.hostId(), agentId, runId]),
    );
    // At most one stale bind retires per call; the fresh bind for the current
    // latest run follows in the same pass.
    for (let round = 0; round < 2; round++) {
      let commandId = baseCommandId;
      let prior = this.core.state.read().intents[commandId];
      const projection = await this.core.reads.readProjection(
        agentId,
        "observation",
      );
      if (projection.thread.settledOverride === "settled") {
        if (prior?.status === "unknown") this.markSettleObserved(commandId);
        this.noteThreadSettled(
          agentId,
          prior?.status === "settled" ? commandId : baseCommandId,
        );
        return;
      }
      // An archived thread is hidden; settling it is pointless and the Nightly
      // may refuse it. The terminal lane owns archived threads.
      if (projection.thread.archivedAt || projection.thread.deletedAt) return;
      const latest = latestRun(projection);
      // A fresh run owns the thread now. Never settle it because an older report arrived late.
      if (!latest || activeStatuses.has(latest.status)) return;
      // A decided command never runs again: the unsettled thread gets a fresh
      // command identity. Unknown delivery still goes through the projection
      // reconciliation below.
      commandId = this.commandIdFor(
        "settle",
        [this.core.hostId(), agentId, runId],
        decidedCommand,
      );
      prior = this.core.state.read().intents[commandId];
      if (prior) {
        const outcome = await this.reconcileSettleIntent(
          commandId,
          prior,
        ).catch(() => null);
        if (outcome !== "retired") return;
        continue; // Stale bind retired; re-read and settle the current latest.
      }
      await this.core.intents.effect(
        commandId,
        "orchestration.dispatchCommand",
        {
          type: "thread.settle",
          commandId,
          threadId: agentId,
          expectedLatestRunId: latest.id,
        },
      );
      this.noteThreadSettled(agentId, commandId);
      return;
    }
  }
  async reconcileReportedSettlements(): Promise<void> {
    this.retireDeletedPresentationIntents();
    const state = this.core.state.read();
    const workerSettles = state.workerSettles ?? {};
    const pending = Object.entries(state.intents).filter(([key, intent]) => {
      if (intent.status !== "unknown") return false;
      // A worker handover settle is never resent (nucleus#1154): an unknown
      // outcome stays unknown, and only a settle that was never sent may be
      // retried from its pending record. Resending here would turn one unknown
      // mutation into a second.
      if (workerSettles[key]) return false;
      // A legacy entry with no recorded kind and an unreadable wire stays unknown
      // delivery, exactly as a malformed command does.
      if (!intentKindOf(intent)) throw new HostUnknownDeliveryError();
      // A nested child's own settle is not the task's presentation (nucleus#1305):
      // the parent's held turn and release own that, so a child settle recorded before
      // nesting began is left as recorded rather than re-read and sent.
      if (this.core.nestedChild?.(intentThreadId(intent) ?? "")) return false;
      // A thread that left observation proves nothing about this delivery: the entry
      // stays exactly as recorded, unknown, and is not reconciled, resent or marked
      // settled without a T3 read that proves it (nucleus#1328 review).
      if (!this.core.reads.observes(intentThreadId(intent) ?? "")) return false;
      return isIntent("thread.settle", intent);
    });
    for (const [key, intent] of pending) {
      try {
        await this.reconcileSettleIntent(key, intent);
      } catch (error) {
        if (isHostOperationTimeout(error))
          throw error; /* retain unknown delivery for the next sweep */
      }
    }
  }

  markSettleObserved(key: string, result: unknown = { settled: true }) {
    this.core.state.update((state) => {
      const intent = state.intents[key];
      if (intent?.status === "unknown")
        state.intents[key] = { ...intent, status: "settled", result };
    });
  }
  /**
   * Reconcile one uncertain settle against T3, and report what it proves.
   * `settled` means the thread is settled (or the resend landed) and there is
   * nothing more to do; `retired` means this command no longer owns the latest
   * run — the caller settles the current latest run under a fresh command
   * instead of leaving the thread unsettled (nucleus#1181; #227's reviewer
   * thread). A bind that never named a latest run cannot be verified either
   * way, so it retires the same way instead of looping invisibly; a malformed
   * intent with no thread stays unknown delivery and is never resent.
   * `unobserved` means this host no longer observes the thread, so nothing here
   * can prove the delivery either way: the entry is left exactly as recorded and
   * is never rewritten to settled without T3 evidence (nucleus#1328 review).
   */
  async reconcileSettleIntent(
    key: string,
    intent: T3State["intents"][string],
  ): Promise<"settled" | "retired" | "unobserved"> {
    const threadId = intentThreadId(intent);
    if (!isIntent("thread.settle", intent) || !threadId)
      throw new HostUnknownDeliveryError();
    // A thread that left observation proves nothing more: its task is over or T3
    // reports it archived, the terminal lane owns the thread, and the recorded
    // unknown delivery stays unknown. Nothing is written, read or resent.
    if (!(await this.core.reads.isObserved(threadId))) return "unobserved";
    const payload = JSON.parse(intent.payload) as {
      payload?: { expectedLatestRunId?: string };
    };
    const projection = await this.core.reads.readProjection(
      threadId,
      "observation",
    );
    if (projection.thread.settledOverride === "settled") {
      this.markSettleObserved(key);
      this.noteThreadSettled(threadId, key);
      return "settled";
    }
    if (projection.thread.archivedAt || projection.thread.deletedAt) {
      // Hidden threads are the terminal lane's; this bind can prove nothing more.
      this.markSettleObserved(key, { settled: false, superseded: true });
      return "retired";
    }
    const latest = latestRun(projection);
    if (
      !payload.payload?.expectedLatestRunId ||
      !latest ||
      latest.id !== payload.payload.expectedLatestRunId ||
      activeStatuses.has(latest.status)
    ) {
      // The old report no longer owns the latest run; retire this intent without touching it.
      this.markSettleObserved(key, { settled: false, superseded: true });
      return "retired";
    }
    await this.core.intents.effect(
      key,
      "orchestration.dispatchCommand",
      JSON.parse(intent.payload).payload,
      undefined,
      undefined,
      { resendUnknownAfterRead: true },
    );
    return "settled";
  }

  async unsettleBeforeMessage(id: string, messageId: string) {
    if (this.core.intents.confirmedDeletion(this.core.state.read(), id))
      throw new ProvenPreSendRefusalError(
        "T3Code thread deletion is confirmed",
      );
    // A message wakes the thread: a later settle must re-read and settle again.
    this.clearThreadSettled(id);
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
   * Surface a stuck task's worker thread (nucleus#1181): when a T3-bound task
   * enters `blocked`, `needs_attention` or an escalation, its worker thread is
   * unsettled so it shows in T3's main list instead of the settled list. Only
   * the worker thread surfaces; support threads keep their settled state and
   * the title already shows the task state. When the task leaves attention the
   * sweep's ordinary settles put the thread back, under a fresh command (the
   * settled marker was cleared here). Idempotent: an already-active thread
   * sends nothing, and each attention episode gets its own command identity.
   */

  async unsettleWorkerThread(agentId: string, taskId: string): Promise<void> {
    this.core.requireConnection();
    // A recorded nested child surfaces on the parent row it is drawn inside; a worker
    // that fell back to a top-level thread surfaces on its own (nucleus#1305 review).
    agentId = this.rowFor(agentId);
    if (this.core.intents.confirmedDeletion(this.core.state.read(), agentId)) {
      this.retireDeletedPresentationIntents();
      return;
    }
    // Clear before the read: a later settle re-reads even when this send's
    // own reply is lost.
    this.clearThreadSettled(agentId);
    // A thread that left observation never surfaces: its task is over or it is
    // archived, so there is no row to pull back into the main list (nucleus#1328).
    if (!(await this.core.reads.isObserved(agentId))) return;
    const projection = await this.core.reads.readProjection(
      agentId,
      "observation",
    );
    if (
      projection.thread.settledOverride !== "settled" ||
      projection.thread.archivedAt ||
      projection.thread.deletedAt
    )
      return;
    const commandId = this.attentionUnsettleCommandId(agentId, taskId);
    await this.core.intents.effect(
      commandId,
      "orchestration.dispatchCommand",
      { type: "thread.unsettle", commandId, threadId: agentId, reason: "user" },
      undefined,
      undefined,
      { resendUnknownAfterRead: true },
    );
  }
  /** First unused attention-unsettle id for this thread and task. Settled and
   * refused commands never run again, so each attention episode after a
   * re-settle gets its own identity; an unknown one is reconciled by re-read. */
  attentionUnsettleCommandId(agentId: string, taskId: string): string {
    return this.commandIdFor(
      "attention-unsettle",
      [this.core.hostId(), agentId, taskId],
      settledOrRefused,
    );
  }

  /**
   * The first command identity for this purpose and these facts that no command
   * owns. Commands get a fresh identity rather than a second send: `decidedCommand`
   * skips every identity that reached an outcome, while `settledOrRefused` keeps
   * an unknown delivery for the projection to reconcile under the same id.
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

  /**
   * Settle a worker thread once Nucleus accepted its handover and moved the task
   * to review (Tom, 2026-11-12). `expectedLatestRunId` names the run this
   * handover ended, so a thread a later run already owns is never settled.
   *
   * The accepted receipt is durable before this presentation effect, and the
   * handover's turn may still be ending when it arrives: an active run is never
   * settled (the next turn would clear the marker anyway), so the intent is
   * recorded and the ordinary host sweep retries it once that run has ended.
   * A recorded command is left exactly as recorded — an unknown delivery is not
   * permission to resend, and a settled one is the same settle again. T3 clears
   * the marker when a new message wakes the thread, so a revision round makes the
   * worker active and its next handover settles it again; an attention surfacing
   * in between clears the marker too, so the return to review settles again
   * under a fresh command identity (nucleus#1181).
   */
  async settleWorkerThread(agentId: string, runId: string): Promise<void> {
    this.core.requireConnection();
    // A recorded nested child settles on the parent row it is drawn inside: a held turn
    // is never settled (the projection read below refuses a run that is still active),
    // and a released one is. A worker that fell back to a top-level thread settles on
    // its own thread (nucleus#1305 review).
    agentId = this.rowFor(agentId);
    if (this.core.intents.confirmedDeletion(this.core.state.read(), agentId)) {
      this.retireDeletedPresentationIntents();
      return;
    }
    // Settled, and no unsettle since: no projection read, no second command.
    if (this.core.state.read().settledThreads?.[agentId]) return;
    // A handover settle for a thread that left observation keeps its durable receipt
    // and its pending record only: nothing is read or sent for a thread whose task is
    // over, or that T3 reports archived or removed (nucleus#1328).
    if (!(await this.core.reads.isObserved(agentId))) return;
    const baseCommandId = identity(
      "settle",
      canonical([this.core.hostId(), agentId, runId]),
    );
    const existing = this.core.state.read().pendingSettles?.[baseCommandId];
    const commandId = this.workerSettleCommandId(agentId, runId);
    const intent = this.core.state.read().intents[commandId];
    if (intent?.status === "unknown")
      throw new HostUnknownDeliveryError(intent.diagnostic);
    if (intent && intent.status !== "refused") return;
    await this.attemptWorkerSettle(
      existing ?? {
        agentId,
        runId,
        commandId,
        recordedAt: new Date().toISOString(),
      },
    );
  }

  /** Retry durable worker settle intents during the ordinary host sweep. */
  async reconcileSettledThreads(): Promise<void> {
    this.retireDeletedPresentationIntents();
    this.pruneWorkerSettles();
    const pending = Object.values(this.core.state.read().pendingSettles ?? {});
    if (!pending.length) return;
    this.core.requireConnection();
    for (const entry of pending) {
      try {
        await this.attemptWorkerSettle(entry);
      } catch (error) {
        if (isHostOperationTimeout(error))
          throw error; /* an unreadable thread or unknown delivery keeps its record for the next pass */
      }
    }
  }

  /** One worker settle: send when the handover's own run has ended, else retain the intent. */
  async attemptWorkerSettle(entry: T3SettleIntent): Promise<void> {
    if (
      this.core.intents.confirmedDeletion(this.core.state.read(), entry.agentId)
    ) {
      this.retireDeletedPresentationIntents();
      return;
    }
    const intent = this.core.state.read().intents[entry.commandId];
    if (intent?.status === "settled") {
      const hadPending = Boolean(
        this.core.state.read().pendingSettles?.[entry.commandId],
      );
      this.forgetSettle(entry.commandId);
      // The send landed: a pending record is the crash window between the
      // receipt and its cleanup. Without one this handover already settled,
      // and only an unsettle since (attention, revision message) earns a
      // fresh command below.
      if (
        hadPending ||
        this.core.state.read().settledThreads?.[entry.agentId] ===
          entry.commandId
      ) {
        this.noteThreadSettled(entry.agentId, entry.commandId);
        return;
      }
      entry = {
        ...entry,
        commandId: this.workerSettleCommandId(entry.agentId, entry.runId),
      };
    } else {
      // Unknown delivery is never resent for worker handovers. A proven refusal
      // gets a new id on the next pass; it was known not to reach T3.
      if (intent && intent.status !== "refused") {
        this.forgetSettle(entry.commandId);
        return;
      }
      if (intent?.status === "refused") {
        this.forgetSettle(entry.commandId);
        entry = {
          ...entry,
          commandId: this.workerSettleCommandId(entry.agentId, entry.runId),
        };
      }
    }
    if (Date.now() - Date.parse(entry.recordedAt) > SETTLE_INTENT_TTL_MS) {
      this.forgetSettle(entry.commandId);
      return;
    }
    // The thread left observation (its task is over, or T3 reports it archived or
    // removed): the recorded settle can never be presented, so it is dropped rather
    // than read for on every sweep (nucleus#1328).
    if (!(await this.core.reads.isObserved(entry.agentId))) {
      this.forgetSettle(entry.commandId);
      return;
    }
    const projection = await this.core.reads.readProjection(
      entry.agentId,
      "observation",
    );
    // Already settled, or retired: the handover needs no further presentation.
    if (
      projection.thread.settledOverride === "settled" ||
      projection.thread.archivedAt ||
      projection.thread.deletedAt
    ) {
      this.noteThreadSettled(entry.agentId, entry.commandId);
      this.forgetSettle(entry.commandId);
      return;
    }
    const latest = latestRun(projection);
    // A later run owns the thread now; this handover must not settle it.
    if (
      entry.expectedLatestRunId &&
      (!latest || latest.id !== entry.expectedLatestRunId)
    ) {
      this.forgetSettle(entry.commandId);
      return;
    }
    // Still live, or the run has not appeared yet: keep the recorded intent.
    if (!latest || activeStatuses.has(latest.status)) {
      this.recordSettle({ ...entry, expectedLatestRunId: latest?.id });
      return;
    }
    this.recordSettle({ ...entry, expectedLatestRunId: latest.id });
    this.markWorkerSettle(entry.commandId, entry.recordedAt);
    await this.core.intents.effect(
      entry.commandId,
      "orchestration.dispatchCommand",
      {
        type: "thread.settle",
        commandId: entry.commandId,
        threadId: entry.agentId,
        expectedLatestRunId: latest.id,
      },
    );
    this.noteThreadSettled(entry.agentId, entry.commandId);
    this.forgetSettle(entry.commandId);
  }

  /** First unused worker settle id: after a proven pre-send refusal, or after an
   * unsettle cleared the settled marker (attention, revision message), so the
   * return to review settles again under a fresh command. */
  workerSettleCommandId(agentId: string, runId: string): string {
    return this.commandIdFor(
      "settle",
      [this.core.hostId(), agentId, runId],
      settledOrRefused,
    );
  }

  /**
   * Record that this command id is a worker handover settle. The mark is written
   * before the send so a crash cannot leave an unknown worker settle looking like
   * a support report's settle to the support reconciler.
   */

  markWorkerSettle(commandId: string, recordedAt: string): void {
    if (this.core.state.read().workerSettles?.[commandId]) return;
    this.core.state.update((state) => {
      state.workerSettles = { ...state.workerSettles, [commandId]: recordedAt };
    });
  }

  /** Drop marks whose command has an outcome; an unknown one stays, so it is never resent. */

  pruneWorkerSettles(): void {
    const state = this.core.state.read();
    const done = Object.keys(state.workerSettles ?? {}).filter(
      (key) => state.intents[key]?.status !== "unknown",
    );
    if (!done.length) return;
    this.core.state.update((next) => {
      for (const key of done) delete next.workerSettles?.[key];
    });
  }

  /** Record one pending settle; an unchanged record is the same intent, never a rewrite. */

  recordSettle(entry: T3SettleIntent): void {
    const current = this.core.state.read().pendingSettles?.[entry.commandId];
    if (current && current.expectedLatestRunId === entry.expectedLatestRunId)
      return;
    this.core.state.update((state) => {
      state.pendingSettles = {
        ...state.pendingSettles,
        [entry.commandId]: {
          ...entry,
          recordedAt: current?.recordedAt ?? entry.recordedAt,
        },
      };
    });
  }

  forgetSettle(commandId: string): void {
    if (!this.core.state.read().pendingSettles?.[commandId]) return;
    this.core.state.update((state) => {
      if (state.pendingSettles) delete state.pendingSettles[commandId];
    });
  }
}
