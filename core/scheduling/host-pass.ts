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
} from "../recovery/recovery-effects";
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
> & { readonly resolution: Pick<Resolution, "observationTargets"> };

/** What one host's pass answers the audit pass that called it. */
export type HostPassResult = {
  /** The one bounded inventory read, when this host could answer for it. */
  inventory: ReadonlyMap<string, AgentObservation> | null;
  /** Finished tasks whose thread cleanup is still owed, for the bounded task window. */
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
   * reading behind (nucleus#1443).
   */
  private taskRows(hostId: string): TaskRowProjection[] {
    return this.store
      .tasks()
      .filter((task) => task.hostId === hostId && task.removedAt == null)
      .map((task) => ({ task, attention: taskRowAttention(this.store, task) }));
  }

  /** Refresh host thread titles and Inbox offers after a sweep opens a new decision. */
  async reconcileInboxTitles(
    host: string,
    tasks: readonly Task[],
  ): Promise<void> {
    if (!this.adapter.reconcileThreadTitles) return;
    await this.step(host, "reconcileThreadTitles", () =>
      this.adapter.reconcileThreadTitles?.(tasks, this.taskRows(host)),
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

  async run(host: string): Promise<HostPassResult> {
    // The pass's own task list is what the host's thread observation is scoped to:
    // a thread whose task is over is not read again, and every read this pass makes
    // is shared by its consumers. A host that does not present threads ignores it.
    const tasks = this.store.tasks().filter((task) => task.hostId === host);
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
        passed = await this.hostPass(host, tasks);
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
    tasks: readonly Task[],
  ): Promise<Omit<HostPassResult, "callFault">> {
    const result: Omit<HostPassResult, "callFault"> = {
      inventory: null,
      finishedCatchUp: new Map(),
    };
    // The terminal owner settles every finished parent's archive first, from the host's
    // durable parent bindings (nucleus#1459). It is its own step before any presentation
    // read, so an Inbox, decision-card, row or title fault — or this pass timing out
    // further along — can never leave a done task's parent in the operator's snoozed
    // list, and one parent's uncertain delivery stays that parent's wait.
    await this.step(host, "reconcileFinishedParents", async () => {
      const waits = await this.adapter.reconcileFinishedParents?.(tasks);
      for (const wait of waits ?? []) this.recordParentArchiveWait(host, wait);
    });
    if (this.adapter.hostProcessListing) {
      const historical =
        Date.now() - (this.lastRunProcessSweep.get(host) ?? 0) >= 3_600_000;
      if (historical) this.lastRunProcessSweep.set(host, Date.now());
      // Process cleanup has its own durable intent and host lane. A slow
      // local probe says nothing about this host's transport or task visits.
      void this.context
        .scheduleLane(
          `cleanup:${host}`,
          LANE_PRIORITY_AUDIT,
          () =>
            sweepSettledRunProcesses(this.store, host, {
              pendingOnly: !historical,
              readProcesses: () => this.adapter.hostProcessListing!(),
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
          ? this.taskRows(host)
          : []);
    await this.step(host, "reconcileTaskRows", () =>
      this.reconcileTaskRows(rows()),
    );
    await this.step(host, "reconcileThreadTitles", () =>
      this.adapter.reconcileThreadTitles?.(tasks, rows()),
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
    const retired = await this.context.observeRetiredWorkers(
      retiredPlan,
      observed,
    );
    if (retired.changed)
      this.store.setMeta(
        this.context.retiredObservationKey(host),
        retired.observations,
      );
    // Select directly from finished history, but never await cleanup in the
    // shared host pass. These tasks join the rotating, bounded task window.
    if (!this.store.getMeta("paused"))
      for (const task of finishedThreadCleanupCatchUp(
        this.store,
        host,
        removesThreads(this.adapter),
      ))
        result.finishedCatchUp.set(task.id, task);
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
