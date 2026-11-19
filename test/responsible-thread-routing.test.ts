import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import type { Adapter } from '../core/host';
import { formatAgentId } from '../shared/agent-identity';
import { submissionSchema, type Run } from '../shared/contracts';
import { answerFixturePrompt } from './support/delegated-reply';
import { agentAskSchema } from '../core/questions/agent-ask';
import { agentMessageSchema } from '../core/questions/agent-messages';

const repo = '/synthetic/example';
const base = 'a'.repeat(40);
function fixture() {
  const store = new Store(':memory:');
  const archived = new Set<string>(), sent: string[] = [], asked: string[] = [];
  let fail = false, inventories = 0;
  /** The live inventory; a test adds a thread to change candidacy. */
  const threads: Array<{ id: string; title: string; workspaceId: null; directory?: string; updatedAt?: string }> = [
    { id: 'own', title: 'own', workspaceId: null, directory: repo, updatedAt: '2098-01-01T00:00:00Z' },
    { id: 'other', title: 'other', workspaceId: null, directory: repo, updatedAt: '2099-01-02T00:00:00Z' },
  ];
  const adapter = { hostId: 'paseo-synthetic',
    listLiveAgents: async () => { inventories++; return threads.filter(thread => !archived.has(thread.id)); },
    originAgent: async (id: string) => ({ id, title: id, workspaceId: null, archived: archived.has(id) }),
    observe: async (id: string) => ({ id, workspaceId: null, status: archived.has(id) ? 'closed' : 'idle', active: false, permissions: false, error: '', archived: archived.has(id) }),
    notify: async (id: string) => { if (fail) throw Error('delivery failed'); sent.push(id); },
    askPlanner: async (id: string, input: { prompt: string }) => {
      asked.push(id);
      return answerFixturePrompt(engine.resolution, id, input.prompt, 'Answer: Continue\nReason: fixture');
    },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.identifyOriginHost = async () => 'paseo-synthetic';
  store.upsertProject({ key: 'example', name: 'Example', repositories: [{ origin: null, path: repo }] });
  const task = store.insert(submissionSchema.parse({ submissionId: 'fixture', title: 'Fixture', repoPath: repo,
    planningCommit: base, brief: { text: 'Fixture brief' }, originAgentId: 'own' }), 'paseo-synthetic', 'brief', base);
  store.update(task.id, { phase: 'working', runId: 'run', agentId: 'worker', workspaceId: 'ws' });
  store.putRun({ id: 'run', taskId: task.id, role: 'revision', generation: 1, head: base, agentId: 'worker', hostId: 'paseo-synthetic', workspaceId: 'ws', status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false } as unknown as Run);
  store.update(task.id, { resolution: { ...store.task(task.id).resolution, currentRunId: 'run' } });
  store.setCredential('run', 'token');
  const tell = (n: number) => engine.resolution.agentMessage(agentMessageSchema.parse({ eventId: n.toString(16).padStart(64, '0'), taskId: task.id, runId: 'run', to: { project: 'example' }, text: `message ${n}` }), 'token');
  return { store, engine, task, archived, sent, asked, threads, tell, inventories: () => inventories, setFail: (value: boolean) => { fail = value; } };
}

test('own planner is first, and an archived owner falls back to the newest live project thread', async () => {
  const f = fixture();
  try {
    assert.equal((await f.engine.resolution.plannerRungsFor(f.store.task(f.task.id))).rungs[0]?.agentId, 'own');
    f.archived.add('own');
    const rungs = (await f.engine.resolution.plannerRungsFor(f.store.task(f.task.id))).rungs;
    assert.equal(rungs.length, 1);
    assert.match(rungs[0]!.agentId, /other/);
  } finally { f.store.close(); }
});

test('a dispatcher outranks a more recently active repository-only thread, and no live thread records self-handling', async () => {
  const f = fixture();
  try {
    // A design thread in the same checkout, fresher than the task's owner.
    f.threads.push({ id: 'design', title: 'design', workspaceId: null, directory: repo, updatedAt: '2099-06-01T00:00:00Z' });
    // `own` owns this fixture's task, so it is a dispatcher and ranks first.
    assert.equal((await f.tell(1)).status, 'delivered');
    assert.deepEqual(f.sent, ['own']);
    f.archived.add('design'); f.archived.add('own'); f.archived.add('other');
    const receipt = await f.tell(2);
    assert.equal(receipt.status, 'expired');
    assert.match('detail' in receipt ? receipt.detail : '', /No live responsible thread for example; handle it yourself/);
    assert.equal(f.store.message('2'.padStart(64, '0'))?.status, 'expired');
    assert.deepEqual(f.sent, ['own']);
  } finally { f.store.close(); }
});

test('a live registered planner outranks a more recently active repository thread', async () => {
  const f = fixture();
  try {
    const planner = formatAgentId('paseo-synthetic', 'own');
    f.store.setProjectPlanner({ key: 'example', agentId: planner, setBy: 'operator' });
    f.threads.push({ id: 'design', title: 'design', workspaceId: null, directory: repo, updatedAt: '2099-06-01T00:00:00Z' });
    const { RuntimeRepositories } = await import('../core/runtime/repositories');
    const repositories = new RuntimeRepositories({ store: f.store, engine: f.engine, markStoreAccess() {} } as never);
    const project = await repositories.getProject({ key: 'example' });
    assert.equal(project?.responsibleThread?.thread?.agentId, planner);
    assert.deepEqual(project?.responsibleThread?.thread?.reasons, ['registered-planner', 'dispatcher', 'repository-worker']);
    // The message reaches the registered planner, never the more recent design thread.
    assert.equal((await f.tell(3)).status, 'delivered');
    assert.deepEqual(f.sent, ['own']);
  } finally { f.store.close(); }
});

test('a tell from the resolved thread skips itself and never echoes back', async () => {
  const f = fixture();
  try {
    // The thread that resolves this project is the thread sending the tell.
    f.store.setProjectPlanner({ key: 'example', agentId: formatAgentId('paseo-synthetic', 'worker'), setBy: 'operator' });
    f.threads.push({ id: 'worker', title: 'worker', workspaceId: null, directory: repo, updatedAt: '2099-06-01T00:00:00Z' });
    assert.equal((await f.tell(1)).status, 'delivered');
    assert.deepEqual(f.sent, ['own']);
    // With nobody else live the sender handles it itself instead of receiving its own message.
    f.archived.add('other'); f.archived.add('own');
    f.engine.resolution.responsibleThreads.cache.invalidate('example');
    const receipt = await f.tell(2);
    assert.equal(receipt.status, 'expired');
    assert.match('detail' in receipt ? receipt.detail : '', /The sender is the only live responsible thread for example; handle it yourself/);
    assert.deepEqual(f.sent, ['own']);
  } finally { f.store.close(); }
});

test('a failed delivery invalidates the shortlist before the next send', async () => {
  const f = fixture();
  try {
    f.setFail(true); await f.tell(1);
    const before = f.inventories();
    f.setFail(false); await f.tell(2);
    assert.ok(f.inventories() > before);
  } finally { f.store.close(); }
});


test('an ask to a project without a live candidate returns a recorded self-handling receipt', async () => {
  const f = fixture();
  try {
    f.archived.add('own'); f.archived.add('other');
    f.engine.resolution.agentAskPollMs = 10;
    f.engine.resolution.agentAskWaitMs = 1000;
    const request = agentAskSchema.parse({ eventId: 'a'.repeat(64), taskId: f.task.id, runId: 'run', to: { project: 'example' }, question: 'What next?' });
    const result = await f.engine.resolution.agentAsk(request, 'token');
    assert.equal(result.status, 'pending');
    assert.match('detail' in result ? result.detail : '', /No live responsible thread for example; handle it yourself/);
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'agent_ask_self_handle'));
  } finally { f.store.close(); }
});

test('project.get exposes the resolved host, interaction, ranking reasons and cache age', async () => {
  const f = fixture();
  try {
    const { RuntimeRepositories } = await import('../core/runtime/repositories');
    const repositories = new RuntimeRepositories({ store: f.store, engine: f.engine, markStoreAccess() {} } as never);
    const project = await repositories.getProject({ key: 'example' });
    assert.equal(project?.responsibleThread?.thread?.hostId, 'paseo-synthetic');
    assert.match(project!.responsibleThread!.thread!.agentId, /own/);
    assert.deepEqual(project?.responsibleThread?.thread?.reasons, ['dispatcher', 'repository-worker']);
    assert.ok(project?.responsibleThread?.thread?.lastInteraction);
    assert.ok(project!.responsibleThread!.cacheAgeMs >= 0);
  } finally { f.store.close(); }
});


test('ask planner reaches the task planner first, then a live project thread after it is archived', async () => {
  for (const ownerGone of [false, true]) {
    const f = fixture();
    try {
      if (ownerGone) f.archived.add('own');
      f.engine.resolution.agentAskPollMs = 10;
      f.engine.resolution.agentAskWaitMs = 3000;
      const request = agentAskSchema.parse({ eventId: 'b'.repeat(64), taskId: f.task.id, runId: 'run', to: 'planner', question: 'What next?' });
      const receipt = await f.engine.resolution.agentAsk(request, 'token');
      assert.equal(receipt.status, 'answered');
      assert.deepEqual(f.asked, [ownerGone ? 'other' : 'own']);
    } finally { f.store.close(); }
  }
});


test('project.get refreshes an invalidated observation before showing a recipient', async () => {
  const f = fixture();
  try {
    const { RuntimeRepositories } = await import('../core/runtime/repositories');
    const repositories = new RuntimeRepositories({ store: f.store, engine: f.engine, markStoreAccess() {} } as never);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.engine.resolution.plannerPresence.threadRoute.bind(f.engine.resolution.plannerPresence);
    let observing!: () => void;
    const started = new Promise<void>(resolve => { observing = resolve; });
    let first = true;
    f.engine.resolution.plannerPresence.threadRoute = async (...args) => {
      if (first) {
        first = false;
        observing();
        await gate;
        return { kind: 'routable' }; // The former observation finishes after invalidation.
      }
      return original(...args);
    };
    const pending = repositories.getProject({ key: 'example' });
    await started;
    f.archived.add('other');
    f.engine.resolution.responsibleThreads.cache.invalidate('example');
    release();
    assert.equal((await pending)?.responsibleThread?.thread?.agentId, formatAgentId('paseo-synthetic', 'own'));
    assert.equal(f.inventories(), 2);
  } finally { f.store.close(); }
});

test('an unreadable candidate leaves a verified recipient available to synchronous notice producers', async () => {
  const f = fixture();
  try {
    const resolution = f.engine.resolution, project = f.store.projectByKey('example')!;
    const original = resolution.plannerPresence.threadRoute.bind(resolution.plannerPresence);
    resolution.plannerPresence.threadRoute = async (id, hostId) =>
      id === formatAgentId('paseo-synthetic', 'other') ? { kind: 'unverified', detail: 'Host observation failed' } : original(id, hostId);
    const own = formatAgentId('paseo-synthetic', 'own');
    for (let i = 0; i < 2; i++) {
      assert.equal((await resolution.responsibleThread(project)).thread?.agentId, own);
      assert.equal(f.store.projectPlannerRecipient(project), own);
    }
    assert.equal(f.inventories(), 1);
    resolution.plannerPresence.threadRoute = original;
    f.archived.add('other');
    assert.equal((await resolution.responsibleThread(project)).thread?.agentId, own);
    assert.deepEqual(resolution.responsibleThreads.cache.peek(project.key)?.threads.map(thread => thread.agentId), [own]);
    assert.equal(f.store.projectPlannerRecipient(project), own);
    await resolution.responsibleThread(project);
    assert.equal(f.inventories(), 2);

  } finally { f.store.close(); }
});

test('a registered planner whose read exceeds the budget is still picked and delivered, marked unverified', async () => {
  const f = fixture();
  try {
    const resolution = f.engine.resolution;
    const planner = formatAgentId('paseo-synthetic', 'own');
    f.store.setProjectPlanner({ key: 'example', agentId: planner, setBy: 'operator' });
    resolution.responsibleObservationMs = 20;
    const original = resolution.plannerPresence.threadRoute.bind(resolution.plannerPresence);
    resolution.plannerPresence.threadRoute = async (id, hostId) => {
      if (id === planner) await new Promise(done => setTimeout(done, 200));
      return original(id, hostId);
    };
    const { RuntimeRepositories } = await import('../core/runtime/repositories');
    const repositories = new RuntimeRepositories({ store: f.store, engine: f.engine, markStoreAccess() {} } as never);
    const project = await repositories.getProject({ key: 'example' });
    assert.equal(project?.responsibleThread?.thread?.agentId, planner);
    const top = project!.responsibleThread!.shortlist[0]!;
    assert.equal(top.agentId, planner);
    assert.equal(top.observation?.state, 'unverified');
    assert.match(top.observation?.detail ?? '', /timed out/);
    assert.equal((await f.tell(1)).status, 'delivered');
    assert.deepEqual(f.sent, ['own']);
  } finally { f.store.close(); }
});

test('the sender is removed before the pick, even when its own read is slow or unverified', async () => {
  const f = fixture();
  try {
    const resolution = f.engine.resolution;
    const sender = formatAgentId('paseo-synthetic', 'worker');
    f.store.setProjectPlanner({ key: 'example', agentId: sender, setBy: 'operator' });
    f.threads.push({ id: 'worker', title: 'worker', workspaceId: null, directory: repo, updatedAt: '2099-06-01T00:00:00Z' });
    resolution.responsibleObservationMs = 20;
    const original = resolution.plannerPresence.threadRoute.bind(resolution.plannerPresence);
    resolution.plannerPresence.threadRoute = async (id, hostId) => {
      if (id === sender) await new Promise(done => setTimeout(done, 200));
      return original(id, hostId);
    };
    // The sender is the registered planner and ranks first; it is never picked, so the dispatcher B answers.
    assert.equal((await f.tell(1)).status, 'delivered');
    assert.deepEqual(f.sent, ['own']);
  } finally { f.store.close(); }
});

test('a candidate that answers as a different thread is never picked', async () => {
  const f = fixture();
  try {
    const resolution = f.engine.resolution;
    const original = resolution.plannerPresence.threadRoute.bind(resolution.plannerPresence);
    resolution.plannerPresence.threadRoute = async (id, hostId) =>
      id === formatAgentId('paseo-synthetic', 'own') ? { kind: 'unroutable', detail: 'the host returned a different thread' } : original(id, hostId);
    assert.equal((await f.tell(1)).status, 'delivered');
    assert.deepEqual(f.sent, ['other']);
  } finally { f.store.close(); }
});

test('project.get shows the shortlist with each observation, and a positively archived candidate leaves it', async () => {
  const f = fixture();
  try {
    const { RuntimeRepositories } = await import('../core/runtime/repositories');
    const repositories = new RuntimeRepositories({ store: f.store, engine: f.engine, markStoreAccess() {} } as never);
    const first = await repositories.getProject({ key: 'example' });
    const shortlist = first!.responsibleThread!.shortlist;
    assert.deepEqual(shortlist.map(thread => thread.agentId), [formatAgentId('paseo-synthetic', 'own'), formatAgentId('paseo-synthetic', 'other')]);
    for (const thread of shortlist) {
      assert.equal(thread.observation?.state, 'routable');
      assert.equal(thread.observation?.detail, null);
      assert.ok(!Number.isNaN(Date.parse(thread.observation!.observedAt)));
    }
    // A positively archived candidate is dropped on the next read, without a fresh inventory.
    f.archived.add('other');
    const second = await repositories.getProject({ key: 'example' });
    assert.deepEqual(second!.responsibleThread!.shortlist.map(thread => thread.agentId), [formatAgentId('paseo-synthetic', 'own')]);
    assert.equal(second!.responsibleThread!.thread?.agentId, formatAgentId('paseo-synthetic', 'own'));
  } finally { f.store.close(); }
});
