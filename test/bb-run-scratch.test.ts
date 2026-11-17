/**
 * nucleus#1315: a BB run's scratch leaf exists before its thread does.
 *
 * BB cannot hand a provider a per-thread environment, so a sandboxed role thread
 * cannot create its own recorded scratch (Claude Code's sandbox refuses writes
 * outside the checkout). The service creates the run's owner-only leaf before the
 * `run.attach` write; a leaf it cannot prove refuses the launch before anything
 * is spawned. This is the BB-side guarantee beside #1314's launch-path creation.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { Store } from '../core/store/store';
import { submissionSchema, type Profile } from '../shared/contracts';
import { formatAgentId } from '../shared/agent-identity';
import { composeBbAdapter } from '../service/bb-adapter';
import { checkoutRunScratchPlacement } from '../core/workspaces/run-scratch';
import type { BbWorkspaceRecord } from '../hosts/bb';

const bbHost = `bb:${'b'.repeat(32)}`;
const profile: Profile = { id: 'worker', name: 'Worker', provider: 'claude-code', model: 'claude-sonnet-5-5', notes: '', available: true, problem: '', supportedThinking: [] };

interface Fixture {
  store: Store;
  dataDir: string;
  directory: string;
  taskId: string;
  runId: string;
  attachObserved: Array<{ scratchExisted: boolean }>;
  adapter(): ReturnType<typeof composeBbAdapter>;
  scratchFor(runId: string): string;
}

function fixture(t: TestContext, options: { scratchFails?: boolean } = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bb-run-scratch-')));
  const store = new Store(join(root, 'queue.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const dataDir = join(root, 'data');
  const mount = join(root, 'scratch-volume');
  const directory = join(root, 'workspace', 'ns-task');
  mkdirSync(directory, { recursive: true });
  mkdirSync(mount, { recursive: true });
  const task = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Scratch task', repoPath: join(root, 'repo'), planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin',
  }), bbHost, 'handoff', 'a'.repeat(40));
  const runId = randomUUID();
  const workspaceId = `bb-worktree-${'a'.repeat(40)}`;
  store.update(task.id, {
    phase: 'working', runId, workspaceId, directory, profile, hostId: bbHost,
    plannerAgentId: formatAgentId(bbHost, 'thr_planner'),
  });
  store.putRun({ id: runId, taskId: task.id, hostId: bbHost, role: 'revision', generation: 0, head: 'a'.repeat(40), base: 'a'.repeat(40),
    agentId: null, workspaceId, profile: null, status: 'intent', createdAt: new Date().toISOString(), lastObservedAt: null,
    active: null, idleSince: null, completion: null, released: false, siblings: [] });
  const records: Record<string, BbWorkspaceRecord> = { [workspaceId]: { id: workspaceId, directory, repositoryRoot: join(root, 'repo'), projectId: 'proj_1', title: 'Scratch task' } };
  const placement = checkoutRunScratchPlacement(options.scratchFails ? { mount, namespace: 'nucleus', create: () => { throw new Error('the scratch volume is absent'); } } : { mount, namespace: 'nucleus' });
  // The adapter's placement follows the repository's own scratch namespace.
  const namespaceRoot = placement.withNamespace!(store.scratchNamespaceFor(store.task(task.id))).root;
  const attachObserved: Fixture['attachObserved'] = [];
  const adapter = () => {
    const composed = composeBbAdapter({
      hostId: bbHost, dataDir, store, connected: () => true,
      workspaces: {
        createWorkspace: async () => ({ id: workspaceId, directory }),
        findWorkspaces: async () => [{ id: workspaceId, directory }],
        workspaceAvailable: async () => true,
        workspaceIdAccepted: (id: unknown) => typeof id === 'string',
        taskWorkspaceArchived: async () => false,
        workspaceRef: () => ({ directory, refresh: async () => true, current: () => null, archive: async () => ({ archivedAt: new Date().toISOString(), error: null }) }),
        repositoryProject: async () => ({ workspaceRoot: join(root, 'repo') }),
      },
      records: () => records,
      put: record => { records[record.id] = record; },
      notSent: () => false,
      operation: async (operation, input) => {
        const at = new Date().toISOString();
        const calls: Record<string, number> = { spawn: 1, operations: 1 };
        if (operation === 'run.attach') {
          const value = input as { parentThreadId: string; pluginMetadata: Record<string, unknown> };
          const run = store.run(runId);
          let scratchExisted = false;
          try { scratchExisted = statSync(join(namespaceRoot, scratchDirectoryName(runId))).isDirectory(); } catch { /* absent */ }
          attachObserved.push({ scratchExisted });
          assert.ok(run, 'the run row is recorded before its agent is attached');
          return { operation, at, calls, value: {
            threadId: 'thr_worker', environmentId: 'env_1', status: 'starting',
            parentThreadId: value.parentThreadId, parentNotifications: 'off', pluginMetadata: value.pluginMetadata,
            createdAt: Date.now(), spawned: 1,
          } } as never;
        }
        throw new Error(`unexpected operation ${operation}`);
      },
    });
    // The proof-only placement: the same policy a private fixture supplies.
    Object.defineProperty(composed, 'runScratch', { value: placement, configurable: true });
    return composed;
  };
  return {
    store, dataDir, directory, taskId: task.id, runId, attachObserved, adapter,
    scratchFor: id => join(namespaceRoot, scratchDirectoryName(id)),
  };
}

/** The leaf name `runTemporaryEnvironment` uses: the first 8 hex of the run id's digest. */
function scratchDirectoryName(runId: string): string {
  return createHash('sha256').update(runId).digest('hex').slice(0, 8);
}

test('a BB role thread is attached only after its owner-only run scratch exists', async (t: TestContext) => {
  const f = fixture(t);
  await f.adapter().createAgent(f.store.task(f.taskId), 'run-token', 'work');
  assert.deepEqual(f.attachObserved, [{ scratchExisted: true }]);
  const scratch = statSync(f.scratchFor(f.runId));
  assert.equal(scratch.isDirectory(), true);
  assert.equal(scratch.mode & 0o077, 0, 'the run scratch is owner-only');
  // Idempotent: a retried launch (a fresh plugin, no in-memory spawn intent) re-observes
  // the same leaf instead of failing on EEXIST.
  f.store.setMeta('bbThreads', { agents: {}, spawns: {}, writes: {} });
  await f.adapter().createAgent(f.store.task(f.taskId), 'run-token', 'work');
  assert.deepEqual(f.attachObserved.map(entry => entry.scratchExisted), [true, true]);
});

test('a BB launch whose run scratch cannot be proved refuses before any attach', async (t: TestContext) => {
  const f = fixture(t, { scratchFails: true });
  await assert.rejects(f.adapter().createAgent(f.store.task(f.taskId), 'run-token', 'work'), /BB run scratch is unavailable: .*the scratch volume is absent/);
  assert.deepEqual(f.attachObserved, [], 'nothing was attached');
});
