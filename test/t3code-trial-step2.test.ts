import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { observeIdle } from './support/fakes';
import { createHost, createAdapter } from '../hosts/t3code';
import { canonical } from '../hosts/t3code/state';
import { t3Fake } from './support/t3code-fake';
import { command, git } from '../core/git/index';
import { questionRoute } from '../core/questions/question-route';
import { AGENT_ASK_WAIT_MS } from '../core/questions/agent-ask';
import { resolveIngressHost } from '../core/host/ingress-host';
import { HostPolicies } from '../core/host/host-policies';
import type { HostPolicyConstructor } from '../core/host';
import { workerPrompt, runPrompt } from '../core/dispatch/prompts';
import { workerAgentSpec, runTicketPath } from '../core/dispatch/agent-creation';
import { workerHelper, startCallbacks, CALLBACK_ASK_TIMEOUT_MS, CALLBACK_SOCKET_TIMEOUT_MS } from '../service/callbacks/callback';
import { hostCallerIdentity } from '../hosts/paseo/cli/index.mjs';
import { resolveQuestionAnswerCaller } from '../shared/question-caller.mjs';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { QueueRuntime } from '../service/runtime-owner';
import { assembleOwnerTaskNext } from '../core/verbs/task-next';
import { submissionSchema, summarizeTask, taskControlInputSchema, taskNextSchema, type Completion, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter as HostAdapter } from '../core/host/adapter';
import { Decisions } from '../core/planning/decisions';

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
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const boundAnswerCommand = (commands: Array<{ type?: string; threadId?: string; commandId?: string; text?: string }>, threadId: string, helperPath: string, runId: string, commandId?: string) => {
  const ticketPath = join(dirname(helperPath), 'tickets', `${runId}.json`);
  const cli = `NUCLEUS_TICKET=${quote(ticketPath)} nucleus question.answer -`;
  const helper = `node ${quote(helperPath)} ${quote(ticketPath)} answer`;
  return commands.find(command => command.type === 'message.dispatch' && command.threadId === threadId
    && (commandId === undefined || command.commandId === commandId)
    && typeof command.text === 'string'
    && command.text.includes(cli)
    && command.text.includes(helper));
};
const putReleasedReviewer = (store: Store, task: Task, reviewerId: string, profile: Profile) => {
  store.putRun({
    id: 'run-review', taskId: task.id, role: 'reviewer', generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40),
    agentId: reviewerId, workspaceId: task.workspaceId ?? 'ws', profile, status: 'finished',
    createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null,
    completion: null, released: true,
  } as Run);
};

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
function spawnCli(env: NodeJS.ProcessEnv, payload: unknown) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('../bin/queue-cli.mjs', import.meta.url).pathname, 'question.answer', '-'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(), ...env },
    });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
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
  assert.match(paseo, /call the ask MCP tool once inside the current turn/);
  const t3 = workerPrompt(helperTask, false, [], null, helper, ticket);
  assert.match(t3, /report through the packaged nucleus helper with this run's ticket/);
  assert.match(t3, /node '\/data\/worker-report\.mjs' '\/data\/tickets\/run-t3\.json'/);
  assert.match(t3, /The ticket binds this report to exactly this run; a report for any other run is refused/);
  assert.match(t3, /feed the question JSON on stdin to `nucleus ask`/);
  assert.match(t3, /feed JSON \{to, role, text\} on stdin to `nucleus tell`/);
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

test('a T3 scope question lands on the board and recovery keeps it off the MCP route', async () => {
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
    const controller = new AbortController();
    const pending = engine.resolution.raiseDecision(store.task(task.id), {
      id: 't3-scope-question', kind: 'scope', question: 'Should the task scope change?', options: ['Change scope', 'Keep scope'],
    }, controller.signal);
    void pending.catch(() => {});
    const decisions = store.listDecisions({ status: 'open', task: task.id });
    assert.equal(decisions.length, 1);
    assert.match(decisions[0]!.question, /Should the task scope change/);
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
    await engine.resolution.resumeAskQuestions();
    assert.equal(store.eventsAll(task.id).some(event => event.kind === 'queue_ask_delivery'), false, 'recovery never tells the T3 worker to call MCP');
    assert.equal(notices.some(notice => notice.id === 'worker' || notice.text.includes('Call the question MCP tool')), false);
    controller.abort();
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
  // One project per repository: the closeout archive holds while a live task
  // shares the repository (nucleus#1139 review).
  assert.equal(native.capabilities().repositorySharedWorkspaces, true);
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

test('the helper ask, message and answer subcommands post to the ticket-bound routes', async () => {
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
    const answer = await spawnHelper(helper, ticket, { questionId: 'q', answer: 'Keep it.', reason: 'Fits the brief.' }, ['answer']);
    assert.equal(answer.code, 0, answer.err);
    assert.equal(requests[2]!.path, '/answer');
    assert.equal(requests[2]!.body.taskId, 't');
    assert.equal(requests[2]!.body.runId, 'r');
    const foreign = await spawnHelper(helper, ticket, { taskId: 'other', question: 'nope' }, ['ask']);
    assert.notEqual(foreign.code, 0);
    assert.match(foreign.err, /Report taskId does not match the callback ticket/);
    const foreignAnswer = await spawnHelper(helper, ticket, { taskId: 'other', questionId: 'q', answer: 'nope', reason: 'no' }, ['answer']);
    assert.notEqual(foreignAnswer.code, 0);
    assert.match(foreignAnswer.err, /Report taskId does not match the callback ticket/);
    assert.equal(requests.length, 3);
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
  const helperPath = join(directory, 'worker-report.mjs');
  const socketPath = join(directory, 'callback.sock');
  const adapter = createAdapter(Policy, host, { socketPath, helperPath });
  const bound = { id: 'run-review', taskId: 'task', role: 'reviewer', workspaceId: workspace.id } as Run;
  assert.deepEqual(await adapter.findRunAgents(bound), [{ id: reviewer.id, workspaceId: workspace.id }]);
  assert.deepEqual(await adapter.findRunAgents({ ...bound, id: 'run-other' }), []);
  assert.equal(await adapter.askReviewer!(reviewer.id, {
    prompt: 'Consult the retained T3 reviewer.', signal: new AbortController().signal, timeoutMs: 1_000, messageId: 'ns-agent-ask-reviewer-1',
  }), null);
  assert.ok(server.commands.some(command => command.type === 'message.dispatch' && command.threadId === reviewer.id
    && command.commandId === 'ns-agent-ask-reviewer-1' && command.text === 'Consult the retained T3 reviewer.'));

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
  putReleasedReviewer(store, store.task(task.id), reviewer.id, profile);
  store.putRun({
    id: 'run-review-later', taskId: task.id, role: 'reviewer', generation: 2, head: 'a'.repeat(40), base: 'a'.repeat(40),
    agentId: reviewer.id, workspaceId: workspace.id, profile, status: 'finished',
    createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null,
    completion: null, released: true,
  } as Run);
  store.setCredential('run-worker', 'fixture-secret');
  const ticket = join(directory, 'ticket.json');
  writeFileSync(ticket, JSON.stringify({ socketPath, token: 'fixture-secret', taskId: task.id, runId: 'run-worker' }), { mode: 0o600 });
  const stop = await startCallbacks(socketPath, helperPath, engine);
  try {
    const pending = spawnHelper(helperPath, ticket, { question: 'Should the T3 reviewer advise this ask?', kind: 'process' }, ['ask']);
    await waitUntil(() => {
      const ask = store.eventsAll(task.id).find(event => event.kind === 'agent_ask');
      return Boolean(ask && boundAnswerCommand(server.commands, reviewer.id, helperPath, 'run-review-later', `ns-agent-ask-reviewer-${ask.detail.split(':')[0]!}`));
    }, 'reviewer consult dispatched with reissued latest ticket');
    assert.equal(store.eventsAll(task.id).some(event => event.kind === 'agent_ask_delegation_missed' && event.detail.includes('delivery adapter unavailable')), false);
    const askId = store.eventsAll(task.id).find(event => event.kind === 'agent_ask')!.detail.split(':')[0]!;
    const consult = boundAnswerCommand(server.commands, reviewer.id, helperPath, 'run-review-later', `ns-agent-ask-reviewer-${askId}`)!;
    assert.match(consult.text!, /nucleus question.answer -/);
    assert.equal(consult.text!.includes('PASEO_AGENT_ID='), false);
    assert.equal(consult.text!.includes(`tickets/run-review.json`), false);
    const reviewerTicket = join(directory, 'tickets', 'run-review-later.json');
    await waitUntil(() => existsSync(reviewerTicket), 'reissued reviewer ticket');
    const helperAnswer = await spawnHelper(helperPath, reviewerTicket, {
      questionId: `ns-agent-ask-reviewer-${askId}`, answer: 'Keep the current T3 approach.', reason: 'Within the approved outcome.',
    }, ['answer']);
    assert.equal(helperAnswer.code, 0, helperAnswer.err);
    const answered = await pending;
    assert.equal(answered.code, 0, answered.err);
    const receipt = JSON.parse(answered.out) as { status: string; answer?: string };
    assert.equal(receipt.status, 'answered');
    assert.equal(receipt.answer, 'Keep the current T3 approach.');
  } finally { await engine.stop(); await stop(); store.close(); }
});

test('a T3 planner ask becomes a board decision; the worker helper receives the board answer', async (t: TestContext) => {
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
  const helperPath = join(directory, 'worker-report.mjs');
  const socketPath = join(directory, 'callback.sock');
  const adapter = createAdapter(Policy, host, { socketPath, helperPath });
  assert.equal(adapter.askPlanner, undefined);

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
  putReleasedReviewer(store, store.task(task.id), reviewer.id, profile);
  store.setCredential('run-worker', 'fixture-secret');
  const ticket = join(directory, 'ticket.json');
  writeFileSync(ticket, JSON.stringify({ socketPath, token: 'fixture-secret', taskId: task.id, runId: 'run-worker' }), { mode: 0o600 });
  const stop = await startCallbacks(socketPath, helperPath, engine);
  try {
    const pending = spawnHelper(helperPath, ticket, { question: 'Does this T3 ask need a planning ruling?', kind: 'process' }, ['ask']);
    await waitUntil(() => {
      const ask = store.eventsAll(task.id).find(event => event.kind === 'agent_ask');
      return Boolean(ask && boundAnswerCommand(server.commands, reviewer.id, helperPath, 'run-review', `ns-agent-ask-reviewer-${ask.detail.split(':')[0]!}`));
    }, 'reviewer consult dispatched with bound answer route');
    const askId = store.eventsAll(task.id).find(event => event.kind === 'agent_ask')!.detail.split(':')[0]!;
    const reviewerTicket = join(directory, 'tickets', 'run-review.json');
    await waitUntil(() => existsSync(reviewerTicket), 'reissued reviewer ticket');
    const helperAnswer = await spawnHelper(helperPath, reviewerTicket, {
      questionId: `ns-agent-ask-reviewer-${askId}`,
      answer: 'Decision: planner — This changes the approved product outcome.',
      reason: 'A planning ruling is needed.',
    }, ['answer']);
    assert.equal(helperAnswer.code, 0, helperAnswer.err);
    const decisions = new Decisions(store);
    await waitUntil(() => decisions.list({ status: 'open', task: task.id }).length === 1, 'planner fallback is on the board');
    assert.ok(store.eventsAll(task.id).some(event => event.kind === 'agent_ask_planning_ruling' && event.detail.includes(`reviewer ${reviewer.id}`)));
    assert.ok(store.eventsAll(task.id).some(event => event.kind === 'agent_ask_decision' && event.detail.startsWith(`${askId}:`)));
    assert.equal(store.eventsAll(task.id).some(event => event.kind === 'agent_ask_delegation_missed'), false);
    assert.equal(server.commands.some(command => command.type === 'message.dispatch' && command.threadId === planner.id), false);
    const open = decisions.list({ status: 'open', task: task.id })[0]!;
    assert.match(`${open.details ?? ''}\n${open.context ?? ''}`, /cannot be asked on its host/);
    const view = decisions.answer({
      id: open.id, version: open.version, answer: 'Keep the T3 planner outcome.',
      answeredBy: 'operator (board)', relayed: false, note: '',
    });
    engine.resolution.operatorDecisionAnswered(view);
    const answered = await pending;
    assert.equal(answered.code, 0, answered.err);
    const receipt = JSON.parse(answered.out) as { status: string; answer?: string };
    assert.equal(receipt.status, 'answered');
    assert.equal(receipt.answer, 'Keep the T3 planner outcome.');
  } finally { await engine.stop(); await stop(); store.close(); }
});

test('a host-A ticket cannot answer a question delegated to the same native id on host B', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 't3-host-isolation-')));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('hostRegistry', [{ id: 'host-a' }, { id: 'host-b' }]);
  const engine = new Engine(store, { observe: observeIdle('ws', 'worker') } as unknown as HostAdapter, 0);
  const socketPath = join(dir, 's'), helper = join(dir, 'worker-report.mjs');
  const task = store.insert(submissionSchema.parse({
    submissionId: 'cross-host-answer', title: 'Cross host answer', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host-a', 'handoff', 'a'.repeat(40));
  const profile = { id: 'p', name: 'p', provider: 'synthetic', model: 'm', notes: '', available: true, problem: '', supportedThinking: [] } as Profile;
  store.putRun({
    id: 'run-a', taskId: task.id, role: 'reviewer', generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40),
    agentId: 'shared-native', workspaceId: 'ws-a', profile, status: 'finished',
    createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null,
    completion: null, released: true,
  } as Run);
  store.setCredential('run-a', 'fixture-secret');
  engine.resolution.openDelegatedQuestion(store.task(task.id), 'q-b', 'shared-native', 'Continue?', 60_000, 'reviewer', 'host-b');
  const ticket = join(dir, 'ticket-a.json');
  writeFileSync(ticket, JSON.stringify({ socketPath, token: 'fixture-secret', taskId: task.id, runId: 'run-a' }), { mode: 0o600 });
  const stop = await startCallbacks(socketPath, helper, engine);
  try {
    const refused = await spawnHelper(helper, ticket, { questionId: 'q-b', answer: 'Keep it.', reason: 'Cross-host.' }, ['answer']);
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.err, /Delegated answer host is not proven/);
    assert.equal(store.eventsAll('delegation:q-b').some(event => event.kind === 'delegated_answer'), false);
  } finally { await engine.stop(); await stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a released Paseo reviewer consult replaces the launch ticket; deleted tickets fall back to PASEO_AGENT_ID', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'paseo-retained-answer-')));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('hostRegistry', [{ id: 'host' }]);
  const socketPath = join(dir, 's'), helperPath = join(dir, 'worker-report.mjs');
  const adapter = {
    observe: observeIdle('ws', 'worker'),
    reportingViaMcp: true,
    helperPath,
    socketPath,
    askReviewer: async () => null,
  } as unknown as HostAdapter;
  const engine = new Engine(store, adapter, 0);
  engine.identifyOriginHost = async () => 'host';
  const task = store.insert(submissionSchema.parse({
    submissionId: 'paseo-retained-answer', title: 'Paseo retained answer', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', 'a'.repeat(40));
  const profile = { id: 'p', name: 'p', provider: 'synthetic', model: 'm', notes: '', available: true, problem: '', supportedThinking: [] } as Profile;
  const launchTicket = join(dir, 'tickets', 'run-review.json');
  mkdirSync(dirname(launchTicket), { recursive: true, mode: 0o700 });
  writeFileSync(launchTicket, JSON.stringify({ socketPath, token: 'stale-secret', taskId: task.id, runId: 'run-review' }), { mode: 0o600 });
  store.setCredential('run-review', 'stale-secret');
  putReleasedReviewer(store, store.task(task.id), 'paseo-reviewer', profile);
  assert.equal(existsSync(launchTicket), false);
  assert.deepEqual(resolveQuestionAnswerCaller({ NUCLEUS_TICKET: launchTicket, PASEO_AGENT_ID: 'paseo-reviewer' }, hostCallerIdentity),
    { source: 'host', hostKind: 'paseo', nativeAgentId: 'paseo-reviewer' });
  engine.resolution.openDelegatedQuestion(store.task(task.id), 'q-host', 'paseo-reviewer', 'Continue?', 60_000, 'reviewer', 'host');
  const hostReceipt = await engine.resolution.answerDelegatedQuestionFromHost(
    { questionId: 'q-host', answer: 'Keep it.', reason: 'Host auth.' }, 'paseo-reviewer');
  assert.equal(hostReceipt.answer, 'Keep it.');
  const plannerConsult = engine.resolution.delegatePrompt(store.task(task.id), 'q-planner', 'Continue?', 'project-planner');
  assert.match(plannerConsult, /NUCLEUS_TICKET= nucleus question.answer -/);
  assert.equal(plannerConsult.includes(`NUCLEUS_TICKET='`), false);
  const stop = await startCallbacks(socketPath, helperPath, engine);
  try {
    writeFileSync(launchTicket, JSON.stringify({ socketPath, token: 'stale-secret', taskId: task.id, runId: 'run-review' }), { mode: 0o600 });
    engine.resolution.openDelegatedQuestion(store.task(task.id), 'q-revoked', 'paseo-reviewer', 'Continue?', 60_000, 'reviewer', 'host');
    const revoked = await spawnCli({ NUCLEUS_TICKET: launchTicket }, {
      questionId: 'q-revoked', answer: 'Keep it.', reason: 'Stale ticket.',
    });
    assert.notEqual(revoked.code, 0, revoked.out);
    assert.match(revoked.err, /Unauthorized callback/);
    assert.equal(store.eventsAll('delegation:q-revoked').some(event => event.kind === 'delegated_answer'), false);
    engine.resolution.openDelegatedQuestion(store.task(task.id), 'q-cli', 'paseo-reviewer', 'Continue?', 60_000, 'reviewer', 'host');
    const consult = engine.resolution.delegatePrompt(store.task(task.id), 'q-cli', 'Continue?', 'paseo-reviewer');
    assert.ok(consult.includes(`NUCLEUS_TICKET=${quote(launchTicket)} nucleus question.answer -`));
    assert.equal(consult.includes('On a host without per-thread MCP'), false);
    assert.ok(existsSync(launchTicket));
    const accepted = await spawnCli({ NUCLEUS_TICKET: launchTicket }, {
      questionId: 'q-cli', answer: 'Keep the Paseo approach.', reason: 'Within the brief.',
    });
    assert.equal(accepted.code, 0, accepted.err);
    const receipt = JSON.parse(accepted.out) as { answer?: string };
    assert.equal(receipt.answer, 'Keep the Paseo approach.');
  } finally { await engine.stop(); await stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('consult tickets select the recipient by proven host and native identity', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'consult-ticket-host-')));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('hostRegistry', [{ id: 'host-t3' }, { id: 'host-paseo' }]);
  const socketPath = join(dir, 's'), helperPath = join(dir, 'worker-report.mjs');
  const adapter = {
    observe: observeIdle('ws', 'worker'),
    reportingViaMcp: true,
    helperPath,
    socketPath,
    askReviewer: async () => null,
  } as unknown as HostAdapter;
  const engine = new Engine(store, adapter, 0);
  engine.identifyOriginHost = async () => 'host-paseo';
  const task = store.insert(submissionSchema.parse({
    submissionId: 'consult-ticket-host', title: 'Consult ticket host', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host-t3', 'handoff', 'a'.repeat(40));
  const profile = { id: 'p', name: 'p', provider: 'synthetic', model: 'm', notes: '', available: true, problem: '', supportedThinking: [] } as Profile;
  store.putRun({
    id: 'run-worker', taskId: task.id, role: 'revision', generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40),
    agentId: 'shared-native', workspaceId: 'ws', profile, status: 'running',
    createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null,
    completion: null, released: false,
  } as Run);
  store.setCredential('run-worker', 'worker-secret');
  const workerTicket = join(dir, 'tickets', 'run-worker.json');
  mkdirSync(dirname(workerTicket), { recursive: true, mode: 0o700 });
  writeFileSync(workerTicket, JSON.stringify({ socketPath, token: 'worker-secret', taskId: task.id, runId: 'run-worker' }), { mode: 0o600 });
  engine.resolution.openDelegatedQuestion(store.task(task.id), 'q-planner', 'shared-native', 'Continue?', 60_000, 'planner', 'host-paseo');
  const plannerConsult = engine.resolution.delegatePrompt(store.task(task.id), 'q-planner', 'Continue?', 'shared-native', 'host-paseo');
  assert.match(plannerConsult, /NUCLEUS_TICKET= nucleus question.answer -/);
  assert.equal(plannerConsult.includes(`NUCLEUS_TICKET='`), false);
  assert.equal(plannerConsult.includes(workerTicket), false);
  assert.doesNotThrow(() => store.authenticate('run-worker', 'worker-secret'));
  assert.equal(JSON.parse(readFileSync(workerTicket, 'utf8')).token, 'worker-secret');
  const hostReceipt = await engine.resolution.answerDelegatedQuestionFromHost(
    { questionId: 'q-planner', answer: 'Keep the planner ruling.', reason: 'Host auth.' }, 'shared-native');
  assert.equal(hostReceipt.answer, 'Keep the planner ruling.');
  engine.resolution.openDelegatedQuestion(store.task(task.id), 'q-worker-ticket', 'shared-native', 'Continue?', 60_000, 'planner', 'host-paseo');
  const stop = await startCallbacks(socketPath, helperPath, engine);
  try {
    const refused = await spawnCli({ NUCLEUS_TICKET: workerTicket }, {
      questionId: 'q-worker-ticket', answer: 'Keep it.', reason: 'Wrong host ticket.',
    });
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.err, /Delegated answer host is not proven/);
    assert.equal(store.eventsAll('delegation:q-worker-ticket').some(event => event.kind === 'delegated_answer'), false);
    engine.resolution.openDelegatedQuestion(store.task(task.id), 'q-same-host', 'shared-native', 'Continue?', 60_000, 'reviewer', 'host-t3');
    const sameHost = engine.resolution.delegatePrompt(store.task(task.id), 'q-same-host', 'Continue?', 'shared-native', 'host-t3');
    assert.ok(sameHost.includes(`NUCLEUS_TICKET=${quote(workerTicket)} nucleus question.answer -`));
    assert.throws(() => store.authenticate('run-worker', 'worker-secret'), /Unauthorized callback/);
    const accepted = await spawnCli({ NUCLEUS_TICKET: workerTicket }, {
      questionId: 'q-same-host', answer: 'Keep the T3 worker approach.', reason: 'Same host consult.',
    });
    assert.equal(accepted.code, 0, accepted.err);
    const receipt = JSON.parse(accepted.out) as { answer?: string };
    assert.equal(receipt.answer, 'Keep the T3 worker approach.');
  } finally { await engine.stop(); await stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/** A real Git fixture with the composed T3 adapter, for core-driven lifecycle proofs. */
async function ownerRetryFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 't3-owner-retry-')));
  const origin = join(root, 'origin.git'), primary = join(root, 'primary'), data = join(root, 'data');
  await command('git', ['init', '--bare', '--initial-branch=main', origin], root);
  await command('git', ['init', '--initial-branch=main', primary], root);
  await git(primary, 'config', 'user.name', 'Queue test');
  await git(primary, 'config', 'user.email', 'queue@example.invalid');
  await writeFileSync(join(primary, 'README.md'), 'base\n');
  await writeFileSync(join(primary, 'handoff.md'), '# handoff\n');
  await git(primary, 'add', '-A');
  await git(primary, 'commit', '-m', 'base');
  const base = await git(primary, 'rev-parse', 'HEAD');
  const server = await t3Fake(t, primary);
  server.projects.splice(0);
  mkdirSync(data, { recursive: true });
  const host = createHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', probeThreadId: 'synthetic-probe',
    statePath: join(data, 'hosts', 't3code.json'), timeoutMs: 2_000 });
  t.after(() => host.close());
  await host.connect();
  const adapter = createAdapter(Policy, host, { socketPath: join(data, 'callback.sock'), helperPath: join(data, 'worker-report.mjs') });
  const store = new Store(join(data, 'queue.sqlite'));
  const engine = new Engine(store, adapter, 0);
  const task = store.insert(submissionSchema.parse({
    submissionId: 't3-owner-retry', title: 'T3 owner retry', repoPath: primary, planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), host.hostId, '# handoff', base);
  await adapter.populateTaskWorktree(store.task(task.id));
  store.update(task.id, { phase: 'needs_attention', workspaceIntent: true, reason: 'Host delivery is unknown; command was not resent; command project.create' });
  // The trial machine's wedged intent: an unknown project.create recorded on the
  // retired dispatch route, with the same deterministic IDs this adapter derives.
  const repositoryRoot = realpathSync(primary);
  const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 40);
  const projectId = `nucleus-project-${digest(canonical([host.hostId, repositoryRoot]))}`;
  const commandId = `nucleus-project-create-${digest(canonical([host.hostId, repositoryRoot]))}`;
  return { root, data, server, host, adapter, store, engine, task, repositoryRoot, projectId, commandId,
    close: async () => { await engine.stop(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

const retryWorkspaceCreation = (f: Awaited<ReturnType<typeof ownerRetryFixture>>) => f.engine.performTaskControl(taskControlInputSchema.parse({
  action: 'retry_effect', taskId: f.task.id, version: f.store.task(f.task.id).version,
  effect: 'workspace_creation', reason: 'Prove the owner retry reaches the T3 wire',
}));

test('the owner retry verb resends a lost old-route project registration once through core', async t => {
  const f = await ownerRetryFixture(t);
  try {
    const legacyPayload = canonical({ method: 'orchestration.dispatchCommand',
      payload: { type: 'project.create', commandId: f.commandId, projectId: f.projectId, title: basename(f.repositoryRoot), workspaceRoot: f.repositoryRoot } });
    f.host.state.update(state => { state.intents[f.commandId] = { payload: legacyPayload, status: 'unknown', diagnostic: { command: 'project.create' } }; });
    const retried = await retryWorkspaceCreation(f);
    assert.equal(retried.phase, 'queued', 'the replayed create returned the task to dispatch');
    const mutations = f.server.commands.filter(command => command.method === 'projects.mutate');
    assert.equal(mutations.length, 1, 'the owner retry resends the recorded create exactly once');
    assert.equal(mutations[0]!.commandId, f.commandId, 'the resend keeps the recorded command id');
    assert.equal(mutations[0]!.projectId, f.projectId, 'the resend keeps the recorded project id');
    assert.equal(mutations[0]!.workspaceRoot, f.repositoryRoot);
    assert.equal(f.server.commands.filter(command => command.method === 'orchestration.dispatchCommand').length, 0,
      'the retired dispatch route carries nothing');
    assert.equal(f.server.projects.length, 1, 'the root is registered once, never duplicated');
    const bound = f.store.task(f.task.id);
    assert.equal(bound.workspaceIntent, true);
    assert.match(bound.workspaceId ?? '', /^nucleus-worktree-[a-f0-9]{40}$/);
    assert.equal(f.host.state.read().intents[f.commandId]?.status, 'settled');
    assert.equal(Object.values(f.host.state.read().workspaces)[0]?.projectId, f.projectId);
  } finally { await f.close(); }
});

test('the owner retry verb adopts a project that landed from the lost create without resending', async t => {
  const f = await ownerRetryFixture(t);
  try {
    const legacyPayload = canonical({ method: 'orchestration.dispatchCommand',
      payload: { type: 'project.create', commandId: f.commandId, projectId: f.projectId, title: basename(f.repositoryRoot), workspaceRoot: f.repositoryRoot } });
    f.host.state.update(state => { state.intents[f.commandId] = { payload: legacyPayload, status: 'unknown', diagnostic: { command: 'project.create' } }; });
    // The lost attempt actually landed: the project exists at the repository root.
    f.server.projects.push({ id: f.projectId, title: basename(f.repositoryRoot), workspaceRoot: f.repositoryRoot });
    await retryWorkspaceCreation(f);
    assert.equal(f.server.commands.filter(command => command.method === 'projects.mutate').length, 0,
      'the inventory re-read adopts the landed project; nothing is resent');
    const bound = f.store.task(f.task.id);
    assert.match(bound.workspaceId ?? '', /^nucleus-worktree-[a-f0-9]{40}$/);
    assert.equal(Object.values(f.host.state.read().workspaces)[0]?.projectId, f.projectId);
    assert.equal(f.host.state.read().intents[f.commandId]?.status, 'unknown', 'an adopted create was never sent again');
  } finally { await f.close(); }
});
