/**
 * Audit A6 (2026-10-25 performance audit, main at d5e20937): Queue observed
 * Paseo once per run and once per retired worker on every 20 s pass — about 58
 * observes per pass and 235 calls a minute against a 480-a-minute budget — and
 * the writes those reads caused fed the board rebuild. This file proves the
 * bounded replacement through the default route, not an engine-only stub:
 *
 * - one complete labelled inventory per pass answers the identities its list
 *   entries really carry, with exactly the fields `observe` reads;
 * - a partial, repeated or unreadable pagination answers nothing, and an
 *   identity the inventory does not answer takes the narrow per-agent read;
 * - retired workers are re-read on their bounded cadence with lifecycle
 *   invalidation, and a pass that learned nothing persists no observation;
 * - the parent shape — one observe per run and per retired worker every pass —
 *   is implemented beside the new one and reproduces the cost this change
 *   removes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { Engine, RETIRED_OBSERVATION_INTERVAL_MS } from '../core/engine';
import { PaseoAdapter, observationFromInventoryEntry, type Adapter, type AgentObservation } from '../service/paseo-composition';
import { Resolution } from '../core/resolution';
import { runSchema, submissionSchema, type Profile, type Task } from '../shared/contracts';

const profile: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };

/** A daemon snapshot both `observe` (through a refreshed handle) and `agents.list` read. */
function snapshot(overrides: Record<string, unknown> = {}) {
  return { id: 'agent-1', workspaceId: 'ws-1', status: 'idle', activeTurn: null, pendingPermissions: [] as unknown[],
    labels: { 'nucleus.plugin': 'nucleus', 'nucleus.task': 'task-1' }, lastError: undefined,
    runtimeInfo: { provider: 'test', model: 'test', modeId: 'default', thinkingOptionId: 'low' },
    model: 'test', provider: 'test', updatedAt: '2026-10-25T00:00:00.000Z', lastUserMessageAt: null,
    requiresAttention: false, archivedAt: null, ...overrides };
}

/** The default adapter's `observe`, reading the same daemon snapshot from a refreshed handle. */
function observingAdapter(target: Record<string, unknown>, calls?: Map<string, number>): PaseoAdapter {
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/report.mjs');
  (adapter as unknown as { api: unknown }).api = { agents: { ref: () => ({
    workspaceId: target.workspaceId, status: target.status, activeTurn: target.activeTurn, pendingPermissions: target.pendingPermissions,
    runtimeInfo: target.runtimeInfo, lastError: target.lastError,
    refresh: async () => true, current: () => target,
  }) } };
  if (calls) {
    const original = adapter.observe.bind(adapter);
    (adapter as unknown as { observe: (id: string) => Promise<AgentObservation> }).observe = async (id: string) => {
      calls.set('observe', (calls.get('observe') ?? 0) + 1);
      return original(id);
    };
  }
  return adapter;
}

/** The default adapter's `observationInventory`, backed by a fake `agents.list` at the same SDK boundary. */
function inventoryAdapter(pages: Array<{ entries: unknown[]; hasMore?: boolean; nextCursor?: string | null }>,
  calls?: Map<string, number>, seen: { options?: unknown } = {}): PaseoAdapter {
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/report.mjs');
  let page = 0;
  (adapter as unknown as { api: unknown }).api = { agents: { list: async (options: unknown) => {
    calls?.set('list', (calls.get('list') ?? 0) + 1);
    seen.options = options;
    const current = pages[Math.min(page++, pages.length - 1)]!;
    return { entries: current.entries, pageInfo: { hasMore: current.hasMore ?? false, nextCursor: current.nextCursor ?? null, prevCursor: null } };
  } } };
  return adapter;
}

test('inventory entries carry exactly the fields observe reads, for active, idle, permission and foreign-workspace states', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['active', { status: 'running', activeTurn: { turnId: 'turn-1', startedAt: '2026-10-25T00:01:00.000Z' } }],
    ['idle', { status: 'idle' }],
    ['permission', { status: 'idle', pendingPermissions: [{ id: 'perm-1', kind: 'question', name: 'request_user_input',
      description: 'Which contract?\nThe approved one.' }] }],
    ['foreign workspace', { workspaceId: 'ws-foreign', status: 'idle' }],
    ['error', { status: 'error', lastError: 'provider stopped' }],
  ];
  for (const [label, overrides] of cases) {
    const target = snapshot(overrides);
    const observed = await observingAdapter(target).observe('agent-1');
    const inventoried = observationFromInventoryEntry(target);
    assert.ok(inventoried, `${label}: the list entry answers the observation`);
    assert.deepEqual(inventoried, observed, `${label}: the inventory answer is the observation observe returns`);
  }
  // A contradictory pair is reported as it is; an active turn is still active.
  const contradiction = snapshot({ status: 'idle', activeTurn: { turnId: 'turn-2', startedAt: null } });
  assert.equal(observationFromInventoryEntry(contradiction)?.active, true);
  assert.equal(observationFromInventoryEntry(contradiction)?.activeTurnId, 'turn-2');
  // Anything absent or of the wrong shape answers nothing, so the caller takes the narrow read.
  assert.equal(observationFromInventoryEntry(snapshot({ status: undefined })), null);
  assert.equal(observationFromInventoryEntry(snapshot({ pendingPermissions: undefined })), null);
  assert.equal(observationFromInventoryEntry(snapshot({ id: '' })), null);
  assert.equal(observationFromInventoryEntry(null), null);
});

test('one complete labelled inventory answers the pass, and a partial list answers nothing', async () => {
  const calls = new Map<string, number>();
  const seen: { options?: unknown } = {};
  const first = snapshot({ id: 'agent-1' });
  const second = snapshot({ id: 'agent-2', status: 'running', activeTurn: { turnId: 'turn-9', startedAt: null }, workspaceId: 'ws-2' });
  const foreign = snapshot({ id: 'agent-foreign' });
  const complete = inventoryAdapter([{ entries: [{ agent: first }, { agent: second }, { agent: foreign }] }], calls, seen);
  const inventory = await complete.observationInventory(['agent-1', 'agent-2', 'agent-missing']);
  assert.ok(inventory, 'a list walked to its own end is a complete inventory');
  assert.deepEqual([...inventory.keys()].sort(), ['agent-1', 'agent-2'], 'only the requested threads are answered');
  assert.equal(calls.get('list'), 1, 'one label generation is one page walk');
  const options = seen.options as { filter?: { labels?: Record<string, string>; includeArchived?: boolean } } | undefined;
  assert.deepEqual(options?.filter, { labels: { 'nucleus.plugin': 'nucleus' }, includeArchived: false },
    'the inventory is the live Queue label set; archived history never enters the walk');

  // Pagination that never positively ends, repeats a cursor or loses one is not a complete list.
  for (const [label, pages] of [
    ['open end', [{ entries: [{ agent: first }], hasMore: true, nextCursor: 'c1' }, { entries: [{ agent: second }], hasMore: true, nextCursor: null }]],
    ['repeated cursor', [{ entries: [{ agent: first }], hasMore: true, nextCursor: 'c1' }, { entries: [{ agent: second }], hasMore: true, nextCursor: 'c1' }]],
    ['missing cursor', [{ entries: [{ agent: first }], hasMore: true, nextCursor: null }]],
  ] as const) {
    assert.equal(await inventoryAdapter(pages as never).observationInventory(['agent-1']), null, `${label}: no inventory`);
  }
  // A complete list still answers nothing for a thread whose entry lacks observe's fields.
  const partialEntries = inventoryAdapter([{ entries: [{ agent: { id: 'agent-1', workspaceId: 'ws-1' } }] }]);
  assert.deepEqual([...(await partialEntries.observationInventory(['agent-1']))!.keys()], [],
    'a list entry without the observation fields leaves the identity to the narrow read');

  const empty = await inventoryAdapter([]).observationInventory([]);
  assert.ok(empty && empty.size === 0, 'no requested identity reads no list');
  assert.equal(calls.get('list'), 1, 'the only list read was the one complete walk');
});

/** A task occupying a slot with a retired worker, and no current run of its own. */
function retiredTask(store: Store, agentId: string, workspaceId = 'ws-1'): Task {
  const submitted = store.insert(submissionSchema.parse({ submissionId: `submission-${agentId}`, title: 'Retired work', repoPath: '/project',
    planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
  return store.update(submitted.id, { phase: 'working', workspaceId, retiredWorkers: [{ agentId, runId: `run-${agentId}`, profile, reason: 'Operator stop' }] });
}

function engineFixture(adapter: Partial<Adapter> & Pick<Adapter, 'observe'>, store = new Store(':memory:')) {
  const full = { profiles: async () => [profile], validate: async (task: Task) => task.planningCommit, findAgents: async () => [],
    findWorkspaces: async () => [], createWorkspace: async () => { throw new Error('no dispatch'); },
    createAgent: async () => { throw new Error('no dispatch'); }, verifyWorkspace: async (task: Task) => task.branch,
    archiveAgent: async () => {}, ...adapter } as Adapter;
  const engine = new Engine(store, full, 0);
  engine.profiles = [profile];
  return { store, engine, adapter: full };
}

test('retired workers are re-read on their bounded cadence and an unchanged pass persists nothing', async t => {
  const observeCalls: string[] = [];
  const { store, engine } = engineFixture({ observe: async id => { observeCalls.push(id); return { id, workspaceId: 'ws-1', status: 'idle', active: false, permissions: false, error: '' }; } });
  try {
    retiredTask(store, 'retired-1');
    const writes: string[] = [];
    const write = store.setMeta.bind(store);
    (store as unknown as { setMeta: (key: string, value: unknown) => void }).setMeta = (key: string, value: unknown) => { writes.push(key); write(key, value); };

    await engine.wake();
    assert.deepEqual(observeCalls, ['retired-1'], 'the first pass reads the retired worker');
    assert.equal(writes.filter(key => key === 'retiredObservations').length, 1);
    const first = JSON.stringify(store.getMeta('retiredObservations'));
    assert.deepEqual(JSON.parse(first), { 'retired-1': { active: false, at: JSON.parse(first)['retired-1'].at } });

    writes.length = 0;
    await engine.wake();
    assert.deepEqual(observeCalls, ['retired-1'], 'the parent-shape second read is removed by the cadence');
    assert.equal(writes.filter(key => key === 'retiredObservations').length, 0, 'an unchanged pass writes no observation record');
    assert.equal(JSON.stringify(store.getMeta('retiredObservations')), first);

    // A lifecycle signal makes that identity due at once, without waiting out the cadence.
    engine.noteLifecycleSignal({ agentId: 'retired-1' });
    await engine.wake();
    assert.deepEqual(observeCalls, ['retired-1', 'retired-1']);

    // A workspace-wide signal names the retired worker's workspace.
    engine.noteLifecycleSignal({ workspaceId: 'ws-1' });
    await engine.wake();
    assert.equal(observeCalls.length, 3);

    // The cadence itself expires the record: an old observation is re-read.
    const record = JSON.parse(first);
    record['retired-1'].at = new Date(Date.now() - RETIRED_OBSERVATION_INTERVAL_MS - 1_000).toISOString();
    store.setMeta('retiredObservations', record);
    await engine.wake();
    assert.equal(observeCalls.length, 4, 'a record past its cadence is re-read');
    // The parent shape read every retired worker on every pass; four passes here
    // would have been five reads (one per pass) instead of this task's four.
    t.diagnostic(JSON.stringify({ retiredWorkers: 1, passes: 5, parentObserveCalls: 5, observes: observeCalls.length,
      cadenceMs: RETIRED_OBSERVATION_INTERVAL_MS, runWrites: 'observation-only, no board revision' }));
  } finally { store.close(); }
});

test('a pass observes runs from one inventory and falls back to the narrow read for an unlisted run', async t => {
  const calls = new Map<string, number>();
  const observedIds: string[] = [];
  const { store, engine } = engineFixture({ observe: async id => {
    calls.set('observe', (calls.get('observe') ?? 0) + 1);
    observedIds.push(id);
    return { id, workspaceId: 'ws-run', status: 'running', active: true, permissions: false, error: '' };
  } });
  try {
    const task = retiredTask(store, 'retired-none');
    const run = runSchema.parse({ id: 'run-1', taskId: task.id, role: 'reviewer', generation: 1, head: '6'.repeat(40), base: '7'.repeat(40),
      agentId: 'agent-1', workspaceId: 'ws-run', profile: null, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: null, idleSince: null, released: false, completion: null });
    store.putRun(run);
    store.update(task.id, { phase: 'reviewing', resolution: { ...store.task(task.id).resolution, currentRunId: run.id, reviewerAgentId: 'agent-1' } });

    // The shared inventory answers the run's identity; no per-run observe happens.
    const answered = new Map<string, AgentObservation>([['agent-1', { id: 'agent-1', workspaceId: 'ws-run', status: 'running', active: true, permissions: false, error: '' }]]);
    let inventoryCalls = 0;
    const withInventory = (inventory: Adapter['observationInventory']) => {
      (engine as unknown as { adapter: Partial<Adapter> }).adapter = { ...(engine as unknown as { adapter: Partial<Adapter> }).adapter, observationInventory: inventory };
    };
    withInventory(async (ids: readonly string[]) => { inventoryCalls++; assert.ok(ids.includes('agent-1')); return answered; });
    calls.clear(); observedIds.length = 0;
    await engine.wake();
    assert.equal(inventoryCalls, 1, 'one inventory read per pass');
    assert.equal(observedIds.includes('agent-1'), false, 'a listed identity is never observed again per run');
    assert.ok(observedIds.every(id => id.startsWith('retired-')), 'only the due retired worker takes a narrow read');
    assert.equal(store.run('run-1')?.active, true);

    // The same pass with an inventory that does not answer the run: the narrow read is used.
    withInventory(async () => new Map());
    calls.clear(); observedIds.length = 0;
    await engine.wake();
    assert.deepEqual(observedIds.filter(id => id === 'agent-1'), ['agent-1'], 'an unanswered identity takes the narrow fresh observation');

    // A partial inventory (null) leaves every identity to the narrow read as well.
    withInventory(async () => null);
    calls.clear(); observedIds.length = 0;
    await engine.wake();
    assert.deepEqual(observedIds.filter(id => id === 'agent-1'), ['agent-1'], 'a partial inventory leaves every identity to the narrow read');

    // The parent shape reads per run every pass; this fixture runs that shape
    // beside the new one, so the saved read is falsifiable rather than asserted.
    const resolution = new Resolution(store, (engine as unknown as { adapter: Adapter }).adapter, () => [profile], () => false);
    assert.deepEqual(resolution.observationTargets(), ['agent-1']);
    observedIds.length = 0;
    for (const id of resolution.observationTargets()) await (engine as unknown as { adapter: Adapter }).adapter.observe(id);
    assert.deepEqual(observedIds, ['agent-1'], 'the parent shape reads the run identity every pass');
    observedIds.length = 0;
    await resolution.observe(answered);
    assert.deepEqual(observedIds, [], 'the same pass with the inventory reads no per-run observation');
    t.diagnostic(JSON.stringify({ runs: 1, passes: 4, parentObservePerPass: 1, inventoryReads: inventoryCalls,
      narrowObservesPerAnsweredPass: 0, narrowObservesForUnanswered: 2 }));
  } finally { store.close(); }
});

test('agent discovery queries the Nucleus labels and still reads a retained run name from stored history', async () => {
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/report.mjs');
  // `old` is a thread created before Nucleus: history, and never returned by a
  // live-label query. `retained` keeps the run label it was launched with.
  const old = snapshot({ id: 'old', labels: { 'northstar.task': 'task', 'northstar.run': 'run' } });
  const modern = snapshot({ id: 'new', labels: { 'nucleus.task': 'task', 'nucleus.run': 'run' } });
  const retained = snapshot({ id: 'retained', labels: { 'nucleus.task': 'task', 'northstar.run': 'run', 'nucleus.run': 'run' } });
  const rows = [old, modern, retained];
  const queries: Record<string, string>[] = [];
  (adapter as unknown as { api: unknown }).api = { agents: { list: async ({ filter }: { filter: { labels: Record<string, string> } }) => {
    queries.push(filter.labels);
    return { entries: rows.filter(row => Object.entries(filter.labels).every(([key, value]) => (row.labels as Record<string, string>)[key] === value)).map(agent => ({ agent })), pageInfo: { hasMore: false } };
  } } };
  const task = { id: 'task', runId: 'run' } as Task;
  assert.deepEqual((await adapter.findAgents(task)).map(x => x.id).sort(), ['new', 'retained']);
  assert.deepEqual(queries, [{ 'nucleus.task': 'task' }], 'the lookup never asks for the retired label');
  // A recorded run label the task does not know is not this task's thread either.
  (retained.labels as Record<string, string>)['nucleus.run'] = 'another-run';
  (retained.labels as Record<string, string>)['northstar.run'] = 'another-run';
  assert.deepEqual((await adapter.findAgents(task)).map(x => x.id), ['new']);
  // A split identity in stored history is refused, never guessed.
  (retained.labels as Record<string, string>)['nucleus.run'] = 'run';
  (retained.labels as Record<string, string>)['northstar.run'] = 'other';
  await assert.rejects(adapter.findAgents(task), /Conflicting/);
});
