import { existsSync } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  EVENT_SCHEMA, joinCommitSubject, pathIsAllowed, type HookRecord, type HookResult,
} from "../../shared/hooks";
import type { Task } from "../../shared/contracts";
import { type Store, now } from "../store/store";
import { gitText, snapshotGit, statusEntries, ignoredPathCollides, inspectChangedPaths, isolatedRepositoryIsCleanAt, type GitSnapshot } from "../git/git-snapshot";
import { gitRun, } from "../git/git-command";
import { gitNulEach } from "../git/git-command";
import { blobDigest } from "./hook-manifest";
import { executablePath, hookProgramExecutable, type HookEmissionResult } from "./hook-context";
import { okResult } from "./hook-occurrence";
import { executionFailure, failedResultEvidence, minimalHookEnvironment, parseHookResult } from "./hook-result";
import type { ExecutionOutcome, ExecutionRequest } from "../machine/process-exec";
import type { HookCheckouts } from "./hook-checkouts";

/**
 * The integration-write effect of one hook occurrence: custody of the Queue-owned
 * isolated checkout, the pinned program's execution, the declared-path commit,
 * the publication push, the canonical fast-forward and the cleanup.
 *
 * One owner for publication. It never invents a change: every path committed is
 * declared by the hook's own result and allowed by the pinned manifest, and a
 * boundary it cannot prove becomes an uncertain occurrence rather than a success.
 */
export interface HookPublicationContext {
  store: Store;
  checkouts: Pick<HookCheckouts, "verifyCleanSynchronizedBase" | "removeIsolatedCheckout">;
  run: (request: ExecutionRequest) => Promise<ExecutionOutcome>;
  save: (record: HookRecord, changes: Partial<HookRecord>) => HookRecord;
  fail: (record: HookRecord, error: string) => HookRecord;
  uncertain: (record: HookRecord, error: string) => HookRecord;
  settle: (record: HookRecord, result: HookResult, extra?: Partial<HookRecord>) => HookRecord;
  result: (record: HookRecord) => HookEmissionResult;
}

export class HookPublication {
  constructor(private readonly context: HookPublicationContext) {}
  private get store() { return this.context.store; }
  private get save() { return this.context.save; }
  private get fail() { return this.context.fail; }
  private get uncertainSync() { return this.context.uncertain; }
  private get settle() { return this.context.settle; }
  private get result() { return this.context.result; }
  private get run() { return this.context.run; }
  get removeIsolatedCheckout() { return (task: Task, path: string, force: boolean) => this.context.checkouts.removeIsolatedCheckout(task, path, force); }
  private get verifyCleanSynchronizedBase() { return (root: string, baseBranch: string, baseCommit: string) => this.context.checkouts.verifyCleanSynchronizedBase(root, baseBranch, baseCommit); }

  async executeIntegrationWrite(task: Task, record: HookRecord, stdin: Buffer, path: string): Promise<HookEmissionResult> {
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
      const executable = await hookProgramExecutable(current, path);
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
  async syncCanonical(root: string, baseBranch: string, baseCommit: string, target: string): Promise<string | null> {
    try {
      if (await gitText(root, "branch", "--show-current") !== baseBranch) return "canonical checkout is not on the base branch";
      if ((await statusEntries(root, false)).length) return "canonical checkout has tracked or untracked changes";
      const head = await gitText(root, "rev-parse", "HEAD");
      if (head !== target) {
        if ((await gitRun(root, ["merge-base", "--is-ancestor", head, target])).code !== 0) return "canonical HEAD diverged from the published history";
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

  async cleanupPublished(task: Task, record: HookRecord): Promise<HookRecord> {
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
  async matchingCommits(task: Task, record: HookRecord): Promise<string[]> {
    const roots = [task.repoPath];
    if (record.workspace?.path && existsSync(record.workspace.path)) roots.push(record.workspace.path);
    const found = new Set<string>();
    for (const root of roots) for (const sha of await matchingCommitsIn(root, record)) found.add(sha);
    return [...found];
  }

  /** True when the remote branch already carries this commit. */
  async remoteCarriesCommit(task: Task, record: HookRecord, commit: string | null): Promise<boolean> {
    if (!commit) return false;
    try {
      await gitText(task.repoPath, "fetch", "origin", record.baseBranch);
      let root = task.repoPath;
      let remote = await gitText(root, "rev-parse", `refs/remotes/origin/${record.baseBranch}`);
      if ((await gitRun(root, ["cat-file", "-e", `${commit}^{commit}`])).code !== 0) {
        // An isolated clone can hold the only copy of a rejected publication.
        // Fetch the canonical publication remote there before asking ancestry.
        root = record.workspace?.path ?? "";
        if (!root || (await gitRun(root, ["cat-file", "-e", `${commit}^{commit}`])).code !== 0) return true;
        const origin = await gitText(task.repoPath, "remote", "get-url", "origin");
        await gitText(root, "fetch", origin, record.baseBranch);
        remote = await gitText(root, "rev-parse", "FETCH_HEAD");
      }
      const ancestry = await gitRun(root, ["merge-base", "--is-ancestor", commit, remote]);
      return ancestry.code !== 1; // Only Git's proven non-ancestor result establishes absence.
    } catch {
      // An unreadable remote is not proof of absence, so refuse and keep the stronger path.
      return true;
    }
  }

  /** True when the remote branch already carries the record's published commit. */
  async remoteCarries(task: Task, record: HookRecord): Promise<boolean> {
    return this.remoteCarriesCommit(task, record, record.commit);
  }

  /** Reconcile one push-intent occurrence: prove the remote carries it, then synchronize and clean up. */
  async reconcilePush(record: HookRecord): Promise<HookRecord> {
    if (!record.commit) return record;
    const task = this.store.task(record.taskId);
    try {
      await gitText(task.repoPath, "fetch", "origin", record.baseBranch);
      const remote = await gitText(task.repoPath, "rev-parse", `refs/remotes/origin/${record.baseBranch}`);
      const contains = remote === record.commit || (await gitRun(task.repoPath, ["merge-base", "--is-ancestor", record.commit, remote])).code === 0;
      if (!contains) return this.uncertainSync(record, `Remote ${record.baseBranch} does not contain published commit ${record.commit}`);
      const syncError = await this.syncCanonical(task.repoPath, record.baseBranch, record.baseCommit, remote);
      if (syncError) return this.uncertainSync(record, `Canonical synchronization requires reconciliation: ${syncError}`);
      return this.cleanupPublished(task, this.save(this.store.hookEvent(record.id)!, { state: "synced", reconciledAt: now() }));
    } catch (error) {
      return this.uncertainSync(record, `Push reconciliation failed: ${String(error)}`);
    }
  }

  /** A policy-violating execution inside the Queue-owned checkout keeps the canonical repository untouched. */
  async failIntegrationWrite(record: HookRecord, error: string, result?: HookResult): Promise<HookRecord> {
    const next = result ? this.save(record, { result }) : record;
    if (await this.workspaceMutated(next)) return this.uncertainSync(next, `${error}; isolated checkout was mutated and needs bounded reconciliation`);
    return this.fail(next, error);
  }

  async workspaceMutated(record: HookRecord): Promise<boolean> {
    const path = record.workspace?.path;
    if (!path || !existsSync(path)) return false;
    try {
      if (await gitText(path, "rev-parse", "HEAD") !== record.baseCommit) return true;
      return (await statusEntries(path, false)).length > 0;
    } catch { return true; }
  }
}

export async function matchingCommitsIn(root: string, record: HookRecord): Promise<string[]> {
  const log = await gitRun(root, ["log", "--format=%H", "-n", "200"]);
  if (log.code !== 0) return [];
  const matches: string[] = [];
  for (const sha of log.stdout.toString("utf8").split("\n").map(line => line.trim()).filter(Boolean)) {
    const body = await gitText(root, "show", "-s", "--format=%B", sha);
    if (body.includes(`Northstar-Queue-Hook: ${record.eventId}`) && body.includes(`Northstar-Queue-Manifest: ${record.manifest.path}@${record.manifest.digest}`)) matches.push(sha);
  }
  return matches;
}

export async function validatePublishedCommit(root: string, record: HookRecord, commit: string): Promise<boolean> {
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
