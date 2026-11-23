import { isHostOperationTimeout as hostTimedOut } from "../host/errors";
import { sweepSettledRunProcesses } from "../machine/run-process-cleanup";
import type { Engine } from "../engine";
import type { Resolution } from "../resolution";
import type { Task } from "../../shared/contracts";
import type { AgentObservation } from "../host/adapter";
import {
  catchUpFinishedTaskThreads,
  finishedThreadCleanupCatchUp,
} from "../workspaces/thread-archive";
import { removesThreads } from "../workspaces/thread-archive-effect";
import { sanitizeHostFailureDetail, sanitizeHostFailureReason } from "../host";
import { isTransportFailure } from "../../shared/transport";
import {
  hasRecordedOperationSettlement,
  historicalFenceRefusal,
  observedHostEffectEvidence,
  releasedRunDeliveryEvidence,
} from "../recovery/recovery-effects";
import {
  SHELL_NOTICE_MS,
  TOOL_TIMELINE_LIMIT,
  TOOL_TIMELINE_READ_BUDGET,
  noTurnLive,
} from "../recovery/stall";
import { executionParticipants } from "../machine/execution-participants";
import {
  HOST_PASS_WARM_BUDGET_MS,
  HOST_PASS_WARM_CANDIDATE_CAP,
  QUANTUM_READ_DEADLINE_MS,
  boundedRead,
} from "./pass-snapshot";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { operationIdForKey, operationInputHash } from "../store/store";
import {
  submissionHash,
  legacySubmissionHash,
  explicitCriticalFalseSubmissionHash,
} from "../store/store-submissions";
import { submissionSchema } from "../../shared/contracts";
import { submissionRecordFromLegacy } from "../../shared/schema/settings/legacy";
import { LANE_PRIORITY_AUDIT } from "./lane-priorities";
import type { TaskAttention } from "../../shared/task-attention";
import type {
  ParentArchiveWait,
  TaskRowProjection,
} from "../host/contract/thread-presentation";
import { taskRowAttention } from "../workspaces/task-row-attention";
import { HiddenRows } from "./hidden-row";

const ROW_FAILURE_LABEL = "task row presentation";

/**
 * Finished tasks one host pass catches up on from its slow cursor (Spec 069 §4),
 * and at most as many again of the fresh finishes it still owes. Finished history
 * is visited a page at a time, never all at once.
 */
export const FINISHED_CATCH_UP_PAGE = 25;

/**
 * Passes a fresh finish keeps its prompt catch-up while its thread cleanup is still
 * owed. After that the slow cursor owns its retries, so a cleanup that can never
 * finish does not hold a place every pass.
 */
export const FRESH_FINISH_ATTEMPTS = 3;

/**
 * Passes in a row a host may abort on the same cursor page before the cursor moves
 * past it, so one finished task whose step hangs cannot pin the cursor.
 */
export const PAGE_ABORT_LIMIT = 3;

/** The durable position of one host's finished-history cursor. */
export const finishedCatchUpCursorKey = (host: string) =>
  `finishedCatchUpCursor:${host}`;

function threadSettlementFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const record = error as Error & {
    reason?: unknown;
    diagnostic?: { reason?: unknown };
    field?: unknown;
  };
  const reason = sanitizeHostFailureReason(
    record.reason ?? record.diagnostic?.reason,
  );
  // A compatibility failure's field names the exact structural mismatch (a
  // snapshot name, a dotted decode path, a connection state); the name alone
  // never did. Every field is an adapter-authored constant, never remote text.
  const detail = sanitizeHostFailureDetail(record.field);
  return `${error.name}${reason ? `: ${reason}` : ""}${detail ? ` (${detail})` : ""}`;
}

export type HostPassContext = Pick<
  Engine,
  | "adapter"
  | "host"
  | "inventoryHostMatches"
  | "observeRetiredWorkers"
  | "retiredObservationKey"
  | "retiredObservationPlan"
  | "scheduleLane"
  | "stopped"
  | "store"
> & {
  readonly resolution: Pick<Resolution, "observationTargets"> &
    Partial<
      Pick<
        Resolution,
        | "hostPassWarmBudgetMs"
        | "markPassTimelineBudgetExhausted"
        | "primePassProcesses"
        | "primePassTimeline"
        | "primePassTimelinePage"
        | "recordPassHostInventory"
        | "recordPassHostObservation"
        | "sealPassHost"
        | "storePassTimelinePage"
      >
    >;
};

/** What one host's pass answers the audit pass that called it. */
export type HostPassResult = {
  /** The one bounded inventory read, when this host could answer for it. */
  inventory: ReadonlyMap<string, AgentObservation> | null;
  /** Finished tasks of this pass's page whose thread cleanup is still owed, for the sweep's catch-up step. */
  finishedCatchUp: Map<string, Task>;
  /**
   * The first step this pass that hung or failed at the transport, or null for a
   * clean pass. It failed only its own step: the sweep hands it to HostHealth as a
   * `degraded` sample (Spec 069 §2), and a clean pass is the healthy reading that
   * clears one. Neither ever marks the host down or writes its tasks.
   */
  callFault: unknown;
};

/**
 * One host's audit steps: settlements and thread presentation, the bounded
 * observation inventory, retired-worker observation, title reconciliation and
 * the finished-thread catch-up selection. They are per-host work, so the sweep
 * owns only the order it visits hosts in.
 *
 * A step that throws is recorded on the store as `hostPassError` and the host's
 * later steps still run: one host's fault never stalls the fleet sweep, and it
 * never disappears with the promise either.
 */
export class HostPass {
  constructor(readonly context: HostPassContext) {}
  private get store() {
    return this.context.store;
  }
  private get adapter() {
    return this.context.adapter;
  }
  /**
   * Each host's first hung or transport-failed step this pass. One pass visits its
   * hosts in order and the entry is cleared when a host's pass begins, so a sample
   * never outlives the pass that made it and never answers for another host.
   */
  private readonly callFaults = new Map<string, unknown>();

  /**
   * The pass's rows: one per task this host presents, from the one attention
   * projection (nucleus#1366). They are derived before any write so the row step and
   * the title step read the same facts and a row fault cannot leave a partial
   * reading behind (nucleus#1443). A finished task's row costs no runs read.
   */
  private taskRows(tasks: readonly Task[]): TaskRowProjection[] {
    return tasks.map((task) => ({
      task,
      attention: taskRowAttention(this.store, task),
    }));
  }

  /**
   * The live tasks of this host that have a thread (Spec 069 §4): the active set
   * (holding a slot, workspace, run or retained role) on this host. A queued task
   * that never started has no thread to present, and finished history is the slow
   * cursor's, so neither costs a row, title or hidden-row read here.
   */
  private presentedTasks(host: string): Task[] {
    return this.store
      .activeCapacityTasks()
      .filter((task) => task.hostId === host);
  }

  /**
   * The finished tasks this pass catches up on (Spec 069 §4): up to a page of the
   * finishes this host still owes a prompt catch-up, then one page from its durable
   * slow cursor. Finishes seen since the last pass go first; the start-up seed and
   * retries queue behind them, so a backlog never delays a new finish. A finish
   * keeps its place until its thread cleanup is no longer owed or it has had
   * `FRESH_FINISH_ATTEMPTS` passes; after that, and for all older history, a retry
   * waits for the cursor to come round again (finished tasks ÷ page passes). No pass
   * reads more than two pages of history.
   */
  private finishedCatchUp(host: string): {
    tasks: Task[];
    settle: (owing: ReadonlySet<string> | null) => void;
  } {
    let queues = this.catchUpQueues.get(host);
    if (!queues)
      this.catchUpQueues.set(
        host,
        (queues = { fresh: new Map(), backlog: new Map() }),
      );
    const { fresh, backlog } = queues;
    // A service start has no hints in memory, so the first pass on a host reads,
    // once, every finished task still owing thread cleanup, most recent finish first:
    // a task that finished just before a roll is at the head of the backlog.
    if (!this.seededHosts.has(host)) {
      this.seededHosts.add(host);
      const owing = finishedThreadCleanupCatchUp(
        this.store,
        host,
        removesThreads(this.adapter),
      ).sort((left, right) =>
        (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""),
      );
      for (const task of owing)
        if (!fresh.has(task.id) && !backlog.has(task.id))
          backlog.set(task.id, 0);
    }
    for (const task of this.store.takeRecentlyFinishedHostTasks(
      host,
      Number.MAX_SAFE_INTEGER,
    )) {
      backlog.delete(task.id);
      if (!fresh.has(task.id)) fresh.set(task.id, 0);
    }
    const hinted: Array<{ task: Task; attempts: number }> = [];
    for (const queue of [fresh, backlog])
      for (const [id, attempts] of [...queue]) {
        if (hinted.length >= FINISHED_CATCH_UP_PAGE) break;
        const task = this.store.taskOrNull(id);
        if (
          !task ||
          task.removedAt != null ||
          task.hostId !== host ||
          !["done", "cancelled"].includes(task.phase)
        ) {
          queue.delete(id);
          continue;
        }
        hinted.push({ task, attempts });
      }
    const key = finishedCatchUpCursorKey(host);
    let after = this.store.getMeta<string>(key) || null;
    // One finished task whose step hangs every time must not pin the cursor: after
    // `PAGE_ABORT_LIMIT` passes in a row aborted on the same page, it moves on.
    const aborts = this.pageAborts.get(host);
    const count = aborts && aborts.after === after ? aborts.count + 1 : 0;
    if (count >= PAGE_ABORT_LIMIT) {
      const stuck = this.store.finishedHostTaskPage(
        host,
        after,
        FINISHED_CATCH_UP_PAGE,
      );
      this.store.setMeta(key, stuck.next ?? "");
      after = stuck.next;
      this.pageAborts.set(host, { after, count: 0 });
    } else this.pageAborts.set(host, { after, count });
    const page = this.store.finishedHostTaskPage(
      host,
      after,
      FINISHED_CATCH_UP_PAGE,
    );
    const byId = new Map(hinted.map(({ task }) => [task.id, task]));
    for (const task of page.tasks) byId.set(task.id, task);
    return {
      tasks: [...byId.values()],
      // Called only when the pass reached its end: an aborted pass keeps both the
      // cursor's page and every hint for the next pass.
      settle: (owing) => {
        this.pageAborts.delete(host);
        if ((page.next ?? "") !== (after ?? ""))
          this.store.setMeta(key, page.next ?? "");
        // A paused pass selects no cleanup, so it spends no hint's attempt.
        if (!owing) return;
        for (const { task, attempts } of hinted) {
          fresh.delete(task.id);
          backlog.delete(task.id);
          // Still owed and still within its attempts: back of the backlog.
          if (owing.has(task.id) && attempts + 1 < FRESH_FINISH_ATTEMPTS)
            backlog.set(task.id, attempts + 1);
        }
      },
    };
  }
  /**
   * The finishes each host still owes a prompt catch-up, with the passes each has
   * had: `fresh` holds those seen since the last pass and goes first; `backlog`
   * holds the start-up seed and retries. A task leaves once its thread cleanup is no
   * longer owed or its attempts are spent.
   */
  private readonly catchUpQueues = new Map<
    string,
    { fresh: Map<string, number>; backlog: Map<string, number> }
  >();
  private readonly seededHosts = new Set<string>();
  /** Consecutive aborted passes on one host's current cursor page. */
  private readonly pageAborts = new Map<
    string,
    { after: string | null; count: number }
  >();

  /** Refresh host thread titles and Inbox offers after a sweep opens a new decision. */
  async reconcileInboxTitles(host: string): Promise<void> {
    if (!this.adapter.reconcileThreadTitles) return;
    const tasks = this.presentedTasks(host);
    await this.step(host, "reconcileThreadTitles", () =>
      this.adapter.reconcileThreadTitles?.(tasks, this.taskRows(tasks)),
    );
  }

  /**
   * The task's one row, from the one attention projection (nucleus#1366): a person
   * who must act unsnoozes it, a task that waits on nothing Nucleus runs snoozes it,
   * and a running role leaves it alone. A host without the presentation method
   * (Paseo) keeps its own behaviour. Presentation only: a warning here never
   * changes a task.
   */
  private async reconcileTaskRows(
    rows: readonly TaskRowProjection[],
  ): Promise<void> {
    const reconcile = this.adapter.reconcileTaskRow;
    if (!reconcile) return;
    const rank = (state: TaskAttention["state"]) =>
      state === "active" || state === "attention"
        ? 0
        : state === "waiting"
          ? 1
          : 2;
    const ordered = [...rows].sort(
      (left, right) => rank(left.attention.state) - rank(right.attention.state),
    );
    for (const { task, attention } of ordered) {
      try {
        await reconcile.call(this.adapter, task.id, attention);
      } catch (error) {
        // A timeout or a transport-boundary failure is about the host, not this
        // task's row: the step's own classification samples it for HostHealth, so it
        // must not be swallowed as one task's presentation warning.
        if (hostTimedOut(error)) throw error;
        if (isTransportFailure(error)) throw error;
        this.store.event(
          task.id,
          "thread_row_warning",
          `${ROW_FAILURE_LABEL} for ${task.id} failed: ${threadSettlementFailureReason(error)}`.slice(
            0,
            4000,
          ),
        );
      }
    }
  }

  /**
   * One host's steps in the audit pass's order. A step that throws is recorded
   * here, and the host's later steps still run.
   */
  private readonly terminalOperationCursor = new Map<string, number>();
  private readonly lastRunProcessSweep = new Map<string, number>();
  /** Per-host rotating offset so timeline warming stays fair across passes. */
  private readonly warmOffset = new Map<string, number>();

  async run(host: string): Promise<HostPassResult> {
    // The pass's own task list is what the host's thread observation is scoped to:
    // a thread whose task is over is not read again, and every read this pass makes
    // is shared by its consumers. A host that does not present threads ignores it.
    // It is the host's live set (Spec 069 §4): finished history is never copied here.
    const tasks = this.store.liveHostTasks(host);
    this.callFaults.delete(host);
    let passed: Omit<HostPassResult, "callFault"> = {
      inventory: null,
      finishedCatchUp: new Map(),
    };
    try {
      await this.step(host, "beginHostPass", () =>
        this.adapter.beginHostPass?.(tasks),
      );
      try {
        passed = await this.hostPass(host);
      } finally {
        await this.step(host, "endHostPass", () =>
          this.adapter.endHostPass?.(),
        );
      }
    } catch (error) {
      // A hung call stops this host's pass, and only it (Spec 069 §2): the rest of
      // this host's steps would wait out the same deadline. The host is not down;
      // its health reads the sample and its owners retry on the next pass.
      if (!hostTimedOut(error)) throw error;
    }
    return { ...passed, callFault: this.callFaults.get(host) ?? null };
  }

  /** The pass's steps, between a host's `beginHostPass` and its `endHostPass`. */
  private async hostPass(
    host: string,
  ): Promise<Omit<HostPassResult, "callFault">> {
    const result: Omit<HostPassResult, "callFault"> = {
      inventory: null,
      finishedCatchUp: new Map(),
    };
    // Spec 069 §4: the pass presents this host's live tasks that have a thread, and
    // catches up on a bounded page of finished ones. Neither grows with history.
    // Each step reads the set afresh, so a write an earlier step made (an escalation
    // the hidden-row step raised) is what the rows after it present.
    const catchUp = this.finishedCatchUp(host);
    const finished = catchUp.tasks;
    const presented = (): Task[] => {
      // One row per task: a finished task reopened since the page was read is
      // presented once, from the live set.
      const byId = new Map(
        this.presentedTasks(host).map((task) => [task.id, task]),
      );
      for (const task of finished) {
        if (byId.has(task.id)) continue;
        const current = this.store.taskOrNull(task.id);
        if (current && current.removedAt == null) byId.set(current.id, current);
      }
      return [...byId.values()];
    };
    // The terminal owner settles every finished parent's archive first, from the host's
    // durable parent bindings (nucleus#1459). It is its own step before any presentation
    // read, so an Inbox, decision-card, row or title fault — or this pass timing out
    // further along — can never leave a done task's parent in the operator's snoozed
    // list, and one parent's uncertain delivery stays that parent's wait.
    await this.step(host, "reconcileFinishedParents", async () => {
      // Spec 069 §4: the adapter selects from its own open bindings and resolves
      // each through the store's single-task read, so the obligation survives a
      // roll and a batch that did not reach every finish loses none of them. A
      // removed task is not resolved, as before.
      const waits = await this.adapter.reconcileFinishedParents?.(
        finished,
        (taskId) => {
          const task = this.store.taskOrNull(taskId);
          return task && task.removedAt == null ? task : null;
        },
      );
      for (const wait of waits ?? []) this.recordParentArchiveWait(host, wait);
    });
    // Read one rotating page, including unresolved rows, so an unprovable
    // submission cannot starve later work. Settled occurrences stay history.
    await this.step(host, "settleTerminalOperations", () => {
      const cursor = this.terminalOperationCursor.get(host) ?? 0;
      // Page unresolved candidates, not the entire historical ledger. A fresh
      // service must not spend thousands of passes walking settled operations.
      const candidates = this.store.db
        .prepare(
          "SELECT rowid AS position, id FROM operations WHERE rowid>? AND state='needs_attention' AND kind IN ('submit','task_control') AND NOT COALESCE(json_extract(data,'$.settlement.id')=id AND json_extract(data,'$.settlement.inputHash')=inputHash AND json_extract(data,'$.settlement.attempt')=json_extract(data,'$.attempts') AND json_extract(data,'$.settlement.intentAt') IS json_extract(data,'$.effect.intentAt') AND json_type(data,'$.settlement.evidence')='text',0) ORDER BY rowid LIMIT 25",
        )
        .all(cursor);
      this.terminalOperationCursor.set(
        host,
        candidates.length
          ? Number(candidates[candidates.length - 1]!.position)
          : 0,
      );
      for (const row of candidates)
        this.store.transaction(() => {
          let operation = this.store.operation(String(row.id));
          if (
            !operation ||
            operation.state !== "needs_attention" ||
            !["submit", "task_control"].includes(operation.kind)
          )
            return;
          const taskRow = operation.taskId
            ? this.store.db
                .prepare("SELECT id FROM tasks WHERE id=?")
                .get(operation.taskId)
            : operation.kind === "submit" && operation.submissionId
              ? this.store.db
                  .prepare("SELECT id FROM tasks WHERE submission=?")
                  .get(operation.submissionId)
              : undefined;
          if (!taskRow) {
            // Retention preserves submission identity and terminal state in a
            // tombstone after removing the task and its run history. Never infer
            // a result from absence alone or replay a command.
            if (
              operation.hostId !== host ||
              operation.attempts !== 1 ||
              operation.result ||
              operation.id !== operationIdForKey(operation.key)
            )
              return;
            const payload = this.store.operationPayload(operation.id) as {
              type?: string;
              submission?: unknown;
              control?: { action?: string; taskId?: string; version?: number };
            } | null;
            if (!payload || operation.inputHash !== operationInputHash(payload))
              return;
            const tombstone =
              operation.kind === "submit" && operation.submissionId
                ? this.store.db
                    .prepare(
                      "SELECT id, input_hash, data FROM tombstones WHERE submission=?",
                    )
                    .get(operation.submissionId)
                : operation.taskId
                  ? this.store.db
                      .prepare(
                        "SELECT id, input_hash, data FROM tombstones WHERE id=?",
                      )
                      .get(operation.taskId)
                  : undefined;
            if (!tombstone) return;
            const record = JSON.parse(String(tombstone.data)) as {
              phase?: string;
            };
            if (!["done", "cancelled"].includes(record.phase ?? "")) return;
            if (operation.kind === "task_control") {
              // The same historical fence decision already used by recovery
              // proves this execution refused before its effect.
              if (
                !historicalFenceRefusal(operation) ||
                payload.type !== "task_control" ||
                payload.control?.taskId !== operation.taskId ||
                payload.control?.version !== operation.expectedVersion ||
                operation.effect?.kind !== "task_control" ||
                operation.effect.target !== payload.control?.action ||
                operation.effect.status !== "uncertain" ||
                operation.effect.result !== operation.diagnostic.slice(0, 2000)
              )
                return;
              this.store.putOperation({
                ...operation,
                settlement: {
                  id: operation.id,
                  inputHash: operation.inputHash,
                  attempt: operation.attempts,
                  intentAt: operation.effect?.intentAt ?? null,
                  evidence: operation.diagnostic,
                  kind: "refused",
                },
              });
              return;
            }
            let parsed: ReturnType<typeof submissionSchema.safeParse>;
            try {
              parsed = submissionSchema.safeParse(
                submissionRecordFromLegacy(
                  payload.submission,
                  "submit operation",
                ),
              );
            } catch {
              return;
            }
            if (
              payload.type !== "submit" ||
              !parsed.success ||
              operation.effect ||
              (operation.taskId && operation.taskId !== String(tombstone.id)) ||
              operation.key !== `submit:${parsed.data.submissionId}` ||
              operation.submissionId !== parsed.data.submissionId ||
              ![
                submissionHash(parsed.data),
                legacySubmissionHash(parsed.data),
                explicitCriticalFalseSubmissionHash(parsed.data),
              ].includes(String(tombstone.input_hash))
            )
              return;
            const evidence = `matching submission belongs to retained terminal tombstone ${record.phase}`;
            const settlement = {
              id: operation.id,
              inputHash: operation.inputHash,
              attempt: operation.attempts,
              intentAt: null,
              evidence,
              kind: "superseded" as const,
            };
            operation = this.store.putOperation({
              ...operation,
              taskId: String(tombstone.id),
              settlement,
            });
            this.store.event(
              String(tombstone.id),
              "operation_superseded",
              JSON.stringify(settlement),
            );
            return;
          }
          const task = this.store.task(String(taskRow.id));
          if (
            task.hostId !== host ||
            (operation.hostId && operation.hostId !== host) ||
            !["done", "cancelled"].includes(task.phase)
          )
            return;
          const payload = this.store.operationPayload(operation.id) as {
            type?: string;
            submission?: unknown;
            control?: { action?: string; taskId?: string };
          } | null;
          if (
            !payload ||
            operation.id !== operationIdForKey(operation.key) ||
            operation.inputHash !== operationInputHash(payload)
          )
            return;
          if (operation.kind === "submit") {
            let parsed: ReturnType<typeof submissionSchema.safeParse>;
            try {
              parsed = submissionSchema.safeParse(
                submissionRecordFromLegacy(
                  payload.submission,
                  "submit operation",
                ),
              );
            } catch {
              return;
            }
            if (
              payload.type !== "submit" ||
              !parsed.success ||
              operation.submissionId !== parsed.data.submissionId ||
              operation.key !== `submit:${parsed.data.submissionId}`
            )
              return;
            try {
              if (this.store.existing(parsed.data)?.id !== task.id) return;
            } catch {
              return;
            }
            if (operation.taskId && operation.taskId !== task.id) return;
            if (!operation.taskId)
              operation = this.store.putOperation({
                ...operation,
                taskId: task.id,
              });
          } else {
            if (
              operation.taskId !== task.id ||
              payload.control?.taskId !== task.id
            )
              return;
            // The shared recovery decision recognises recorded restart
            // supersessions; cleanup and other controls remain applicable.
            if (
              operation.effect?.kind !== "task_control" ||
              operation.effect.target !== "restart" ||
              payload.control.action !== "restart"
            )
              return;
          }
          if (hasRecordedOperationSettlement(this.store, task, operation))
            return;
          const evidence =
            operation.kind === "task_control"
              ? observedHostEffectEvidence(this.store, task, operation)
              : null;
          if (operation.kind === "task_control" && !evidence) return;
          const settlement = {
            id: operation.id,
            inputHash: operation.inputHash,
            attempt: operation.attempts,
            intentAt: operation.effect?.intentAt ?? null,
            evidence:
              evidence ??
              `matching submission belongs to terminal task ${task.phase}`,
            kind: "superseded" as const,
          };
          this.store.putOperation({ ...operation, settlement });
          this.store.event(
            task.id,
            "operation_superseded",
            JSON.stringify({
              ...settlement,
              intentAt: operation.effect?.intentAt,
            }),
          );
        });
    });
    // The row's own visibility first: a Nucleus-owned snooze that stays on past its
    // bound is reported to the planner, and a planner's own hold whose nudge went
    // unanswered is escalated here (nucleus#1417, nucleus#1419). It reads the host's
    // durable snooze record and the attention projection, never the presentation
    // step's outcome, so a failed presentation pass cannot suppress the notice; and
    // running it first lets this same pass's rows see an escalation, so the row
    // wakes in the pass that decided it.
    await this.step(host, "reconcileHiddenRows", () =>
      new HiddenRows({ store: this.store, adapter: this.adapter }).observe(
        host,
        presented(),
      ),
    );
    // The pass derives its rows once, before it writes anything, and both the row
    // step and the title step read that same projection (nucleus#1443): a row write
    // that fails partway leaves the titles reading the whole host, never a count of
    // how many writes had landed. A host that presents neither pays for no rows, and
    // a projection fault stays inside the step that first needed it.
    let derived: readonly TaskRowProjection[] | undefined;
    const rows = (): readonly TaskRowProjection[] =>
      (derived ??=
        this.adapter.reconcileTaskRow || this.adapter.reconcileThreadTitles
          ? this.taskRows(presented())
          : []);
    await this.step(host, "reconcileTaskRows", () =>
      this.reconcileTaskRows(rows()),
    );
    await this.step(host, "reconcileThreadTitles", () =>
      this.adapter.reconcileThreadTitles?.(
        rows().map((row) => row.task),
        rows(),
      ),
    );
    // Audit A6: one bounded labelled inventory answers every identity this
    // pass observes, and retired workers are re-read on their own slow cadence.
    // A list that cannot be walked to its end answers nothing, so every
    // identity falls back to the narrow read and no inactivity is inferred.
    const retiredPlan = this.context.retiredObservationPlan();
    const inventoryIds = [
      ...new Set([
        ...retiredPlan.due,
        ...this.context.resolution.observationTargets(),
      ]),
    ];
    let observed: ReadonlyMap<string, AgentObservation> | null = null;
    if (inventoryIds.length && this.adapter.observationInventory) {
      // The inventory is optional, so a list that cannot be read answers nothing
      // and every identity falls back to the narrow read. It is still a host read,
      // so its own failure is this pass's to classify (nucleus#1469): the step
      // keeps an unavailable inventory distinct from transport loss, which is a
      // HostHealth sample, and reports both as `hostPassError`.
      // A timeout keeps stopping the pass, as every other host step's does.
      await this.step(host, "observationInventory", async () => {
        observed = await this.context.host.observationInventory(inventoryIds);
      });
    }
    // Record the pre-process inventory on the pass snapshot BEFORE capturing
    // the process table so owned-tool proofs can verify whether a participant
    // was already idle before the process snapshot was taken (Spec 068 §6).
    this.context.resolution.recordPassHostInventory?.(host, observed);
    // Live inventories (such as Paseo's) omit archived agents. Collect exact
    // terminal observations for retained participants missing from `observed`
    // BEFORE `processSnapshot` runs so archived/gone participants can clear
    // their scratch-process proof against the scan that follows.
    const hostTasks = presented();
    const activeTasks = hostTasks.filter(
      (task) => !task.removedAt && !["done", "cancelled"].includes(task.phase),
    );
    const warmBudgetMs =
      this.context.resolution.hostPassWarmBudgetMs ?? HOST_PASS_WARM_BUDGET_MS;
    const warmDeadlineAt = Date.now() + Math.max(0, warmBudgetMs);
    const budgetRemaining = (): number => {
      const remaining = warmDeadlineAt - Date.now();
      if (remaining <= 0) {
        this.context.resolution.markPassTimelineBudgetExhausted?.(
          host,
          `host pass timeline warming budget (${warmBudgetMs} ms) exhausted`,
        );
        return 0;
      }
      return remaining;
    };
    const perCandidateCap = (count: number): number => {
      const remaining = budgetRemaining();
      if (remaining <= 0) return 0;
      return count > 1
        ? Math.min(remaining, Math.max(1, Math.ceil(warmBudgetMs / 2)))
        : remaining;
    };
    const rotate = <T>(items: T[], offset: number): T[] => {
      if (items.length <= 1) return items;
      const start = offset % items.length;
      return start === 0
        ? items
        : [...items.slice(start), ...items.slice(0, start)];
    };
    const passOffset = this.warmOffset.get(host) ?? 0;
    this.warmOffset.set(host, passOffset + 1);

    if (
      this.adapter.originAgent &&
      this.context.resolution.recordPassHostObservation &&
      activeTasks.length
    ) {
      const observedMap = observed as ReadonlyMap<
        string,
        AgentObservation
      > | null;
      const missingRetained: Array<{ agentId: string; workspaceId: string }> =
        [];
      const seenRetained = new Set<string>();
      for (const task of activeTasks) {
        for (const [agentId, workspaceId] of executionParticipants(
          task,
          this.store.runs(task.id),
        )) {
          if (observedMap?.has(agentId) || seenRetained.has(agentId)) continue;
          seenRetained.add(agentId);
          missingRetained.push({ agentId, workspaceId });
        }
      }
      if (missingRetained.length) {
        const orderedRetained = rotate(missingRetained, passOffset).slice(
          0,
          HOST_PASS_WARM_CANDIDATE_CAP,
        );
        await this.step(host, "retainedTerminalObservations", async () => {
          for (const candidate of orderedRetained) {
            await yieldToLoop();
            if (this.context.stopped) return;
            const cap = perCandidateCap(orderedRetained.length);
            if (cap <= 0) return;
            const originRead = await boundedRead(
              "origin agent observation",
              () => this.context.host.originAgent(candidate.agentId),
              Math.min(cap, QUANTUM_READ_DEADLINE_MS),
            ).catch(() => ({
              state: "unknown" as const,
              reason: "origin read failed",
            }));
            if (originRead.state === "unknown") continue;
            const origin = originRead.value;
            if (!origin || origin.deleted === true) {
              this.context.resolution.recordPassHostObservation!(
                host,
                candidate.agentId,
                {
                  id: candidate.agentId,
                  workspaceId: origin?.workspaceId ?? candidate.workspaceId,
                  status: "gone",
                  active: false,
                  activeTurnId: null,
                  permissions: false,
                  error: "",
                  archived: true,
                },
              );
            } else if (origin.archived === true) {
              this.context.resolution.recordPassHostObservation!(
                host,
                candidate.agentId,
                {
                  id: candidate.agentId,
                  workspaceId: origin.workspaceId,
                  status: "closed",
                  active: false,
                  activeTurnId: null,
                  permissions: false,
                  error: "",
                  archived: true,
                },
              );
            }
          }
        });
      }
    }
    // Spec 068 §6 / Spec 066 R1: one shared process-table snapshot per host
    // pass, bounded by its deadline. Captured AFTER inventory and retained
    // terminal observations so every pre-process observation predates the scan.
    if (
      this.adapter.hostProcessListing &&
      this.context.resolution.primePassProcesses &&
      activeTasks.length
    ) {
      await yieldToLoop();
      if (!this.context.stopped) {
        await this.step(host, "processSnapshot", () =>
          this.context.resolution.primePassProcesses!(host),
        );
      }
    }
    // Schedule settled-run process cleanup AFTER `processSnapshot` so cleanup's
    // initial scan shares the already-primed pass snapshot instead of racing
    // ahead of inventory and terminal observation collection.
    if (this.adapter.hostProcessListing) {
      const historical =
        Date.now() - (this.lastRunProcessSweep.get(host) ?? 0) >= 3_600_000;
      if (historical) this.lastRunProcessSweep.set(host, Date.now());
      let usedPassSnapshot = false;
      const primePass = this.context.resolution.primePassProcesses;
      void this.context
        .scheduleLane(
          `cleanup:${host}`,
          LANE_PRIORITY_AUDIT,
          () =>
            sweepSettledRunProcesses(this.store, host, {
              pendingOnly: !historical,
              readProcesses: async () => {
                if (!usedPassSnapshot && primePass) {
                  usedPassSnapshot = true;
                  const read = await primePass(host);
                  return read.state === "listed" ? read.processes : null;
                }
                return this.adapter.hostProcessListing!();
              },
            }),
          {
            coalesce: historical
              ? "historical-run-process-cleanup"
              : "settled-run-process-cleanup",
          },
        )
        .catch((error) => {
          if (this.context.stopped) return;
          const detail = error instanceof Error ? error.message : String(error);
          this.store.setMeta(
            "hostPassError",
            `${host}/settledRunProcesses: ${detail}`.slice(0, 2000),
          );
        });
    }
    // Spec 068 §6: pre-read timelines needed by this host's tasks into the
    // pass's shared snapshot under a single bounded per-host budget, rotating
    // candidate order across passes so a persistently slow candidate cannot
    // starve healthy candidates on the same host.
    let warmed = 0;
    const canWarmMore = (): boolean =>
      !this.context.stopped &&
      warmed < HOST_PASS_WARM_CANDIDATE_CAP &&
      budgetRemaining() > 0;

    if (
      this.adapter.originAgent &&
      this.adapter.agentTimelinePage &&
      this.context.resolution.primePassTimelinePage &&
      canWarmMore()
    ) {
      // Delivery timelines are primed ONLY after proving the agent is already
      // terminal (archived or closed) in its recorded workspace, carrying
      // `closedUpdatedAt` for resumable closed threads so an earlier closure
      // can never settle a later resumed turn's delivery as absent.
      const deliveryCandidates: Array<{
        agentId: string;
        workspaceId: string;
      }> = [];
      const seenDelivery = new Set<string>();
      for (const task of hostTasks) {
        if (task.removedAt) continue;
        for (const run of this.store.runs(task.id)) {
          if (
            run.released &&
            run.status === "uncertain" &&
            run.agentId &&
            run.workspaceId &&
            !seenDelivery.has(run.agentId) &&
            !releasedRunDeliveryEvidence(this.store, run)
          ) {
            seenDelivery.add(run.agentId);
            deliveryCandidates.push({
              agentId: run.agentId,
              workspaceId: run.workspaceId,
            });
          }
        }
      }
      if (deliveryCandidates.length) {
        const orderedDelivery = rotate(deliveryCandidates, passOffset);
        await this.step(host, "timelineDeliverySnapshot", async () => {
          for (const candidate of orderedDelivery) {
            await yieldToLoop();
            if (!canWarmMore()) return;
            const originCap = perCandidateCap(orderedDelivery.length);
            if (originCap <= 0) return;
            const originRead = await boundedRead(
              "origin agent observation",
              () => this.context.host.originAgent(candidate.agentId),
              originCap,
            ).catch(() => ({
              state: "unknown" as const,
              reason: "origin read failed",
            }));
            if (originRead.state === "unknown") {
              if (budgetRemaining() <= 0) return;
              continue;
            }
            const origin = originRead.value;
            if (!origin || origin.workspaceId !== candidate.workspaceId)
              continue;
            const archived = origin.archived === true;
            let closedUpdatedAt: string | null | undefined;
            if (!archived) {
              const obsCap = perCandidateCap(orderedDelivery.length);
              if (obsCap <= 0) return;
              const obsRead = await boundedRead(
                "participant observation",
                () => this.context.host.observe(candidate.agentId),
                obsCap,
              ).catch(() => ({
                state: "unknown" as const,
                reason: "observe failed",
              }));
              if (obsRead.state === "unknown") {
                if (budgetRemaining() <= 0) return;
                continue;
              }
              const state = obsRead.value;
              if (
                state.id !== candidate.agentId ||
                state.workspaceId !== candidate.workspaceId ||
                state.status !== "closed" ||
                state.active ||
                state.activeTurnId ||
                state.permissions
              )
                continue;
              closedUpdatedAt = state.updatedAt ?? null;
            }
            const pageCap = perCandidateCap(orderedDelivery.length);
            if (pageCap <= 0) return;
            warmed++;
            const pageRead = await this.context.resolution
              .primePassTimelinePage!(candidate.agentId, 100, host, {
              provenTerminal: {
                archived,
                workspaceId: candidate.workspaceId,
                ...(archived ? {} : { closedUpdatedAt }),
              },
              deadlineMs: pageCap,
            }).catch(() => null);
            if (pageRead?.state === "unknown" && budgetRemaining() <= 0) return;
          }
        });
      }
    }
    if (
      this.adapter.agentTimelinePage &&
      this.context.resolution.primePassTimelinePage &&
      canWarmMore()
    ) {
      // Pre-warm tool timeline pages at TOOL_TIMELINE_LIMIT (200) for
      // historical proof executor runs and non-terminal participants,
      // expanding partial pages inside HostPass so task quanta never start
      // timeline RPCs on their exclusive lanes.
      const toolCandidates: Array<{
        agentId: string;
        coveredObservation?: {
          updatedAt?: string | null;
          status?: string;
          archived?: boolean;
        };
      }> = [];
      const seenTool = new Set<string>();
      const addTool = (
        agentId: string,
        state?: AgentObservation | null,
      ): void => {
        if (seenTool.has(agentId)) return;
        seenTool.add(agentId);
        toolCandidates.push({
          agentId,
          ...(state
            ? {
                coveredObservation: {
                  updatedAt: state.updatedAt ?? null,
                  status: state.status,
                  archived: state.archived,
                },
              }
            : {}),
        });
      };
      const observedMap = observed as ReadonlyMap<
        string,
        AgentObservation
      > | null;
      for (const task of activeTasks) {
        const runs = this.store.runs(task.id);
        for (const run of runs) {
          if (
            run.role === "executor" &&
            run.proofExecution &&
            run.agentId &&
            (task.proofExecutions ?? []).some(
              (item) => item.runId === run.id && item.status === "running",
            )
          )
            addTool(run.agentId, observedMap?.get(run.agentId));
        }
        for (const [agentId] of executionParticipants(task, runs)) {
          const state = observedMap?.get(agentId) ?? null;
          if (state) {
            if (
              noTurnLive(state) ||
              state.status === "closed" ||
              state.status === "gone" ||
              state.archived === true
            )
              addTool(agentId, state);
          } else if (
            !observedMap ||
            [
              "verifying",
              "merging",
              "syncing",
              "closing",
              "awaiting_review",
              "reviewing",
              "changes_requested",
              "needs_attention",
            ].includes(task.phase) ||
            Boolean(task.completion)
          ) {
            addTool(agentId, null);
          }
        }
      }
      if (toolCandidates.length) {
        const orderedTools = rotate(toolCandidates, passOffset);
        await this.step(host, "timelineToolSnapshot", async () => {
          for (const candidate of orderedTools) {
            await yieldToLoop();
            if (!canWarmMore()) return;
            const cap = perCandidateCap(orderedTools.length);
            if (cap <= 0) return;
            let coveredObservation = candidate.coveredObservation;
            if (!coveredObservation) {
              const obsRead = await boundedRead(
                "participant observation",
                () => this.context.host.observe(candidate.agentId),
                cap,
              ).catch(() => ({
                state: "unknown" as const,
                reason: "observe failed",
              }));
              if (obsRead.state !== "ok") {
                if (budgetRemaining() <= 0) return;
                continue;
              }
              const s = obsRead.value;
              if (s.active || s.permissions || s.activeTurnId) continue;
              coveredObservation = {
                updatedAt: s.updatedAt ?? null,
                status: s.status,
                archived: s.archived,
              };
            }
            const pageCap = perCandidateCap(orderedTools.length);
            if (pageCap <= 0) return;
            warmed++;
            const firstRead = await this.context.resolution
              .primePassTimelinePage!(
              candidate.agentId,
              TOOL_TIMELINE_LIMIT,
              host,
              {
                coveredObservation,
                deadlineMs: pageCap,
              },
            ).catch(() => null);
            if (firstRead?.state === "unknown") {
              if (budgetRemaining() <= 0) return;
              continue;
            }
            // If the 200-entry page is partial (`hasOlder === true` and not
            // bounded), expand it here in HostPass within the remaining budget
            // so the task lane does not issue widening RPCs.
            let page = firstRead?.state === "ok" ? firstRead.value : null;
            let limit = TOOL_TIMELINE_LIMIT;
            for (
              let step = 1;
              step < TOOL_TIMELINE_READ_BUDGET &&
              page &&
              page.hasOlder === true &&
              page.projection !== "bounded" &&
              !page.gap &&
              !page.staleCursor &&
              !page.reset &&
              budgetRemaining() > 0 &&
              !this.context.stopped;
              step++
            ) {
              limit = Math.max(limit, page.entries.length) * 2;
              const expandCap = perCandidateCap(orderedTools.length);
              if (expandCap <= 0) break;
              const expanded = await boundedRead(
                "agent timeline page",
                () =>
                  this.context.host.agentTimelinePage(candidate.agentId, limit),
                expandCap,
              ).catch(() => ({
                state: "unknown" as const,
                reason: "expand failed",
              }));
              if (expanded.state === "unknown") break;
              this.context.resolution.storePassTimelinePage?.(
                host,
                candidate.agentId,
                limit,
                {
                  ...expanded,
                  capturedAt: Date.now(),
                  fromPassSnapshot: true,
                  ...(coveredObservation ? { coveredObservation } : {}),
                },
              );
              page = expanded.value;
            }
          }
        });
      }
    }
    if (
      this.adapter.agentTimeline &&
      this.context.resolution.primePassTimeline &&
      canWarmMore()
    ) {
      const shellAgents: string[] = [];
      const seenShell = new Set<string>();
      const addShell = (agentId: string): void => {
        if (seenShell.has(agentId)) return;
        seenShell.add(agentId);
        shellAgents.push(agentId);
      };
      const nowMs = Date.now();
      const stallMinutes = this.store.getMeta<number>("stallThresholdMinutes");
      const stallThresholdMs =
        typeof stallMinutes === "number" &&
        Number.isFinite(stallMinutes) &&
        stallMinutes > 0
          ? stallMinutes * 60_000
          : 30 * 60_000;
      if (observed) {
        for (const [agentId, state] of observed as ReadonlyMap<
          string,
          AgentObservation
        >) {
          if (!state.active && !state.permissions) continue;
          const turnStartedAt = state.turnStartedAt
            ? Date.parse(state.turnStartedAt)
            : NaN;
          const updatedAt = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
          const longTurn =
            Number.isFinite(turnStartedAt) &&
            nowMs - turnStartedAt >= SHELL_NOTICE_MS;
          const staleTurn =
            Number.isFinite(updatedAt) &&
            nowMs - updatedAt >= Math.min(SHELL_NOTICE_MS, stallThresholdMs);
          if (longTurn || staleTurn) addShell(agentId);
        }
      } else {
        for (const task of activeTasks) {
          if (
            task.agentId &&
            ["working", "reviewing", "needs_attention"].includes(task.phase)
          )
            addShell(task.agentId);
          for (const run of this.store.runs(task.id))
            if (!run.released && run.agentId) addShell(run.agentId);
        }
      }
      if (shellAgents.length) {
        const orderedShells = rotate(shellAgents, passOffset);
        await this.step(host, "timelineShellSnapshot", async () => {
          for (const agentId of orderedShells) {
            await yieldToLoop();
            if (!canWarmMore()) return;
            const cap = perCandidateCap(orderedShells.length);
            if (cap <= 0) return;
            warmed++;
            const read = await this.context.resolution.primePassTimeline!(
              agentId,
              host,
              undefined,
              cap,
            ).catch(() => null);
            if (read?.state === "unknown" && budgetRemaining() <= 0) return;
          }
        });
      }
    }
    // Seal this host's timeline snapshot now that HostPass finished warming so
    // task-lane cache misses return explicit unknown instead of starting new
    // timeline RPCs inside exclusive task lanes (Spec 068 §6).
    this.context.resolution.sealPassHost?.(host);
    const retired = await this.context.observeRetiredWorkers(
      retiredPlan,
      observed,
    );
    if (retired.changed)
      this.store.setMeta(
        this.context.retiredObservationKey(host),
        retired.observations,
      );
    // Select from this pass's page of finished history, but never await cleanup in
    // the shared host pass. The sweep's catch-up step runs them on their task lanes.
    const paused = Boolean(this.store.getMeta("paused"));
    if (!paused)
      for (const task of finishedThreadCleanupCatchUp(
        this.store,
        host,
        removesThreads(this.adapter),
        finished.map((task) => task.id),
      ))
        result.finishedCatchUp.set(task.id, task);
    catchUp.settle(paused ? null : new Set(result.finishedCatchUp.keys()));
    if (this.context.inventoryHostMatches(host)) result.inventory = observed;
    return result;
  }

  /**
   * Record one finished parent the host still owes an archive (nucleus#1459). The typed
   * state and the host's own reason are the operator's evidence, and an unchanged wait is
   * not a new event: the same reason on the next pass says nothing new. The binding keeps
   * the same record, so it survives a roll.
   */
  private recordParentArchiveWait(host: string, wait: ParentArchiveWait): void {
    const key = `parentArchiveWait:${host}:${wait.taskId}`;
    const detail = `${wait.threadId} (${wait.state}): ${wait.reason}`.slice(
      0,
      2000,
    );
    if (this.store.getMeta<string>(key) === detail) return;
    this.store.setMeta(key, detail);
    this.store.event(
      wait.taskId,
      wait.state === "unknown"
        ? "parent_archive_uncertain"
        : "parent_archive_wait",
      detail,
    );
  }

  /** One host step: a throw is recorded here and never stops the host's later steps. */ private async step(
    host: string,
    name: string,
    run: () => Promise<unknown> | unknown,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      // A hung or transport-failed step fails only itself (Spec 069 §2). It is this
      // host's sample for HostHealth, never a verdict on the host or its tasks.
      const timedOut = hostTimedOut(error);
      if ((timedOut || isTransportFailure(error)) && !this.callFaults.has(host))
        this.callFaults.set(host, error);
      const detail = error instanceof Error ? error.message : String(error);
      this.store.setMeta(
        "hostPassError",
        `${host}/${name}: ${detail}`.slice(0, 2000),
      );
      // A hung call stops the host's later steps; `run` ends the pass.
      if (timedOut) throw error;
    }
  }
}
