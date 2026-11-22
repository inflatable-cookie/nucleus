import {
  holdsOf,
  mergeReviewEvidenceAt,
  type Task,
} from "../../shared/contracts";
import type {
  ExplicitResolution,
  ResolutionWarningId,
} from "../../shared/schema/task-control";
import { TASK_PROGRESSING_REASON } from "../../shared/task-stop";
import type { Engine } from "../engine";
import { taskPrNumber } from "../forge/index";
import { now } from "../store/store";
import type {
  ExplicitPlan,
  ExplicitWarning,
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
  } | null;
  mergeReadError?: string;
  checksWarning?: string | null;
};

function activeOtherHolders(engine: Engine, task: Task): Task[] {
  return engine.store
    .integrationTasks(task.repoPath)
    .filter(
      (other) =>
        other.id !== task.id && engine.resolution.integrationActive(other),
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
    const unknownMergeOutcome =
      !r.mergedCommit &&
      (r.mergeIntent ||
        r.mergeResponseOutcome === "uncertain" ||
        r.mergeRetryOutcome === "uncertain");
    if (unknownMergeOutcome) {
      if (!engine.resolution.adapter.merged) {
        result.mergeReadError = "GitHub merge observation is unavailable";
      } else {
        try {
          const observed = await engine.resolution.adapter.merged(task);
          result.observedMerge = {
            merged: observed.merged,
            commit: observed.commit,
            head: observed.head ?? null,
          };
        } catch (error) {
          result.mergeReadError = String(error);
        }
      }
    }
    if (engine.resolution.requiredCheckPollState(task)) {
      result.checksWarning = "PR checks are still pending or failed.";
    } else if (
      !r.mergedCommit &&
      taskPrNumber(task) &&
      engine.resolution.adapter.requiredChecks
    ) {
      try {
        const checks = await engine.resolution.adapter.requiredChecks(task);
        if (checks.wait || checks.checksFailed || checks.pendingCheck) {
          result.checksWarning =
            checks.wait || "PR checks are pending or failed.";
        }
      } catch {
        /* A failed optional check read does not block merge.now. */
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
          ? { merged: true, commit: observed.commit, head: observed.head }
          : { merged: false, commit: null, head: null },
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
  const otherHolders = activeOtherHolders(engine, task);
  const otherReservation =
    reservation && reservation.taskId !== task.id
      ? store.taskOrNull(reservation.taskId)
      : null;
  const warnings: ExplicitWarning[] = [];
  if (otherHolders.length > 0 || otherReservation) {
    const names = [
      ...otherHolders.map((h) => `${h.title} (${h.id})`),
      ...(otherReservation &&
      !otherHolders.some((h) => h.id === otherReservation.id)
        ? [`${otherReservation.title} (${otherReservation.id})`]
        : []),
    ];
    warnings.push({
      id: "turn_held",
      text: `Repository integration turn is currently held by ${names.join(", ")}; taking it displaces them.`,
    });
  }
  if (
    otherHolders.some(
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
      for (const other of otherHolders) {
        store.update(
          other.id,
          { resolution: { ...other.resolution, integrationTurn: null } },
          "integration_turn_released",
          `displaced by turn.take on ${task.id}: ${input.reason}`,
        );
      }
      const integrationTurn = task.resolution.integrationTurn ?? {
        sequence: store.nextIntegrationSequence(task.repoPath),
        acceptedAt: now(),
      };
      const clearTurnWait =
        task.resolution.stop?.fact?.code === "integration_turn" ||
        task.reasonFact?.code === "integration_turn";
      return {
        before: {
          integrationTurn: task.resolution.integrationTurn,
          displaced: otherHolders.map((h) => h.id),
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
  // Hard gate 1: applied review verdict at exact head or explicit operator source acceptance.
  if (
    engine.resolution.reviewRequired(task) &&
    !mergeReviewEvidenceAt(task, input.head)
  ) {
    throw Error(
      `merge.now refused: head ${input.head} has no applied review verdict or explicit operator source acceptance`,
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
  }
  if (!engine.resolution.adapter.merge) {
    throw Error("GitHub guarded merge is unavailable");
  }

  const otherHolders = activeOtherHolders(engine, task);
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
  }

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
          mergeIntent: r.mergeIntent,
          mergeHead: r.mergeHead,
          mergeResponseOutcome: r.mergeResponseOutcome,
          integrationTurn: r.integrationTurn,
        },
        patch: {
          resolution: {
            ...r,
            integrationTurn,
            mergeIntent: true,
            mergeHead: input.head,
            mergeRequestedAt: now(),
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
      const current = store.task(task.id);
      try {
        await engine.resolution.adapter.merge!(current, () => true);
        const after = store.task(task.id);
        engine.resolution.update(
          after,
          { mergeResponseOutcome: "accepted" },
          {},
          "merge_response_accepted",
          `GitHub accepted the guarded merge for ${input.head}`,
        );
        return { issues: [] };
      } catch (error) {
        const after = store.task(task.id);
        engine.resolution.update(
          after,
          { mergeResponseOutcome: "uncertain" },
          {},
          "merge_response_uncertain",
          String(error).slice(0, 2000),
        );
        return {
          issues: [
            `GitHub merge request did not confirm: ${String(error).slice(0, 500)}.`,
          ],
        };
      }
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
      input.mergedCommit &&
      input.mergedCommit !== preflight.observedMerge.commit
    ) {
      throw Error(
        `closeout.now refused: GitHub merge commit ${preflight.observedMerge.commit} does not match supplied ${input.mergedCommit}`,
      );
    }
    mergedCommit = preflight.observedMerge.commit;
    mergeHead = preflight.observedMerge.head ?? r.mergeHead ?? task.prHead ?? null;
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

  // Hard gate: applied review verdict at that head or explicit operator source acceptance.
  if (
    engine.resolution.reviewRequired(task) &&
    (!mergeHead || !mergeReviewEvidenceAt(task, mergeHead))
  ) {
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

  return {
    warnings,
    apply() {
      const integrationTurn = r.integrationTurn ?? {
        sequence: store.nextIntegrationSequence(task.repoPath),
        acceptedAt: now(),
      };
      const phase = r.syncedCommit ? "closing" : "syncing";
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
        },
        patch: {
          phase,
          reason,
          reasonFact: null,
          resolution: {
            ...r,
            mergedCommit,
            ...(mergeHead ? { mergeHead } : {}),
            ...(r.mergedCommit ? {} : { externalMerge: true }),
            integrationTurn,
            stop: null,
            attention: false,
            externalMergePreAttention: null,
          },
        },
      };
    },
    async finish() {
      engine.scheduleLifecycleFollowUp(task.id);
      return { issues: [] };
    },
  };
}

export const OPERATOR_ONLY_WARNINGS = new Set<ResolutionWarningId>([
  "unverified_merge",
]);
