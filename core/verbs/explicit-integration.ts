import { sameCallerIdentity } from "../../shared/agent-identity";
import {
  holdsOf,
  operatorSourceAcceptance,
  qualifiedOwnerAcceptance,
  type Task,
} from "../../shared/contracts";
import type {
  ExplicitResolution,
  ResolutionWarningId,
} from "../../shared/schema/task-control";
import { TASK_PROGRESSING_REASON } from "../../shared/task-stop";
import type { Engine } from "../engine";
import { taskPrNumber } from "../forge/index";
import { nextMergeRequestAt, sendGuardedMerge } from "../merge/merge-phase";
import { now } from "../store/store";
import {
  releasePlan,
  type ExplicitPlan,
  type ExplicitWarning,
} from "./explicit-resolution";

export type ExplicitIntegrationAction = Extract<
  ExplicitResolution,
  { action: "turn.take" | "turn.release" | "merge.now" | "closeout.now" }
>;

export type ExplicitIntegrationPreflight = {
  observedMerge?: {
    merged: boolean;
    commit: string | null;
    head: string | null;
    base: string | null;
  } | null;
  mergeReadError?: string;
  prIdentityError?: string;
  checksWarning?: string | null;
};

/**
 * Spec 067 hard gate for `merge.now` and `closeout.now`: requires an applied
 * qualifying review verdict (`ready_to_merge` or `owner_reviewed`) or an
 * explicit recorded `operator_source` acceptance at the exact head. Never
 * waived by `skipPRReview` and never satisfied by `source_approved` with
 * pending proofs.
 */
function hasExplicitMergeEvidence(task: Task, head: string): boolean {
  const review = task.resolution.review;
  if (review?.status === "ready_to_merge" && review.head === head) return true;
  const atHead = { ...task, prHead: head };
  if (qualifiedOwnerAcceptance(atHead)) return true;
  if (operatorSourceAcceptance(atHead)) return true;
  return false;
}

function currentTurnHolders(engine: Engine, task: Task): Task[] {
  return engine.store
    .integrationTasks(task.repoPath)
    .filter(
      (other) =>
        other.id !== task.id && engine.resolution.holdsIntegrationTurn(other),
    );
}

/**
 * Refresh every task in `repoPath` that is waiting on the repository
 * integration turn so it re-reads the current holder after a release or take.
 */
export function refreshIntegrationWaiters(
  engine: Engine,
  repoPath: string,
  excludeTaskId?: string,
): void {
  const store = engine.store;
  const holder =
    store
      .integrationTasks(repoPath)
      .find((candidate) => engine.resolution.holdsIntegrationTurn(candidate)) ??
    null;
  for (const candidate of store.tasks()) {
    if (
      candidate.repoPath !== repoPath ||
      candidate.id === excludeTaskId ||
      candidate.removedAt != null ||
      ["done", "cancelled"].includes(candidate.phase)
    )
      continue;
    const isTurnWait =
      candidate.resolution.stop?.fact?.code === "integration_turn" ||
      candidate.reasonFact?.code === "integration_turn";
    if (!isTurnWait) continue;
    if (!holder || holder.id === candidate.id) {
      store.update(candidate.id, {
        resolution: {
          ...candidate.resolution,
          ...(candidate.resolution.stop?.fact?.code === "integration_turn"
            ? { stop: null }
            : {}),
        },
        reason: TASK_PROGRESSING_REASON,
        reasonFact: null,
      });
    } else if (candidate.resolution.stop?.fact?.subject !== holder.id) {
      const holderDetail =
        holder.resolution.stop?.fact?.code === "integration_turn" ||
        holder.reasonFact?.code === "integration_turn"
          ? "integration work pending"
          : holder.reason;
      engine.resolution.waiting(
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
}

export async function preflightExplicitIntegration(
  engine: Engine,
  task: Task,
  input: ExplicitIntegrationAction,
): Promise<ExplicitIntegrationPreflight | undefined> {
  if (input.action === "turn.take" || input.action === "turn.release")
    return undefined;

  if (input.action === "merge.now") {
    const r = task.resolution;
    const result: ExplicitIntegrationPreflight = {};
    const prNumber = taskPrNumber(task);
    if (!r.mergedCommit && prNumber) {
      if (!engine.resolution.adapter.merged) {
        result.mergeReadError = "GitHub merge observation is unavailable";
      } else {
        try {
          const observed = await engine.resolution.adapter.merged(task);
          result.observedMerge = {
            merged: observed.merged,
            commit: observed.commit,
            head: observed.head ?? null,
            base: observed.base ?? null,
          };
          if (observed.base && observed.base !== task.baseBranch) {
            result.prIdentityError = `PR targets ${observed.base}, not task base ${task.baseBranch}`;
          }
        } catch (error) {
          result.mergeReadError = String(error);
        }
      }
      if (!result.prIdentityError && engine.adapter.verifyPrIdentity) {
        try {
          await engine.adapter.verifyPrIdentity(task, prNumber);
        } catch (error) {
          result.prIdentityError = `PR identity verification failed: ${String(error)}`;
        }
      }
    }
    if (engine.resolution.requiredCheckPollState(task)) {
      result.checksWarning = "PR checks are still pending or failed.";
    } else if (
      !r.mergedCommit &&
      prNumber &&
      engine.resolution.adapter.requiredChecks
    ) {
      try {
        const checks = await engine.resolution.adapter.requiredChecks(task);
        if (checks.wait || checks.checksFailed || checks.pendingCheck) {
          result.checksWarning =
            checks.wait || "PR checks are pending or failed.";
        }
      } catch (error) {
        result.checksWarning = `PR checks could not be read: ${String(error).slice(0, 500)}`;
      }
    }
    return result;
  }

  // closeout.now
  if (task.resolution.mergedCommit) {
    return {
      observedMerge: {
        merged: true,
        commit: task.resolution.mergedCommit,
        head: task.resolution.mergeHead ?? task.prHead ?? null,
        base: task.baseBranch,
      },
    };
  }
  if (engine.resolution.adapter.merged) {
    try {
      const observed = await engine.resolution.adapter.merged(task);
      return {
        observedMerge: {
          merged: observed.merged,
          commit: observed.commit,
          head: observed.head ?? null,
          base: observed.base ?? null,
        },
      };
    } catch (error) {
      return { observedMerge: null, mergeReadError: String(error) };
    }
  }
  if (engine.resolution.adapter.externalMerge) {
    try {
      const observed = await engine.resolution.adapter.externalMerge(task);
      return {
        observedMerge: observed
          ? {
              merged: true,
              commit: observed.commit,
              head: observed.head,
              base: task.baseBranch,
            }
          : { merged: false, commit: null, head: null, base: null },
      };
    } catch (error) {
      return { observedMerge: null, mergeReadError: String(error) };
    }
  }
  return {
    observedMerge: null,
    mergeReadError: "GitHub merge observation is unavailable",
  };
}

export function turnReleasePlan(
  engine: Engine,
  task: Task,
  _input: Extract<ExplicitResolution, { action: "turn.release" }>,
): ExplicitPlan {
  const store = engine.store;
  const reservationKey = `closeoutTurn:${task.repoPath}`;
  const reservation = store.getMeta<{ taskId: string }>(reservationKey);
  if (!task.resolution.integrationTurn && reservation?.taskId !== task.id) {
    throw Error("This task does not hold a repository integration turn");
  }
  const warnings: ExplicitWarning[] = [];
  if (task.resolution.mergeIntent && !task.resolution.mergedCommit) {
    warnings.push({
      id: "merge_in_flight",
      text: "A merge request is in flight for this task; releasing the turn allows another task to integrate concurrently.",
    });
  }
  return {
    warnings,
    apply() {
      if (reservation?.taskId === task.id) store.deleteMeta(reservationKey);
      return {
        before: { integrationTurn: task.resolution.integrationTurn },
        patch: {
          resolution: {
            ...task.resolution,
            integrationTurn: null,
          },
        },
      };
    },
    async finish() {
      refreshIntegrationWaiters(engine, task.repoPath, task.id);
      engine.wakeIntegrationSuccessor(task.repoPath);
      return { issues: [] };
    },
  };
}

export function turnTakePlan(
  engine: Engine,
  task: Task,
  input: Extract<ExplicitResolution, { action: "turn.take" }>,
): ExplicitPlan {
  const store = engine.store;
  const reservationKey = `closeoutTurn:${task.repoPath}`;
  const reservation = store.getMeta<{ taskId: string }>(reservationKey);
  const currentHolders = currentTurnHolders(engine, task);
  const otherReservation =
    reservation && reservation.taskId !== task.id
      ? store.taskOrNull(reservation.taskId)
      : null;
  const displaced = [
    ...currentHolders,
    ...(otherReservation &&
    !currentHolders.some((h) => h.id === otherReservation.id)
      ? [otherReservation]
      : []),
  ];
  const warnings: ExplicitWarning[] = [];
  if (displaced.length > 0) {
    const names = displaced.map((h) => `${h.title} (${h.id})`);
    warnings.push({
      id: "turn_held",
      text: `Repository integration turn is currently held by ${names.join(", ")}; taking it displaces them.`,
    });
  }
  if (
    displaced.some(
      (h) => h.resolution.mergeIntent && !h.resolution.mergedCommit,
    )
  ) {
    warnings.push({
      id: "merge_in_flight",
      text: "A displaced task has a merge request in flight.",
    });
  }
  return {
    warnings,
    apply() {
      if (reservation && reservation.taskId !== task.id)
        store.deleteMeta(reservationKey);
      const displacedIds = new Set(displaced.map((h) => h.id));
      for (const other of displaced) {
        store.update(
          other.id,
          { resolution: { ...other.resolution, integrationTurn: null } },
          "integration_turn_released",
          `displaced by turn.take on ${task.id}: ${input.reason}`,
        );
      }
      // Preserve FIFO sequence of unrelated waiting tasks while placing `task`
      // strictly ahead of them at sequence 1.
      const remaining = store
        .integrationTasks(task.repoPath)
        .filter((other) => other.id !== task.id && !displacedIds.has(other.id))
        .sort(
          (a, b) =>
            (a.resolution.integrationTurn?.sequence ?? 0) -
            (b.resolution.integrationTurn?.sequence ?? 0),
        );
      const needsShift = remaining.some(
        (other) => (other.resolution.integrationTurn?.sequence ?? 0) <= 1,
      );
      if (needsShift) {
        let maxSeq = 1;
        for (const other of [...remaining].reverse()) {
          const nextSeq = (other.resolution.integrationTurn?.sequence ?? 1) + 1;
          if (nextSeq > maxSeq) maxSeq = nextSeq;
          store.update(other.id, {
            resolution: {
              ...other.resolution,
              integrationTurn: {
                ...other.resolution.integrationTurn!,
                sequence: nextSeq,
              },
            },
          });
        }
        const metaKey = `integrationTurnSeq:${task.repoPath}`;
        const currentMeta = store.getMeta<number>(metaKey) ?? 0;
        if (maxSeq > currentMeta) store.setMeta(metaKey, maxSeq);
      }
      const integrationTurn = {
        sequence: 1,
        acceptedAt: task.resolution.integrationTurn?.acceptedAt ?? now(),
      };
      const metaKey = `integrationTurnSeq:${task.repoPath}`;
      if ((store.getMeta<number>(metaKey) ?? 0) < 1) store.setMeta(metaKey, 1);
      const clearTurnWait =
        task.resolution.stop?.fact?.code === "integration_turn" ||
        task.reasonFact?.code === "integration_turn";
      return {
        before: {
          integrationTurn: task.resolution.integrationTurn,
          displaced: displaced.map((h) => h.id),
        },
        patch: {
          resolution: {
            ...task.resolution,
            integrationTurn,
            ...(clearTurnWait &&
            task.resolution.stop?.fact?.code === "integration_turn"
              ? { stop: null }
              : {}),
          },
          ...(clearTurnWait
            ? { reason: TASK_PROGRESSING_REASON, reasonFact: null }
            : {}),
        },
      };
    },
    async finish() {
      refreshIntegrationWaiters(engine, task.repoPath, task.id);
      engine.scheduleLifecycleFollowUp(task.id);
      return { issues: [] };
    },
  };
}

export function mergeNowPlan(
  engine: Engine,
  task: Task,
  input: Extract<ExplicitResolution, { action: "merge.now" }>,
  preflight?: ExplicitIntegrationPreflight,
): ExplicitPlan {
  const store = engine.store;
  const r = task.resolution;
  if (r.mergedCommit) {
    throw Error("Task already has a recorded merge commit; use closeout.now");
  }
  if (!taskPrNumber(task)) {
    throw Error("merge.now requires a pull request number on the task");
  }
  // Hard gate 1: applied qualifying review verdict at exact head or explicit operator source acceptance.
  if (!hasExplicitMergeEvidence(task, input.head)) {
    throw Error(
      `merge.now refused: head ${input.head} has no applied review verdict or explicit operator source acceptance`,
    );
  }
  // PR identity and target branch validation.
  if (preflight?.prIdentityError) {
    throw Error(`merge.now refused: ${preflight.prIdentityError}`);
  }
  if (
    preflight?.observedMerge?.base &&
    preflight.observedMerge.base !== task.baseBranch
  ) {
    throw Error(
      `merge.now refused: PR targets ${preflight.observedMerge.base}, not task base ${task.baseBranch}`,
    );
  }
  // Hard gate 2: no re-request while an earlier merge outcome is unknown unless GitHub shows it unmerged in the same call.
  const unknownMergeOutcome =
    r.mergeIntent ||
    r.mergeResponseOutcome === "uncertain" ||
    r.mergeRetryOutcome === "uncertain";
  if (unknownMergeOutcome) {
    if (preflight?.mergeReadError || !preflight?.observedMerge) {
      throw Error(
        `merge.now refused: an earlier merge request's outcome is unknown and GitHub could not confirm the PR is unmerged${preflight?.mergeReadError ? ` (${preflight.mergeReadError})` : ""}`,
      );
    }
    if (preflight.observedMerge.merged) {
      throw Error(
        `merge.now refused: GitHub reports the PR is already merged (${preflight.observedMerge.commit ?? "commit unknown"}); use closeout.now`,
      );
    }
  } else if (preflight?.observedMerge?.merged) {
    throw Error(
      `merge.now refused: GitHub reports the PR is already merged (${preflight.observedMerge.commit ?? "commit unknown"}); use closeout.now`,
    );
  } else if (preflight?.mergeReadError) {
    throw Error(
      `merge.now refused: could not verify PR target branch on GitHub (${preflight.mergeReadError})`,
    );
  }
  if (!engine.resolution.adapter.merge) {
    throw Error("GitHub guarded merge is unavailable");
  }

  const otherHolders = currentTurnHolders(engine, task);
  const warnings: ExplicitWarning[] = [];
  if (otherHolders.length > 0) {
    warnings.push({
      id: "turn_held",
      text: `Repository integration turn is held by ${otherHolders.map((h) => `${h.title} (${h.id})`).join(", ")}.`,
    });
  }
  if (preflight?.checksWarning) {
    warnings.push({
      id: "checks",
      text: preflight.checksWarning,
    });
  }
  const fences = holdsOf(task);
  const activeHolds = [
    ...(fences.merge ? ["merge"] : []),
    ...(fences.dispatch ? ["dispatch"] : []),
  ];
  if (activeHolds.length > 0) {
    warnings.push({
      id: "holds",
      text: `Task has active hold(s): ${activeHolds.join(", ")}.`,
    });
    const foreignOwners = [fences.merge, fences.dispatch]
      .filter((hold): hold is NonNullable<typeof hold> =>
        Boolean(hold?.owner && hold.owner !== input.caller),
      )
      .map((hold) => hold.owner);
    if (foreignOwners.length > 0) {
      warnings.push({
        id: "hold_owner",
        text: `Active hold belongs to ${[...new Set(foreignOwners)].join(", ")}.`,
      });
    }
  }

  const requestedAt = nextMergeRequestAt(r.mergeRequestedAt);

  return {
    warnings,
    apply() {
      const takeTurn = otherHolders.length === 0 && !r.integrationTurn;
      const integrationTurn = takeTurn
        ? {
            sequence: store.nextIntegrationSequence(task.repoPath),
            acceptedAt: now(),
          }
        : r.integrationTurn;
      return {
        before: {
          phase: task.phase,
          mergeIntent: r.mergeIntent,
          mergeHead: r.mergeHead,
          mergeResponseOutcome: r.mergeResponseOutcome,
          integrationTurn: r.integrationTurn,
        },
        patch: {
          phase: "merging",
          reason: `Explicit merge requested for ${input.head.slice(0, 12)}`,
          reasonFact: null,
          resolution: {
            ...r,
            integrationTurn,
            attention: false,
            stop: null,
            mergeIntent: true,
            mergeHead: input.head,
            mergeRequestedAt: requestedAt,
            mergeResponseOutcome: "pending",
            mergeProofSince: null,
            mergeRetryAt: null,
            mergeRetryOutcome: null,
            mergeAutoRetryExhausted: false,
          },
        },
      };
    },
    async finish() {
      const issues: string[] = [];
      const matchesRequest = (candidate: Task) =>
        candidate.resolution.mergeIntent &&
        candidate.resolution.mergeHead === input.head &&
        candidate.resolution.mergeRequestedAt === requestedAt &&
        candidate.resolution.mergeResponseOutcome === "pending" &&
        !candidate.resolution.mergedCommit;
      await sendGuardedMerge({
        store,
        taskId: task.id,
        head: input.head,
        send: (reservedTask, allowed) =>
          engine.resolution.adapter.merge!(reservedTask, allowed),
        reserve: () => {
          const current = store.task(task.id);
          return matchesRequest(current)
            ? { task: current, matchesCurrent: matchesRequest }
            : null;
        },
        onAccepted: (after) => {
          engine.resolution.update(
            after,
            { mergeResponseOutcome: "accepted" },
            {},
            "merge_response_accepted",
            `GitHub accepted the guarded merge for ${input.head}`,
          );
          engine.scheduleLifecycleFollowUp(task.id);
        },
        onLateAccepted: () => {
          store.event(
            task.id,
            "merge_response_late_accepted",
            `Late accepted reply for ${input.head} (${requestedAt}); preserved current merge outcome`,
          );
        },
        onError: (after, error, isCurrent) => {
          const detail = String(error).slice(0, 2000);
          if (isCurrent) {
            engine.resolution.update(
              after,
              { mergeResponseOutcome: "uncertain" },
              {},
              "merge_response_uncertain",
              detail,
            );
          } else {
            store.event(
              task.id,
              "merge_response_late_uncertain",
              `Late uncertain reply for ${input.head} (${requestedAt}): ${detail}`,
            );
          }
          issues.push(
            `GitHub merge request did not confirm: ${String(error).slice(0, 500)}.`,
          );
        },
      });
      return { issues };
    },
  };
}

export function closeoutNowPlan(
  engine: Engine,
  task: Task,
  input: Extract<ExplicitResolution, { action: "closeout.now" }>,
  preflight?: ExplicitIntegrationPreflight,
): ExplicitPlan {
  const store = engine.store;
  const r = task.resolution;
  let mergedCommit: string;
  let mergeHead: string | null;
  let unverified = false;

  if (r.mergedCommit) {
    if (input.mergedCommit && input.mergedCommit !== r.mergedCommit) {
      throw Error(
        `closeout.now refused: recorded mergedCommit ${r.mergedCommit} does not match supplied ${input.mergedCommit}`,
      );
    }
    mergedCommit = r.mergedCommit;
    mergeHead = r.mergeHead ?? task.prHead ?? null;
  } else if (preflight?.observedMerge) {
    if (!preflight.observedMerge.merged || !preflight.observedMerge.commit) {
      throw Error("closeout.now refused: GitHub reports the PR is not merged");
    }
    if (
      preflight.observedMerge.base &&
      preflight.observedMerge.base !== task.baseBranch
    ) {
      throw Error(
        `closeout.now refused: GitHub reports the PR merged into ${preflight.observedMerge.base}, not task base ${task.baseBranch}`,
      );
    }
    if (
      input.mergedCommit &&
      input.mergedCommit !== preflight.observedMerge.commit
    ) {
      throw Error(
        `closeout.now refused: GitHub merge commit ${preflight.observedMerge.commit} does not match supplied ${input.mergedCommit}`,
      );
    }
    mergedCommit = preflight.observedMerge.commit;
    mergeHead =
      preflight.observedMerge.head ?? r.mergeHead ?? task.prHead ?? null;
  } else {
    if (!input.mergedCommit) {
      throw Error(
        `closeout.now refused: GitHub could not be read and no mergedCommit was supplied${preflight?.mergeReadError ? ` (${preflight.mergeReadError})` : ""}`,
      );
    }
    mergedCommit = input.mergedCommit;
    mergeHead = r.mergeHead ?? task.prHead ?? null;
    unverified = true;
  }

  // Hard gate: applied qualifying review verdict at that head or explicit operator source acceptance.
  if (!mergeHead || !hasExplicitMergeEvidence(task, mergeHead)) {
    throw Error(
      `closeout.now refused: merged head ${mergeHead ?? "unknown"} has no applied review verdict or explicit operator source acceptance`,
    );
  }

  const warnings: ExplicitWarning[] = [];
  if (unverified) {
    warnings.push({
      id: "unverified_merge",
      text: "GitHub could not be read to verify this merge commit; proceeding with the operator-stated commit.",
    });
  }
  const hasReadyVerdict = Boolean(
    mergeHead &&
      r.review?.status === "ready_to_merge" &&
      r.review.head === mergeHead,
  );
  if (!hasReadyVerdict) {
    warnings.push({
      id: "no_verdict",
      text: "No applied ready_to_merge review verdict exists for this merged head.",
    });
  }

  // Ruling 2: closeout.now never silently releases or revokes another run.
  // If a live coordinator/recovery run is bound and belongs to another caller,
  // return `live_runs` and route accepted release through `run.release`.
  const episodeRunId = r.recovery?.runId ?? null;
  const episodeRun = episodeRunId ? store.run(episodeRunId) : null;
  const liveEpisodeRun =
    episodeRun &&
    episodeRun.taskId === task.id &&
    episodeRun.role === "recovery" &&
    !episodeRun.released
      ? episodeRun
      : null;
  const isSelfCoordinator = Boolean(
    liveEpisodeRun &&
      sameCallerIdentity(
        liveEpisodeRun.agentId,
        input.caller,
        liveEpisodeRun.hostId ?? task.hostId,
        engine.legacyPaseoHostId(),
      ),
  );
  const boundRelease =
    liveEpisodeRun && !isSelfCoordinator
      ? releasePlan(engine, task, {
          action: "run.release",
          taskId: task.id,
          version: task.version,
          reason: input.reason,
          accept: input.accept,
          caller: input.caller,
          run: liveEpisodeRun.id,
        })
      : null;
  if (boundRelease) {
    warnings.push({
      id: "live_runs",
      text: `Live recovery run ${liveEpisodeRun!.id} is bound to this task; accepting releases and cancels it via run.release.`,
    });
  }

  return {
    warnings,
    apply() {
      let releasePatch: Partial<Task> = {};
      if (boundRelease) {
        releasePatch = boundRelease.apply().patch ?? {};
      } else if (liveEpisodeRun && isSelfCoordinator) {
        // The calling coordinator is handing off its own episode to closeout.
        store.putRun({
          ...liveEpisodeRun,
          active: false,
          released: true,
          explicitlyReleasedAt: now(),
          status: liveEpisodeRun.completion ? "finished" : "superseded",
        });
        store.deleteCredential(liveEpisodeRun.id);
      }
      const baseResolution = releasePatch.resolution ?? r;
      const clearedCurrentRunId =
        liveEpisodeRun && baseResolution.currentRunId === liveEpisodeRun.id
          ? null
          : baseResolution.currentRunId;
      const settledRecovery =
        baseResolution.recovery && baseResolution.recovery.status !== "resolved"
          ? {
              ...baseResolution.recovery,
              runId: null,
              status: "resolved" as const,
              summary: `Closed by closeout.now: ${input.reason}`.slice(0, 2000),
            }
          : baseResolution.recovery;

      const integrationTurn = baseResolution.integrationTurn ?? {
        sequence: store.nextIntegrationSequence(task.repoPath),
        acceptedAt: now(),
      };
      const phase = baseResolution.syncedCommit ? "closing" : "syncing";
      const reason =
        phase === "syncing"
          ? "Verified merge; synchronizing the integration checkout"
          : "Integration checkout synchronized; closeout pending";
      return {
        before: {
          phase: task.phase,
          mergedCommit: r.mergedCommit,
          mergeHead: r.mergeHead,
          stop: r.stop,
          attention: r.attention,
          recoveryActive: r.recoveryActive,
        },
        patch: {
          ...releasePatch,
          phase,
          reason,
          reasonFact: null,
          resolution: {
            ...baseResolution,
            mergedCommit,
            ...(mergeHead ? { mergeHead } : {}),
            ...(r.mergedCommit ? {} : { externalMerge: true }),
            integrationTurn,
            stop: null,
            attention: false,
            externalMergePreAttention: null,
            recoveryActive: false,
            recovery: settledRecovery,
            currentRunId: clearedCurrentRunId,
          },
        },
      };
    },
    async finish() {
      const releaseResult = boundRelease
        ? await boundRelease.finish?.()
        : undefined;
      engine.scheduleLifecycleFollowUp(task.id);
      return { issues: releaseResult?.issues ?? [] };
    },
  };
}

export const OPERATOR_ONLY_WARNINGS = new Set<ResolutionWarningId>([
  "unverified_merge",
]);
