#!/usr/bin/env node
// Synthetic Codex app-server for the private T3 proof. No model or account is used.
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  console.log('codex-cli 0.166.0');
  process.exit(0);
}
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const threads = new Map();
const pending = new Map();
let nextRequest = 10000;
const model = { id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'Synthetic proof', description: 'Local proof fixture', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Synthetic' }], inputModalities: ['text'] };
function thread(id = randomUUID(), cwd = process.cwd()) {
  const value = { id, cliVersion: '0.166.0', createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000), cwd, ephemeral: false, modelProvider: 'openai', model: model.id, preview: '', projectId: null, sessionId: id, source: 'appServer', status: { type: 'idle' }, turns: [] };
  threads.set(id, value);
  return value;
}
function finish(threadId, turnId, status = 'completed') {
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: randomUUID(), text: 'Synthetic proof completed.', phase: 'final_answer' } });
  notify('turn/completed', { threadId, turn: { id: turnId, items: [], status, error: null } });
}
function handle(message) {
  if (process.env.NUCLEUS_T3_PROVIDER_LOG) appendFileSync(process.env.NUCLEUS_T3_PROVIDER_LOG, `${JSON.stringify({ method: message.method, id: message.id, input: message.method === 'turn/start' ? message.params?.input : undefined })}\n`);
  const { id, method, params = {} } = message;
  if (!method) {
    const turn = pending.get(id);
    if (turn) {
      pending.delete(id);
      if (message.error) { process.stderr.write(`Synthetic runtime request was rejected: ${JSON.stringify(message.error)}\n`); finish(turn.threadId, turn.turnId, 'interrupted'); }
      else finish(turn.threadId, turn.turnId);
    }
    return;
  }
  if (method === 'initialize') return reply(id, { userAgent: 'codex/0.166.0', codexHome: process.env.CODEX_HOME || process.cwd(), platformFamily: 'unix', platformOs: 'macos' });
  if (method === 'initialized') return;
  if (method === 'account/read') return reply(id, { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' }, requiresOpenaiAuth: false });
  if (method === 'account/rateLimits/read') return reply(id, { rateLimits: { limitId: 'codex', limitName: 'Synthetic', primary: null, secondary: null, credits: null, planType: 'plus' }, rateLimitsByLimitId: {} });
  if (method === 'model/list') return reply(id, { data: [model], nextCursor: null });
  if (method === 'skills/list') return reply(id, { data: [{ cwd: params.cwd || process.cwd(), errors: [], skills: [] }] });
  if (method === 'config/read') return reply(id, { config: {}, origins: {}, layers: null });
  if (method === 'mcpServerStatus/list') return reply(id, { data: [], nextCursor: null });
  if (method === 'thread/start' || method === 'thread/resume') {
    const value = thread(params.threadId, params.cwd);
    return reply(id, { thread: value, model: model.id, modelProvider: 'openai', cwd: value.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' }, reasoningEffort: 'medium' });
  }
  if (method === 'thread/read') return reply(id, { thread: threads.get(params.threadId) || thread(params.threadId) });
  if (method === 'turn/start') {
    const turnId = randomUUID();
    const threadId = params.threadId;
    const turn = { id: turnId, items: [], status: 'inProgress', error: null };
    reply(id, { turn });
    setTimeout(() => {
      notify('turn/started', { threadId, turn });
      const text = (params.input || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
      if (text.includes('proof-question')) {
        const requestId = nextRequest++;
        pending.set(requestId, { threadId, turnId });
        send({ id: requestId, method: 'item/tool/requestUserInput', params: { threadId, turnId, itemId: randomUUID(), isBlocking: true, questions: [{ id: 'continue', header: 'Continue', question: 'Continue the synthetic proof?', options: [{ label: 'Yes', description: 'Continue' }, { label: 'No', description: 'Stop' }] }] } });
      } else if (text.includes('proof-approval')) {
        const requestId = nextRequest++;
        pending.set(requestId, { threadId, turnId });
        send({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: randomUUID(), startedAtMs: Date.now(), command: 'synthetic-noop', cwd: process.cwd(), reason: 'Synthetic proof permission' } });
      } else if (!text.includes('proof-hold')) finish(threadId, turnId);
    }, 200);
    return;
  }
  if (method === 'turn/interrupt') {
    reply(id, {});
    setTimeout(() => finish(params.threadId, params.turnId, 'interrupted'), 20);
    return;
  }
  if (id !== undefined) reply(id, {});
}
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffered += chunk;
  const lines = buffered.split('\n');
  buffered = lines.pop() || '';
  for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
process.stdin.on('end', () => process.exit(0));
