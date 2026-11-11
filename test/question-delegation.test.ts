import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPERATOR_ONLY_QUESTION_KINDS, isDelegableQuestionKind } from '../core/questions/operator-question';
import { binaryApprovalChoice, delegatedAuthorityNote, delegatedDecisionText, parseDelegatedAnswer, DELEGATED_ANSWER_TIMEOUT_MS } from '../core/questions/question-delegation';
import { taskControlInputSchema, type Profile, type Task } from '../shared/contracts';
import { PaseoAdapter } from '../service/paseo-composition';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { delegateApprovedChoice, nativeDelegationPrompt, parseNativeDelegatedReply, taskContextLines } from '../core/questions/question-delegation';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';
import { HostRegistry, identitySourceHostEvidence, resolveOriginHost } from '../core/host/host-registry';

test('native question on one host reaches its planner on another and waits while either is offline', async () => {
  const store = new Store(':memory:');
  store.setMeta('paused', false);
  const initial = store.insert(submissionSchema.parse({ submissionId: 'cross-host', title: 'Cross host', repoPath: '/fixture',
    planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'planner' }), 'worker-host', 'handoff', 'a'.repeat(40), { originHostId: 'planner-host' });
  store.update(initial.id, { phase: 'working', agentId: 'worker', workspaceId: 'workspace' });
  store.upsertProject({ key: 'fixture', name: 'Fixture', repositories: [{ origin: null, path: '/fixture' }] });
  store.setProjectPlanner({ key: 'fixture', agentId: 'planner', setBy: 'operator' });
  const request = { requestId: 'same-request', questions: [{ header: 'Route', question: 'Which route?', options: ['Focused'] }] };
  const calls: string[] = [];
  let plannerOnline = false, workerOnline = true, identifiedHost: string | undefined = 'planner-host', engine!: Engine;
  const worker = {
    pendingQuestions: async (id: string) => { calls.push(`pending:${id}`); return [request]; },
    answerNativeQuestion: async (id: string, workspace: string, requestId: string, answers: Record<string, string>) => {
      calls.push(`answer:${id}:${workspace}:${requestId}:${answers.Route}`);
    },
  } as unknown as Adapter;
  const planner = {
    originAgent: async (id: string) => ({ id, workspaceId: 'planner-ws', title: 'Planner', archived: false }),
    askPlanner: async (id: string, input: { messageId: string; sourceAgentId?: string }) => {
      calls.push(`planner:${id}:${input.sourceAgentId ?? 'none'}`);
      const reply = { questionId: input.messageId, answer: 'Focused', reason: 'Within scope' };
      identifiedHost = undefined;
      await assert.rejects(engine.resolution.answerDelegatedQuestionFromHost(reply, id), /unavailable or ambiguous/);
      identifiedHost = 'worker-host';
      await assert.rejects(engine.resolution.answerDelegatedQuestionFromHost(reply, id), /not proven/);
      identifiedHost = 'planner-host';
      await engine.resolution.answerDelegatedQuestionFromHost(reply, id);
      workerOnline = false;
      return null;
    },
  } as unknown as Adapter;
  engine = new Engine(store, worker, 0);
  engine.resolveHostAdapter = id => id === 'worker-host' ? worker : id === 'planner-host' ? planner : undefined;
  engine.hostAvailable = id => id === 'worker-host' ? workerOnline : id === 'planner-host' && plannerOnline;
  engine.identifyOriginHost = async id => id === 'planner' ? identifiedHost : undefined;
  try {
    await engine.resolution.delegateNativeQuestions();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.some(call => call.startsWith('planner:')), false);
    assert.equal(calls.some(call => call.startsWith('answer:')), false);
    plannerOnline = true;
    await engine.resolution.delegateNativeQuestions();
    for (let i = 0; i < 100 && engine.resolution.responsibleQuestions.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(calls.includes('planner:planner:none'));
    assert.equal(calls.some(call => call.startsWith('answer:')), false);
    assert.equal(store.eventsAll(initial.id).some(event => event.kind === 'native_question_response_intent'), false);
    workerOnline = true;
    await engine.resolution.delegateNativeQuestions();
    for (let i = 0; i < 100 && !calls.some(call => call.startsWith('answer:')); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(calls.includes('planner:planner:none'));
    assert.equal(calls.filter(call => call.startsWith('planner:')).length, 1);
    assert.ok(calls.includes('answer:worker:workspace:same-request:Focused'));
    workerOnline = false;
    const before = calls.length;
    await engine.resolution.delegateNativeQuestions();
    assert.equal(calls.length, before);
  } finally { await engine.stop(); store.close(); }
});

test('a legacy delegated answer needs a uniquely proven host', async () => {
  const store = new Store(':memory:');
  const task = store.insert(submissionSchema.parse({ submissionId: 'legacy-answer', title: 'Legacy', repoPath: '/fixture',
    planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'planner' }), 'host-a', 'handoff', 'a'.repeat(40));
  const engine = new Engine(store, {} as Adapter, 0);
  engine.identifyOriginHost = async () => 'host-a'; engine.hostAvailable = () => true;
  const input = { questionId: 'legacy-window', answer: 'Continue', reason: 'Within scope' };
  try {
    engine.resolution.openDelegatedQuestion(task, input.questionId, 'planner', 'Question: Continue?', 10_000, 'planner');
    store.setMeta('hostRegistry', [{ id: 'host-a' }, { id: 'host-b' }]);
    await assert.rejects(engine.resolution.answerDelegatedQuestionFromHost(input, 'planner'), /not proven/);
    assert.equal(store.eventsAll('delegation:legacy-window').some(event => event.kind === 'delegated_answer'), false);
    store.setMeta('hostRegistry', [{ id: 'host-a' }]);
    const receipt = await engine.resolution.answerDelegatedQuestionFromHost(input, 'planner');
    assert.equal(receipt.answer, 'Continue');
    assert.equal(store.eventsAll('delegation:legacy-window').filter(event => event.kind === 'delegated_delivery').length, 1);
    engine.resolution.openDelegatedQuestion(task, 'race-window', 'planner', 'Question: Continue?', 10_000, 'planner');
    engine.identifyOriginHost = async () => {
      const prior = store.eventsAll('delegation:race-window').findLast(event => event.kind === 'delegated_delivery')!;
      store.event('delegation:race-window', 'delegated_delivery', JSON.stringify({ ...JSON.parse(prior.detail), hostId: 'host-b' }));
      return 'host-a';
    };
    await assert.rejects(engine.resolution.answerDelegatedQuestionFromHost({ ...input, questionId: 'race-window' }, 'planner'), /changed during host verification/);
    assert.equal(store.eventsAll('delegation:race-window').some(event => event.kind === 'delegated_answer'), false);
  } finally { await engine.stop(); store.close(); }
});

test('a delegated answer arriving during a roll window waits for the plugin bridge', async () => {
  const store = new Store(':memory:');
  const task = store.insert(submissionSchema.parse({ submissionId: 'roll-answer', title: 'Roll', repoPath: '/fixture',
    planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'planner' }), 'host-a', 'handoff', 'a'.repeat(40));
  const engine = new Engine(store, {} as Adapter, 0);
  let bridgeReady = false, waitedMs = 0;
  engine.identifyOriginHost = async () => 'host-a';
  engine.hostAvailable = () => bridgeReady;
  // The runtime's own roll hook, shape-matched: bounded, and answered by the
  // bridge reconnecting mid-wait, exactly as a replacement's bootstrap does.
  engine.resolution.hostBridgeWaitMs = 5_000;
  engine.resolution.awaitHostBridge = async waitMs => {
    const start = Date.now();
    const deadline = start + waitMs;
    while (!bridgeReady) {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    waitedMs = Date.now() - start;
    return true;
  };
  const input = { questionId: 'roll-window', answer: 'Continue', reason: 'Within scope' };
  try {
    engine.resolution.openDelegatedQuestion(task, input.questionId, 'planner', 'Question: Continue?', 10_000, 'planner', 'host-a');
    store.setMeta('hostRegistry', [{ id: 'host-a' }]);
    const pending = engine.resolution.answerDelegatedQuestionFromHost(input, 'planner');
    setTimeout(() => { bridgeReady = true; }, 80);
    const receipt = await pending;
    assert.equal(receipt.answer, 'Continue', 'the answer landed once the bridge answered again');
    assert.ok(waitedMs >= 60, `the answer waited for the bridge (${waitedMs} ms)`);

    // A bridge still unavailable after the bound refuses, bounded — never a hang.
    engine.resolution.openDelegatedQuestion(task, 'down-window', 'planner', 'Question: Continue?', 10_000, 'planner', 'host-a');
    bridgeReady = false;
    engine.resolution.hostBridgeWaitMs = 120;
    const started = Date.now();
    await assert.rejects(
      engine.resolution.answerDelegatedQuestionFromHost({ ...input, questionId: 'down-window' }, 'planner'),
      /unavailable or ambiguous/,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100 && elapsed < 4_000, `the refusal stayed bounded (${elapsed} ms)`);
    assert.equal(store.eventsAll('delegation:down-window').some(event => event.kind === 'delegated_answer'), false);
  } finally { await engine.stop(); store.close(); }
});

test('a new decider records its task host before its command answer', async () => {
  const store = new Store(':memory:');
  const task = store.insert(submissionSchema.parse({ submissionId: 'decider-host', title: 'Decider', repoPath: '/fixture',
    planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host-a', 'handoff', 'a'.repeat(40));
  const selected: Profile = { id: 'decider', name: 'Decider', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
  let engine!: Engine;
  const adapter = { runDecider: async () => ({ agentId: 'decider', text: null }), askPlanner: async (id: string, input: { messageId: string }) => {
    await engine.resolution.answerDelegatedQuestionFromHost({ questionId: input.messageId, answer: 'Continue', reason: 'Within scope' }, id);
    return null;
  } } as unknown as Adapter;
  engine = new Engine(store, adapter, 0);
  engine.identifyOriginHost = async () => 'host-a'; engine.hostAvailable = () => true;
  try {
    const result = await engine.resolution.deciderBound(task, { prompt: 'Question: Continue?', profile: selected, signal: new AbortController().signal, timeoutMs: 1000, decisionId: 'decision' });
    assert.match(result.text!, /Answer: Continue/);
    const delivery = store.eventsAll('delegation:ns-decider-decision').find(event => event.kind === 'delegated_delivery')!;
    assert.equal(JSON.parse(delivery.detail).hostId, 'host-a');
  } finally { await engine.stop(); store.close(); }
});

test('native delegates answer or explicitly leave operator decisions pending', () => {
  const prompt = nativeDelegationPrompt('planner', { question: 'Who reviews?', choices: [], context: ['Brief: review'] });
  assert.match(prompt, /Question for the project planner: Who reviews\?/);
  assert.match(prompt, /decision: "operator" with a one-line reason/);
  assert.match(prompt, /Task context:\n {2}Brief: review/, 'bug 25: delegates read the task context');
  assert.doesNotMatch(prompt, /approve by default|Ask:|Reply with/);
  assert.deepEqual(parseNativeDelegatedReply('Answer: The retained reviewer\nReason: Independent review.'), { kind: 'answer', answer: 'The retained reviewer', reason: 'Independent review.' });
  assert.deepEqual(parseNativeDelegatedReply('Answer: Keep the API private\nReason: The ruling changed it.\nOvertakes: decision-17, decision-22, decision-17'), {
    kind: 'answer', answer: 'Keep the API private', reason: 'The ruling changed it.', overtakes: ['decision-17', 'decision-22'],
  });
  assert.deepEqual(parseNativeDelegatedReply('Answer: publish\nDecision: operator\nReason: Release decision'), { kind: 'operator', reason: 'Release decision' });
  assert.doesNotMatch(nativeDelegationPrompt('decider', { question: 'Who reviews?', choices: [], context: [] }), /Overtakes:/, 'only planner rulings may cite overtaken decisions');
  assert.equal(parseNativeDelegatedReply('Answer: yes'), null);
});

test('native permission is read and answered on its own agent with header-keyed answers', async () => {
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/worker-report.mjs');
  const requests = [{ id: 'request', kind: 'question', input: { questions: [{ header: 'Question 1', question: 'Which route?', options: [{ label: 'Focused' }] }] } }];
  const delivered: unknown[] = [];
  const agent = { refresh: async () => true, workspaceId: 'review-workspace', archivedAt: null, pendingPermissions: requests,
    respondToPermission: async (input: unknown) => { delivered.push(input); } };
  Object.assign(adapter, { api: { agents: { ref: () => agent } } });
  assert.deepEqual(await adapter.pendingQuestions('reviewer'), [{ requestId: 'request', questions: [{ header: 'Question 1', question: 'Which route?', options: ['Focused'] }] }]);
  await adapter.answerNativeQuestion('reviewer', 'review-workspace', 'request', { 'Question 1': 'Focused' });
  assert.deepEqual(delivered, [{ requestId: 'request', response: { behavior: 'allow', updatedInput: { answers: { 'Question 1': 'Focused' } } } }]);
  await assert.rejects(adapter.answerNativeQuestion('reviewer', 'wrong-workspace', 'request', {}), /identity changed/);
});

/**
 * Spec 058 (task 540): the pure parts of delegated answers. The lifecycle suite covers the
 * planner, decider, budget and operator-only paths end to end.
 */

const choices = ['Merge now without these proofs (run them after merge)', 'Return the task to the worker', 'Leave held for the planner'];

test('only scope and release are operator-only; every other kind is delegable', () => {
  assert.deepEqual([...OPERATOR_ONLY_QUESTION_KINDS].sort(), ['release', 'scope']);
  for (const kind of ['proof_acceptance', 'budget', 'review'] as const) assert.equal(isDelegableQuestionKind(kind), true, kind);
  for (const kind of ['scope', 'release'] as const) assert.equal(isDelegableQuestionKind(kind), false, kind);
});

test('binary approvals default to approve except for operator-gated actions and product changes', () => {
  assert.equal(binaryApprovalChoice('Spend past twice the budget?', ['Approve', 'Hold']), 'Approve');
  assert.equal(binaryApprovalChoice('Should Queue run this outward action?', ['Approve', 'Hold']), null);
  assert.equal(binaryApprovalChoice('Should I send this?', ['Approve', 'Hold'], 'This emails the customer.'), null);
  assert.equal(binaryApprovalChoice('Should I proceed?', ['Approve', 'Hold'], 'This would change product scope.'), null);
  assert.equal(binaryApprovalChoice('Should we release this version?', ['Approve release', 'Hold release']), null);
  assert.equal(binaryApprovalChoice('Should we change what the task delivers?', ['Approve', 'Hold']), null);
  assert.equal(binaryApprovalChoice('Can I use a frontier profile?', ['Approve', 'Hold']), null);
  assert.equal(binaryApprovalChoice('Can I use an above-ceiling profile?', ['Approve', 'Hold']), null);
  assert.equal(binaryApprovalChoice('Should I proceed?', ['Approve', 'Hold'], 'This would add a new product feature.'), null);
  assert.equal(binaryApprovalChoice('Which approach should we use?', ['Approve', 'Hold', 'Ask later']), null);
});

test('a delegated answer is read from the last Choice and Reason lines, and the choice must be offered', () => {
  const reply = 'Thinking aloud.\nChoice: Leave held for the planner\nReason: The proofs need the planner.\n';
  assert.deepEqual(parseDelegatedAnswer(reply, choices), { choice: 'Leave held for the planner', reason: 'The proofs need the planner.' });
  // The last pair wins, so a revised answer in the same reply is the one read.
  assert.equal(parseDelegatedAnswer(`Choice: Return the task to the worker\nReason: first\nChoice: Leave held for the planner\nReason: second`, choices)?.choice, 'Leave held for the planner');
  // A paraphrase is no answer: the choice must equal one offered choice exactly.
  assert.equal(parseDelegatedAnswer('Choice: Leave it for later\nReason: unsure', choices), null);
  assert.equal(parseDelegatedAnswer('Choice: Return the task to the worker', choices), null, 'a reason is required');
  assert.equal(parseDelegatedAnswer('Choice: Return the task to the worker\nReason:   ', choices), null, 'an empty reason is no reason');
  assert.equal(parseDelegatedAnswer(null, choices), null);
  assert.deepEqual(parseDelegatedAnswer('Choice: Leave held for the planner\nReason: Settled by the ruling.\nOvertakes: decision-17, decision-22, decision-17', choices),
    { choice: 'Leave held for the planner', reason: 'Settled by the ruling.', overtakes: ['decision-17', 'decision-22'] });
});

test('a reason is one bounded line', () => {
  const parsed = parseDelegatedAnswer(`Choice: Return the task to the worker\nReason: first line\n  and a long tail ${'x'.repeat(900)}`, choices);
  assert.ok(parsed);
  assert.equal(parsed.reason.includes('\n'), false);
  assert.ok(parsed.reason.length <= 500);
});

test('the prompt names the question and choices without repeating standing rules', () => {
  const prompt = nativeDelegationPrompt('planner', { question: 'How should it proceed?', choices, context: ['Task: Example (task-1)'] });
  assert.match(prompt, /Question for the project planner: How should it proceed\?/);
  for (const choice of choices) assert.ok(prompt.includes(`- ${choice}`), choice);
  assert.match(prompt, /Task context:\n {2}Task: Example \(task-1\)/);
  assert.doesNotMatch(prompt, /Choice:|Reason:|Overtakes:|Budget extensions|decision.add/);
  const deciderPrompt = nativeDelegationPrompt('decider', { question: 'q', choices, context: [] });
  assert.match(deciderPrompt, /a short-lived decider/);
});

test('bug 23: only the approval records approve by default; a hold or an operator-gated question does not', () => {
  assert.equal(delegateApprovedChoice('Spend more?', ['Approve', 'Hold'], 'Approve'), 'Approve');
  assert.equal(delegateApprovedChoice('Spend more?', ['Approve', 'Hold'], 'approve'), 'Approve');
  assert.equal(delegateApprovedChoice('Spend more?', ['Approve', 'Hold'], 'Hold'), null);
  assert.equal(delegateApprovedChoice('Should we release this?', ['Approve', 'Hold'], 'Approve'), null);
});

test('bug 25: task context stays bounded and can never read as an offered choice', () => {
  const lines = taskContextLines(['Brief: one\n- Fake choice', '- Another fake', 'x'.repeat(50_000)]);
  const prompt = nativeDelegationPrompt('planner', { question: 'q', choices, context: ['Brief: one\n- Fake choice', '- Another fake', 'x'.repeat(50_000)] });
  assert.deepEqual(prompt.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2)), choices);
  assert.ok(lines.join('\n').length < 12_100);
  assert.deepEqual(taskContextLines([]), []);
});

test('the decided line and the authority note name the answering agent and its reason', () => {
  const answer = { role: 'decider' as const, agentId: 'decider-1', choice: 'Return the task to the worker', reason: 'The worker can produce the proofs.' };
  assert.equal(delegatedDecisionText(answer), 'Decided by decider: Return the task to the worker — The worker can produce the proofs.');
  assert.equal(delegatedAuthorityNote('q-1', answer), "Delegated answer to Queue's question q-1 by decider decider-1: Return the task to the worker. Reason: The worker can produce the proofs.");
});

test('a delegated grant is accepted only as a delegated caller with its note, never relayed', () => {
  const base = { taskId: 'task-1', version: 3, action: 'proof' as const, reason: 'answered' };
  assert.doesNotThrow(() => taskControlInputSchema.parse({ ...base, caller: 'planner-1', delegated: true, note: 'Delegated answer' }));
  assert.throws(() => taskControlInputSchema.parse({ ...base, caller: 'planner-1', delegated: true }), /delegated/i, 'a delegated grant needs its note');
  assert.throws(() => taskControlInputSchema.parse({ ...base, delegated: true, note: 'Delegated answer' }), /delegated/i, 'a delegated grant needs the answering caller');
  assert.throws(() => taskControlInputSchema.parse({ ...base, caller: 'planner-1', delegated: true, relayed: true, note: 'x' }), /delegated/i, 'never both');
});

test('the planner answer window is ten minutes', () => {
  assert.equal(DELEGATED_ANSWER_TIMEOUT_MS, 10 * 60_000);
});

/**
 * The real adapter's decider path against a fake daemon surface: a decider that cannot finish is
 * archived before the failure is rethrown, so it never lingers as an unarchived agent.
 */
function deciderAdapter(waitForFinish: () => Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-decider-adapter-'));
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', join(dir, 'callback.sock'), join(dir, 'worker-report.mjs'));
  const archived: string[] = [];
  const created: string[] = [];
  const agent = (id: string) => ({
    refresh: async () => true, archivedAt: null, current: () => ({ id }),
    archive: async () => { archived.push(id); return { archivedAt: '2026-11-01T00:00:00.000Z' }; },
    waitForFinish,
  });
  Object.assign(adapter, { api: {
    workspaces: { ref: () => ({ agents: { create: async (input: { prompt?: string }) => { assert.equal(input.prompt, undefined, 'register command authority before sending'); created.push('decider-9'); return { id: 'decider-9' }; } } }) },
    agents: { ref: (id: string) => agent(id) },
  } });
  const profile = { id: 'coordinator', name: 'coordinator', provider: 'fixture', model: 'coordinator', modeId: undefined, thinkingOptionId: '', featureValues: undefined, available: true, problem: '', notes: '', supportedThinking: [] } as unknown as Profile;
  return { adapter, archived, created, profile, dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a decider returns its identity without waiting for or reading chat output', async () => {
  const fake = deciderAdapter(async () => { throw Error('chat must not be read'); });
  try {
    const task = { id: 'task-1', title: 'Example', workspaceId: 'workspace-1' } as unknown as Task;
    const decided = await fake.adapter.runDecider!(task, { profile: fake.profile, signal: new AbortController().signal, timeoutMs: 1000, decisionId: 'q-2' });
    assert.deepEqual(decided, { agentId: 'decider-9', text: null });
    assert.deepEqual(fake.archived, [], 'resolution owns the command window and archival');
  } finally { fake.close(); }
});

function plannerAdapter() {
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/worker-report.mjs');
  const messages: Array<{ text: string; options: unknown }> = [];
  const agent = {
    status: 'running', activeTurn: { turnId: 'conversation' } as { turnId: string } | null,
    pendingPermissions: [] as unknown[], archivedAt: null,
    refresh: async () => true,
    run: async (text: string, options: unknown) => { messages.push({ text, options }); return { status: 'idle', lastMessage: 'Answer: yes\nReason: chat output' }; },
    send: async (text: string, options: unknown) => { messages.push({ text, options }); },
  };
  Object.assign(adapter, { api: { agents: { ref: () => agent } }, provenanceClient: { sendRequest: async ({ message }: any) => { await agent.send(message.text, { messageId: message.messageId, sourceAgentId: message.sourceAgentId }); return { accepted: true }; } } });
  return { adapter, agent, messages };
}

test('a busy planner receives nothing until idle and no chat output is an answer', async () => {
  const f = plannerAdapter();
  const pending = f.adapter.askPlanner('planner', { prompt: 'question', messageId: 'question-1', timeoutMs: 1000, signal: new AbortController().signal });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(f.messages, [], 'an active conversation must never be steered');
  f.agent.status = 'idle'; f.agent.activeTurn = null;
  assert.equal(await pending, null, 'only the command can answer');
  assert.deepEqual(f.messages, [{ text: 'question', options: { messageId: 'question-1', sourceAgentId: 'nucleus' } }]);
});

test('a planner busy for the whole window receives nothing', async () => {
  const f = plannerAdapter();
  assert.equal(await f.adapter.askPlanner('planner', { prompt: 'question', messageId: 'question-2', timeoutMs: 25, signal: new AbortController().signal }), null);
  assert.deepEqual(f.messages, []);
});

test('an idle planner chat reply resolves nothing', async () => {
  const f = plannerAdapter(); f.agent.status = 'idle'; f.agent.activeTurn = null;
  assert.equal(await f.adapter.askPlanner('planner', { prompt: 'question', messageId: 'question-3', timeoutMs: 1000, signal: new AbortController().signal }), null);
  assert.equal(f.messages.length, 1);
});

test('notices wait for idle and carry the same system label', async () => {
  const f = plannerAdapter();
  const pending = f.adapter.notify('planner', 'notice-1', 'notice');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(f.messages, []);
  f.agent.status = 'idle'; f.agent.activeTurn = null;
  await pending;
  assert.deepEqual(f.messages, [{ text: 'notice', options: { messageId: 'notice-1', sourceAgentId: 'nucleus' } }]);
});

test('reviewer asks obey idle delivery and ignore chat output too', async () => {
  const f = plannerAdapter(); f.agent.status = 'idle'; f.agent.activeTurn = null;
  assert.equal(await f.adapter.askReviewer('reviewer', { prompt: 'consult', messageId: 'consult-1', timeoutMs: 1000, signal: new AbortController().signal }), null);
  assert.equal(f.messages.length, 1);
});


test('simultaneous messages serialize idle proof and send, and queued expiry never sends later', async () => {
  const f = plannerAdapter(); f.agent.status = 'idle'; f.agent.activeTurn = null;
  let releaseFirst!: () => void;
  const firstDelivery = new Promise<void>(resolve => { releaseFirst = resolve; });
  f.agent.send = async (text: string, options: unknown) => {
    f.messages.push({ text, options });
    if (f.messages.length === 1) await firstDelivery;
    f.agent.status = 'running'; f.agent.activeTurn = { turnId: 'delivery' };
  };
  const input = (messageId: string, timeoutMs = 1000) => ({ messageId, prompt: messageId, timeoutMs, signal: new AbortController().signal });
  const first = f.adapter.askPlanner('planner', input('first'));
  const second = f.adapter.askPlanner('planner', input('second'));
  const expired = f.adapter.askPlanner('planner', input('expired', 25));
  await expired;
  try { assert.equal(f.messages.length, 1, 'two sends must not race against the same idle snapshot'); }
  finally { releaseFirst(); }
  await first;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.messages.length, 1, 'the second send waits for the first conversation to finish');
  f.agent.status = 'idle'; f.agent.activeTurn = null;
  await second;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(f.messages.map(message => (message.options as { messageId: string }).messageId), ['first', 'second']);
});


for (const stop of ['timeout', 'abort'] as const) {
  test(`a hung idle refresh is bounded by ${stop} and releases the recipient queue without a late send`, { timeout: 1000 }, async () => {
    const f = plannerAdapter(); f.agent.status = 'idle'; f.agent.activeTurn = null;
    let finishRefresh!: (value: boolean) => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>(resolve => { refreshStarted = resolve; });
    const hungRefresh = new Promise<boolean>(resolve => { finishRefresh = resolve; });
    let refreshes = 0;
    f.agent.refresh = async () => {
      if (++refreshes === 1) { refreshStarted(); return hungRefresh; }
      return true;
    };
    const controller = new AbortController();
    const first = f.adapter.askPlanner('planner', { prompt: 'first', messageId: 'first', timeoutMs: stop === 'timeout' ? 25 : 500, signal: controller.signal });
    await started;
    const second = f.adapter.askPlanner('planner', { prompt: 'second', messageId: 'second', timeoutMs: 500, signal: new AbortController().signal });
    if (stop === 'abort') controller.abort();
    assert.equal(await first, null, 'a host read sends nothing');
    assert.equal(await second, null, 'the later question gets a fresh idle proof');
    finishRefresh(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(f.messages.map(message => (message.options as { messageId: string }).messageId), ['second']);
  });

  test(`a hung send returns unknown on ${stop} while fencing subsequent sends until the host settles`, { timeout: 1000 }, async () => {
    const f = plannerAdapter(); f.agent.status = 'idle'; f.agent.activeTurn = null;
    let finishSend!: () => void;
    let sendStarted!: () => void;
    const started = new Promise<void>(resolve => { sendStarted = resolve; });
    const hungSend = new Promise<void>(resolve => { finishSend = resolve; });
    f.agent.send = async (text: string, options: unknown) => {
      f.messages.push({ text, options });
      if (f.messages.length === 1) { sendStarted(); await hungSend; }
    };
    const controller = new AbortController();
    const first = f.adapter.askPlanner('planner', { prompt: 'first', messageId: 'first', timeoutMs: stop === 'timeout' ? 25 : 500, signal: controller.signal });
    const unknown = assert.rejects(first, /delivery outcome unknown.*never resend/);
    await started;
    const second = f.adapter.askPlanner('planner', { prompt: 'expired', messageId: 'expired', timeoutMs: 50, signal: new AbortController().signal });
    if (stop === 'abort') controller.abort();
    await unknown;
    assert.equal(await second, null, 'queued callers remain bounded even behind a hung send');
    assert.equal(f.messages.length, 1, 'an unresolved host send fences all later sends');
    finishSend();
    await f.adapter.askPlanner('planner', { prompt: 'third', messageId: 'third', timeoutMs: 500, signal: new AbortController().signal });
    assert.deepEqual(f.messages.map(message => (message.options as { messageId: string }).messageId), ['first', 'third']);
  });
}

test('pending permission at the final read prevents delivery', async () => {
  const f = plannerAdapter(); f.agent.status = 'idle'; f.agent.activeTurn = null;
  let reads = 0;
  f.agent.refresh = async () => { if (++reads === 2) f.agent.pendingPermissions = [{}]; return true; };
  await f.adapter.askPlanner('planner', { prompt: 'question', messageId: 'p', sourceAgentId: 'worker', timeoutMs: 30, signal: new AbortController().signal });
  assert.deepEqual(f.messages, []);
  assert.equal(f.agent.pendingPermissions.length, 1);
});

test('source is forwarded and a rejected source falls back only after explicit refusal', async () => {
  const f = plannerAdapter(); f.agent.status = 'idle'; f.agent.activeTurn = null;
  const calls: any[] = [];
  Object.assign(f.adapter, { provenanceClient: { sendRequest: async ({ message }: any) => { calls.push(message); return { accepted: false }; } }, client: { sendAgentMessage: async (...args: any[]) => { calls.push(args); } } });
  await f.adapter.askPlanner('planner', { prompt: 'question', messageId: 'stable', sourceAgentId: 'reviewer', timeoutMs: 1000, signal: new AbortController().signal });
  assert.equal(calls[0].sourceAgentId, 'reviewer');
  assert.equal(calls[0].messageId, 'stable');
  assert.deepEqual(calls[1], ['planner', 'question', { messageId: 'stable' }]);
});

test('unknown source delivery is never retried as a plain send', async () => {
  const f = plannerAdapter(); f.agent.status = 'idle'; f.agent.activeTurn = null;
  let fallback = false;
  Object.assign(f.adapter, { provenanceClient: { sendRequest: async () => { throw Error('connection lost'); } }, client: { sendAgentMessage: async () => { fallback = true; } } });
  await assert.rejects(f.adapter.askPlanner('planner', { prompt: 'q', messageId: 'id', timeoutMs: 1000, signal: new AbortController().signal }), /connection lost/);
  assert.equal(fallback, false);
});


test('delegate receipt surfaces share last-field parsing while keeping their allowed shapes', () => {
  const text = 'Choice: Hold\nAnswer: first\nReason: first\nChoice: Continue\nAnswer: second\nReason: final\nOvertakes: one, two, one';
  assert.deepEqual(parseDelegatedAnswer(text, ['Hold', 'Continue']), { choice: 'Continue', reason: 'final', overtakes: ['one', 'two'] });
  assert.deepEqual(parseNativeDelegatedReply(text), { kind: 'answer', answer: 'second', reason: 'final', overtakes: ['one', 'two'] });
  assert.equal(parseDelegatedAnswer('Answer: Continue\nReason: final', ['Continue']), null);
  assert.equal(parseNativeDelegatedReply('Choice: Continue\nReason: final'), null);
  assert.equal(parseNativeDelegatedReply(`Answer: Continue\nReason: ${'a'.repeat(700)}`)?.reason.length, 500);
});

test('a delegated answer resolves through the origin lookup, and an offline host does not block a caller-named host', async () => {
  const store = new Store(':memory:');
  const task = store.insert(submissionSchema.parse({ submissionId: 'offline-host-answer', title: 'Offline host', repoPath: '/fixture',
    planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'planner' }), 'paseo:alpha', 'handoff', 'a'.repeat(40));
  const engine = new Engine(store, {} as Adapter, 0);
  // The live Paseo host answers with positive knowledge of the planner; the
  // registered T3 host is offline and never asked. The whole resolution runs
  // through the real resolver, so the offline host's effect on it is the real one.
  let known: ReadonlyArray<{ id: string; endpoint: string }> = [];
  const registry = new HostRegistry<{ knows: boolean }>({ read: () => known, write: value => { known = value; }, transaction: fn => fn() });
  known = [{ id: 'paseo:alpha', endpoint: 'paseo-endpoint' }, { id: 't3code:nightly', endpoint: 't3-endpoint' }];
  registry.connect('paseo:alpha', 'paseo-endpoint', { knows: true });
  const t3 = registry.connect('t3code:nightly', 't3-endpoint', { knows: false });
  registry.disconnect('t3code:nightly', t3);
  engine.identifyOriginHost = (id, identitySource) => resolveOriginHost(registry, id,
    async (host, agent) => host.knows && agent === 'planner' ? 'mine' : 'not-mine',
    // The runtime's own rule: a source is evidence only for the thread it names.
    identitySourceHostEvidence(id, identitySource, registry.known().map(entry => entry.id)));
  engine.hostAvailable = () => true;
  const input = { questionId: 'offline-window', answer: 'Continue', reason: 'Within scope' };
  try {
    engine.resolution.openDelegatedQuestion(task, input.questionId, 'planner', 'Question: Continue?', 10_000, 'planner', 'paseo:alpha');
    await assert.rejects(engine.resolution.answerDelegatedQuestionFromHost(input, 'planner'), /unavailable or ambiguous/);
    assert.equal(store.eventsAll('delegation:offline-window').some(event => event.kind === 'delegated_answer'), false);
    // The answering thread's own identity source names its host, so the offline
    // host that has no part in this answer cannot block it.
    const receipt = await engine.resolution.answerDelegatedQuestionFromHost(input, 'planner',
      { agent: 'planner', hostId: 'paseo:alpha' });
    assert.equal(receipt.answer, 'Continue');
    // Evidence about a different identity decides nothing.
    engine.resolution.openDelegatedQuestion(task, 'other-window', 'planner', 'Question: Continue?', 10_000, 'planner', 'paseo:alpha');
    await assert.rejects(engine.resolution.answerDelegatedQuestionFromHost({ ...input, questionId: 'other-window' }, 'planner',
      { agent: 'someone-else', hostId: 'paseo:alpha' }), /unavailable or ambiguous/);
  } finally { await engine.stop(); store.close(); }
});
