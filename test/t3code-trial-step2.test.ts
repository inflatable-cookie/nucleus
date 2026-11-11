import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { observeIdle } from './support/fakes';
import { createHost, createAdapter } from '../hosts/t3code';
import { t3Fake } from './support/t3code-fake';
import { questionRoute } from '../core/questions/question-route';
import { AGENT_ASK_WAIT_MS } from '../core/questions/agent-ask';
import { resolveIngressHost } from '../core/host/ingress-host';
import { HostPolicies } from '../core/host/host-policies';
import type { HostPolicyConstructor } from '../core/host';
import { workerPrompt, runPrompt } from '../core/dispatch/prompts';
import { workerAgentSpec, runTicketPath } from '../core/dispatch/agent-creation';
import { workerHelper, startCallbacks, CALLBACK_ASK_TIMEOUT_MS, CALLBACK_SOCKET_TIMEOUT_MS } from '../service/callbacks/callback';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { QueueRuntime } from '../service/runtime-owner';
import { assembleOwnerTaskNext } from '../core/verbs/task-next';
import { submissionSchema, summarizeTask, taskNextSchema, type Completion, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter as HostAdapter } from '../core/host/adapter';

const Policy = HostPolicies as unknown as HostPolicyConstructor;

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (ready: () => boolean, label = 'condition') => {
  for (let i = 0; i < 80 && !ready(); i++) await tick();
  assert.ok(ready(), label);
};
const waitUntil = async (ready: () => boolean, label: string, timeoutMs = 5_000) => {
  const start = Date.now();
  while (!ready() && Date.now() - start < timeoutMs) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(ready(), label);
};
const boundAnswerCommand = (commands: Array<{ type?: string; threadId?: string; commandId?: string; text?: string }>, threadId: string, commandId?: string) =>
  commands.find(command => command.type === 'message.dispatch' && command.threadId === threadId
    && (commandId === undefined || command.commandId === commandId)
    && typeof command.text === 'string'
    && command.text.includes(`PASEO_AGENT_ID=${JSON.stringify(threadId)} nucleus question.answer -`));

const helperTask = {
  id: 'task', runId: 'run-t3', title: 'T3 trial', originAgentId: 'origin', coordinatorAgentId: null,
  dependsOn: [], branch: 'ns-task', baseBranch: 'main', handoffPath: 'handoff.md', planningCommit: 'a'.repeat(40),
  retiredWorkers: [], resolution: {}, skipPRReview: false, repoPath: '/repo', workspaceId: 'workspace', directory: '/worktree',
} as unknown as Task;

function spawnHelper(helper: string, ticket: string, payload: unknown, extraArgs: string[] = []) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ticket, ...extraArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('questionRoute sends T3 to the board, Codex Paseo to native, and MCP-only hosts to mcp_ask', () => {
  const t3 = { capabilities: () => ({ nativeDecisions: false, reportingViaMcp: false }), reportingViaMcp: false } as Pick<HostAdapter, 'capabilities' | 'raiseTaskDecision' | 'reportingViaMcp'>;
  assert.equal(questionRoute(t3), 'board');
  const paseo = {
    capabilities: () => ({ nativeDecisions: true, reportingViaMcp: true }),
    reportingViaMcp: true,
    raiseTaskDecision: async () => 'ok',
  } as unknown as Pick<HostAdapter, 'capabilities' | 'raiseTaskDecision' | 'reportingViaMcp'>;
  assert.equal(questionRoute(paseo, 'codex'), 'native');
  const mcpOnly = { reportingViaMcp: true } as Pick<HostAdapter, 'capabilities' | 'raiseTaskDecision' | 'reportingViaMcp'>;
  assert.equal(questionRoute(mcpOnly), 'mcp_ask');
});

test('a T3 helper report binds to its run and refuses a report for another run', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 't3-helper-report-')));
  const store = new Store(join(dir, 'queue.sqlite'));
  const engine = new Engine(store, { observe: observeIdle('ws', 'worker') } as unknown as HostAdapter, 0);
  const socketPath = join(dir, 's'), helper = join(dir, 'worker-report.mjs'), ticket = join(dir, 'ticket.json');
  const task = store.insert(submissionSchema.parse({
    submissionId: 't3-report', title: 'T3 report', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 't3code:synthetic-environment', 'handoff', 'a'.repeat(40));
  store.update(task.id, { phase: 'working', runId: 'run-t3', agentId: 'worker', workspaceId: 'ws' });
  store.setCredential('run-t3', 'fixture-secret');
  writeFileSync(ticket, JSON.stringify({ socketPath, token: 'fixture-secret', taskId: task.id, runId: 'run-t3' }), { mode: 0o600 });
  const stop = await startCallbacks(socketPath, helper, engine);
  try {
    const accepted = await spawnHelper(helper, ticket, { status: 'blocked', summary: 'T3 helper bound' });
    assert.equal(accepted.code, 0, accepted.err);
    assert.equal(store.task(task.id).completion?.runId, 'run-t3');
    assert.equal(store.task(task.id).completion?.summary, 'T3 helper bound');
    const refused = await spawnHelper(helper, ticket, { taskId: 'other-task', runId: 'other-run', status: 'blocked', summary: 'foreign' });
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /Report taskId does not match the callback ticket|Report runId does not match the callback ticket/);
    assert.equal(store.task(task.id).completion?.summary, 'T3 helper bound');
  } finally { await engine.stop(); await stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a Paseo worker prompt still names nucleus_report MCP; a T3 prompt names the helper and ticket', () => {
  const helper = '/data/worker-report.mjs', ticket = '/data/tickets/run-t3.json';
  const paseo = workerPrompt(helperTask, true);
  assert.match(paseo, /call the nucleus_report MCP tool with runId "run-t3"/);
  assert.match(paseo, /call the nucleus_ask MCP tool once inside the current turn/);
  const t3 = workerPrompt(helperTask, false, [], null, helper, ticket);
  assert.match(t3, /report through the packaged nucleus helper with this run's ticket/);
  assert.match(t3, /node '\/data\/worker-report\.mjs' '\/data\/tickets\/run-t3\.json'/);
  assert.match(t3, /The ticket binds this report to exactly this run; a report for any other run is refused/);
  assert.match(t3, /node '\/data\/worker-report\.mjs' '\/data\/tickets\/run-t3\.json' ask/);
  assert.match(t3, /node '\/data\/worker-report\.mjs' '\/data\/tickets\/run-t3\.json' message/);
  const reviewer = runPrompt(helperTask, { id: 'run-t3', role: 'reviewer', generation: 1, head: 'a'.repeat(40) } as Run, helper, ticket, false);
  assert.match(reviewer, /node '\/data\/worker-report\.mjs' '\/data\/tickets\/run-t3\.json'/);
});

test('workerAgentSpec writes no MCP binding on T3 and an empty environment', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 't3-spec-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helperPath = join(dir, 'worker-report.mjs');
  const task = {
    id: 'task-1', title: 'T3', runId: 'run-t3', workspaceId: 'ws', temporaryDirectory: join(dir, 'tmp'),
    profile: { id: 'p', name: 'p', provider: 'synthetic', model: 'm', notes: '', available: true, problem: '', supportedThinking: [] },
  } as unknown as Task;
  const t3 = workerAgentSpec(() => ({
    socketPath: join(dir, 'callback.sock'), helperPath, reportingViaMcp: false, perThreadEnvironment: false,
    admissionLaunchEnv: {}, scratchPlacement: () => ({ mount: dir, root: dir, create: () => {}, remove: () => true }),
  }), task, 'token', 'prompt', 'legacy');
  assert.equal(t3.mcpBindingPath, null);
  assert.deepEqual(t3.attempt(false, false).environment, {});
  const paseo = workerAgentSpec(() => ({
    socketPath: join(dir, 'callback.sock'), helperPath, reportingViaMcp: true,
    admissionLaunchEnv: {}, scratchPlacement: () => ({ mount: dir, root: dir, create: () => {}, remove: () => true }),
  }), task, 'token', 'prompt', 'legacy');
  assert.ok(paseo.mcpBindingPath);
  assert.match(paseo.mcpBindingPath, /mcp-run-t3\.json$/);
});

test('a T3 budget question lands on the board and recovery keeps it off the MCP route', async () => {
  const store = new Store(':memory:');
  store.setMeta('paused', false);
  store.setMeta('hostId', 't3code:synthetic-environment');
  const notices: Array<{ id: string; messageId: string; text: string }> = [];
  let failPlanner = true;
  const adapter = {
    capabilities: () => ({ reportingViaMcp: false, supportsCoordinatorRecovery: true, nativeDecisions: false, uiContributions: false, lifecycleDispatch: true, perThreadEnvironment: false }),
    reportingViaMcp: false,
    observe: observeIdle('ws', 'worker'),
    originAgent: async (id: string) => id === 'planner' ? { id, archived: false, workspaceId: 'planner-ws', title: 'Planner' } : null,
    notify: async (id: string, messageId: string, text: string) => {
      if (id === 'planner' && failPlanner) throw new Error('planner host unavailable');
      notices.push({ id, messageId, text });
    },
  } as unknown as HostAdapter;
  const engine = new Engine(store, adapter, 0);
  engine.identifyOriginHost = async () => 'paseo-host';
  engine.hostAvailable = () => true;
  const task = store.insert(submissionSchema.parse({
    submissionId: 't3-budget', title: 'T3 budget', repoPath: '/repo', planningCommit: 'a'.repeat(40),
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 't3code:synthetic-environment', 'handoff', 'a'.repeat(40));
  store.update(task.id, {
    phase: 'working', agentId: 'worker', workspaceId: 'ws', runId: 'run-t3',
    resolution: {
      ...store.task(task.id).resolution,
      stop: { reason: 'budget', detail: 'effective tokens', since: '2026-11-01T00:00:00.000Z', suggestedVerbs: [] },
    },
  });
  store.upsertProject({ key: 'trial', name: 'Trial', repositories: [{ origin: null, path: '/repo' }] });
  store.setProjectPlanner({ key: 'trial', agentId: 'planner', setBy: 'test' });
  try {
    await engine.resolution.raiseOperatorQuestions(task.id);
    const decisions = store.listDecisions({ status: 'open', task: task.id });
    assert.equal(decisions.length, 1);
    assert.match(decisions[0]!.question, /reached its budget/);
    assert.match(decisions[0]!.context ?? '', /the task host cannot take a native question/);
    await settle(() => store.eventsAll(task.id).some(event => event.kind === 'operator_question_planner_missed'), 'planner miss');
    assert.equal(notices.length, 0);
    assert.equal(store.eventsAll(task.id).some(event => event.kind === 'queue_ask_payload'), false, 'board route does not record an MCP ask payload');
    assert.equal(store.eventsAll(task.id).some(event => event.kind === 'queue_ask_delivery'), false, 'T3 does not prompt the worker to call nucleus_ask');
    failPlanner = false;
    await engine.resolution.resumeAskQuestions();
    await settle(() => notices.length === 1, 'planner notice retry');
    assert.equal(notices[0]!.id, 'planner');
    assert.match(notices[0]!.messageId, /^ns-queue-question-/);
    assert.match(notices[0]!.text, /cannot take a native question/);
    assert.ok(store.eventsAll(task.id).some(event => event.kind === 'operator_question_planner_notice'));
    const questionId = store.eventsAll(task.id).find(event => event.kind === 'operator_question')!.detail.split(':')[0]!;
    store.event(task.id, 'queue_ask_payload', JSON.stringify({
      id: questionId, kind: 'budget', question: decisions[0]!.question,
      options: ['Extend the budget', 'Change the approach', 'Stop and keep the work'],
    }));
    await engine.resolution.resumeAskQuestions();
    assert.equal(store.eventsAll(task.id).some(event => event.kind === 'queue_ask_delivery'), false, 'recovery never tells the T3 worker to call MCP');
    assert.equal(notices.some(notice => notice.id === 'worker' || notice.text.includes('Call the question MCP tool')), false);
  } finally { await engine.stop(); store.close(); }
});

test('repository hostKind selects the online host of that kind; switching back leaves live tasks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-host-optin-'));
  const client = { isConnected: true };
  const paseo = { client, hostId: 'paseo-primary', socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'helper.mjs'),
    connect: async () => { client.isConnected = true; }, close: async () => { client.isConnected = false; },
    catalog: async () => ({ providers: [] }) } as unknown as HostAdapter;
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => paseo, timers: false });
  try {
    await runtime.started; await runtime.bootstrap;
    const t3 = { client: { isConnected: true }, hostId: 't3code:env', socketPath: join(dir, 't3.sock'), helperPath: join(dir, 't3-helper.mjs'),
      connect: async () => {}, close: async () => {}, catalog: async () => ({ providers: [] }) } as unknown as HostAdapter;
    runtime.hostRegistry.connect('t3code:env', 'endpoint-t3', { adapter: t3, admission: runtime.admission });
    runtime.store.putRepository({ origin: null, path: '/repo' }, null, '', null, null, null, undefined, undefined, 't3code');
    assert.equal(runtime.engine.selectIngressHost(undefined, '/repo'), 't3code:env');
    const accepted = await runtime.engine.startOperation({
      key: 'opt-in-submit', kind: 'review_entry', payload: { type: 'review_entry', input: {} },
      repoPath: '/repo', deferSchedule: true,
    });
    if (!('accepted' in accepted)) throw Error('backpressured');
    assert.deepEqual(accepted.operation.hostSelection, { hostId: 't3code:env', basis: 'repository_host', reason: 'Repository hostKind t3code' });
    const submission = submissionSchema.parse({
      submissionId: 'live-t3', title: 'Live T3 task', repoPath: '/repo', planningCommit: 'a'.repeat(40),
      handoffPath: 'h', originAgentId: 'origin',
    });
    const live = runtime.store.insert(submission, 't3code:env', 'h', 'a'.repeat(40), { hostSelection: accepted.operation.hostSelection });
    runtime.store.patchRepository({ origin: null, path: '/repo' }, { hostKind: 'paseo' });
    assert.equal(runtime.store.task(live.id).hostId, 't3code:env', 'switching the setting never rehosts a live task');
    assert.equal(runtime.engine.selectIngressHost(undefined, '/repo'), 'paseo-primary');
    const next = await runtime.engine.startOperation({
      key: 'opt-out-submit', kind: 'review_entry', payload: { type: 'review_entry', input: {} },
      repoPath: '/repo', deferSchedule: true,
    });
    if (!('accepted' in next)) throw Error('backpressured');
    assert.equal(next.operation.hostSelection?.hostId, 'paseo-primary');
    assert.equal(next.operation.hostSelection?.basis, 'repository_host');
    const summary = summarizeTask(runtime.store.task(live.id));
    assert.equal(summary.hostId, 't3code:env');
    const view = assembleOwnerTaskNext({
      store: runtime.store, task: runtime.store.task(live.id), runs: [], events: [], notices: [], hookRecords: [], planning: true,
    }, () => []);
    assert.equal(view.host, 't3code:env');
    assert.equal(taskNextSchema.parse(view).host, 't3code:env');
  } finally { await runtime.drain(); }
});

test('T3 Adapter enables lifecycleDispatch; the Host stays native-only; create without helper refuses', async (t: TestContext) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 't3-lifecycle-')));
  const server = await t3Fake(t, directory);
  const host = createHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', probeThreadId: 'synthetic-probe',
    statePath: join(directory, 'hosts', 't3code.json'), timeoutMs: 2_000 });
  t.after(() => host.close());
  await host.connect();
  assert.equal(host.capabilities().lifecycleDispatch, false);
  const native = createAdapter(Policy, host);
  assert.equal(native.capabilities().lifecycleDispatch, true);
  assert.equal(native.capabilities().supportsCoordinatorRecovery, true);
  assert.equal(native.reportingViaMcp, false);
  assert.equal(native.supportsCoordinatorRecovery, true);
  assert.throws(() => native.createAgent({} as never, 'unused', 'unused'), /helper path/);
  const wired = createAdapter(Policy, host, { socketPath: join(directory, 'callback.sock'), helperPath: join(directory, 'worker-report.mjs') });
  assert.equal(wired.capabilities().lifecycleDispatch, true);
  assert.equal(runTicketPath({ helperPath: join(directory, 'worker-report.mjs') }, 'run-t3'), join(directory, 'tickets', 'run-t3.json'));
});

test('resolveIngressHost fails closed when the opted-in kind is not online', () => {
  assert.throws(() => resolveIngressHost({ hostKind: 't3code', registered: ['paseo-primary'], online: ['paseo-primary'] }), /T3Code host is not online/);
  assert.throws(() => resolveIngressHost({ hostKind: 'paseo', registered: ['t3code:env'], online: ['t3code:env'] }), /Paseo host is not online/);
  const explicit = resolveIngressHost({ explicit: 't3code:env', hostKind: 'paseo', registered: ['paseo-primary', 't3code:env'], online: ['paseo-primary', 't3code:env'] });
  assert.deepEqual(explicit.selection, { hostId: 't3code:env', basis: 'explicit' });
});

test('the helper ask and message subcommands post to the ticket-bound routes', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 't3-helper-ask-')));
  const requests: { path: string | undefined; body: { taskId: string; runId: string } }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: JSON.parse(body) });
    res.end('{"ok":true,"status":"pending"}');
  });
  const socketPath = join(dir, 's');
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const helper = join(dir, 'worker-report.mjs'), ticket = join(dir, 'ticket.json');
  writeFileSync(helper, workerHelper);
  writeFileSync(ticket, JSON.stringify({ socketPath, token: 'fixture-secret', taskId: 't', runId: 'r' }));
  try {
    const ask = await spawnHelper(helper, ticket, { question: 'Should we change approach?', kind: 'process' }, ['ask']);
    assert.equal(ask.code, 0, ask.err);
    assert.equal(requests[0]!.path, '/ask');
    assert.equal(requests[0]!.body.taskId, 't');
    assert.equal(requests[0]!.body.runId, 'r');
    const message = await spawnHelper(helper, ticket, { to: 'other-task', text: 'Heads up from the T3 worker.' }, ['message']);
    assert.equal(message.code, 0, message.err);
    assert.equal(requests[1]!.path, '/message');
    assert.equal(requests[1]!.body.taskId, 't');
    const foreign = await spawnHelper(helper, ticket, { taskId: 'other', question: 'nope' }, ['ask']);
    assert.notEqual(foreign.code, 0);
    assert.match(foreign.err, /Report taskId does not match the callback ticket/);
    assert.equal(requests.length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('the helper ask timeout outlasts the server wait and covers delayed and pending answers', async () => {
  assert.ok(CALLBACK_ASK_TIMEOUT_MS > AGENT_ASK_WAIT_MS);
  assert.match(workerHelper, new RegExp(String.raw`timeoutMs:route==='/ask'\?${CALLBACK_ASK_TIMEOUT_MS}:${CALLBACK_SOCKET_TIMEOUT_MS}`));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 't3-helper-ask-wait-')));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const profile = { id: 'p', name: 'p', provider: 'synthetic', model: 'm', notes: '', available: true, problem: '', supportedThinking: [] } as Profile;
  const adapter = {
    observe: observeIdle('ws', 'worker'),
    notify: async () => {},
    askPlanner: async () => null,
    originAgent: async () => null,
  } as unknown as HostAdapter;
  const engine = new Engine(store, adapter, 0);
  engine.resolution.agentAskWaitMs = 400;
  engine.resolution.agentAskPollMs = 20;
  const task = store.insert(submissionSchema.parse({
    submissionId: 't3-ask-wait', title: 'T3 ask wait', repoPath: '/repo', planningCommit: 'a'.repeat(40),
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 't3code:synthetic-environment', 'handoff', 'a'.repeat(40));
  store.update(task.id, {
    phase: 'working', runId: 'run-1', agentId: 'worker', workspaceId: 'ws', profile,
  });
  store.setCredential('run-1', 'fixture-secret');
  const socketPath = join(dir, 's'), helper = join(dir, 'worker-report.mjs'), ticket = join(dir, 'ticket.json');
  writeFileSync(ticket, JSON.stringify({ socketPath, token: 'fixture-secret', taskId: task.id, runId: 'run-1' }), { mode: 0o600 });
  const stop = await startCallbacks(socketPath, helper, engine);
  try {
    const delayed = spawnHelper(helper, ticket, { question: 'Delay this T3 helper ask?', kind: 'process' }, ['ask']);
    await waitUntil(() => store.eventsAll(task.id).some(event => event.kind === 'agent_ask'), 'ask recorded');
    const askId = store.eventsAll(task.id).find(event => event.kind === 'agent_ask')!.detail.split(':')[0]!;
    store.event(task.id, 'agent_ask_answered', `${askId}: answered by planner planner: proceed`);
    const answered = await delayed;
    assert.equal(answered.code, 0, answered.err);
    const receipt = JSON.parse(answered.out) as { status: string; answer?: string };
    assert.equal(receipt.status, 'answered');
    assert.equal(receipt.answer, 'proceed');
    const pending = await spawnHelper(helper, ticket, { question: 'A different pending T3 helper ask?', kind: 'process' }, ['ask']);
    assert.equal(pending.code, 0, pending.err);
    assert.equal((JSON.parse(pending.out) as { status: string }).status, 'pending');
  } finally { await engine.stop(); await stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('T3 adapter verifies reviews and continues retained threads without a fresh launch', async (t: TestContext) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 't3-review-continue-')));
  const server = await t3Fake(t, directory);
  const host = createHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', probeThreadId: 'synthetic-probe',
    statePath: join(directory, 'hosts', 't3code.json'), timeoutMs: 2_000 });
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace', directory, project: { projectId: 'synthetic-project' } });
  const profile = { id: 'p', name: 'p', provider: 'synthetic-provider', model: 'synthetic-model', notes: '', available: true, problem: '', supportedThinking: [] } as Profile;
  const worker = await host.createAgent({
    workspaceId: workspace.id, title: 'Synthetic worker', mcpBindingPath: null, profile,
    attempt: () => ({ requestId: 'create-worker', prompt: 'work', labels: { 'nucleus.task': 'task' }, environment: {} }),
  });
  const helperPath = join(directory, 'worker-report.mjs');
  const adapter = createAdapter(Policy, host, {
    socketPath: join(directory, 'callback.sock'), helperPath,
  });
  adapter.runScratch = { mount: directory, root: join(directory, 'scratch'), create: path => mkdirSync(path, { recursive: true }), remove: () => true };
  const task = {
    id: 'task', title: 'T3 review', repoPath: directory, directory, workspaceId: workspace.id, agentId: worker.id, runId: 'run-t3',
    branch: 'ns-task', baseBranch: 'main', retiredWorkers: [], resolution: {}, profile,
  } as unknown as Task;
  const run = {
    id: 'run-t3', taskId: task.id, role: 'reviewer', generation: 1, head: 'a'.repeat(40),
    agentId: worker.id, workspaceId: workspace.id, profile,
  } as unknown as Run;
  await assert.rejects(adapter.verifyReview(task, run, { status: 'changes_requested', summary: 'needs work', head: run.head } as unknown as Completion),
    /not independent|authored this task/);
  const preflight = await adapter.preflightWorkerContinuation(task);
  assert.deepEqual(preflight, { available: true });
  await adapter.continueWorker(task, 'checkpoint-1', 'Continue the retained T3 worker.');
  assert.ok(server.commands.some(command => command.type === 'message.dispatch' && command.threadId === worker.id && command.text === 'Continue the retained T3 worker.'));
  await adapter.continueRun(run, 'ns-run-continue', 'Continue the retained T3 run.');
  assert.ok(server.commands.some(command => command.type === 'message.dispatch' && command.text === 'Continue the retained T3 run.'));
  await adapter.sendRun(task, run, 'token');
  assert.ok(server.commands.some(command => command.type === 'message.dispatch' && command.commandId === 'ns-run-run-t3'));
  const reviewer = await adapter.continueReviewer(task, run, 'ns-reviewer-1', 'Review in place.', async () => true, () => true);
  assert.equal(reviewer.sent, true);
  assert.ok(server.commands.some(command => command.type === 'message.dispatch' && command.commandId === 'ns-reviewer-1' && command.text === 'Review in place.'));
});

test('T3 adapter asks a retained reviewer and binds uncertain run creation', async (t: TestContext) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 't3-ask-bind-')));
  const server = await t3Fake(t, directory);
  const host = createHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', probeThreadId: 'synthetic-probe',
    statePath: join(directory, 'hosts', 't3code.json'), timeoutMs: 2_000 });
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace', directory, project: { projectId: 'synthetic-project' } });
  const profile = { id: 'p', name: 'p', provider: 'synthetic-provider', model: 'synthetic-model', notes: '', available: true, problem: '', supportedThinking: [] } as Profile;
  const worker = await host.createAgent({
    workspaceId: workspace.id, title: 'Synthetic worker', mcpBindingPath: null, profile,
    attempt: () => ({ requestId: 'create-worker', prompt: 'work', labels: { 'nucleus.task': 'task', 'nucleus.run': 'run-worker' }, environment: {} }),
  });
  const reviewer = await host.createAgent({
    workspaceId: workspace.id, title: 'Synthetic reviewer', mcpBindingPath: null, profile,
    attempt: () => ({ requestId: 'create-reviewer', prompt: 'review', labels: { 'nucleus.task': 'task', 'nucleus.run': 'run-review', 'nucleus.role': 'reviewer' }, environment: {} }),
  });
  const adapter = createAdapter(Policy, host, { socketPath: join(directory, 'callback.sock'), helperPath: join(directory, 'worker-report.mjs') });
  const bound = { id: 'run-review', taskId: 'task', role: 'reviewer', workspaceId: workspace.id } as Run;
  assert.deepEqual(await adapter.findRunAgents(bound), [{ id: reviewer.id, workspaceId: workspace.id }]);
  assert.deepEqual(await adapter.findRunAgents({ ...bound, id: 'run-other' }), []);
  assert.equal(await adapter.askReviewer!(reviewer.id, {
    prompt: 'Consult the retained T3 reviewer.', signal: new AbortController().signal, timeoutMs: 1_000, messageId: 'ns-agent-ask-reviewer-1',
  }), null);
  const boundConsult = boundAnswerCommand(server.commands, reviewer.id, 'ns-agent-ask-reviewer-1');
  assert.ok(boundConsult);
  assert.match(boundConsult.text!, /Consult the retained T3 reviewer/);

  const store = new Store(join(directory, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('hostId', host.hostId);
  const engine = new Engine(store, adapter, 0);
  engine.resolution.agentAskWaitMs = 8_000;
  engine.resolution.agentAskPollMs = 20;
  engine.resolution.delegatedAnswerWaitMs = 6_000;
  const task = store.insert(submissionSchema.parse({
    submissionId: 't3-ask-reviewer', title: 'T3 ask reviewer', repoPath: directory, planningCommit: 'a'.repeat(40),
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), host.hostId, 'handoff', 'a'.repeat(40));
  store.update(task.id, {
    phase: 'working', runId: 'run-worker', agentId: worker.id, workspaceId: workspace.id, profile,
    resolution: { ...store.task(task.id).resolution, reviewerAgentId: reviewer.id },
  });
  store.setCredential('run-worker', 'fixture-secret');
  const socketPath = join(directory, 's'), helper = join(directory, 'worker-report.mjs'), ticket = join(directory, 'ticket.json');
  writeFileSync(ticket, JSON.stringify({ socketPath, token: 'fixture-secret', taskId: task.id, runId: 'run-worker' }), { mode: 0o600 });
  const stop = await startCallbacks(socketPath, helper, engine);
  try {
    const pending = spawnHelper(helper, ticket, { question: 'Should the T3 reviewer advise this ask?', kind: 'process' }, ['ask']);
    await waitUntil(() => {
      const ask = store.eventsAll(task.id).find(event => event.kind === 'agent_ask');
      return Boolean(ask && boundAnswerCommand(server.commands, reviewer.id, `ns-agent-ask-reviewer-${ask.detail.split(':')[0]!}`));
    }, 'reviewer consult dispatched with bound answer route');
    assert.equal(store.eventsAll(task.id).some(event => event.kind === 'agent_ask_delegation_missed' && event.detail.includes('delivery adapter unavailable')), false);
    const askId = store.eventsAll(task.id).find(event => event.kind === 'agent_ask')!.detail.split(':')[0]!;
    engine.resolution.answerDelegatedQuestion({
      questionId: `ns-agent-ask-reviewer-${askId}`, answer: 'Keep the current T3 approach.', reason: 'Within the approved outcome.',
    }, reviewer.id);
    const answered = await pending;
    assert.equal(answered.code, 0, answered.err);
    const receipt = JSON.parse(answered.out) as { status: string; answer?: string };
    assert.equal(receipt.status, 'answered');
    assert.equal(receipt.answer, 'Keep the current T3 approach.');
  } finally { await engine.stop(); await stop(); store.close(); }
});

test('T3 adapter asks a project planner, including a reviewer planning ruling', async (t: TestContext) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 't3-ask-planner-')));
  const server = await t3Fake(t, directory);
  const host = createHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', probeThreadId: 'synthetic-probe',
    statePath: join(directory, 'hosts', 't3code.json'), timeoutMs: 2_000 });
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace', directory, project: { projectId: 'synthetic-project' } });
  const profile = { id: 'p', name: 'p', provider: 'synthetic-provider', model: 'synthetic-model', notes: '', available: true, problem: '', supportedThinking: [] } as Profile;
  const worker = await host.createAgent({
    workspaceId: workspace.id, title: 'Synthetic worker', mcpBindingPath: null, profile,
    attempt: () => ({ requestId: 'create-worker', prompt: 'work', labels: { 'nucleus.task': 'task', 'nucleus.run': 'run-worker' }, environment: {} }),
  });
  const reviewer = await host.createAgent({
    workspaceId: workspace.id, title: 'Synthetic reviewer', mcpBindingPath: null, profile,
    attempt: () => ({ requestId: 'create-reviewer', prompt: 'review', labels: { 'nucleus.task': 'task', 'nucleus.run': 'run-review', 'nucleus.role': 'reviewer' }, environment: {} }),
  });
  const planner = await host.createAgent({
    workspaceId: workspace.id, title: 'Synthetic planner', mcpBindingPath: null, profile,
    attempt: () => ({ requestId: 'create-planner', prompt: 'plan', labels: { 'nucleus.role': 'planner' }, environment: {} }),
  });
  const adapter = createAdapter(Policy, host, { socketPath: join(directory, 'callback.sock'), helperPath: join(directory, 'worker-report.mjs') });
  assert.equal(await adapter.askPlanner!(planner.id, {
    prompt: 'Ask the T3 project planner.', signal: new AbortController().signal, timeoutMs: 1_000, messageId: 'ns-agent-ask-planner-1',
  }), null);
  const boundPlanner = boundAnswerCommand(server.commands, planner.id, 'ns-agent-ask-planner-1');
  assert.ok(boundPlanner);
  assert.match(boundPlanner.text!, /Ask the T3 project planner/);

  const store = new Store(join(directory, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('hostId', host.hostId);
  store.upsertProject({ key: 't3-trial', name: 'T3 trial', repositories: [{ origin: null, path: directory }] });
  store.setProjectPlanner({ key: 't3-trial', agentId: planner.id, setBy: 'test' });
  const engine = new Engine(store, adapter, 0);
  engine.resolution.agentAskWaitMs = 12_000;
  engine.resolution.agentAskPollMs = 20;
  engine.resolution.delegatedAnswerWaitMs = 6_000;
  const task = store.insert(submissionSchema.parse({
    submissionId: 't3-ask-planner', title: 'T3 ask planner', repoPath: directory, planningCommit: 'a'.repeat(40),
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), host.hostId, 'handoff', 'a'.repeat(40));
  store.update(task.id, {
    phase: 'working', runId: 'run-worker', agentId: worker.id, workspaceId: workspace.id, profile,
    resolution: { ...store.task(task.id).resolution, reviewerAgentId: reviewer.id },
  });
  store.setCredential('run-worker', 'fixture-secret');
  const socketPath = join(directory, 's'), helper = join(directory, 'worker-report.mjs'), ticket = join(directory, 'ticket.json');
  writeFileSync(ticket, JSON.stringify({ socketPath, token: 'fixture-secret', taskId: task.id, runId: 'run-worker' }), { mode: 0o600 });
  const stop = await startCallbacks(socketPath, helper, engine);
  try {
    const pending = spawnHelper(helper, ticket, { question: 'Does this T3 ask need a planning ruling?', kind: 'process' }, ['ask']);
    await waitUntil(() => {
      const ask = store.eventsAll(task.id).find(event => event.kind === 'agent_ask');
      return Boolean(ask && boundAnswerCommand(server.commands, reviewer.id, `ns-agent-ask-reviewer-${ask.detail.split(':')[0]!}`));
    }, 'reviewer consult dispatched with bound answer route');
    const askId = store.eventsAll(task.id).find(event => event.kind === 'agent_ask')!.detail.split(':')[0]!;
    engine.resolution.answerDelegatedQuestion({
      questionId: `ns-agent-ask-reviewer-${askId}`,
      answer: 'Decision: planner — This changes the approved product outcome.',
      reason: 'A planning ruling is needed.',
    }, reviewer.id);
    await waitUntil(() => Boolean(boundAnswerCommand(server.commands, planner.id, `ns-agent-ask-${askId}`)),
      'planner consult dispatched with bound answer route');
    assert.ok(store.eventsAll(task.id).some(event => event.kind === 'agent_ask_planning_ruling' && event.detail.includes(`reviewer ${reviewer.id}`)));
    assert.equal(store.eventsAll(task.id).some(event => event.kind === 'agent_ask_delegation_missed'), false);
    engine.resolution.answerDelegatedQuestion({
      questionId: `ns-agent-ask-${askId}`, answer: 'Keep the T3 planner outcome.', reason: 'Within the approved brief.',
    }, planner.id);
    const answered = await pending;
    assert.equal(answered.code, 0, answered.err);
    const receipt = JSON.parse(answered.out) as { status: string; answer?: string };
    assert.equal(receipt.status, 'answered');
    assert.equal(receipt.answer, 'Keep the T3 planner outcome. — Within the approved brief.');
  } finally { await engine.stop(); await stop(); store.close(); }
});
