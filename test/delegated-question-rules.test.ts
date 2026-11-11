import { formatAgentId } from '../shared/agent-identity';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { digest } from '../core/store/store';
import { QUEUE_REPOSITORY_ORIGIN } from '../shared/contracts';
import { ANSWERING_WINDOW_MS, waitFor } from './support/budgets';
import { fixture } from './support/responsible-lifecycle-fixture';

/**
 * Tom's rulings of 2026-11-06 on the delegated routes: one missing-planner rule (bug 8), the
 * operator's answer always wins and a delegate's hold stands (bug 23), and every delegated
 * question carries the task context (bug 25). The nucleus_ask route is in agent-ask.test.ts.
 */
type Fixture = ReturnType<typeof fixture>;

const RETURN = 'Choice: Return to the worker with a new approach\nReason: Try another gate.';
const DECISION = { id: 'decision-1', kind: 'process' as const, question: 'May the worker continue?', options: ['Approve', 'Hold'] };

async function until(condition: () => boolean): Promise<void> {
  await waitFor(condition, ANSWERING_WINDOW_MS, 'condition');
}
/** Only these threads have gone; every other answer, including the fixture's archived state, stands. */
function threadsGone(f: Fixture, gone: string[]) {
  const read = f.adapter.originAgent!;
  Object.assign(f.adapter, { originAgent: async (id: string) => gone.includes(id) ? null : read(id) });
}
function projectPlanner(f: Fixture, agentId = 'planner-1') {
  f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
  f.store.setProjectPlanner({ key: 'app', agentId, setBy: 'operator' });
}
function queuePlanner(f: Fixture, agentId = 'queue-planner') {
  const key = `repo-${digest(QUEUE_REPOSITORY_ORIGIN).slice(0, 20)}`;
  f.store.upsertProject({ key, name: 'Queue', repositories: [{ origin: QUEUE_REPOSITORY_ORIGIN, path: join(f.dir, 'queue-repo') }] });
  f.store.setProjectPlanner({ key, agentId, setBy: 'operator' });
}
async function escalate(f: Fixture) {
  await f.reviews(1);
  await f.engine.wake();
  await f.report('blocked', { summary: 'An external environment gate failed' });
  await until(() => f.events('planner_escalation_answered').length > 0);
}
function nativeQuestion(f: Fixture, options: string[] = ['Approve', 'Hold'], stillPending: () => boolean = () => true) {
  const delivered: Array<Record<string, string>> = [];
  f.adapter.pendingQuestions = async id => id === 'worker' && stillPending()
    ? [{ requestId: 'permission-1', questions: [{ header: 'Question 1', question: 'May the worker continue?', options }] }] : [];
  f.adapter.answerNativeQuestion = async (_agent, _workspace, _request, answers) => { delivered.push(answers); };
  return delivered;
}
function delegateDecision(f: Fixture) {
  const delivered: string[] = [];
  const resolution = f.engine.resolution as unknown as { delegateDecision(taskId: string, decision: typeof DECISION, request: null, signal: AbortSignal, deliver: (task: unknown, answer: string) => Promise<void>): Promise<boolean> };
  return { delivered, run: () => f.engine.withHost(f.current().hostId, () => resolution.delegateDecision(f.current().id, DECISION, null, new AbortController().signal, async (_task, answer) => { delivered.push(answer); })) };
}

// Bug 8: one missing-planner rule.

test('bug 8: an escalation with its project planner and origin thread both gone goes straight to the decider', async () => {
  const f = fixture({ responsible: true, delegates: { planner: RETURN, decider: RETURN } });
  try {
    threadsGone(f, ['planner-1', 'origin']);
    projectPlanner(f);
    await escalate(f);
    assert.deepEqual(f.delegated.planner, [], 'nobody waits on the archived thread');
    assert.equal(f.delegated.deciders.length, 1);
    assert.equal(f.store.projectByKey('app')?.planner, null, 'the gap is visible on the project');
  } finally { await f.close(); }
});

test('bug 8: an escalation with no project planner reaches the live Nucleus planner', async () => {
  const f = fixture({ responsible: true, delegates: { planner: RETURN, decider: null } });
  try {
    // Task 1109: the task planner is asked first; with it gone the project rung is next.
    threadsGone(f, ['origin']);
    queuePlanner(f);
    await escalate(f);
    assert.deepEqual(f.delegated.planner.map(item => item.agentId), ['queue-planner']);
  } finally { await f.close(); }
});

test('bug 8: an escalation with no planner at all asks a live origin thread', async () => {
  const f = fixture({ responsible: true, delegates: { planner: RETURN, decider: null } });
  try {
    await escalate(f);
    assert.deepEqual(f.delegated.planner.map(item => item.agentId), ['origin']);
  } finally { await f.close(); }
});

test('bug 8: an archived project planner sends an escalation to the live origin thread, not to nobody', async () => {
  const f = fixture({ responsible: true, delegates: { planner: RETURN, decider: null, plannerArchived: true } });
  try {
    projectPlanner(f);
    await escalate(f);
    assert.deepEqual(f.delegated.planner.map(item => item.agentId), ['origin']);
    assert.equal(f.store.projectByKey('app')?.planner, null);
  } finally { await f.close(); }
});

test('bug 8: a native question skips an archived project planner for the Nucleus planner and notes the gap', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Answer: The focused selector\nReason: It covers the change.', decider: null, plannerArchived: true } });
  try {
    projectPlanner(f);
    queuePlanner(f);
    threadsGone(f, ['origin']);
    const delivered = nativeQuestion(f, []);
    await f.engine.resolution.delegateNativeQuestions();
    await until(() => delivered.length > 0);
    assert.deepEqual(f.delegated.planner.map(item => item.agentId), ['queue-planner']);
    assert.equal(f.store.projectByKey('app')?.planner, null);
    assert.ok(f.store.eventsAll('project:app').some(event => event.kind === 'project_planner_missing_notified'));
  } finally { await f.close(); }
});

test('bug 8: a native question with no project planner reaches the Nucleus planner, not a decider', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Answer: The focused selector\nReason: It covers the change.', decider: 'Answer: Other\nReason: Decider.' } });
  try {
    queuePlanner(f);
    threadsGone(f, ['origin']);
    const delivered = nativeQuestion(f, []);
    await f.engine.resolution.delegateNativeQuestions();
    await until(() => delivered.length > 0);
    assert.deepEqual(f.delegated.planner.map(item => item.agentId), ['queue-planner']);
    assert.equal(f.delegated.deciders.length, 0);
  } finally { await f.close(); }
});

test('bug 8: an archived Nucleus planner is nobody too, so the question goes straight to the decider', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Choice: Approve\nReason: Planner.', decider: 'Choice: Hold\nReason: Decider.', plannerArchived: true } });
  try {
    queuePlanner(f, 'planner-1');
    threadsGone(f, ['origin']);
    const decision = delegateDecision(f);
    assert.equal(await decision.run(), true);
    assert.deepEqual(f.delegated.planner, []);
    assert.deepEqual(decision.delivered, ['Hold']);
  } finally { await f.close(); }
});

// Task 1109: each task has its own planner.

const APPROVE = 'Choice: Approve\nReason: Within scope.';

test('task 1109: a question goes to the task planner first and the project planner is never asked', async () => {
  const f = fixture({ responsible: true, delegates: { planner: APPROVE, decider: RETURN } });
  try {
    projectPlanner(f);
    const decision = delegateDecision(f);
    assert.equal(await decision.run(), true);
    assert.deepEqual(f.delegated.planner.map(item => item.agentId), ['origin'], 'the submitting thread is the task planner');
    assert.deepEqual(decision.delivered, ['Approve']);
    assert.match(f.events('operator_question_delegated')[0]!.detail, /: task planner origin; asked/);
    assert.equal(f.delegated.deciders.length, 0);
  } finally { await f.close(); }
});

test('task 1109: a silent task planner falls to the project planner, then the decider', async () => {
  const f = fixture({ responsible: true, delegates: { planner: null, decider: RETURN } });
  f.engine.resolution.delegatedAnswerWaitMs = 50;
  const asked: string[] = [];
  try {
    projectPlanner(f);
    f.adapter.askPlanner = async (planner: string, input: { messageId: string }) => {
      asked.push(planner);
      if (planner === 'planner-1') f.engine.resolution.answerDelegatedQuestion({ questionId: input.messageId, choice: 'Hold', reason: 'The project holds it.' }, planner);
      return null;
    };
    const decision = delegateDecision(f);
    assert.equal(await decision.run(), true);
    assert.deepEqual(asked, ['origin', 'planner-1'], 'the task planner is asked, then the project planner');
    assert.deepEqual(decision.delivered, ['Hold']);
    assert.equal(f.delegated.deciders.length, 0);
  } finally { await f.close(); }
});

test('task 1109: an observed-gone task planner is skipped at once for the project planner', async () => {
  const f = fixture({ responsible: true, delegates: { planner: APPROVE, decider: RETURN } });
  try {
    threadsGone(f, ['origin']);
    projectPlanner(f);
    const decision = delegateDecision(f);
    assert.equal(await decision.run(), true);
    assert.deepEqual(f.delegated.planner.map(item => item.agentId), ['planner-1']);
    assert.equal(f.delegated.deciders.length, 0);
  } finally { await f.close(); }
});

test('task 1109: a task planner that is also the project planner is one rung, asked once', async () => {
  const f = fixture({ responsible: true, delegates: { planner: APPROVE, decider: RETURN } });
  try {
    projectPlanner(f, 'origin');
    const decision = delegateDecision(f);
    assert.equal(await decision.run(), true);
    assert.deepEqual(f.delegated.planner.map(item => item.agentId), ['origin']);
    assert.equal(f.delegated.deciders.length, 0);
  } finally { await f.close(); }
});

test('task 1109: reparenting changes the first rung to the new owner', async () => {
  const f = fixture({ responsible: true, delegates: { planner: APPROVE, decider: RETURN } });
  try {
    projectPlanner(f);
    await f.engine.reparent({ toAgentId: 'planner-1', taskIds: [f.current().id], caller: 'origin', reason: 'The successor promotes this task' } as never);
    assert.equal(f.current().notificationAgentId, 'planner-1');
    const decision = delegateDecision(f);
    assert.equal(await decision.run(), true);
    assert.deepEqual(f.delegated.planner.map(item => item.agentId), ['planner-1']);
  } finally { await f.close(); }
});

test('task 1109: a brief-named planner is the first rung instead of the owner', async () => {
  const f = fixture({ responsible: true, delegates: { planner: APPROVE, decider: RETURN } });
  try {
    f.store.update(f.current().id, { plannerAgentId: 'named-planner' });
    const decision = delegateDecision(f);
    assert.equal(await decision.run(), true);
    assert.deepEqual(f.delegated.planner.map(item => item.agentId), ['named-planner']);
  } finally { await f.close(); }
});

test('task 1109: operator-only kinds still go straight to the operator and ask no planner', async () => {
  const f = fixture({ responsible: true, delegates: { planner: APPROVE, decider: RETURN } });
  try {
    projectPlanner(f);
    const delegated = f.engine.resolution as unknown as {
      delegateDecision(taskId: string, decision: { id: string; kind: 'scope'; question: string; options: string[] }, request: null, signal: AbortSignal, deliver: () => Promise<void>): Promise<boolean>;
    };
    const answered = await f.engine.withHost(f.current().hostId!, () => delegated.delegateDecision(f.current().id,
      { id: 'scope-question', kind: 'scope', question: 'Should the product change?', options: ['Yes', 'No'] }, null, new AbortController().signal, async () => {}));
    assert.equal(answered, false);
    assert.deepEqual(f.delegated.planner, [], 'an operator-only kind never reaches a planner');
    assert.equal(f.delegated.deciders.length, 0);
  } finally { await f.close(); }
});

// Bug 23: the operator wins and a hold stands.

test('bug 23: a native binary question the planner forwards stays with the operator', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Decision: operator\nReason: Only Tom can say.', decider: null } });
  try {
    projectPlanner(f);
    const delivered = nativeQuestion(f);
    await f.engine.resolution.delegateNativeQuestions();
    await until(() => f.events('native_question_operator').length > 0);
    assert.deepEqual(delivered, []);
    assert.equal(f.events('native_question_answered').length, 0);
  } finally { await f.close(); }
});

test('bug 23: a delegate hold on a native binary question stands as a hold', async () => {
  for (const delegates of [{ planner: 'Answer: Hold\nReason: Wait for the gate.', decider: null }, { planner: null, decider: 'Answer: Hold\nReason: Wait for the gate.' }]) {
    const f = fixture({ responsible: true, delegates });
    try {
      if (delegates.planner) projectPlanner(f);
      const delivered = nativeQuestion(f);
      await f.engine.resolution.delegateNativeQuestions();
      await until(() => delivered.length > 0);
      assert.deepEqual(delivered, [{ 'Question 1': 'Hold' }]);
      assert.match(f.events('native_question_answered')[0]!.detail, /: Hold — Wait for the gate\./);
    } finally { await f.close(); }
  }
});

test('bug 23: a native approval still records approve by default', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Answer: Approve\nReason: Fine.', decider: null } });
  try {
    projectPlanner(f);
    const delivered = nativeQuestion(f);
    await f.engine.resolution.delegateNativeQuestions();
    await until(() => delivered.length > 0);
    assert.deepEqual(delivered, [{ 'Question 1': 'Approve' }]);
    assert.match(f.events('native_question_answered')[0]!.detail, /Approve — approve by default, Tom 2026-11-03/);
  } finally { await f.close(); }
});

test('bug 23: a permission answered on the thread during the window beats the delegate', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Answer: Approve\nReason: Fine.', decider: null } });
  try {
    projectPlanner(f);
    let reads = 0;
    const delivered = nativeQuestion(f, ['Approve', 'Hold'], () => reads++ === 0);
    await f.engine.resolution.delegateNativeQuestions();
    await until(() => f.events('native_question_stale_answered').length > 0);
    assert.deepEqual(delivered, []);
    assert.equal(f.events('native_question_response_intent').length, 0);
    assert.equal(f.events('native_question_answered').length, 0);
  } finally { await f.close(); }
});

test('bug 23: a failed read of the permission keeps the delegate answer', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Answer: Approve\nReason: Fine.', decider: null } });
  try {
    projectPlanner(f);
    const delivered = nativeQuestion(f);
    const read = f.adapter.pendingQuestions!;
    let reads = 0;
    f.adapter.pendingQuestions = async id => { if (id === 'worker' && reads++ === 1) throw Error('read failed'); return read(id); };
    await f.engine.resolution.delegateNativeQuestions();
    await until(() => delivered.length > 0);
    assert.equal(f.events('native_question_stale_answered').length, 0);
  } finally { await f.close(); }
});

test('bug 23: a delegate hold on a marked decision stands, for planner and decider', async () => {
  for (const delegates of [{ planner: 'Choice: Hold\nReason: Wait for the gate.', decider: null }, { planner: null, decider: 'Choice: Hold\nReason: Wait for the gate.' }]) {
    const f = fixture({ responsible: true, delegates });
    try {
      if (delegates.planner) projectPlanner(f);
      const decision = delegateDecision(f);
      assert.equal(await decision.run(), true);
      assert.deepEqual(decision.delivered, ['Hold']);
      const decided = f.events('operator_question_decided')[0]!.detail;
      assert.match(decided, /: Hold — Wait for the gate\./);
      assert.doesNotMatch(decided, /approve by default/);
    } finally { await f.close(); }
  }
});

// Bug 25: task context on every route.

const assertTaskContext = (prompt: string | undefined) => {
  assert.ok(prompt, 'the delegate was asked');
  assert.match(prompt!, /Task context:\n {2}Task: Responsible lifecycle/);
  assert.match(prompt!, /^ {2}Brief: \S/m);
  assert.match(prompt!, /^ {2}Latest review at /m);
};

test('bug 25: native questions carry the task context to planner and decider', async () => {
  for (const delegates of [{ planner: 'Answer: Go\nReason: Fine.', decider: null }, { planner: null, decider: 'Answer: Go\nReason: Fine.' }]) {
    const f = fixture({ responsible: true, delegates });
    try {
      if (delegates.planner) projectPlanner(f);
      const delivered = nativeQuestion(f, []);
      await f.engine.resolution.delegateNativeQuestions();
      await until(() => delivered.length > 0);
      assertTaskContext((f.delegated.planner[0] ?? f.delegated.deciders[0])?.prompt);
    } finally { await f.close(); }
  }
});

test('bug 25: marked decisions carry the task context to planner and decider', async () => {
  for (const delegates of [{ planner: 'Choice: Hold\nReason: Fine.', decider: null }, { planner: null, decider: 'Choice: Hold\nReason: Fine.' }]) {
    const f = fixture({ responsible: true, delegates });
    try {
      if (delegates.planner) projectPlanner(f);
      await delegateDecision(f).run();
      assertTaskContext((f.delegated.planner[0] ?? f.delegated.deciders[0])?.prompt);
    } finally { await f.close(); }
  }
});

test('bug 25: escalations carry the task context to planner and decider', async () => {
  for (const delegates of [{ planner: RETURN, decider: null }, { planner: null, decider: RETURN }]) {
    const f = fixture({ responsible: true, delegates });
    try {
      if (!delegates.planner) threadsGone(f, ['planner-1', 'origin']);
      projectPlanner(f);
      await escalate(f);
      assertTaskContext((f.delegated.planner[0] ?? f.delegated.deciders[0])?.prompt);
    } finally { await f.close(); }
  }
});

test('bug 25: a reviewer consult carries the task context, retained or newly created', async () => {
  for (const retained of [true, false]) {
    const f = fixture({ responsible: true });
    f.engine.resolution.delegatedAnswerWaitMs = 30_000;
    const prompts: string[] = [];
    Object.assign(f.adapter, {
      askReviewer: async (reviewer: string, input: { prompt: string; messageId: string }) => {
        prompts.push(input.prompt);
        f.engine.resolution.answerDelegatedQuestion({ questionId: input.messageId, answer: 'Try the smaller fixture.', reason: 'Isolated.' }, reviewer);
        return null;
      },
      createConsultReviewer: async () => ({ id: 'new-reviewer', workspaceId: 'workspace' }),
    });
    try {
      if (retained) { await f.reviews(1); await f.engine.wake(); await f.report('blocked', { summary: 'I cannot reconcile these approaches' }); }
      else await f.engine.resolution.responsibleBlockerLadder(f.current(), { source: 'worker', runId: null, completion: { status: 'blocked', summary: 'I cannot reconcile these approaches', head: null } as never });
      await until(() => f.events('reviewer_consult_answered').length > 0);
      assertTaskContext(prompts[0]);
    } finally { await f.close(); }
  }
});


test('qualified planners receive missing-planner, board-question and escalation notices through native host IDs', async () => {
 const f=fixture({responsible:true,delegates:{planner:null,decider:null}});
 const controller=new AbortController();
 let boardAnswer:Promise<string>|undefined;
 try {
  threadsGone(f,['planner-1','origin']);
  projectPlanner(f);
  const caller=formatAgentId('host','queue-planner');
  queuePlanner(f,caller);
  assert.equal((await f.engine.resolution.projectPlannerFor(f.current())).planner,caller);
  const missing=f.prompts.find(message=>message.messageId.startsWith('ns-project-planner-missing-'));
  assert.equal(missing?.agentId,'queue-planner');
  boardAnswer=f.engine.resolution.questions.raiseBoardDecision(f.current(),
   {id:'qualified-board-question',kind:'process',question:'Continue?',options:['Continue']},controller.signal).catch(()=> 'aborted');
  await until(()=>f.prompts.some(message=>message.messageId==='ns-queue-question-qualified-board-question'));
  assert.equal(f.prompts.find(message=>message.messageId==='ns-queue-question-qualified-board-question')?.agentId,'queue-planner');
  f.engine.resolution.attentionUnknownEscalation(f.current(),{id:'qualified-escalation',question:'Continue?'});
  await until(()=>f.prompts.some(message=>message.messageId==='ns-escalation-attention-qualified-escalation'));
  assert.equal(f.prompts.find(message=>message.messageId==='ns-escalation-attention-qualified-escalation')?.agentId,'queue-planner');
 }finally{controller.abort();await boardAnswer;await f.close();}
});
