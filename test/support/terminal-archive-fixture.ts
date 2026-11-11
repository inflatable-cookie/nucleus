import type { TestContext } from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../../core/engine';
import { PaseoAdapter, type AgentObservation } from '../../service/paseo-composition';
import { Store, digest } from '../../core/store/store';
import { command, git } from '../../core/git/index';
import { repoCommonDir } from '../../core/workspaces/workspace-allocation';
import { RuntimeRetirementService } from '../../core/runtime/runtime-retirement';
import { collectOwnerVerbFacts, ownerTaskNext } from '../../core/verbs/owner-verbs';
import { submissionSchema, type Task } from '../../shared/contracts';
import { toolTimelinePage } from './tool-timeline';

/**
 * A done task with a Queue-owned canonical worktree, a pushed task commit and a
 * failed terminal archive, wired to a scripted Paseo catalog and participant.
 * `unfinished` leaves the task blocked so a test can finish it through a verb.
 */
export const missingHistory = 'tool observations read 1 failed: native history unavailable';

export async function terminalArchiveFixture(t: TestContext, options: { unfinished?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ns-terminal-archive-retry-')));
  let close = async () => { await rm(root, { recursive: true, force: true }); };
  t.after(() => close());
  const origin = join(root, 'origin.git'), primary = join(root, 'primary'), data = join(root, 'data');
  await command('git', ['init', '--bare', '--initial-branch=main', origin], root);
  await command('git', ['init', '--initial-branch=main', primary], root);
  await git(primary, 'config', 'user.name', 'Queue test');
  await git(primary, 'config', 'user.email', 'queue@example.invalid');
  await writeFile(join(primary, 'README.md'), 'base\n');
  await git(primary, 'add', '-A');
  await git(primary, 'commit', '-m', 'base');
  await git(primary, 'remote', 'add', 'origin', origin);
  await git(primary, 'push', 'origin', 'main');
  const base = await git(primary, 'rev-parse', 'HEAD');
  const store = new Store(join(root, 'queue.sqlite'));
  close = async () => { store.close(); await rm(root, { recursive: true, force: true }); };
  store.setMeta('paused', false);
  store.setMeta('hostId', 'host');
  store.setMeta('hostRegistry', [{ id: 'host', endpoint: 'fixture' }]);
  const inserted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Terminal archive retry', repoPath: primary,
    planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', join(data, 'callback.sock'), join(data, 'worker-report.mjs'));
  const directory = join(data, 'workspaces', digest(await repoCommonDir(primary)), inserted.branch);
  adapter.findWorkspaces = async () => [];
  await adapter.populateTaskWorktree(inserted);
  await writeFile(join(directory, 'task.txt'), 'task\n');
  await git(directory, 'add', '-A');
  await git(directory, 'commit', '-m', 'task');
  await git(directory, 'push', 'origin', inserted.branch);
  const head = await git(directory, 'rev-parse', 'HEAD');
  if (options.unfinished) store.update(inserted.id, { phase: 'blocked', workspaceId: 'ws', directory, agentId: 'worker' });
  else store.update(inserted.id, { phase: 'done', workspaceId: 'ws', directory, agentId: 'worker', prHead: head,
    prUrl: 'https://github.com/example/repo/pull/1', resolution: { ...inserted.resolution, mergedCommit: head, syncedCommit: head,
      workspaceArchiveRetries: [{ workspaceId: 'ws', attempts: 5, error: missingHistory, nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString() }],
      cleanupReason: `Workspace archive for ws failed: ${missingHistory}` } });
  const remote = { catalogued: true, observationError: false, historyReads: 0, archives: [] as string[],
    descriptor: { projectRootPath: primary },
    participant: { id: 'worker', workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' } as AgentObservation };
  const api = { workspaces: { ref: () => ({ directory,
    refresh: async () => { if (remote.observationError) throw Error('native catalog unavailable'); },
    current: () => remote.catalogued ? remote.descriptor : undefined,
    archive: async (requestId: string) => { remote.archives.push(requestId); remote.catalogued = false; return { archivedAt: new Date().toISOString() }; },
  }) }, agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
  (adapter as any).api = api;
  adapter.observe = async id => ({ ...remote.participant, id });
  adapter.agentTimelinePage = async () => { remote.historyReads++; return toolTimelinePage([]); };
  const retirement = new RuntimeRetirementService(store, async () => ({ code: 0, timedOut: false, spawnError: '', output: '{}' }));
  const engine = new Engine(store, adapter, 0, () => true, retirement);
  close = async () => { await engine.stop(); store.close(); await rm(root, { recursive: true, force: true }); };
  const task = () => store.task(inserted.id);
  const updateResolution = (patch: Partial<Task['resolution']>) => store.update(inserted.id, { resolution: { ...task().resolution, ...patch } });
  const next = () => ownerTaskNext(collectOwnerVerbFacts(store, task())).verbs.filter(view => view.verb === 'retry_effect');
  const retry = (effect = 'workspace_archive.ws') => engine.performTaskControl({ action: 'retry_effect', taskId: inserted.id,
    version: task().version, effect, caller: 'operator', reason: 'Retry after repairing the archive blocker' });
  return { root, primary, directory, store, adapter, engine, remote, api, task, updateResolution, next, retry, head, retirement };
}
