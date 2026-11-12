import { existsSync } from "node:fs";
import type { TaskControlInput } from '../../shared/contracts';
import { isDispositionActive } from '../../shared/contracts';
import type { Store } from '../store/store';
import type { Adapter } from '../host/adapter';
import { proveWorkspaceEmpty } from '../verbs/disposition';
import { sharedRepositoryArchiveHold } from './repository-archive-gate';
import { git } from '../git/index';
import type { RuntimeRetirementService } from '../runtime/runtime-retirement';

type ArchiveEvidence = { workspaceId: string; directory: string; head: string; branch?: string; status: 'intent' | 'archived' };

/** The consumer-owned retention gate: report a hold with the hook's own evidence. */
export type UnusedWorkspaceRetentionGate = (target: { directory: string; head: string }) => Promise<{ hold: boolean; detail: string }>;

/**
 * Operator-only cleanup of a duplicate, never the task's retained dispatch workspace.
 * An unrecorded duplicate needs settled pre-dispatch state. A rebind-displaced one
 * never held the task's work, so it stays releasable after dispatch and at `done`
 * while no live run or resolution role of this task still names it.
 */
export async function archiveUnusedWorkspace(store: Store, adapter: Adapter, input: { taskId: string; version: number; unusedWorkspaceId: string }, running: () => boolean, retirement?: RuntimeRetirementService, preArchive?: UnusedWorkspaceRetentionGate) {
  const task = store.task(input.taskId), id = input.unusedWorkspaceId;
  if (task.version !== input.version) throw Error('Task changed; refresh before retrying');
  const displaced = store.getMeta<{ id: string; directory: string; branch: string }>(`displacedDispatchWorkspace:${task.id}:${id}`);
  const preDispatch = !(task.runId || task.agentId || task.agentIntent || task.completion || task.prUrl || task.prHead || task.resumePrNumber ||
      task.resolution.currentRunId || task.resolution.recoveryActive || task.resolution.mergeIntent) &&
    ['queued', 'needs_attention', 'blocked', 'error'].includes(task.phase) &&
    !store.runs(task.id).some(run => !run.released || run.role !== 'recovery');
  const displacedIdle = Boolean(displaced) &&
    task.resolution.coordinatorWorkspaceId !== id && task.resolution.closeoutWorkspaceId !== id &&
    !store.runs(task.id).some(run => run.workspaceId === id && !run.released);
  if (task.removedAt || isDispositionActive(task) || task.reviewEntry || !task.workspaceId || !task.directory)
    throw Error('Unused workspace cleanup requires a retained workspace and no active disposition');
  if (!preDispatch && !displacedIdle)
    throw Error(displaced ? 'Displaced workspace is still named by a live run or resolution role of this task'
      : 'Unused workspace cleanup requires settled pre-dispatch state unless the workspace was displaced by rebind');
  if (id === task.workspaceId) throw Error('The current task workspace must be retained');
  if (!adapter.archiveTaskWorkspace) throw Error('Workspace cleanup is unavailable');
  // A duplicate cleanup retires the shared registration every task in the
  // repository uses, so it waits for the repository to quiesce (nucleus#1139 review).
  const sharedHold = sharedRepositoryArchiveHold(adapter, store.tasks(), task);
  if (sharedHold) throw Error(sharedHold);
  const key = `unusedWorkspaceArchive:${task.id}:${id}`;
  const prior = store.getMeta<ArchiveEvidence>(key);
  if (prior?.status === 'archived') return task;
  const branch = displaced?.branch ?? task.branch;
  if (displaced && (displaced.id !== id || !new RegExp(`^ns-${task.id}(?:-[0-9]+)?$`).test(branch)))
    throw Error('Displaced workspace does not carry a recorded Nucleus collision branch');
  const archive = async (target: typeof task, directory: string, head: string, allowed: () => boolean, uncertain: boolean) => {
    try { return await adapter.archiveTaskWorkspace!(target, id, directory, head, allowed, uncertain, uncertain); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (retirement && (/teardown/i.test(reason) || retirement.hasScope(task.id, id) && /retire|runtime scope/i.test(reason)))
        retirement.flagArchiveFailure(task.id, id, reason);
      throw error;
    }
  };
  // The retention gate is the last check before Queue asks for the archive, so
  // a hold leaves the worktree untouched and no archive intent recorded.
  const retentionHold = async (target: { directory: string; head: string }): Promise<void> => {
    if (!preArchive) return;
    const gate = await preArchive(target);
    if (!gate.hold) return;
    store.event(task.id, 'unused_workspace_retention_hold', gate.detail);
    throw Error(gate.detail);
  };
  const found = await adapter.findWorkspaces(task);
  const matches = found.filter(workspace => workspace.id === id);
  if (!matches.length && prior?.status === 'intent' && !existsSync(prior.directory)) {
    // Exact catalog absence alone is insufficient: the adapter checks the recorded
    // workspace directly before treating an unknown archive as already complete.
    await retirement?.capture(task.id, id, prior.directory);
    await retentionHold({ directory: prior.directory, head: prior.head });
    const archived = await archive({ ...task, workspaceId: id, directory: prior.directory, branch: prior.branch ?? branch }, prior.directory, prior.head, running, true);
    if (!archived) throw Error('Workspace archive remains unconfirmed');
    await retirement?.archived(task.id, id);
    store.setMeta(key, { ...prior, status: 'archived' });
    return store.update(task.id, {}, 'unused_workspace_archived', id);
  }
  if (!matches.length && prior?.status === 'intent') matches.push({ id, directory: prior.directory });
  if (!matches.length && displaced) matches.push({ id, directory: displaced.directory });
  if (matches.length !== 1 || !matches[0].directory || matches[0].directory === task.directory)
    throw Error('Unused workspace identity is absent, ambiguous, or shares the retained directory');
  const directory = matches[0].directory;
  if (displaced && displaced.directory !== directory) throw Error('Displaced workspace directory changed; preserved');
  const unshared = () => !store.tasks().some(other => other.id !== task.id &&
    (other.workspaceId === id || other.directory === directory || other.resolution.coordinatorWorkspaceId === id ||
      other.resolution.closeoutWorkspaceId === id || store.runs(other.id).some(run => run.workspaceId === id)));
  if (!unshared()) throw Error('Workspace is referenced by another task; preserved');
  const head = await git(directory, 'rev-parse', 'HEAD');
  // An older clean checkout is empty of unique work too. Never reset it to prove this.
  if (await git(directory, 'merge-base', head, task.planningBase) !== head)
    throw Error('Workspace holds commits beyond the planning base; preserved without archive');
  // The displaced collision branch never backed the task's PR; the emptiness proof
  // still checks its own branch, worktree and remote ref.
  const target = { ...task, workspaceId: id, directory, branch, planningBase: head, ...(displaced ? { prUrl: null } : {}) };
  const proof = await proveWorkspaceEmpty(store, target, true);
  if (!proof.empty || proof.uncertain) throw Error(proof.uncertain || proof.detail);
  if (prior && (prior.directory !== directory || prior.head !== head || (prior.branch && prior.branch !== branch))) throw Error('Uncertain archive identity changed; preserved');
  const allowed = () => running() && store.task(task.id).version === task.version && unshared();
  if (!allowed()) throw Error('Task changed during workspace cleanup verification');
  const evidence: ArchiveEvidence = prior ?? { workspaceId: id, directory, head, branch, status: 'intent' };
  await retentionHold({ directory, head });
  store.setMeta(key, evidence);
  store.event(task.id, 'unused_workspace_archive_intent', JSON.stringify(evidence));
  // A prior intent may only be reconciled as absent, never blindly repeated.
  await retirement?.capture(task.id, id, directory);
  const archived = await archive(target, directory, head, allowed, Boolean(prior));
  if (!archived) throw Error('Workspace archive was not confirmed; intent retained');
  await retirement?.archived(task.id, id);
  store.setMeta(key, { ...evidence, status: 'archived' });
  return store.update(task.id, {}, 'unused_workspace_archived', id);
}
