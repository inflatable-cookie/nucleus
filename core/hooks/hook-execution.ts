import { EVENT_SCHEMA, type HookRecord, type HookResult, type NormalizedHookDefinition } from "../../shared/hooks";
import type { Task } from "../../shared/contracts";
import type { Store } from "../store/store";
import { gitText, verifyMergeCandidate, verifyRetainedWorktree, verifyReviewedHead, type GitSnapshot } from "../git/git-snapshot";
import { gitRaw } from "../git/git-command";
import type { ExecutionOutcome, ExecutionRequest } from "../machine/process-exec";
import {
  hookProgramExecutable, hookRecordTarget, preArchiveWorktreeHead,
  type HookContext, type HookEmissionResult,
} from "./hook-context";
import type { HookOccurrences } from "./hook-occurrence";
import { executionFailure, failedResultEvidence, minimalHookEnvironment, parseHookResult } from "./hook-result";
import type { HookPublication } from "./hook-publication";
import type { ManifestDiscovery } from "./hook-manifest";
import type { ProspectiveMerge } from "../merge/prospective-merge";
import type { HookReplay } from "./hook-replay";
import type { HookCheckouts } from "./hook-checkouts";

/**
 * Execute one durable hook occurrence.
 *
 * One owner for the per-event section, the execution root each event observes,
 * the read-only mutation proof (before/after snapshot, target drift, a base that
 * fast-forwarded to a published origin tip) and the dispatch to the
 * integration-write publication. The occurrence record is already durable before
 * this runs; a boundary it cannot prove becomes `uncertain`, never a success.
 */
export interface HookExecutionContext {
  store: Store;
  checkouts: Pick<HookCheckouts, "isolationPath">;
  occurrences: HookOccurrences;
  publication: HookPublication;
  prospectiveMerge: Pick<ProspectiveMerge, "ensureProspectiveCandidate" | "prospectiveProgramDrift">;
  hookReplay: Pick<HookReplay, "supersedeForBaseAdvance">;
  reconcile: (record: HookRecord) => Promise<HookRecord>;
  /** The repository program materialized at a reconciled integration base, when this occurrence is one. */
  materializeReconciledProgram: (task: Task, record: HookRecord) => Promise<{ path: string; cleanup: () => Promise<void> } | null>;
  run: (request: ExecutionRequest) => Promise<ExecutionOutcome>;
  snapshot: (root: string) => Promise<GitSnapshot>;
}

export class HookExecution {
  constructor(private readonly context: HookExecutionContext) {}
  private get store() { return this.context.store; }
  private get save() { return (record: HookRecord, changes: Partial<HookRecord>) => this.context.occurrences.save(record, changes); }
  private get settle() { return (record: HookRecord, result: HookResult, extra?: Partial<HookRecord>) => this.context.occurrences.settle(record, result, extra); }
  private get fail() { return (record: HookRecord, error: string) => this.context.occurrences.fail(record, error); }
  private get uncertainSync() { return (record: HookRecord, error: string) => this.context.occurrences.uncertain(record, error); }
  private get result() { return (record: HookRecord) => this.context.occurrences.result(record); }
  private get deliveryEvent() { return (record: HookRecord, root: string) => this.context.occurrences.deliveryEvent(record, root); }
  private get isolationPath() { return (task: Task, eventId: string) => this.context.checkouts.isolationPath(task, eventId); }
  private get run() { return this.context.run; }

  async runHook(task: Task, hook: NormalizedHookDefinition, discovery: ManifestDiscovery, context: HookContext): Promise<HookEmissionResult> {
    return this.withHookEventLock(`${task.id}\u0000${hook.id}\u0000${context.event}`, () => this.runHookOnce(task, hook, discovery, context));
  }

  /** Hold one logical key's in-process section, for a caller that must serialize with execution. */
  withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    return this.withHookEventLock(key, work);
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
    const record = await this.context.occurrences.intent(task, hook, discovery, context);
    return this.executeRecordedHook(task, hook, record);
  }

  /**
   * Execute one already-minted occurrence under the per-event lock. Unlike
   * {@link runHook}, this bypasses the open-record search, so a reconciliation
   * occurrence always runs its own pins even when an older occurrence answers
   * for the same target: the search would otherwise resume the stale refusal
   * and leave the fresh intent orphaned.
   */
  async runRecordedHook(task: Task, hook: NormalizedHookDefinition, record: HookRecord): Promise<HookEmissionResult> {
    return this.withHookEventLock(`${task.id}\u0000${hook.id}\u0000${record.event}`, () => this.executeRecordedHook(task, hook, record));
  }

  /** Reconcile one minted occurrence and execute its pinned program when due. */
  private async executeRecordedHook(task: Task, hook: NormalizedHookDefinition, record: HookRecord): Promise<HookEmissionResult> {
    if (this.store.task(task.id).resolution.ownerSettlements.some(item => item.effect === `hook.${record.eventId}`))
      return { hold: false, attention: false, records: [record] };
    record = await this.context.reconcile(record);
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
      const ensured = await this.context.prospectiveMerge.ensureProspectiveCandidate(task, record);
      if (!ensured.ok) return this.result(this.fail(record, ensured.detail));
      record = this.store.hookEvent(record.id) ?? record;
    }
    const root = await this.deliverRoot(task, record);
    const event = this.deliveryEvent(record, root);
    const stdout = Buffer.from(JSON.stringify(event), "utf8");
    if (record.mode === "integration_write") {
      return this.context.publication.executeIntegrationWrite(task, record, stdout, root);
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
    try { before = await this.context.snapshot(root); } catch (error) {
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
      const missing = await this.context.prospectiveMerge.prospectiveProgramDrift(root, record);
      if (missing) return this.result(this.fail(this.store.hookEvent(record.id)!, missing));
    }
    // A reconciliation runs the repository program blob pinned at the
    // integration base, not the retained-worktree file at the refused head:
    // a gate-program repair merged to main is pinned and must be what runs.
    // The execution root stays the retained worktree, which is never written.
    let materialized: { path: string; cleanup: () => Promise<void> } | null = null;
    try {
      materialized = await this.context.materializeReconciledProgram(task, record);
    } catch (error) {
      return this.result(this.fail(this.store.hookEvent(record.id)!,
        `Retention reconciliation program is unavailable: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.store.event(task.id, "hook_execution_started", `${record.hookId} ${record.event} ${record.eventId} attempt ${record.attempt}`);
    let outcome: ExecutionOutcome;
    try {
      const executable = materialized?.path ?? await hookProgramExecutable(record, root);
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
        return this.result(this.context.hookReplay.supersedeForBaseAdvance(current, before.head, after.head));
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
      return this.result(this.context.hookReplay.supersedeForBaseAdvance(current, before.head, after.head));
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

  private async safeSnapshot(root: string): Promise<GitSnapshot | null> { try { return await this.context.snapshot(root); } catch { return null; } }
}
