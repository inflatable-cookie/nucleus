import type { Decision } from "../../shared/contracts";
import type { Adapter, AgentObservation } from "../host/adapter";
import type { Host } from "../../shared/host";
import type { Resolution } from "../resolution";
import { LANE_PRIORITY_OPERATION } from "../scheduling/lane-priorities";
import { now, type Store } from "../store/store";

export const DECISION_NOTICE_OBSERVE_TIMEOUT_MS = 5_000;
export const DECISION_NOTICE_SEND_TIMEOUT_MS = 15_000;
export const DECISION_NOTICE_CONCURRENCY = 4;
export const DECISION_NOTICE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

const UNROUTABLE_WAIT = "Cannot route this identity";
const GONE_WAIT = "The asking agent thread is no longer available";

type DecisionDeliveryRecord = NonNullable<Decision["delivery"]>;

class StepAbortedError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = "StepAbortedError";
  }
}

export interface DecisionNoticeResolutionPorts {
  readonly host: Pick<Host, "observe">;
  identifyOriginHost: Resolution["identifyOriginHost"];
  originHostAvailable: Resolution["originHostAvailable"];
  paused: Resolution["paused"];
  sendDurably: Resolution["sendDurably"];
  withHost: Resolution["withHost"];
}

export interface DecisionNoticePassContext {
  readonly adapter: Pick<Adapter, "notify" | "steerOrNotify">;
  readonly stopped: boolean;
  readonly store: Pick<
    Store,
    "decision" | "pendingDecisionDeliveries" | "updateDecisionDelivery"
  >;
  readonly resolution: DecisionNoticeResolutionPorts;
}

export interface DecisionNoticeDeliveryContext extends DecisionNoticePassContext {
  cleanContext<T>(work: () => T): T;
  scheduleLane(
    key: string,
    priority: number,
    work: () => Promise<void> | void,
    options?: { coalesce?: string },
  ): Promise<void>;
}

export interface DecisionDeliveryPassOptions {
  observeTimeoutMs?: number;
  sendTimeoutMs?: number;
  concurrency?: number;
  registerStopWaiter?: (wake: () => void) => () => void;
  onLatePromise?: (
    decisionId: string,
    version: number,
    noticeId: string,
    late: Promise<unknown>,
  ) => void;
}

/** Extract a late-settlement promise attached to an abandoned/unknown host error. */
export function extractLatePromise(error: unknown): Promise<unknown> | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { lateDelivery?: unknown; late?: unknown };
  if (record.lateDelivery !== true) return null;
  return record.late instanceof Promise ? record.late : null;
}

function readPending(
  store: DecisionNoticePassContext["store"],
  decisionId: string,
  expectedVersion: number,
): { decision: Decision; delivery: DecisionDeliveryRecord } | null {
  let decision: Decision;
  try {
    decision = store.decision(decisionId);
  } catch {
    return null;
  }
  const delivery = decision.delivery;
  if (
    decision.status !== "answered" ||
    !delivery ||
    decision.version !== expectedVersion ||
    delivery.version !== decision.version ||
    delivery.status !== "pending" ||
    !delivery.agentId
  )
    return null;
  return { decision, delivery };
}

async function runBounded<T>(
  timeoutMs: number,
  work: () => Promise<T>,
  timeoutMessage: string,
  registerStopWaiter?: (wake: () => void) => () => void,
): Promise<T> {
  const running = work();
  // Prevent unhandled rejection if timeout/stop settles the race before `running` settles.
  void running.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unregisterStop: (() => void) | undefined;
  let settled = false;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new StepAbortedError(timeoutMessage, true));
    }, timeoutMs);
    timer.unref?.();
    if (registerStopWaiter) {
      unregisterStop = registerStopWaiter(() => {
        if (settled) return;
        settled = true;
        reject(new StepAbortedError("Engine stopped during lookup", false));
      });
    }
  });
  try {
    return await Promise.race([running, guard]);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    unregisterStop?.();
  }
}

async function deliverOneDecision(
  context: DecisionNoticePassContext,
  decisionId: string,
  expectedVersion: number,
  options: DecisionDeliveryPassOptions,
): Promise<"paused" | "done"> {
  if (context.stopped) return "done";
  if (context.resolution.paused()) return "paused";
  const initial = readPending(context.store, decisionId, expectedVersion);
  if (!initial) return "done";
  const agentId = initial.delivery.agentId;
  const observeTimeoutMs =
    options.observeTimeoutMs ?? DECISION_NOTICE_OBSERVE_TIMEOUT_MS;
  const sendTimeoutMs =
    options.sendTimeoutMs ?? DECISION_NOTICE_SEND_TIMEOUT_MS;

  const wait = (reason: string, bumpAttempts = true) => {
    if (context.stopped) return;
    const latest = readPending(context.store, decisionId, expectedVersion);
    if (!latest) return;
    const attempts = bumpAttempts
      ? Math.max(latest.delivery.attempts, 1)
      : latest.delivery.attempts;
    if (
      latest.delivery.error === reason &&
      latest.delivery.attempts === attempts
    )
      return;
    context.store.updateDecisionDelivery(decisionId, {
      ...latest.delivery,
      error: reason,
      attempts,
    });
  };

  let host: string | undefined;
  try {
    host = await runBounded(
      observeTimeoutMs,
      () => context.resolution.identifyOriginHost(agentId),
      "Waiting for the asking agent: host lookup timed out",
      options.registerStopWaiter,
    );
  } catch (error) {
    if (error instanceof StepAbortedError) {
      if (error.timedOut) wait(error.message);
      return "done";
    }
    wait(
      `Waiting for the asking agent: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "done";
  }
  if (context.stopped) return "done";
  if (!host) {
    wait(UNROUTABLE_WAIT);
    return "done";
  }
  let available = false;
  let canSteer = false;
  try {
    context.resolution.withHost(host, () => {
      available =
        context.resolution.originHostAvailable(host) &&
        Boolean(context.adapter.steerOrNotify ?? context.adapter.notify);
      canSteer = Boolean(context.adapter.steerOrNotify);
    });
  } catch {
    available = false;
  }
  if (!available) {
    wait(`Waiting for host ${host}`);
    return "done";
  }

  let stepAborted = false;
  let latePromise: Promise<unknown> | null = null;
  let lateNoticeId = initial.delivery.noticeId;
  try {
    return await context.resolution.withHost(host, () =>
      context.resolution.sendDurably<DecisionDeliveryRecord>({
        recipient: agentId,
        aborted: () => stepAborted || context.stopped,
        observe: async (): Promise<AgentObservation | null> => {
          try {
            return await runBounded(
              observeTimeoutMs,
              () => context.resolution.host.observe(agentId),
              "Waiting for the asking agent: observation timed out",
              options.registerStopWaiter,
            );
          } catch (error) {
            if (error instanceof StepAbortedError) {
              stepAborted = true;
              if (error.timedOut) wait(error.message);
              return null;
            }
            throw error;
          }
        },
        lookupWait: (message) => `Waiting for the asking agent: ${message}`,
        busyWait: (state) =>
          `Waiting for the asking agent to finish (${state.status})`,
        ...(canSteer ? { ready: () => true, steer: true } : {}),
        wait: (reason) => {
          if (stepAborted || context.stopped) return;
          wait(reason, false);
        },
        gone: () => {
          if (stepAborted || context.stopped) return;
          wait(GONE_WAIT);
        },
        confirm: () => {
          if (stepAborted || context.stopped) return null;
          const latest = readPending(
            context.store,
            decisionId,
            expectedVersion,
          );
          return latest ? latest.delivery : null;
        },
        target: (record) => {
          lateNoticeId = record.noticeId;
          return {
            agentId: record.agentId,
            id: record.noticeId,
            text: record.text,
          };
        },
        refused: (record, reason) => {
          try {
            context.store.updateDecisionDelivery(decisionId, {
              ...record,
              status: "pending",
              error: reason,
              attempts: record.attempts + 1,
            });
          } catch {
            /* store closed during shutdown */
          }
        },
        sendTimeoutMs,
        registerStopWaiter: options.registerStopWaiter,
        mark: (record, status, error, failure) => {
          try {
            context.store.updateDecisionDelivery(decisionId, {
              ...record,
              status,
              error,
              attempts: record.attempts + 1,
              ...(status === "delivered" ? { deliveredAt: now() } : {}),
            });
          } catch {
            /* store closed during shutdown */
          }
          if (status === "uncertain") {
            latePromise = extractLatePromise(failure);
          }
        },
      }),
    );
  } catch (error) {
    if (!context.stopped && !stepAborted) {
      wait(
        `Waiting for host ${host}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return "done";
  } finally {
    if (latePromise && options.onLatePromise) {
      options.onLatePromise(
        decisionId,
        expectedVersion,
        lateNoticeId,
        latePromise,
      );
    }
  }
}

/**
 * One bounded decision-notice pass: settles interrupted `intent` rows as
 * `uncertain` without resending, skips already-`uncertain` rows, and delivers
 * pending rows grouped per recipient with bounded concurrency so a busy,
 * offline, or hung recipient never monopolizes unrelated reachable threads.
 */
export async function deliverDecisionNoticesPass(
  context: DecisionNoticePassContext,
  options: DecisionDeliveryPassOptions = {},
): Promise<void> {
  if (context.stopped || context.resolution.paused()) return;
  const candidates = context.store.pendingDecisionDeliveries();
  if (!candidates.length) return;

  const actionable: Decision[] = [];
  for (const decision of candidates) {
    const delivery = decision.delivery;
    if (
      !delivery ||
      delivery.version !== decision.version ||
      !delivery.agentId
    )
      continue;
    if (delivery.status === "intent") {
      // An intent remaining when no delivery pass is active in this process
      // means a prior process restarted mid-send; settle as uncertain and never resend.
      context.store.updateDecisionDelivery(decision.id, {
        ...delivery,
        status: "uncertain",
        error:
          "Restart during delivery; inspect the asking agent thread before resending",
        attempts: Math.max(delivery.attempts, 1),
      });
      continue;
    }
    if (delivery.status === "pending") {
      actionable.push(decision);
    }
  }

  if (!actionable.length) return;

  const byRecipient = new Map<string, Decision[]>();
  for (const decision of actionable) {
    const agentId = decision.delivery!.agentId;
    const list = byRecipient.get(agentId) ?? [];
    list.push(decision);
    byRecipient.set(agentId, list);
  }

  // Fresh deliveries (`attempts === 0`) run ahead of already-retried groups so
  // even a full concurrency width of waiting/hung recipients cannot delay a new answer.
  const queue = [...byRecipient.values()].sort((left, right) => {
    const leftFresh = left.some((item) => item.delivery!.attempts === 0)
      ? 0
      : 1;
    const rightFresh = right.some((item) => item.delivery!.attempts === 0)
      ? 0
      : 1;
    return leftFresh - rightFresh;
  });

  const concurrency = Math.max(
    1,
    options.concurrency ?? DECISION_NOTICE_CONCURRENCY,
  );
  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      while (queue.length) {
        if (context.stopped || context.resolution.paused()) return;
        const group = queue.shift()!;
        for (const decision of group) {
          if (context.stopped || context.resolution.paused()) return;
          const outcome = await deliverOneDecision(
            context,
            decision.id,
            decision.version,
            options,
          );
          if (outcome === "paused") return;
        }
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Coalesced, bounded delivery owner for committed Spec 032 decision notices.
 * Runs on its own `"decision-notices"` lane independent of the serial fleet
 * sweep, so reachable idle threads receive answers promptly even while task
 * reconciliation is slow or stalled.
 */
export class DecisionNoticeDelivery {
  observeTimeoutMs = DECISION_NOTICE_OBSERVE_TIMEOUT_MS;
  sendTimeoutMs = DECISION_NOTICE_SEND_TIMEOUT_MS;
  concurrency = DECISION_NOTICE_CONCURRENCY;
  retryDelaysMs = [...DECISION_NOTICE_RETRY_DELAYS_MS];

  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private readonly stopWaiters = new Set<() => void>();

  constructor(private readonly context: DecisionNoticeDeliveryContext) {}

  /** Schedule one coalesced pass immediately (answer commit, startup, resume, unpause, reconnect). */
  schedule(): Promise<void> {
    if (this.context.stopped) return Promise.resolve();
    this.clearRetryTimer();
    this.retryAttempt = 0;
    return this.enqueue();
  }

  private enqueue(): Promise<void> {
    if (this.context.stopped) return Promise.resolve();
    return this.context.cleanContext(() =>
      this.context.scheduleLane(
        "decision-notices",
        LANE_PRIORITY_OPERATION,
        () => this.runPass(),
        { coalesce: "decision-notices" },
      ),
    );
  }

  private async runPass(): Promise<void> {
    if (this.context.stopped || this.context.resolution.paused()) return;
    await deliverDecisionNoticesPass(this.context, {
      observeTimeoutMs: this.observeTimeoutMs,
      sendTimeoutMs: this.sendTimeoutMs,
      concurrency: this.concurrency,
      registerStopWaiter: (wake) => {
        this.stopWaiters.add(wake);
        return () => {
          this.stopWaiters.delete(wake);
        };
      },
      onLatePromise: (decisionId, version, noticeId, late) => {
        this.attachLateSettlement(decisionId, version, noticeId, late);
      },
    });
    if (!this.context.stopped && !this.context.resolution.paused()) {
      this.armRetryIfNeeded();
    }
  }

  private attachLateSettlement(
    decisionId: string,
    version: number,
    noticeId: string,
    late: Promise<unknown>,
  ): void {
    void late.then(
      () => {
        if (this.context.stopped) return;
        try {
          const latest = this.context.store.decision(decisionId);
          if (
            latest.status === "answered" &&
            latest.delivery &&
            latest.delivery.version === version &&
            latest.delivery.noticeId === noticeId &&
            latest.delivery.status === "uncertain"
          ) {
            this.context.store.updateDecisionDelivery(decisionId, {
              ...latest.delivery,
              status: "delivered",
              error: "",
              deliveredAt: now(),
            });
          }
        } catch {
          /* store closed or decision absent; leave recorded state untouched */
        }
      },
      () => {
        /* late send failed; unknown delivery remains uncertain and is never resent */
      },
    );
  }

  private armRetryIfNeeded(): void {
    if (
      this.context.stopped ||
      this.context.resolution.paused() ||
      this.retryTimer ||
      !this.retryDelaysMs.length
    )
      return;
    const needsRetry = this.context.store
      .pendingDecisionDeliveries()
      .some((decision) => {
        const delivery = decision.delivery;
        if (
          !delivery ||
          delivery.version !== decision.version ||
          !delivery.agentId ||
          delivery.status !== "pending"
        )
          return false;
        return (
          delivery.error !== UNROUTABLE_WAIT && delivery.error !== GONE_WAIT
        );
      });
    if (!needsRetry) return;
    const delay =
      this.retryDelaysMs[
        Math.min(this.retryAttempt++, this.retryDelaysMs.length - 1)
      ] ?? 16_000;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.context.stopped || this.context.resolution.paused()) return;
      void this.enqueue().catch(() => {});
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Clear timers and abort any hung in-flight step waiters so shutdown never blocks. */
  stop(): void {
    this.clearRetryTimer();
    const waiters = [...this.stopWaiters];
    this.stopWaiters.clear();
    for (const wake of waiters) wake();
  }
}
