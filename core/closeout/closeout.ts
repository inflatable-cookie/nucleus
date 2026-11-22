import { admitPhaseFacts } from "../scheduling/phase-latency";
import { resultApplied, recordResultApplied } from "../intake/applied-result";
import {
  isDispositionActive,
  mergeFenced,
  type Completion,
  type Run,
  type Task,
} from "../../shared/contracts";
import { taskPrNumber } from "../forge/index";
import {
  describeIntegrationFastForward,
  git,
  recordIntegrationFastForward,
} from "../git/index";
import {
  hookHoldReason,
  isCloseoutAuthorityHook,
  type CloseoutAuthority,
} from "../hooks/hooks";
import { hostProcessSweepIntent } from "../machine/host-process-reap";
import {
  isBlockingRecoveryEffect,
  recoveryEffects,
  recoveryEffectsRefusal,
} from "../recovery/recovery-effects";
import type { Resolution } from "../resolution";
import { closeEscalationFollowups } from "../questions/ladder/continuation";
import { plannerEscalations } from "../questions/ladder/records";
import { CLOSEOUT_BASE_REFRESH_REASON } from "../recovery/task-reasons";
import { EXTERNAL_MERGE_CHECK_REASON_PREFIX } from "../recovery/task-reasons";
import { settlementHeld } from "./queue-drain";
import {
  CLOSEOUT_BASE_RENEWED_KIND,
  CLOSEOUT_BASE_RENEWAL_TRANSITION,
  closeoutBaseRenewalAllowed,
} from "./closeout-base-refresh";

export type CloseoutContext = Pick<
  Resolution,
  | "adapter"
  | "assignIntegrationTurn"
  | "attention"
  | "claimIntegrationTurn"
  | "closeoutAuthority"
  | "closeoutWritten"
  | "executionLease"
  | "hookCloseout"
  | "hooks"
  | "launch"
  | "paused"
  | "queueCloseout"
  | "recovery"
  | "recordIncidentEvent"
  | "refreshingCloseoutHook"
  | "settleAutomaticReplayHold"
  | "stopped"
  | "store"
  | "turnReleased"
  | "update"
  | "waiting"
>;

export const isMergeCloseoutPhase = (t: Task) =>
  t.phase === "merging" || t.phase === "syncing" || t.phase === "closing";

type OccurrenceOptions = {
  automatic: boolean;
  reobserved?: boolean;
  effectsHold?: () => boolean;
};

/**
 * The one occurrence decision for a verified merge: which recovery, stop, incident
 * and binding the merge overtakes, and what still holds the phase. Sweep, the owner
 * move and its preview all read it; it writes nothing. `hold` names the holder and
 * the missing fact for an owner caller. Automatic-only holds are never named.
 */
export function mergeOccurrence(
  store: CloseoutContext["store"],
  current: Task,
  options: OccurrenceOptions,
) {
  const r = current.resolution;
  const runs = store.runs(current.id);
  const bound = runs.find((run) => run.id === r.currentRunId);
  const parked = !isMergeCloseoutPhase(current);
  const hasEpisode = Boolean(
    r.recoveryActive || (r.recovery && r.recovery.status !== "resolved"),
  );
  const recoveredProbe = Boolean(
    options.automatic &&
      options.reobserved &&
      r.externalMergePreAttention &&
      !hasEpisode &&
      current.reasonFact?.code === "external_merge_check" &&
      (!r.stop ||
        r.stop.fact?.code === "external_merge_check") &&
      (!r.incident ||
        r.incident.status === "resolved" ||
        r.incident.detail.startsWith(EXTERNAL_MERGE_CHECK_REASON_PREFIX)),
  );
  const otherStop = Boolean(r.stop && !recoveredProbe);
  const otherIncident = Boolean(
    r.incident &&
      r.incident.status !== "resolved" &&
      !recoveredProbe,
  );
  const otherBinding = Boolean(r.currentRunId && bound?.role !== "closeout");
  const liveRun = runs.find((run) => !run.released);
  const automaticHold = Boolean(
    options.automatic &&
      ((parked && !options.reobserved) ||
        (bound?.role === "closeout" && bound.completion) ||
        options.effectsHold?.()),
  );
  const held =
    mergeFenced(current) ||
    hasEpisode ||
    otherStop ||
    otherIncident ||
    otherBinding ||
    Boolean(liveRun) ||
    automaticHold;
  const episode = r.recovery
    ? `recovery episode ${r.recovery.id}${r.recovery.runId ? ` on run ${r.recovery.runId}` : " that started no run"}`
    : "the active recovery";
  let hold: string | null = null;
  if (hasEpisode)
    hold = `${episode} is still active; use closeout.now to start closeout`;
  else if (mergeFenced(current)) hold = "a merge hold is active";
  else if (otherStop && r.stop)
    hold = `the ${r.stop.reason} stop still owns the task: ${r.stop.detail}`;
  else if (otherIncident && r.incident)
    hold = `incident ${r.incident.id} is unresolved`;
  else if (otherBinding)
    hold = `run ${r.currentRunId} is still bound to the task`;
  else if (liveRun)
    hold = `run ${liveRun.id} (${liveRun.role}) is not released`;
  else if (automaticHold)
    hold = "synchronization waits for the next automatic pass";
  return {
    runs,
    bound,
    parked,
    hasEpisode,
    recoveredProbe,
    otherStop,
    otherIncident,
    held,
    hold,
  };
}

/** Settle ladder occurrences the merge overtook without applying a planner answer. */
export function settleMergeEscalations(
  t: Task,
  store: CloseoutContext["store"],
  detail: string,
): boolean {
  if (t.resolution.recovery || t.resolution.stop?.reason !== "escalated")
    return false;
  const events = store.eventsAll(t.id);
  for (const escalation of plannerEscalations(events)) {
    if (
      escalation.answered ||
      escalation.refusal !== "pre_merge" ||
      escalation.runId !== t.runId ||
      t.resolution.stop.fact?.subject !== escalation.id
    )
      continue;
    store.event(
      t.id,
      "planner_escalation_resolved",
      `${escalation.id}: ${detail}`,
    );
    if (
      events.some(
        (event) =>
          event.kind === "planner_escalation_wait" &&
          event.detail.startsWith(`${escalation.id}:`),
      ) &&
      !events.some(
        (event) =>
          event.kind === "planner_escalation_wait_superseded" &&
          event.detail.startsWith(`${escalation.id}:`),
      )
    )
      store.event(
        t.id,
        "planner_escalation_wait_superseded",
        `${escalation.id}: ${detail}`,
      );
    closeEscalationFollowups(store, t.id, escalation.id);
    return true;
  }
  return false;
}

type RecordedMergeContinuation =
  | { kind: "sweep"; reobserved?: boolean }
  | { kind: "owner"; reason: string; refresh?: boolean }
  | { kind: "retry"; refresh: boolean };

/** Select the closeout authority and finish closeout: queue, repository hook or agent. */
export class Closeout {
  constructor(readonly resolution: CloseoutContext) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  get hooks() {
    return this.resolution.hooks;
  }
  /** A verified merge owes sync or closeout. Callers prove any fresh observations before entering this transaction. */
  continueRecordedMerge(
    t: Task,
    continuation: RecordedMergeContinuation,
  ): Task {
    const apply = () => {
      const current = this.store.task(t.id);
      const r = current.resolution;
      if (
        current.version !== t.version ||
        !r.mergedCommit ||
        current.removedAt ||
        isDispositionActive(current) ||
        ["queued", "done", "cancelled"].includes(current.phase)
      )
        return current;
      const automatic = continuation.kind === "sweep";
      const occurrence = mergeOccurrence(this.store, current, {
        automatic,
        reobserved: continuation.kind === "sweep" && continuation.reobserved,
        effectsHold: () => this.closeoutEffects(current).length > 0,
      });
      const {
        parked,
        recoveredProbe,
        held,
      } = occurrence;
      // An owner move names the holder it cannot pass, never a silent no-op.
      if (occurrence.hold && continuation.kind === "owner")
        throw new Error(`Recorded merge waits: ${occurrence.hold}`);
      if (held) return current;
      const reenter =
        parked ||
        current.phase === "merging" ||
        Boolean(r.externalMergePreAttention);
      if (automatic && !reenter) return current;
      const ownerRefresh =
        continuation.kind !== "sweep" && continuation.refresh;
      const phase =
        ownerRefresh || !r.syncedCommit || current.phase === "syncing"
          ? "syncing"
          : "closing";
      const reason = ownerRefresh
        ? CLOSEOUT_BASE_REFRESH_REASON
        : phase === "syncing"
          ? "Verified merge; synchronizing the integration checkout"
          : "Integration checkout synchronized; closeout pending";
      const latest = this.resolution.assignIntegrationTurn(current);
      const recoveredIncident =
        recoveredProbe && r.incident && r.incident.status !== "resolved"
          ? {
              ...r.incident,
              status: "resolved" as const,
              updatedAt: new Date().toISOString(),
            }
          : null;
      const updated = this.resolution.update(
        latest,
        {
          ...(recoveredProbe ? { attention: false, stop: null } : {}),
          ...(recoveredIncident ? { incident: recoveredIncident } : {}),
          externalMergePreAttention: null,
        },
        {
          phase,
          reason,
          ...(automatic && current.phase === "merging" && phase === "syncing"
            ? { coordinatorGeneration: current.coordinatorGeneration + 1 }
            : {}),
        },
        continuation.kind === "owner"
          ? "owner_closeout_merge_observed"
          : automatic
            ? "recorded_merge_phase_reconciled"
            : "closeout_sync_requested",
        JSON.stringify({
          head: r.mergeHead,
          commit: r.mergedCommit,
          ...(continuation.kind === "owner"
            ? { reason: continuation.reason }
            : {}),
        }),
      );
      if (recoveredIncident)
        this.resolution.recordIncidentEvent(t.id, recoveredIncident);
      return updated;
    };
    return this.store.db.isTransaction
      ? apply()
      : this.store.transaction(apply);
  }
  private closeoutEffects(t: Task, syncing = false) {
    const refreshing = this.resolution.refreshingCloseoutHook(t, syncing);
    return recoveryEffects(this.store, t, {
      kinds: [
        "operation",
        "hook",
        "run-delivery",
        "review-delivery",
        "publication",
        "attention-notice",
      ],
    }).filter(
      (effect) =>
        isBlockingRecoveryEffect(effect) &&
        !(effect.kind === "hook" && effect.identity === refreshing?.id),
    );
  }
  private reviewDisclosures(t: Task): string {
    return [
      ...t.resolution.criticalReviewFallbacks.map(
        (record) =>
          `Critical review fallback: ${record.reason} (reviewer ${record.reviewerProfileId}).`,
      ),
      ...t.resolution.forcedChecks.map(
        (record) =>
          `Reviewer forced checks at ${record.head}: ${record.checks.map((check) => `${check.name} ${check.jobUrl}`).join(", ")}. ${record.reason}`,
      ),
    ].join("\n");
  }
  /** Hand the turn on at the closeout write instead of at quantum end (Queue #705). */
  closeoutWritten(t: Task) {
    const disclosure = this.reviewDisclosures(t);
    if (disclosure && !t.reason.includes(disclosure))
      this.store.update(
        t.id,
        { reason: `${t.reason}\n${disclosure}` },
        "review_disclosures",
        disclosure,
      );
    if (
      t.phase !== "done" ||
      !t.resolution.mergedCommit ||
      !t.resolution.syncedCommit
    )
      return;
    this.resolution.turnReleased?.(t.repoPath);
  }
  /** Select one closeout authority from the manifest pinned at this task's synchronized integration commit. */
  async closeoutAuthority(t: Task): Promise<CloseoutAuthority> {
    const hooks = this.store.hookEvents(t.id);
    if (
      hooks.some(
        (record) =>
          record.event === "task.closeout" &&
          record.delivery === "required" &&
          record.mode === "integration_write",
      )
    )
      return "hook";
    if (this.store.runs(t.id).some((run) => run.role === "closeout"))
      return "agent";
    const baseCommit = t.resolution.syncedCommit ?? t.resolution.mergedCommit;
    if (!this.hooks || !baseCommit) return "agent";
    return this.hooks.closeoutAuthorityAt(t, baseCommit);
  }
  /** Complete closeout in Queue: no run, workspace, hook occurrence, commit or push. */
  async queueCloseout(t: Task): Promise<void> {
    if (!this.resolution.claimIntegrationTurn(t)) return;
    t = this.store.task(t.id);
    if (settlementHeld(this.store, this.resolution.stopped())) return;
    const baseCommit = t.resolution.syncedCommit;
    if (!baseCommit) {
      this.resolution.attention(
        t,
        "Nucleus-owned closeout requires a synchronized integration commit",
      );
      return;
    }
    this.resolution.update(
      t,
      { currentRunId: null, hostProcessSweep: hostProcessSweepIntent("done") },
      {
        phase: "done",
        reason: "Nucleus-owned closeout at the synchronized integration commit",
      },
      "closed_out",
    );
    this.resolution.closeoutWritten(this.store.task(t.id));
  }
  /** Complete closeout through the repository's authoritative integration-write hook. No closeout run or workspace is created. */
  async hookCloseout(t: Task): Promise<void> {
    if (!this.resolution.claimIntegrationTurn(t)) return;
    t = this.store.task(t.id);
    if (settlementHeld(this.store, this.resolution.stopped())) return;
    const held = this.hooks!.heldAutomaticReplay(t);
    const baseCommit =
      held?.record.event === "task.closeout"
        ? await git(t.repoPath, "rev-parse", "HEAD")
        : t.resolution.syncedCommit;
    if (!baseCommit) {
      this.resolution.attention(
        t,
        "Hook-owned closeout requires a synchronized integration commit",
      );
      return;
    }
    const review = t.resolution.review?.summary ?? null;
    const summary = [
      review ?? "Hook-owned closeout at the synchronized integration commit",
      this.reviewDisclosures(t),
    ]
      .filter(Boolean)
      .join("\n");
    const hookState = await this.hooks!.emit(
      "task.closeout",
      this.store.task(t.id),
      {
        event: "task.closeout",
        baseCommit,
        summary,
        delivery: {
          prUrl: t.prUrl,
          prNumber: taskPrNumber(t),
          head: t.prHead,
          review,
          mergeCommit: t.resolution.mergedCommit,
          integrationCommit: baseCommit,
          summary,
        },
      },
    );
    if (hookState.hold) {
      const holdReason = hookHoldReason(hookState);
      // A moved integration base is operational staleness, not a finding: refresh the
      // base and retry, which is exactly what an operator retry does. The shared rule
      // owns the eligible refusal class and the per-merge bound, and the transition it
      // writes is the one named refresh reason.
      if (
        closeoutBaseRenewalAllowed(
          this.store.events(t.id),
          hookState.records.at(-1),
        )
      ) {
        this.resolution.update(
          this.store.task(t.id),
          { currentRunId: null, attention: false },
          CLOSEOUT_BASE_RENEWAL_TRANSITION,
          CLOSEOUT_BASE_RENEWED_KIND,
        );
        return;
      }
      this.resolution.attention(this.store.task(t.id), holdReason);
      return;
    }
    const published = hookState.records.findLast(
      (record) =>
        record.state === "published" &&
        record.mode === "integration_write" &&
        record.delivery === "required",
    );
    if (!published) {
      this.resolution.attention(
        this.store.task(t.id),
        "Hook-owned closeout did not publish a required integration write",
      );
      return;
    }
    const settled = this.resolution.settleAutomaticReplayHold(
      this.store.task(t.id),
      hookState.records,
      "task.closeout",
    );
    this.resolution.update(
      settled,
      {
        currentRunId: null,
        syncedCommit: published.commit ?? baseCommit,
        hostProcessSweep: hostProcessSweepIntent("done"),
      },
      {
        phase: "done",
        reason: "Hook-owned closeout published and synchronized",
      },
      "closed_out",
    );
    this.resolution.closeoutWritten(this.store.task(t.id));
  }
  async advanceCloseoutResult(t: Task, run: Run, c: Completion): Promise<void> {
    if (resultApplied(this.store, t.id, run.id)) return;
    let closeoutCommit: string | void;
    try {
      closeoutCommit = await this.adapter.verifyCloseout!(t, c);
    } catch (error) {
      if (resultApplied(this.store, t.id, run.id)) return;
      throw error;
    }
    if (
      settlementHeld(this.store, this.resolution.stopped()) ||
      run.generation !== this.store.task(t.id).coordinatorGeneration
    )
      return;
    const hookState = this.hooks
      ? await this.hooks.emit(
          "task.closeout",
          t,
          {
            event: "task.closeout",
            summary: c.summary,
            delivery: {
              prUrl: t.prUrl,
              prNumber: c.prNumber ?? null,
              head: t.prHead,
              review: t.resolution.review?.summary ?? null,
              mergeCommit: t.resolution.mergedCommit,
              integrationCommit: closeoutCommit ?? t.resolution.syncedCommit,
              summary: c.summary,
            },
          },
          (hook) => !isCloseoutAuthorityHook(hook),
        )
      : null;
    if (hookState?.hold) {
      this.resolution.attention(
        this.store.task(t.id),
        hookHoldReason(hookState),
      );
      return;
    }
    if (
      settlementHeld(this.store, this.resolution.stopped()) ||
      run.generation !== this.store.task(t.id).coordinatorGeneration
    )
      return;
    const applied = this.store.transaction(() => {
      const current = this.store.task(t.id);
      if (
        resultApplied(this.store, t.id, run.id) ||
        current.resolution.currentRunId !== run.id ||
        run.generation !== current.coordinatorGeneration
      )
        return false;
      this.resolution.update(
        current,
        {
          currentRunId: null,
          hostProcessSweep: hostProcessSweepIntent("done"),
          ...(closeoutCommit ? { syncedCommit: closeoutCommit } : {}),
        },
        { phase: "done", reason: c.summary },
        "closed_out",
      );
      recordResultApplied(this.store, t.id, run.id);
      return true;
    });
    if (applied) this.resolution.closeoutWritten(this.store.task(t.id));
  }
  async advanceClosing(t: Task): Promise<void> {
    if (
      t.resolution.recoveryActive ||
      (t.resolution.recovery && t.resolution.recovery.status !== "resolved")
    )
      return;
    if (
      t.resolution.mergedCommit &&
      this.store.runs(t.id).some((run) => !run.released)
    )
      return;
    // A blocked closeout hook is handled by the closeout authority; uncertain
    // effects and all other task effects must settle independently.
    const closeoutHooks = new Set(
      this.store
        .hookEvents(t.id)
        .filter(
          (record) =>
            record.event === "task.closeout" && record.state === "blocked",
        )
        .map((record) => record.id),
    );
    const blocking = this.closeoutEffects(t).filter(
      (effect) =>
        !(effect.kind === "hook" && closeoutHooks.has(effect.identity)),
    );
    if (blocking.length) {
      this.resolution.waiting(
        t,
        `Closeout waits for ${recoveryEffectsRefusal(blocking)}`,
        "lifecycle",
      );
      return;
    }
    const authority = await this.resolution.closeoutAuthority(t);
    if (authority === "hook") {
      admitPhaseFacts(this.store, t.id);
      await this.resolution.hookCloseout(this.store.task(t.id));
    } else if (authority === "queue") {
      admitPhaseFacts(this.store, t.id);
      await this.resolution.queueCloseout(this.store.task(t.id));
    } else await this.resolution.launch(t, "closeout");
  }
  async advanceSyncing(t: Task): Promise<void> {
    if (
      t.resolution.recoveryActive ||
      (t.resolution.recovery && t.resolution.recovery.status !== "resolved")
    )
      return;
    if (
      !t.resolution.mergedCommit ||
      this.store.runs(t.id).some((run) => !run.released)
    )
      return;
    if (!this.resolution.claimIntegrationTurn(t)) return;
    t = this.store.task(t.id);
    if (
      !(await this.resolution.executionLease(t, undefined, true)) ||
      this.resolution.paused()
    )
      return;
    admitPhaseFacts(this.store, t.id);
    const syncStarted = Date.now();
    const runs = JSON.stringify(this.store.runs(t.id));
    const current = () =>
      !this.resolution.stopped() &&
      this.store.task(t.id).version === t.version &&
      JSON.stringify(this.store.runs(t.id)) === runs;
    const canSettle = () =>
      current() && !this.closeoutEffects(this.store.task(t.id), true).length;
    if (!canSettle() || this.store.runs(t.id).some((run) => !run.released))
      return;
    let commit: string;
    try {
      commit = await this.adapter.syncMain!(
        t,
        () => !this.resolution.paused() && canSettle(),
        (move) => recordIntegrationFastForward(this.store, t, move),
        (move) => {
          const detail = `${t.resolution.mergedCommit}: ${describeIntegrationFastForward(t.baseBranch, move)}`;
          const latest = this.store
            .events(t.id)
            .find(
              (event) =>
                event.kind === "main_sync_intent" ||
                event.kind === "main_synchronized",
            );
          if (latest?.kind !== "main_sync_intent" || latest.detail !== detail)
            this.store.event(t.id, "main_sync_intent", detail);
        },
      );
    } catch (error) {
      if (!canSettle()) return;
      const detail = String(error).slice(0, 2000);
      if (
        this.store
          .events(t.id)
          .find((event) => event.kind === "main_sync_failed")?.detail !== detail
      )
        this.store.event(t.id, "main_sync_failed", detail);
      throw error;
    }
    this.store.transaction(() => {
      if (!canSettle()) return;
      this.store.event(
        t.id,
        "integration_sync_duration",
        `${Date.now() - syncStarted}ms`,
      );
      this.resolution.update(
        t,
        { syncedCommit: commit },
        {
          phase: "closing",
          reason:
            "Integration branch synchronized; coordinator closeout pending",
        },
        "main_synchronized",
      );
    });
  }
}
