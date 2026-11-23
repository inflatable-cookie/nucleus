import { externalMergeStateRefusal } from "../verbs/control-refusals";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  externalMergeSourceAcceptance,
  mergeReviewEvidenceAt,
  type OwnerAcceptanceRecord,
  type Run,
  type Task,
} from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import {
  isLoginSessionFault,
  LoginSessionFaultError,
} from "../../shared/session-fault";
import { isTransportFailure } from "../../shared/transport";
import { settleSupersededFencesInTx } from "../recovery/fence-settlement";
import { ForgeOutageError } from "../forge/forge-health";
import {
  git,
  gitAncestrySync,
  GitReadTimeoutError,
  queueCheckoutStatus,
} from "../git/index";
import { commonDirMatchesTask, readGitCheckout } from "../git/git-identity";
import {
  QUANTUM_READ_DEADLINE_MS,
  boundedRead,
} from "../scheduling/pass-snapshot";
import type {
  ReviewEntryExternalMerge,
  RetainedSourceExternalMerge,
  Resolution,
} from "../resolution";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { now } from "../store/store";
import {
  EXTERNAL_MERGE_CHECK_REASON_PREFIX,
  EXTERNAL_MERGE_CHECK_RECOVERED_REASON,
  EXTERNAL_MERGE_PROBE_LIMIT,
  EXTERNAL_MERGE_PROBE_MS,
} from "../recovery/task-reasons";
import {
  isMergeCloseoutPhase,
  settleMergeEscalations,
} from "../closeout/closeout";
import { recordObservedMerge } from "./external-merge-record";
import { unreviewedMergeObservation } from "../../shared/task-view";
import {
  recoveredExternalCheckIncident,
  resumeClearedAttention as resumeClearedAttentionFor,
  resumeFromExternalMergeCheck as resumeFromExternalMergeCheckFor,
  stopUnreviewedExternalMerge,
} from "./external-merge-check";

export type ExternalMergeContext = Pick<
  Resolution,
  | "adapter"
  | "assignIntegrationTurn"
  | "attention"
  | "closeout"
  | "environmentDeferred"
  | "executionLease"
  | "gitTransientFailure"
  | "hasEarlierIntegrationTurn"
  | "host"
  | "openPlannerEscalation"
  | "paused"
  | "quantumReadTimeoutMs"
  | "resolveIncident"
  | "reviewRequired"
  | "store"
  | "transportDeferred"
  | "update"
  | "waiting"
> & {
  recovery: Pick<Resolution["recovery"], "releaseWithNotAppliedAction">;
};

/** The route whose acceptance this merge follows, with the witnesses that route proved. */
type AcceptanceRoute =
  | { kind: "ordinary" }
  | { kind: "review-entry"; reviewEntry: ReviewEntryExternalMerge }
  | {
      kind: "retained";
      retained: RetainedSourceExternalMerge;
      sourceWitness: string;
    };

/**
 * Everything one accepted external merge already proved, as one fact bundle.
 * The three routes differ only in `route`; the ordered settlement reads this
 * instead of threading ten positional arguments through four methods.
 */
export interface AcceptedExternalMergeJob {
  reason: string;
  settleFences?: string;
  appliedCoordinatorRunId?: string;
  /** Each run the acceptance observed, released in the settlement transaction. */
  captured: Run[];
  /** The exact run identity the acceptance read before the forge answer. */
  allRunIdentity: string;
  /** The runs still holding the task at settlement time. */
  leases: () => Run[];
  /** Re-proves the route's own inactivity after the forge answer. */
  stopped: () => Promise<void>;
  result: { head: string; commit: string };
  route: AcceptanceRoute;
}

/** Accepts or detects a PR merged outside Nucleus. */
export class ExternalMerge {
  constructor(readonly resolution: ExternalMergeContext) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  /**
   * The last automatic external-merge probe per task, with the lifecycle identity
   * it observed. In memory only: a restart forgets every stamp and therefore
   * probes immediately, which is the conservative direction.
   */
  private readonly externalMergeProbes = new Map<
    string,
    { at: number; identity: string }
  >();
  /** The window in which an unchanged task's automatic probe is not repeated. */
  externalMergeProbeMs = EXTERNAL_MERGE_PROBE_MS;

  /**
   * Operator-only: close out a PR merged outside Queue at a head that descends from the
   * recorded work (a planner commit on the task branch). The reason and both heads are
   * recorded; the merge then follows the normal external-merge closeout.
   *
   * Task 408: the same verb reconciles a queued review-entry task that never
   * dispatched (`reviewEntry` below). It has no runs to stop and no reviewer at
   * the head its own PR merged at, so the merge alone can never stand in for
   * review: the observed merged head and commit are proved, the exact-final-head
   * operator source acceptance is recorded beside them in the same transaction,
   * and the recorded source head (`prHead`), the immutable intake block, both
   * holds, pause, provenance and every declaration stay exact. Nothing is
   * dispatched, and no review, native proof or source-author credit is invented.
   */
  async acceptExternalMerge(
    t: Task,
    reason: string,
    settleFences?: string,
    appliedCoordinatorRunId?: string,
    reviewEntry?: ReviewEntryExternalMerge,
    retained?: RetainedSourceExternalMerge,
  ) {
    if (!this.adapter.externalMerge)
      throw new Error("External merge verification is unavailable");
    // A never-dispatched review-entry task is `queued` by definition, so the
    // dispatched-task refusal applies only when this boundary does not hold. The
    // boundary is the one the dependency correction reads; the authenticated
    // invocation executing this move is not a competing
    // writer (task 404), and every other unfinished operation still refuses.
    const boundary = reviewEntry
      ? this.store.reviewEntryUnrunBeforeFirstRun(t, reviewEntry.operationId)
      : false;
    if (reviewEntry && !boundary)
      throw new Error(
        "The review-entry pre-first-run boundary changed before the external merge; nothing was written",
      );
    const refusal = externalMergeStateRefusal(t, boundary);
    if (refusal) throw Error(refusal);
    const leases = () => this.store.runs(t.id).filter((r) => !r.released);
    const captured = leases();
    const allRunIdentity = JSON.stringify(this.store.runs(t.id));
    const stopped = async () => {
      for (const run of captured) {
        if (
          !run.agentId ||
          !run.workspaceId ||
          ["intent", "uncertain"].includes(run.status)
        )
          throw Error(
            "Unknown run delivery must be reconciled before accepting the external merge",
          );
        if (!["revision", "reviewer", "executor"].includes(run.role)) continue;
        const state = await this.resolution.host.observe(run.agentId);
        if (
          state.id !== run.agentId ||
          state.workspaceId !== run.workspaceId ||
          state.active ||
          state.activeTurnId ||
          state.permissions ||
          !["idle", "error", "closed"].includes(state.status)
        )
          throw Error(
            "A run still owns an active thread; stop it before accepting the external merge",
          );
      }
    };
    // The never-dispatched boundary proves inactive ownership before it reads
    // the forge: an unknown writer is not an absent one.
    if (reviewEntry) await reviewEntry.assertQuiet();
    if (retained) {
      retained.assertState();
      await retained.assertQuiet();
    }
    if (
      !reviewEntry &&
      !retained &&
      !(await this.resolution.executionLease(t))
    ) {
      throw new DurableFenceRefusal("Task execution participants are not settled");
    }
    await stopped();
    const sourceWitness = retained
      ? await this.proveRetainedExternalMergeSource(t)
      : null;
    const result = await this.adapter.externalMerge(t, true, Boolean(retained));
    if (!result) throw new Error("The task PR is not merged");
    const job: AcceptedExternalMergeJob = {
      reason,
      settleFences,
      appliedCoordinatorRunId,
      captured,
      allRunIdentity,
      leases,
      stopped,
      result,
      route: reviewEntry
        ? { kind: "review-entry", reviewEntry }
        : retained
          ? { kind: "retained", retained, sourceWitness: sourceWitness! }
          : { kind: "ordinary" },
    };
    await this.acceptRoute(t, job);
    return this.settleAcceptedExternalMerge(t, job);
  }
  /** The route whose acceptance this merge follows, with that route's own witnesses. */
  private async acceptRoute(
    t: Task,
    job: AcceptedExternalMergeJob,
  ): Promise<void> {
    const route = job.route;
    if (route.kind === "review-entry") {
      // A positively observed merge names both exact identities; never a
      // caller-supplied head and never a guessed commit.
      if (
        !/^[a-f0-9]{40}$/.test(String(job.result.head)) ||
        !/^[a-f0-9]{40}$/.test(String(job.result.commit))
      )
        throw Error(
          "The observed external merge did not name an exact merged head and commit",
        );
      const intake = t.reviewEntry?.verifiedHead,
        recorded = t.prHead;
      if (
        !t.directory ||
        !intake ||
        !recorded ||
        !/^[a-f0-9]{40}$/.test(intake) ||
        !/^[a-f0-9]{40}$/.test(recorded)
      )
        throw Error(
          "Reconciling a never-dispatched external merge requires the bound external workspace and the recorded intake and source heads",
        );
      // The merged head must descend from the immutable intake head AND the
      // task's latest recorded head: a rewritten or unrelated source is never
      // adopted as this task's work.
      for (const ancestor of [...new Set([intake, recorded])]) {
        try {
          await git(
            t.directory,
            "merge-base",
            "--is-ancestor",
            ancestor,
            job.result.head,
          );
        } catch {
          throw Error(
            `The observed merged head ${job.result.head} does not descend from the recorded source head ${ancestor}; this task's work was not merged at that head`,
          );
        }
      }
      await job.stopped();
      // Fresh inactive ownership after every await, then the workspace witness
      // synchronously before the commit: a moved, dirty or aliased checkout
      // refuses with nothing written, and no writer is read as absent.
      await route.reviewEntry.assertQuiet();
      if (await queueCheckoutStatus(t.directory!, "status", "--porcelain"))
        throw Error(
          "The bound external workspace is dirty; the external merge proof is stale",
        );
      if (readGitCheckout(t.directory!).head !== job.result.head)
        throw Error(
          "The bound external workspace moved during the external merge proof; nothing was accepted",
        );
      return;
    }
    if (route.kind === "retained") {
      await job.stopped();
      if (
        !/^[a-f0-9]{40}$/.test(job.result.head) ||
        !/^[a-f0-9]{40}$/.test(job.result.commit)
      )
        throw Error("External merge identity is incomplete");
      if (job.result.head === route.sourceWitness)
        throw Error(
          "A retained-source acceptance requires a descendant final head",
        );
      route.retained.acceptanceFor(job.result.head);
      await route.retained.assertQuiet();
      route.retained.assertState();
      if (
        (await this.proveRetainedExternalMergeSource(t)) !== route.sourceWitness
      )
        throw Error("Retained task source changed during external merge proof");
      if (
        gitAncestrySync(t.directory!, route.sourceWitness, job.result.head) !==
        "ancestor"
      )
        throw Error(
          "Merged head does not descend from the retained source or ancestry is unreadable",
        );
      return;
    }
    await job.stopped();
    if (
      !(await this.resolution.executionLease(t))
    ) {
      throw new DurableFenceRefusal("Task execution participants changed during external merge proof");
    }
  }
  /** One transaction: run release, the route's acceptance, and the observed merge. */
  private settleAcceptedExternalMerge(t: Task, job: AcceptedExternalMergeJob) {
    const {
      reason,
      settleFences,
      appliedCoordinatorRunId,
      captured,
      allRunIdentity,
      leases,
      result,
      route,
    } = job;
    return this.store.transaction(() => {
      const current = this.store.task(t.id);
      if (
        current.version !== t.version ||
        JSON.stringify(this.store.runs(t.id)) !== allRunIdentity
      )
        throw new Error(
          "Task or run changed during external merge verification",
        );
      const acceptance = this.acceptanceInTransaction(current, route, result);
      for (const run of leases()) {
        // The shared merge transition owns this episode. Keep its callback and
        // execution custody until that transition and the ordinary lease settle.
        if (
          run.role === "recovery" &&
          run.id === current.resolution.recovery?.runId &&
          !run.completion
        )
          continue;
        // Spec 050 (#3569): a recovery run released at closeout still records a
        // pending accepted action as not applied instead of closing silently.
        if (
          run.role === "recovery" &&
          this.resolution.recovery.releaseWithNotAppliedAction(
            current,
            run,
            `accepted external merge: ${reason}`,
            appliedCoordinatorRunId,
          )
        )
          continue;
        this.store.putRun({
          ...run,
          released: true,
          active: false,
          status: run.completion ? "finished" : "superseded",
        });
      }
      if (captured.length)
        this.store.event(
          t.id,
          "external_merge_stopped_runs_settled",
          captured.map((r) => r.id).join(", "),
        );
      this.store.event(
        t.id,
        "external_merge_head_accepted",
        `${t.prHead ?? "none"} -> ${result.head} at ${result.commit}: ${reason}`.slice(
          0,
          2000,
        ),
      );
      recordObservedMerge({ resolution: this.resolution }, current, {
        head: result.head,
        commit: result.commit,
        recordHead: !acceptance,
        acceptance,
        // A never-dispatched task keeps its recorded source head: the merged head
        // and commit are recorded beside it, not over it.
        reason: acceptance
          ? {
              holding:
                "Exact-final-head operator source acceptance recorded; the external merge is observed and main synchronizes before closeout",
              waiting:
                "Exact-final-head operator source acceptance recorded; the external merge is observed and waits for the repository integration turn",
            }
          : {
              holding:
                "Operator accepted the external merge; synchronizing main before coordinator closeout",
              waiting:
                "Operator accepted the external merge; waiting for repository integration turn",
            },
      });
      // Spec 050 atomic verbs: the move's fence settlement rides the accepted
      // merge inside this transaction, after its own update.
      if (settleFences && !current.resolution.recovery)
        settleSupersededFencesInTx(
          this.store,
          t.id,
          settleFences,
          now(),
          appliedCoordinatorRunId,
        );
      if (route.kind === "retained")
        route.retained.settleOperation(this.store.task(t.id));
      return this.store.task(t.id);
    });
  }
  /** The acceptance the route derives, re-proved inside the settlement transaction. */
  private acceptanceInTransaction(
    current: Task,
    route: AcceptedExternalMergeJob["route"],
    result: { head: string; commit: string },
  ): OwnerAcceptanceRecord | null {
    if (route.kind === "retained") {
      const { retained, sourceWitness } = route;
      retained.assertState();
      if (
        this.retainedExternalMergeIdentity(current) !== sourceWitness ||
        gitAncestrySync(current.directory!, sourceWitness, result.head) !==
          "ancestor"
      )
        throw Error(
          "Retained source or ancestry changed before external merge settlement",
        );
      const acceptance = retained.acceptanceFor(result.head);
      if (
        acceptance.head !== result.head ||
        acceptance.kind !== "operator_source" ||
        acceptance.review !== null
      )
        throw Error("The exact-final-head operator source acceptance changed");
      this.store.event(
        current.id,
        "owner_acceptance",
        JSON.stringify({ taskId: current.id, ...acceptance }).slice(0, 4000),
      );
      return acceptance;
    }
    if (route.kind === "review-entry") {
      // Re-proved inside the commit: the boundary, the recorded merge and the
      // authenticated invocation that is executing it. An unverifiable
      // invocation exempts nothing. The acceptance binds the OBSERVED merged
      // head, never the recorded source head and never a previous head's ruling.
      if (
        current.resolution.mergeIntent ||
        current.resolution.mergedCommit ||
        !this.store.reviewEntryUnrunBeforeFirstRun(current, route.reviewEntry.operationId)
      )
        throw new Error(
          "The review-entry boundary or recorded merge changed during the external merge proof; nothing was written",
        );
      const derived = route.reviewEntry.acceptanceFor(result.head);
      if (
        derived.head !== result.head ||
        derived.kind !== "operator_source" ||
        derived.review !== null
      )
        throw new Error(
          "The exact-final-head operator source acceptance does not bind the observed merged head",
        );
      this.store.event(
        current.id,
        "owner_acceptance",
        JSON.stringify({
          taskId: current.id,
          kind: derived.kind,
          prNumber: derived.prNumber,
          head: derived.head,
          missingEvidence: derived.missingEvidence,
          review: derived.review,
          actor: derived.actor,
          authority: derived.authority,
          reason: derived.reason,
          qualification: derived.qualification,
        }).slice(0, 4000),
      );
      return derived;
    }
    if (
      this.resolution.reviewRequired(current) &&
      !mergeReviewEvidenceAt(current, result.head)
    )
      throw new DurableFenceRefusal(
        "No review evidence binds the merged head; a responsible planner or the operator board can use closeout.now with accept [\"unreviewed_merge\"]",
      );
    return null;
  }

  /** Exact-head identity of the retained workspace from the filesystem. Safe inside a transaction. */
  private retainedExternalMergeIdentity(t: Task): string {
    if (
      !t.directory ||
      !t.workspaceId ||
      !t.prHead ||
      t.branch !== `ns-${t.id}` ||
      t.branch === t.baseBranch
    )
      throw Error(
        "Retained Nucleus workspace and recorded source identity are required",
      );
    const root = realpathSync(t.directory),
      repo = realpathSync(t.repoPath);
    let checkout, repoGit;
    try {
      checkout = readGitCheckout(t.directory);
      repoGit = readGitCheckout(t.repoPath);
    } catch {
      throw Error("Retained workspace is aliased or is not its Git root");
    }
    if (
      root !== resolve(t.directory) ||
      root === repo ||
      checkout.toplevel !== root
    )
      throw Error("Retained workspace is aliased or is not its Git root");
    if (
      !commonDirMatchesTask(
        t,
        checkout.commonDir,
        repoGit.commonDir,
        t.directory,
      )
    )
      throw Error("Retained workspace belongs to another repository");
    if (
      !t.repository ||
      normalizeRepositoryOrigin(checkout.origin) !==
        normalizeRepositoryOrigin(t.repository)
    )
      throw Error(
        "Retained workspace origin does not match the recorded repository",
      );
    if (checkout.branch !== t.branch)
      throw Error("Retained workspace is dirty or switched");
    if (checkout.head !== t.prHead)
      throw Error("Retained workspace does not match the recorded task source");
    return checkout.head;
  }
  /** Identity plus an async clean-tree walk. Call before the transaction; re-check identity inside it. */
  private async proveRetainedExternalMergeSource(t: Task): Promise<string> {
    const head = this.retainedExternalMergeIdentity(t);
    if (
      await queueCheckoutStatus(
        t.directory!,
        "--no-optional-locks",
        "status",
        "--porcelain",
      )
    )
      throw Error("Retained workspace is dirty or switched");
    if (this.retainedExternalMergeIdentity(t) !== head)
      throw Error("Retained workspace does not match the recorded task source");
    return head;
  }
  /** Re-prove the recorded source witness when acceptance kept a different merged head. */
  async observeRecordedMerge(t: Task) {
    if (!this.adapter.externalMerge)
      throw Error("External merge verification is unavailable");
    // A never-dispatched review entry keeps its intake head in prHead but its
    // checkout is at the merged head; it uses the ordinary merged-head witness.
    const unrunReviewEntry = Boolean(
      t.reviewEntry && !t.agentIntent && !t.agentId,
    );
    const retained = Boolean(
      t.prHead &&
        t.resolution.mergeHead &&
        t.prHead !== t.resolution.mergeHead &&
        (
          (!unrunReviewEntry && t.resolution.ownerAcceptances.some(
            (item) =>
              item.kind === "operator_source" &&
              item.head === t.resolution.mergeHead,
          )) ||
          (externalMergeSourceAcceptance(t) && t.directory &&
            readGitCheckout(t.directory).head === t.prHead)
        ),
    );
    const witness = retained
      ? await this.proveRetainedExternalMergeSource(t)
      : null;
    const observedRead = await boundedRead(
      "external merge check",
      () => this.adapter.externalMerge!(t, true, retained),
      this.resolution.quantumReadTimeoutMs ?? QUANTUM_READ_DEADLINE_MS,
    );
    if (observedRead.state === "unknown") return null;
    const observed = observedRead.value;
    if (
      retained &&
      ((await this.proveRetainedExternalMergeSource(t)) !== witness ||
        !observed ||
        gitAncestrySync(t.directory!, witness!, observed.head) !== "ancestor")
    )
      throw Error(
        "Retained source or ancestry changed during merge observation",
      );
    return observed;
  }
  async recoverExternalMerge(t: Task) {
    if (
      this.resolution.paused() ||
      t.removedAt ||
      ["done", "cancelled", "queued"].includes(t.phase)
    )
      return false;
    if (t.resolution.mergedCommit && isMergeCloseoutPhase(t)) {
      this.resolution.closeout.continueRecordedMerge(t, { kind: "sweep" });
      return false;
    }
    if (
      !this.adapter.externalMerge ||
      !t.workspaceId ||
      (!t.agentId && !t.reviewEntry) ||
      !(t.reviewEntry?.prNumber || t.completion?.prNumber || t.resumePrNumber)
    )
      return false;
    if (t.resolution.mergedCommit) {
      if (
        !this.externalMergeProbeDue(t) ||
        this.store.runs(t.id).some((run) => !run.released)
      )
        return false;
      if (!(await this.resolution.executionLease(t, false, true)))
        return false;
      const runs = JSON.stringify(this.store.runs(t.id));
      let observed: Awaited<
        ReturnType<NonNullable<typeof this.adapter.externalMerge>>
      >;
      try {
        observed = await this.observeRecordedMerge(t);
      } catch {
        this.noteExternalMergeProbe(t);
        return false;
      }
      this.noteExternalMergeProbe(t);
      if (
        !observed ||
        observed.head !== t.resolution.mergeHead ||
        observed.commit !== t.resolution.mergedCommit ||
        (this.resolution.reviewRequired(t) &&
          !mergeReviewEvidenceAt(t, observed.head) &&
          !externalMergeSourceAcceptance(t))
      )
        return false;
      if (
        !(await this.resolution.executionLease(t, false, true)) ||
        this.resolution.paused()
      )
        return false;
      return this.store.transaction(() => {
        if (
          this.store.task(t.id).version !== t.version ||
          JSON.stringify(this.store.runs(t.id)) !== runs
        )
          return false;
        return (
          this.resolution.closeout.continueRecordedMerge(t, {
            kind: "sweep",
            reobserved: true,
          }).version !== t.version
        );
      });
    }
    if (t.resolution.mergeIntent) return false;
    if (this.store.runs(t.id).some((r) => !r.released && !r.agentId))
      return false;
    try {
      // A read that cannot change an answer is not made again inside the window.
      // Skipping is "no merge observed this pass", exactly like a probe that found
      // the PR open, so the task's own path still advances; it never records a
      // merge, and a changed head, PR, phase, run, generation or attention
      // identity forces the read immediately.
      if (!this.externalMergeProbeDue(t)) return false;
      if (
        !(await this.resolution.executionLease(t, false, true)) ||
        this.resolution.paused()
      )
        return false;
      const observed = this.externalCheckIdentity(this.store.task(t.id));
      const resultRead = await boundedRead(
        "external merge check",
        () => this.adapter.externalMerge!(t),
        this.resolution.quantumReadTimeoutMs ?? QUANTUM_READ_DEADLINE_MS,
      );
      if (resultRead.state === "unknown") {
        // Spec 066 R1: a timed-out forge probe is unknown, never "PR is open".
        this.noteExternalMergeProbe(t);
        return false;
      }
      const result = resultRead.value;
      this.noteExternalMergeProbe(t);
      if (this.resolution.paused()) return false;
      if (!result) {
        // A fresh successful probe proves the PR still open. Re-prove the lease after the
        // await, then apply both writes in one transaction that re-checks the identity read
        // before the probe.
        if (
          !(await this.resolution.executionLease(
            this.store.task(t.id),
            false,
            true,
          )) ||
          this.resolution.paused()
        )
          return false;
        this.store.transaction(() => {
          const latest = this.store.task(t.id);
          const incident =
            this.externalCheckIdentity(latest) === observed
              ? recoveredExternalCheckIncident(
                  { store: this.store, resolution: this.resolution },
                  latest,
                )
              : null;
          if (incident) {
            this.resolution.resolveIncident(
              latest,
              incident.runId,
              "Fresh external merge probe found the PR open; external-check incident recovered",
            );
            this.store.event(
              t.id,
              "external_merge_check_incident_resolved",
              JSON.stringify({
                incidentId: incident.id,
                runId: incident.runId,
                head: latest.prHead ?? null,
              }),
            );
          }
          const restored = this.store.task(t.id);
          if (
            restored.resolution.attention &&
            restored.reasonFact?.code === "external_merge_check"
          )
            resumeFromExternalMergeCheckFor(
              { resolution: this.resolution },
              restored,
              EXTERNAL_MERGE_CHECK_RECOVERED_REASON,
            );
        });
        return false;
      }
      if (
        !(await this.resolution.executionLease(
          this.store.task(t.id),
          false,
          true,
        )) ||
        this.resolution.paused()
      )
        return false;
      const current = this.store.task(t.id);
      if (this.externalCheckIdentity(current) !== observed) return false;
      const descendant = result.head !== current.prHead;
      if (
        !current.prHead ||
        (descendant && result.descendsFrom !== current.prHead) ||
        !/^[a-f0-9]{40}$/.test(result.commit)
      )
        throw new Error("External merge head differs from recorded task work");
      // Task 993: a merge counts only for the task whose head was reviewed. A
      // fresh observation advances to syncing and closeout only when recorded
      // review evidence binds the merged head; otherwise the merge is recorded
      // as a fact and the task stops for its planner. Nothing is advanced,
      // reverted or synced, and the already-recorded-merge re-entry below never
      // re-decides an accepted route, so the gate lives only on this path. A
      // submission that explicitly skipped PR review keeps its previous merge
      // behavior, the same rule the Queue-owned gates apply.
      if (
        (descendant || this.resolution.reviewRequired(current)) &&
        !mergeReviewEvidenceAt(current, result.head)
      ) {
        // nucleus#1425: the recorded unreviewed merge governs its own re-observation. While
        // the owner's fresh review of that merged source is in flight, the probe neither
        // restates the stop nor answers the route; the review's verdict reconciles the merge.
        const route = unreviewedMergeObservation(current);
        const recordedMerge =
          route !== null &&
          route.head === result.head &&
          route.commit === result.commit;
        if (
          recordedMerge &&
          ["awaiting_review", "reviewing"].includes(current.phase)
        )
          return false;
        stopUnreviewedExternalMerge(
          { store: this.store, resolution: this.resolution },
          current,
          result.head,
          result.commit,
          descendant ? current.prHead : undefined,
        );
        return true;
      }
      this.store.transaction(() => {
        for (const run of this.store
          .runs(t.id)
          .filter(
            (r) =>
              !r.released &&
              !(
                r.role === "recovery" &&
                r.id === current.resolution.recovery?.runId
              ),
          ))
          this.store.putRun({ ...run, released: true, status: "superseded" });
        recordObservedMerge({ resolution: this.resolution }, current, {
          head: result.head,
          commit: result.commit,
          recordHead: true,
          reason: {
            holding:
              "External merge verified; synchronizing main before coordinator closeout",
            waiting:
              "External merge verified; waiting for repository integration turn",
          },
        });
        if (
          settleMergeEscalations(
            current,
            this.store,
            `Verified merge ${result.commit} superseded the earlier resolution step`,
          )
        ) {
          const latest = this.store.task(current.id);
          this.resolution.update(
            latest,
            { stop: null, attention: false },
            {},
            "pre_merge_escalation_settled",
          );
        }
      });
      return true;
    } catch (error) {
      // Ordinary probe failures are windowed like completed reads but never imply
      // an open PR. A timed-out local Git read is different: it made no witness,
      // so leave the probe due and retry it on the next pass.
      if (!this.resolution.paused()) {
        if (error instanceof GitReadTimeoutError)
          this.resolution.waiting(
            this.store.task(t.id),
            error.message,
            "external_unavailable",
          );
        else {
          if (
            error instanceof ForgeOutageError &&
            this.resolution.gitTransientFailure?.(this.store.task(t.id), error)
          )
            return true;
          this.noteExternalMergeProbe(t);
          if (error instanceof ForgeOutageError)
            this.resolution.waiting(
              this.store.task(t.id),
              error.message,
              "external_unavailable",
            );
          else if (isTransportFailure(error))
            this.resolution.transportDeferred(this.store.task(t.id), error);
          else if (
            error instanceof LoginSessionFaultError ||
            isLoginSessionFault(error)
          )
            this.resolution.environmentDeferred(this.store.task(t.id), error);
          else
            this.resolution.attention(
              this.store.task(t.id),
              `${EXTERNAL_MERGE_CHECK_REASON_PREFIX} ${error instanceof Error ? error.message : String(error)}`,
            );
        }
      }
      return true;
    }
  }
  /**
   * Whether the automatic probe may read the forge for this task now. A task
   * parked on the probe's own check is a stuck state with its own exit, so it is
   * asked about immediately; every other task waits for its window, its identity
   * to change, or the first pass after a restart.
   */
  private externalMergeProbeDue(task: Task): boolean {
    if (
      task.resolution.attention &&
      task.reasonFact?.code === "external_merge_check"
    )
      return true;
    const last = this.externalMergeProbes.get(task.id);
    return (
      !last ||
      last.identity !== this.externalMergeProbeIdentity(task) ||
      Date.now() - last.at >= this.externalMergeProbeMs
    );
  }
  /**
   * The lifecycle facts that make an already-made read stale. Version and event
   * history are excluded on purpose: observation writes advance them, so they
   * would defeat the window without changing what the forge would answer.
   */
  private externalMergeProbeIdentity(task: Task): string {
    return JSON.stringify([
      task.prUrl ?? null,
      task.prHead ?? null,
      task.phase,
      task.resolution.currentRunId ?? null,
      task.agentId ?? null,
      task.coordinatorGeneration,
      task.reviewEntry?.prNumber ?? null,
      task.completion?.prNumber ?? null,
      task.resumePrNumber ?? null,
    ]);
  }
  private noteExternalMergeProbe(task: Task): void {
    const identity = this.externalMergeProbeIdentity(task);
    this.externalMergeProbes.delete(task.id);
    if (this.externalMergeProbes.size >= EXTERNAL_MERGE_PROBE_LIMIT)
      this.externalMergeProbes.delete(
        this.externalMergeProbes.keys().next().value!,
      );
    this.externalMergeProbes.set(task.id, { at: Date.now(), identity });
  }
  /** Task version, stored incident and current run: the identity a probe must find unchanged. */
  private externalCheckIdentity(task: Task): string {
    const run = task.resolution.currentRunId
      ? this.store.run(task.resolution.currentRunId)
      : null;
    return JSON.stringify([
      task.version,
      task.resolution.incident ?? null,
      run,
    ]);
  }
  /**
   * Lifecycle sweep (project-a #1837): a task parked in `needs_attention` with the
   * attention flag already cleared, no current run and no unreleased run has
   * nothing that will advance it; the recorded pre-attention state is restored so
   * the ordinary resolution path runs again instead of idling.
   */
  resumeClearedAttention(t: Task): Task | null {
    if (t.resolution.mergedCommit) return null;
    return resumeClearedAttentionFor(
      { store: this.store, resolution: this.resolution },
      t,
    );
  }
}
