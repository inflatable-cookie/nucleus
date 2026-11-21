import { type Run, type Task } from "../../../shared/contracts";
import { now, type Store } from "../../store/store";
import type { Adapter } from "../../host/adapter";
import { hostFailureRefusalDetail } from "../../host/errors";
import type { ResolutionAdapter } from "../../resolution";
import {
  creationProducerId,
  readCreationAttempt,
} from "../../store/store-task-funnel";
import {
  ABSENT_RESOLUTION_REASON,
  resolutionCreationRoles,
} from "../task-reasons";
import {
  isDispositionActive,
  isDispositionComplete,
} from "../../../shared/contracts";
import { taskPrNumber } from "../../forge/index";
import type { Resolution } from "../../resolution";
import { absentReplacementRecord } from "./budget";
import { agentlessCreation, provenAbsentCreation } from "./decisions";

/** Classify a complete, occurrence-bound lookup without treating uncertain placement as absence. */
export function creationLookup(
  found: { id: string; workspaceId: string | null; hostConfirmed?: boolean }[],
  workspaceId: string | null,
):
  | { kind: "absent" }
  | { kind: "bound"; agentId: string }
  | { kind: "unknown" } {
  if (found.length === 0) return { kind: "absent" };
  if (
    found.length === 1 &&
    workspaceId &&
    found[0]!.workspaceId === workspaceId &&
    found[0]!.hostConfirmed !== false &&
    found[0]!.id
  )
    return { kind: "bound", agentId: found[0]!.id };
  return { kind: "unknown" };
}

/**
 * The one observation a resolution-role creation occurrence waits on. Sweep,
 * `next` and the applying owner verb read these strings, so a stuck creation
 * names the same missing fact everywhere instead of a third routed answer.
 */
export const resolutionCreationWait = (role: Run["role"]): string =>
  `The ${role} creation remains uncertain; waiting for its recorded producer to stop and the lookup grace period to pass`;
const resolutionCreationPartial = (run: Run): string =>
  `The ${run.role} creation lookup for run ${run.id} is partial or ambiguous`;
const resolutionCreationUnavailable = (role: Run["role"]): string =>
  `Exact ${role} creation lookup is unavailable`;
const resolutionCreationSettled = (run: Run): string =>
  `The ${run.role} creation ${run.id} is still uncertain: a complete lookup found no agent, but its recorded creation call settled in this service process and may still deliver; wait for a service roll and another exact lookup`;

/** The preview is a store read. Only the sweep's positive proof can offer replacement. */
export function resolutionCreationRestartRefusal(task: Task, run: Run) {
  if (run.role !== "closeout" && run.head !== task.prHead)
    return "PR head changed; inspect it before replacing the absent run";
  if (provenAbsentCreation(run)) return null;
  const detail = task.resolution.stop?.detail;
  if (
    task.resolution.incident?.runId === run.id &&
    detail &&
    [
      resolutionCreationPartial(run),
      resolutionCreationUnavailable(run.role),
      resolutionCreationSettled(run),
    ].some((prefix) => detail.startsWith(prefix))
  )
    return detail;
  return resolutionCreationWait(run.role);
}

/**
 * What one agentless creation occurrence is, from its original delivery
 * evidence. `bound` is the exact identity that answers the occurrence;
 * `absent` is a complete lookup with no agent after the recorded producer can
 * no longer deliver; `partial` found a match it cannot bind (ambiguous,
 * misplaced or host-unconfirmed); `wait` has not answered yet and stays owned.
 * Zero matches alone are never absence: the original call may still deliver.
 */
export type ResolutionCreationObservation =
  | { kind: "bound"; agentId: string; attemptId: string | null }
  | { kind: "absent"; attemptId: string; terminatedBy: string }
  | { kind: "partial"; detail: string; attemptId: string | null }
  | { kind: "wait"; detail: string };

export function recordResolutionCreationBinding(
  store: Store,
  run: Run,
  agentId: string,
) {
  store.event(
    run.taskId,
    "run_creation_bound",
    `${run.id}: exact lookup bound agent ${agentId} in ${run.workspaceId}; its dispatch delivery is not yet observed`,
  );
}

/**
 * Observe one agentless resolution creation: capture termination before the
 * inventory read can prove absence, then classify the complete exact lookup.
 * A match binds even while its producer is pending; only an empty read needs
 * termination proof.
 */
export async function observeResolutionCreation(
  store: Pick<Store, "db">,
  adapter: Adapter & Partial<Pick<ResolutionAdapter, "findRunAgents">>,
  run: Run,
  graceMs: number,
): Promise<ResolutionCreationObservation> {
  // A call that settles during the lookup cannot answer that lookup.
  const attempt = readCreationAttempt(store, run);
  const gracePassed =
    attempt &&
    Date.now() - Date.parse(attempt.settlement?.at ?? attempt.reservedAt) >=
      graceMs;
  if (!adapter.findRunAgents)
    return {
      kind: "wait",
      detail: `${resolutionCreationUnavailable(run.role)}; the occurrence remains owned`,
    };
  let found: {
    id: string;
    workspaceId: string | null;
    hostConfirmed?: boolean;
  }[];
  try {
    found = await adapter.findRunAgents(run);
  } catch (error) {
    return {
      kind: "wait",
      detail: `${resolutionCreationUnavailable(run.role)} (${hostFailureRefusalDetail(error)}); the occurrence remains owned`,
    };
  }
  if (
    (readCreationAttempt(store, run)?.attemptId ?? null) !==
    (attempt?.attemptId ?? null)
  )
    return { kind: "wait", detail: resolutionCreationWait(run.role) };
  const lookup = creationLookup(found, run.workspaceId);
  if (lookup.kind === "bound")
    return {
      kind: "bound",
      agentId: lookup.agentId,
      attemptId: attempt?.attemptId ?? null,
    };
  if (lookup.kind === "absent" && attempt && gracePassed) {
    if (attempt.producerId !== creationProducerId)
      return {
        kind: "absent",
        attemptId: attempt.attemptId,
        terminatedBy: "service_replaced",
      };
    if (attempt.settlement)
      return { kind: "wait", detail: resolutionCreationSettled(run) };
  }
  if (lookup.kind === "unknown") {
    const placement =
      found.length === 1 && found[0]?.workspaceId !== run.workspaceId
        ? `; found agent outside the retained workspace ${run.workspaceId}`
        : "";
    const occurrence = attempt ? ` (attempt ${attempt.attemptId})` : "";
    return {
      kind: "partial",
      detail: `${resolutionCreationPartial(run)} (${found.length} matching agent${found.length === 1 ? "" : "s"})${placement}${occurrence}; the occurrence remains owned`,
      attemptId: attempt?.attemptId ?? null,
    };
  }
  return { kind: "wait", detail: resolutionCreationWait(run.role) };
}

/** Admit replacements for proven-absent creations. */
export type AbsentRestartsContext = Pick<
  Resolution,
  | "adapter"
  | "attention"
  | "ensureIncident"
  | "graceMs"
  | "paused"
  | "recordIncidentEvent"
  | "resolveIncident"
  | "settleVerbFences"
  | "store"
  | "update"
  | "waiting"
>;

/**
 * The resolution-side half of absence: settle a proven-absent worker or
 * resolution run and route a fresh same-role creation. The engine-side
 * half, which owns workspace creation and the worker-absence observations, is
 * `CreationRecovery` in `creation.ts`; the budget both read is `budget.ts`.
 */
export class AbsentRestarts {
  constructor(readonly resolution: AbsentRestartsContext) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  get graceMs() {
    return this.resolution.graceMs;
  }

  absentResolutionRun(t: Task) {
    const run = t.resolution.currentRunId
      ? this.store.run(t.resolution.currentRunId)
      : null;
    if (!run || run.released || run.completion || !agentlessCreation(run))
      return null;
    if (!resolutionCreationRoles.has(run.role)) return null;
    return run;
  }

  admitAbsentResolution(
    t: Task,
    runId: string,
    settleRunIds: string[] = [],
  ): Run {
    const current = t;
    const run = this.absentResolutionRun(current);
    if (!run || run.id !== runId)
      throw Error(
        "Absent resolution-run recovery requires an agentless reviewer or coordinator creation whose delivery is unanswered",
      );
    if (!current.workspaceId || !current.directory)
      throw Error(
        "Absent resolution-run recovery requires the retained task workspace",
      );
    if (run.taskId !== current.id || current.workspaceId !== run.workspaceId)
      throw Error("Absent resolution-run identity or workspace changed");
    if (current.resolution.mergeIntent && !current.resolution.mergedCommit)
      throw Error(
        "Absent resolution-run recovery cannot replace an uncertain merge intent",
      );
    if (run.role !== "closeout" && current.resolution.mergedCommit)
      throw Error("Absent resolution-run recovery cannot replace a merged PR");
    if (
      this.store
        .runs(current.id)
        .some(
          (r) =>
            r.id !== run.id &&
            r.role !== "recovery" &&
            !r.released &&
            !settleRunIds.includes(r.id),
        )
    )
      throw Error(
        "Absent resolution-run recovery has another unresolved task run",
      );
    return run;
  }

  /**
   * Spec 050 `restart` on a proven-absent resolution run: settle the run as
   * released history and let the ordinary launch create a fresh run from the
   * role's current route. The recorded creation payload is never replayed, so a
   * profile that changed provider since the intent is what launches. The new
   * run has its own identity and creation intent. The caller has already run the
   * exact lookup and read it as zero matches.
   */
  replaceAbsentRunFromRoute(
    t: Task,
    runId: string,
    instruction: string | null,
    settleFences?: {
      detail: string;
      runIds: string[];
      displacedRunIds?: string[];
    },
  ): Task {
    if (this.resolution.paused())
      throw Error("Nucleus is paused; absent run replacement is deferred");
    const settling = settleFences
      ? [...settleFences.runIds, ...(settleFences.displacedRunIds ?? [])]
      : [];
    return this.store.transaction(() => {
      const current = this.store.task(t.id),
        run = this.store.run(runId);
      if (
        current.version !== t.version ||
        current.resolution.currentRunId !== runId ||
        !run ||
        run.released ||
        !agentlessCreation(run)
      )
        throw Error(
          "Absent run changed during restart; refresh before retrying",
        );
      this.admitAbsentResolution(current, runId, settling);
      if (settleFences) this.resolution.settleVerbFences(t.id, settleFences);
      this.releaseAbsentRun(
        current,
        runId,
        `restart ${run.role}${instruction ? `: ${instruction.slice(0, 80)}` : ""}`,
      );
      const phase =
        run.role === "reviewer"
          ? "awaiting_review"
          : run.role === "executor"
            ? (run.proofExecution?.returnPhase ?? "awaiting_review")
            : "closing";
      return this.resolution.update(
        this.store.task(t.id),
        { currentRunId: null, attention: false },
        {
          phase,
          reason: `Absent ${run.role} creation settled; a fresh ${run.role} run launches from the current route`,
        },
        "absent_creation_routed",
        `${run.role}:${run.id}`,
      );
    });
  }

  /**
   * Release one unreleased, agentless creation as settled history:
   * its credential is revoked so a late callback cannot authenticate, the run is
   * superseded and released, and its incident resolves. Nothing is archived or
   * stopped, because no thread exists. The caller proves the absence first; the
   * route and restart paths both do. Writes only inside the caller's transaction.
   */
  releaseAbsentRun(t: Task, runId: string, detail: string): void {
    const run = this.store.run(runId);
    if (!run || run.released || !agentlessCreation(run))
      throw Error(
        "Only an agentless creation whose delivery is unanswered can be released as absent",
      );
    this.store.deleteCredential(run.id);
    this.store.putRun({
      ...run,
      status: "superseded",
      released: true,
      active: false,
      absentProvenAt: run.absentProvenAt ?? now(),
    });
    this.store.event(
      t.id,
      "absent_creation_released",
      `${run.role}:${run.id}: ${detail}`,
    );
    this.resolution.resolveIncident(
      this.store.task(t.id),
      run.id,
      `Absent ${run.role} creation released: ${detail}`,
    );
  }

  /**
   * Settle one uncertain resolution-role creation from its own observation.
   * After the bounded grace the occurrence takes exactly one of the observed
   * answers: a proved absence records its proof and the owner exits, a partial
   * lookup stays an owner decision bound to this occurrence, and an unanswered
   * lookup names the missing fact. Nothing here creates or releases a run.
   */
  async reconcileAbsentCreation(
    t: Task,
    run: Run,
    observation: ResolutionCreationObservation,
  ) {
    if (isDispositionActive(t) || isDispositionComplete(t)) return;
    // A creation already proved absent is settled: nothing re-looks it up, reopens its incident or escalates again.
    if (provenAbsentCreation(this.store.run(run.id) ?? run)) return;
    const prior = t.resolution.incident;
    const incident =
      prior?.runId === run.id &&
      prior.cause === "uncertain_delivery" &&
      prior.status !== "resolved"
        ? prior
        : this.resolution.ensureIncident(
            t,
            run,
            ABSENT_RESOLUTION_REASON,
            "exact_lookup",
          );
    const current = this.store.task(t.id);
    if (observation.kind === "partial") {
      this.resolution.attention(
        current,
        observation.detail,
        "uncertain_delivery",
      );
      return;
    }
    if (Date.now() - Date.parse(incident.createdAt) < this.graceMs) return;
    if (observation.kind === "absent") {
      this.settleAbsentProof(current, run, observation);
      return;
    }
    // An empty inventory alone does not prove that the original producer cannot
    // deliver later. Keep the run and credential owned, and name the exact fact
    // that has not answered yet.
    this.resolution.waiting(
      current,
      observation.kind === "wait"
        ? observation.detail
        : resolutionCreationWait(run.role),
      "lifecycle",
    );
  }

  /**
   * Record that an exact lookup proved this uncertain creation produced no agent,
   * either once the replacement budget is spent or from the sweep's own complete
   * observation. The run keeps its lease until an owner control releases it, but
   * observation stops looking it up and the effect no longer blocks other verbs.
   * The task names the owner controls that replace it.
   */
  settleAbsentProof(
    t: Task,
    run: Run,
    proof?: Pick<
      Extract<ResolutionCreationObservation, { kind: "absent" }>,
      "attemptId" | "terminatedBy"
    >,
  ): void {
    this.store.transaction(() => {
      const latest = this.store.run(run.id);
      if (!latest || latest.released || latest.agentId || latest.absentProvenAt)
        return;
      this.store.putRun({ ...latest, absentProvenAt: now() });
      this.store.event(
        t.id,
        "absent_creation_proven",
        `${run.role}:${run.id}: ${JSON.stringify(proof ?? {})}`,
      );
    });
    // The exact-lookup window has ended with an absence: the incident records that and stops asking for a retry.
    this.resolution.resolveIncident(
      this.store.task(t.id),
      run.id,
      "Exact lookup proved no agent; the creation settled as absent",
    );
    // A wait, not attention: the coordinator's own creation runs on the same host that never answered, so the owner replaces this run instead.
    this.resolution.waiting(
      this.store.task(t.id),
      `The ${run.role} creation ${run.id} is proved absent after an exact lookup (no agent, producer stopped); route role=${run.role} now or restart role=${run.role} launches one fresh run from the current route`,
      "lifecycle",
      { suggestedVerbs: ["route", "restart"] },
    );
  }

  /** Atomically revoke one proven-absent callback and issue exactly one same-role replacement. */
  async replaceAbsentCreation(t: Task, run: Run) {
    if (isDispositionActive(t) || isDispositionComplete(t)) return;
    if (t.removedAt) throw new Error("Task was removed from the queue");
    if (!t.workspaceId || !t.directory)
      throw new Error(
        "Absent run replacement requires the retained task workspace",
      );
    if (t.resolution.mergeIntent && !t.resolution.mergedCommit)
      throw new Error(
        "Absent run replacement cannot replace an uncertain merge intent",
      );
    if (run.role !== "closeout" && t.resolution.mergedCommit)
      throw new Error("Absent run replacement cannot replace a merged PR");
    if (
      this.adapter.workspaceAvailable &&
      !(await this.adapter.workspaceAvailable(t.workspaceId))
    )
      throw new Error(
        "Absent run replacement requires the retained task workspace",
      );
    if (run.role === "closeout") {
      if (!this.adapter.verifyCleanQueueWorktree)
        throw new Error("Workspace verification is unavailable");
      await this.adapter.verifyCleanQueueWorktree(t);
    } else {
      const pr = await this.adapter.verifyPr(t, taskPrNumber(t));
      if (pr.head !== t.prHead || pr.head !== run.head)
        throw new Error(
          "PR head changed; inspect it before replacing the absent run",
        );
    }
    const current = this.store.task(t.id);
    if (isDispositionActive(current) || isDispositionComplete(current)) return;
    const live = current.resolution.currentRunId
      ? this.store.run(current.resolution.currentRunId)
      : null;
    if (
      !live ||
      live.id !== run.id ||
      live.agentId ||
      live.completion ||
      live.released
    )
      throw new Error("Task changed during absent-run reconciliation");
    this.adapter.purgeReportingFiles?.(t.id, [run.id]);
    this.store.transaction(() => {
      this.store.deleteCredential(run.id);
      this.store.putRun({ ...run, status: "superseded", released: true });
      const incident = current.resolution.incident!;
      const phase =
        run.role === "reviewer"
          ? "awaiting_review"
          : run.role === "executor"
            ? (run.proofExecution?.returnPhase ?? "awaiting_review")
            : "closing";
      const reason = `Confirmed absent ${run.role} creation; Nucleus issued one replacement`;
      this.resolution.update(
        current,
        {
          currentRunId: null,
          attention: false,
          incident: {
            ...incident,
            action: "replacement",
            attempt: incident.attempt + 1,
            detail: `Proven-absent ${run.role} callback revoked; one replacement issued`,
            status: "reconciling",
            updatedAt: now(),
          },
        },
        { phase, reason },
        "absent_creation_replaced",
        absentReplacementRecord(run.role, run.id, reason),
      );
      this.resolution.recordIncidentEvent(current.id, {
        ...incident,
        action: "replacement",
        attempt: incident.attempt + 1,
        status: "reconciling",
        updatedAt: now(),
      });
    });
  }
}
