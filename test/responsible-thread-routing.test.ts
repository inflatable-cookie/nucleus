import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import type { Adapter } from '../core/host';
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
  const adapter = { hostId: 'paseo-synthetic',
    listLiveAgents: async () => { inventories++; return [
      { id: 'own', title: 'own', workspaceId: null, directory: repo, updatedAt: '2098-01-01T00:00:00Z' },
      { id: 'other', title: 'other', workspaceId: null, directory: repo, updatedAt: '2099-01-02T00:00:00Z' },
    ].filter(thread => !archived.has(thread.id)); },
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
  return { store, engine, task, archived, sent, asked, tell, inventories: () => inventories, setFail: (value: boolean) => { fail = value; } };
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

test('tell chooses the latest live thread, and no live thread produces a recorded self-handling receipt', async () => {
  const f = fixture();
  try {
    assert.equal((await f.tell(1)).status, 'delivered');
    assert.deepEqual(f.sent, ['other']);
    f.archived.add('other'); f.archived.add('own');
    const receipt = await f.tell(2);
    assert.equal(receipt.status, 'expired');
    assert.match('detail' in receipt ? receipt.detail : '', /No live responsible thread for example; handle it yourself/);
    assert.equal(f.store.message('2'.padStart(64, '0'))?.status, 'expired');
    assert.deepEqual(f.sent, ['other']);
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

test('project.get exposes the resolved host, interaction and cache age', async () => {
  const f = fixture();
  try {
    const { RuntimeRepositories } = await import('../core/runtime/repositories');
    const repositories = new RuntimeRepositories({ store: f.store, engine: f.engine, markStoreAccess() {} } as never);
    const project = await repositories.getProject({ key: 'example' });
    assert.equal(project?.responsibleThread?.thread?.hostId, 'paseo-synthetic');
    assert.match(project!.responsibleThread!.thread!.agentId, /other/);
    assert.equal(project?.responsibleThread?.thread?.lastInteraction, '2099-01-02T00:00:00Z');
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


test('an invalidation during live observation fences the stale recipient', async () => {
  const f = fixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.engine.resolution.plannerPresence.threadRoute.bind(f.engine.resolution.plannerPresence);
    let observing!: () => void;
    const started = new Promise<void>(resolve => { observing = resolve; });
    f.engine.resolution.plannerPresence.threadRoute = async (...args) => { observing(); await gate; return original(...args); };
    const pending = f.engine.resolution.responsibleThread(f.store.projectByKey('example')!);
    await started;
    f.engine.resolution.responsibleThreads.cache.invalidate('example');
    release();
    await assert.rejects(pending, /invalidated during observation/);
    assert.deepEqual(f.sent, []);
  } finally { f.store.close(); }
});
