import { existsSync } from "node:fs";
import type { HookRecord, HookResult } from "../../shared/hooks";
import type { Task } from "../../shared/contracts";
import { type Store, now } from "../store/store";
import { repositoryIsCleanAt, isolatedRepositoryIsCleanAt, verifyMergeCandidate, verifyRetainedWorktree, verifyReviewedHead } from "../git/git-snapshot";
import { gitText } from "../git/git-snapshot";
import { pidAlive } from "../machine/process-identity";
import { hookRecordTarget, preArchiveWorktreeHead, type HookEmissionResult } from "./hook-context";
import { okResult } from "./hook-occurrence";
import { validatePublishedCommit, type HookPublication } from "./hook-publication";

/**
 * Reconcile one durable occurrence against the repository and the remote after a
 * restart, before any execution or retry decides what to do with it.
 *
 * One owner for the reconciliation state machine: a checkout-creation intent, a
 * running execution, a commit or push intent, a synchronization intent and a
 * pending cleanup each have exactly one recovery proof. Anything the proof
 * cannot establish stays `uncertain`; unknown delivery is never read as absent.
 */
export interface HookReconcileContext {
  store: Store;
  publication: Pick<HookPublication,
    "matchingCommits" | "reconcilePush" | "syncCanonical" | "cleanupPublished" | "removeIsolatedCheckout">;
  save: (record: HookRecord, changes: Partial<HookRecord>) => HookRecord;
  uncertain: (record: HookRecord, error: string) => HookRecord;
  settle: (record: HookRecord, result: HookResult, extra?: Partial<HookRecord>) => HookRecord;
  result: (record: HookRecord) => HookEmissionResult;
}

export class HookReconciler {
  constructor(private readonly context: HookReconcileContext) {}
  private get store() { return this.context.store; }
  private get save() { return (record: HookRecord, changes: Partial<HookRecord>) => this.context.save(record, changes); }
  private get uncertainSync() { return (record: HookRecord, error: string) => this.context.uncertain(record, error); }
  private get settle() { return this.context.settle; }
  private get matchingCommits() { return (task: Task, record: HookRecord) => this.context.publication.matchingCommits(task, record); }
  private get reconcilePush() { return (record: HookRecord) => this.context.publication.reconcilePush(record); }
  private get syncCanonical() { return (root: string, baseBranch: string, baseCommit: string, target: string) => this.context.publication.syncCanonical(root, baseBranch, baseCommit, target); }
  private get cleanupPublished() { return (task: Task, record: HookRecord) => this.context.publication.cleanupPublished(task, record); }
  private get removeIsolatedCheckout() { return (task: Task, path: string, force: boolean) => this.context.publication.removeIsolatedCheckout(task, path, force); }

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
}

/** Non-throwing reviewed-head cleanliness proof used by restart reconciliation. */
async function reviewedHeadIsClean(task: Task, record: HookRecord): Promise<boolean> {
  if (!task.directory) return false;
  try { await verifyReviewedHead(task.directory, task.branch, record.baseCommit); return true; }
  catch { return false; }
}
