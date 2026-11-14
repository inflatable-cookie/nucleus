import { lstat, readdir, realpath, rm, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Store } from '../store/store';
import type { Task } from '../../shared/contracts';
import { hookStateIsTerminal, type HookRecord } from '../../shared/hooks';
import {
  gitRaw, isolationDataDirFor, isolationPathFor, isolationRootFor,
  warmCandidatePathFor,
} from './hooks';
import { git } from '../git/index';
import { digest } from '../store/store';
import { HOOK_CLEANUP_ERROR_LIMIT, hookRecordOwnsIntegrationCheckout } from './hook-retention';

export interface HookCleanupHealth {
  checkedAt: string;
  orphanCount: number;
  /** Bytes measured only for checkouts selected for reaping. */
  orphanBytes: number;
  reapedCount: number;
  reapedBytes: number;
  remainingCount: number;
  unavailableRepositoryCount: number;
  /**
   * Orphan records reconciled because their own recorded checkout was positively
   * absent, so no row was deleted while an owned path might still exist (audit B5).
   */
  reconciledCount: number;
  /** Every failure this pass, including the ones past the carried list below. */
  errorCount: number;
  /** The first `HOOK_CLEANUP_ERROR_LIMIT` failures, each naming the event and the reason. */
  errors: string[];
}

const HOOK_READ_PAGE = 250;
const HOOK_WALK_SLICE = 25;
/** Unknown orphan owners get a bounded grace period after which only their exact isolated checkout is eligible. */
export const UNOWNED_ISOLATION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

async function treeBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return info.size;
  let bytes = info.size;
  for (const name of await readdir(path)) bytes += await treeBytes(join(path, name));
  return bytes;
}

/**
 * Reap only exact event directories with durable, no-longer-retryable ownership.
 *
 * Audit B5/A10: the walk is linear. Eligibility used to ask `records.some(...)` twice
 * per record (O(n²) over 10,679 occurrences) and called `store.task` for every record,
 * which throws for a task the retention purge already removed. Tasks are read once,
 * the supersession and shared-event questions are answered from indexes built in one
 * pass, and the occurrence table is read in pages so the runtime thread keeps serving
 * the host-run endpoint and board reads while the hourly pass runs.
 *
 * An occurrence whose task is gone can no longer be reaped through a task-derived
 * ownership path, so it is reconciled only on the record's own evidence: its recorded
 * checkout is probed and, when the path is positively absent, the orphan row goes.
 * A settled occurrence that names no checkout holds none, so its row goes too (task
 * 987). A path that exists keeps the row and is counted in the pass's orphan figures;
 * one that cannot be read keeps it and is recorded as a failure.
 */
export async function reapHookCheckouts(store: Store, options: { taskIds?: ReadonlySet<string> | null } = {}): Promise<HookCleanupHealth> {
  const health: HookCleanupHealth = { checkedAt: new Date().toISOString(), orphanCount: 0, orphanBytes: 0,
    reapedCount: 0, reapedBytes: 0, remainingCount: 0, unavailableRepositoryCount: 0, reconciledCount: 0,
    errorCount: 0, errors: [] };
  const fail = (identity: string, error: unknown) => {
    health.errorCount++;
    if (health.errors.length < HOOK_CLEANUP_ERROR_LIMIT) health.errors.push(`${identity}: ${String(error)}`.slice(0, 500));
  };
  const throughRowid = Number(store.db.prepare("SELECT COALESCE(MAX(rowid),0) AS last FROM hook_events").get()!.last);
  async function* records() {
    for (let cursor = 0;;) {
      const page = store.hookEventsPage(cursor, HOOK_READ_PAGE, throughRowid);
      if (!page.records.length) return;
      for (const record of page.records) yield record;
      cursor = page.lastRowid;
      await yieldToEventLoop();
    }
  }
  const tasks = new Map<string, Task | null>();
  const taskOf = (id: string): Task | null => {
    if (!tasks.has(id)) tasks.set(id, store.taskOrNull(id));
    return tasks.get(id)!;
  };
  const eligible = (record: HookRecord, task: Task | null): boolean => {
    if (!hookRecordOwnsIntegrationCheckout(record)) return false;
    // An orphan record cannot be judged settled: its task's phase is gone, so the only
    // terminal evidence left is the record's own state, which the reconciliation below
    // already accounts for.
    if (!task) return false;
    if (task.phase === 'done' || task.phase === 'cancelled' && task.disposition?.status === 'complete') return true;
    if (record.state === 'published') return true;
    // A superseded occurrence can never execute again; its successor has a different event ID.
    if (record.state !== 'failed' || !record.summary.startsWith('Superseded before publication')) return false;
    const logical = logicalEvents.get(`${record.taskId}\0${record.hookId}\0${record.event}`);
    return Boolean(logical && logical.latestOccurrence > record.occurrence
      && [...logical.eventIds].some(eventId => eventId !== record.eventId));
  };
  // One pass over the occurrence table answers both eligibility questions the old
  // per-record `some(...)` scans asked: is this the latest occurrence of its logical
  // event, and does another occurrence of the same event ID still hold write evidence?
  const logicalEvents = new Map<string, { latestOccurrence: number; eventIds: Set<string> }>();
  for await (const record of records()) {
    const key = `${record.taskId}\0${record.hookId}\0${record.event}`;
    const entry = logicalEvents.get(key) ?? { latestOccurrence: -Infinity, eventIds: new Set<string>() };
    entry.latestOccurrence = Math.max(entry.latestOccurrence, record.occurrence);
    entry.eventIds.add(record.eventId);
    logicalEvents.set(key, entry);
  }
  // A shared event/path with unresolved write evidence is never disposable. Indexed
  // by the same eligibility the walk uses, so this answer equals the old per-record scan.
  const unresolvedByEventId = new Map<string, number>();
  for await (const record of records()) {
    if (eligible(record, taskOf(record.taskId))) continue;
    unresolvedByEventId.set(record.eventId, (unresolvedByEventId.get(record.eventId) ?? 0) + 1);
  }
  const commons = new Map<string, string | null>();
  const dataDir = store.path === ':memory:' ? null : isolationDataDirFor(store);
  const recordedPaths = new Set<string>();
  const activeHostPaths = new Set(store.hostRunsByStates(['queued', 'admitted', 'running']).map(run => resolve(run.repository.path)));
  const settledHostPaths = new Set(store.hostRunsByStates(['settled']).map(run => resolve(run.repository.path)));
  const usedByLiveRun = (path: string) => [...activeHostPaths].some(active => active === path || active.startsWith(`${path}/`));
  const usedBySettledRun = (path: string) => [...settledHostPaths].some(settled => settled === path || settled.startsWith(`${path}/`));
  for await (const record of records()) if (record.workspace?.path) recordedPaths.add(resolve(record.workspace.path));
  const reconciled: string[] = [];
  let walked = 0;
  for await (const record of records()) {
    if (++walked % HOOK_WALK_SLICE === 0) await yieldToEventLoop();
    if (options.taskIds && !options.taskIds.has(record.taskId)) continue;
    const task = taskOf(record.taskId);
    if (!task) {
      // The task's history is already gone. This row is the last record of a checkout
      // Queue created, so it is reconciled exactly when that checkout is provably absent.
      const recorded = record.workspace ? resolve(record.workspace.path) : null;
      // Lean store 2 (task 987): a settled record that names no checkout holds none
      // (hook-retention.ts's rule), so it is reconciled now instead of skipped forever.
      if (!recorded) { if (hookStateIsTerminal(record.state)) reconciled.push(record.id); continue; }
      try {
        const info = await lstat(recorded).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (info) {
          // A missing task cannot prove an owner is live. Give the exact data-home
          // checkout a bounded grace period, while any unsettled host run protects it.
          const currentRoot = dataDir ? join(dataDir, 'isolation') : null;
          const ownedShape = currentRoot && recorded.startsWith(`${currentRoot}/`)
            && /^[a-f0-9]{64}\/[a-f0-9]{48}$/.test(recorded.slice(currentRoot.length + 1));
          const stale = Date.now() - info.mtimeMs >= UNOWNED_ISOLATION_RETENTION_MS || usedBySettledRun(recorded);
          const rootInfo = currentRoot ? await lstat(currentRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; }) : null;
          const parent = currentRoot ? join(currentRoot, recorded.slice(currentRoot.length + 1).split('/')[0]) : null;
          const parentInfo = parent ? await lstat(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; }) : null;
          if (ownedShape && rootInfo?.isDirectory() && !rootInfo.isSymbolicLink() && currentRoot && await realpath(currentRoot) === currentRoot
              && parentInfo?.isDirectory() && !parentInfo.isSymbolicLink() && parent && await realpath(parent) === parent
              && stale && !info.isSymbolicLink() && info.isDirectory() && !usedByLiveRun(recorded)) {
            const bytes = await treeBytes(recorded);
            const marker = await lstat(join(recorded, '.git')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
            if (marker?.isSymbolicLink()) throw new Error('Checkout Git marker is a symbolic link');
            if (marker?.isFile()) {
              const contents = await readFile(join(recorded, '.git'), 'utf8');
              const gitdirLine = /^gitdir: (.+)\s*$/.exec(contents);
              if (!gitdirLine) throw new Error('Checkout Git marker is not a worktree pointer');
              const gitdir = resolve(recorded, gitdirLine[1]);
              const commonDir = resolve(gitdir, '..', '..', '..');
              if (await realpath(commonDir) !== commonDir || digest(commonDir) !== basename(parent!))
                throw new Error('Checkout worktree pointer does not match its Queue isolation root');
              const removed = await gitRaw(parent!, [`--git-dir=${commonDir}`, 'worktree', 'remove', '--force', recorded]);
              if (removed.code !== 0) throw new Error(`Git worktree removal failed: ${removed.stderr.trim()}`);
            }
            await rm(recorded, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            health.orphanCount++; health.orphanBytes += bytes; health.reapedCount++; health.reapedBytes += bytes;
            reconciled.push(record.id);
          } else {
            health.orphanCount++;
          }
          continue;
        }
        reconciled.push(record.id);
      } catch (error) { fail(record.eventId, error); }
      continue;
    }
    try {
      if (!eligible(record, task) || !/^[a-f0-9]{48}$/.test(record.eventId)) continue;
      if (!commons.has(task.repoPath)) {
        // Historical tasks can outlive their repository. Probe each root once, not once per record.
        commons.set(task.repoPath, null);
        const repo = await lstat(task.repoPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!repo) { health.unavailableRepositoryCount++; continue; }
        commons.set(task.repoPath, await git(task.repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
      }
      const common = commons.get(task.repoPath);
      if (!common) continue;
      const currentPath = dataDir ? isolationPathFor(dataDir, common, record.eventId) : null;
      const recorded = record.workspace ? resolve(record.workspace.path) : null;
      const warmPaths = new Set([
        ...(dataDir ? [warmCandidatePathFor(dataDir, common)] : []),
      ]);
      // Only the current data-home root confers ownership.
      if (recorded && recorded !== currentPath) continue;
      const path = recorded ?? currentPath;
      if (!path || warmPaths.has(path)) continue;
      if (usedByLiveRun(path)) continue;
      const root = dataDir ? isolationRootFor(dataDir, common) : null;
      if (!root) continue;
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('Checkout path is not a real Queue-owned directory');
      // A shared event/path with unresolved write evidence is never disposable.
      if (unresolvedByEventId.has(record.eventId)) continue;
      health.orphanCount++;
      const current = store.hookEvent(record.id);
      if (!current || !eligible(current, task)) continue;
      const bytes = await treeBytes(path);
      health.orphanBytes += bytes;
      const marker = await lstat(join(path, '.git')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (marker?.isSymbolicLink()) throw new Error('Checkout Git marker is a symbolic link');
      if (marker?.isFile()) {
        const removed = await gitRaw(task.repoPath, ['worktree', 'remove', '--force', path]);
        if (removed.code !== 0) throw new Error(`Git worktree removal failed: ${removed.stderr.trim()}`);
      }
      // Independent clones and interrupted removals may have no Git marker left.
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      health.reapedCount++; health.reapedBytes += bytes;
      store.event(task.id, 'hook_checkout_reaped', `${record.eventId}: ${bytes} bytes`);
    } catch (error) {
      fail(record.eventId, error);
    }
  }
  // Direct isolation leaves with no retained hook owner still get a bounded
  // cleanup path. Their age is not sufficient by itself: an unsettled host run
  // naming the directory, or a retained hook record whose ownership is unclear,
  // keeps it untouched.
  if (dataDir) {
    const isolationRoot = join(dataDir, 'isolation');
    try {
      const rootInfo = await lstat(isolationRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(isolationRoot) !== isolationRoot)
        throw new Error('Isolation root is not a real Queue-owned directory');
      for (const rootLeaf of await readdir(isolationRoot)) {
        if (!/^[a-f0-9]{64}$/.test(rootLeaf)) continue;
        const repositoryRoot = join(isolationRoot, rootLeaf);
        const repositoryInfo = await lstat(repositoryRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!repositoryInfo?.isDirectory() || repositoryInfo.isSymbolicLink() || await realpath(repositoryRoot) !== repositoryRoot) continue;
        for (const eventLeaf of await readdir(repositoryRoot)) {
          if (!/^[a-f0-9]{48}$/.test(eventLeaf)) continue;
          const path = join(repositoryRoot, eventLeaf);
          if (recordedPaths.has(path) || usedByLiveRun(path)) continue;
          const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
          if (!info?.isDirectory() || info.isSymbolicLink()
              || !usedBySettledRun(path) && Date.now() - info.mtimeMs < UNOWNED_ISOLATION_RETENTION_MS) continue;
          const bytes = await treeBytes(path);
          await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          health.orphanCount++; health.orphanBytes += bytes; health.reapedCount++; health.reapedBytes += bytes;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('isolation root', error);
    }
  }
  if (reconciled.length) health.reconciledCount = store.deleteHookEvents(reconciled);
  health.remainingCount = health.orphanCount - health.reapedCount;
  store.setMeta('hookCleanup', health);
  return health;
}
