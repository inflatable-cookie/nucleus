import type { Engine } from "../engine";
import type { Run, Task } from "../../shared/contracts";
import { classifyGitTransientFailure, ForgeOutageError, gitDeliveryUnknown, ReviewPublicationTransientError } from "../forge/forge-health";
import { GIT_TRANSIENT_LIMIT_MS, nextGitTransientAttempt, type GitTransientEpisode } from "../git/git-transient-backoff";
import { boardDispatchHoldApplies } from "../../shared/board-dispatch-hold";
import { CheckoutRefusalError, CheckoutUnavailableError } from "../workspaces/checkout-volume";
import { CAPACITY_WAIT_PREFIX } from "../../shared/wait-state";
import { WorkspaceObservationUnavailableError } from "../workspaces/workspace-allocation";
import { isTransportFailure } from "../../shared/transport";
import { isLoginSessionFault, LoginSessionFaultError } from "../../shared/session-fault";
import { dispatchBlocked, fairSlotRequestOrder, occupiesSlot } from "../dispatch/capacity";
import { LANE_PRIORITY_TASK } from "./lane-priorities";
import { now } from "../store/store";
import { settlementHeld, startsNoRuns } from "../closeout/queue-drain";

/** Named git-transient plan over already-read store facts. */
export type GitTransientPlan =
  | { kind: 'ignore' }
  | { kind: 'skip_unknown' }
  | { kind: 'exhausted'; failureKind: 'lock' | 'ssh' | 'network'; attempts: number; detail: string }
  | { kind: 'retry_lock'; episode: GitTransientEpisode; detail: string }
  | { kind: 'retry_shared'; episode: GitTransientEpisode; host: GitTransientEpisode; detail: string };

export function gitTransientPlan(facts: {
  failureKind: 'lock' | 'ssh' | 'network' | null;
  deliveryUnknown: boolean;
  publicationTransient: boolean;
  operation: boolean;
  hasReviewPublication: boolean;
  old: GitTransientEpisode | null;
  host: GitTransientEpisode | null;
  detail: string;
  now: number;
}): GitTransientPlan {
  if (!facts.failureKind) return { kind: 'ignore' };
  if (facts.deliveryUnknown && (facts.operation || !facts.publicationTransient || !facts.hasReviewPublication))
    return { kind: 'skip_unknown' };
  const next = nextGitTransientAttempt(facts.old, facts.detail, facts.now);
  if (!next) return { kind: 'exhausted', failureKind: facts.failureKind, attempts: facts.old?.attempts ?? 0, detail: facts.detail };
  if (facts.failureKind !== 'lock') {
    const shared = facts.host && facts.host.retryAt > facts.now
      ? facts.host
      : nextGitTransientAttempt(facts.host ?? null, facts.detail, facts.now) ?? next;
    next.retryAt = Math.min(next.startedAt + GIT_TRANSIENT_LIMIT_MS, shared.retryAt);
    return { kind: 'retry_shared', episode: next, host: shared, detail: facts.detail };
  }
  return { kind: 'retry_lock', episode: next, detail: facts.detail };
}

/** Route a step failure after the git-transient gate. */
export type StepFailureRoute = 'git_transient' | 'cleanup' | 'checkout_refusal' | 'external_wait' | 'transport' | 'session' | 'attention';

export function stepFailureRoute(facts: {
  terminal: boolean;
  gitTransient: boolean;
  checkoutRefusal: boolean;
  externalWait: boolean;
  transport: boolean;
  session: boolean;
}): StepFailureRoute {
  if (!facts.terminal && facts.gitTransient) return 'git_transient';
  if (facts.terminal) return 'cleanup';
  if (facts.checkoutRefusal) return 'checkout_refusal';
  if (facts.externalWait) return 'external_wait';
  if (facts.transport) return 'transport';
  if (facts.session) return 'session';
  return 'attention';
}

export { quantumFollowUps, type QuantumFollowUp } from '../closeout/completion-follow-ups';

/**
 * Task wakes: what a task's quantum owes after it runs, the bounded timers that
 * retry those follow-ups, and the git-transient backoff. Same-name `Engine`
 * methods delegate here. `store`, `resolution` and `admission` read the engine
 * per call, and moved code calls its siblings through `this.engine`, so
 * instance overrides still fire. `Engine.stop` calls `stop()`.
 */
export type TaskWakesContext = Pick<Engine, 'resolution' | 'admission' | 'armGitTransient' | 'cleanContext' | 'completionFollowUps' | 'deferGitTransient' | 'dispatchQueued' | 'dispatchTask' | 'gitTransientWaiting' | 'note' | 'scheduleDispatch' | 'scheduleLane' | 'scheduleLifecycleFollowUp' | 'scheduleOperation' | 'scheduleTaskQuantum' | 'stopped' | 'store' | 'taskHostAvailable' | 'taskQuantum' | 'terminalThreadsPending' | 'transientKey' | 'wakeTask' | 'withHost'>;

export class TaskWakes {
  constructor(readonly engine: TaskWakesContext) {}
  get store() { return this.engine.store; }
  get resolution() { return this.engine.resolution; }
  get admission() { return this.engine.admission; }
  readonly lifecycleFollowUps = new Set<string>();
  private readonly gitTransientTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Record a step failure. A transport failure leaves the lane where it is so the next
   * sweep retries it; anything else is a task fault and parks for attention as before.
   */
  transientKey(id: string): string { return `gitTransient:${id}`; }
  armGitTransient(id: string, retryAt: number, operation = false): void {
    if (this.gitTransientTimers.has(id) || this.engine.stopped) return;
    const timer = setTimeout(() => {
      this.gitTransientTimers.delete(id);
      if (this.engine.stopped) return;
      if (operation) {
        if (settlementHeld(this.store, this.engine.stopped)) return;
        this.engine.cleanContext(() => this.engine.scheduleOperation(id));
      } else {
        const task = this.store.task(id);
        if (task.phase === 'queued') {
          if (startsNoRuns(this.store, this.engine.stopped)) return;
          void this.engine.cleanContext(() => this.engine.scheduleLane(`task:${id}`, LANE_PRIORITY_TASK, () => this.engine.dispatchTask(id, this.store.getMeta<boolean>('dispatchHeld') ?? false))).catch(() => {});
        } else {
          if (settlementHeld(this.store, this.engine.stopped)) return;
          void this.engine.cleanContext(() => this.engine.wakeTask(id));
        }
      }
    }, Math.max(0, retryAt - Date.now()));
    timer.unref();
    this.gitTransientTimers.set(id, timer);
  }
  deferGitTransient(id: string, error: unknown, operation = false): boolean {
    const failureKind = classifyGitTransientFailure(error);
    const deliveryUnknown = gitDeliveryUnknown(error);
    const publicationTransient = error instanceof ReviewPublicationTransientError;
    let hasReviewPublication = false;
    if (failureKind && deliveryUnknown && !operation && publicationTransient) {
      const runId = this.store.task(id).resolution.currentRunId;
      // Only the publication protocol can observe this write on the next pass.
      hasReviewPublication = Boolean(runId && this.store.getMeta(`reviewPublication:${runId}`));
    }
    const skipUnknown = Boolean(failureKind && deliveryUnknown && (operation || !publicationTransient || !hasReviewPublication));
    const key = this.engine.transientKey(id);
    const old = failureKind && !skipUnknown ? (this.store.getMeta<GitTransientEpisode | null>(key) ?? null) : null;
    const host = failureKind && failureKind !== 'lock' && !skipUnknown
      ? this.store.getMeta<GitTransientEpisode | null>('gitTransientHost:github') ?? null : null;
    const detail = failureKind && !skipUnknown
      ? (error instanceof Error ? error.message : String(error)).replace(/; operator SSH\/key inspection required/g, '').slice(0, 800)
      : '';
    const plan = gitTransientPlan({
      failureKind, deliveryUnknown, publicationTransient, operation, hasReviewPublication, old, host, detail, now: Date.now(),
    });
    if (plan.kind === 'ignore' || plan.kind === 'skip_unknown') return false;
    if (plan.kind === 'exhausted') {
      this.store.deleteMeta(key);
      const reason = `Git or GitHub failed after ${plan.attempts} retries over 15 minutes: ${plan.detail}${plan.failureKind === 'ssh' ? '; inspect SSH authentication and keys' : ''}`;
      if (operation) {
        const current = this.store.operation(id);
        if (current) this.store.putOperation({ ...current, state: 'needs_attention', settledAt: now(), diagnostic: reason });
      } else this.engine.note(id, reason, 'operator_needed', 'needs_attention');
      return true;
    }
    if (plan.kind === 'retry_shared') this.store.setMeta('gitTransientHost:github', plan.host);
    const next = plan.episode;
    const source = this.resolution.gitFailureSource(error);
    if (source ?? old?.source) next.source = source ?? old?.source;
    this.store.setMeta(key, next);
    const reason = `Git or GitHub failed: ${plan.detail}. Retrying at ${new Date(next.retryAt).toISOString()}`;
    if (operation) {
      const current = this.store.operation(id);
      if (current) this.store.putOperation({ ...current, state: 'pending', settledAt: null, diagnostic: reason });
    } else this.resolution.waiting(this.store.task(id), reason, 'external_unavailable');
    this.engine.armGitTransient(id, next.retryAt, operation);
    return true;
  }
  gitTransientWaiting(id: string, operation = false): boolean {
    const episode = this.store.getMeta<GitTransientEpisode | null>(this.engine.transientKey(id));
    if (!episode || episode.retryAt <= Date.now()) return false;
    this.engine.armGitTransient(id, episode.retryAt, operation);
    return true;
  }
  noteStepFailure(taskId: string, error: unknown) {
    const current = this.store.task(taskId);
    const terminal = ['done', 'cancelled'].includes(current.phase);
    const gitTransient = !terminal && this.engine.deferGitTransient(taskId, error);
    switch (stepFailureRoute({
      terminal, gitTransient,
      checkoutRefusal: error instanceof CheckoutRefusalError,
      externalWait: error instanceof WorkspaceObservationUnavailableError || error instanceof ForgeOutageError || error instanceof CheckoutUnavailableError,
      transport: isTransportFailure(error),
      session: error instanceof LoginSessionFaultError || isLoginSessionFault(error),
    })) {
      case 'git_transient': return;
      case 'cleanup':
        this.store.update(taskId, { resolution: { ...current.resolution, cleanupReason: String(error instanceof Error ? error.message : error) } }, 'cleanup_failed');
        return;
      case 'checkout_refusal':
        this.engine.note(taskId, (error as Error).message, 'operator_needed', this.store.getMeta("paused") ? undefined : "needs_attention");
        return;
      case 'external_wait':
        this.resolution.waiting(this.store.task(taskId), (error as Error).message, 'external_unavailable');
        return;
      case 'transport':
        this.resolution.transportDeferred(this.store.task(taskId), error);
        return;
      case 'session':
        this.resolution.environmentDeferred(this.store.task(taskId), error);
        return;
      case 'attention':
        this.engine.note(taskId, String(error instanceof Error ? error.message : error), 'classify', this.store.getMeta("paused") ? undefined : "needs_attention");
    }
  }

  /** One bounded lifecycle quantum for a task on its exclusive lane key. */
  scheduleTaskQuantum(taskId: string): Promise<void> {
    return this.engine.scheduleLane(`task:${taskId}`, LANE_PRIORITY_TASK, async () => {
      const task = this.store.task(taskId);
      if (!task.hostId) return;
      return this.engine.withHost(task.hostId, async () => {
      if (this.engine.gitTransientWaiting(taskId)) return;
      const transientBefore = this.store.getMeta<GitTransientEpisode | null>(this.engine.transientKey(taskId));
      const before = this.store.task(taskId);
      if (!this.engine.taskHostAvailable(before)) return;
      const heldIntegration = this.resolution.holdsIntegrationTurn(before);
      const beforeRuns = this.store.runs(taskId);
      const threadWorkBefore = this.engine.terminalThreadsPending(before, beforeRuns);
      const occupied = occupiesSlot(before, beforeRuns);
      // The sweep observes retained runs separately; a callback or status hint must
      // be able to observe its own reported run without waiting for that pass.
      if (!settlementHeld(this.store, this.engine.stopped) && beforeRuns.some(run => !run.released && run.completion && run.role !== "recovery"))
        await this.resolution.observe(null, taskId);
      await this.resolution.integrationQuantum(taskId, () => this.engine.taskQuantum(taskId));
      if (settlementHeld(this.store, this.engine.stopped)) return;
      this.engine.completionFollowUps.finishQuantum(taskId, before, beforeRuns, transientBefore, heldIntegration, threadWorkBefore, occupied);
      });
    });
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
    const next = this.store.integrationTasks(repoPath)
      .filter(task => this.resolution.holdsIntegrationTurn(task))
      .sort((left, right) => (left.resolution.integrationTurn?.sequence ?? 0) - (right.resolution.integrationTurn?.sequence ?? 0))[0];
    if (next) this.engine.scheduleLifecycleFollowUp(next.id);
  }

  /** A freed global slot can belong to another project. Select one eligible
   * waiter using the existing fair admission rule; do not run a fleet sweep. */
  wakeCapacityWaiter(releasingTaskId: string): void {
    const held = this.store.getMeta<boolean>("dispatchHeld") ?? false;
    const candidates = fairSlotRequestOrder(this.store.admissionCandidates(), task => task.id !== releasingTaskId
      && !(held && boardDispatchHoldApplies(task))
      && (!/no eligible|configure.*profile|profile.*unavailable/i.test(task.reason) || this.store.routingRetryAllowed(task))
      && !occupiesSlot(task) && (task.phase === "queued" || task.reason.startsWith(CAPACITY_WAIT_PREFIX))
      && ["queued", "awaiting_review", "changes_requested", "verifying"].includes(task.phase));
    const next = candidates.find(task => !task.prerequisiteWait
      && (task.phase !== "queued" || !this.store.dependencyWait(task) && !this.resolution.projectInFlightAdmissionReason(task))
      && !this.resolution.slotAdmissionReason(task));
    if (!next) return;
    this.engine.cleanContext(() => {
      if (next.phase === "queued") void this.engine.scheduleLane(`task:${next.id}`, LANE_PRIORITY_TASK, () => this.engine.dispatchTask(next.id, this.store.getMeta<boolean>("dispatchHeld") ?? false)).catch(() => {});
      else void this.engine.cleanContext(() => this.engine.wakeTask(next.id));
    });
  }

  scheduleLifecycleFollowUp(taskId: string): boolean {
    if (this.lifecycleFollowUps.has(taskId)) return true;
    this.lifecycleFollowUps.add(taskId);
    setImmediate(() => {
      try {
        if (settlementHeld(this.store, this.engine.stopped)) return;
        let task: Task;
        try { task = this.store.task(taskId); } catch { return; }
        if (task.removedAt || dispatchBlocked(task)) return;
        // AsyncLocalStorage propagates through setImmediate. Exit the old lane
        // context so this queues behind it instead of taking the inline path.
        this.engine.cleanContext(() => { void this.engine.scheduleTaskQuantum(taskId).catch(() => {}); });
      } finally {
        // Keep the id in the set until the lane is queued (or this turn
        // no-ops) so quiesce cannot observe an empty engine in the gap
        // between "accepted follow-up" and "enqueued quantum".
        this.lifecycleFollowUps.delete(taskId);
        this.engine.scheduleDispatch();
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
    if (admission) {
      try {
        const task = this.store.task(taskId);
        for (const id of [task.agentId, task.coordinatorAgentId, task.resolution.reviewerAgentId,
          ...this.store.runs(taskId).filter(run => !run.released && run.completion).map(run => run.agentId)]) admission.invalidate(id ?? "");
      } catch { /* a purged or missing task has no cached observation to invalidate */ }
    }
    // A discarded quantum at shutdown has no caller with a durable decision to
    // make: the task lane records its own faults, so callers stay fire-and-forget.
    return this.engine.scheduleTaskQuantum(taskId).catch(() => {});
  }

  /**
   * Drive only one repository's queued lanes. A submission, promotion or
   * released capacity schedules the affected repository; it never authorizes a
   * fleet-wide pass.
   */
  wakeRepository(repoPath: string | null | undefined): Promise<void> {
    if (this.engine.stopped || !repoPath) return Promise.resolve();
    return this.engine.dispatchQueued(repoPath).catch(() => {});
  }

  /** Clears every pending timer. `Engine.stop` calls this before the projections stop. */
  stop(): void {
    for (const timer of this.gitTransientTimers.values()) clearTimeout(timer);
    this.gitTransientTimers.clear();
    this.engine.completionFollowUps.stop();
  }
}
