import type { Engine } from "../engine";
import type { Run, Task } from "../../shared/contracts";
import {
  classifyGitTransientFailure,
  ForgeOutageError,
  gitDeliveryUnknown,
  ReviewPublicationTransientError,
} from "../forge/forge-health";
import {
  GIT_TRANSIENT_LIMIT_MS,
  nextGitTransientAttempt,
  type GitTransientEpisode,
} from "../git/git-transient-backoff";
import {
  claimHostReadTransientError,
  hasUnresolvedHostReadExhaustionEvent,
  hostReadTransientEscalationReason,
  hostReadTransientKey,
  nextHostReadTransientAttempt,
  readHostReadTransientEpisode,
  taskHostReadContext,
  type HostReadFailureContext,
  type HostReadTransientEpisode,
} from "../recovery/host-read-transient";
import { boardDispatchHoldApplies } from "../../shared/board-dispatch-hold";
import {
  CheckoutRefusalError,
  CheckoutUnavailableError,
} from "../workspaces/checkout-volume";
import { routeUnavailableStop } from "../../shared/task-stop";
import { recordedSlotWait } from "../recovery/wait-context";
import { HostReadRefusalError } from "../host";
import { WorkspaceObservationUnavailableError } from "../workspaces/workspace-allocation";
import { isTransportFailure } from "../../shared/transport";
import {
  isLoginSessionFault,
  LoginSessionFaultError,
} from "../../shared/session-fault";
import {
  dispatchBlocked,
  fairSlotRequestOrder,
  occupiesSlot,
} from "../dispatch/capacity";
import { LANE_PRIORITY_TASK } from "./lane-priorities";
import {
  HOST_PASS_WARM_BUDGET_MS,
  PASS_PROCESS_READ_DEADLINE_MS,
  PassSnapshot,
  QUANTUM_READ_DEADLINE_MS,
  QUANTUM_TOTAL_READ_BUDGET_MS,
  boundedRead,
  runInTaskQuantumScope,
  runOutsideTaskQuantumScope,
} from "./pass-snapshot";
import { knownExecutionParticipantIds } from "../machine/execution-participants";
import {
  TOOL_TIMELINE_LIMIT,
  TOOL_TIMELINE_READ_BUDGET,
  liveToolIssueFact,
} from "../recovery/stall";
import { now, type Store } from "../store/store";
import { settlementHeld, startsNoRuns } from "../closeout/queue-drain";
import { markPhaseFact } from "./phase-latency";
import { prerequisiteWaitBlocksPhase } from "../store/store-prerequisites";

/**
 * A wake that threw after its caller stopped waiting. The engine being stopped is
 * the one discard that is not a fault: `scheduleLane` and the quantum lanes drop
 * queued work at shutdown by design. Any other throw is a lost wake with no
 * sender, so it is recorded on the task's timeline instead of vanishing with the
 * promise; the next scheduling decision is a fresh one, never this resend.
 */
function recordWakeFailure(
  store: Store,
  stopped: boolean,
  taskId: string,
  wake: string,
  error: unknown,
): void {
  if (stopped) return;
  const detail = error instanceof Error ? error.message : String(error);
  // The record is best-effort by contract, like the engine's own diagnostics: a
  // store that is closing refuses the write, and a lost wake is never resent
  // because its record could not be written either.
  try {
    store.event(
      taskId,
      "wake_failed",
      `${wake} failed: ${detail}`.slice(0, 2000),
    );
  } catch {
    /* the store refused the record; the wake itself is still lost */
  }
}

/**
 * The failure text the git-transient plan records: the error's own message, minus
 * the suffix the operator is told separately, bounded. It is diagnostic output
 * only — no decision in the plan reads it.
 */
function transientDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/; operator SSH\/key inspection required/g, "")
    .slice(0, 800);
}

/** Named git-transient plan over already-read store facts. */
export type GitTransientPlan =
  | { kind: "ignore" }
  | { kind: "skip_unknown" }
  | {
      kind: "exhausted";
      failureKind: "lock" | "ssh" | "network";
      attempts: number;
      detail: string;
    }
  | { kind: "retry_lock"; episode: GitTransientEpisode; detail: string }
  | {
      kind: "retry_shared";
      episode: GitTransientEpisode;
      host: GitTransientEpisode;
      detail: string;
    };

export function gitTransientPlan(facts: {
  failureKind: "lock" | "ssh" | "network" | null;
  deliveryUnknown: boolean;
  publicationTransient: boolean;
  operation: boolean;
  hasReviewPublication: boolean;
  old: GitTransientEpisode | null;
  host: GitTransientEpisode | null;
  detail: string;
  now: number;
}): GitTransientPlan {
  if (!facts.failureKind) return { kind: "ignore" };
  if (
    facts.deliveryUnknown &&
    (facts.operation ||
      !facts.publicationTransient ||
      !facts.hasReviewPublication)
  )
    return { kind: "skip_unknown" };
  const next = nextGitTransientAttempt(facts.old, facts.detail, facts.now);
  if (!next)
    return {
      kind: "exhausted",
      failureKind: facts.failureKind,
      attempts: facts.old?.attempts ?? 0,
      detail: facts.detail,
    };
  if (facts.failureKind !== "lock") {
    const shared =
      facts.host && facts.host.retryAt > facts.now
        ? facts.host
        : (nextGitTransientAttempt(
            facts.host ?? null,
            facts.detail,
            facts.now,
          ) ?? next);
    next.retryAt = Math.min(
      next.startedAt + GIT_TRANSIENT_LIMIT_MS,
      shared.retryAt,
    );
    return {
      kind: "retry_shared",
      episode: next,
      host: shared,
      detail: facts.detail,
    };
  }
  return { kind: "retry_lock", episode: next, detail: facts.detail };
}

/** Route a step failure after the git-transient gate. */
export type StepFailureRoute =
  | "git_transient"
  | "cleanup"
  | "checkout_refusal"
  | "external_wait"
  | "transport"
  | "session"
  | "attention";

export function stepFailureRoute(facts: {
  terminal: boolean;
  gitTransient: boolean;
  checkoutRefusal: boolean;
  externalWait: boolean;
  transport: boolean;
  session: boolean;
}): StepFailureRoute {
  if (!facts.terminal && facts.gitTransient) return "git_transient";
  if (facts.terminal) return "cleanup";
  if (facts.checkoutRefusal) return "checkout_refusal";
  if (facts.externalWait) return "external_wait";
  if (facts.transport) return "transport";
  if (facts.session) return "session";
  return "attention";
}

export {
  quantumFollowUps,
  type QuantumFollowUp,
} from "../closeout/completion-follow-ups";

/**
 * Task wakes: what a task's quantum owes after it runs, the bounded timers that
 * retry those follow-ups, and the git-transient backoff. Same-name `Engine`
 * methods delegate here. `store`, `resolution` and `admission` read the engine
 * per call, and moved code calls its siblings through `this.engine`, so
 * instance overrides still fire. `Engine.stop` calls `stop()`.
 */
export type TaskWakesContext = Pick<
  Engine,
  | "adapter"
  | "host"
  | "resolution"
  | "admission"
  | "applyDeferredOwnerVerbs"
  | "armGitTransient"
  | "cleanContext"
  | "completionFollowUps"
  | "deferGitTransient"
  | "dispatchQueued"
  | "dispatchTask"
  | "gitTransientWaiting"
  | "note"
  | "scheduleDispatch"
  | "scheduleLane"
  | "scheduleLifecycleFollowUp"
  | "scheduleOperation"
  | "scheduleTaskQuantum"
  | "stopped"
  | "store"
  | "taskHostAvailable"
  | "taskQuantum"
  | "terminalThreadsPending"
  | "transientKey"
  | "wakeRepository"
  | "wakeTask"
  | "withHost"
>;

export class TaskWakes {
  constructor(readonly engine: TaskWakesContext) {}
  get store() {
    return this.engine.store;
  }
  get resolution() {
    return this.engine.resolution;
  }
  get admission() {
    return this.engine.admission;
  }
  readonly lifecycleFollowUps = new Set<string>();
  private readonly gitTransientTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly hostReadTransientTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  /**
   * Record a step failure. A transport failure leaves the lane where it is so the next
   * sweep retries it; anything else is a task fault and parks for attention as before.
   */
  transientKey(id: string): string {
    return `gitTransient:${id}`;
  }
  armGitTransient(id: string, retryAt: number, operation = false): void {
    if (this.gitTransientTimers.has(id) || this.engine.stopped) return;
    const timer = setTimeout(
      () => {
        this.gitTransientTimers.delete(id);
        if (this.engine.stopped) return;
        if (operation) {
          if (settlementHeld(this.store, this.engine.stopped)) return;
          this.engine.cleanContext(() => this.engine.scheduleOperation(id));
        } else {
          const task = this.store.task(id);
          if (task.phase === "queued") {
            if (startsNoRuns(this.store, this.engine.stopped)) return;
            void this.engine
              .cleanContext(() =>
                this.engine.scheduleLane(`task:${id}`, LANE_PRIORITY_TASK, () =>
                  this.engine.dispatchTask(
                    id,
                    this.store.getMeta<boolean>("dispatchHeld") ?? false,
                  ),
                ),
              )
              .catch((error) =>
                recordWakeFailure(
                  this.store,
                  this.engine.stopped,
                  id,
                  "Git-transient dispatch retry",
                  error,
                ),
              );
          } else {
            if (settlementHeld(this.store, this.engine.stopped)) return;
            void this.engine.cleanContext(() => this.engine.wakeTask(id));
          }
        }
      },
      Math.max(0, retryAt - Date.now()),
    );
    timer.unref();
    this.gitTransientTimers.set(id, timer);
  }
  deferGitTransient(id: string, error: unknown, operation = false): boolean {
    const facts = this.gitTransientFacts(id, error, operation);
    const plan = gitTransientPlan(facts);
    if (plan.kind === "ignore" || plan.kind === "skip_unknown") return false;
    const key = this.engine.transientKey(id);
    if (plan.kind === "exhausted") {
      this.store.deleteMeta(key);
      const reason = `Git or GitHub failed after ${plan.attempts} retries over 15 minutes: ${plan.detail}${plan.failureKind === "ssh" ? "; inspect SSH authentication and keys" : ""}`;
      if (operation) {
        const current = this.store.operation(id);
        if (current)
          this.store.putOperation({
            ...current,
            state: "needs_attention",
            settledAt: now(),
            diagnostic: reason,
          });
      } else this.engine.note(id, reason, "operator_needed", "needs_attention");
      return true;
    }
    if (plan.kind === "retry_shared")
      this.store.setMeta("gitTransientHost:github", plan.host);
    const next = plan.episode;
    const source = this.resolution.gitFailureSource(error);
    if (source ?? facts.old?.source) next.source = source ?? facts.old?.source;
    this.store.setMeta(key, next);
    const reason = `Git or GitHub failed: ${plan.detail}. Retrying at ${new Date(next.retryAt).toISOString()}`;
    if (operation) {
      const current = this.store.operation(id);
      if (current)
        this.store.putOperation({
          ...current,
          state: "pending",
          settledAt: null,
          diagnostic: reason,
        });
    } else
      this.resolution.waiting(
        this.store.task(id),
        reason,
        "external_unavailable",
      );
    this.engine.armGitTransient(id, next.retryAt, operation);
    return true;
  }
  gitTransientWaiting(id: string, operation = false): boolean {
    const episode = this.store.getMeta<GitTransientEpisode | null>(
      this.engine.transientKey(id),
    );
    if (!episode || episode.retryAt <= Date.now()) return false;
    this.engine.armGitTransient(id, episode.retryAt, operation);
    return true;
  }
  /**
   * Every store fact the git-transient plan reads, gathered once. The plan alone
   * decides the uncertain-delivery skip, so the episode reads here are only its
   * input: nothing in this class re-derives that conjunction beside it.
   */
  private gitTransientFacts(
    id: string,
    error: unknown,
    operation: boolean,
  ): Parameters<typeof gitTransientPlan>[0] {
    const failureKind = classifyGitTransientFailure(error);
    const deliveryUnknown = gitDeliveryUnknown(error);
    const publicationTransient =
      error instanceof ReviewPublicationTransientError;
    let hasReviewPublication = false;
    if (failureKind && deliveryUnknown && !operation && publicationTransient) {
      // Only the publication protocol can observe this write on the next pass. A
      // purged task has no record to observe; that is a fact about the record.
      const runId = this.store.taskOrNull(id)?.resolution.currentRunId;
      hasReviewPublication = Boolean(
        runId && this.store.getMeta(`reviewPublication:${runId}`),
      );
    }
    return {
      failureKind,
      deliveryUnknown,
      publicationTransient,
      operation,
      hasReviewPublication,
      old:
        this.store.getMeta<GitTransientEpisode | null>(
          this.engine.transientKey(id),
        ) ?? null,
      host:
        failureKind && failureKind !== "lock"
          ? (this.store.getMeta<GitTransientEpisode | null>(
              "gitTransientHost:github",
            ) ?? null)
          : null,
      detail: failureKind ? transientDetail(error) : "",
      now: Date.now(),
    };
  }
  clearHostReadTransient(
    id: string,
    scope: "task" | "op" | "question" = "task",
  ): void {
    const key = hostReadTransientKey(scope, id);
    const old = readHostReadTransientEpisode(this.store, id, scope);
    this.store.deleteMeta(key);
    const timerKey = `${scope}:${id}`;
    const timer = this.hostReadTransientTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.hostReadTransientTimers.delete(timerKey);
    }
    if (
      scope === "task" &&
      (old?.exhaustedAt != null ||
        hasUnresolvedHostReadExhaustionEvent(this.store, id))
    ) {
      this.store.event(
        id,
        "host_read_transient_recovered",
        "Fresh host observation or owner control cleared the host-read wait",
      );
      this.resolution.settleAttentionEpisode(
        id,
        "Fresh host observation or owner control cleared the host-read wait",
      );
    }
  }
  resumeHostReadTransients(): void {
    if (this.engine.stopped) return;
    for (const task of this.store.liveTasks()) {
      if (task.removedAt || ["done", "cancelled"].includes(task.phase))
        continue;
      const episode = readHostReadTransientEpisode(this.store, task.id, "task");
      if (episode && episode.exhaustedAt == null)
        this.armHostReadTransient(task.id, episode.retryAt, "task");
    }
    for (const operation of this.store.operations({
      states: ["pending", "running"],
    })) {
      const episode = readHostReadTransientEpisode(
        this.store,
        operation.id,
        "op",
      );
      if (episode && episode.exhaustedAt == null)
        this.armHostReadTransient(operation.id, episode.retryAt, "op");
    }
  }
  armHostReadTransient(
    id: string,
    retryAt: number,
    scope: "task" | "op" | "question" = "task",
  ): void {
    const timerKey = `${scope}:${id}`;
    if (this.hostReadTransientTimers.has(timerKey) || this.engine.stopped)
      return;
    const timer = setTimeout(
      () => {
        this.hostReadTransientTimers.delete(timerKey);
        if (this.engine.stopped) return;
        if (scope === "op") {
          if (!this.store.getMeta("paused")) this.engine.scheduleOperation(id);
          return;
        }
        if (scope === "question") {
          void this.engine.cleanContext(() =>
            this.resolution.delegation.recoverPendingEscalationAnswers(),
          );
          return;
        }
        const task = this.store.taskOrNull(id);
        if (
          !task ||
          task.removedAt ||
          ["done", "cancelled"].includes(task.phase)
        )
          return;
        if (task.phase === "queued" && !task.workspaceId)
          void this.engine.cleanContext(() =>
            this.engine.wakeRepository(task.repoPath),
          );
        else void this.engine.cleanContext(() => this.engine.wakeTask(id));
      },
      Math.max(0, retryAt - Date.now()),
    );
    timer.unref();
    this.hostReadTransientTimers.set(timerKey, timer);
  }
  deferHostReadTransient(
    id: string,
    error: unknown,
    operation = false,
    step = "Host check",
  ): "wait" | "exhausted" {
    const scope = operation ? "op" : "task";
    const key = hostReadTransientKey(scope, id);
    const detail = error instanceof Error ? error.message : String(error);
    const old = readHostReadTransientEpisode(this.store, id, scope);
    const currentTask = !operation ? this.store.taskOrNull(id) : null;
    const currentOp = operation ? this.store.operation(id) : null;
    const context: HostReadFailureContext =
      !operation && currentTask
        ? taskHostReadContext(currentTask, step, old)
        : {
            step,
            hostId: currentOp?.hostId ?? old?.hostId ?? null,
            target: currentOp?.taskId
              ? `task ${currentOp.taskId}`
              : (old?.target ?? null),
            occurrenceKey: id,
          };
    const occurrenceMismatch = Boolean(
      old?.occurrenceKey &&
        context.occurrenceKey &&
        old.occurrenceKey !== context.occurrenceKey,
    );
    if (!claimHostReadTransientError(error) && old && !occurrenceMismatch)
      return old.exhaustedAt != null ? "exhausted" : "wait";
    const activeOld = occurrenceMismatch ? null : old;
    const limits = {
      limitMs: this.store.getMeta<number>("hostReadTransientLimitMs"),
      minAttempts: this.store.getMeta<number>("hostReadTransientMinAttempts"),
      maxAttempts: this.store.getMeta<number>("hostReadTransientMaxAttempts"),
    };
    const nowMs = Date.now();
    const legacyAlreadyExhausted = Boolean(
      !operation &&
        !activeOld &&
        currentTask &&
        hasUnresolvedHostReadExhaustionEvent(this.store, id) &&
        (currentTask.reasonFact?.code === "host_read_exhausted" ||
          currentTask.resolution.stop?.fact?.code === "host_read_exhausted"),
    );
    const next = legacyAlreadyExhausted
      ? null
      : nextHostReadTransientAttempt(activeOld, detail, nowMs, limits, context);
    if (!next) {
      const timerKey = `${scope}:${id}`;
      const timer = this.hostReadTransientTimers.get(timerKey);
      if (timer) {
        clearTimeout(timer);
        this.hostReadTransientTimers.delete(timerKey);
      }
      const reason = hostReadTransientEscalationReason(
        context.step ?? step,
        activeOld,
        detail,
        nowMs,
        context,
      );
      if (operation) {
        const current = this.store.operation(id);
        const exhaustedEpisode: HostReadTransientEpisode = {
          startedAt: activeOld?.startedAt ?? nowMs,
          attempts: activeOld?.attempts ?? 0,
          retryAt: 0,
          detail: detail.slice(0, 1000),
          step: context.step ?? activeOld?.step ?? step,
          hostId: context.hostId ?? activeOld?.hostId ?? null,
          target: context.target ?? activeOld?.target ?? null,
          occurrenceKey:
            context.occurrenceKey ?? activeOld?.occurrenceKey ?? null,
          exhaustedAt: activeOld?.exhaustedAt ?? nowMs,
        };
        this.store.setMeta(key, exhaustedEpisode);
        if (current && !["succeeded", "failed"].includes(current.state)) {
          this.store.putOperation({
            ...current,
            state: current.preSendBoundaryStartedAt
              ? "needs_attention"
              : "failed",
            settledAt: now(),
            diagnostic: reason.slice(0, 4000),
            effect: current.effect
              ? {
                  ...current.effect,
                  status: "reconciled",
                  result: reason.slice(0, 2000),
                  resultAt: now(),
                }
              : null,
          });
        }
      } else {
        const current = this.store.taskOrNull(id);
        const episodeTag = `${activeOld?.startedAt ?? 0}:${detail.slice(0, 120)}`;
        const alreadyExhaustedAttention = Boolean(
          current &&
            (legacyAlreadyExhausted ||
              ((current.phase === "needs_attention" ||
                current.resolution.stop?.reason === "operator_needed") &&
                (activeOld?.exhaustedAt != null ||
                  this.store
                    .eventsAll(id)
                    .some(
                      (event) =>
                        event.kind === "host_read_transient_exhausted" &&
                        event.detail.startsWith(episodeTag),
                    )))),
        );
        const moveTaskToAttention = Boolean(
          current &&
            !this.store.getMeta("paused") &&
            ["queued", "dispatching"].includes(current.phase),
        );
        if (!alreadyExhaustedAttention) {
          this.store.setMeta(key, {
            startedAt: activeOld?.startedAt ?? nowMs,
            attempts: activeOld?.attempts ?? 0,
            retryAt: 0,
            detail: detail.slice(0, 1000),
            step: context.step ?? activeOld?.step ?? step,
            hostId: context.hostId ?? activeOld?.hostId ?? null,
            target: context.target ?? activeOld?.target ?? null,
            occurrenceKey:
              context.occurrenceKey ?? activeOld?.occurrenceKey ?? null,
            exhaustedAt: activeOld?.exhaustedAt ?? nowMs,
            resumePhase: activeOld?.resumePhase ?? context.resumePhase ?? null,
            movedToAttention:
              activeOld?.movedToAttention || moveTaskToAttention,
          } satisfies HostReadTransientEpisode);
          if (
            !this.store
              .eventsAll(id)
              .some(
                (event) =>
                  event.kind === "host_read_transient_exhausted" &&
                  event.detail.startsWith(episodeTag),
              )
          ) {
            this.store.event(
              id,
              "host_read_transient_exhausted",
              `${episodeTag}: ${reason}`.slice(0, 2000),
            );
          }
          this.engine.note(
            id,
            reason,
            "operator_needed",
            moveTaskToAttention ? "needs_attention" : undefined,
            ["restart", "move"],
          );
        } else {
          if (!activeOld || activeOld.exhaustedAt == null) {
            this.store.setMeta(key, {
              startedAt: activeOld?.startedAt ?? nowMs,
              attempts: activeOld?.attempts ?? 0,
              retryAt: 0,
              detail: activeOld?.detail ?? detail.slice(0, 1000),
              step: context.step ?? activeOld?.step ?? step,
              hostId: context.hostId ?? activeOld?.hostId ?? null,
              target: context.target ?? activeOld?.target ?? null,
              occurrenceKey:
                context.occurrenceKey ?? activeOld?.occurrenceKey ?? null,
              exhaustedAt: nowMs,
              resumePhase:
                activeOld?.resumePhase ?? context.resumePhase ?? null,
              movedToAttention:
                activeOld?.movedToAttention ||
                current?.phase === "needs_attention",
            } satisfies HostReadTransientEpisode);
          }
          if (
            current &&
            (current.reasonFact?.code === "creating_worker" ||
              current.resolution.stop?.reason === "route_unavailable")
          ) {
            this.engine.note(
              id,
              current.resolution.stop?.fact?.code === "host_read_exhausted"
                ? current.resolution.stop.detail
                : reason,
              "operator_needed",
              moveTaskToAttention ? "needs_attention" : undefined,
              ["restart", "move"],
            );
          }
        }
      }
      return "exhausted";
    }
    this.store.setMeta(key, next);
    const scopeParts = [
      next.hostId ? `host ${next.hostId}` : null,
      next.target || null,
    ].filter(Boolean);
    const scopeText = scopeParts.length ? ` (${scopeParts.join(", ")})` : "";
    const visible = `${next.step ?? step} read incomplete${scopeText}; retrying automatically (attempt ${next.attempts}): ${detail}`;
    if (operation) {
      const current = this.store.operation(id);
      if (current)
        this.store.putOperation({
          ...current,
          state: "pending",
          settledAt: null,
          diagnostic: visible.slice(0, 4000),
        });
    } else {
      const task = this.store.taskOrNull(id);
      if (task) this.resolution.waiting(task, visible, "external_unavailable");
    }
    this.armHostReadTransient(id, next.retryAt, scope);
    return "wait";
  }

  noteStepFailure(taskId: string, error: unknown) {
    const current = this.store.task(taskId);
    const terminal = ["done", "cancelled"].includes(current.phase);
    if (!terminal && error instanceof HostReadRefusalError) {
      this.deferHostReadTransient(taskId, error, false);
      return;
    }
    const gitTransient =
      !terminal && this.engine.deferGitTransient(taskId, error);
    switch (
      stepFailureRoute({
        terminal,
        gitTransient,
        checkoutRefusal: error instanceof CheckoutRefusalError,
        externalWait:
          error instanceof WorkspaceObservationUnavailableError ||
          error instanceof ForgeOutageError ||
          error instanceof CheckoutUnavailableError ||
          error instanceof HostReadRefusalError,
        transport: isTransportFailure(error),
        session:
          error instanceof LoginSessionFaultError || isLoginSessionFault(error),
      })
    ) {
      case "git_transient":
        return;
      case "cleanup":
        this.store.update(
          taskId,
          {
            resolution: {
              ...current.resolution,
              cleanupReason: String(
                error instanceof Error ? error.message : error,
              ),
            },
          },
          "cleanup_failed",
        );
        return;
      case "checkout_refusal":
        this.engine.note(
          taskId,
          (error as Error).message,
          "operator_needed",
          this.store.getMeta("paused") ? undefined : "needs_attention",
        );
        return;
      case "external_wait":
        this.resolution.waiting(
          this.store.task(taskId),
          (error as Error).message,
          "external_unavailable",
        );
        return;
      case "transport":
        this.resolution.transportDeferred(this.store.task(taskId), error);
        return;
      case "session":
        this.resolution.environmentDeferred(this.store.task(taskId), error);
        return;
      case "attention":
        this.engine.note(
          taskId,
          String(error instanceof Error ? error.message : error),
          "classify",
          this.store.getMeta("paused") ? undefined : "needs_attention",
        );
    }
  }

  /**
   * Whether a wake-triggered quantum for `taskId` needs a host-side snapshot
   * prefetch before acquiring `task:<taskId>`. Returning false keeps trivial
   * wakes (e.g. queued tasks or live in-flight turns) on a single hop while
   * `TaskQuantumReadScope` still forbids any direct expensive read inside the
   * task lane.
   */
  private needsWakePrefetch(taskId: string): boolean {
    if (this.engine.stopped) return false;
    const task = this.store.taskOrNull(taskId);
    if (
      !task ||
      task.removedAt ||
      ["queued", "working", "reviewing", "done", "cancelled"].includes(
        task.phase,
      ) ||
      !task.hostId ||
      !this.engine.taskHostAvailable(task)
    )
      return false;
    const adapter = this.engine.adapter;
    if (!adapter.agentTimelinePage && !adapter.hostProcessListing) return false;
    const runs = this.store.runs(taskId);
    return knownExecutionParticipantIds(task, runs).length > 0;
  }

  /**
   * Spec 068 §6: host-side snapshot priming for wake-triggered quanta outside
   * `auditPass`. Runs BEFORE acquiring the exclusive `task:<taskId>` lane so
   * expensive timeline and process reads never run inside a task lane; the host
   * is sealed before the snapshot is handed to `scheduleTaskQuantum`.
   */
  private primeWakeSnapshot(taskId: string): Promise<PassSnapshot | undefined> {
    if (!this.needsWakePrefetch(taskId)) return Promise.resolve(undefined);
    return runOutsideTaskQuantumScope(() => this.runPrimeWakeSnapshot(taskId));
  }

  private async runPrimeWakeSnapshot(
    taskId: string,
  ): Promise<PassSnapshot | undefined> {
    if (this.engine.stopped) return undefined;
    const task = this.store.taskOrNull(taskId);
    if (
      !task ||
      task.removedAt ||
      ["done", "cancelled"].includes(task.phase) ||
      !task.hostId ||
      !this.engine.taskHostAvailable(task)
    )
      return undefined;
    const adapter = this.engine.adapter;
    if (!adapter.agentTimelinePage && !adapter.hostProcessListing)
      return undefined;
    const runs = this.store.runs(taskId);
    const participants = knownExecutionParticipantIds(task, runs);
    if (!participants.length) return undefined;

    const hostId = task.hostId;
    const snapshot = new PassSnapshot();
    const budgetMs =
      this.resolution.hostPassWarmBudgetMs ?? HOST_PASS_WARM_BUDGET_MS;
    const perReadMs =
      this.resolution.quantumReadTimeoutMs ?? QUANTUM_READ_DEADLINE_MS;
    const processDeadlineMs =
      this.resolution.passProcessReadTimeoutMs ?? PASS_PROCESS_READ_DEADLINE_MS;
    const deadlineAt = Date.now() + Math.max(0, budgetMs);
    const remaining = () => Math.max(0, deadlineAt - Date.now());

    try {
      await this.engine.withHost(hostId, async () => {
        let needsProcesses = false;
        for (const { agentId, workspaceId } of participants) {
          if (this.engine.stopped || remaining() <= 0) break;
          let obs: Awaited<ReturnType<Engine["host"]["observe"]>> | null = null;
          try {
            const read = await boundedRead(
              "participant observation",
              () => this.engine.host.observe(agentId),
              Math.min(remaining(), perReadMs),
            );
            if (read.state === "ok") obs = read.value;
          } catch {
            if (adapter.originAgent && remaining() > 0) {
              const originRead = await boundedRead(
                "origin agent observation",
                () => this.engine.host.originAgent(agentId),
                Math.min(remaining(), perReadMs),
              ).catch(() => ({
                state: "unknown" as const,
                reason: "origin read failed",
              }));
              if (originRead.state === "ok") {
                const origin = originRead.value;
                if (!origin || origin.deleted === true) {
                  obs = {
                    id: agentId,
                    workspaceId: origin?.workspaceId ?? workspaceId ?? "",
                    status: "gone",
                    active: false,
                    activeTurnId: null,
                    permissions: false,
                    error: "",
                    archived: true,
                  };
                } else if (origin.archived === true) {
                  obs = {
                    id: agentId,
                    workspaceId: origin.workspaceId,
                    status: "closed",
                    active: false,
                    activeTurnId: null,
                    permissions: false,
                    error: "",
                    archived: true,
                  };
                }
              }
            }
          }
          if (!obs) continue;
          snapshot.recordHostObservation(hostId, agentId, obs);
          const inactive =
            Boolean(
              !obs.active &&
                !obs.permissions &&
                !obs.activeTurnId &&
                ["idle", "error", "closed", "gone"].includes(obs.status ?? ""),
            ) || obs.archived === true;
          if (
            obs.status === "closed" ||
            obs.status === "gone" ||
            obs.archived === true
          )
            needsProcesses = true;
          if (adapter.agentTimelinePage && inactive && remaining() > 0) {
            const pageRead = await snapshot
              .timelinePage(
                hostId,
                agentId,
                TOOL_TIMELINE_LIMIT,
                () =>
                  this.engine.host.agentTimelinePage(
                    agentId,
                    TOOL_TIMELINE_LIMIT,
                  ),
                Math.min(remaining(), perReadMs),
                {
                  coveredObservation: {
                    updatedAt: obs.updatedAt ?? null,
                    status: obs.status,
                    archived: obs.archived,
                  },
                },
              )
              .catch(() => null);
            let page = pageRead?.state === "ok" ? pageRead.value : null;
            if (
              page &&
              page.hasOlder &&
              !page.gap &&
              !page.staleCursor &&
              !page.reset &&
              page.projection !== "bounded" &&
              remaining() > 0
            ) {
              let limit = TOOL_TIMELINE_LIMIT;
              for (
                let step = 1;
                step < TOOL_TIMELINE_READ_BUDGET &&
                page &&
                page.hasOlder === true &&
                !page.gap &&
                !page.staleCursor &&
                !page.reset &&
                page.projection !== "bounded" &&
                remaining() > 0;
                step++
              ) {
                limit *= 2;
                const expanded = await boundedRead(
                  "agent timeline page",
                  () => this.engine.host.agentTimelinePage(agentId, limit),
                  Math.min(remaining(), perReadMs),
                ).catch(() => ({
                  state: "unknown" as const,
                  reason: "expanded timeline read failed",
                }));
                if (expanded.state !== "ok") break;
                page = expanded.value;
                snapshot.storeTimelinePage(hostId, agentId, limit, {
                  state: "ok",
                  value: page,
                  capturedAt: Date.now(),
                  fromPassSnapshot: true,
                  coveredObservation: {
                    updatedAt: obs.updatedAt ?? null,
                    status: obs.status,
                    archived: obs.archived,
                  },
                });
              }
            }
            if (
              page &&
              (page.projection === "bounded" ||
                liveToolIssueFact(page.entries ?? []) !== null)
            )
              needsProcesses = true;
          }
        }
        if (needsProcesses && adapter.hostProcessListing && remaining() > 0) {
          await snapshot.processes(
            hostId,
            async () => {
              try {
                const listed = await adapter.hostProcessListing!();
                return listed
                  ? { state: "listed", processes: listed }
                  : {
                      state: "unknown",
                      reason: "the host process listing is unreadable",
                    };
              } catch (error) {
                return {
                  state: "unknown",
                  reason: `host process listing failed: ${error instanceof Error ? error.message : String(error)}`,
                };
              }
            },
            Math.min(remaining(), processDeadlineMs),
          );
        }
      });
    } catch {
      /* a host-side wake prefetch failure leaves the sealed snapshot empty; task quantum defers */
    }
    snapshot.sealHost(hostId);
    return snapshot;
  }

  /** One bounded lifecycle quantum for a task on its exclusive lane key. */
  scheduleTaskQuantum(
    taskId: string,
    passSnapshot?: PassSnapshot,
  ): Promise<void> {
    return this.engine.scheduleLane(
      `task:${taskId}`,
      LANE_PRIORITY_TASK,
      async () => {
        try {
          const task = this.store.task(taskId);
          if (!task.hostId) return;
          const budgetMs =
            this.resolution.quantumReadBudgetMs ?? QUANTUM_TOTAL_READ_BUDGET_MS;
          return await runInTaskQuantumScope(
            budgetMs,
            () =>
              this.engine.withHost(task.hostId!, async () => {
                if (this.engine.gitTransientWaiting(taskId)) return;
                const transientBefore =
                  this.store.getMeta<GitTransientEpisode | null>(
                    this.engine.transientKey(taskId),
                  );
                const before = this.store.task(taskId);
                if (!this.engine.taskHostAvailable(before)) return;
                const heldIntegration =
                  this.resolution.holdsIntegrationTurn(before);
                const beforeRuns = this.store.runs(taskId);
                const threadWorkBefore = this.engine.terminalThreadsPending(
                  before,
                  beforeRuns,
                );
                const occupied = occupiesSlot(before, beforeRuns);
                // The sweep observes retained runs separately; a callback or status hint must
                // be able to observe its own reported run without waiting for that pass.
                if (
                  !settlementHeld(this.store, this.engine.stopped) &&
                  beforeRuns.some(
                    (run) =>
                      !run.released &&
                      run.role !== "recovery" &&
                      (run.completion ||
                        (run.active &&
                          Date.now() -
                            Date.parse(run.lastObservedAt ?? run.createdAt) >=
                            16000)),
                  )
                )
                  await this.resolution.observe(null, taskId);
                for (const previous of beforeRuns) {
                  const current = this.store.run(previous.id);
                  if (
                    !previous.released &&
                    current?.released &&
                    current.completion
                  )
                    markPhaseFact(
                      this.store,
                      taskId,
                      `release:${current.id}:${current.completion.eventId}`,
                      `${current.role} result released; next step awaiting admission`,
                    );
                }
                await this.resolution.integrationQuantum(taskId, () =>
                  this.engine.taskQuantum(taskId),
                );
                if (settlementHeld(this.store, this.engine.stopped)) return;
                this.engine.completionFollowUps.finishQuantum(
                  taskId,
                  before,
                  beforeRuns,
                  transientBefore,
                  heldIntegration,
                  threadWorkBefore,
                  occupied,
                );
              }),
            passSnapshot,
            true,
          );
        } finally {
          passSnapshot?.expire();
        }
      },
      { coalesce: "task-quantum" },
    );
  }

  /**
   * Queue #705: a task whose closeout is written owes nothing more of the
   * repository's integration turn, whatever thread or workspace cleanup its
   * quantum still runs. Wake the earliest task that now holds the turn, from
   * this repository's turn index, so the next merge never waits for the
   * closed-out task's quantum or a fleet sweep.
   */
  wakeIntegrationSuccessor(repoPath: string): void {
    if (this.engine.stopped) return;
    const holder =
      this.store
        .integrationTasks(repoPath)
        .find((task) => this.resolution.holdsIntegrationTurn(task)) ?? null;
    for (const candidate of this.store.tasks()) {
      if (
        candidate.repoPath !== repoPath ||
        candidate.removedAt != null ||
        ["done", "cancelled"].includes(candidate.phase)
      )
        continue;
      const isTurnWait =
        candidate.resolution.stop?.fact?.code === "integration_turn" ||
        candidate.reasonFact?.code === "integration_turn";
      if (!isTurnWait) continue;
      if (!holder || holder.id === candidate.id) {
        this.store.update(candidate.id, {
          resolution: {
            ...candidate.resolution,
            ...(candidate.resolution.stop?.fact?.code === "integration_turn"
              ? { stop: null }
              : {}),
          },
          reason: "Task progressing",
          reasonFact: null,
        });
      } else if (candidate.resolution.stop?.fact?.subject !== holder.id) {
        const holderDetail =
          holder.resolution.stop?.fact?.code === "integration_turn" ||
          holder.reasonFact?.code === "integration_turn"
            ? "integration work pending"
            : holder.reason;
        this.resolution.waiting(
          candidate,
          `Waiting for repository integration turn: ${holder.title} (${holder.id}) holds it — ${holderDetail}`.slice(
            0,
            2000,
          ),
          "lifecycle",
          { fact: { code: "integration_turn", subject: holder.id } },
        );
      }
    }
    const next = this.store
      .integrationTasks(repoPath)
      .filter((task) => this.resolution.holdsIntegrationTurn(task))
      .sort(
        (left, right) =>
          (left.resolution.integrationTurn?.sequence ?? 0) -
          (right.resolution.integrationTurn?.sequence ?? 0),
      )[0];
    if (next) this.engine.scheduleLifecycleFollowUp(next.id);
  }

  /**
   * A freed global slot can belong to another project. Select one eligible
   * waiter using the existing fair admission rule; do not run a fleet sweep.
   *
   * A candidate is a task that could take the freed slot: not the one that
   * released it, not behind a dispatch hold, not parked on an unroutable stop,
   * holding no slot now, and in a phase that wants one. A ready waiter is a
   * candidate whose own current reads (prerequisites, in-flight admission, the
   * slot refusal) say the slot is its to take.
   */
  wakeCapacityWaiter(releasingTaskId: string): void {
    const held = this.store.getMeta<boolean>("dispatchHeld") ?? false;
    const candidate = (task: Task) =>
      task.id !== releasingTaskId &&
      !(held && boardDispatchHoldApplies(task)) &&
      (!routeUnavailableStop(task) || this.store.routingRetryAllowed(task)) &&
      !occupiesSlot(task) &&
      (task.phase === "queued" || recordedSlotWait(task)) &&
      [
        "queued",
        "awaiting_review",
        "changes_requested",
        "reviewing",
        "closing",
      ].includes(task.phase);
    const ready = (task: Task) =>
      Boolean(
        task.hostId &&
          this.engine.withHost(task.hostId, () =>
            this.engine.taskHostAvailable(task),
          ),
      ) &&
      !prerequisiteWaitBlocksPhase(task) &&
      (task.phase !== "queued" ||
        (!this.store.dependencyWait(task) &&
          !this.resolution.projectInFlightAdmissionReason(task))) &&
      !this.resolution.slotAdmissionReason(task);
    const tasks = this.store.admissionCandidates();
    const next = fairSlotRequestOrder(
      tasks,
      candidate,
      tasks.filter((task) => occupiesSlot(task)),
    ).find(ready);
    if (!next) return;
    markPhaseFact(
      this.store,
      next.id,
      `capacity:${releasingTaskId}:${next.version}`,
      "Freed slot awaiting admission",
    );
    this.engine.cleanContext(() => {
      if (next.phase !== "queued") {
        void this.engine.cleanContext(() => this.engine.wakeTask(next.id));
        return;
      }
      void this.engine
        .scheduleLane(`task:${next.id}`, LANE_PRIORITY_TASK, () => {
          return this.engine.dispatchTask(
            next.id,
            this.store.getMeta<boolean>("dispatchHeld") ?? false,
          );
        })
        .catch((error) =>
          recordWakeFailure(
            this.store,
            this.engine.stopped,
            next.id,
            "Freed-slot dispatch",
            error,
          ),
        );
    });
  }

  scheduleLifecycleFollowUp(taskId: string): boolean {
    if (this.lifecycleFollowUps.has(taskId)) return true;
    this.lifecycleFollowUps.add(taskId);
    const queuedAt = now();
    setImmediate(() => {
      let handedOff = false;
      try {
        if (settlementHeld(this.store, this.engine.stopped)) return;
        let task: Task;
        try {
          task = this.store.task(taskId);
        } catch {
          return;
        }
        if (task.removedAt || dispatchBlocked(task)) return;
        markPhaseFact(
          this.store,
          taskId,
          `phase:${task.version}`,
          `${task.phase} follow-up awaiting admission`,
          queuedAt,
        );
        // AsyncLocalStorage propagates through setImmediate. Exit the old lane
        // context so this queues behind it instead of taking the inline path.
        this.engine.cleanContext(() => {
          handedOff = true;
          void this.primeWakeSnapshot(taskId)
            .then((wakeSnapshot) => {
              const scheduled = this.engine
                .scheduleTaskQuantum(taskId, wakeSnapshot)
                .finally(() => wakeSnapshot?.expire());
              this.lifecycleFollowUps.delete(taskId);
              this.engine.scheduleDispatch();
              return scheduled;
            })
            .catch((error) => {
              this.lifecycleFollowUps.delete(taskId);
              this.engine.scheduleDispatch();
              recordWakeFailure(
                this.store,
                this.engine.stopped,
                taskId,
                "Lifecycle follow-up",
                error,
              );
            });
        });
      } finally {
        // Keep the id in the set until the lane is queued (or this turn
        // no-ops) so quiesce cannot observe an empty engine in the gap
        // between "accepted follow-up" and "enqueued quantum".
        if (!handedOff) {
          this.lifecycleFollowUps.delete(taskId);
          this.engine.scheduleDispatch();
        }
      }
    });
    return true;
  }

  /** Drive the task named by a callback/control without waking the full fleet. */
  wakeTask(taskId: string): Promise<void> {
    if (this.engine.stopped) return Promise.resolve();
    // A callback or control is authoritative evidence that this task's agents
    // changed state, so its cached observations must not answer for them.
    const admission = this.admission;
    try {
      const task = this.store.task(taskId);
      const runs = this.store.runs(taskId);
      const callbacks = runs
        .filter((run) => !run.released && run.completion)
        .map((run) => run.completion!);
      if (task.phase === "working" && task.completion?.runId === task.runId)
        callbacks.push(task.completion);
      const events = callbacks.length ? this.store.eventsAll(taskId) : [];
      for (const callback of callbacks) {
        const event = events.findLast(
          (item) =>
            item.kind ===
            (callback.runId === task.runId
              ? "completion_received"
              : "run_completion"),
        );
        markPhaseFact(
          this.store,
          taskId,
          `callback:${callback.eventId}`,
          "Accepted result awaiting task admission",
          event?.at ?? now(),
        );
      }
      if (admission)
        for (const id of [
          task.agentId,
          task.coordinatorAgentId,
          task.resolution.reviewerAgentId,
          ...runs
            .filter((run) => !run.released && run.completion)
            .map((run) => run.agentId),
        ])
          admission.invalidate(id ?? "");
    } catch {
      /* a purged or missing task has no observation or latency to record */
    }
    // A discarded quantum at shutdown has no caller with a durable decision to
    // make: the task lane records its own faults, so callers stay fire-and-forget.
    // A wake that fails with the engine still running is recorded on the task.
    // Spec 068 §6: host-side snapshot priming runs on a separate coalesced
    // `wake-prefetch:<taskId>` lane (never holding `task:<taskId>`) so bursts
    // coalesce and `quiesce()` tracks the entire wake synchronously.
    const runQuantum = this.needsWakePrefetch(taskId)
      ? this.engine.scheduleLane(
          `wake-prefetch:${taskId}`,
          LANE_PRIORITY_TASK,
          async () => {
            const wakeSnapshot = await this.primeWakeSnapshot(taskId);
            return this.engine
              .scheduleTaskQuantum(taskId, wakeSnapshot)
              .finally(() => wakeSnapshot?.expire());
          },
          { coalesce: "wake-prefetch" },
        )
      : this.engine.scheduleTaskQuantum(taskId);
    return runQuantum
      .then(() => {
        if (
          this.store.taskOrNull(taskId)?.resolution.deferredVerb?.input
            .__workerAsk
        )
          void this.engine
            .cleanContext(() => this.engine.applyDeferredOwnerVerbs())
            .catch((error) =>
              recordWakeFailure(
                this.store,
                this.engine.stopped,
                taskId,
                "Deferred direction wake",
                error,
              ),
            );
      })
      .catch((error) =>
        recordWakeFailure(
          this.store,
          this.engine.stopped,
          taskId,
          "Task quantum wake",
          error,
        ),
      );
  }

  /**
   * Drive only one repository's queued lanes. A submission, promotion or
   * released capacity schedules the affected repository; it never authorizes a
   * fleet-wide pass. A pass-level failure loses no state: the queue is durable
   * and each task the dispatch pass visits records its own fault, so the next
   * repository wake is the retry and this stays a fire-and-forget call.
   */
  wakeRepository(repoPath: string | null | undefined): Promise<void> {
    if (this.engine.stopped || !repoPath) return Promise.resolve();
    return this.engine.dispatchQueued(repoPath).catch(() => {
      /* the durable queue keeps every task the pass did not reach */
    });
  }

  /** Clears every pending timer. `Engine.stop` calls this before the projections stop. */
  stop(): void {
    for (const timer of this.gitTransientTimers.values()) clearTimeout(timer);
    this.gitTransientTimers.clear();
    for (const timer of this.hostReadTransientTimers.values())
      clearTimeout(timer);
    this.hostReadTransientTimers.clear();
    this.engine.completionFollowUps.stop();
  }
}
