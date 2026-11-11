import { callerNativeId } from '../../shared/agent-identity';
import type { RegistrationAdapter } from './types';
export type { RegistrationAdapter } from './types';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { complexityRefusal } from '../../shared/demand';
import { submissionSchema, type Profile, type Task, type TaskRegistrationInput, type TaskRegistrationResult } from '../../shared/contracts';
import type { AgentObservation } from './adapter';
import { git, validateSubmission } from '../git/index';
import { repositoryOrigin } from '../planning/lanes';
import { now, type Store } from '../store/store';

/** The transport surface a registration arrived from. Only the direct CLI path is accepted. */
export interface RegistrationSurface { via?: string | null }

/** The main checkout that owns this worktree's Git directory, or null when Git cannot say. */
export async function mainCheckoutOf(directory: string): Promise<string | null> {
  try {
    const first = (await git(directory, 'worktree', 'list', '--porcelain')).split('\n').find(line => line.startsWith('worktree '));
    return first ? await realpath(first.slice('worktree '.length)) : null;
  } catch { return null; }
}

/**
 * The worktree the caller registers from must be a clean, separate Git
 * worktree on a branch of a registered repository. Each refusal names its
 * reason; nothing is reset, cleaned or rewritten to obtain it.
 */
export async function verifyRegistrationGit(directory: string, repoPath: string, baseBranch: string): Promise<string> {
  if (await realpath(directory) !== directory) throw Error('Registration requires the worktree real path, not a symlink onto it');
  if (await git(directory, 'rev-parse', '--show-toplevel') !== directory) throw Error('Registration requires an isolated worktree root, not a subdirectory of one');
  if (directory === repoPath) throw Error('Registration from the registered checkout is refused; register from a separate clean worktree on its own branch');
  if (await git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir') !== await git(repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir')) throw Error('Registration workspace belongs to a different repository than its project checkout');
  const branch = await git(directory, 'branch', '--show-current');
  if (!branch) throw Error('Registration requires a worktree on a branch, not a detached head');
  if (branch === baseBranch) throw Error(`Registration requires an isolated branch, not the integration branch ${baseBranch}`);
  if (await git(directory, 'status', '--porcelain')) throw Error('Registration worktree is dirty; commit its changes on its branch and register again');
  return branch;
}

/** A workspace, agent or branch already on the board belongs to its task; registration never takes it twice. */
export function assertRegistrationUnowned(store: Store, input: { workspaceId: string; agentId: string; branch: string; repoPath: string; hostId?: string }) {
  for (const t of store.tasks()) {
    const runs = store.runs(t.id);
    const agents = [t.agentId, t.coordinatorAgentId, t.resolution.reviewerAgentId, ...t.retiredWorkers.map(w => w.agentId)];
    const workspaces = [t.workspaceId, t.resolution.closeoutWorkspaceId, t.resolution.coordinatorWorkspaceId];
    // Unknown provenance cannot prove a different host. Branch ownership is
    // machine-wide; native workspace and agent identities are host-local.
    const couldBeSameHost = !input.hostId || !t.hostId || input.hostId === t.hostId;
    const matchingRun = runs.some(run => (!input.hostId || !run.hostId || input.hostId === run.hostId)
      && (run.workspaceId === input.workspaceId || run.agentId === input.agentId));
    if (couldBeSameHost && (workspaces.includes(input.workspaceId) || agents.includes(input.agentId)) || matchingRun
      || (t.repoPath === input.repoPath && t.branch === input.branch))
      throw Error(`Workspace, branch or agent already belongs to queue task ${t.id}; resume that task instead`);
  }
}

/** The caller's actual model, when the pool knows a profile for it; otherwise the task records no worker profile. */
function workerProfileFor(profiles: Profile[], observation: AgentObservation): Profile | null {
  if (!observation.model) return null;
  return profiles.find(p => p.model === observation.model && (!observation.provider || p.provider === observation.provider))
    ?? profiles.find(p => p.model === observation.model) ?? null;
}

export async function registerTask(
  store: Store,
  adapter: RegistrationAdapter,
  profiles: Profile[],
  input: TaskRegistrationInput,
  surface: RegistrationSurface = {},
): Promise<TaskRegistrationResult> {
  // The Paseo plugin tool path carries no reliable calling-thread identity in
  // its envelope, so a typed caller there would be exactly what the brief
  // forbids. Only the thread's own shell (whose CLI resolved and overwrote
  // caller from its Nucleus ticket or host identity) may register.
  if (surface.via === 'paseo') throw Error('task.register refuses the Paseo bridge; call it from the registering thread\'s own shell with node bin/queue-cli.mjs task.register so the worker is the authenticated calling thread, not a typed name');
  const refusal = complexityRefusal(input);
  if (refusal) throw new Error(refusal);
  if (!adapter.inspectRegistration) throw Error('Paseo cannot identify the calling thread to the plugin reliably; registration is refused with nothing written');
  const caller = callerNativeId(input.caller, adapter.hostId);
  let inspected: { workspaceId: string; directory: string; repoPath: string; observation: AgentObservation };
  try {
    inspected = await adapter.inspectRegistration(caller);
  } catch (error) {
    throw Error(`Registration caller ${input.caller} is not a live Paseo thread: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { workspaceId, directory, observation } = inspected;
  // The repository is the worktree's main checkout from Git, not Paseo's project root: a worktree
  // opened in Paseo as its own project reports itself as the root (effigy #512 slice C).
  const repoPath = await mainCheckoutOf(directory) ?? inspected.repoPath;
  if (observation.id !== caller) throw Error(`Registration caller ${input.caller} is not a live Paseo thread: the observed thread is ${observation.id || 'unknown'}`);
  const origin = await repositoryOrigin(repoPath);
  const registered = store.repositories().find(row => (row.repository.path && row.repository.path === repoPath)
    || (origin && row.repository.origin === origin));
  if (!registered) throw Error(`Registration workspace belongs to no registered repository (checkout ${repoPath}); register from a worktree of a repository Queue knows`);
  const baseBranch = await originBaseBranch(repoPath);
  const branch = await verifyRegistrationGit(directory, repoPath, baseBranch);
  // Fast fail before the expensive remote reads; the claim below rechecks
  // authoritatively inside the write transaction.
  const claimed = { workspaceId, agentId: caller, branch, repoPath, hostId: adapter.hostId };
  assertRegistrationUnowned(store, claimed);
  let planningCommit: string;
  try {
    await git(repoPath, 'fetch', 'origin', baseBranch);
    // The branch's fork point, not the base tip: every continuation requires the planning commit
    // to be an ancestor of the worktree head, and a branch cut before the latest base commit has
    // not got it (effigy #527).
    planningCommit = await git(directory, 'merge-base', 'HEAD', `refs/remotes/origin/${baseBranch}`);
  } catch (error) {
    throw Error(`Registration awaits the pushed integration head: ${error instanceof Error ? error.message : String(error)}`);
  }
  const submission = submissionSchema.parse({
    submissionId: randomUUID(), title: input.title, repoPath, baseBranch, planningCommit,
    brief: { text: `${input.description}\n\nSelf-registered by the worker thread via task.register (Spec 058); the worker is the calling thread in its own worktree.` },
    originAgentId: input.caller, scope: 'general', complexity: input.complexity,
    responsible: true, notifyOriginOnCloseout: true,
  });
  const validated = await validateSubmission(submission);
  const runId = randomUUID(), token = randomBytes(32).toString('hex');
  const profile = workerProfileFor(profiles, observation);
  // The authoritative claim runs with no await between the recheck and the
  // insert inside one write transaction. Concurrent registrations serialize
  // here, so the same workspace, agent or branch is never claimed twice.
  const task = store.transaction(() => {
    assertRegistrationUnowned(store, claimed);
    return store.insert(submission, adapter.hostId, validated.handoffText, validated.planningBase, {
      hostSelection: { hostId: adapter.hostId, basis: input.hostId ? 'explicit' : 'sole_online_host' },
      originHostId: adapter.hostId,
      phase: 'working', reason: `Registered by ${input.caller} on ${branch}; awaiting work and the worker's authenticated report`,
      workspaceId, directory, branch, agentId: caller, runId,
      workspaceIntent: true, agentIntent: true,
      profile, profileGroup: profile ? store.pool().find(p => p.profileId === profile.id)?.group ?? null : null,
      originWorkspaceId: workspaceId,
      workerModel: observation.model || null, workerModels: observation.model ? [observation.model] : [],
      agentActive: observation.active || observation.permissions, lastAgentStatus: observation.status, lastObservedAt: now(),
    }, { runId, token, prepare: task => adapter.prepareRegistration?.(task, token) }, origin);
  });
  store.event(task.id, 'registered', `Worker ${input.caller} registered from its own worktree on ${branch}; responsible lifecycle, no planner or coordinator`);
  const current = store.task(task.id);
  return {
    task: current, workspaceId, directory, branch, workerAgentId: caller, runId,
    status: observation.status, model: observation.model ?? '',
  };
}

/** The integration branch the registration must stay off: the origin HEAD, else main. */
async function originBaseBranch(repoPath: string): Promise<string> {
  try {
    const head = await git(repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
    const branch = head.replace(/^origin\//, '');
    if (branch && branch !== head) return branch;
  } catch { /* a repository without an origin HEAD registers against main */ }
  return 'main';
}
