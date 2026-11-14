import { existsSync } from "node:fs";
import {
  type AnyHookEvent, type ControlManifest, type NormalizedControlManifest, type NormalizedHookDefinition, type HookEventName, type HookRecord, type MergeCandidate,
} from "../../shared/hooks";
import { normalizeControlManifest, manifestSupportsCloseoutSelection } from "../../shared/hooks";
import type { ProjectCloseout, ProjectValidation, Submission, Task } from "../../shared/contracts";
import { Store } from "../store/store";
import { gitText, snapshotGit } from "../git/git-snapshot";
import { executeHookProgram, type ExecutionRequest } from "../machine/process-exec";
import { HookReplay } from "./hook-replay";
import { ProspectiveMerge } from "../merge/prospective-merge";
import { ProjectValidationRunner } from "../qa/project-validation";
import { HostRunScheduler } from "../host-runs/host-run-scheduler";
import { repositoryOrigin } from "../planning/lanes";
import { requestDisposition } from "../verbs/disposition";
import {
  hookHoldReason,
  type AutomaticReplayAttempt, type HeldAutomaticReplay, type HookContext, type HookEmissionResult,
  type ProjectValidationOutcome, type ProspectiveMergeRequest, type ProspectiveMergeOutcome, type RepositoryHooksOptions,
} from "./hook-context";
import { discoverManifest, repositoryIsGitCheckout, type ManifestDiscovery } from "./hook-manifest";
import { HookCheckouts } from "./hook-checkouts";
import { HookOccurrences } from "./hook-occurrence";
import { HookPublication } from "./hook-publication";
import { HookReconciler } from "./hook-reconcile";
import { HookRetentionGate } from "./hook-retention";
import { HookExecution } from "./hook-execution";
import { HookRetry } from "./hook-retry";

export { READ_ONLY_BASE_ADVANCED_KIND, STALE_INTEGRATION_BASE_PROOF, isStaleIntegrationBaseRefusal } from "./hook-replay";
export { hookHoldReason, isHookHoldReason, isRecoveredPreDispatchHookHold, isCloseoutHookHold, type HookEmissionResult, type HookContext, type ProspectiveMergeOutcome } from "./hook-context";
export { isolationDataDirFor, isolationRootFor, isolationPathFor, warmCandidatePathFor, isOwnedIsolationPath } from "./hook-isolation";
export { blobDigest, repositoryIsGitCheckout, pinInstruction, instructionForCommit, parseManifestBytes, forgetManifestDiscovery, discoverManifest, pinExecutable } from "./hook-manifest";
export { executeHookProgram, type ExecutionOutcome, type ExecutionRequest } from "../machine/process-exec";
export { SCRATCH_INDEX_PREFIX, parsePorcelain, statusEntries, ignoredPathCollides, snapshotGit, inspectChangedPaths, verifyReviewedHead } from "../git/git-snapshot";
export { gitRun as gitRaw } from "../git/git-command";
export { minimalHookEnvironment, parseHookResult, STDERR_EXCERPT_MAX_BYTES, HOOK_EVIDENCE_MAX_BYTES } from "./hook-result";
export { RETENTION_TIMEOUT_ATTEMPTS } from "./hook-retention";
export type { RepositoryHooksOptions } from "./hook-context";

/** Task-history kind recorded when a bound `task.finished` hook is skipped because the retained worktree is gone. */
export const FINISHED_WORKTREE_MISSING_KIND = "finished_hook_worktree_missing";
/** Task-history kind recorded when a bound `task.finished` hook could not be evaluated at all. */
const FINISHED_HOOK_WARNING_KIND = "finished_hook_warning";
/** Task-history kind recorded when the durable `task.finished` intent is cleared after evaluation. */
const FINISHED_HOOK_SETTLED_KIND = "finished_hook_settled";

export type CloseoutAuthority = "hook" | "agent" | "queue";

/** A required integration-write task.closeout hook owns closeout for one repository. */
export function isCloseoutAuthorityHook(hook: Pick<NormalizedHookDefinition, "delivery" | "mode" | "events">): boolean {
  return hook.delivery === "required" && hook.mode === "integration_write" && hook.events.includes("task.closeout");
}

/**
 * Select one closeout authority from a pinned control manifest. A manifest, when
 * present, governs. Without one the project closeout override applies, and Queue
 * closeout is the default (Spec 022): a repository with no manifest behaves like
 * `{ v5, closeout: "queue", hooks: [] }`.
 */
export function classifyCloseoutAuthority(manifest: ControlManifest | NormalizedControlManifest | null, noManifestOverride?: ProjectCloseout | null): CloseoutAuthority {
  if (!manifest) return noManifestOverride === "agent" ? "agent" : "queue";
  const normalized = normalizeControlManifest(manifest);
  if (manifestSupportsCloseoutSelection(normalized.schema) && normalized.closeout === "queue") return "queue";
  return normalized.hooks.some(isCloseoutAuthorityHook) ? "hook" : "agent";
}

/**
 * Refuse a review-skipping submission where a required integration-write
 * `task.closeout` hook owns closeout.
 *
 * That hook receives the delivery object instead of Queue producing review
 * identity, so a review-skipping lane can merge completely and still never close:
 * the hook refuses for a missing accepted review, and no recovery control can
 * invent one. Refusing at submission happens while the dispatcher can still
 * choose an ordinary reviewed lane, and it is conditional on the pinned manifest
 * so a repository without hook-owned closeout keeps the option.
 *
 * The condition is the manifest-level closeout binding rather than a hook
 * identity: Queue does not parse a repository's document system, and every
 * closeout-owning hook is one Queue cannot satisfy from a review-skipping lane.
 */
/**
 * A repository that opts into formal PR reviews (Spec 033) cannot take a
 * review-skipping lane: branch protection requires the configured login's
 * approved review at the current head, and Queue will not invent one. As with
 * the hook-owned closeout binding below, refusing at submission happens while
 * the dispatcher can still choose an ordinary reviewed lane, and the merge gate
 * refuses independently for a task submitted before the opt-in existed.
 */
export async function assertReviewSkipSupported(
  submission: Pick<Submission, "repoPath" | "skipPRReview">,
  baseCommit: string,
  reviewerLogin?: string | null,
): Promise<void> {
  if (!submission.skipPRReview) return;
  if (reviewerLogin) throw new Error(`skipPRReview is unavailable for this repository: it opts into formal PR reviews as ${reviewerLogin}, which requires an independent exact-head review and that login's approved review at the current head before merge. Remove queue.skipPRReview from the handoff and submit an ordinary reviewed lane, or clear the repository's reviewer setting.`);
  const discovery = await discoverManifest(submission.repoPath, baseCommit);
  if (classifyCloseoutAuthority(discovery?.manifest ?? null) !== "hook") return;
  throw new Error("skipPRReview is unavailable for this repository: a required integration-write task.closeout hook owns closeout and needs the accepted review identity that a review-skipping lane never produces, so the task could merge but never close. Remove queue.skipPRReview from the handoff and submit an ordinary reviewed lane.");
}

/** Cancel one still-queued task through the same durable disposition model as post-dispatch work. */
export async function cancelQueuedTask(store: Store, hooks: RepositoryHooks, task: Task): Promise<Task> {
  if (task.phase !== "queued") throw new Error("Cancellation is only available before dispatch");
  return requestDisposition(store, {
    hooks,
    observeAgent: async () => ({ stopped: true }),
    archiveAgent: async () => {},
    proveWorkspaceEmpty: async () => ({ empty: true, detail: "No task workspace was created" }),
    proveRetainedByReplacement: async () => ({ retained: true, detail: "No unique work exists before dispatch" }),
    archiveWorkspace: async () => true,
    observeWorkspaceArchived: async () => true,
    settleCancelledPr: async () => "No PR before dispatch",
  }, { taskId: task.id, version: task.version, action: "cancel", reason: "Cancelled before dispatch", requestedBy: "operator control" });
}

/**
 * Owns optional repository-hook discovery, durable intent, direct execution,
 * bounded integration publication and restart reconciliation. Queue never
 * parses the instruction or allows a hook to own Git state.
 *
 * This class is the public front of the hook domain. Each mechanism behind it
 * has one owner: occurrence records (`hook-occurrence`), read-only execution
 * (`hook-execution`), integration-write publication (`hook-publication`), the
 * restart reconciliation state machine (`hook-reconcile`), retry and disposal
 * proofs (`hook-retry`), the retention gate and its reconciliation
 * (`hook-retention`), and the Queue-owned checkout and integration base
 * (`hook-checkouts`).
 */
export class RepositoryHooks {
  private readonly checkouts: HookCheckouts;
  private readonly occurrences: HookOccurrences;
  private readonly prospectiveMerge: ProspectiveMerge;
  private readonly publication: HookPublication;
  private readonly reconciler: HookReconciler;
  private readonly hookReplay: HookReplay;
  private readonly retention: HookRetentionGate;
  private readonly execution: HookExecution;
  private readonly retryRunner: HookRetry;
  private readonly projectValidation: ProjectValidationRunner;

  constructor(readonly store: Store, readonly options: RepositoryHooksOptions = {}) {
    this.checkouts = new HookCheckouts({ store, dataDir: options.dataDir });
    this.occurrences = new HookOccurrences({ store, isolationPath: (task, eventId) => this.checkouts.isolationPath(task, eventId) });
    this.prospectiveMerge = new ProspectiveMerge({
      store: this.store,
      isolationDataDir: () => this.checkouts.dataDir(),
      gitCommonDir: task => this.checkouts.gitCommonDir(task),
      integrationBase: task => this.integrationBase(task),
      removeIsolatedCheckout: (task, path, force) => this.removeIsolatedCheckout(task, path, force),
      save: (record, changes) => this.occurrences.save(record, changes),
      emit: (event, task, context, accept) => this.emit(event, task, context, accept),
    });
    this.publication = new HookPublication({
      store: this.store,
      checkouts: this.checkouts,
      run: request => this.run(request),
      save: (record, changes) => this.occurrences.save(record, changes),
      fail: (record, error) => this.occurrences.fail(record, error),
      uncertain: (record, error) => this.occurrences.uncertain(record, error),
      settle: (record, result, extra) => this.occurrences.settle(record, result, extra),
      result: record => this.occurrences.result(record),
    });
    this.reconciler = new HookReconciler({
      store: this.store,
      publication: this.publication,
      save: (record, changes) => this.occurrences.save(record, changes),
      uncertain: (record, error) => this.occurrences.uncertain(record, error),
      settle: (record, result, extra) => this.occurrences.settle(record, result, extra),
      result: record => this.occurrences.result(record),
    });
    this.hookReplay = new HookReplay({
      store: this.store,
      save: (record, changes) => this.occurrences.save(record, changes),
      matchingCommits: (task, record) => this.publication.matchingCommits(task, record),
      isolationPath: (task, eventId) => this.checkouts.isolationPath(task, eventId),
      verifyCleanSynchronizedBase: (root, baseBranch, baseCommit) => this.verifyCleanSynchronizedBase(root, baseBranch, baseCommit),
      remoteCarries: (task, record) => this.publication.remoteCarries(task, record),
      remoteCarriesCommit: (task, record, commit) => this.publication.remoteCarriesCommit(task, record, commit),
      removeIsolatedCheckout: (task, path, force) => this.removeIsolatedCheckout(task, path, force),
      runHook: (task, hook, discovery, context) => this.execution.runHook(task, hook, discovery, context),
      emit: (event, task, context, accept) => this.emit(event, task, context, accept),
    });
    this.retention = new HookRetentionGate({
      store: this.store,
      save: (record, changes) => this.occurrences.save(record, changes),
      lock: (key, work) => this.execution.withLock(key, work),
      emit: (event, task, context) => this.emit(event, task, context),
      runRecordedHook: (task, hook, record) => this.execution.runRecordedHook(task, hook, record),
      retry: (task, hookEventId, discardUnpublishedCheckout, cleanupOnly) => this.retry(task, hookEventId, discardUnpublishedCheckout, cleanupOnly),
    });
    this.execution = new HookExecution({
      store: this.store,
      checkouts: this.checkouts,
      occurrences: this.occurrences,
      publication: this.publication,
      prospectiveMerge: this.prospectiveMerge,
      hookReplay: this.hookReplay,
      reconcile: record => this.reconciler.reconcile(record),
      materializeReconciledProgram: (task, record) => this.retention.materializeReconciledProgram(task, record),
      run: request => this.run(request),
      snapshot: root => this.snapshot(root),
    });
    this.retryRunner = new HookRetry({
      store: this.store,
      checkouts: this.checkouts,
      publication: this.publication,
      execution: this.execution,
      hookReplay: this.hookReplay,
      occurrences: this.occurrences,
      reconcile: record => this.reconciler.reconcile(record),
    });
    this.projectValidation = new ProjectValidationRunner({
      store: this.store,
      options: this.options,
      hostRunScheduler: () => this.hostRunScheduler,
      isolationDataDir: () => this.checkouts.dataDir(),
      integrationBase: (task) => this.integrationBase(task),
      prospectiveCandidatePath: (task, candidate) => this.prospectiveCandidatePath(task, candidate),
      buildProspectiveCandidate: (task, path, base, head, warm) => this.buildProspectiveCandidate(task, path, base, head, warm),
      removeIsolatedCheckout: (task, path, force) => this.removeIsolatedCheckout(task, path, force),
    });
  }

  /** Dispose the former repository-local warm clones once; no event checkout is replayed or removed. */
  async disposeLegacyWarmCheckouts(): Promise<void> {
    return this.checkouts.disposeLegacyWarmCheckouts(this.store, (task, path, common) => this.prospectiveMerge.proveWarmOwnership(task, path, common));
  }

  private get hostRunScheduler(): HostRunScheduler { return this.options.hostRuns ?? HostRunScheduler.forStore(this.store); }
  /** Queue scheduler liveness for client runs submitted from a worker worktree. */
  liveClientHostRunAt(directory: string | null | undefined) { return this.hostRunScheduler.liveClientRunAt(directory); }

  private run(request: ExecutionRequest) { return (this.options.run ?? executeHookProgram)(request); }
  private snapshot(root: string) { return (this.options.snapshot ?? snapshotGit)(root); }
  private queueBuild(): string { return this.projectValidation.queueBuild(); }
  /** The Queue data directory that owns isolated checkouts, as the queue's own front reports it. */
  private isolationDataDir(): string { return this.checkouts.dataDir(); }
  /** The clean, synchronized integration base proof; one owner, reachable from the front. */
  private verifyCleanSynchronizedBase(root: string, baseBranch: string, baseCommit: string): Promise<void> {
    return this.checkouts.verifyCleanSynchronizedBase(root, baseBranch, baseCommit);
  }
  /** Remove only a Queue-owned isolated checkout. */
  private removeIsolatedCheckout(task: Task, path: string, force: boolean): Promise<void> {
    return this.checkouts.removeIsolatedCheckout(task, path, force);
  }
  private prospectiveCandidatePath(task: Task, candidate: Pick<MergeCandidate, "integrationBase" | "reviewedHead">): Promise<string> {
    return this.prospectiveMerge.prospectiveCandidatePath(task, candidate);
  }
  private buildProspectiveCandidate(task: Task, path: string, base: string, head: string, warm = false): Promise<{ kind: "built"; candidate: MergeCandidate } | { kind: "conflict"; detail: string } | { kind: "error"; detail: string } | { kind: "fallback"; detail: string }> {
    return this.prospectiveMerge.buildProspectiveCandidate(task, path, base, head, warm);
  }

  /** Run read-only pre-dispatch policy before a task enters the durable Queue store. */
  async previewPreDispatch(submission: Submission, handoffText: string, planningBase: string): Promise<void> {
    // Spec 033: an opted-in repository refuses a review-skipping lane before any hook runs.
    const reviewerLogin = submission.skipPRReview
      ? this.store.canonicalRepository(submission.repoPath, await repositoryOrigin(submission.repoPath).catch(() => null))?.reviewer?.login ?? null
      : null;
    await assertReviewSkipSupported(submission, planningBase, reviewerLogin);
    const previewStore = new Store(":memory:");
    try {
      // The throwaway store holds no lanes, lane documents or prerequisites. All three are
      // validated against the real store before this preview, and none affects
      // pre-dispatch hooks. Leaving laneDocuments in refused every brief that linked one.
      const preview = previewStore.insert({ ...submission, dependsOn: [], lanes: [], laneDocuments: [] }, "pre-dispatch-preview", handoffText, planningBase);
      const result = await new RepositoryHooks(previewStore, this.options).emit("task.pre_dispatch", preview, {
        event: "task.pre_dispatch", baseCommit: planningBase, summary: "Submission pre-dispatch validation",
      });
      if (result.hold) throw new Error(hookHoldReason(result));
    } finally { previewStore.close(); }
  }

  /** Select the closeout authority at one immutable integration base: the manifest there governs, and without one the project override decides (Spec 022). */
  async closeoutAuthorityAt(task: Task, baseCommit: string): Promise<CloseoutAuthority> {
    const discovery = await discoverManifest(task.repoPath, baseCommit);
    if (discovery?.manifest) return classifyCloseoutAuthority(discovery.manifest);
    const origin = await repositoryOrigin(task.repoPath);
    return classifyCloseoutAuthority(null, this.store.repositoryCloseoutOverride(task.repoPath, origin));
  }

  /** True when every closeout record is a terminal success, so a restart or a successful retry must conclude instead of re-emitting. */
  closeoutEmissionSettled(taskId: string): boolean {
    return this.occurrences.emissionSettled(taskId, "task.closeout");
  }

  cancellationEmissionSettled(taskId: string): boolean {
    return this.occurrences.emissionSettled(taskId, "task.cancelled");
  }

  /** The consumer-owned pre-archive retention gate; see {@link HookRetentionGate.gate}. */
  retentionGate(task: Task, target: { directory: string; head: string; reason: string }): Promise<HookEmissionResult> {
    return this.retention.gate(task, target);
  }

  /** Explicit operator reconciliation of a merged done task's refused retention gate; see {@link HookRetentionGate.retryAtIntegrationBase}. */
  retryRetentionAtIntegrationBase(task: Task, reason: string): Promise<HookEmissionResult> {
    return this.retention.retryAtIntegrationBase(task, reason);
  }

  /** The retention gate as a disposition step consumes it. */
  preArchive(task: Task): Promise<{ hold: boolean; detail: string }> {
    return this.retention.preArchive(task);
  }

  /**
   * The advisory finished-task runtime stop.
   *
   * When a task reaches `done` or `cancelled` with a retained worktree and the
   * repository's pinned manifest binds an advisory read-only `task.finished`
   * hook, Queue runs that program once in the retained worktree. A failure,
   * timeout or uncertainty is a warning on the task's history: it never holds
   * the transition, reopens the task, removes the worktree or clears volumes.
   * A missing worktree is noted and skipped. Repositories without the bound
   * hook get an empty, non-holding result and are unchanged. Queue never
   * chooses the runtime command; the repository declares it.
   *
   * The result is advisory, so every caller records the warning and advances.
   */
  async finished(task: Task): Promise<HookEmissionResult> {
    const outcome = await this.finishedOutcome(task);
    this.settleFinishedIntent(task.id);
    return outcome;
  }

  /**
   * Clear the durable finished-task intent once the stop has been evaluated,
   * whatever the outcome. The intent is the restart authority for a task the
   * ordinary lifecycle scan no longer visits, so it must survive a crash during
   * the stop and only retire after a settled result, an advisory failure, an
   * uncertainty, a missing worktree or an unbound hook.
   */
  private settleFinishedIntent(taskId: string): void {
    const latest = this.store.task(taskId);
    if (!latest.resolution.finishedHook) return;
    if (!["done", "cancelled"].includes(latest.phase)) return;
    this.store.update(latest.id, { resolution: { ...latest.resolution, finishedHook: null } },
      FINISHED_HOOK_SETTLED_KIND, "Finished-task runtime stop evaluated; durable intent cleared");
  }

  private async finishedOutcome(task: Task): Promise<HookEmissionResult> {
    const none: HookEmissionResult = { hold: false, attention: false, records: [] };
    if (!["done", "cancelled"].includes(task.phase)) return none;
    if (!repositoryIsGitCheckout(task.repoPath)) return none;
    const directory = task.directory && existsSync(task.directory) ? task.directory : null;
    let baseCommit = task.resolution.syncedCommit ?? task.resolution.mergedCommit ?? task.planningBase ?? null;
    if (directory) baseCommit = await gitText(directory, "rev-parse", "HEAD").catch(() => baseCommit);
    if (!baseCommit) return none;
    let bound: { discovery: ManifestDiscovery; hooks: NormalizedHookDefinition[] } | null;
    try { bound = await this.boundHooks(task, "task.finished", baseCommit); }
    catch (error) {
      this.store.event(task.id, FINISHED_HOOK_WARNING_KIND, `task.finished could not read the control manifest: ${error instanceof Error ? error.message : String(error)}`);
      return none;
    }
    if (!bound || !bound.hooks.length) return none;
    if (!directory) {
      // Once per task: a repeated pass over an already-archived task must not
      // keep appending the same note.
      if (!this.store.events(task.id).some(event => event.kind === FINISHED_WORKTREE_MISSING_KIND))
        this.store.event(task.id, FINISHED_WORKTREE_MISSING_KIND, "task.finished hook is bound but the retained worktree is missing; runtime stop skipped");
      return none;
    }
    try {
      const outcome = await this.emit("task.finished", task, {
        event: "task.finished", baseCommit, baseBranch: task.baseBranch,
        summary: `Finished-task runtime stop after ${task.phase}`, worktree: directory,
      });
      // The event is advisory by contract: even an uncertain execution is a
      // warning on the task's history, never a hold on its terminal phase.
      return { ...outcome, hold: false, attention: false };
    } catch (error) {
      this.store.event(task.id, FINISHED_HOOK_WARNING_KIND, `task.finished could not run: ${error instanceof Error ? error.message : String(error)}`);
      return none;
    }
  }

  async boundHooks(task: Task, event: HookEventName, baseCommit: string): Promise<{ discovery: ManifestDiscovery; hooks: NormalizedHookDefinition[] } | null> {
    if (!repositoryIsGitCheckout(task.repoPath)) return null;
    const discovery = await discoverManifest(task.repoPath, baseCommit);
    if (!discovery) return null;
    return { discovery, hooks: discovery.manifest.hooks.filter(hook => hook.events.includes(event)) };
  }

  /** The clean, synchronized integration base commit for one repository, proven against origin. */
  integrationBase(task: Task): Promise<string> {
    return this.checkouts.integrationBase(task, (root, baseBranch, baseCommit) => this.verifyCleanSynchronizedBase(root, baseBranch, baseCommit));
  }

  /**
   * Fast-forward the integration base to origin after a stale-base refusal: the
   * same ff-only move the post-merge sync makes, without its merged-commit
   * precondition. Dirty, wrong-branch and locally-ahead checkouts still refuse,
   * so the cleanliness proof is not relaxed; only origin being ahead is renewed.
   */
  renewIntegrationBase(task: Task, allowed: () => boolean): Promise<string> {
    return this.checkouts.renewIntegrationBase(task, allowed);
  }

  prospectiveMergeGate(task: Task, request: ProspectiveMergeRequest): Promise<ProspectiveMergeOutcome> {
    return this.prospectiveMerge.prospectiveMergeGate(task, request);
  }

  startProjectValidation(task: Task, head: string, validation: ProjectValidation): Promise<ProjectValidationOutcome> {
    return this.projectValidation.startProjectValidation(task, head, validation);
  }

  cancelProjectValidation(task: Task, reason: string): Promise<void> {
    return this.projectValidation.cancelProjectValidation(task, reason);
  }

  projectValidationGate(task: Task, head: string, validation: ProjectValidation): Promise<ProjectValidationOutcome> {
    return this.projectValidation.projectValidationGate(task, head, validation);
  }

  /** Reconcile one durable occurrence against the repository and the remote after a restart. */
  reconcile(record: HookRecord): Promise<HookRecord> {
    return this.reconciler.reconcile(record);
  }

  /** Persist the durable intent of one occurrence without executing it (the restart seam). */
  private intent(task: Task, hook: NormalizedHookDefinition, discovery: ManifestDiscovery, context: HookContext): Promise<HookRecord> {
    return this.occurrences.intent(task, hook, discovery, context);
  }

  /** Build the closed event payload for one occurrence. */
  buildEvent(task: Task, hook: NormalizedHookDefinition, eventId: string, attempt: number, context: HookContext, root = task.repoPath): AnyHookEvent {
    return this.occurrences.buildEvent(task, hook, eventId, attempt, context, root);
  }

  /** Execute one bound hook under the per-event section, minting its durable intent first. */
  runHook(task: Task, hook: NormalizedHookDefinition, discovery: ManifestDiscovery, context: HookContext): Promise<HookEmissionResult> {
    return this.execution.runHook(task, hook, discovery, context);
  }

  heldAutomaticReplay(task: Task): HeldAutomaticReplay | null {
    return this.hookReplay.heldAutomaticReplay(task);
  }

  automaticReplayAvailable(task: Task): boolean {
    return this.hookReplay.automaticReplayAvailable(task);
  }

  automaticReplayAttemptDue(task: Task): Promise<boolean> {
    return this.hookReplay.automaticReplayAttemptDue(task);
  }

  private automaticReplay(task: Task, hook: NormalizedHookDefinition, discovery: ManifestDiscovery, baseCommit: string, context: HookContext): Promise<AutomaticReplayAttempt> {
    return this.hookReplay.automaticReplay(task, hook, discovery, baseCommit, context);
  }

  private rollRepairedCloseoutOccurrence(task: Task, record: HookRecord, operator = false): Promise<HookEmissionResult | null> {
    return this.hookReplay.rollRepairedCloseoutOccurrence(task, record, operator);
  }

  private rollRepairedCancellationOccurrence(task: Task, record: HookRecord, baseCommit: string, hook: NormalizedHookDefinition, discovery: ManifestDiscovery, context: HookContext): Promise<HookEmissionResult | null> {
    return this.hookReplay.rollRepairedCancellationOccurrence(task, record, baseCommit, hook, discovery, context);
  }

  private rollRepairedBlockedOccurrence(task: Task, record: HookRecord, baseCommit: string): Promise<HookEmissionResult | null> {
    return this.hookReplay.rollRepairedBlockedOccurrence(task, record, baseCommit);
  }

  /** Emit one lifecycle event to every bound hook, reconciling open records first. `accept` narrows the delivery to selected hooks. */
  async emit(event: HookEventName, task: Task, context: HookContext, accept?: (hook: NormalizedHookDefinition) => boolean): Promise<HookEmissionResult> {
    if (!repositoryIsGitCheckout(task.repoPath)) return { hold: false, attention: false, records: [] };
    const baseCommit = context.baseCommit ?? await gitText(task.repoPath, "rev-parse", `refs/heads/${task.baseBranch}`);
    const bound = await this.boundHooks(task, event, baseCommit);
    if (!bound) return { hold: false, attention: false, records: [] };
    const selected = accept ? bound.hooks.filter(accept) : bound.hooks;
    const results: HookRecord[] = [];
    let hold = false, attention = false;
    for (const hook of selected) {
      const settled = this.store.hookEvents(task.id).findLast(record => record.hookId === hook.id && record.event === event
        && record.baseCommit === baseCommit && (record.workspace?.path ?? null) === (context.worktree ?? null));
      if (settled && this.store.task(task.id).resolution.ownerSettlements.some(item => item.effect === `hook.${settled.eventId}`)) {
        results.push(settled);
        continue;
      }
      const held = this.store.hookEvents(task.id).findLast(record => record.hookId === hook.id && record.event === event && record.checkoutDiscard && record.state !== "failed");
      if (held) { results.push(held); hold = true; attention = true; break; }
      const blockedCloseout = event === "task.closeout"
        ? this.store.hookEvents(task.id).findLast(record => record.hookId === hook.id && record.event === event && record.state === "blocked")
        : undefined;
      const blockedCancellation = event === "task.cancelled"
        ? this.store.hookEvents(task.id).findLast(record => record.hookId === hook.id && record.event === event && record.state === "blocked")
        : undefined;
      const blockedWorker = event === "task.blocked"
        ? this.store.hookEvents(task.id).findLast(record => record.hookId === hook.id && record.event === event && record.state === "blocked")
        : undefined;
      // A normal lifecycle pass follows a parked restart after main has been
      // repaired. Renew the immutable pre-publication occurrence here instead
      // of requiring a second owner retry_effect.
      const automatic = await this.automaticReplay(task, hook, bound.discovery, baseCommit, context);
      const renewed = automatic.status === "not-applicable"
        ? blockedCloseout
          ? await this.rollRepairedCloseoutOccurrence(task, blockedCloseout)
          : blockedCancellation
            ? await this.rollRepairedCancellationOccurrence(task, blockedCancellation, baseCommit, hook, bound.discovery, { ...context, baseCommit })
            : blockedWorker
              ? await this.rollRepairedBlockedOccurrence(task, blockedWorker, baseCommit)
            : null
        : null;
      const outcome = automatic.status === "applied" ? automatic.outcome : renewed ?? await this.runHook(task, hook, bound.discovery, { ...context, baseCommit });
      results.push(...outcome.records);
      hold ||= outcome.hold;
      attention ||= outcome.attention;
      if (outcome.hold) break;
    }
    return { hold, attention, records: results };
  }

  /** Resume every non-terminal record for unresolved task work after a restart. */
  async reconcileTask(task: Task): Promise<HookEmissionResult> {
    const records = this.store.hookEvents(task.id).filter(record => !["result", "published", "blocked", "failed"].includes(record.state)
      && !task.resolution.ownerSettlements.some(item => item.effect === `hook.${record.eventId}`));
    const results: HookRecord[] = [];
    let hold = false, attention = false;
    for (const record of records) {
      let next = await this.reconcile(record);
      if (next.state === "intent") {
        // A manifest read failure is a fact of its own: it never reads as a
        // stale pin or an unbound hook, which are separate proofs.
        let discovery: ManifestDiscovery | null = null;
        let discoveryError: string | null = null;
        try { discovery = await discoverManifest(task.repoPath, next.baseCommit); }
        catch (error) { discoveryError = error instanceof Error ? error.message : String(error); }
        const hook = discovery?.manifest.hooks.find(candidate => candidate.id === next.hookId);
        if (discoveryError !== null) {
          next = this.occurrences.uncertain(next, `Hook manifest could not be read at ${next.baseCommit}: ${discoveryError}`);
        } else if (!discovery || discovery.pin.digest !== next.manifest.digest || !hook) {
          next = this.occurrences.uncertain(next, "Hook manifest is stale or the hook is no longer bound; bounded reconciliation required");
        } else if (next.retentionReconciliation) {
          // A reconciliation occurrence carries its own integration-base
          // pins and must run itself: the ordinary search would resume the
          // older refused occurrence it reconciles whenever both answer for
          // the same target.
          const outcome = await this.execution.runRecordedHook(task, hook, next);
          results.push(...outcome.records);
          hold ||= outcome.hold;
          attention ||= outcome.attention;
          continue;
        } else {
          const outcome = await this.runHook(task, hook, discovery, { event: next.event, baseCommit: next.baseCommit, baseBranch: next.baseBranch, summary: task.reason, worktree: next.workspace?.path });
          results.push(...outcome.records);
          // A finished-task runtime stop is advisory: its uncertainty is a
          // warning on the terminal task, never a hold on any transition.
          const advisoryFinished = next.event === "task.finished";
          hold ||= !advisoryFinished && outcome.hold;
          attention ||= !advisoryFinished && outcome.attention;
          continue;
        }
      }
      results.push(next);
      const advisoryFinished = next.event === "task.finished";
      hold ||= !advisoryFinished && (next.state === "blocked" || next.state === "uncertain" || (next.state === "failed" && next.delivery === "required") || !["result", "published", "blocked", "uncertain", "failed", "intent"].includes(next.state));
      attention ||= !advisoryFinished && (next.state === "uncertain" || next.state === "blocked" || (next.state === "failed" && next.delivery === "required") || !["result", "published", "blocked", "uncertain", "failed", "intent"].includes(next.state));
    }
    return { hold, attention, records: results };
  }

  /**
   * Retry one reconciled hook event, then settle the retention-gate consequence: a
   * successful `task.pre_archive` retry means the retained workspace is ready for the
   * archive, so the automatic archive backoff (commit 01f949e0) the refusal left is
   * cleared before the next cleanup pass instead of fencing an operator retry for up
   * to an hour.
   */
  async retry(task: Task, hookEventId: string, discardUnpublishedCheckout = false, cleanupOnly = false): Promise<HookEmissionResult> {
    const outcome = await this.retryRunner.retryOccurrence(task, hookEventId, discardUnpublishedCheckout, cleanupOnly);
    const record = this.store.hookEvent(hookEventId) ?? this.store.hookEvents(task.id).find(candidate => candidate.eventId === hookEventId) ?? null;
    if (record?.event === "task.pre_archive" && !outcome.hold)
      this.options.retentionGateSettled?.(task.id, record.workspace?.path ?? null);
    return outcome;
  }
}
