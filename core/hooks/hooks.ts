import { ProjectValidationRunner } from "../qa/project-validation";
import { HookReplay, READ_ONLY_BASE_ADVANCED_KIND, STALE_INTEGRATION_BASE_PROOF, isStaleIntegrationBaseRefusal } from "./hook-replay";
export { READ_ONLY_BASE_ADVANCED_KIND, STALE_INTEGRATION_BASE_PROOF, isStaleIntegrationBaseRefusal } from "./hook-replay";
import type { RepositoryHooksOptions, ProjectValidationOutcome, HeldAutomaticReplay, AutomaticReplayAttempt } from "./hook-context";
import { ProspectiveMerge } from "../merge/prospective-merge";
import { executablePath, hookHoldReason, type HookEmissionResult, type HookContext, type ProspectiveMergeRequest, type ProspectiveMergeOutcome } from "./hook-context";
export { hookHoldReason, type HookEmissionResult, type HookContext, type ProspectiveMergeOutcome } from "./hook-context";
import { WARM_CANDIDATE_NAME, isolationDataDirFor, isolationPathFor, isOwnedIsolationPath } from "./hook-isolation";
export { isolationDataDirFor, isolationRootFor, isolationPathFor, warmCandidatePathFor, isOwnedIsolationPath } from "./hook-isolation";
import { blobDigest, repositoryIsGitCheckout, pinInstruction, instructionForCommit, discoverManifest, pinExecutable, pinProgram, type ManifestDiscovery } from "./hook-manifest";
export { blobDigest, repositoryIsGitCheckout, pinInstruction, instructionForCommit, parseManifestBytes, forgetManifestDiscovery, discoverManifest, pinExecutable } from "./hook-manifest";
import { executeHookProgram, type ExecutionOutcome, type ExecutionRequest } from "../machine/process-exec";
export { executeHookProgram, type ExecutionOutcome, type ExecutionRequest } from "../machine/process-exec";
import { gitText, snapshotGit, statusEntries, ignoredPathCollides, inspectChangedPaths, repositoryIsCleanAt, isolatedRepositoryIsCleanAt, verifyReviewedHead, verifyRetainedWorktree, verifyMergeCandidate, type GitSnapshot } from "../git/git-snapshot";
export { SCRATCH_INDEX_PREFIX, parsePorcelain, statusEntries, ignoredPathCollides, snapshotGit, inspectChangedPaths, verifyReviewedHead } from "../git/git-snapshot";
import { withIntegrationCheckout } from "../git/index";
import { gitNulEach } from "../git/git-command";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EVENT_SCHEMA, EVENT_SCHEMA_V2, EVENT_SCHEMA_V3, EVENT_SCHEMA_V4, RESULT_SCHEMA, hookEventSchema, hookEventV2Schema, hookEventV3Schema, hookEventV4Schema, anyHookEventSchema, hookHoldsTransition, supersededRetentionReconciliation, hookRecordSchema, hookResultSchema, joinCommitSubject, normalizeControlManifest, normalizeRepoRelativePath, pathIsAllowed, manifestSupportsCloseoutSelection, type ControlManifest, type NormalizedControlManifest, type AnyHookTarget, type MergeCandidate, type NormalizedHookDefinition, type AnyHookEvent, type HookEventName, type HookRecord, type HookResult } from "../../shared/hooks";
import { type ProjectCloseout, type ProjectValidation, type Submission, type Task } from "../../shared/contracts";
import { Store, digest, now } from "../store/store";
import { repositoryOrigin } from "../planning/lanes";
import { requestDisposition } from "../verbs/disposition";
import { requestServiceRollAfterRepositorySync } from "../forge/roll-request";
import { HostRunScheduler } from "../host-runs/host-run-scheduler";
import { processGroupEmpty } from "../machine/process-group";
import { pidAlive } from "../machine/process-identity";

/** Task-history kind recorded when a proven pre-commit uncertainty returns to retryable intent. */
const PRE_COMMIT_RECOVERED_KIND = "hook_pre_commit_recovered";
const READ_ONLY_RECOVERED_KIND = "hook_read_only_recovered";
/** Task-history kind recorded when a bound `task.finished` hook is skipped because the retained worktree is gone. */
export const FINISHED_WORKTREE_MISSING_KIND = "finished_hook_worktree_missing";
/** Task-history kind recorded when a bound `task.finished` hook could not be evaluated at all. */
const FINISHED_HOOK_WARNING_KIND = "finished_hook_warning";
/** Task-history kind recorded when the durable `task.finished` intent is cleared after evaluation. */
const FINISHED_HOOK_SETTLED_KIND = "finished_hook_settled";

/** Bound for a stored stderr excerpt, comfortably inside the record summary limit. */
export const STDERR_EXCERPT_MAX_BYTES = 2000;

/** v4 reconciliation payload identity: a merged done task's gate re-run pinned at the integration base. */
const RETENTION_RECONCILIATION_TARGET = "merged_integration_base" as const;
const RETENTION_RECONCILIATION_ROUTE = "merged_task_reconciliation" as const;

export { gitRaw } from "../git/git-command";
import { gitRaw, formatGitError } from "../git/git-command";
/** The target a stored occurrence actually carries, tolerating records that only named it in the immutable payload. */
function hookRecordTarget(record: Pick<HookRecord, "target" | "eventPayload">): AnyHookTarget {
  if (record.eventPayload?.schema === EVENT_SCHEMA_V2) return "reviewed_head";
  if (record.eventPayload?.schema === EVENT_SCHEMA_V3) return "prospective_merge";
  return record.target;
}

export function minimalHookEnvironment(eventId: string, schema: string = EVENT_SCHEMA): Record<string, string> {
  // USER is identity metadata needed by host credential discovery, not an
  // arbitrary caller override. Derive it from the launch process's OS identity.
  const username = userInfo().username;
  if (!username) throw new Error("Hook launch user identity is unavailable");
  const env: Record<string, string> = { USER: username, PASEO_QUEUE_EVENT_ID: eventId, PASEO_QUEUE_EVENT_SCHEMA: schema };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const) { const value = process.env[key]; if (value) env[key] = value; }
  return env;
}

interface ParsedHookResult { result: HookResult }
/** Parse the closed hook result envelope. Any extra stdout bytes are a failure. */
export function parseHookResult(stdout: Buffer, expectedEventId: string): ParsedHookResult | { error: string } {
  const text = stdout.toString("utf8");
  const trimmed = text.trim();
  if (!trimmed) return { error: "Hook produced no result on stdout" };
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return { error: "Hook result is not valid JSON or contains extra bytes" }; }
  const candidate = hookResultSchema.safeParse(parsed);
  if (!candidate.success) return { error: `Hook result is invalid: ${candidate.error.issues.map(issue => issue.message).join("; ")}` };
  if (candidate.data.schema !== RESULT_SCHEMA) return { error: "Hook result schema is unsupported" };
  if (candidate.data.eventId !== expectedEventId) return { error: "Hook result event ID does not match the dispatched event" };
  return { result: candidate.data };
}

/** True when a hold reason was produced by {@link hookHoldReason}. */
export function isHookHoldReason(reason: string): boolean {
  return reason.startsWith("Repository hook ") && reason.includes(" holds this transition: ");
}

/** True when a successful retry has cleared the pre-dispatch hook hold recorded on a task. */
export function isRecoveredPreDispatchHookHold(task: Pick<Task, "phase" | "reason">, result: HookEmissionResult): boolean {
  return task.phase === "needs_attention"
    && isHookHoldReason(task.reason)
    && !result.hold
    && result.records.some(record => record.event === "task.pre_dispatch" && ["result", "published"].includes(record.state));
}

/** True when a task is visibly held by a repository closeout hook rather than a coordinator issue. */
export function isCloseoutHookHold(task: Pick<Task, "phase" | "reason">): boolean {
  return task.phase === "closing" && isHookHoldReason(task.reason);
}

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
 */
/** Attempts a timed-out read-only pre-archive occurrence gets in all before its hold stands (Tom, 2026-10-19). */
export const RETENTION_TIMEOUT_ATTEMPTS = 3;

export class RepositoryHooks {
  private readonly hookReplay = new HookReplay({
    store: this.store,
    save: (record, changes) => this.save(record, changes),
    matchingCommits: (task, record) => this.matchingCommits(task, record),
    isolationPath: (task, eventId) => this.isolationPath(task, eventId),
    verifyCleanSynchronizedBase: (root, baseBranch, baseCommit) => this.verifyCleanSynchronizedBase(root, baseBranch, baseCommit),
    remoteCarries: (task, record) => this.remoteCarries(task, record),
    remoteCarriesCommit: (task, record, commit) => this.remoteCarriesCommit(task, record, commit),
    removeIsolatedCheckout: (task, path, force) => this.removeIsolatedCheckout(task, path, force),
    runHook: (task, hook, discovery, context) => this.runHook(task, hook, discovery, context),
    emit: (event, task, context, accept) => this.emit(event, task, context, accept),
  });

  private queueBuild(): string { return this.projectValidation.queueBuild(); }

  private readonly projectValidation = new ProjectValidationRunner({
    store: this.store,
    options: this.options,
    hostRunScheduler: () => this.hostRunScheduler,
    isolationDataDir: () => this.isolationDataDir(),
    integrationBase: (task) => this.integrationBase(task),
    prospectiveCandidatePath: (task, candidate) => this.prospectiveCandidatePath(task, candidate),
    buildProspectiveCandidate: (task, path, base, head, warm) => this.buildProspectiveCandidate(task, path, base, head, warm),
    removeIsolatedCheckout: (task, path, force) => this.removeIsolatedCheckout(task, path, force),
  });

  constructor(readonly store: Store, readonly options: RepositoryHooksOptions = {}) {}
  private readonly prospectiveMerge = new ProspectiveMerge({
    store: this.store,
    isolationDataDir: () => this.isolationDataDir(),
    gitCommonDir: task => this.gitCommonDir(task),
    integrationBase: task => this.integrationBase(task),
    removeIsolatedCheckout: (task, path, force) => this.removeIsolatedCheckout(task, path, force),
    save: (record, changes) => this.save(record, changes),
    emit: (event, task, context, accept) => this.emit(event, task, context, accept),
  });

  /** Dispose the former repository-local warm clones once; no event checkout is replayed or removed. */
  async disposeLegacyWarmCheckouts(): Promise<void> {
    if (this.store.getMeta<boolean>("legacyWarmCheckoutsDisposed")) return;
    const tasks = this.store.tasks();
    const repositories = new Map(tasks.map(task => [task.repoPath, { repoPath: task.repoPath }]));
    for (const repository of this.store.repositories()) {
      if (repository.repository.path) repositories.set(repository.repository.path, { repoPath: repository.repository.path });
    }
    for (const project of this.store.projects()) for (const repository of project.repositories) {
      if (repository.path) repositories.set(repository.path, { repoPath: repository.path });
    }
    for (const task of repositories.values()) {
      const common = await this.gitCommonDir(task);
      const path = join(common, "queue-hooks", WARM_CANDIDATE_NAME);
      try { await lstat(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const unresolved = this.store.db.prepare(`SELECT id FROM hook_events
        WHERE json_extract(data,'$.workspace.path')=?
          AND json_extract(data,'$.state') NOT IN ('result','published','failed','blocked') LIMIT 1`).get(path);
      if (unresolved)
        throw new Error(`Legacy warm checkout still has an unresolved occurrence: ${path}`);
      await this.proveWarmOwnership(task, path, common);
      await rm(path, { recursive: true });
    }
    this.store.setMeta("legacyWarmCheckoutsDisposed", true);
  }

  private get hostRunScheduler(): HostRunScheduler { return this.options.hostRuns ?? HostRunScheduler.forStore(this.store); }
  /** Queue scheduler liveness for client runs submitted from a worker worktree. */
  liveClientHostRunAt(directory: string | null | undefined) { return this.hostRunScheduler.liveClientRunAt(directory); }

  private run(request: ExecutionRequest) { return (this.options.run ?? executeHookProgram)(request); }
  private snapshot(root: string) { return (this.options.snapshot ?? snapshotGit)(root); }
  /** Queue data directory that owns new isolated checkouts. Never the live `~/.paseo` in tests. */
  private isolationDataDir(): string {
    const dir = this.options.dataDir ?? isolationDataDirFor(this.store);
    try { return realpathSync(dir); } catch { return resolve(dir); }
  }
  private async gitCommonDir(task: Pick<Task, "repoPath">): Promise<string> {
    return gitText(task.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
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

  private async programExecutable(record: HookRecord, root: string): Promise<string> {
    if (record.program.kind === "repository") return executablePath(root, record.program.executable);
    if (record.program.kind === "tool") return record.program.path;
    if (record.program.kind === "unavailable_tool") throw new Error(record.program.error);
    throw new Error("Historical trusted runner occurrence cannot execute after retirement");
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
    return this.emissionSettled(taskId, "task.closeout");
  }

  cancellationEmissionSettled(taskId: string): boolean {
    return this.emissionSettled(taskId, "task.cancelled");
  }

  /**
   * The consumer-owned pre-archive retention gate. Before Queue archives a
   * retained task worktree for any reason, every required read-only
   * `task.pre_archive` hook bound in the repository's pinned manifest may refuse
   * with its own evidence. The worktree is preserved until the hook settles:
   * refusal, failure, timeout and uncertainty all hold. A repository with no
   * bound hook returns an empty, non-holding result and archives as before.
   */
  async retentionGate(task: Task, target: { directory: string; head: string; reason: string }): Promise<HookEmissionResult> {
    await this.rerunTimedOutRetention(task, target.directory);
    // A settled merged-task reconciliation answers for the same retained
    // worktree and head without re-running the stale worktree-head gate: a
    // success satisfies the gate, a refusal stays a hold with its evidence.
    // Any other change (moved head, different workspace) re-gates normally.
    const reconciled = this.settledRetentionReconciliation(task, target);
    if (reconciled) return reconciled;
    return this.emit("task.pre_archive", task, {
      event: "task.pre_archive", baseCommit: target.head, baseBranch: task.baseBranch,
      summary: target.reason, worktree: target.directory,
    });
  }

  /**
   * A read-only pre-archive occurrence for this worktree whose last attempt only
   * timed out (it neither refused nor failed) runs again on the next cleanup
   * pass, up to RETENTION_TIMEOUT_ATTEMPTS attempts in all; a refusal, a
   * failure or the bound keeps the hold (Tom, 2026-10-19: host load held Project-a
   * #3686 behind one 60s timeout). Read-only hooks have no external effect, so
   * a rerun replays nothing. Only a timeout whose process group was proven gone
   * qualifies, so a rerun never overlaps a surviving execution, and a superseded
   * reconciliation is history, never rerun (review #552).
   */
  private async rerunTimedOutRetention(task: Task, directory: string): Promise<void> {
    const due = () => {
      const all = this.store.hookEvents(task.id);
      const latestByHook = new Map<string, HookRecord>();
      for (const record of all) if (record.event === "task.pre_archive" && (record.workspace?.path ?? null) === directory) latestByHook.set(record.hookId, record);
      return [...latestByHook.values()].filter(record => record.mode === "read_only" && record.state === "blocked"
        && record.timedOut === true && record.processGroupEmpty === true && !record.terminationError
        && record.attempt < RETENTION_TIMEOUT_ATTEMPTS && !supersededRetentionReconciliation(all, record));
    };
    const seen = new Map(due().map(record => [record.id, record.attempt]));
    if (!seen.size) return;
    // Concurrent cleanup callers select before either runs; the second sees the
    // attempt the first already ran and leaves it to the next pass.
    await this.withHookEventLock(`retention-timeout-rerun\u0000${task.id}\u0000${directory}`, async () => {
      for (const record of due()) {
        if (seen.get(record.id) !== record.attempt) continue;
        // The flag describes the latest attempt only: anything but a fresh
        // timeout below leaves it cleared, so a later failure stays held.
        this.save(record, { timedOut: false });
        this.store.event(task.id, "retention_timeout_rerun", `${record.hookId} ${record.eventId}: attempt ${record.attempt} timed out; running attempt ${record.attempt + 1}`);
        await this.retry(task, record.eventId, false, false).catch(error => {
          this.store.event(task.id, "retention_timeout_rerun_failed", `${record.hookId} ${record.eventId}: ${String(error).slice(0, 500)}`);
        });
      }
    });
  }

  /**
   * A settled merged-task reconciliation occurrence for the same retained
   * worktree and exact head satisfies the retention gate. Only a merged done
   * task whose recorded worktree, path and head still match the reconciled
   * identity qualifies; everything else re-gates through the ordinary
   * worktree-head emission. Returns null when no reconciliation answers.
   */
  private settledRetentionReconciliation(task: Task, target: { directory: string; head: string }): HookEmissionResult | null {
    if (task.phase !== "done" || !task.resolution.mergedCommit || !task.directory || !task.prHead) return null;
    if (target.directory !== task.directory || target.head !== task.prHead) return null;
    // A reconciliation the occurrence it reconciled has since overtaken (that
    // occurrence later settled ok) no longer answers: the ordinary gate runs
    // every required hook again, so one hook's pass never bypasses another
    // (Project-a #3686; review #550).
    const all = this.store.hookEvents(task.id);
    const reconciliations = all.filter(record => record.event === "task.pre_archive"
      && record.workspace?.path === target.directory
      && record.retentionReconciliation?.taskHead === target.head
      && !supersededRetentionReconciliation(all, record));
    if (!reconciliations.length) return null;
    const latest = reconciliations[reconciliations.length - 1];
    if (task.resolution.ownerSettlements.some(item => item.effect === `hook.${latest.eventId}` || item.effect === `merged_task_retention.${latest.eventId}`))
      return { hold: false, attention: false, records: [latest] };
    if (latest.state === "result" && latest.result?.outcome === "ok") return { hold: false, attention: false, records: [latest] };
    if (hookHoldsTransition(latest)) return { hold: true, attention: true, records: [latest] };
    return null;
  }

  /**
   * Explicit operator reconciliation of a merged done task's refused
   * pre-archive retention gate at the current integration base (Spec 047).
   *
   * The ordinary gate pins the manifest and program at the retained worktree
   * head, so a correction merged to main never reaches a refused occurrence
   * and `retry_effect` re-runs the same stale bytes. This control mints one new
   * occurrence with the manifest and repository program pinned at the current
   * `refs/heads/<baseBranch>` commit and runs it read-only in the retained
   * worktree. It is never invoked automatically, and ordinary pre-archive
   * emission keeps the worktree-head pin and the frozen v1 payload.
   *
   * Before any effect the control refuses unless the task is done and merged
   * with no merge intent pending, the latest pre-archive occurrence for the
   * retained workspace is a settled refusal or hold, the retained worktree
   * exists at exactly the recorded prHead and is clean, the merged commit is
   * an ancestor of the current integration base, and the manifest at that
   * base still binds the same hook id for `task.pre_archive`.
   */
  async retryRetentionAtIntegrationBase(task: Task, reason: string): Promise<HookEmissionResult> {
    const current = this.store.task(task.id);
    if (!reason?.trim()) throw new Error("Retention reconciliation requires an operator reason");
    if (current.phase !== "done") throw new Error("Retention reconciliation requires a done task");
    const mergedCommit = current.resolution.mergedCommit;
    // A merge intent with no merged commit is an unlanded merge and is refused;
    // a settled intent (`mergedCommit` set) is the real done shape and passes.
    if (current.resolution.mergeIntent && !mergedCommit) throw new Error("Retention reconciliation refuses a pending merge intent");
    if (!mergedCommit) throw new Error("Retention reconciliation requires a merged task");
    const worktree = current.directory;
    const taskHead = current.prHead;
    if (!worktree || !taskHead) throw new Error("Retention reconciliation requires the retained worktree and its recorded head");
    const candidates = this.store.hookEvents(current.id).filter(record => record.event === "task.pre_archive"
      && (record.workspace?.path ?? null) === worktree);
    const prior = candidates.at(-1) ?? null;
    if (!prior) throw new Error("Retention reconciliation requires a recorded task.pre_archive refusal for the retained workspace");
    if (!hookHoldsTransition(prior)) throw new Error("Retention reconciliation requires the latest task.pre_archive occurrence for the retained workspace to be a settled refusal or hold");
    if (!prior.eventPayload) throw new Error("Retention reconciliation requires the refused occurrence's immutable delivery payload");
    const worktreeInfo = await lstat(worktree).catch(() => null);
    if (!worktreeInfo || !worktreeInfo.isDirectory() || worktreeInfo.isSymbolicLink()) throw new Error("Retention reconciliation requires the retained task worktree");
    let worktreeHead: string;
    try { worktreeHead = await gitText(worktree, "rev-parse", "HEAD"); }
    catch { throw new Error("Retention reconciliation cannot read the retained worktree HEAD"); }
    if (worktreeHead !== taskHead) throw new Error(`Retention reconciliation requires the recorded worktree head: worktree HEAD ${worktreeHead} differs from prHead ${taskHead}`);
    if ((await statusEntries(worktree, false)).length) throw new Error("Retention reconciliation requires a clean retained worktree");
    let baseCommit: string;
    try { baseCommit = await gitText(current.repoPath, "rev-parse", `refs/heads/${current.baseBranch}`); }
    catch { throw new Error(`Retention reconciliation cannot read the current refs/heads/${current.baseBranch} commit`); }
    if ((await gitRaw(current.repoPath, ["merge-base", "--is-ancestor", mergedCommit, baseCommit])).code !== 0)
      throw new Error("Retention reconciliation requires the merged commit to be an ancestor of the current integration base");
    // A failed integration-base reconciliation is history, not the original
    // retained declaration's identity. Keep the immutable task-head occurrence
    // as the consumer's predecessor on every later explicit retry.
    const predecessor = candidates.findLast(record => record.hookId === prior.hookId
      && !record.retentionReconciliation && record.baseCommit === taskHead
      && record.workspace?.head === taskHead && record.eventPayload
      && hookHoldsTransition(record));
    if (!predecessor?.eventPayload)
      throw new Error("Retention reconciliation requires the original refused task-head occurrence and its immutable payload");
    const discovery = await discoverManifest(current.repoPath, baseCommit).catch(() => null);
    const hook = discovery?.manifest.hooks.find(candidate => candidate.id === prior.hookId && candidate.events.includes("task.pre_archive"));
    if (!discovery || !hook) throw new Error(`Retention reconciliation requires the hook ${prior.hookId} to stay bound for task.pre_archive at the current integration base`);
    if (hook.mode !== "read_only" || hook.delivery !== "required") throw new Error("Retention reconciliation requires the replacement hook to keep the required read-only gate");
    const existing = this.store.hookEvents(current.id).filter(record => record.hookId === hook.id && record.event === "task.pre_archive");
    const occurrence = existing.length + 1;
    const eventId = digest(`${current.id}\n${hook.id}\ntask.pre_archive\n${occurrence}`).slice(0, 48);
    if (existing.some(record => record.eventId === eventId)) throw new Error("Retention reconciliation refuses a duplicate occurrence identity");
    const program = await pinProgram(current.repoPath, discovery.pin.commit, hook.program);
    const event = hookEventV4Schema.parse({
      schema: EVENT_SCHEMA_V4, eventId, hookId: hook.id, event: "task.pre_archive",
      occurredAt: now(), attempt: 1,
      repository: {
        root: worktree, baseBranch: current.baseBranch, baseCommit, target: RETENTION_RECONCILIATION_TARGET,
        retention: {
          route: RETENTION_RECONCILIATION_ROUTE, mergedCommit, taskHead,
          manifestDigest: discovery.pin.digest,
          prior: { eventId: predecessor.eventId, baseCommit: predecessor.baseCommit, manifestDigest: predecessor.manifest.digest },
        },
      },
      task: { id: current.id, title: current.title, phase: "done", instruction: current.instruction ?? null },
      delivery: { ...prior.eventPayload.delivery },
    });
    const record = hookRecordSchema.parse({
      id: randomUUID(), taskId: current.id, hookId: hook.id, event: "task.pre_archive", eventId, occurrence,
      mode: "read_only", delivery: "required", state: program.kind === "unavailable_tool" ? "blocked" : "intent",
      manifest: discovery.pin, executable: program.kind === "repository" ? program.executable : null, program,
      instruction: event.task.instruction,
      baseBranch: current.baseBranch, baseCommit, attempt: 0,
      argv: hook.program.argv, timeoutMs: hook.timeoutMs, maxOutputBytes: hook.maxOutputBytes,
      allowedPaths: hook.allowedPaths, commitSubject: hook.commitSubject,
      eventDigest: digest(JSON.stringify(event)), eventPayload: event,
      target: hook.target, mergeCandidate: null,
      workspace: { path: worktree, head: taskHead },
      retentionReconciliation: { priorEventId: predecessor.eventId, priorBaseCommit: predecessor.baseCommit,
        priorManifestDigest: predecessor.manifest.digest, taskHead, mergedCommit },
      result: null, commit: null, remote: null,
      summary: program.kind === "unavailable_tool" ? program.error : "", error: program.kind === "unavailable_tool" ? program.error : "", createdAt: now(), updatedAt: now(), reconciledAt: null,
    });
    this.store.putHookEvent(record);
    this.store.event(current.id, "hook_intent", `${hook.id} task.pre_archive ${eventId}: merged-task reconciliation at ${baseCommit}: ${reason.slice(0, 300)}`);
    // The fresh occurrence runs directly: the ordinary open-record search
    // would resume the refused occurrence it reconciles (blocked counts as
    // open) whenever the integration base still equals the refused pin,
    // returning the stale refusal and orphaning this intent.
    return this.runRecordedHook(current, hook, record);
  }

  /**
   * The retention gate as a disposition step consumes it: resolve the retained
   * workspace head, emit `task.pre_archive`, and report a hold with its
   * evidence. A repository with no bound hook reports no hold, so disposition
   * archives exactly as before.
   */
  async preArchive(task: Task): Promise<{ hold: boolean; detail: string }> {
    if (!task.directory || !task.workspaceId) return { hold: false, detail: "" };
    let head: string;
    try { head = await gitText(task.directory, "rev-parse", "HEAD"); }
    catch (error) { return { hold: true, detail: `Cannot prove the retained workspace head for pre-archive: ${String(error)}` }; }
    const outcome = await this.retentionGate(task, { directory: task.directory, head, reason: "Disposition archive of the task workspace" });
    return outcome.hold ? { hold: true, detail: hookHoldReason(outcome) } : { hold: false, detail: "" };
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

  private emissionSettled(taskId: string, event: HookEventName): boolean {
    const records = this.store.hookEvents(taskId).filter(record => record.event === event);
    if (!records.length) return false;
    const latest = new Map<string, HookRecord>();
    for (const record of records) {
      const current = latest.get(record.hookId);
      if (!current || record.occurrence > current.occurrence) latest.set(record.hookId, record);
    }
    return [...latest.values()].every(record => ["result", "published"].includes(record.state) || record.state === "failed" && record.delivery === "advisory");
  }

  async boundHooks(task: Task, event: HookEventName, baseCommit: string): Promise<{ discovery: ManifestDiscovery; hooks: NormalizedHookDefinition[] } | null> {
    if (!repositoryIsGitCheckout(task.repoPath)) return null;
    const discovery = await discoverManifest(task.repoPath, baseCommit);
    if (!discovery) return null;
    return { discovery, hooks: discovery.manifest.hooks.filter(hook => hook.events.includes(event)) };
  }

  /** Build the closed event payload. Event content is data; it never reaches argv or the shell. */
  buildEvent(task: Task, hook: NormalizedHookDefinition, eventId: string, attempt: number, context: HookContext, root = task.repoPath): AnyHookEvent {
    const delivery = context.delivery ?? {};
    if (!context.baseCommit) throw new Error("Hook event requires a base commit");
    const shared = {
      eventId, hookId: hook.id, event: context.event, occurredAt: now(), attempt,
      repository: { root, baseBranch: task.baseBranch, baseCommit: context.baseCommit },
      task: { id: task.id, title: task.title, phase: task.phase, instruction: context.instruction === undefined ? task.instruction ?? null : context.instruction },
      delivery: {
        prUrl: delivery.prUrl ?? null, prNumber: delivery.prNumber ?? null, head: delivery.head ?? null,
        review: delivery.review ?? null, mergeCommit: delivery.mergeCommit ?? null,
        integrationCommit: delivery.integrationCommit ?? null, summary: (delivery.summary ?? context.summary ?? "").slice(0, 4000),
      },
    };
    // Integration-base events keep the frozen v1 payload; a reviewed-head
    // occurrence emits the additive v2 payload with `repository.target`; a
    // prospective-merge occurrence emits v3 with its pinned candidate identity.
    if (hook.target === "reviewed_head") return hookEventV2Schema.parse({ schema: EVENT_SCHEMA_V2, ...shared, repository: { ...shared.repository, target: "reviewed_head" } });
    if (hook.target === "prospective_merge") {
      const candidate = context.candidate;
      if (!candidate) throw new Error("A prospective-merge event requires the pinned candidate identity");
      if (candidate.integrationBase !== context.baseCommit) throw new Error("A prospective-merge candidate must be built from the pinned integration base");
      const { path: _path, ...identity } = candidate;
      return hookEventV3Schema.parse({ schema: EVENT_SCHEMA_V3, ...shared, repository: { ...shared.repository, target: "prospective_merge", mergeCandidate: identity } });
    }
    return hookEventSchema.parse({ schema: EVENT_SCHEMA, ...shared });
  }

  private eventKey(hookId: string, event: HookEventName) { return `${hookId}:${event}`; }

  private async isolationPath(task: Task, eventId: string): Promise<string> {
    return isolationPathFor(this.isolationDataDir(), await this.gitCommonDir(task), eventId);
  }
  /** Persist durable event intent before any external effect. Reuse an open record; new ids only after a terminal one. */
  private async intent(task: Task, hook: NormalizedHookDefinition, discovery: ManifestDiscovery, context: HookContext): Promise<HookRecord> {
    const hookProgram = hook.program ?? { kind: "repository" as const, executable: (hook as unknown as { executable: string }).executable, argv: (hook as unknown as { argv: string[] }).argv };
    const existing = this.store.hookEvents(task.id).filter(record => record.hookId === hook.id && record.event === context.event);
    /**
     * True when a stored occurrence answers for the same exact pre-merge target.
     * A reviewed head is answered once per exact head; a prospective-merge
     * occurrence is answered once per exact candidate identity, so a moved
     * integration base always mints a fresh candidate instead of reusing an
     * unrelated result.
     */
    const samePreMergeTarget = (record: HookRecord): boolean => {
      if (record.manifest.digest !== discovery.pin.digest) return false;
      if (hookRecordTarget(record) !== hook.target) return false;
      if (hook.target === "prospective_merge") {
        const candidate = context.candidate;
        return Boolean(candidate)
          && record.mergeCandidate?.commit === candidate!.commit
          && record.mergeCandidate?.tree === candidate!.tree
          && record.mergeCandidate?.integrationBase === candidate!.integrationBase;
      }
      return record.baseCommit === context.baseCommit;
    };
    // Closeout happens once per task: a terminal success is reused rather than
    // re-emitted, so a restart or a successful retry keeps the same occurrence
    // identity instead of executing the repository hook a second time.
    if (context.event === "task.closeout") {
      const settled = existing.find(record => record.state === "result" || record.state === "published");
      if (settled) return settled;
    }
    // A pre-merge target owns at most one settled occurrence per manifest pin: an
    // unchanged target reuses its result, while a changed one mints a fresh
    // occurrence. A pre-archive occurrence is answered once per retained
    // worktree head, so an unchanged worktree is not gated twice while a
    // changed one mints a fresh occurrence.
    const sameRetentionTarget = (record: HookRecord): boolean =>
      record.manifest.digest === discovery.pin.digest
      && record.baseCommit === context.baseCommit
      && (record.workspace?.path ?? null) === (context.worktree ?? null);
    if (context.event === "task.pre_merge") {
      const settled = existing.find(record => record.state === "result" && samePreMergeTarget(record));
      if (settled) return settled;
    }
    if (context.event === "task.pre_archive") {
      const settled = existing.find(record => record.state === "result" && sameRetentionTarget(record));
      if (settled) return settled;
    }
    // The finished-task runtime stop is delivered at most once per task. A
    // settled result or an advisory failure is reused, so a restart or an
    // ordinary pass never runs the repository's stop a second time;
    // `retry_effect` clears the occurrence back to intent and re-runs the pinned
    // program. An uncertain attempt is re-emitted through the open-record path
    // below and never retried automatically.
    if (context.event === "task.finished") {
      const settled = existing.at(-1);
      if (settled) return settled;
    }
    // A held or uncertain event is resumed, never silently re-emitted. Only a
    // proven-success or advisory outcome may produce the next occurrence. A
    // pinned target is per occurrence: a held refusal at an older target never
    // answers for a changed one.
    const open = existing.find(record => !["result", "published", "failed"].includes(record.state)
      && (context.event !== "task.pre_merge" || samePreMergeTarget(record))
      && (context.event !== "task.pre_archive" || sameRetentionTarget(record)));
    if (open) return open;
    const occurrence = existing.length + 1;
    const eventId = digest(`${task.id}\n${hook.id}\n${context.event}\n${occurrence}`).slice(0, 48);
    const program = await pinProgram(task.repoPath, discovery.pin.commit, hookProgram);
    const executable = program.kind === "repository" ? program.executable : null;
    if (hookProgram.kind === "repository" && hook.allowedPaths.some(entry => entry.endsWith("/") ? hookProgram.executable.startsWith(entry) : entry === hookProgram.executable)) throw new Error(`allowedPaths may not name the hook executable: ${hookProgram.executable}`);
    const workspacePath = hook.mode === "integration_write" ? await this.isolationPath(task, eventId)
      : hook.target === "prospective_merge" ? context.candidate?.path ?? null
      : context.event === "task.pre_archive" ? context.worktree ?? null
      : context.event === "task.finished" ? context.worktree ?? null : null;
    // A reviewed-head gate always runs in the retained Queue task workspace so
    // it observes the worker's exact pushed head rather than the integration base.
    if (hook.target === "reviewed_head" && !task.directory) throw new Error("Reviewed-head hook requires the retained task workspace directory");
    // A prospective-merge gate runs only in the Queue-owned disposable candidate
    // checkout, never in the worker branch or the canonical integration checkout.
    if (hook.target === "prospective_merge" && !workspacePath) throw new Error("Prospective-merge hook requires the Queue-owned candidate checkout");
    // The retention gate runs in the retained task worktree it must observe
    // immediately before Queue archives it, never in the canonical checkout.
    if (context.event === "task.pre_archive" && !workspacePath) throw new Error("Pre-archive hook requires the retained task worktree path");
    // The finished-task stop runs in the retained worktree whose dev stack it
    // must stop, never in the canonical integration checkout.
    if (context.event === "task.finished" && !workspacePath) throw new Error("Finished-task hook requires the retained task worktree path");
    const executionRoot = hook.target === "reviewed_head" ? task.directory! : hook.target === "prospective_merge" ? workspacePath! : workspacePath ?? task.repoPath;
    const event = this.buildEvent(task, hook, eventId, 1, context, executionRoot);
    const record = hookRecordSchema.parse({
      id: randomUUID(), taskId: task.id, hookId: hook.id, event: context.event, eventId, occurrence,
      mode: hook.mode, delivery: hook.delivery, state: program.kind === "unavailable_tool" ? hook.delivery === "required" ? "blocked" : "failed" : "intent",
      manifest: discovery.pin, executable, program, instruction: event.task.instruction,
      baseBranch: task.baseBranch, baseCommit: context.baseCommit, attempt: 0,
      argv: hookProgram.argv, timeoutMs: hook.timeoutMs, maxOutputBytes: hook.maxOutputBytes,
      allowedPaths: hook.allowedPaths, commitSubject: hook.commitSubject,
      eventDigest: digest(JSON.stringify(event)), eventPayload: event,
      target: hook.target,
      mergeCandidate: hook.target === "prospective_merge" && context.candidate
        ? { integrationBase: context.candidate.integrationBase, reviewedHead: context.candidate.reviewedHead, commit: context.candidate.commit, tree: context.candidate.tree }
        : null,
      workspace: workspacePath ? { path: workspacePath, head: hook.target === "prospective_merge" ? context.candidate!.commit : context.baseCommit } : null,
      result: null, commit: null, remote: null,
      summary: program.kind === "unavailable_tool" ? program.error : "", error: program.kind === "unavailable_tool" ? program.error : "", createdAt: now(), updatedAt: now(), reconciledAt: null,
    });
    this.store.putHookEvent(record);
    this.store.event(task.id, program.kind === "unavailable_tool" ? `hook_${record.state}` : "hook_intent", `${hook.id} ${context.event} ${eventId}${program.kind === "unavailable_tool" ? `: ${program.error}` : ""}`);
    return record;
  }

  private save(record: HookRecord, changes: Partial<HookRecord>): HookRecord {
    const next = hookRecordSchema.parse({ ...record, ...changes, updatedAt: now() });
    this.store.putHookEvent(next);
    return next;
  }

  /** The immutable occurrence payload with only the confirmed attempt advancing and the actual execution root. */
  private deliveryEvent(record: HookRecord, root: string): AnyHookEvent {
    if (!record.eventPayload) throw new Error("Hook event payload is unavailable; reconcile the record before retrying");
    return anyHookEventSchema.parse({ ...record.eventPayload, attempt: record.attempt + 1, repository: { ...record.eventPayload.repository, root } });
  }

  /**
   * Execute or reconcile one bound hook and return its durable terminal state.
   *
   * One in-process section per logical event guarantees that concurrent callers
   * - a completed cancellation's inline stop and the lifecycle recovery scan,
   * or two lifecycle passes - cannot both reach the spawn while the shared
   * occurrence still reads `intent`. The second caller re-reads the occurrence
   * the first settled and returns it instead of executing the pinned program
   * again.
   */
  async runHook(task: Task, hook: NormalizedHookDefinition, discovery: ManifestDiscovery, context: HookContext): Promise<HookEmissionResult> {
    return this.withHookEventLock(`${task.id}\u0000${hook.id}\u0000${context.event}`, () => this.runHookOnce(task, hook, discovery, context));
  }

  /** One in-process section per logical event; a failed predecessor never blocks the next section. */
  private readonly hookEventLocks = new Map<string, Promise<unknown>>();
  private async withHookEventLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.hookEventLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = prior.then(() => gate, () => gate);
    this.hookEventLocks.set(key, tail);
    await prior.catch(() => { /* a failed predecessor never blocks the next section */ });
    try { return await work(); }
    finally {
      release();
      if (this.hookEventLocks.get(key) === tail) this.hookEventLocks.delete(key);
    }
  }

  private async runHookOnce(task: Task, hook: NormalizedHookDefinition, discovery: ManifestDiscovery, context: HookContext): Promise<HookEmissionResult> {
    const held = this.store.hookEvents(task.id).findLast(record => record.hookId === hook.id && record.event === context.event && record.checkoutDiscard && record.state !== "failed");
    if (held) return this.result(held);
    const record = await this.intent(task, hook, discovery, context);
    return this.executeRecordedHook(task, hook, record);
  }

  /**
   * Execute one already-minted occurrence under the per-event lock. Unlike
   * {@link runHook}, this bypasses the open-record search, so a reconciliation
   * occurrence always runs its own pins even when an older occurrence answers
   * for the same target: the search would otherwise resume the stale refusal
   * and leave the fresh intent orphaned.
   */
  private async runRecordedHook(task: Task, hook: NormalizedHookDefinition, record: HookRecord): Promise<HookEmissionResult> {
    return this.withHookEventLock(`${task.id}\u0000${hook.id}\u0000${record.event}`, () => this.executeRecordedHook(task, hook, record));
  }

  /** Reconcile one minted occurrence and execute its pinned program when due. */
  private async executeRecordedHook(task: Task, hook: NormalizedHookDefinition, record: HookRecord): Promise<HookEmissionResult> {
    if (this.store.task(task.id).resolution.ownerSettlements.some(item => item.effect === `hook.${record.eventId}`))
      return { hold: false, attention: false, records: [record] };
    record = await this.reconcile(record);
    if (["result", "published", "blocked", "failed"].includes(record.state)) return this.result(record);
    // `timedOut` describes the latest attempt only. Clear it before any
    // pre-spawn or baseline check, so a failure there stays held instead of
    // reading as a timeout the cleanup pass reruns (review #552).
    if (record.timedOut) record = this.save(record, { timedOut: false });
    // An uncertain finished-task stop is recorded once and never retried
    // automatically; only an explicit `retry_effect` re-runs the pinned program.
    // Every other state here is safe to execute: `intent` means no process ever
    // started for this occurrence.
    if (record.event === "task.finished" && record.state !== "intent") return this.result(record);
    if (record.event === "task.pre_merge" && hookRecordTarget(record) === "prospective_merge") {
      const ensured = await this.ensureProspectiveCandidate(task, record);
      if (!ensured.ok) return this.result(this.fail(record, ensured.detail));
      record = this.store.hookEvent(record.id) ?? record;
    }
    const root = await this.deliverRoot(task, record);
    const event = this.deliveryEvent(record, root);
    const stdout = Buffer.from(JSON.stringify(event), "utf8");
    if (record.mode === "integration_write") {
      return this.executeIntegrationWrite(task, record, stdout, root);
    }
    return this.executeReadOnly(task, record, stdout, root);
  }

  /** The execution root named by the delivered event: the retained task workspace for a reviewed head, the retained worktree for the retention gate, the Queue-owned candidate for a prospective merge, canonical for read-only, isolated for a write. */
  private async deliverRoot(task: Task, record: HookRecord): Promise<string> {
    if (record.event === "task.pre_archive") {
      if (!record.workspace?.path) throw new Error("Pre-archive hook lost its retained task worktree");
      return record.workspace.path;
    }
    if (record.event === "task.finished") {
      if (!record.workspace?.path) throw new Error("Finished-task hook lost its retained task worktree");
      return record.workspace.path;
    }
    if (record.event === "task.pre_merge") {
      if (hookRecordTarget(record) === "prospective_merge") {
        if (!record.workspace?.path) throw new Error("Prospective-merge hook lost its Queue-owned candidate checkout");
        return record.workspace.path;
      }
      if (!task.directory) throw new Error("Reviewed-head hook requires the retained task workspace directory");
      return task.directory;
    }
    if (record.mode !== "integration_write") return task.repoPath;
    return record.workspace?.path ?? await this.isolationPath(task, record.eventId);
  }

  private async executeReadOnly(task: Task, record: HookRecord, stdin: Buffer, root: string): Promise<HookEmissionResult> {
    const preMerge = record.event === "task.pre_merge";
    const prospectiveMerge = preMerge && hookRecordTarget(record) === "prospective_merge";
    const preArchive = record.event === "task.pre_archive";
    const finished = record.event === "task.finished";
    const targetDrift = async (): Promise<string | null> => {
      // The finished-task stop is advisory and runs in a retained worktree that
      // may legitimately still hold work; there is no lifecycle identity to
      // prove, and a dirty worktree is never a reason to hold or reopen.
      if (finished) return null;
      if (preArchive) {
        // A merged-task reconciliation observes the exact retained worktree
        // head at the integration-base pins, not the pinned base itself.
        try { await verifyRetainedWorktree(root, preArchiveWorktreeHead(record)); return null; }
        catch (error) { return error instanceof Error ? error.message : String(error); }
      }
      if (!preMerge) return null;
      try {
        if (prospectiveMerge) await verifyMergeCandidate(root, record.mergeCandidate);
        else await verifyReviewedHead(root, task.branch, record.baseCommit);
        return null;
      } catch (error) { return error instanceof Error ? error.message : String(error); }
    };
    const baselineDrift = await targetDrift();
    if (baselineDrift) return this.result(this.fail(record, `${preArchive ? "Retention gate" : prospectiveMerge ? "Prospective-merge candidate" : "Reviewed-head"} baseline failed: ${baselineDrift}`));
    let before: GitSnapshot;
    try { before = await this.snapshot(root); } catch (error) {
      const message = `Read-only baseline failed: ${String(error)}`;
      const retryable = this.save(record, { state: "intent", error: message, summary: message.slice(0, 4000), processId: null });
      this.store.event(record.taskId, "hook_baseline_retryable", `${record.hookId} ${record.event} ${record.eventId}: ${message.slice(0, 500)}`);
      return this.result(retryable);
    }
    record = this.save(record, { state: "running", attempt: record.attempt + 1, processId: null, processGroupId: null,
      leaderStartIdentity: null, terminationSignal: null, processGroupEmpty: null, terminationError: null });
    // A candidate must never redefine the required gate it is running: the
    // pinned program bytes are the repository policy, not lane-authored content.
    if (prospectiveMerge && record.program.kind === "repository") {
      const missing = await this.prospectiveProgramDrift(root, record);
      if (missing) return this.result(this.fail(this.store.hookEvent(record.id)!, missing));
    }
    // A reconciliation runs the repository program blob pinned at the
    // integration base, not the retained-worktree file at the refused head:
    // a gate-program repair merged to main is pinned and must be what runs.
    // The execution root stays the retained worktree, which is never written.
    let materialized: { path: string; cleanup: () => Promise<void> } | null = null;
    try {
      materialized = await this.materializeReconciledProgram(task, record);
    } catch (error) {
      return this.result(this.fail(this.store.hookEvent(record.id)!,
        `Retention reconciliation program is unavailable: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.store.event(task.id, "hook_execution_started", `${record.hookId} ${record.event} ${record.eventId} attempt ${record.attempt}`);
    let outcome: ExecutionOutcome;
    try {
      const executable = materialized?.path ?? await this.programExecutable(record, root);
      try {
        outcome = await this.run({
          root, executable, argv: record.program.argv, stdin,
          timeoutMs: record.timeoutMs, maxOutputBytes: record.maxOutputBytes, env: minimalHookEnvironment(record.eventId, record.eventPayload?.schema ?? EVENT_SCHEMA),
          onSpawn: (pid, processGroupId, leaderStartIdentity) => { record = this.save(this.store.hookEvent(record.id)!, {
            processId: pid || null, processGroupId: processGroupId ?? null, leaderStartIdentity: leaderStartIdentity ?? null }); },
        });
      } finally {
        await materialized?.cleanup();
      }
    } catch (error) { return this.result(this.fail(this.store.hookEvent(record.id)!, `Hook could not start: ${String(error)}`)); }
    const current = this.save(this.store.hookEvent(record.id)!, { processId: null,
      processGroupId: outcome.processGroupId ?? null, leaderStartIdentity: outcome.leaderStartIdentity ?? null,
      terminationSignal: outcome.terminationSignal ?? null, processGroupEmpty: outcome.processGroupEmpty ?? null,
      terminationError: outcome.terminationError ?? null, timedOut: outcome.timedOut === true });
    const failure = executionFailure(outcome, current);
    if (failure) {
      const drifted = await targetDrift();
      const after = await this.safeSnapshot(root);
      if (!after)
        return this.result(this.uncertainSync(current, `${failure}; read-only hook mutation comparison unavailable; repository state could not be verified`));
      if (!drifted && await this.publishedFastForward(task, record, before, after))
        return this.result(this.supersedeForBaseAdvance(current, before.head, after.head));
      if (drifted || after.head !== before.head || after.status !== before.status || after.indexTree !== before.indexTree)
        return this.result(this.uncertainSync(current, `${failure}; read-only hook changed repository state and requires attention`));
      return this.result(this.fail(current, failure));
    }
    const parsed = parseHookResult(outcome.stdout, current.eventId);
    if ("error" in parsed) return this.result(this.fail(current, failedResultEvidence(outcome, `produced no usable result: ${parsed.error}`)));
    const result = parsed.result;
    if (result.changedPaths.length || result.commitSubjectSuffix !== null) return this.result(this.fail(current, "A read-only hook may not report changed paths or a commit subject"));
    const after = await this.safeSnapshot(root);
    if (!after)
      return this.result(this.uncertainSync(current, "Read-only hook mutation comparison unavailable; repository state could not be verified"));
    if (await this.publishedFastForward(task, record, before, after))
      return this.result(this.supersedeForBaseAdvance(current, before.head, after.head));
    if (after.head !== before.head || after.status !== before.status || after.indexTree !== before.indexTree) {
      this.store.event(task.id, "hook_read_only_mutation", `${current.hookId} ${current.eventId}`);
      return this.result(this.uncertainSync(current, "Read-only hook changed HEAD, index or worktree; the repository needs attention"));
    }
    const executionDrift = await targetDrift();
    if (executionDrift) return this.result(this.uncertainSync(current, `${preArchive ? "Retention gate worktree" : prospectiveMerge ? "Prospective-merge candidate" : "Reviewed-head"} identity changed during execution: ${executionDrift}`));
    // A structured refusal or failure keeps the same stderr evidence a non-zero
    // exit keeps; the hook's own summary stays the summary.
    return this.result(this.settle(current, result, result.outcome === "ok" ? {}
      : { error: failedResultEvidence(outcome, `reported outcome ${result.outcome}: ${result.summary}`) }));
  }

  private prospectiveProgramDrift(root: string, record: HookRecord): Promise<string | null> {
    return this.prospectiveMerge.prospectiveProgramDrift(root, record);
  }

  /** The clean, synchronized integration base commit for one repository, proven against origin. */
  async integrationBase(task: Task): Promise<string> {
    return withIntegrationCheckout(task, async (checkout, unchanged) => {
      const head = await gitText(checkout, "rev-parse", "HEAD");
      await this.verifyCleanSynchronizedBase(checkout, task.baseBranch, head);
      await unchanged();
      return head;
    });
  }

  /**
   * Fast-forward the integration base to origin after a stale-base refusal: the
   * same ff-only move the post-merge sync makes, without its merged-commit
   * precondition. Dirty, wrong-branch and locally-ahead checkouts still refuse,
   * so the cleanliness proof is not relaxed; only origin being ahead is renewed.
   */
  async renewIntegrationBase(task: Task, allowed: () => boolean): Promise<string> {
    return withIntegrationCheckout(task, async (checkout, unchanged) => {
      if (await gitText(checkout, "branch", "--show-current") !== task.baseBranch) throw new Error("Integration checkout is not on the base branch");
      if ((await statusEntries(checkout, false)).length) throw new Error("Integration checkout has tracked or untracked changes");
      const head = await gitText(checkout, "rev-parse", "HEAD");
      await gitText(checkout, "fetch", "origin", task.baseBranch);
      const remote = await gitText(checkout, "rev-parse", `refs/remotes/origin/${task.baseBranch}`);
      if (remote === head) return head;
      // Commits origin does not have are a state their author must push, not a base to renew.
      try { await gitText(checkout, "merge-base", "--is-ancestor", head, remote); }
      catch { throw new Error("Integration base cannot fast-forward: local integration commits are not on origin"); }
      await unchanged();
      if (!allowed()) throw new Error("Paused before local main update");
      await gitText(checkout, "merge", "--ff-only", remote);
      if (await gitText(checkout, "rev-parse", "HEAD") !== remote || (await statusEntries(checkout, false)).length)
        throw new Error("Integration synchronization did not leave a clean expected head");
      // A direct update of the registered checkout is the same main change the post-merge sync announces.
      if (checkout === task.repoPath) requestServiceRollAfterRepositorySync(task.repoPath);
      return remote;
    });
  }

  private prospectiveCandidatePath(task: Task, candidate: Pick<MergeCandidate, "integrationBase" | "reviewedHead">): Promise<string> {
    return this.prospectiveMerge.prospectiveCandidatePath(task, candidate);
  }

  /**
   * Materialize the repository program blob pinned at the reconciled
   * integration base into a Queue-owned ephemeral executable outside the
   * retained worktree. The retained worktree is at the refused head, so
   * spawning its file would run the stale gate program; the pinned digest is
   * re-proven against the object store before anything executes. Returns null
   * for every other occurrence, which keeps spawning its own execution root.
   */
  private async materializeReconciledProgram(task: Task, record: HookRecord): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
    if (!record.retentionReconciliation || record.program.kind !== "repository") return null;
    const pin = record.program.executable;
    if (pin.commit !== record.baseCommit) throw new Error("the pinned hook program is not at the reconciled integration base");
    const blob = await gitRaw(task.repoPath, ["cat-file", "-p", `${record.baseCommit}:${pin.path}`]);
    if (blob.code !== 0) throw new Error(`the pinned hook program is missing at the reconciled base: ${formatGitError(["cat-file", "-p", `${record.baseCommit}:${pin.path}`], blob.code, blob.signal, blob.stderr)}`);
    if (blobDigest(blob.stdout) !== pin.digest) throw new Error("the hook program at the reconciled base differs from the pinned digest");
    const dir = await mkdtemp(join(tmpdir(), "nsq-retention-program-"));
    try {
      const path = join(dir, pin.path.split("/").pop() || "hook");
      await writeFile(path, blob.stdout, { mode: 0o755 });
      await chmod(path, 0o755);
      return { path, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => { /* cleanup must never mask the materialization outcome */ });
      throw error;
    }
  }

  private proveWarmOwnership(task: Pick<Task, "repoPath">, path: string, common: string): Promise<void> {
    return this.prospectiveMerge.proveWarmOwnership(task, path, common);
  }

  private buildProspectiveCandidate(task: Task, path: string, base: string, head: string, warm = false): Promise<{ kind: "built"; candidate: MergeCandidate } | { kind: "conflict"; detail: string } | { kind: "error"; detail: string } | { kind: "fallback"; detail: string }> {
    return this.prospectiveMerge.buildProspectiveCandidate(task, path, base, head, warm);
  }

  private ensureProspectiveCandidate(task: Task, record: HookRecord): Promise<{ ok: true } | { ok: false; detail: string }> {
    return this.prospectiveMerge.ensureProspectiveCandidate(task, record);
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

  private async executeIntegrationWrite(task: Task, record: HookRecord, stdin: Buffer, path: string): Promise<HookEmissionResult> {
    try {
      await this.verifyCleanSynchronizedBase(task.repoPath, record.baseBranch, record.baseCommit);
    } catch (error) { return this.result(this.fail(record, `Integration write requires a clean synchronized base: ${String(error)}`)); }
    // Durable creation intent precedes the Queue-owned checkout. The path is
    // deterministic for this event, so a restart never creates a second one.
    let current = this.save(record, { state: "workspace_intent", workspace: { path, head: record.baseCommit } });
    this.store.event(task.id, "hook_workspace_intent", `${current.hookId} ${current.eventId} ${path}`);
    try {
      await this.removeIsolatedCheckout(task, path, true);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const origin = await gitText(task.repoPath, "remote", "get-url", "origin");
      await gitText(task.repoPath, "clone", "--shared", "--no-checkout", "--", task.repoPath, path);
      await gitText(path, "remote", "set-url", "origin", origin);
      await gitText(path, "checkout", "-B", current.baseBranch, current.baseCommit);
      if (!await isolatedRepositoryIsCleanAt(path, current.baseCommit, current.baseBranch)) throw new Error("Isolated checkout did not settle clean on the declared branch at the event base");
      if (await gitText(path, "remote", "get-url", "origin") !== origin) throw new Error("Isolated checkout origin differs from the canonical origin");
      await this.verifyExecutableBlob(path, current);
    } catch (error) {
      return this.result(await this.uncertainSync(this.store.hookEvent(current.id)!, `Isolated checkout creation requires reconciliation: ${String(error)}`));
    }
    this.store.event(task.id, "hook_workspace_created", `${current.hookId} ${current.eventId}`);
    let before: GitSnapshot;
    try { before = await snapshotGit(path); } catch (error) { return this.result(await this.uncertainSync(this.store.hookEvent(current.id)!, `Isolated checkout baseline failed: ${String(error)}`)); }
    current = this.save(this.store.hookEvent(current.id)!, { state: "running", attempt: current.attempt + 1, processId: null, processGroupId: null,
      leaderStartIdentity: null, terminationSignal: null, processGroupEmpty: null, terminationError: null });
    this.store.event(task.id, "hook_execution_started", `${current.hookId} ${current.event} ${current.eventId} attempt ${current.attempt}`);
    let outcome: ExecutionOutcome;
    try {
      const executable = await this.programExecutable(current, path);
      outcome = await this.run({
        root: path, executable, argv: current.program.argv, stdin,
        timeoutMs: current.timeoutMs, maxOutputBytes: current.maxOutputBytes, env: minimalHookEnvironment(current.eventId, current.eventPayload?.schema ?? EVENT_SCHEMA),
        onSpawn: (pid, processGroupId, leaderStartIdentity) => { const latest = this.store.hookEvent(current.id); if (latest) current = this.save(latest, {
          processId: pid || null, processGroupId: processGroupId ?? null, leaderStartIdentity: leaderStartIdentity ?? null }); },
      });
    } catch (error) { return this.result(await this.failIntegrationWrite(this.store.hookEvent(current.id)!, `Hook could not start: ${String(error)}`)); }
    let latest = this.save(this.store.hookEvent(current.id)!, { processId: null,
      processGroupId: outcome.processGroupId ?? null, leaderStartIdentity: outcome.leaderStartIdentity ?? null,
      terminationSignal: outcome.terminationSignal ?? null, processGroupEmpty: outcome.processGroupEmpty ?? null,
      terminationError: outcome.terminationError ?? null });
    const failure = executionFailure(outcome, latest);
    if (failure) return this.result(await this.failIntegrationWrite(latest, failure));
    const parsed = parseHookResult(outcome.stdout, latest.eventId);
    if ("error" in parsed) return this.result(await this.failIntegrationWrite(latest, failedResultEvidence(outcome, `produced no usable result: ${parsed.error}`)));
    const result = parsed.result;
    if (result.outcome !== "ok") return this.result(await this.failIntegrationWrite(latest, failedResultEvidence(outcome, `reported outcome ${result.outcome}: ${result.summary}`), result));
    try {
      const head = await gitText(path, "rev-parse", "HEAD");
      if (head !== before.head) throw new Error("Hook changed HEAD; a hook must not commit");
      const inspection = await inspectChangedPaths(path, result.changedPaths, latest.allowedPaths, { ignored: "runtime" });
      const changed = inspection.paths;
      if (changed.length === 0) return this.result(await this.finishWithoutPublication(task, latest, result, path));
      if (JSON.stringify(changed) !== JSON.stringify(result.changedPaths)) throw new Error(`Declared and actual changed paths differ; actual: ${changed.join(", ") || "none"}`);
      const subject = joinCommitSubject(latest.commitSubject!, result.commitSubjectSuffix);
      return this.publish(task, latest, changed, subject, result, path);
    } catch (error) {
      return this.result(await this.failIntegrationWrite(this.store.hookEvent(latest.id)!, error instanceof Error ? error.message : String(error)));
    }
  }

  /** The canonical checkout must be clean for Git publication and exact at the event base. Ignored evidence is allowed. */
  /**
   * True when canonical HEAD moved during a read-only integration-base hook only
   * because the base fast-forwarded to the published origin tip: the checkout is
   * clean, on the base branch, its index is exactly the new HEAD tree, and HEAD is
   * origin. A local commit, a dirty tree or an unpublished head stays uncertain.
   */
  private async publishedFastForward(task: Task, record: HookRecord, before: GitSnapshot, after: GitSnapshot): Promise<boolean> {
    if (record.event === "task.pre_merge" || record.event === "task.pre_archive" || after.head === before.head || before.status !== "" || after.status !== "") return false;
    try {
      const root = task.repoPath;
      if (await gitText(root, "branch", "--show-current") !== record.baseBranch) return false;
      if ((await gitRaw(root, ["merge-base", "--is-ancestor", before.head, after.head])).code !== 0) return false;
      if (after.indexTree !== await gitText(root, "rev-parse", `${after.head}^{tree}`)) return false;
      return after.head === await gitText(root, "rev-parse", `refs/remotes/origin/${record.baseBranch}`);
    } catch { return false; }
  }

  private supersedeForBaseAdvance(record: HookRecord, from: string, to: string): HookRecord {
    return this.hookReplay.supersedeForBaseAdvance(record, from, to);
  }

  private renewAdvancedPreDispatch(task: Task, record: HookRecord): Promise<HookEmissionResult | null> {
    return this.hookReplay.renewAdvancedPreDispatch(task, record);
  }

  private async verifyCleanSynchronizedBase(root: string, baseBranch: string, baseCommit: string) {
    const dirty = await statusEntries(root, false);
    if (dirty.length) throw new Error("Integration checkout has tracked or untracked changes");
    if (await gitText(root, "branch", "--show-current") !== baseBranch) throw new Error("Integration checkout is not on the base branch");
    const head = await gitText(root, "rev-parse", "HEAD");
    if (head !== baseCommit) throw new Error("Integration HEAD moved from the event base");
    await gitText(root, "fetch", "origin", baseBranch);
    const remote = await gitText(root, "rev-parse", `refs/remotes/origin/${baseBranch}`);
    if (remote !== head) throw new Error("Local integration base differs from origin");
  }

  /** Remove only a Queue-owned isolated checkout. A non-forced removal refuses to discard dirty state. */
  private async removeIsolatedCheckout(task: Task, path: string, force: boolean) {
    const common = await gitText(task.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (!isOwnedIsolationPath(path, this.isolationDataDir(), common)) throw new Error("Refusing to remove a checkout outside the Queue-owned isolation root");
    const rootInfo = await lstat(path).catch(() => null);
    if (!rootInfo) { await gitRaw(task.repoPath, ["worktree", "prune"]); return; }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Queue-owned isolated checkout path is not a real directory");
    const gitMarker = await lstat(join(path, ".git")).catch(() => null);
    if (gitMarker?.isFile()) {
      const result = await gitRaw(task.repoPath, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
      if (result.code !== 0) {
        if (!force) throw new Error(`Isolated checkout removal failed: ${formatGitError(["worktree", "remove", path], result.code, result.signal, result.stderr)}`);
        await rm(path, { recursive: true, force: true });
        await gitRaw(task.repoPath, ["worktree", "prune"]);
      }
    } else if (gitMarker?.isDirectory()) {
      // Ignored entries are disposable runtime material in a Queue-owned
      // isolated checkout; every non-ignored entry still blocks a clean removal.
      if (!force) {
        const dirt = await statusEntries(path, false);
        if (dirt.length) throw new Error("Queue-owned isolated repository is dirty");
      }
      await rm(path, { recursive: true, force: true });
    } else {
      if (!force) throw new Error("Queue-owned isolated checkout has no recognized Git identity");
      await rm(path, { recursive: true, force: true });
    }
    if (existsSync(path)) throw new Error("Isolated checkout still exists after removal");
  }

  private async verifyExecutableBlob(path: string, record: HookRecord) {
    if (record.program.kind === "tool") return;
    if (record.program.kind !== "repository") throw new Error("Historical or unavailable tool occurrence cannot execute");
    const file = executablePath(path, record.program.executable);
    const info = await lstat(file).catch(() => null);
    if (!info || !info.isFile() || (info.mode & 0o111) === 0) throw new Error("Isolated checkout executable is missing or not executable");
    if (blobDigest(await readFile(file)) !== record.program.executable.digest) throw new Error("Isolated checkout executable digest differs from the pinned blob");
  }

  /** A no-diff successful write discards the isolated checkout without publishing. */
  private async finishWithoutPublication(task: Task, record: HookRecord, result: HookResult, path: string): Promise<HookRecord> {
    let current = this.save(record, { state: "cleanup_intent", result });
    try { await this.removeIsolatedCheckout(task, path, false); }
    catch (error) { return this.uncertainSync(current, `Isolated checkout cleanup requires reconciliation: ${String(error)}`); }
    return this.settle(this.store.hookEvent(current.id)!, result, { state: "published", workspace: null });
  }

  private async publish(task: Task, record: HookRecord, changed: string[], subject: string, result: HookResult, path: string): Promise<HookEmissionResult> {
    let current = this.save(record, { state: "commit_intent", result: { ...result, changedPaths: changed }, summary: result.summary });
    try {
      await gitText(path, "add", "--", ...changed);
      const extra: string[] = [];
      await gitNulEach(path, ["diff", "--cached", "--name-only", "-z"], candidate => { if (!changed.includes(candidate)) extra.push(candidate); });
      if (extra.length) throw new Error(`Refusing to publish undeclared staged paths: ${extra.join(", ")}`);
      await gitText(path, "commit", "-m", subject, "-m", this.trailers(current));
      const commit = await gitText(path, "rev-parse", "HEAD");
      current = this.save(this.store.hookEvent(current.id)!, { state: "committed", commit });
      this.store.event(task.id, "hook_committed", `${current.hookId} ${commit}`);
    } catch (error) {
      return this.result(await this.uncertainSync(this.store.hookEvent(current.id)!, `Commit outcome requires reconciliation: ${String(error)}`));
    }
    current = this.save(this.store.hookEvent(current.id)!, { state: "push_intent", remote: `refs/heads/${current.baseBranch}` });
    try {
      await gitText(path, "push", "origin", `${current.commit}:refs/heads/${current.baseBranch}`);
      await gitText(task.repoPath, "fetch", "origin", current.baseBranch);
      const remote = await gitText(task.repoPath, "rev-parse", `refs/remotes/origin/${current.baseBranch}`);
      if (remote !== current.commit) throw new Error("Remote branch does not point to the published commit");
    } catch (error) {
      return this.result(await this.uncertainSync(this.store.hookEvent(current.id)!, `Push outcome requires reconciliation: ${String(error)}`));
    }
    return this.result(await this.completePublication(task, this.store.hookEvent(current.id)!, current.commit!, result, path));
  }

  /** After remote publication: fast-forward the canonical checkout, prove the remote, then remove the isolated checkout. */
  private async completePublication(task: Task, record: HookRecord, commit: string, result: HookResult, path: string): Promise<HookRecord> {
    let current = this.save(record, { state: "sync_intent", commit });
    const syncError = await this.syncCanonical(task.repoPath, record.baseBranch, record.baseCommit, commit);
    if (syncError) return this.uncertainSync(current, `Canonical synchronization requires reconciliation: ${syncError}`);
    current = this.save(this.store.hookEvent(current.id)!, { state: "synced", commit });
    this.store.event(task.id, "hook_synced", `${current.hookId} ${commit}`);
    current = this.save(this.store.hookEvent(current.id)!, { state: "cleanup_intent" });
    try { await this.removeIsolatedCheckout(task, path, false); }
    catch (error) { return this.uncertainSync(current, `Isolated checkout cleanup requires reconciliation: ${String(error)}`); }
    return this.settle(this.store.hookEvent(current.id)!, result, { state: "published", commit, workspace: null });
  }

  /** Fast-forward the operator checkout from the event base to a published commit and prove it matches the remote. */
  private async syncCanonical(root: string, baseBranch: string, baseCommit: string, target: string): Promise<string | null> {
    try {
      if (await gitText(root, "branch", "--show-current") !== baseBranch) return "canonical checkout is not on the base branch";
      if ((await statusEntries(root, false)).length) return "canonical checkout has tracked or untracked changes";
      const head = await gitText(root, "rev-parse", "HEAD");
      if (head !== target) {
        if ((await gitRaw(root, ["merge-base", "--is-ancestor", head, target])).code !== 0) return "canonical HEAD diverged from the published history";
        const collisions = await this.ignoredCollisions(root, head, target);
        if (collisions.length) return `ignored operator content would be overwritten: ${collisions.join(", ")}`;
        await gitText(root, "merge", "--ff-only", target);
      }
      await gitText(root, "fetch", "origin", baseBranch);
      const remote = await gitText(root, "rev-parse", `refs/remotes/origin/${baseBranch}`);
      if (remote !== target) return "remote branch does not point to the synchronized commit";
      if (await gitText(root, "rev-parse", "HEAD") !== target) return "canonical HEAD does not match the synchronized commit";
      return null;
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  /** Paths the published commit adds or rewrites that exist in the operator checkout as ignored evidence. */
  private async ignoredCollisions(root: string, baseCommit: string, target: string): Promise<string[]> {
    const ignored = (await statusEntries(root)).filter(entry => entry.ignored).map(entry => entry.path);
    const collisions: string[] = [];
    await gitNulEach(root, ["diff", "--name-only", "-z", "--diff-filter=ACMR", baseCommit, target], path => {
      if (ignored.some(entry => ignoredPathCollides(path, entry))) collisions.push(path);
    });
    return collisions;
  }

  private async cleanupPublished(task: Task, record: HookRecord): Promise<HookRecord> {
    const path = record.workspace?.path;
    if (!path || !existsSync(path)) return this.settle(record, record.result ?? okResult(record), { state: "published", commit: record.commit, workspace: null, reconciledAt: now() });
    const current = this.save(this.store.hookEvent(record.id)!, { state: "cleanup_intent" });
    try { await this.removeIsolatedCheckout(task, path, true); }
    catch (error) { return this.uncertainSync(current, `Isolated checkout cleanup requires reconciliation: ${String(error)}`); }
    return this.settle(this.store.hookEvent(current.id)!, record.result ?? okResult(record), { state: "published", commit: record.commit, workspace: null, reconciledAt: now() });
  }

  private trailers(record: HookRecord): string {
    // These trailer names are committed history on the forge: writer and readers
    // (the git log greps below) must stay in sync, so they keep the name they
    // were first published under even after the Nucleus rename.
    return [
      `Northstar-Queue-Hook: ${record.eventId}`,
      `Northstar-Queue-Manifest: ${record.manifest.path}@${record.manifest.digest}`,
      `Northstar-Queue-Event: ${record.event}`,
    ].join("\n");
  }

  /** Search the isolated checkout and the canonical checkout for this event's published commit. */
  private async matchingCommits(task: Task, record: HookRecord): Promise<string[]> {
    const roots = [task.repoPath];
    if (record.workspace?.path && existsSync(record.workspace.path)) roots.push(record.workspace.path);
    const found = new Set<string>();
    for (const root of roots) for (const sha of await matchingCommitsIn(root, record)) found.add(sha);
    return [...found];
  }

  /** Reconcile one durable record against local history and the remote before any retry. */
  async reconcile(record: HookRecord): Promise<HookRecord> {
    if (record.checkoutDiscard) return record;
    if (["result", "published", "blocked", "failed", "intent"].includes(record.state)) return record;
    const task = this.store.task(record.taskId);
    try {
      if (record.state === "workspace_intent") {
        const path = record.workspace?.path;
        if (!path) return this.uncertainSync(record, "Isolated checkout creation intent lost its recorded path");
        if (existsSync(path) && !await isolatedRepositoryIsCleanAt(path, record.baseCommit, record.baseBranch)) return this.uncertainSync(record, "Isolated checkout for this hook is not clean on the declared branch at the event base");
        return this.save(record, { state: "intent", reconciledAt: now() });
      }
      if (record.state === "running") {
        if (record.processId && pidAlive(record.processId)) return record;
        if (record.mode === "integration_write") {
          const path = record.workspace?.path;
          if (!path || !existsSync(path)) return this.uncertainSync(record, "Restart during isolated hook execution lost the Queue-owned checkout");
          if (!await isolatedRepositoryIsCleanAt(path, record.baseCommit, record.baseBranch)) return this.uncertainSync(record, "Restart during isolated hook execution left repository state that needs attention");
        } else if (record.event === "task.pre_merge") {
          if (hookRecordTarget(record) === "prospective_merge") {
            const path = record.workspace?.path;
            try {
              if (!path || !existsSync(path)) throw new Error("the Queue-owned candidate checkout is missing");
              await verifyMergeCandidate(path, record.mergeCandidate);
            } catch (error) {
              return this.uncertainSync(record, `Restart during the prospective-merge gate left repository state that needs attention: ${error instanceof Error ? error.message : String(error)}`);
            }
          } else if (!await reviewedHeadIsClean(task, record)) return this.uncertainSync(record, "Restart during the reviewed-head gate left repository state that needs attention");
        } else if (record.event === "task.pre_archive") {
          const path = record.workspace?.path;
          try {
            if (!path) throw new Error("the retained task worktree path is missing");
            await verifyRetainedWorktree(path, preArchiveWorktreeHead(record));
          } catch (error) {
            return this.uncertainSync(record, `Restart during the pre-archive gate left repository state that needs attention: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else if (record.event === "task.finished") {
          // The stop is advisory and its only effect is the repository's own
          // runtime. A restart cannot tell whether it completed, so the
          // occurrence is recorded uncertain and never retried automatically;
          // an owner `retry_effect` re-runs the pinned program.
          return this.uncertainSync(record, "Restart during the finished-task runtime stop left the outcome unknown; retry_effect re-runs it");
        } else if (!(await repositoryIsCleanAt(task.repoPath, record.baseCommit))) {
          return this.uncertainSync(record, "Restart during hook execution left repository state that needs attention");
        }
        return this.save(record, { state: "intent", processId: null, reconciledAt: now() });
      }
      if (record.state === "commit_intent" || record.state === "committed") {
        const matches = await this.matchingCommits(task, record);
        if (matches.length > 1) return this.uncertainSync(record, `Multiple local commits match hook ${record.eventId}`);
        let commit = record.commit;
        if (matches.length === 1) {
          if (!await validatePublishedCommit(task.repoPath, record, matches[0])) return this.uncertainSync(record, `Matching commit ${matches[0]} failed tree or allowed-path validation`);
          commit = matches[0];
        } else if (record.state === "committed" && commit) {
          if (!await validatePublishedCommit(task.repoPath, record, commit)) return this.uncertainSync(record, `Recorded commit ${commit} failed tree or allowed-path validation`);
        }
        if (record.state === "commit_intent" && !commit) return this.save(record, { state: "intent", reconciledAt: now() });
        return this.reconcilePush(this.save(record, { commit, state: "push_intent", reconciledAt: now() }));
      }
      if (record.state === "push_intent" || record.state === "uncertain") {
        const matches = await this.matchingCommits(task, record);
        if (record.state === "uncertain" && matches.length === 1) return this.reconcilePush(this.save(record, { commit: matches[0], state: "push_intent", reconciledAt: now() }));
        if (record.state === "push_intent") return this.reconcilePush(record);
        return record;
      }
      if (record.state === "sync_intent" || record.state === "synced") {
        if (!record.commit) return this.uncertainSync(record, "Synchronization intent lost the published commit");
        if (await gitText(task.repoPath, "rev-parse", "HEAD").catch(() => null) === record.commit) return this.cleanupPublished(task, record);
        const syncError = await this.syncCanonical(task.repoPath, record.baseBranch, record.baseCommit, record.commit);
        if (syncError) return this.uncertainSync(record, `Canonical synchronization requires reconciliation: ${syncError}`);
        return this.cleanupPublished(task, this.save(record, { state: "synced", reconciledAt: now() }));
      }
      if (record.state === "cleanup_intent") {
        const path = record.workspace?.path;
        if (!path || !existsSync(path)) return this.settle(record, record.result ?? okResult(record), { state: "published", commit: record.commit, workspace: null, reconciledAt: now() });
        try { await this.removeIsolatedCheckout(task, path, false); }
        catch (error) { return this.uncertainSync(record, `Isolated checkout cleanup requires reconciliation: ${String(error)}`); }
        return this.settle(this.store.hookEvent(record.id)!, record.result ?? okResult(record), { state: "published", commit: record.commit, workspace: null, reconciledAt: now() });
      }
    } catch (error) {
      return this.uncertainSync(record, `Reconciliation failed: ${String(error)}`);
    }
    return record;
  }

  /**
   * Prove an uncertain `integration_write` stopped before Queue's commit
   * intent. The proof requires no matching event commit locally or remotely,
   * canonical `HEAD` and `origin/<base>` both at the pinned base, the recorded
   * Queue-owned checkout still at that base and branch, and a complete status
   * limited to ignored runtime material plus manifest-allowed changes. A
   * durably stored parsed result adds exact declared-path equality. Ignored
   * artifacts are disposable checkout-local material; every non-ignored entry
   * still has to be allowed. Commit and push uncertainty never passes.
   */
  private async provePreCommitUncertain(task: Task, record: HookRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      if (record.mode !== "integration_write") return { ok: false, reason: "only an integration write owns a disposable pre-commit checkout" };
      if (record.commit || record.remote) return { ok: false, reason: "the record crossed the commit or push intent boundary" };
      if ((await this.matchingCommits(task, record)).length) return { ok: false, reason: "a commit carrying this hook event already exists" };
      await gitText(task.repoPath, "fetch", "origin", record.baseBranch);
      if (await gitText(task.repoPath, "rev-parse", "HEAD") !== record.baseCommit) return { ok: false, reason: "the canonical checkout moved from the pinned base" };
      if (await gitText(task.repoPath, "rev-parse", `refs/remotes/origin/${record.baseBranch}`) !== record.baseCommit) return { ok: false, reason: "the remote base moved from the pinned base" };
      const path = record.workspace?.path;
      if (!path || !existsSync(path)) return { ok: false, reason: "the Queue-owned checkout is missing" };
      if (await gitText(path, "rev-parse", "HEAD") !== record.baseCommit) return { ok: false, reason: "the Queue-owned checkout moved from the pinned base" };
      if (await gitText(path, "branch", "--show-current") !== record.baseBranch) return { ok: false, reason: "the Queue-owned checkout left the declared branch" };
      const changed = new Set<string>();
      for (const entry of await statusEntries(path, false)) {
        const candidate = normalizeRepoRelativePath(entry.path);
        if (!pathIsAllowed(candidate, record.allowedPaths)) return { ok: false, reason: `an unexpected non-ignored path is present: ${candidate}` };
        changed.add(candidate);
      }
      if (record.result) {
        const declared = [...new Set(record.result.changedPaths)].sort();
        if (JSON.stringify([...changed].sort()) !== JSON.stringify(declared)) return { ok: false, reason: "the stored result does not match the checkout-local changes" };
      }
      return { ok: true };
    } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
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

  private async reconcilePush(record: HookRecord): Promise<HookRecord> {
    if (!record.commit) return record;
    const task = this.store.task(record.taskId);
    try {
      await gitText(task.repoPath, "fetch", "origin", record.baseBranch);
      const remote = await gitText(task.repoPath, "rev-parse", `refs/remotes/origin/${record.baseBranch}`);
      const contains = remote === record.commit || (await gitRaw(task.repoPath, ["merge-base", "--is-ancestor", record.commit, remote])).code === 0;
      if (!contains) return this.uncertainSync(record, `Remote ${record.baseBranch} does not contain published commit ${record.commit}`);
      const syncError = await this.syncCanonical(task.repoPath, record.baseBranch, record.baseCommit, remote);
      if (syncError) return this.uncertainSync(record, `Canonical synchronization requires reconciliation: ${syncError}`);
      return this.cleanupPublished(task, this.save(this.store.hookEvent(record.id)!, { state: "synced", reconciledAt: now() }));
    } catch (error) {
      return this.uncertainSync(record, `Push reconciliation failed: ${String(error)}`);
    }
  }

  private settle(record: HookRecord, result: HookResult, extra: Partial<HookRecord> = {}): HookRecord {
    const outcome = result.outcome;
    const state: HookRecord["state"] = extra.state ?? (outcome === "ok" ? "result" : record.delivery === "required" ? "blocked" : "failed");
    const next = this.save(record, { ...extra, state, result, summary: result.summary, commit: extra.commit ?? record.commit, reconciledAt: extra.reconciledAt ?? record.reconciledAt });
    this.store.event(record.taskId, `hook_${state}`, `${record.hookId} ${record.event} ${record.eventId}: ${result.summary.slice(0, 500)}`);
    return next;
  }

  private fail(record: HookRecord, error: string): HookRecord {
    const state: HookRecord["state"] = record.delivery === "required" ? "blocked" : "failed";
    const next = this.save(record, { state, error, summary: error.slice(0, 4000), processId: null });
    this.store.event(record.taskId, `hook_${state}`, `${record.hookId} ${record.event} ${record.eventId}: ${error.slice(0, 500)}`);
    return next;
  }

  private uncertainSync(record: HookRecord, error: string): HookRecord {
    const next = this.save(record, { state: "uncertain", error, summary: error.slice(0, 4000), processId: null, reconciledAt: now() });
    this.store.event(record.taskId, "hook_uncertain", `${record.hookId} ${record.event} ${record.eventId}: ${error.slice(0, 500)}`);
    return next;
  }

  /** A policy-violating execution inside the Queue-owned checkout keeps the canonical repository untouched. */
  private async failIntegrationWrite(record: HookRecord, error: string, result?: HookResult): Promise<HookRecord> {
    const next = result ? this.save(record, { result }) : record;
    if (await this.workspaceMutated(next)) return this.uncertainSync(next, `${error}; isolated checkout was mutated and needs bounded reconciliation`);
    return this.fail(next, error);
  }

  private async workspaceMutated(record: HookRecord): Promise<boolean> {
    const path = record.workspace?.path;
    if (!path || !existsSync(path)) return false;
    try {
      if (await gitText(path, "rev-parse", "HEAD") !== record.baseCommit) return true;
      return (await statusEntries(path, false)).length > 0;
    } catch { return true; }
  }

  private async safeSnapshot(root: string): Promise<GitSnapshot | null> { try { return await this.snapshot(root); } catch { return null; } }

  private result(record: HookRecord): HookEmissionResult {
    return { hold: record.state === "blocked" || record.state === "uncertain" || (record.state === "failed" && record.delivery === "required"), attention: record.state === "uncertain" || record.state === "blocked" || (record.state === "failed" && record.delivery === "required"), records: [record] };
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
        const discovery = await discoverManifest(task.repoPath, next.baseCommit).catch(() => null);
        const hook = discovery?.manifest.hooks.find(candidate => candidate.id === next.hookId);
        if (!discovery || discovery.pin.digest !== next.manifest.digest || !hook) {
          next = this.uncertainSync(next, "Hook manifest is stale or the hook is no longer bound; bounded reconciliation required");
        } else if (next.retentionReconciliation) {
          // A reconciliation occurrence carries its own integration-base
          // pins and must run itself: the ordinary search would resume the
          // older refused occurrence it reconciles whenever both answer for
          // the same target.
          const outcome = await this.runRecordedHook(task, hook, next);
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
    const outcome = await this.retryOccurrence(task, hookEventId, discardUnpublishedCheckout, cleanupOnly);
    const record = this.store.hookEvent(hookEventId) ?? this.store.hookEvents(task.id).find(candidate => candidate.eventId === hookEventId) ?? null;
    if (record?.event === "task.pre_archive" && !outcome.hold)
      this.options.retentionGateSettled?.(task.id, record.workspace?.path ?? null);
    return outcome;
  }

  /** Retry one reconciled hook event with its durable occurrence facts and a single higher confirmed attempt. */
  private async retryOccurrence(task: Task, hookEventId: string, discardUnpublishedCheckout = false, cleanupOnly = false): Promise<HookEmissionResult> {
    const byRecord = this.store.hookEvent(hookEventId);
    const byEvent = this.store.hookEvents(task.id).filter(candidate => candidate.eventId === hookEventId);
    if (byEvent.length > 1) throw new Error("Multiple hook records share that event ID");
    const found = byRecord ?? byEvent[0] ?? null;
    if (!found || found.taskId !== task.id) throw new Error("Hook record not found for this task");
    if (cleanupOnly && !discardUnpublishedCheckout) throw new Error("Cleanup-only requires explicit unpublished checkout discard");
    if (discardUnpublishedCheckout) return this.discardUnpublishedOccurrence(task, found, cleanupOnly);
    if (found.checkoutDiscard) throw new Error("This occurrence is held after checkout disposal; an explicit discard retry is required to run a replacement");
    const renewed = await this.renewAdvancedPreDispatch(task, found);
    if (renewed) return renewed;
    let record = await this.reconcile(found);
    if (["published", "result"].includes(record.state)) return this.result(record);
    const rolled = await this.rollRepairedCloseoutOccurrence(task, record, true);
    if (rolled) return rolled;
    if (record.event === "task.blocked" && record.state === "blocked") {
      const baseCommit = await gitText(task.repoPath, "rev-parse", `refs/heads/${record.baseBranch}`);
      const renewed = await this.rollRepairedBlockedOccurrence(task, record, baseCommit);
      if (renewed) return renewed;
    }
    if (record.event === "task.cancelled" && ["blocked", "uncertain"].includes(record.state)) {
      const baseCommit = await gitText(task.repoPath, "rev-parse", `refs/heads/${record.baseBranch}`);
      if (baseCommit !== record.baseCommit) {
        const discovery = await discoverManifest(task.repoPath, baseCommit);
        const hook = discovery?.manifest.hooks.find(candidate => candidate.id === record.hookId && candidate.events.includes(record.event));
        if (!discovery || !hook) throw new Error("The cancellation hook is no longer bound at the current integration base");
        const disposition = task.disposition;
        const summary = disposition?.kind === "supersede"
          ? `Superseded by ${disposition.replacementTaskId}: ${disposition.reason}`
          : disposition?.reason ?? task.reason;
        const renewed = await this.rollRepairedCancellationOccurrence(task, record, baseCommit, hook, discovery, {
          event: "task.cancelled", baseCommit, baseBranch: record.baseBranch, summary,
        });
        if (renewed) return renewed;
      }
    }
    // Pre-commit uncertainty is the one uncertain shape an operator may retry
    // without manual Git repair: the proof shows the attempt stopped before
    // Queue's commit intent. Every other uncertain state keeps the stronger
    // commit, push, synchronization and cleanup reconciliation.
    if (record.state === "uncertain") {
      if (record.mode === "read_only") {
        try {
          if (record.event === "task.pre_merge" && hookRecordTarget(record) === "prospective_merge") {
            const candidate = record.mergeCandidate;
            if (!candidate) throw new Error("the prospective-merge occurrence lost its candidate identity");
            const candidatePath = record.workspace?.path;
            if (!candidatePath || !existsSync(candidatePath)) throw new Error("the Queue-owned candidate checkout is missing");
            if (await gitText(candidatePath, "rev-parse", "HEAD") !== candidate.commit) throw new Error("the Queue-owned candidate checkout does not hold the pinned candidate commit");
            await this.verifyCleanSynchronizedBase(task.repoPath, record.baseBranch, candidate.integrationBase);
            // The candidate is Queue-created disposable read-only material. Once
            // its identity and the canonical base are proven and no process is
            // running, it may be discarded and rebuilt from the same pins.
            await this.removeIsolatedCheckout(task, candidatePath, true);
            record = this.save(record, { workspace: null });
          } else if (record.event === "task.pre_merge") {
            if (!task.directory) throw new Error("the retained task workspace is missing");
            await verifyReviewedHead(task.directory, task.branch, record.baseCommit);
          } else if (record.event === "task.pre_archive") {
            const worktree = record.workspace?.path;
            if (!worktree) throw new Error("the retention gate occurrence lost its retained worktree");
            await verifyRetainedWorktree(worktree, preArchiveWorktreeHead(record));
          } else if (record.event === "task.finished") {
            // The advisory stop's only requirement is the retained worktree it
            // runs in; it has no canonical base to prove and may leave ignored
            // runtime bytes behind.
            const worktree = record.workspace?.path;
            if (!worktree) throw new Error("the finished-task occurrence lost its retained worktree");
            if (!existsSync(worktree)) throw new Error("the retained worktree is missing");
          } else await this.verifyCleanSynchronizedBase(task.repoPath, record.baseBranch, record.baseCommit);
        }
        catch (error) { throw new Error(`Reconcile the uncertain hook outcome before retrying: ${error instanceof Error ? error.message : String(error)}`); }
      } else {
        const proof = await this.provePreCommitUncertain(task, record);
        if (!proof.ok) throw new Error(`Reconcile the uncertain hook outcome before retrying: ${proof.reason}`);
      }
      record = this.save(record, { state: "intent", error: "", processId: null, reconciledAt: now() });
      const kind = record.mode === "read_only" ? READ_ONLY_RECOVERED_KIND : PRE_COMMIT_RECOVERED_KIND;
      const proof = record.mode === "read_only" ? "clean read-only base" : "proven pre-commit uncertainty";
      this.store.event(task.id, kind, `${record.hookId} ${record.event} ${record.eventId}: ${proof} returned to retryable intent`);
    }
    if (!["intent", "blocked", "failed"].includes(record.state)) throw new Error("Reconcile the uncertain hook outcome before retrying");
    const discovery = await discoverManifest(task.repoPath, record.baseCommit);
    if (!discovery || discovery.pin.digest !== record.manifest.digest) throw new Error("Hook manifest changed; the retry would be stale");
    const hook = discovery.manifest.hooks.find(candidate => candidate.id === record.hookId);
    if (!hook) throw new Error("Hook is no longer bound in the manifest");
    if (record.program.kind === "repository") {
      if (hook.program.kind !== "repository") throw new Error("Hook program kind changed; the retry would be stale");
      const executable = await pinExecutable(task.repoPath, record.program.executable.commit, hook.program.executable);
      if (executable.path !== record.program.executable.path || executable.digest !== record.program.executable.digest) throw new Error("Hook executable changed; the retry would be stale");
    } else if (record.program.kind === "tool" || record.program.kind === "unavailable_tool") {
      if (hook.program.kind !== "tool" || hook.program.name !== record.program.name) throw new Error("Hook tool changed; the retry would be stale");
      if (record.program.kind === "unavailable_tool") {
        const program = await pinProgram(task.repoPath, record.baseCommit, hook.program);
        if (program.kind === "unavailable_tool") throw new Error(program.error);
        record = this.save(record, { program });
      }
    } else {
      throw new Error("Historical trusted runner occurrence cannot execute after retirement");
    }
    record = this.save(record, { state: "intent", error: "", processId: null });
    // A reconciliation occurrence carries its own integration-base pins and
    // must run itself: the ordinary search would resume the older refused
    // occurrence it reconciles whenever both answer for the same target.
    if (record.retentionReconciliation) return this.runRecordedHook(task, hook, record);
    return this.runHook(task, hook, discovery, { event: record.event, baseCommit: record.baseCommit, baseBranch: record.baseBranch, summary: task.reason, worktree: record.workspace?.path });
  }

  /**
   * Replace a pre-publication closeout occurrence after an operator repair moved
   * the synchronized integration base or restored durable accepted-review evidence.
   * The old occurrence stays terminal audit evidence; the replacement is pinned
   * and executed as a new occurrence.
   */
  /** True when the remote branch already carries this commit. */
  private async remoteCarriesCommit(task: Task, record: HookRecord, commit: string | null): Promise<boolean> {
    if (!commit) return false;
    try {
      await gitText(task.repoPath, "fetch", "origin", record.baseBranch);
      let root = task.repoPath;
      let remote = await gitText(root, "rev-parse", `refs/remotes/origin/${record.baseBranch}`);
      if ((await gitRaw(root, ["cat-file", "-e", `${commit}^{commit}`])).code !== 0) {
        // An isolated clone can hold the only copy of a rejected publication.
        // Fetch the canonical publication remote there before asking ancestry.
        root = record.workspace?.path ?? "";
        if (!root || (await gitRaw(root, ["cat-file", "-e", `${commit}^{commit}`])).code !== 0) return true;
        const origin = await gitText(task.repoPath, "remote", "get-url", "origin");
        await gitText(root, "fetch", origin, record.baseBranch);
        remote = await gitText(root, "rev-parse", "FETCH_HEAD");
      }
      const ancestry = await gitRaw(root, ["merge-base", "--is-ancestor", commit, remote]);
      return ancestry.code !== 1; // Only Git's proven non-ancestor result establishes absence.
    } catch {
      // An unreadable remote is not proof of absence, so refuse and keep the stronger path.
      return true;
    }
  }

  /** True when the remote branch already carries the record's published commit. */
  private async remoteCarries(task: Task, record: HookRecord): Promise<boolean> {
    return this.remoteCarriesCommit(task, record, record.commit);
  }
  /** Explicit disposal never infers execution authority from filesystem repair. */
  private async discardUnpublishedOccurrence(task: Task, record: HookRecord, cleanupOnly: boolean): Promise<HookEmissionResult> {
    if (record.mode !== "integration_write" || hookRecordTarget(record) !== "integration_base" ||
        !["blocked", "uncertain"].includes(record.state))
      throw new Error("Checkout discard requires a held integration-write occurrence");
    const latest = this.store.hookEvents(task.id).findLast(candidate => candidate.hookId === record.hookId && candidate.event === record.event);
    if (latest?.id !== record.id) throw new Error("Checkout discard requires the latest hook occurrence");
    if (record.processId) throw new Error("Checkout discard refuses an unresolved hook process");
    const payload = record.eventPayload;
    const isolation = await this.isolationPath(task, record.eventId);
    const expected = isolation;
    if (!payload || payload.task.id !== task.id || payload.eventId !== record.eventId || payload.event !== record.event || payload.hookId !== record.hookId ||
        (payload.repository.root !== isolation) || payload.repository.baseBranch !== record.baseBranch ||
        payload.repository.baseCommit !== record.baseCommit || record.baseBranch !== task.baseBranch)
      throw new Error("Checkout discard requires the exact immutable event and branch identity");
    const baseCommit = record.event === "task.closeout"
      ? task.resolution.syncedCommit
      : await gitText(task.repoPath, "rev-parse", `refs/heads/${record.baseBranch}`);
    if (!baseCommit) throw new Error("Checkout discard requires a synchronized integration base");
    if (record.event === "task.closeout" && task.phase !== "closing") throw new Error("Closeout disposal requires a closing task");
    await this.verifyCleanSynchronizedBase(task.repoPath, record.baseBranch, baseCommit);
    const remoteEvents = await gitText(task.repoPath, "log", `refs/remotes/origin/${record.baseBranch}`, "--format=%H", "--fixed-strings", `--grep=Northstar-Queue-Hook: ${record.eventId}`);
    if (remoteEvents) throw new Error("A commit carrying the hook event is already published");
    for (const commit of new Set([record.commit, ...await this.matchingCommits(task, record)].filter((value): value is string => !!value))) {
      if (record.checkoutDiscard && (!record.workspace || !existsSync(record.workspace.path))) {
        // Disposal may have removed the only object copy. The durable proof
        // established absence at its base; inspect every newly reachable commit
        // before extending that proof to a later fast-forwarded base.
        const anchor = record.checkoutDiscard.baseCommit;
        if ((await gitRaw(task.repoPath, ["merge-base", "--is-ancestor", anchor, baseCommit])).code !== 0)
          throw new Error("Discard proof base is no longer an ancestor of the remote");
        const added = await gitText(task.repoPath, "rev-list", `${anchor}..${baseCommit}`);
        if (added.split("\n").includes(commit)) throw new Error("Previously discarded hook commit is now published");
      } else if (await this.remoteCarriesCommit(task, record, commit)) throw new Error("Hook commit is published or remote absence cannot be proved");
    }
    const discovery = await discoverManifest(task.repoPath, baseCommit);
    const hook = discovery?.manifest.hooks.find(candidate => candidate.id === record.hookId && candidate.events.includes(record.event));
    if (!discovery || !hook || hook.mode !== "integration_write") throw new Error("Replacement integration-write hook is no longer bound");
    const path = record.workspace?.path;
    if (path && path !== expected) throw new Error("Checkout discard path is not the exact event-owned directory");
    if (!path && !record.checkoutDiscard) throw new Error("Checkout discard requires a recorded event-owned directory");
    if (path && existsSync(path)) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== expected)
        throw new Error("Checkout discard refuses a foreign directory or symlink");
      if (!existsSync(join(path, ".git"))) {
        // Only a creation failure before invocation can lose Git identity safely.
        // A completed/running hook without its object database cannot prove absence.
        if (record.attempt !== 0 || record.result || record.commit || record.remote || record.processId)
          throw new Error("Metadata-free checkout is not a proven pre-execution creation failure");
      } else {
        if (await gitText(path, "rev-parse", "--show-toplevel") !== expected || await gitText(path, "branch", "--show-current") !== record.baseBranch)
          throw new Error("Checkout Git directory or branch does not match the event identity");
        if (!await isolatedRepositoryIsCleanAt(path, record.baseCommit, record.baseBranch))
          await this.proveDisposableUnpublishedCheckout(task, record, path);
      }
      record = this.save(record, { checkoutDiscard: { status: "intent", baseCommit, at: now() } });
      this.store.event(task.id, "hook_unpublished_checkout_discard_intent", `${record.eventId}: explicit operator disposal after synchronized-base and remote-absence proofs`);
      if (existsSync(join(path, ".git"))) await this.removeIsolatedCheckout(task, path, true);
      else await rm(path, { recursive: true, force: true });
    } else if (!record.checkoutDiscard) throw new Error("Checkout disappeared without a recorded discard intent");
    const summary = "Unpublished checkout discarded; Nucleus holds this occurrence until an owner retry_effect with discard mints a replacement";
    record = this.save(record, { state: "blocked", workspace: null, processId: null, error: summary, summary,
      reconciledAt: now(), checkoutDiscard: { status: "held", baseCommit, at: now() } });
    if (cleanupOnly) return this.result(record);
    this.save(record, { state: "failed", error: "Superseded before publication after operator checkout disposal", summary: "Superseded before publication after operator checkout disposal" });
    this.store.event(task.id, "hook_occurrence_superseded", `${record.eventId}: operator requested a fresh integration-write occurrence`);
    const instruction = task.instruction
      ? await instructionForCommit(task.repoPath, baseCommit, task.instruction.path, task.instruction.mediaType)
      : record.instruction;
    const delivery = record.event === "task.closeout"
      ? { ...payload.delivery, integrationCommit: baseCommit, review: task.resolution.review?.summary ?? payload.delivery.review }
      : payload.delivery;
    return this.runHook(task, hook, discovery, { event: record.event, baseCommit, baseBranch: record.baseBranch, instruction, delivery, summary: payload.delivery.summary });
  }

  private async proveDisposableUnpublishedCheckout(task: Task, record: HookRecord, path: string): Promise<void> {
    const isolation = await this.isolationPath(task, record.eventId);
    const expected = isolation;
    if (path !== isolation || await realpath(path) !== expected || await gitText(path, "rev-parse", "--show-toplevel") !== expected)
      throw new Error("Unpublished checkout does not match the exact Queue-owned event directory");
    if (await gitText(path, "branch", "--show-current") !== record.baseBranch)
      throw new Error("Unpublished checkout branch changed");
    const head = await gitText(path, "rev-parse", "HEAD");
    if (head === record.baseCommit) {
      if (!record.result) throw new Error("Unpublished checkout has no recorded hook content declaration");
      await inspectChangedPaths(path, record.result.changedPaths, record.allowedPaths, { ignored: "runtime" });
    } else {
      if (head !== record.commit || !(await matchingCommitsIn(path, record)).includes(head) ||
          !await validatePublishedCommit(path, record, head) || (await statusEntries(path, false)).length)
        throw new Error("Unpublished checkout contains changes outside its recorded hook commit");
      if (await this.remoteCarriesCommit(task, record, head)) throw new Error("Unpublished checkout absence from the remote could not be proved");
    }
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
}

function okResult(record: HookRecord): HookResult {
  return { schema: RESULT_SCHEMA, eventId: record.eventId, outcome: "ok", summary: record.summary || "Reconciled hook publication", metadata: {}, changedPaths: record.result?.changedPaths ?? [], commitSubjectSuffix: null };
}

/** A bounded UTF-8 stderr excerpt for a failing hook. Never returns unbounded output. */
function boundedStderrExcerpt(stderr: Buffer, maxBytes: number = STDERR_EXCERPT_MAX_BYTES): string {
  const text = stderr.toString("utf8").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  // Do not split a UTF-8 sequence: step back over continuation bytes.
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}…[truncated]`;
}

/** The existing stored error limit a failing hook's evidence must fit inside. */
export const HOOK_EVIDENCE_MAX_BYTES = 4000;

/**
 * Task 389: the evidence a hook leaves when its wrapper exited but did not
 * produce an acceptable result. A structured `blocked`/`failed` result, or a
 * result Queue could not parse, used to keep only the summary (or the parse
 * complaint) while a non-zero exit kept its bounded stderr excerpt. The three
 * facts stay separate and none is invented: the wrapper exit status, the result
 * state (or that no usable result came back), and the stderr bytes the program
 * actually wrote. Queue never infers an inner exit code and never claims there
 * was nothing to stop; absent stderr is simply not mentioned.
 */
function failedResultEvidence(outcome: ExecutionOutcome, detail: string): string {
  const head = `Hook exited with code ${outcome.code ?? "unknown"}${outcome.signal ? ` (${outcome.signal})` : ""} but ${detail}`;
  const separator = "; stderr: ";
  const room = HOOK_EVIDENCE_MAX_BYTES - Buffer.byteLength(head, "utf8") - Buffer.byteLength(separator, "utf8");
  if (room <= 0) return head;
  const excerpt = boundedStderrExcerpt(outcome.stderr, Math.min(STDERR_EXCERPT_MAX_BYTES, room));
  return excerpt ? `${head}${separator}${excerpt}` : head;
}

function executionFailure(outcome: ExecutionOutcome, record: HookRecord): string | null {
  const terminationDetail = outcome.terminationError || (outcome.processGroupEmpty === false ? "process group remained after termination" : "");
  if (outcome.timedOut) return `Hook exceeded its ${record.timeoutMs}ms timeout${terminationDetail ? `; ${terminationDetail}` : ""}`;
  if (outcome.stdoutExceeded || outcome.stderrExceeded)
    return `Hook exceeded its ${record.maxOutputBytes}-byte output limit${terminationDetail ? `; ${terminationDetail}` : ""}`;
  if (outcome.terminationError || outcome.processGroupEmpty === false)
    return outcome.terminationError || "Hook process group was not empty after termination";
  if (outcome.code !== 0) {
    const excerpt = boundedStderrExcerpt(outcome.stderr);
    return `Hook exited with code ${outcome.code ?? "unknown"}${outcome.signal ? ` (${outcome.signal})` : ""}${excerpt ? `; stderr: ${excerpt}` : ""}`;
  }
  return null;
}

/**
 * Prove the retention gate still observes the exact retained worktree it was
 * pinned to. The before/after snapshot is the mutation proof; this establishes
 * that the worktree exists and has not moved to another head. The worktree is
 * not required to be clean of pre-existing worker output.
 */
/**
 * The retained worktree head a pre-archive occurrence must still observe: the
 * reconciled task head for a merged-task reconciliation at the integration
 * base, otherwise the pinned worktree-head base itself.
 */
function preArchiveWorktreeHead(record: Pick<HookRecord, "baseCommit" | "retentionReconciliation">): string {
  return record.retentionReconciliation?.taskHead ?? record.baseCommit;
}

/** Non-throwing reviewed-head cleanliness proof used by restart reconciliation. */
async function reviewedHeadIsClean(task: Task, record: HookRecord): Promise<boolean> {
  if (!task.directory) return false;
  try { await verifyReviewedHead(task.directory, task.branch, record.baseCommit); return true; }
  catch { return false; }
}

async function matchingCommitsIn(root: string, record: HookRecord): Promise<string[]> {
  const log = await gitRaw(root, ["log", "--format=%H", "-n", "200"]);
  if (log.code !== 0) return [];
  const matches: string[] = [];
  for (const sha of log.stdout.toString("utf8").split("\n").map(line => line.trim()).filter(Boolean)) {
    const body = await gitText(root, "show", "-s", "--format=%B", sha);
    if (body.includes(`Northstar-Queue-Hook: ${record.eventId}`) && body.includes(`Northstar-Queue-Manifest: ${record.manifest.path}@${record.manifest.digest}`)) matches.push(sha);
  }
  return matches;
}

async function validatePublishedCommit(root: string, record: HookRecord, commit: string): Promise<boolean> {
  try {
    const parent = await gitText(root, "rev-parse", `${commit}^`);
    if (parent !== record.baseCommit) return false;
    const declared = new Set(record.result?.changedPaths ?? []);
    let valid = true;
    await gitNulEach(root, ["diff-tree", "--no-commit-id", "--name-only", "-z", "-r", commit], path => {
      if (!declared.has(path) || !pathIsAllowed(path, record.allowedPaths)) valid = false;
    });
    if (!valid) return false;
    return true;
  } catch { return false; }
}
