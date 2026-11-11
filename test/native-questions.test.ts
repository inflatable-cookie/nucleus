import { observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Engine } from '../core/engine';
import { Store, digest } from '../core/store/store';
import { submissionSchema, summarizeTask } from '../shared/contracts';
import { formatAgentId } from '../shared/agent-identity';
import type { Adapter } from '../core/host/adapter';
import { mount, useNativeStubs } from './support/render';
useNativeStubs();

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (ready: () => boolean) => { for (let i = 0; i < 30 && !ready(); i++) await tick(); assert.ok(ready()); };
const request = { id: 'permission-1', kind: 'question', input: { questions: [{ header: 'Question 1', question: 'Choose a branch?', options: [{ label: 'main' }] }] } };

test('superseding a Nucleus-raised native question dismisses it through the host', async () => {
  const store = new Store(':memory:');
  store.setMeta('paused', false);
  store.setMeta('hostId', 'host');
  const task = store.insert(submissionSchema.parse({
    submissionId: 'q', title: 'Q', repoPath: '/repo', planningCommit: 'a'.repeat(40),
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', 'a'.repeat(40));
  store.update(task.id, { phase: 'working', agentId: 'worker', workspaceId: 'workspace', runId: 'initial' });
  const questionId = 'budget-1';
  store.event(task.id, 'operator_question', `${questionId}: kind budget; stop none; head none; question abc (3 chars); options Yes`);
  const dismissed: unknown[] = [];
  const adapter = {
    pendingQuestions: async (id: string) => id === 'worker' ? [
      { requestId: 'native-1', questions: [{ header: 'Question 1', question: `[Queue decision ${questionId}] Continue?`, options: ['Yes'] }] },
      { requestId: 'other', questions: [{ header: 'Question 1', question: 'Unrelated host question?', options: [] }] },
    ] : [],
    dismissNativeQuestion: async (...args: unknown[]) => { dismissed.push(args); },
    observe: observeIdle('workspace'),
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  try {
    engine.resolution.supersedeOpenOwnerQuestions(task.id, 'next applied');
    assert.ok(store.eventsAll(task.id).some(event => event.kind === 'operator_question_superseded' && event.detail.startsWith(`${questionId}:`)));
    assert.ok(store.eventsAll(task.id).some(event => event.kind === 'native_question_dismiss_intent' && event.detail.startsWith(`${questionId}:`)));
    for (let i = 0; i < 20 && dismissed.length === 0; i++) await tick();
    assert.deepEqual(dismissed, [['worker', 'workspace', 'native-1']]);
    assert.ok(store.eventsAll(task.id).some(event => event.kind === 'native_question_dismissed' && event.detail.includes('native-1')));
  } finally { await engine.stop(); store.close(); }
});

test('equal native question identities on two hosts do not share an in-flight key', async () => {
  const store = new Store(':memory:'); store.setMeta('paused', false);
  const add = (id: string, host: string) => {
    const task = store.insert(submissionSchema.parse({ submissionId: id, title: id, repoPath: '/repo', planningCommit: 'a'.repeat(40),
      handoffPath: 'handoff.md', originAgentId: 'origin' }), host, 'handoff', 'a'.repeat(40));
    return store.update(task.id, { phase: 'working', agentId: 'same', workspaceId: 'workspace' });
  };
  const a = add('a', 'host-a'), b = add('b', 'host-b');
  const legacy = digest('native-question:same:permission');
  store.event(a.id, 'native_question_delegated', `${legacy}: same; permission permission`);
  const question = { requestId: 'permission', questions: [{ header: 'Q', question: 'Choose?', options: ['Yes'] }] };
  const adapter = { pendingQuestions: async () => [question], answerNativeQuestion: async () => {} } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.resolveHostAdapter = () => adapter; engine.hostAvailable = () => true;
  const observed: Array<{ host: string | undefined; id: string; taskId: string }> = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  engine.resolution.answerNativeQuestions = async (taskId, _agent, _workspace, id) => {
    observed.push({ host: engine.activeHostId, id, taskId }); await held;
  };
  try {
    await engine.resolution.delegateNativeQuestions();
    assert.equal(observed.length, 2);
    assert.equal(observed.find(item => item.taskId === a.id)?.id, legacy);
    assert.notEqual(observed.find(item => item.taskId === b.id)?.id, legacy);
    assert.deepEqual(observed.map(item => item.host).sort(), ['host-a', 'host-b']);
  } finally { release(); await engine.stop(); store.close(); }
});

test('native question pill mirrors and resolves the daemon request', async () => {
  const { registerNativeQuestionPills } = await import('../client/native-questions');
  let pending: unknown[] = [request];
  let captured: any, removed = 0, answered: unknown;
  const agent = () => ({ id: 'worker', workspaceId: 'workspace', pendingPermissions: pending });
  const client = { agents: {
    list: async () => ({ entries: [{ agent: agent() }], pageInfo: { hasMore: false } }),
    ref: () => ({ refresh: async () => ({ agent: agent() }), respondToPermission: async (input: unknown) => { answered = input; pending = []; } }),
  }, addComposerPill: (pill: unknown) => { captured = pill; return { remove: () => removed++, update: () => {} }; } } as any;
  const stop = registerNativeQuestionPills(client, 10);
  await settle(() => !!captured);
  const Content = captured.button.behavior.Content;
  const ui = mount(React.createElement(Content, { context: 'agent', agentId: 'worker', workspaceId: 'workspace', theme: { colors: new Proxy({}, { get: () => '#000' }) }, close() {} }));
  await settle(() => ui.text().includes('Choose a branch?'));
  ui.type('Answer Choose a branch?', 'main');
  ui.press('Submit answers');
  await settle(() => !!answered);
  assert.deepEqual(answered, { requestId: 'permission-1', response: { behavior: 'allow', updatedInput: { answers: { 'Question 1': 'main' } } } });
  await settle(() => ui.text().includes('No open questions.'));
  await settle(() => removed > 0);
  ui.update(React.createElement('View')); stop();
});

test('web question projections keep equal native IDs on separate hosts', async () => {
  const { bindWebQuestions, updateWebQuestions, useTaskQuestions } = await import('../client/native-questions');
  const store = new Store(':memory:');
  const add = (host: string) => {
    const task = store.insert(submissionSchema.parse({ submissionId: host, title: host, repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), host, 'h', 'a'.repeat(40));
    return summarizeTask(store.update(task.id, { agentId: 'same' }));
  };
  const a = add('a'), b = add('b');
  const refA = formatAgentId(a.hostId!, a.questionAgentIds![0]!);
  const refB = formatAgentId(b.hostId!, b.questionAgentIds![0]!);
  assert.notEqual(refA, refB);
  const stop = bindWebQuestions(async () => {});
  function Card({ task }: { task: typeof a }) {
    const questions = useTaskQuestions(task.questionAgentIds ?? [], task.hostId ? task.questionAgentIds?.map(id => formatAgentId(task.hostId!, id)) : []);
    return React.createElement('Text', null, questions.map(q => q.questions[0]?.question).join(','));
  }
  const uiA = mount(React.createElement(Card, { task: a }));
  const uiB = mount(React.createElement(Card, { task: b }));
  updateWebQuestions(refA, [{ id: 'p', questions: [{ header: 'Q', question: 'Host A', options: [] }] }]);
  await settle(() => uiA.text().includes('Host A'));
  assert.doesNotMatch(uiB.text(), /Host A/);
  updateWebQuestions(refB, [{ id: 'p', questions: [{ header: 'Q', question: 'Host B', options: [] }] }]);
  await settle(() => uiB.text().includes('Host B'));
  assert.doesNotMatch(uiA.text(), /Host B/);
  updateWebQuestions(refA, []); updateWebQuestions(refB, []);
  stop(); uiA.update(React.createElement('View')); uiB.update(React.createElement('View')); store.close();
});

test('native answer elsewhere clears the pill on refresh', async () => {
  const { registerNativeQuestionPills, nativeQuestions } = await import('../client/native-questions');
  let pending: unknown[] = [request], registered = false, removed = false;
  const client = { agents: { list: async () => ({ entries: [{ agent: { id: 'reviewer', workspaceId: 'workspace', pendingPermissions: pending } }], pageInfo: { hasMore: false } }) },
    addComposerPill: () => { registered = true; return { remove: () => { removed = true; }, update() {} }; } } as any;
  const stop = registerNativeQuestionPills(client, 10);
  await settle(() => registered);
  pending = [];
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(removed);
  assert.deepEqual(nativeQuestions([{ id: 'other', kind: 'tool' }, request]), [{ id: 'permission-1', questions: [{ header: 'Question 1', question: 'Choose a branch?', options: ['main'] }] }]);
  stop();
});

test('board question view follows the shared observer without a Paseo provider', async () => {
  const { registerNativeQuestionPills, useTaskQuestions } = await import('../client/native-questions');
  let pending: unknown[] = [request];
  const client = { agents: { list: async () => ({ entries: [{ agent: { id: 'worker', workspaceId: 'workspace', pendingPermissions: pending } }], pageInfo: { hasMore: false } }) },
    addComposerPill: () => ({ remove() {}, update() {} }) } as any;
  function Card() {
    const questions = useTaskQuestions(['worker']);
    return React.createElement('Text', null, questions.flatMap(q => q.questions.map(item => item.question)).join(', ') || 'No question');
  }
  const ui = mount(React.createElement(Card));
  assert.match(ui.text(), /No question/);
  const stop = registerNativeQuestionPills(client, 10);
  await settle(() => ui.text().includes('Choose a branch?'));
  pending = [];
  await new Promise(resolve => setTimeout(resolve, 30));
  await settle(() => ui.text().includes('No question'));
  stop(); ui.update(React.createElement('View'));
});

/**
 * Task 538: the task detail answers the same native request the pill mirrors, so
 * the answer controls and the protocol stay one path.
 */
test('the detail answer control submits the native request and reports a missing client', async () => {
  const { answerNativeQuestion, NativeQuestionAnswer, registerNativeQuestionPills } = await import('../client/native-questions');
  const colors = new Proxy({}, { get: () => '#000' }) as never;
  // No pill observer has registered a client in this process: nothing may pretend to answer.
  await assert.rejects(() => answerNativeQuestion('worker', 'permission-1', { 'Question 1': 'main' }), /answerable in its pill on the thread/);

  let pending: unknown[] = [request], answered: unknown, answeredCallback = 0;
  const agent = () => ({ id: 'worker', workspaceId: 'workspace', pendingPermissions: pending });
  const client = { agents: {
    list: async () => ({ entries: [{ agent: agent() }], pageInfo: { hasMore: false } }),
    ref: () => ({ refresh: async () => ({ agent: agent() }), respondToPermission: async (input: unknown) => { answered = input; pending = []; } }),
  }, addComposerPill: () => ({ remove() {}, update() {} }) } as any;
  const stop = registerNativeQuestionPills(client, 10);
  const ui = mount(React.createElement(NativeQuestionAnswer, {
    agentId: 'worker', request: { id: 'permission-1', questions: [{ header: 'Question 1', question: 'Choose a branch?', options: ['main', 'release'] }] },
    onAnswered: () => { answeredCallback++; }, c: colors,
  }));
  try {
    assert.equal(ui.query('Submit answer')!.props.accessibilityState.disabled, true, 'an unanswered request cannot be submitted');
    ui.press('Answer Question 1: release');
    assert.equal(ui.query('Submit answer')!.props.accessibilityState.disabled, false);
    ui.press('Submit answer');
    await settle(() => !!answered);
    assert.deepEqual(answered, { requestId: 'permission-1', response: { behavior: 'allow', updatedInput: { answers: { 'Question 1': 'release' } } } });
    await settle(() => answeredCallback === 1);
  } finally { ui.update(React.createElement('View')); stop(); }
});

for (const updateBeforeRefresh of [false, true]) {
  test(`an answer refresh without permissions preserves remaining questions (subscription update ${updateBeforeRefresh ? 'before' : 'after'} refresh)`, async () => {
    const { registerNativeQuestionPills, useTaskQuestions } = await import('../client/native-questions');
    const remaining = { ...request, id: 'permission-2', input: { questions: [{ header: 'Question 2', question: 'Choose a target?', options: [{ label: 'staging' }] }] } };
    let handlers: any, captured: any, refreshed = false, removed = 0, lists = 0;
    const labels: string[] = [];
    const agent = (pendingPermissions: unknown[]) => ({ id: 'worker', workspaceId: 'workspace', pendingPermissions });
    const publishRemaining = () => handlers.update({ type: 'agent_update', payload: { kind: 'upsert', agent: agent([remaining]) } });
    const client = { agents: {
      list: async () => {
        lists++;
        return { entries: [{ agent: agent([request, remaining]) }], pageInfo: { hasMore: false },
          subscription: { subscribe: (value: any) => { handlers = value; }, release() {} } };
      },
      ref: () => ({
        respondToPermission: async () => { if (updateBeforeRefresh) publishRemaining(); },
        refresh: async () => { refreshed = true; return { agent: { id: 'worker', workspaceId: 'workspace' } }; },
      }),
    }, addComposerPill: (pill: any) => {
      captured = pill; labels.push(pill.button.title);
      return { remove: () => removed++, update: (patch: any) => { labels.push(patch.title); } };
    } } as any;
    function Card() {
      return React.createElement('Text', null, useTaskQuestions(['worker']).flatMap(q => q.questions.map(item => item.question)).join(', '));
    }
    const card = mount(React.createElement(Card));
    const stop = registerNativeQuestionPills(client, 10);
    let ui: ReturnType<typeof mount> | undefined;
    try {
      await settle(() => !!captured && !!handlers);
      ui = mount(React.createElement(captured.button.behavior.Content, { context: 'agent', agentId: 'worker', workspaceId: 'workspace', theme: { colors: new Proxy({}, { get: () => '#000' }) }, close() {} }));
      ui.type('Answer Choose a branch?', 'main');
      const submits = ui.all('Submit answers').filter(node => !node.props.accessibilityState.disabled);
      assert.equal(submits.length, 1, 'only the answered request is ready to submit');
      submits[0].props.onPress();
      await settle(() => refreshed);
      await tick(); // Allow the refresh continuation to update shared state.
      assert.match(ui.text(), /Choose a target\?/);
      assert.match(card.text(), /Choose a target\?/);
      assert.equal(removed, 0, 'a partial refresh cannot remove the remaining question pill');
      if (!updateBeforeRefresh) publishRemaining();
      await settle(() => !ui!.text().includes('Choose a branch?'));
      assert.equal(labels.at(-1), '1 question');
      assert.match(card.text(), /Choose a target\?/);
      assert.equal(lists, 1, 'answering keeps the existing subscription instead of restarting polling');
      handlers.update({ type: 'agent_update', payload: { kind: 'upsert', agent: agent([]) } });
      await settle(() => ui!.text().includes('No open questions.'));
      assert.equal(removed, 1, 'an explicit empty set still clears the pill');
    } finally { ui?.update(React.createElement('View')); card.update(React.createElement('View')); stop(); }
  });
}

/**
 * Papercut 7cb34906 (a consumer task): three native budget questions
 * stayed pending after two `extend_budget` calls, and launches declined with
 * "retained worker still owns its turn: pending question" until the planner
 * answered them by hand. A budget extension clears the budget stop its questions
 * belong to, so it supersedes every recorded budget question for the task and
 * dismisses the ones still pending on the thread through the host.
 */
test('extend_budget dismisses Nucleus budget questions still pending on the worker thread', async () => {
  const store = new Store(':memory:');
  store.setMeta('paused', false);
  store.setMeta('hostId', 'host');
  const task = store.insert(submissionSchema.parse({
    submissionId: 'budget', title: 'Budget', repoPath: '/repo', planningCommit: 'a'.repeat(40),
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', 'a'.repeat(40));
  const queued = store.update(task.id, {
    phase: 'blocked', reason: 'Budget reached', agentId: 'worker', workspaceId: 'workspace',
    budgetSince: new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(),
  });
  // Three recorded budget questions: one from the current stop, two older ones whose
  // native prompts are still pending on the thread.
  for (const id of ['budget-1', 'budget-2', 'budget-3'])
    store.event(queued.id, 'operator_question', `${id}: kind budget; stop budget; head none; question ${digest(id)} (3 chars); options Extend the budget | Stop and keep the work`);
  const dismissed: unknown[] = [];
  const adapter = {
    pendingQuestions: async (id: string) => id === 'worker' ? [
      { requestId: 'native-1', questions: [{ header: 'Question 1', question: '[Queue decision budget-1] Budget reached. Continue?', options: ['Extend the budget'] }] },
      { requestId: 'native-2', questions: [{ header: 'Question 1', question: '[Queue decision budget-3] Budget reached. Continue?', options: ['Extend the budget'] }] },
      { requestId: 'unrelated', questions: [{ header: 'Question 1', question: 'An unrelated host question?', options: [] }] },
    ] : [],
    dismissNativeQuestion: async (...args: unknown[]) => { dismissed.push(args); },
    observe: observeIdle('workspace'),
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  try {
    await engine.performTaskControl({ taskId: queued.id, version: store.task(queued.id).version,
      action: 'extend_budget', reason: 'Continue the current approach', caller: 'operator (board)' });
    for (let i = 0; i < 20 && dismissed.length < 2; i++) await tick();
    const events = store.eventsAll(queued.id);
    for (const id of ['budget-1', 'budget-2', 'budget-3']) {
      assert.ok(events.some(event => event.kind === 'operator_question_superseded' && event.detail.startsWith(`${id}:`)), `${id}: superseded by the extension`);
      assert.ok(events.some(event => event.kind === 'native_question_dismiss_intent' && event.detail.startsWith(`${id}:`)), `${id}: dismissal recorded`);
    }
    assert.deepEqual(dismissed, [['worker', 'workspace', 'native-1'], ['worker', 'workspace', 'native-2']],
      'every pending Nucleus budget question is dismissed through the host, and nothing else is');
    assert.equal(store.task(queued.id).resolution.stop, null);
    assert.equal(store.task(queued.id).resolution.budgetExtensions, 1);
  } finally { await engine.stop(); store.close(); }
});
