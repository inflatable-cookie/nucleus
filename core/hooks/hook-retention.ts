import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EVENT_SCHEMA_V4, hookRecordSchema, hookEventV4Schema, hookHoldsTransition, supersededRetentionReconciliation,
  hookStateIsTerminal, type HookRecord, type NormalizedHookDefinition,
} from "../../shared/hooks";
import type { Task } from "../../shared/contracts";
import { type Store, digest, now } from "../store/store";
import { gitText, statusEntries } from "../git/git-snapshot";
import { gitRaw, formatGitError } from "../git/git-command";
import { blobDigest, discoverManifest, pinProgram, type ManifestDiscovery } from "./hook-manifest";
import { hookHoldReason, type HookContext, type HookEmissionResult } from "./hook-context";

/**
 * How many hook-cleanup errors a health read carries. Audit A10: the stored record
 * accumulated 4,432 "Task history was purged" strings (425 KB) and every `health()`
 * call read it on every push and every RPC. The count stays exact and each carried
 * entry keeps its event identity and the reason, so nothing actionable is lost.
 */
export const HOOK_CLEANUP_ERROR_LIMIT = 20;

/**
 * True when a task's retention must wait for this hook record (audit B5). Hook
 * records are the only proof of ownership for an isolated checkout, so the purge
 * deletes a task's rows only when every record is settled:
 *
 * - a record still naming a checkout that exists may own that directory;
 * - a record whose execution has not settled may own a derived one that no caller
 *   has proved absent, and unknown delivery is never read as gone. `uncertain` is
 *   deliberately not terminal here even though the reaper may reap it;
 * - a settled record with no recorded checkout is Queue's own statement that it
 *   holds none: every path clears the handle only after the directory is removed.
 */
export function hookRetentionBlocksPurge(record: HookRecord, exists: (path: string) => boolean): boolean {
  const recorded = record.workspace?.path;
  if (recorded && exists(resolve(recorded))) return true;
  return !hookStateIsTerminal(record.state);
}

/**
 * The record shape the reaper may dispose of and the shape the purge gate trusts:
 * one closed integration-write occurrence of an event-owned checkout. A read-only,
 * prospective-merge or advisory occurrence owns no checkout this reaper removes.
 */
export function hookRecordOwnsIntegrationCheckout(record: HookRecord): boolean {
  return record.mode === "integration_write" && record.target === "integration_base"
    && hookStateIsTerminal(record.state);
}

/** Attempts a timed-out read-only pre-archive occurrence gets in all before its hold stands (Tom, 2026-10-19). */
export const RETENTION_TIMEOUT_ATTEMPTS = 3;

/** v4 reconciliation payload identity: a merged done task's gate re-run pinned at the integration base. */
const RETENTION_RECONCILIATION_TARGET = "merged_integration_base" as const;
const RETENTION_RECONCILIATION_ROUTE = "merged_task_reconciliation" as const;

/**
 * The consumer-owned pre-archive retention gate and its explicit reconciliation.
 *
 * One owner for the retention mechanism: the ordinary gate at the retained
 * worktree head, the bounded rerun of an attempt that only timed out, the settled
 * merged-task reconciliation that answers for the same worktree and head, and the
 * operator control that re-gates at the current integration base. The worktree is
 * preserved until every required read-only hook settles: refusal, failure,
 * timeout and uncertainty all hold.
 */
export interface HookRetentionContext {
  store: Store;
  save: (record: HookRecord, changes: Partial<HookRecord>) => HookRecord;
  lock: <T>(key: string, work: () => Promise<T>) => Promise<T>;
  /** Emit one lifecycle event to every bound hook in the repository's pinned manifest. */
  emit: (event: "task.pre_archive", task: Task, context: HookContext) => Promise<HookEmissionResult>;
  /** Run one already-minted occurrence, bypassing the open-record search. */
  runRecordedHook: (task: Task, hook: NormalizedHookDefinition, record: HookRecord) => Promise<HookEmissionResult>;
  /** Retry one recorded occurrence through the ordinary retry path. */
  retry: (task: Task, hookEventId: string, discardUnpublishedCheckout?: boolean, cleanupOnly?: boolean) => Promise<HookEmissionResult>;
}

export class HookRetentionGate {
  constructor(private readonly context: HookRetentionContext) {}
  private get store() { return this.context.store; }
  private get save() { return this.context.save; }
  private get retry() { return this.context.retry; }

  /**
   * The consumer-owned pre-archive retention gate. Before Queue archives a
   * retained task worktree for any reason, every required read-only
   * `task.pre_archive` hook bound in the repository's pinned manifest may refuse
   * with its own evidence. The worktree is preserved until the hook settles:
   * refusal, failure, timeout and uncertainty all hold. A repository with no
   * bound hook returns an empty, non-holding result and archives as before.
   */
  async gate(task: Task, target: { directory: string; head: string; reason: string }): Promise<HookEmissionResult> {
    await this.rerunTimedOutRetention(task, target.directory);
    // A settled merged-task reconciliation answers for the same retained
    // worktree and head without re-running the stale worktree-head gate: a
    // success satisfies the gate, a refusal stays a hold with its evidence.
    // Any other change (moved head, different workspace) re-gates normally.
    const reconciled = this.settledReconciliation(task, target);
    if (reconciled) return reconciled;
    return this.context.emit("task.pre_archive", task, {
      event: "task.pre_archive", baseCommit: target.head, baseBranch: task.baseBranch,
      summary: target.reason, worktree: target.directory,
    });
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
    const outcome = await this.gate(task, { directory: task.directory, head, reason: "Disposition archive of the task workspace" });
    return outcome.hold ? { hold: true, detail: hookHoldReason(outcome) } : { hold: false, detail: "" };
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
    await this.context.lock(`retention-timeout-rerun\u0000${task.id}\u0000${directory}`, async () => {
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
  private settledReconciliation(task: Task, target: { directory: string; head: string }): HookEmissionResult | null {
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
  async retryAtIntegrationBase(task: Task, reason: string): Promise<HookEmissionResult> {
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
    return this.context.runRecordedHook(current, hook, record);
  }

  /**
   * Materialize the repository program blob pinned at the reconciled
   * integration base into a Queue-owned ephemeral executable outside the
   * retained worktree. The retained worktree is at the refused head, so
   * spawning its file would run the stale gate program; the pinned digest is
   * re-proven against the object store before anything executes. Returns null
   * for every other occurrence, which keeps spawning its own execution root.
   */
  async materializeReconciledProgram(task: Task, record: HookRecord): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
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
}
