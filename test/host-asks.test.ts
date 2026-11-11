import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaseoAdapter } from '../service/paseo-composition';
import type { Profile, Task } from '../shared/contracts';

/**
 * Witnesses for the native ask, consult and decider boundary (step 3 row 11, task 884).
 * They pin what the adapter's ask and launch methods do before and after the Paseo host
 * takes them: the idle send each ask starts synchronously through the adapter's own
 * delivery method, the refusals that arrive as rejections, and the native agent each
 * consult and decider creates under its stable identities.
 */

const task = { id: 'task-1', agentId: 'worker', workspaceId: 'workspace', title: 'Ship it' } as unknown as Task;
const profile = { id: 'profile', provider: 'codex', model: 'gpt', modeId: 'mode', thinkingOptionId: 'thinking', featureValues: { fast: true } } as unknown as Profile;
const ask = (messageId: string) => ({ prompt: 'question', messageId, timeoutMs: 1000, signal: new AbortController().signal });

function adapterWithApi(create: (args: unknown) => Promise<{ id: string }> = async () => ({ id: 'new-agent' })) {
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/worker-report.mjs');
  const created: unknown[] = [];
  const refs: string[] = [];
  Object.assign(adapter, { api: { workspaces: { ref: (id: string) => {
    refs.push(id);
    return { agents: { create: async (args: unknown) => { created.push(args); return create(args); } } };
  } } } });
  return { adapter, created, refs };
}

test('asks start their idle send through the adapter synchronously and return no answer, even when the send is refused', async () => {
  const { adapter } = adapterWithApi();
  const sends: Array<{ recipient: string; messageId: string; prompt: string }> = [];
  Object.assign(adapter, { sendWhenIdle: async (recipient: string, input: { messageId: string; prompt: string }) => {
    sends.push({ recipient, messageId: input.messageId, prompt: input.prompt });
    return false;
  } });
  const planner = adapter.askPlanner!('planner', ask('ask-1'));
  assert.equal(sends.length, 1, 'the idle send is called before askPlanner returns');
  assert.deepEqual(sends[0], { recipient: 'planner', messageId: 'ask-1', prompt: 'question' });
  assert.equal(await planner, null);
  assert.equal(await adapter.askReviewer!('reviewer', ask('consult-1')), null);
  assert.deepEqual(sends.map(send => send.recipient), ['planner', 'reviewer']);
});

test('an ask whose idle send is unknown rejects once and is never resent by the adapter', async () => {
  const { adapter } = adapterWithApi();
  let calls = 0;
  Object.assign(adapter, { sendWhenIdle: async () => { calls++; throw Error('Nucleus message ask-2 delivery outcome unknown after timeout or abort; never resend'); } });
  await assert.rejects(adapter.askPlanner!('planner', ask('ask-2')), { message: 'Nucleus message ask-2 delivery outcome unknown after timeout or abort; never resend' });
  assert.equal(calls, 1);
});

test('a consult reviewer is created in the task workspace under its stable request and label', async () => {
  const { adapter, created, refs } = adapterWithApi();
  const consult = await adapter.createConsultReviewer!(task, { profile, id: 'consult-1' });
  assert.deepEqual(consult, { id: 'new-agent', workspaceId: 'workspace' });
  assert.deepEqual(refs, ['workspace']);
  assert.deepEqual(created, [{
    config: { provider: 'codex/gpt', modeId: 'mode', thinkingOptionId: 'thinking', featureValues: { fast: true } },
    title: 'Review: Ship it', autoArchive: false, requestId: 'ns-reviewer-consult-consult-1', labels: { 'nucleus.reviewer': 'task-1' },
  }]);
});

test('a consult or decider without a task workspace refuses as a rejection and creates nothing', async () => {
  const { adapter, created } = adapterWithApi();
  const unworkspaced = { ...task, workspaceId: null } as unknown as Task;
  const consult = adapter.createConsultReviewer!(unworkspaced, { profile, id: 'consult-2' });
  assert.ok(consult instanceof Promise);
  await assert.rejects(consult, { message: 'Task has no workspace for a reviewer' });
  const decider = adapter.runDecider!(unworkspaced, { profile, signal: new AbortController().signal, timeoutMs: 1000, decisionId: 'decision-2' });
  assert.ok(decider instanceof Promise);
  await assert.rejects(decider, { message: 'Task has no workspace for a decider' });
  assert.deepEqual(created, []);
});

test('a decider starts in the task workspace with null text, and a failed create is not retried', async () => {
  const { adapter, created } = adapterWithApi();
  const decided = await adapter.runDecider!(task, { profile, signal: new AbortController().signal, timeoutMs: 1000, decisionId: 'decision-1' });
  assert.deepEqual(decided, { agentId: 'new-agent', text: null });
  assert.deepEqual(created, [{
    config: { provider: 'codex/gpt', modeId: 'mode', thinkingOptionId: 'thinking', featureValues: { fast: true } },
    title: 'Decision: Ship it', autoArchive: false, requestId: 'ns-decider-decision-1', labels: { 'nucleus.decider': 'task-1' },
  }]);
  const failing = adapterWithApi(async () => { throw Error('daemon refused the agent'); });
  await assert.rejects(failing.adapter.runDecider!(task, { profile, signal: new AbortController().signal, timeoutMs: 1000, decisionId: 'decision-3' }), { message: 'daemon refused the agent' });
  assert.equal(failing.created.length, 1, 'a refused create is not retried');
});
