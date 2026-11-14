import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { normalizeRepoRelativePath, pathIsAllowed, type HookRecord, type NormalizedHookDefinition } from "../../shared/hooks";
import type { Task } from "../../shared/contracts";
import { type Store, now } from "../store/store";
import { gitText, statusEntries, inspectChangedPaths, isolatedRepositoryIsCleanAt, verifyReviewedHead, verifyRetainedWorktree } from "../git/git-snapshot";
import { gitRaw } from "../git/git-command";
import { removeTree } from "../workspaces/tree-removal";
import { discoverManifest, instructionForCommit, pinExecutable, pinProgram, type ManifestDiscovery } from "./hook-manifest";
import { hookRecordTarget, preArchiveWorktreeHead, type HookContext, type HookEmissionResult } from "./hook-context";
import type { HookOccurrences } from "./hook-occurrence";
import { matchingCommitsIn, validatePublishedCommit, type HookPublication } from "./hook-publication";
import type { HookReplay } from "./hook-replay";
import type { HookCheckouts } from "./hook-checkouts";
import type { HookExecution } from "./hook-execution";

/** Task-history kind recorded when a proven pre-commit uncertainty returns to retryable intent. */
const PRE_COMMIT_RECOVERED_KIND = "hook_pre_commit_recovered";
const READ_ONLY_RECOVERED_KIND = "hook_read_only_recovered";

/**
 * Retry and disposal of one held hook occurrence.
 *
 * One owner for the proofs an operator retry stands on: a read-only uncertain
 * occurrence must show its clean base or retained worktree still intact, an
 * integration write must prove it stopped before Queue's commit intent, and an
 * explicit discard must prove the checkout disposable and the remote free of it.
 * Every other shape refuses with the reason to reconcile first; nothing here
 * infers execution authority from a filesystem the proof does not cover.
 */
export interface HookRetryContext {
  store: Store;
  checkouts: Pick<HookCheckouts, "isolationPath" | "removeIsolatedCheckout" | "verifyCleanSynchronizedBase">;
  publication: Pick<HookPublication, "matchingCommits" | "remoteCarriesCommit">;
  execution: Pick<HookExecution, "runHook" | "runRecordedHook">;
  hookReplay: Pick<HookReplay,
    "renewAdvancedPreDispatch" | "rollRepairedCloseoutOccurrence" | "rollRepairedCancellationOccurrence" | "rollRepairedBlockedOccurrence">;
  occurrences: HookOccurrences;
  reconcile: (record: HookRecord) => Promise<HookRecord>;
}

export class HookRetry {
  constructor(private readonly context: HookRetryContext) {}
  private get store() { return this.context.store; }
  private get save() { return (record: HookRecord, changes: Partial<HookRecord>) => this.context.occurrences.save(record, changes); }
  private get result() { return (record: HookRecord) => this.context.occurrences.result(record); }
  private get isolationPath() { return (task: Task, eventId: string) => this.context.checkouts.isolationPath(task, eventId); }
  private get removeIsolatedCheckout() { return (task: Task, path: string, force: boolean) => this.context.checkouts.removeIsolatedCheckout(task, path, force); }
  private get verifyCleanSynchronizedBase() { return (root: string, baseBranch: string, baseCommit: string) => this.context.checkouts.verifyCleanSynchronizedBase(root, baseBranch, baseCommit); }
  private get matchingCommits() { return (task: Task, record: HookRecord) => this.context.publication.matchingCommits(task, record); }
  private get remoteCarriesCommit() { return (task: Task, record: HookRecord, commit: string | null) => this.context.publication.remoteCarriesCommit(task, record, commit); }
  private get reconcile() { return this.context.reconcile; }
  private get runHook() { return (task: Task, hook: NormalizedHookDefinition, discovery: ManifestDiscovery, context: HookContext) => this.context.execution.runHook(task, hook, discovery, context); }
  private get runRecordedHook() { return (task: Task, hook: NormalizedHookDefinition, record: HookRecord) => this.context.execution.runRecordedHook(task, hook, record); }

  /** Retry one reconciled hook event with its durable occurrence facts and a single higher confirmed attempt. */
  async retryOccurrence(task: Task, hookEventId: string, discardUnpublishedCheckout = false, cleanupOnly = false): Promise<HookEmissionResult> {
    const byRecord = this.store.hookEvent(hookEventId);
    const byEvent = this.store.hookEvents(task.id).filter(candidate => candidate.eventId === hookEventId);
    if (byEvent.length > 1) throw new Error("Multiple hook records share that event ID");
    const found = byRecord ?? byEvent[0] ?? null;
    if (!found || found.taskId !== task.id) throw new Error("Hook record not found for this task");
    if (cleanupOnly && !discardUnpublishedCheckout) throw new Error("Cleanup-only requires explicit unpublished checkout discard");
    if (discardUnpublishedCheckout) return this.discardUnpublishedOccurrence(task, found, cleanupOnly);
    if (found.checkoutDiscard) throw new Error("This occurrence is held after checkout disposal; an explicit discard retry is required to run a replacement");
    const renewed = await this.context.hookReplay.renewAdvancedPreDispatch(task, found);
    if (renewed) return renewed;
    let record = await this.reconcile(found);
    if (["published", "result"].includes(record.state)) return this.result(record);
    const rolled = await this.context.hookReplay.rollRepairedCloseoutOccurrence(task, record, true);
    if (rolled) return rolled;
    if (record.event === "task.blocked" && record.state === "blocked") {
      const baseCommit = await gitText(task.repoPath, "rev-parse", `refs/heads/${record.baseBranch}`);
      const renewed = await this.context.hookReplay.rollRepairedBlockedOccurrence(task, record, baseCommit);
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
        const renewed = await this.context.hookReplay.rollRepairedCancellationOccurrence(task, record, baseCommit, hook, discovery, {
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
      else await removeTree(path);
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
}
