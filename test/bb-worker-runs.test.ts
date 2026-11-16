import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BbThreads, emptyBbThreadState, type BbThreadState, type BbWorkspaceRecord } from '../hosts/bb/threads';
import { bbFake, bbWire, assertBbWire } from './support/bb-fake';
import { wireLabels } from '../shared/wire-labels';
import type { HostAgentSpec } from '../shared/host';
import { HostUnknownDeliveryError } from '../core/host/errors';

const hostId = 'bb:0123456789abcdef0123456789abcdef';
function fixture() {
  const fake = bbFake();
  let state = emptyBbThreadState();
  let workspace: BbWorkspaceRecord = { id: 'bb-worktree-' + 'a'.repeat(40), directory: '/synthetic/worktree', projectId: 'proj_synthetic', repositoryRoot: '/synthetic/repo', title: 'Synthetic' };
  let now = 0;
  const ports = { hostId, operation: fake.operations.execute, state: () => structuredClone(state), save: (value: BbThreadState) => { state = structuredClone(value); },
    workspace: () => workspace, putWorkspace: (value: BbWorkspaceRecord) => { workspace = value; }, parent: () => 'thr_planner',
    helperPath: '/synthetic/helper.mjs', ticketPath: (id: string) => `/synthetic/tickets/${id}.json`, notSent: () => false, now: () => now };
  const native = new BbThreads(ports);
  const spec = (run = 'run_synthetic', role = 'worker'): HostAgentSpec => ({
    workspaceId: workspace.id, taskNumber: 1270, title: role === 'worker' ? 'Synthetic task' : `${role}: Synthetic task`,
    profile: { id: 'synthetic-profile', name: 'Synthetic profile', provider: 'codex', model: 'synthetic-model', notes: '', available: true, problem: '', supportedThinking: ['high'], thinkingOptionId: 'high' }, mcpBindingPath: null,
    attempt: () => ({ requestId: `ns-${run}`, labels: wireLabels({ task: 'task_synthetic', run, role }), environment: {}, prompt: 'Synthetic task prompt with helper binding.' }),
  });
  return { ...fake, native, ports, spec, workspace: () => workspace, state: () => state, restart: () => new BbThreads(ports), expire: () => { now = 21_000; } };
}

test('BB run records the environment before binding, reuses it for the next role and carries the helper ticket', async () => {
  const f = fixture();
  const worker = await f.native.createAgent(f.spec());
  assert.equal(f.workspace().environmentId, f.rows.get(worker.id).environmentId);
  const reviewer = await f.restart().createAgent(f.spec('review_synthetic', 'reviewer'));
  assert.equal(f.rows.get(reviewer.id).environmentId, f.workspace().environmentId);
  const spawn = f.calls.find(c => c.method === 'threads.spawn')!.args;
  assert.equal(spawn.parentThreadId, 'thr_planner'); assert.equal(spawn.parentNotifications, 'off');
  assert.equal(spawn.environment.workspace.type, 'unmanaged');
  assert.equal(spawn.reasoningLevel, 'high'); assert.equal(spawn.permissionMode, 'full');
  assert.deepEqual(spawn.pluginMetadata.nucleus, { task: 'task_synthetic', run: 'run_synthetic', role: 'worker', host: hostId, helperPath: '/synthetic/helper.mjs', ticketPath: '/synthetic/tickets/run_synthetic.json' });
  assert.equal(Object.hasOwn(spawn, 'lifecycleOwnerThreadId'), false);
  assert.equal((await f.native.observe(worker.id)).workspaceId, worker.workspaceId);
});

test('BB inventory chunks more than 200 threads and reads interactions only for flagged rows', async () => {
  const f = fixture();
  const ids = Array.from({ length: 405 }, (_, i) => `thr_${i}`);
  for (const id of ids) f.rows.set(id, bbWire('list', { id, hasPendingInteraction: id === ids[0] }));
  f.interactions.set(ids[0], [bbWire('interaction', { threadId: ids[0] })]);
  const inventory = await f.native.observationInventory(ids);
  assert.equal(inventory?.size, 405);
  assert.deepEqual(f.calls.filter(c => c.method === 'threads.list').map(c => c.args.threadIds.length), [200, 200, 5]);
  assert.equal(f.calls.filter(c => c.method === 'threads.interactions.list').length, 1);
  assert.equal(inventory?.get(ids[0])?.permissions, true);
  assert.equal(inventory?.get(ids[0])?.pendingRequest?.kind, 'plugin');
  assert.equal(inventory?.get(ids[0])?.activeTurnId, undefined, 'the fixture does not invent activeTurnId');
});

for (const fault of ['failed chunk', 'short chunk', 'omitted row', 'partial row'] as const) test(`BB ${fault} answers null and per-agent observe remains available`, async () => {
  const f = fixture(), ids = Array.from({ length: 201 }, (_, i) => `thr_${i}`);
  for (const id of ids) f.rows.set(id, bbWire('list', { id, hasPendingInteraction: false }));
  if (fault === 'failed chunk') f.controls.failChunk = 2;
  if (fault === 'short chunk') f.controls.omitId = ids[0];
  if (fault === 'omitted row') f.controls.omitId = ids[200];
  if (fault === 'partial row') delete f.rows.get(ids[200]).runtime;
  assert.equal(await f.native.observationInventory(ids), null);
  assert.equal((await f.native.observe(ids[1])).status, 'idle');
});

test('BB unknown spawn adopts exact metadata across complete origin walks, hidden, reparented and archived rows', async () => {
  const f = fixture(); f.controls.loseSpawn = true;
  await assert.rejects(f.native.createAgent(f.spec()), /unknown delivery/);
  const spawned = [...f.rows.values()][0];
  spawned.parentThreadId = 'thr_other_planner'; spawned.projectId = 'proj_other'; spawned.visibility = 'hidden'; spawned.archivedAt = 42;
  for (let i = 0; i < 401; i++) { const id = `thr_other_${i}`; f.rows.set(id, bbWire('list', { id, hasPendingInteraction: false, archivedAt: null })); }
  const found = await f.restart().findAgents('task_synthetic', 'run_synthetic');
  assert.equal(found[0]?.id, spawned.id);
  const walks = f.calls.filter(c => c.method === 'threads.list' && c.args.originPluginId);
  assert.deepEqual(walks.map(c => [c.args.archived, c.args.offset]), [[false, 0], [false, 200], [false, 400], [true, 0]]);
  for (const call of walks) { assert.equal(call.args.includeHidden, true); assert.equal(call.args.projectId, undefined); assert.equal(call.args.parentThreadId, undefined); }
  assert.deepEqual(f.calls.filter(c => c.method === 'threads.experimental_listPluginMetadata').map(c => c.args.threadIds.length), [200, 200, 2]);
  assert.equal(f.calls.filter(c => c.method === 'threads.spawn').length, 1);
});

test('BB late spawn is adopted on a later sweep; empty complete search never resends, even after the window', async () => {
  const f = fixture(); f.controls.loseSpawn = true; f.controls.delaySpawn = true;
  await assert.rejects(f.native.createAgent(f.spec()), /unknown delivery/);
  await assert.rejects(f.native.findAgents('task_synthetic', 'run_synthetic'), /later sweep/);
  f.expire();
  await assert.rejects(f.restart().createAgent(f.spec()), /window expired/);
  assert.deepEqual(f.state().agents, {});
  f.land();
  const found = await f.restart().findAgents('task_synthetic', 'run_synthetic');
  assert.equal(found.length, 1);
  assert.equal(f.calls.filter(c => c.method === 'threads.spawn').length, 1);
});

for (const fault of ['unreadable walk', 'partial metadata', 'two matches', 'wrong run'] as const) test(`BB lost spawn with ${fault} stays unknown and unbound`, async () => {
  const f = fixture(); f.controls.loseSpawn = true;
  await assert.rejects(f.native.createAgent(f.spec()));
  const row = [...f.rows.values()][0], meta = f.metadata.get(row.id)!;
  if (fault === 'unreadable walk') f.controls.failList = true;
  if (fault === 'partial metadata') f.controls.partialMetadata = true;
  if (fault === 'two matches') { f.rows.set('thr_duplicate', { ...row, id: 'thr_duplicate' }); f.metadata.set('thr_duplicate', meta); }
  if (fault === 'wrong run') (meta.nucleus as Record<string, unknown>).run = 'another_run';
  await assert.rejects(f.native.findAgents('task_synthetic', 'run_synthetic'));
  assert.deepEqual(f.state().agents, {}); assert.equal(f.workspace().environmentId, undefined);
  assert.equal(f.calls.filter(c => c.method === 'threads.spawn').length, 1);
});

test('BB unknown title write is read back before another write; missing postcondition never authorizes resend', async () => {
  const f = fixture(), agent = await f.native.createAgent(f.spec()); f.controls.loseTitle = true;
  await assert.rejects(f.native.title(agent.id, 'Reviewing: 1270 Synthetic · reviewer needs input', 'title-1'));
  await f.restart().title(agent.id, 'Reviewing: 1270 Synthetic · reviewer needs input', 'title-1');
  assert.equal(f.calls.filter(c => c.method === 'threads.update').length, 1);
  f.controls.titleLands = false;
  await assert.rejects(f.native.title(agent.id, 'Needs attention: 1270 Synthetic', 'title-2'));
  await assert.rejects(f.restart().title(agent.id, 'Needs attention: 1270 Synthetic', 'title-3'), HostUnknownDeliveryError);
  assert.equal(f.calls.filter(c => c.method === 'threads.update').length, 2);
});

test('BB stop observes idle and archive is preceded by cascade proof; foreign dependents remain untouched', async () => {
  const f = fixture(), agent = await f.native.createAgent(f.spec());
  f.rows.get(agent.id).status = 'active';
  await f.native.stopAgentTurn(agent.id); assert.equal((await f.native.observe(agent.id)).active, false);
  f.cascades.set(agent.id, ['thr_foreign']);
  await assert.rejects(f.native.archiveAgent(agent.id), /dependent/);
  assert.equal(f.calls.some(c => c.method === 'threads.archive'), false);
  f.cascades.set(agent.id, []); await f.native.archiveAgent(agent.id);
  const archive = f.calls.findIndex(c => c.method === 'threads.archive');
  assert.equal(f.calls[archive - 1].method, 'threads.experimental_listCascade');
  assert.equal((await f.native.observe(agent.id)).status, 'closed');
  await f.native.archiveAgent(agent.id);
  assert.equal(f.calls.filter(c => c.method === 'threads.archive').length, 1);
});

test('BB recorded wire fixture refuses invented and partial rows', () => {
  assert.throws(() => bbWire('list', { activeTurnId: 'invented' }), /Invented/);
  assert.throws(() => assertBbWire('list', { id: 'partial' }), /Partial/);
});

test('BB catalogue reads recorded provider/model DTOs and projects their offered modes and thinking levels', async () => {
  const f = fixture(); const catalog = await f.native.catalog();
  assert.equal(catalog.providers[0].key, 'codex');
  assert.ok(catalog.providers[0].models[0].thinkingOptions.some(option => option.id === 'high'));
  assert.deepEqual(catalog.providers[0].models[0].modes.map(mode => mode.id), ['accept-edits', 'auto', 'full']);
});
