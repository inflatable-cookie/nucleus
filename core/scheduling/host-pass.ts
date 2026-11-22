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
  noTurnLive,
} from "../recovery/stall";
import {
  HOST_PASS_WARM_BUDGET_MS,
  HOST_PASS_WARM_CANDIDATE_CAP,
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
      >
    >;
};

/** What one host's pass answers the audit pass that called it. */
export type HostPassResult = {
  /** The one bounded inventory read, when this host could answer for it. */
  inventory: ReadonlyMap<string, AgentObservation> | null;
  /** Finished tasks whose thread cleanup is still owed, for the bounded task window. */
  finishedCatchUp: Map<string, Task>;
  /**
   * This host's transport answered the whole pass (Spec 066 R1/R6, C2). A step that
   * fails at the transport boundary means it did not: the registry can still claim
   * a connection the socket does not honour, so the pass reads the failure, not the
   * claim. The sweep shares this record with the same host's task visits, and a
   * host that did not answer settles nothing while another host's tasks progress.
   */
  transportAnswered: boolean;
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
   * Hosts whose pass hit the transport boundary. One pass visits its hosts in
   * order, and the entry is cleared when a host's pass begins, so a reading never
   * outlives the pass that made it and never answers for another host.
   */
  private readonly transportFailures = new Set<string>();

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
        // A timeout or a transport-boundary failure is the host's own answer for
        // this pass (Spec 066 R6): the step's own classification records it, so it
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
    this.transportFailures.delete(host);
    await this.step(host, "beginHostPass", () =>
      this.adapter.beginHostPass?.(tasks),
    );
    let passed: Omit<HostPassResult, "transportAnswered"> | null = null;
    try {
      passed = await this.hostPass(host, tasks);
    } finally {
      await this.step(host, "endHostPass", () => this.adapter.endHostPass?.());
    }
    return { ...passed!, transportAnswered: !this.transportFailures.has(host) };
  }

  /** The pass's steps, between a host's `beginHostPass` and its `endHostPass`. */
  private async hostPass(
    host: string,
    tasks: readonly Task[],
  ): Promise<Omit<HostPassResult, "transportAnswered">> {
    const result: Omit<HostPassResult, "transportAnswered"> = {
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
      // Its initial scan shares this host pass's bounded process snapshot so
      // cleanup and task quanta read the process table at most once per pass.
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
      // keeps an unavailable inventory distinct from transport loss, which is the
      // host answering nothing for the pass, and reports both as `hostPassError`.
      // A timeout keeps stopping the pass, as every other host step's does.
      await this.step(host, "observationInventory", async () => {
        observed = await this.context.host.observationInventory(inventoryIds);
      });
    }
    // Record the pre-process inventory on the pass snapshot BEFORE capturing
    // the process table so owned-tool proofs can verify whether a participant
    // was already idle before the process snapshot was taken (Spec 068 §6).
    this.context.resolution.recordPassHostInventory?.(host, observed);
    // Spec 068 §6 / Spec 066 R1: one shared process-table snapshot per host
    // pass, bounded by its deadline. Task quanta on this host read the pass's
    // snapshot instead of each spawning `ps`/`lsof`/env reads in the task lane.
    if (
      this.adapter.hostProcessListing &&
      this.context.resolution.primePassProcesses &&
      tasks.some(
        (task) =>
          !task.removedAt && !["done", "cancelled"].includes(task.phase),
      )
    ) {
      await yieldToLoop();
      if (!this.context.stopped) {
        await this.step(host, "processSnapshot", () =>
          this.context.resolution.primePassProcesses!(host),
        );
      }
    }
    // Spec 068 §6: pre-read timelines needed by this host's tasks into the
    // pass's shared snapshot under a single bounded per-host budget and
    // candidate cap so a slow host never stalls healthy hosts' task visits.
    const warmBudgetMs =
      this.context.resolution.hostPassWarmBudgetMs ?? HOST_PASS_WARM_BUDGET_MS;
    const warmDeadlineAt = Date.now() + Math.max(0, warmBudgetMs);
    let warmed = 0;
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
      // terminal (archived or closed) in its recorded workspace, preserving
      // the pre-closure ordering required before settling a negative delivery.
      const deliveryCandidates: Array<{
        agentId: string;
        workspaceId: string;
      }> = [];
      const seenDelivery = new Set<string>();
      for (const task of tasks) {
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
        await this.step(host, "timelineDeliverySnapshot", async () => {
          for (const candidate of deliveryCandidates) {
            await yieldToLoop();
            if (!canWarmMore()) return;
            const originRemaining = budgetRemaining();
            if (originRemaining <= 0) return;
            const originRead = await boundedRead(
              "origin agent observation",
              () => this.context.host.originAgent(candidate.agentId),
              originRemaining,
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
            if (!archived) {
              const obsRemaining = budgetRemaining();
              if (obsRemaining <= 0) return;
              const obsRead = await boundedRead(
                "participant observation",
                () => this.context.host.observe(candidate.agentId),
                obsRemaining,
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
            }
            const pageRemaining = budgetRemaining();
            if (pageRemaining <= 0) return;
            warmed++;
            const pageRead = await this.context.resolution
              .primePassTimelinePage!(candidate.agentId, 100, host, {
              provenTerminal: {
                archived,
                workspaceId: candidate.workspaceId,
              },
              deadlineMs: pageRemaining,
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
      // historical proof executor runs and settled non-terminal participants
      // so owned-tool and proof-settlement reads hit the host pass snapshot.
      const toolCandidates = new Set<string>();
      const observedMap = observed as ReadonlyMap<
        string,
        AgentObservation
      > | null;
      for (const task of tasks) {
        if (task.removedAt || ["done", "cancelled"].includes(task.phase))
          continue;
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
            toolCandidates.add(run.agentId);
        }
        if (observedMap) {
          if (task.agentId) {
            const state = observedMap.get(task.agentId);
            if (state && noTurnLive(state)) toolCandidates.add(task.agentId);
          }
          for (const run of runs) {
            if (!run.released && run.agentId) {
              const state = observedMap.get(run.agentId);
              if (state && noTurnLive(state)) toolCandidates.add(run.agentId);
            }
          }
        }
      }
      if (toolCandidates.size) {
        await this.step(host, "timelineToolSnapshot", async () => {
          for (const agentId of toolCandidates) {
            await yieldToLoop();
            if (!canWarmMore()) return;
            const remaining = budgetRemaining();
            if (remaining <= 0) return;
            warmed++;
            const read = await this.context.resolution.primePassTimelinePage!(
              agentId,
              TOOL_TIMELINE_LIMIT,
              host,
              {
                deadlineMs: remaining,
              },
            ).catch(() => null);
            if (read?.state === "unknown" && budgetRemaining() <= 0) return;
          }
        });
      }
    }
    if (
      observed &&
      this.adapter.agentTimeline &&
      this.context.resolution.primePassTimeline &&
      canWarmMore()
    ) {
      const shellAgents: string[] = [];
      const nowMs = Date.now();
      for (const [agentId, state] of observed as ReadonlyMap<
        string,
        AgentObservation
      >) {
        if (!state.active && !state.permissions) continue;
        const turnStartedAt = state.turnStartedAt
          ? Date.parse(state.turnStartedAt)
          : NaN;
        if (
          Number.isFinite(turnStartedAt) &&
          nowMs - turnStartedAt >= SHELL_NOTICE_MS
        )
          shellAgents.push(agentId);
      }
      if (shellAgents.length) {
        await this.step(host, "timelineShellSnapshot", async () => {
          for (const agentId of shellAgents) {
            await yieldToLoop();
            if (!canWarmMore()) return;
            const remaining = budgetRemaining();
            if (remaining <= 0) return;
            warmed++;
            const read = await this.context.resolution.primePassTimeline!(
              agentId,
              host,
              undefined,
              remaining,
            ).catch(() => null);
            if (read?.state === "unknown" && budgetRemaining() <= 0) return;
          }
        });
      }
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
      if (hostTimedOut(error)) throw error;
      // A step that fails at the transport boundary is this host's own answer for
      // the pass (Spec 066 R6): the client claims a connection the socket does not
      // honour, so the host did not answer and its tasks keep their wait. Only this
      // host's reading changes; another host's failure never reaches this record.
      if (isTransportFailure(error)) this.transportFailures.add(host);
      const detail = error instanceof Error ? error.message : String(error);
      this.store.setMeta(
        "hostPassError",
        `${host}/${name}: ${detail}`.slice(0, 2000),
      );
    }
  }
}
