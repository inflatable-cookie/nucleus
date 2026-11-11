import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { observeIdle } from './support/fakes';
import { createHost, createAdapter } from '../hosts/t3code';
import { t3Fake } from './support/t3code-fake';
import { questionRoute } from '../core/questions/question-route';
import { resolveIngressHost } from '../core/host/ingress-host';
import { workerPrompt, runPrompt } from '../core/dispatch/prompts';
import { workerAgentSpec, runTicketPath } from '../core/dispatch/agent-creation';
import { workerHelper, startCallbacks } from '../service/callbacks/callback';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { QueueRuntime } from '../service/runtime-owner';
import { assembleOwnerTaskNext } from '../core/verbs/task-next';
import { submissionSchema, summarizeTask, taskNextSchema, type Run, type Task } from '../shared/contracts';
import type { Adapter as HostAdapter } from '../core/host/adapter';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (ready: () => boolean, label = 'condition') => {
  for (let i = 0; i < 80 && !ready(); i++) await tick();
  assert.ok(ready(), label);
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

test('a T3 budget question lands on the board and notifies the project planner', async () => {
  const store = new Store(':memory:');
  store.setMeta('paused', false);
  store.setMeta('hostId', 't3code:synthetic-environment');
  const notices: Array<{ id: string; messageId: string; text: string }> = [];
  const adapter = {
    capabilities: () => ({ reportingViaMcp: false, supportsCoordinatorRecovery: false, nativeDecisions: false, uiContributions: false, lifecycleDispatch: true, perThreadEnvironment: false }),
    reportingViaMcp: false,
    observe: observeIdle('ws', 'worker'),
    originAgent: async (id: string) => id === 'planner' ? { id, archived: false, workspaceId: 'planner-ws', title: 'Planner' } : null,
    notify: async (id: string, messageId: string, text: string) => { notices.push({ id, messageId, text }); },
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
    await settle(() => notices.length === 1, 'planner notice');
    assert.equal(notices[0]!.id, 'planner');
    assert.match(notices[0]!.messageId, /^ns-queue-question-/);
    assert.match(notices[0]!.text, /cannot take a native question/);
    assert.ok(store.eventsAll(task.id).some(event => event.kind === 'operator_question_planner_notice'));
    assert.equal(store.eventsAll(task.id).some(event => event.kind === 'queue_ask_delivery'), false, 'T3 does not prompt the worker to call nucleus_ask');
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
  const native = createAdapter(host);
  assert.equal(native.capabilities().lifecycleDispatch, true);
  assert.equal(native.reportingViaMcp, false);
  assert.throws(() => native.createAgent({} as never, 'unused', 'unused'), /helper path/);
  const wired = createAdapter(host, { socketPath: join(directory, 'callback.sock'), helperPath: join(directory, 'worker-report.mjs') });
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
