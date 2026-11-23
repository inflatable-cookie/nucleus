import { dirname } from "node:path";
import type { Engine } from "../engine";
import { reapHookCheckouts } from "../hooks/hook-cleanup";
import { removeTaskProofFiles } from "../intake/proof-files";
import { pruneLiveDataHomeBackupCopies } from "../store/data-home-retention";
import {
  RECLAIM_DRAIN_BUDGET_MS,
  RECLAIM_DRAIN_FREE_PAGES,
  RECLAIM_DRAIN_MAX_PAGES,
} from "../store/store";
import {
  runThreadRetention,
  threadRetentionIntervalMs,
} from "../workspaces/thread-retention";
import { evaluateTriage } from "../planning/triage";
import { unparkDueLeads } from "../planning/parking";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type SweepMaintenanceContext = Pick<
  Engine,
  | "adapter"
  | "hostAvailable"
  | "hostIds"
  | "migrateProjectOwnersToPlanners"
  | "removeSiblings"
  | "stopped"
  | "store"
  | "withHost"
>;

/**
 * The audit pass's periodic maintenance: the hourly and daily store chores and
 * the engine's periodic project-owner and lane passes. They are not task work —
 * each is bounded, touches no task, and belongs to the store's or the plan's own
 * cadence — so their timing lives here and the sweep only calls one pass.
 *
 * Every step records its outcome under the meta key its reader already polls
 * (`dataHomeRetention`, `retentionError`, `laneIdleError`, `projectOwnerError`,
 * `laneDrainError`), and clears that key when the step succeeds, so a stale
 * failure never outlives the fault it names.
 */
export class SweepMaintenance {
  /** Last hourly hook-checkout and data-home retention pass. */
  lastHookCleanupAt = 0;
  /** The archived-thread pass in flight, if any: at most one runs at a time. */
  threadRetentionRun: Promise<void> | null = null;
  constructor(readonly context: SweepMaintenanceContext) {}
  private get store() {
    return this.context.store;
  }

  /**
   * Start the archived-thread pass without awaiting it. Its outcome is recorded
   * under `threadRetentionError` (cleared on success) and per host under
   * `threadRetention`, so `service.health` shows a failed or stalled pass; nothing
   * waits on it, so a long walk never holds the audit drain or a service start.
   */
  private startThreadRetention(at: number): void {
    // A walk that could not read a host is retried after an hour, not after the
    // whole interval: one failed read must not cost half a day of pruning.
    const retrySoon = () => {
      try {
        const interval = threadRetentionIntervalMs(this.store);
        if (interval > HOUR_MS)
          this.store.setMeta("lastThreadRetentionAt", at - interval + HOUR_MS);
      } catch {
        /* the store is closed: the next service start reads the pass again */
      }
    };
    this.threadRetentionRun = runThreadRetention({
      store: this.store,
      hostIds: this.context.hostIds(),
      hostAvailable: (hostId) => this.context.hostAvailable(hostId),
      withHost: (hostId, work) => this.context.withHost(hostId, work),
      adapter: this.context.adapter,
      at,
      stopped: () => Boolean(this.context.stopped),
    })
      .then((health) => {
        this.store.setMeta("threadRetentionError", "");
        if (
          health.hosts.some(
            (fact) =>
              fact.checkedAt === new Date(at).toISOString() &&
              (fact.truncated ||
                fact.error.startsWith("The archived thread walk")),
          )
        )
          retrySoon();
      })
      .catch((error) => {
        try {
          this.store.setMeta("threadRetentionError", String(error));
        } catch {
          /* the store is closed: the next service start reads the pass again */
        }
        retrySoon();
      })
      .finally(() => {
        this.threadRetentionRun = null;
      });
  }

  async run(at = Date.now()): Promise<void> {
    const paused = Boolean(this.store.getMeta("paused"));
    if (at - this.lastHookCleanupAt >= HOUR_MS) {
      this.lastHookCleanupAt = at;
      await reapHookCheckouts(this.store);
      try {
        const removed = pruneLiveDataHomeBackupCopies(dirname(this.store.path));
        if (removed.length)
          this.store.setMeta("dataHomeRetention", {
            checkedAt: new Date(at).toISOString(),
            removed,
          });
      } catch (error) {
        this.store.setMeta("dataHomeRetentionError", String(error));
      }
    }
    if (
      !paused &&
      at - (this.store.getMeta<number>("lastRetentionAt") ?? 0) >= DAY_MS
    ) {
      try {
        // Audit B5: a hook record is the only proof of an isolated checkout's ownership,
        // so the task's owned checkouts are reaped before its hook rows go. A task that
        // still owns an existing checkout keeps its whole history for the next pass.
        const candidates = this.store.retentionCandidates(at);
        if (candidates.length)
          await reapHookCheckouts(this.store, {
            taskIds: new Set(candidates.map((task) => task.id)),
          });
        // Task 1496: compact telemetry for still-present finished history, bounded per pass.
        this.store.seedRetainedTelemetry(at);
        this.store.purgeOldTasks(at, (taskId, runIds) => {
          // Retention runs in no host context; the reporting files belong to the
          // task's own host, whose adapter is the one that knows their paths.
          const hostId = this.store.task(taskId).hostId;
          let purge: ((taskId: string, runIds: string[]) => void) | undefined;
          try {
            purge = hostId
              ? this.context.withHost(
                  hostId,
                  () => this.context.adapter.purgeReportingFiles,
                )
              : this.context.adapter.purgeReportingFiles;
          } catch {
            purge = undefined; // A host that is not connected keeps its files.
          }
          purge?.(taskId, runIds);
          void this.context.removeSiblings(taskId);
          try {
            removeTaskProofFiles(this.store.task(taskId));
          } catch {
            /* Evidence whose recorded paths cannot be proved is left in place. */
          }
        });
        // Lean store 2 (task 987): the same windows the schema-52 migration applied, so rows that
        // outlive their task or run are pruned as they age out, not only once.
        this.store.transaction(() => this.store.pruneRetainedRows(at));
        // Retained telemetry keeps the rolling 90-day cohort window; detail retention is unchanged.
        this.store.expireRetainedTelemetry(at);
        // A capture fault keeps that task's history and stays visible in retention health.
        this.store.setMeta(
          "retentionError",
          this.store.telemetryRetentionError(),
        );
      } catch (error) {
        this.store.setMeta("retentionError", String(error));
        this.store.setMeta("lastRetentionAt", at);
      }
    }
    // Orchestration contract, "Archived thread retention": the service schedules
    // one retention pass itself, never a system job (Tom, 2026-11-19). It is the
    // only reader of a host's archived threads, so it runs on its own interval
    // (`threadRetentionIntervalHours`, 12 by default: Tom, 2026-11-22, "Once or
    // twice a day?"), with a batch cap per host so the archived backlog drains over
    // passes instead of in one burst against a host. It runs detached (see
    // `startThreadRetention`): the first pass walks every archived thread on every
    // host, and the audit pass this maintenance sits in is what the bootstrap's
    // reconciliation waits on.
    if (
      !paused &&
      !this.threadRetentionRun &&
      at - (this.store.getMeta<number>("lastThreadRetentionAt") ?? 0) >=
        threadRetentionIntervalMs(this.store)
    ) {
      this.store.setMeta("lastThreadRetentionAt", at);
      this.startThreadRetention(at);
    }
    // Lean store 4 (task 989): freed pages are released on every maintenance tick, not only
    // after a prune, while free pages exceed the drain threshold — one bounded pass per tick
    // at the drain bounds, so a freelist the size of a prune's backlog clears in minutes
    // instead of the days the hourly-only passes took (about 6 pages a minute after task 987
    // rolled). At or below the threshold this tick releases nothing: the passes after the
    // hourly and daily prunes are the only releases, so a steady store is not touched every
    // sweep. One chunk is one short write transaction, so the writer is never held for the
    // whole budget at once.
    if (
      !paused &&
      this.store.storeFacts().freePages > RECLAIM_DRAIN_FREE_PAGES
    ) {
      try {
        this.store.reclaimFreedPages({
          maxPages: RECLAIM_DRAIN_MAX_PAGES,
          budgetMs: RECLAIM_DRAIN_BUDGET_MS,
        });
      } catch {
        /* the pass records its own fault on the store */
      }
    }
    // Spec 019: idle lanes close themselves; an hourly, bounded store pass that touches no task.
    if (
      !paused &&
      at - (this.store.getMeta<number>("lastLaneIdleAt") ?? 0) >= HOUR_MS
    ) {
      this.store.setMeta("lastLaneIdleAt", at);
      try {
        this.store.closeIdleLanes();
        this.store.setMeta("laneIdleError", "");
      } catch (error) {
        this.store.setMeta("laneIdleError", String(error));
      }
    }
    // Spec 058 cutover 5: the one-time owner→planner migration runs before the drain
    // pass below, so notice routing never reads the retired owner machinery.
    if (!paused) {
      try {
        await this.context.migrateProjectOwnersToPlanners();
        this.store.setMeta("projectOwnerError", "");
      } catch (error) {
        this.store.setMeta("projectOwnerError", String(error));
      }
    }
    // Nucleus#1420: opted-in projects triage their open leads and papercuts; at most a minute apart, one batch per project.
    if (
      !paused &&
      at - (this.store.getMeta<number>("lastTriageAt") ?? 0) >= 60_000
    ) {
      this.store.setMeta("lastTriageAt", at);
      // Nucleus#1543: a parked lead whose recheck is due returns to the to-do list before triage reads it.
      try {
        unparkDueLeads(this.store, at);
        this.store.setMeta("parkingError", "");
      } catch (error) {
        this.store.setMeta("parkingError", String(error));
      }
      try {
        evaluateTriage(this.store, at);
        this.store.setMeta("triageError", "");
      } catch (error) {
        this.store.setMeta("triageError", String(error));
      }
    }
    // Spec 041: drained lanes and boards prompt their plan owner and escalate; hourly, bounded, no task touched.
    if (
      !paused &&
      at - (this.store.getMeta<number>("lastLaneDrainAt") ?? 0) >= HOUR_MS
    ) {
      this.store.setMeta("lastLaneDrainAt", at);
      try {
        this.store.evaluateLaneDrains();
        this.store.setMeta("laneDrainError", "");
      } catch (error) {
        this.store.setMeta("laneDrainError", String(error));
      }
    }
  }
}
