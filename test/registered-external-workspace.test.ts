import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Engine } from '../core/engine';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { git, verifyTaskWorktreeIdentity } from '../core/git/index';
import { assertRegistrationUnowned, registerTask, type RegistrationAdapter } from '../core/host/registration';
import { dispositionSchema, submissionSchema, type Profile, type Task } from '../shared/contracts';
import { runTicketPath, writeRunTicket } from '../core/dispatch/agent-creation';
import { ownedWorkspacePath, repoCommonDir } from '../core/workspaces/workspace-allocation';
import { PaseoAdapter } from '../service/paseo-composition';
import { Store } from '../core/store/store';
import { fakeAdapter } from './support/fakes';

/**
 * nucleus#1261: a task registered in an existing worktree keeps that worktree
 * as an external workspace through its whole lifecycle.
 *
 * Registration records the caller's own checkout as `external` — the same
 * ownership class review entry uses for a preserved checkout — so the workspace
 * lifecycle proves the task's directory and reporting binding instead of a
 * Queue allocation, and closeout never archives a worktree Nucleus did not
 * create. The rows here come from the real registration path and the real store.
 */

const oldTaskId = 'supersededtasksynthetic227';
const newTaskId = 'registeredtasksynthetic239';

const profile = (id: string, model = id): Profile =>
  ({ id, name: id, model, provider: 'fixture', available: true, problem: '', notes: '', supportedThinking: [] });

async function externalFixture(t: Pick<TestContext, 'after'>, options: { oldTask?: boolean; branch?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ns-registered-external-')));
  const data = join(root, 'data'), repo = join(root, 'repo'), origin = join(root, 'origin.git');
  mkdirSync(data);
  await git(root, 'init', '--bare', origin);
  await git(root, 'init', '-b', 'main', repo);
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), 'repo\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'plan');
  await git(repo, 'remote', 'add', 'origin', origin);
  await git(repo, 'push', 'origin', 'main');
  // The registering thread's worktree is an earlier task's Queue allocation on
  // this machine's workspace root: Nucleus did not create this one either.
  const directory = ownedWorkspacePath(data, await repoCommonDir(repo), oldTaskId);
  mkdirSync(dirname(directory), { recursive: true });
  await git(repo, 'worktree', 'add', '-b', options.branch ?? `ns-${newTaskId}`, directory, 'main');
  const head = await git(directory, 'rev-parse', 'HEAD');

  const store = new Store(join(root, 'queue.sqlite'));
  const profiles = [profile('author'), profile('reviewer')];
  store.patchRepository({ origin: null, path: repo }, {});
  // A superseded task whose disposition preserved its folder is retired, not a
  // live writer: the folder and files stay, the task's claim on them does not.
  const oldTask = options.oldTask === false ? null : store.insert(submissionSchema.parse({
    submissionId: 'old-superseded', title: 'The superseded task', repoPath: repo, planningCommit: head,
    handoffPath: 'handoff.md', originAgentId: 'old-origin',
  }), 'host', 'handoff', head);
  if (oldTask) store.update(oldTask.id, {
    phase: 'cancelled', workspaceId: 'old-workspace', directory, branch: `ns-${oldTaskId}`, agentId: 'old-thread', runId: 'old-run',
    disposition: dispositionSchema.parse({ kind: 'supersede', status: 'complete', requestedAt: new Date().toISOString(),
      requestedBy: 'operator', reason: 'Superseded by the task registered in the same folder', workDisposition: 'preserve' }),
  });

  const helperPath = join(data, 'worker-report.mjs'), socketPath = join(data, 'callback.sock');
  const caller = 'registered-thread', workspaceId = 'registered-workspace';
  const observation = { id: caller, workspaceId, status: 'running', active: true, permissions: false, error: '', model: 'author' };
  const adapter = fakeAdapter({
    hostId: 'host',
    inspectRegistration: async (agentId: string) => {
      if (agentId !== caller) throw Error('Agent was not found');
      return { workspaceId, directory, repoPath: repo, observation };
    },
    observe: async (id: string) => id === caller ? observation : { ...observation, id, status: 'idle', active: false },
    // The real host writes the ticket and answers the binding the caller reports through.
    prepareRegistration: (task: Task, token: string) => {
      const ticketPath = writeRunTicket({ helperPath, socketPath }, task, { id: task.runId!, role: 'worker', generation: 0 }, token);
      return { runId: task.runId!, helperPath, ticketPath, mcpBindingPath: null };
    },
  } as Record<string, unknown>) as unknown as RegistrationAdapter;
  const register = () => registerTask(store, adapter, profiles, {
    title: 'Work already in progress', description: 'Continue the work this thread already has', complexity: 'medium', caller,
  });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, data, repo, origin, directory, head, store, profiles, adapter, helperPath, socketPath, caller, workspaceId, oldTask, register };
}

test('a worktree named for a superseded preserved task registers as external and its preflight and continuation run there', async (t) => {
  const f = await externalFixture(t);
  const result = await f.register();
  assert.equal(result.task.workspaceOwnership, 'external', 'registration records the caller worktree as external');
  assert.equal(result.directory, f.directory);
  assert.equal(result.branch, `ns-${newTaskId}`);
  assert.equal(result.task.directory, f.directory, 'the stored row keeps the registering worktree');

  // The real host policy over this machine's placement: the external worktree
  // is not a Queue allocation, so no allocation proof or volume admission runs.
  const admissions: string[] = [];
  const host = new PaseoAdapter('ws://127.0.0.1:1', f.socketPath, f.helperPath, undefined, undefined,
    { dataDir: f.data, admit: (path: string) => admissions.push(path) });
  (host as unknown as { api: unknown }).api = {
    workspaces: {
      ref: () => ({ get directory() { return f.directory; }, refresh: async () => true,
        current: () => ({ projectRootPath: f.repo }) }),
      // Paseo reports the worktree itself as its project root (effigy #512 slice C).
      list: async () => ({ entries: [{ id: f.workspaceId, projectRootPath: f.directory, workspaceDirectory: f.directory }],
        pageInfo: { hasMore: false } }),
    },
  };
  await host.preflightWorkspaceStorage(f.store.task(result.task.id));
  assert.deepEqual(admissions, [], 'an external worktree is never admitted to the Queue allocation volume');
  assert.deepEqual(await host.preflightWorkerContinuation(f.store.task(result.task.id)), { available: true },
    'a continuation runs in the registered directory');
  assert.deepEqual(await host.findWorkspaces(f.store.task(result.task.id)), [{ id: f.workspaceId, directory: f.directory }],
    'the recorded workspace identity matches even when Paseo roots the project at the worktree');
});

test('registration from a directory a live task still owns is refused with the owner named', async (t) => {
  const f = await externalFixture(t, { oldTask: false });
  const live = f.store.insert(submissionSchema.parse({
    submissionId: 'live-owner', title: 'The live owner', repoPath: f.repo, planningCommit: f.head,
    handoffPath: 'handoff.md', originAgentId: 'live-origin',
  }), 'host', 'handoff', f.head);
  f.store.update(live.id, { phase: 'working', workspaceId: 'live-workspace', directory: f.directory, branch: 'ns-live-task', agentId: 'live-thread' });
  await assert.rejects(f.register(), (error: Error) => {
    assert.match(error.message, /Registration worktree .* already belongs to queue task /);
    assert.ok(error.message.includes(live.id), `the refusal names the owner: ${error.message}`);
    return true;
  });
  assert.equal(f.store.tasks().filter(task => task.directory === f.directory).length, 1, 'nothing is written for the refused registration');

  // The folder is free once that owner is finished; a directory proof never
  // keeps a terminal task's folder claimed.
  f.store.update(live.id, { phase: 'done' });
  assert.doesNotThrow(() => assertRegistrationUnowned(f.store, {
    workspaceId: 'another-workspace', agentId: 'another-thread', branch: 'ns-another', repoPath: f.repo, directory: f.directory,
  }));
});

test('the registration response carries the reporting binding the thread reports through', async (t) => {
  const f = await externalFixture(t);
  const result = await f.register();
  const binding = result.binding;
  assert.ok(binding, 'a real host answers the binding in the registration response');
  assert.equal(binding.runId, result.runId);
  assert.equal(binding.helperPath, f.helperPath);
  assert.equal(binding.ticketPath, runTicketPath({ helperPath: f.helperPath }, result.runId));
  assert.equal(existsSync(binding.ticketPath), true, 'the ticket the response names is the one the host wrote');
  assert.equal(JSON.parse(readFileSync(binding.ticketPath, 'utf8')).runId, result.runId);
  assert.equal('token' in binding, false, 'the response names the credential file, never the secret');
});

test('a row registered before the ownership field existed is proved external from its registration event', async (t) => {
  const f = await externalFixture(t, { oldTask: false });
  const { task } = await f.register();
  // Reproduce the pre-fix stored shape: the row predates `workspaceOwnership`.
  f.store.db.prepare("UPDATE tasks SET data=json_remove(data,'$.workspaceOwnership') WHERE id=?").run(task.id);
  assert.equal(JSON.parse(String(f.store.db.prepare('SELECT data FROM tasks WHERE id=?').get(task.id)?.data)).workspaceOwnership, undefined);
  // A planned row is never marked: it has no registration event.
  const planned = f.store.insert(submissionSchema.parse({
    submissionId: 'planned-row', title: 'Planned', repoPath: f.repo, planningCommit: f.head,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', f.head);

  // Opening the store again runs the on-open migration over the stored shape.
  const reopened = new Store(join(f.root, 'queue.sqlite'));
  t.after(() => reopened.close());
  assert.equal(reopened.task(task.id).workspaceOwnership, 'external', 'the registration event proves the stored worktree external');
  assert.equal(reopened.task(planned.id).workspaceOwnership, 'queue', 'a planned task keeps the Queue allocation class');
});

test('continuation worktree proof accepts the migrated registered branch but still binds the current branch', async (t) => {
  const f = await externalFixture(t, { oldTask: false, branch: 'feature/registered-work' });
  const { task } = await f.register();
  // Reproduce the pre-1261 row and let the real store migration restore ownership.
  f.store.db.prepare("UPDATE tasks SET data=json_remove(data,'$.workspaceOwnership') WHERE id=?").run(task.id);
  const reopened = new Store(join(f.root, 'queue.sqlite'));
  t.after(() => reopened.close());
  const migrated = reopened.task(task.id);
  assert.equal(migrated.workspaceOwnership, 'external');
  assert.equal(migrated.branch, 'feature/registered-work');
  await verifyTaskWorktreeIdentity(migrated);
  await assert.rejects(verifyTaskWorktreeIdentity({ ...migrated, workspaceOwnership: 'queue' }), /immutable task branch identity/);
  await git(f.directory, 'checkout', '-b', 'feature/other');
  await assert.rejects(verifyTaskWorktreeIdentity(migrated), /worktree is on the wrong branch/);
});

test('closeout of a registered task leaves its external directory and branch in place', async (t) => {
  // No superseded row: nothing else could hold the archive, so the assertion
  // proves the external ownership itself keeps the worktree.
  const f = await externalFixture(t, { oldTask: false });
  const { task } = await f.register();
  f.store.setMeta('paused', false);
  const current = f.store.task(task.id);
  f.store.update(task.id, { phase: 'done', prUrl: 'https://github.com/example/repo/pull/239', prHead: f.head,
    resolution: { ...current.resolution, mergedCommit: f.head, syncedCommit: f.head } });
  const archives: string[] = [];
  const adapter = Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
  Object.defineProperty(adapter, 'helperPath', { value: f.helperPath });
  (adapter as unknown as { archiveTaskWorkspace: (task: Task, id: string, directory: string) => Promise<boolean> }).archiveTaskWorkspace =
    async (_task: Task, id: string, directory: string) => {
      archives.push(`${id}:${directory}`);
      return true;
    };
  const engine = new Engine(f.store, adapter, 0);
  try {
    await new Lifecycle(engine).archive(f.store.task(task.id));
  } finally { await engine.stop(); }

  assert.deepEqual(archives, [], 'Nucleus never archives a worktree it did not create');
  assert.deepEqual(f.store.task(task.id).resolution.archivedWorkspaceIds, [], 'the external workspace is not a Queue archive');
  assert.equal(existsSync(f.directory), true, 'the directory stays');
  assert.equal(await git(f.directory, 'branch', '--show-current'), `ns-${newTaskId}`, 'the branch stays checked out');
  assert.equal(await git(f.repo, 'rev-parse', '--verify', `refs/heads/ns-${newTaskId}`), f.head, 'the branch ref stays');
  assert.equal(f.store.lifecycleTasks().some(candidate => candidate.id === task.id), false,
    'a done external task owes no terminal cleanup pass');
});
