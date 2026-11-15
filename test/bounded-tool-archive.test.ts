import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../shared/contracts';
import type { HostProcessFact } from '../core/host/types';
import { terminalArchiveFixture } from './support/terminal-archive-fixture';
import { toolTimelinePage } from './support/tool-timeline';

async function fixture(t: TestContext, attached = false) {
  const f = await terminalArchiveFixture(t, { unfinished: true });
  const agentId = attached ? 'synthetic-support' : 'worker';
  const oldScratch = join(f.root, 'old-run'), currentScratch = join(f.root, 'current-run');
  f.store.update(f.task().id, { runId: 'current-worker', temporaryDirectory: currentScratch });
  f.remote.participant.activeTurnId = null;
  f.adapter.agentTimelinePage = async () => toolTimelinePage([], {
    projection: 'bounded', hasOlder: true, pendingBackgroundTasks: [],
  });
  const run = (id: string, temporaryDirectory?: string, workspaceId = 'ws'): Run => ({
    id, taskId: f.task().id, role: 'revision', generation: f.task().coordinatorGeneration,
    head: f.head, base: f.head, agentId, workspaceId, profile: null,
    status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null,
    active: false, idleSince: null, completion: null, released: true, temporaryDirectory,
  });
  f.store.putRun(run('older-participant', oldScratch));
  f.store.putRun(run('current-participant', currentScratch));
  let processes: HostProcessFact[] | null = [];
  f.adapter.hostProcessListing = async () => processes;
  const archive = (inventory: (() => Run[]) | undefined = () => f.store.runs(f.task().id)) =>
    f.adapter.archiveTaskWorkspace(f.task(), 'ws', f.directory, f.head, () => true, false,
      { requirePublished: true, attachedAgentIds: new Set([agentId]), requireDirectory: true, participantRuns: inventory });
  const processAt = (cwd: string): HostProcessFact => ({ pid: 42, ppid: 1, pgid: 42, uid: 501,
    startIdentity: 'synthetic-start', command: 'synthetic-detached-command', cwd });
  return { ...f, agentId, oldScratch, currentScratch, archive, run, processAt,
    setProcesses: (value: HostProcessFact[] | null) => { processes = value; } };
}

for (const attached of [false, true]) test(`workspace archive covers older scratch for ${attached ? 'an attached support participant' : 'the retained worker'}`, async t => {
  const f = await fixture(t, attached);
  f.setProcesses([f.processAt(join(f.oldScratch, 'child'))]);
  await assert.rejects(f.archive(), /process 42 remains in the task workspace process tree/);
  assert.deepEqual(f.remote.archives, [], 'no archive is sent while an older run owns work');
  assert.equal(existsSync(f.directory), true);
  f.setProcesses([]);
  assert.deepEqual(await f.archive(), [], 'a clear inventory and process table allow archive');
  assert.equal(existsSync(f.directory), false);
});

test('workspace archive holds on missing participant run identities and scratch roots', async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.archive(() => []), /participant run process identity is unavailable/);
  f.store.putRun(f.run('older-participant'));
  await assert.rejects(f.archive(), /participant run temporary directory is unrecorded/);
  f.store.putRun(f.run('older-participant', f.oldScratch));
  f.setProcesses(null);
  await assert.rejects(f.archive(), /host process listing is unreadable/);
  assert.deepEqual(f.remote.archives, []);
});

test('workspace archive refreshes the run inventory before local teardown', async t => {
  const f = await fixture(t, true);
  let reads = 0;
  const inventory = () => {
    if (++reads === 3) {
      const lateScratch = join(f.root, 'late-run');
      f.store.putRun(f.run('late-participant', lateScratch));
      f.setProcesses([f.processAt(lateScratch)]);
    }
    return f.store.runs(f.task().id);
  };
  await assert.rejects(f.archive(inventory), /process 42 remains in the task workspace process tree/);
  assert.equal(reads, 3, 'each proof pass resolves the current inventory');
  assert.equal(existsSync(f.directory), true, 'native archive does not authorize unsafe local teardown');
});
