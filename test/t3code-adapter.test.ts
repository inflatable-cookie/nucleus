import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3CodeHost } from '../hosts/t3code/adapter';
import { ProvenPreSendRefusalError, HostUnknownDeliveryError } from '../core/host';
import { isTransportFailure } from '../shared/transport';
import type { HostAgentSpec } from '../shared/host';
import type { Profile, Task } from '../shared/contracts';
import { taskWorkspaceTitle } from '../core/workspaces/workspace-title';
import { capPaseoTitle } from '../shared/paseo-title';
import { WIRE_LABEL_KEYS, WIRE_PLUGIN_LABEL_KEY, wireLabels } from '../shared/wire-labels';
import { t3Fake, STAMP, threadProjection } from './support/t3code-fake';

const profile: Profile = { id: 'synthetic-profile', name: 'Synthetic', provider: 'synthetic-provider', model: 'synthetic-model',
  available: true, problem: '', notes: '', supportedThinking: [] };
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 't3code-adapter-'));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  const options = { endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath: join(root, 'state.json'), timeoutMs: 1_000, probeThreadId: 'synthetic-probe' };
  const host = new T3CodeHost(options);
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace-intent', directory, project: { projectId: 'synthetic-project' } });
  const spec = (requestId = 'launch-intent', prompt = 'Synthetic prompt', role = 'worker'): HostAgentSpec => ({ workspaceId: workspace.id, profile, title: role === 'worker' ? 'Synthetic role' : `${role}: Synthetic role`, taskNumber: 225, mcpBindingPath: null,
    attempt: () => ({ requestId, prompt, labels: wireLabels({ task: 'synthetic-task', run: role === 'worker' ? 'worker-run' : `${role}-run`, ...(role === 'worker' ? {} : { role }) }), environment: {} }) });
  return { root, directory, server, options, host, workspace, spec };
}

test('connect accepts an unseen nightly on structural probes, records its version and preserves capabilities', async t => {
  const { host, server } = await fixture(t);
  assert.equal(host.hostId, 't3code:synthetic-environment');
  assert.equal(host.version, server.controls.version);
  assert.equal(host.state.read().lastPassedVersion, server.controls.version);
  assert.equal(host.connected, true);
  assert.deepEqual(host.capabilities(), { reportingViaMcp: false, supportsCoordinatorRecovery: false, nativeDecisions: false, uiContributions: false, lifecycleDispatch: false, perThreadEnvironment: false });
  assert.equal(server.commands.length, 0, 'compatibility probe is read-only');
  const providers = (await host.catalog()).providers;
  assert.equal(providers[0]?.key, 'synthetic-provider');
});

test('create uses an existing canonical worktree and explicit top-level provider/model/prompt identities', async t => {
  const { host, server, workspace, directory, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const command = server.commands[0]!;
  assert.equal(command.method, 'orchestration.launchThread');
  assert.equal(command.threadId, created.id);
  assert.equal(command.projectId, 'synthetic-project');
  assert.deepEqual(command.modelSelection, { instanceId: 'synthetic-provider', model: 'synthetic-model' });
  assert.deepEqual(command.workspaceStrategy, { type: 'existing_worktree', worktreePath: directory });
  assert.equal(command.initialMessage.text, 'Synthetic prompt');
  assert.equal(command.title, '225: Synthetic role');
  assert.equal(command.initialMessage.attachments.length, 0);
  // A profile with no mode launches in T3's own default runtime mode, so an
  // unattended thread never stops at every approval prompt (nucleus#1143).
  assert.equal(command.runtimeMode, 'full-access');
  assert.equal((await host.observe(created.id)).modeId, 'full-access');
  assert.equal(created.workspaceId, workspace.id);
  for (const field of ['parentThreadId', 'parentRunId', 'delegatedFrom', 'environment', 'mcpServers']) assert.equal(Object.hasOwn(command, field), false, field);
  assert.equal((await host.observe(created.id)).workspaceId, workspace.id);
  assert.deepEqual(await host.findAgents({ [WIRE_LABEL_KEYS.task]: 'synthetic-task' }), [created]);
});

test('new T3 worker, reviewer and recovery threads use task number and role titles', async t => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec('worker-title', 'Worker', 'worker'));
  await host.createAgent(spec('review-title', 'Review', 'reviewer'));
  await host.createAgent(spec('recovery-title', 'Recovery', 'recovery'));
  assert.deepEqual(server.commands.filter(command => command.method === 'orchestration.launchThread').map(command => command.title), [
    '225: Synthetic role', '225 review: Synthetic role', '225 recovery: Synthetic role',
  ]);
});

test('real stored label keys locate a role-less worker and repair existing support titles', async t => {
  const { host, server, spec } = await fixture(t);
  const worker = await host.createAgent(spec('worker-run', 'Worker'));
  const reviewer = await host.createAgent(spec('reviewer-run', 'Review', 'reviewer'));
  const workerLabels = host.state.read().agents[worker.id]!.labels;
  assert.deepEqual(workerLabels, { [WIRE_PLUGIN_LABEL_KEY]: 'nucleus', [WIRE_LABEL_KEYS.task]: 'synthetic-task', [WIRE_LABEL_KEYS.run]: 'worker-run' });
  assert.equal(workerLabels[WIRE_LABEL_KEYS.role], undefined, 'the worker label shape omits nucleus.role');
  assert.ok(Object.keys(host.state.read().agents[reviewer.id]!.labels).every(key =>
    key === WIRE_PLUGIN_LABEL_KEY || Object.values(WIRE_LABEL_KEYS).includes(key as typeof WIRE_LABEL_KEYS[keyof typeof WIRE_LABEL_KEYS])),
  'every created fixture uses the shared wire label keys');

  server.threads.get(reviewer.id)!.thread.title = 'reviewer: Synthetic role';
  const task = { id: 'synthetic-task', number: 225, title: 'Synthetic role', held: false, hostId: host.hostId,
    workspaceId: worker.workspaceId, runId: 'worker-run', phase: 'working' } as Task;
  const title = taskWorkspaceTitle(task);
  await host.setTaskWorkspaceTitle(task, title, 'real-label-title', false);
  assert.deepEqual(server.commands.filter(command => command.type === 'thread.metadata.update').map(command => [command.threadId, command.title]), [
    [worker.id, title], [reviewer.id, '225 review: Synthetic role'],
  ]);
});

test('worker thread titles use the shared task state title once per change', async t => {
  const { host, server, options, spec } = await fixture(t);
  const created = await host.createAgent(spec('rename-title'));
  const task = { id: 'synthetic-task', number: 225, title: 'Synthetic role', held: false, hostId: host.hostId,
    workspaceId: created.workspaceId, agentId: created.id, phase: 'working' } as Task;
  const states = ['working', 'awaiting_review', 'merging', 'working', 'awaiting_review', 'working'] as const;
  const titles = states.map(phase => taskWorkspaceTitle({ ...task, phase }));
  for (const [index, phase] of states.entries())
    await host.setTaskWorkspaceTitle({ ...task, phase }, titles[index]!, `request-${index + 1}`, false);
  await host.setTaskWorkspaceTitle(task, titles.at(-1)!, `request-${states.length}`, false);
  assert.deepEqual(server.commands.filter(command => command.type === 'thread.metadata.update').map(command => command.title), titles);
  const longTitle = taskWorkspaceTitle({ ...task, title: 'Long task '.repeat(100) });
  await host.setTaskWorkspaceTitle(task, longTitle, 'long-title', false);
  assert.equal(server.commands.filter(command => command.type === 'thread.metadata.update').at(-1)?.title, capPaseoTitle(longTitle));
});

test('an uncertain worker title write is read before retry and is not resent when already applied', async t => {
  const { host, server, options, spec } = await fixture(t);
  const created = await host.createAgent(spec('rename-title'));
  const task = { id: 'synthetic-task', number: 225, title: 'Synthetic role', held: false, hostId: host.hostId,
    workspaceId: created.workspaceId, agentId: created.id, phase: 'working' } as Task;
  const title = taskWorkspaceTitle(task);
  server.controls.disconnectAfterEffect = true;
  await assert.rejects(host.setTaskWorkspaceTitle(task, title, 'title-request', false));
  assert.equal(server.threads.get(created.id)!.thread.title, title, 'the server applied the title before the reply was lost');
  host.close();
  server.controls.disconnectAfterEffect = false;
  const reloaded = new T3CodeHost(options); t.after(() => reloaded.close());
  await reloaded.connect();
  await reloaded.setTaskWorkspaceTitle(task, title, 'title-request', true);
  assert.equal(server.commands.filter(command => command.type === 'thread.metadata.update').length, 1,
    'a read confirming the current title settles the unknown write without resending');
});

test('connect refuses incompatible protocol and missing probe coverage without a canary mutation', async t => {
  const { host, server, options } = await fixture(t);
  host.close(); server.controls.protocol = 3;
  const incompatible = new T3CodeHost(options); t.after(() => incompatible.close());
  await assert.rejects(incompatible.connect(), /orchestrationProtocolVersion/);
  assert.equal(incompatible.connected, false);
  server.controls.protocol = 2; server.controls.shellMissingField = 'activeRunId';
  const missingField = new T3CodeHost(options); t.after(() => missingField.close());
  await assert.rejects(missingField.connect(), /activeRunId/);
  server.controls.shellMissingField = ''; server.controls.threadCoverage = { hasMoreHistory: 'true' };
  const incompleteProbe = new T3CodeHost(options); t.after(() => incompleteProbe.close());
  await assert.rejects(incompleteProbe.connect(), /hasMoreHistory/);
  assert.equal(incompleteProbe.connected, false);
  server.controls.threadCoverage = {}; server.threads.clear();
  const empty = new T3CodeHost({ ...options, probeThreadId: undefined }); t.after(() => empty.close());
  await empty.connect();
  assert.equal(empty.connected, true);
  assert.equal(empty.threadShapePending, true);
  assert.equal(server.commands.length, 0);
});

test('the first created thread is decoded and a mismatch refuses it and takes T3 offline', async t => {
  const { host, server, options, spec } = await fixture(t);
  host.close(); server.threads.clear();
  const empty = new T3CodeHost({ ...options, probeThreadId: undefined }); t.after(() => empty.close());
  await empty.connect();
  assert.equal(empty.threadShapePending, true);
  server.controls.threadCoverage = { hasMoreHistory: 'true' };
  await assert.rejects(empty.createAgent(spec()), /subscribeThread\.hasMoreHistory/);
  assert.equal(empty.connected, false);
  assert.match(empty.compatibilityFailure, /subscribeThread\.hasMoreHistory/);
});

test('the first created thread clears pending verification after a strict decode', async t => {
  const { host, server, options, spec } = await fixture(t);
  host.close(); server.threads.clear();
  const empty = new T3CodeHost({ ...options, probeThreadId: undefined }); t.after(() => empty.close());
  await empty.connect();
  assert.equal(empty.threadShapePending, true);
  await empty.createAgent(spec());
  assert.equal(empty.connected, true);
  assert.equal(empty.threadShapePending, false);
});

test('the first thread found in inventory is decoded before it is returned', async t => {
  const { host, server, options, directory } = await fixture(t);
  host.close(); server.threads.clear();
  const empty = new T3CodeHost({ ...options, probeThreadId: undefined }); t.after(() => empty.close());
  await empty.connect();
  server.threads.set('synthetic-observed', threadProjection('synthetic-observed', directory));
  server.controls.threadCoverage = { hasMoreHistory: 'true' };
  await assert.rejects(empty.listLiveAgents(), /subscribeThread\.hasMoreHistory/);
  assert.equal(empty.connected, false);
  assert.match(empty.compatibilityFailure, /subscribeThread\.hasMoreHistory/);
});

test('durable create replay survives reload and refuses changed payload or labels under the same intent', async t => {
  const { host, server, options, spec } = await fixture(t);
  const first = await host.createAgent(spec());
  assert.deepEqual(await host.createAgent(spec()), first);
  assert.equal(server.commands.length, 1);
  host.close();
  const reloaded = new T3CodeHost(options); t.after(() => reloaded.close());
  await reloaded.connect();
  assert.deepEqual(await reloaded.createAgent(spec()), first);
  assert.equal(server.commands.length, 1);
  await assert.rejects(reloaded.createAgent(spec('launch-intent', 'Changed prompt')), /payload changed/);
  const changed = spec(); changed.attempt = () => ({ requestId: 'launch-intent', prompt: 'Synthetic prompt', labels: wireLabels({ task: 'other-task', run: 'worker-run' }), environment: {} });
  await assert.rejects(reloaded.createAgent(changed), /retained identity changed/);
  assert.equal(server.commands.length, 1);
});

test('follow-ups keep exact text and native target, with no resend after interrupted delivery', async t => {
  const { host, server, options, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  await host.sendMessage(created.id, { messageId: 'follow-up', text: 'Exact follow-up\nsecond line' });
  await host.sendMessage(created.id, { messageId: 'follow-up', text: 'Exact follow-up\nsecond line' });
  assert.equal(server.commands.length, 2);
  assert.equal(server.commands[1]!.threadId, created.id);
  assert.equal(server.commands[1]!.text, 'Exact follow-up\nsecond line');
  await assert.rejects(host.sendMessage(created.id, { messageId: 'follow-up', text: 'Changed' }), /payload changed/);
  server.controls.disconnectMutation = true;
  await assert.rejects(host.sendMessage(created.id, { messageId: 'lost-follow-up', text: 'Uncertain' }));
  assert.equal(server.commands.length, 3);
  const reloaded = new T3CodeHost(options); t.after(() => reloaded.close());
  server.controls.disconnectMutation = false;
  await reloaded.connect();
  await assert.rejects(reloaded.sendMessage(created.id, { messageId: 'lost-follow-up', text: 'Uncertain' }), /unknown.*not resent/);
  assert.equal(server.commands.length, 3);
});

test('a reported support thread settles against the latest Nightly run', async t => {
  const { host, server } = await fixture(t);
  const projection = server.threads.get('synthetic-probe')!;
  projection.runs.push({ id: 'nightly-review-run', status: 'completed', startedAt: STAMP });
  await host.settleReportedThread('synthetic-probe', 'nucleus-review-run');
  const settle = server.commands.find(command => command.type === 'thread.settle')!;
  assert.equal(settle.method, 'orchestration.dispatchCommand');
  assert.equal(settle.threadId, 'synthetic-probe');
  assert.equal(settle.expectedLatestRunId, 'nightly-review-run');
  assert.equal(projection.thread.settledOverride, 'settled');
});

test('an uncertain settlement is checked against settledOverride before any resend', async t => {
  const { host, server, options } = await fixture(t);
  const projection = server.threads.get('synthetic-probe')!;
  projection.runs.push({ id: 'nightly-review-run', status: 'completed', startedAt: STAMP });
  server.controls.disconnectAfterEffect = true;
  await assert.rejects(host.settleReportedThread('synthetic-probe', 'nucleus-review-run'), HostUnknownDeliveryError);
  assert.equal(projection.thread.settledOverride, 'settled', 'the fake server applied the command before losing its reply');
  const count = server.commands.filter(command => command.type === 'thread.settle').length;
  host.close(); server.controls.disconnectAfterEffect = false;
  const reloaded = new T3CodeHost(options); t.after(() => reloaded.close()); await reloaded.connect();
  await reloaded.reconcileReportedSettlements();
  assert.equal(server.commands.filter(command => command.type === 'thread.settle').length, count, 'observed settlement prevents a resend');
  assert.equal(reloaded.state.read().intents[server.commands.find(command => command.type === 'thread.settle')!.commandId]?.status, 'settled');
});

test('an unknown worker handover settle is never resent by either reconciler', async t => {
  const { host, server, options } = await fixture(t);
  const projection = server.threads.get('synthetic-probe')!;
  projection.runs.push({ id: 'nightly-worker-run', status: 'completed', startedAt: STAMP });
  // The socket dies before the command is applied: the delivery is unknown, and
  // nothing may turn that one unknown mutation into a second (nucleus#1154).
  server.controls.disconnectMutation = true;
  await assert.rejects(host.settleWorkerThread('synthetic-probe', 'nucleus-worker-run'), HostUnknownDeliveryError);
  assert.equal(projection.thread.settledOverride, null, 'the fake server never applied the settle');
  assert.equal(server.commands.filter(command => command.type === 'thread.settle').length, 1);

  host.close(); server.controls.disconnectMutation = false;
  const reloaded = new T3CodeHost(options); t.after(() => reloaded.close()); await reloaded.connect();
  const commandId = server.commands.find(command => command.type === 'thread.settle')!.commandId;
  assert.equal(reloaded.state.read().intents[commandId]?.status, 'unknown', 'the recorded intent stays unknown');
  await reloaded.reconcileSettledThreads();
  await reloaded.reconcileReportedSettlements();
  await assert.rejects(reloaded.settleWorkerThread('synthetic-probe', 'nucleus-worker-run'), HostUnknownDeliveryError,
    'the sweep can record the unresolved failure without authorizing a resend');
  assert.equal(server.commands.filter(command => command.type === 'thread.settle').length, 1, 'neither reconciler resends an unknown worker settle');
  assert.equal(projection.thread.settledOverride, null, 'the thread is not settled by a resent command');
  assert.equal(reloaded.state.read().intents[commandId]?.status, 'unknown');
});

test('a settled reviewer is explicitly unsettled before a later round message', async t => {
  const { host, server } = await fixture(t);
  const projection = server.threads.get('synthetic-probe')!;
  projection.runs.push({ id: 'nightly-review-run-1', status: 'completed', startedAt: STAMP });
  await host.settleReportedThread('synthetic-probe', 'nucleus-review-run-1');
  await host.sendMessage('synthetic-probe', { messageId: 'review-round-2', text: 'Please review the addressed finding.' });
  assert.equal(projection.thread.settledOverride, 'active');
  assert.deepEqual(server.commands.filter(command => command.threadId === 'synthetic-probe').map(command => command.type),
    ['thread.settle', 'thread.unsettle', 'message.dispatch']);
  projection.runs.push({ id: 'nightly-review-run-2', status: 'completed', startedAt: STAMP });
  await host.settleReportedThread('synthetic-probe', 'nucleus-review-run-2');
  const settlements = server.commands.filter(command => command.type === 'thread.settle');
  assert.equal(settlements.at(-1)!.expectedLatestRunId, 'nightly-review-run-2');
  assert.equal(projection.thread.settledOverride, 'settled');
});

test('decoder-formatted defects keep durable diagnostics while remaining unknown after reload', async t => {
  const { host, server, spec, options } = await fixture(t);
  const created = await host.createAgent(spec());
  server.controls.postEffectDefect = true;
  await assert.rejects(host.sendMessage(created.id, { messageId: 'schema-refusal', text: 'Synthetic' }), error => {
    assert.ok(error instanceof HostUnknownDeliveryError);
    assert.deepEqual(error.diagnostic, { command: 'message.dispatch', reason: 'schema_missing_key' });
    return true;
  });
  assert.equal(host.state.read().intents['schema-refusal']?.status, 'unknown');
  assert.deepEqual(host.state.read().intents['schema-refusal']?.diagnostic, { command: 'message.dispatch', reason: 'schema_missing_key' });
  assert.ok(server.threads.get(created.id)!.messages.some((message: { text: string }) => message.text === 'Synthetic'), 'handler performed the effect before the identical defect');
  const sent = server.commands.length;
  server.controls.postEffectDefect = false;
  host.close();
  const reloaded = new T3CodeHost(options); t.after(() => reloaded.close()); await reloaded.connect();
  await assert.rejects(reloaded.sendMessage(created.id, { messageId: 'schema-refusal', text: 'Synthetic' }), error => {
    assert.ok(error instanceof HostUnknownDeliveryError);
    assert.deepEqual(error.diagnostic, { command: 'message.dispatch', reason: 'schema_missing_key' });
    assert.match(error.message, /unknown.*not resent.*message.dispatch/);
    return true;
  });
  assert.equal(server.commands.length, sent);
});

test('decoder defects carrying secrets keep neither the value nor the bearer in durable diagnostics', async t => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  server.controls.secretDefect = true;
  // A secret in the decoder's expected-shape position canonicalizes to fixed
  // wording; no location text survives beside it.
  await assert.rejects(host.sendMessage(created.id, { messageId: 'secret-defect', text: 'Synthetic' }), error => {
    assert.ok(error instanceof HostUnknownDeliveryError);
    assert.deepEqual(error.diagnostic, { command: 'message.dispatch', reason: 'schema_expected' });
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /synthetic-secret/);
    return true;
  });
  assert.equal(host.state.read().intents['secret-defect']?.status, 'unknown');
  const durable = JSON.stringify(host.state.read().intents['secret-defect']);
  assert.doesNotMatch(durable, /synthetic-secret/);
  // A location that names one of our own payload fields is still remote-chosen
  // text: nothing is retained, through the durable intent and the attention.
  server.controls.secretDefect = false;
  server.controls.secretLocationDefect = true;
  await assert.rejects(host.sendMessage(created.id, { messageId: 'secret-location', text: 'Synthetic' }), error => {
    assert.ok(error instanceof HostUnknownDeliveryError);
    const diagnostic = (error as HostUnknownDeliveryError).diagnostic;
    assert.deepEqual(diagnostic, { command: 'message.dispatch', reason: 'schema_missing_key' });
    assert.equal('field' in diagnostic, false, 'no location is named, even a known field name');
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /synthetic_secret/);
    return true;
  });
  const durableLocation = JSON.stringify(host.state.read().intents['secret-location']);
  assert.equal(host.state.read().intents['secret-location']?.status, 'unknown');
  assert.doesNotMatch(durableLocation, /synthetic_secret/);
  assert.equal(durableLocation.includes('"field"'), false, 'the durable intent carries no location');
});

test('observations distinguish idle, active run, permissions, archived and explicit deletion', async t => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  assert.equal((await host.observe(created.id)).active, false);
  p.runs = [{ id: 'synthetic-run', status: 'running', startedAt: STAMP }];
  assert.equal((await host.observe(created.id)).activeTurnId, 'synthetic-run');
  assert.equal((await host.observe(created.id)).active, true);
  p.runtimeRequests = [{ id: 'approval', kind: 'command', status: 'pending', responseCapability: { type: 'live', providerSessionId: 'session' } }];
  const pending = await host.observe(created.id);
  assert.equal(pending.permissions, true); assert.equal(pending.pendingRequest?.id, 'approval');
  await host.stopAgentTurn(created.id);
  assert.equal((await host.observe(created.id)).active, false);
  await host.archiveAgent(created.id);
  const archivedCommands = server.commands.length;
  await host.archiveAgent(created.id);
  assert.equal(server.commands.length, archivedCommands);
  // An archived thread is retired: terminal closed status, with the archived
  // fact on its own field.
  const retired = await host.observe(created.id);
  assert.equal(retired.status, 'closed');
  assert.equal(retired.archived, true);
  assert.ok(server.requests.some(r => r.tag === 'orchestration.getArchivedShellSnapshot'));
  assert.equal((await host.listLiveAgents()).some(r => r.id === created.id), false);
  p.thread.deletedAt = STAMP;
  assert.equal((await host.observe(created.id)).status, 'gone');
  await assert.rejects(host.observe('absent-thread'));
  assert.equal(await host.observationInventory(['absent-thread']), null);
});

test('empty enrichment snapshots preserve inventory while missing fields and incomplete reads stay unknown', async t => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  server.controls.enrichment = true;
  assert.ok((await host.listLiveAgents()).some(r => r.id === created.id));
  server.controls.shellMissingField = 'activeRunId';
  await assert.rejects(host.observe(created.id), /activeRunId/);
  assert.equal(await host.observationInventory([created.id]), null);
  server.controls.shellMissingField = '';
  server.controls.incompleteThread = true;
  await assert.rejects(host.observe(created.id), /incomplete projection/);
  assert.equal(await host.agentTimelinePage(created.id), null);
  server.controls.incompleteThread = false;
  server.controls.synchronized = false;
  await assert.rejects(host.observe(created.id), /timeout/);
  assert.equal(host.connected, false);
});

test('coverage fields are strictly decoded before observation or timeline completeness is claimed', async t => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  for (const [field, value] of [
    ['hasMoreHistory', 'true'], ['hasMoreHistory', 0], ['hasMoreHistory', null],
    ['turnItemsOmitLocalVisible', 'false'], ['historyCursor', 7],
    ['latestLocalTurnOrdinal', '1'], ['idTable', false],
  ] as const) {
    server.controls.threadCoverage = { [field]: value };
    await assert.rejects(host.observe(created.id), new RegExp(field));
    assert.equal(await host.agentTimelinePage(created.id), null);
    assert.equal(await host.observationInventory([created.id]), null);
  }
  server.controls.threadCoverage = { hasMoreHistory: false, historyCursor: 'opaque-history-cursor' };
  await assert.rejects(host.observe(created.id), /incomplete projection/);
  server.controls.threadCoverage = { hasMoreHistory: false, historyCursor: null, turnItemsOmitLocalVisible: false };
  assert.equal((await host.observe(created.id)).active, false);
});

test('inventory repeats moving live/archive snapshot pairs and succeeds when the sequence settles', async t => {
  const { host, server, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  let movingReads = 0;
  server.controls.beforeArchiveRead = () => {
    if (movingReads++ < 2) server.controls.snapshotSequence++;
  };
  assert.ok((await host.listLiveAgents()).some(agent => agent.id === created.id));
  assert.equal(movingReads, 3, 'two mismatched pairs are followed by the consistent third pair');
  assert.ok((await host.listLiveAgents()).some(agent => agent.id === created.id));
  assert.ok((await host.activeThreads()).some(agent => agent.id === created.id));
});

test('inventory refuses an unstable snapshot after the bounded number of read pairs', async t => {
  const { host, server } = await fixture(t);
  const shellReads = server.requests.filter(request => request.tag === 'orchestration.subscribeShell').length;
  const archiveReads = server.requests.filter(request => request.tag === 'orchestration.getArchivedShellSnapshot').length;
  server.controls.beforeArchiveRead = () => { server.controls.snapshotSequence++; };
  await assert.rejects(host.listLiveAgents(), /inventory kept moving.*5 attempts/);
  assert.equal(server.requests.filter(request => request.tag === 'orchestration.subscribeShell').length - shellReads, 5);
  assert.equal(server.requests.filter(request => request.tag === 'orchestration.getArchivedShellSnapshot').length - archiveReads, 5);
});

test('questions and approvals answer exact runtime requests and refuse wrong kinds or workspaces', async t => {
  const { host, server, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  p.runtimeRequests = [{ id: 'question-request', kind: 'user_input', status: 'pending', responseCapability: { type: 'live', providerSessionId: 'session' } },
    { id: 'approval-request', kind: 'command', status: 'pending', responseCapability: { type: 'live', providerSessionId: 'session' } }];
  p.turnItems = [{ id: 'question-item', type: 'user_input_request', requestId: 'question-request', questions: [{ id: 'choice', header: 'Choice', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] }];
  assert.deepEqual(await host.pendingQuestions(created.id), [{ requestId: 'question-request', questions: [{ header: 'Choice', question: 'Pick one', options: ['A', 'B'] }] }]);
  await assert.rejects(host.respondRuntimeRequest(created.id, workspace.id, 'question-request', { decision: 'accept' }, 'invalid-question-kind'), /kind/);
  await assert.rejects(host.respondRuntimeRequest(created.id, 'other-workspace', 'question-request', { answers: { choice: 'A' } }, 'invalid-question-workspace'), /workspace/);
  await host.answerNativeQuestion(created.id, workspace.id, 'question-request', { choice: 'A' });
  await host.respondRuntimeRequest(created.id, workspace.id, 'approval-request', { decision: 'accept' });
  const responses = server.commands.filter(command => command.type === 'runtime-request.respond');
  assert.equal(responses.length, 2);
  assert.equal(responses[0]!.requestId, 'question-request');
  assert.deepEqual(responses[0]!.answers, { choice: ['A'] });
  assert.equal(responses[1]!.requestId, 'approval-request');
  assert.equal(responses[1]!.decision, 'accept');
  assert.equal((await host.answeredQuestions(created.id))[0]?.requestId, 'question-request');
  p.runtimeRequests.push({ id: 'unknown-request', kind: 'future-request-kind', status: 'pending', responseCapability: { type: 'live', providerSessionId: 'session' } });
  await assert.rejects(host.respondRuntimeRequest(created.id, workspace.id, 'unknown-request', { decision: 'accept' }), /unsupported/);
});

test('question answer and dismissal inspect an uncertain original response before native status or a new intent', async t => {
  const { host, server, options, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  p.runtimeRequests = [{ id: 'lost-question', kind: 'user_input', status: 'pending', responseCapability: { type: 'live', providerSessionId: 'session' } }];
  p.turnItems = [{ id: 'question-item', type: 'user_input_request', requestId: 'lost-question', questions: [{ id: 'choice', header: 'Choice', question: 'Pick one', options: [{ label: 'A' }] }] }];
  server.controls.disconnectAfterEffect = true;
  await assert.rejects(host.answerNativeQuestion(created.id, workspace.id, 'lost-question', { Choice: 'A' }));
  assert.equal(p.runtimeRequests[0].status, 'resolved');
  server.controls.disconnectAfterEffect = false;
  host.close(); const reloaded = new T3CodeHost(options); t.after(() => reloaded.close()); await reloaded.connect();
  const reads = server.requests.length, writes = server.commands.length;
  const unknown = (error: unknown) => { assert.ok(error instanceof Error); assert.equal(error instanceof ProvenPreSendRefusalError, false); assert.match(error.message, /unknown.*not resent/); return true; };
  await assert.rejects(reloaded.answerNativeQuestion(created.id, workspace.id, 'lost-question', { Choice: 'A' }), unknown);
  await assert.rejects(reloaded.dismissNativeQuestion(created.id, workspace.id, 'lost-question'), unknown);
  await assert.rejects(reloaded.respondRuntimeRequest(created.id, workspace.id, 'lost-question', { answers: { choice: ['B'] } }, 'replacement-question-intent'), unknown);
  assert.equal(server.requests.length, reads);
  assert.equal(server.commands.length, writes);
});

test('restart preserves message-answerable questions and refuses expired approvals without an extra message', async t => {
  const { host, server, options, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  p.runtimeRequests = [{ id: 'restart-question', kind: 'user_input', status: 'pending', responseCapability: { type: 'message' } },
    { id: 'expired-approval', kind: 'command', status: 'expired', responseCapability: { type: 'not_resumable', reason: 'Server restarted' } }];
  p.turnItems = [{ id: 'question-item', type: 'user_input_request', requestId: 'restart-question', questions: [{ id: 'choice', header: 'Choice', question: 'Pick one', options: [{ label: 'A' }] }] }];
  host.close(); const reloaded = new T3CodeHost(options); t.after(() => reloaded.close()); await reloaded.connect();
  await reloaded.answerNativeQuestion(created.id, workspace.id, 'restart-question', { choice: 'A' });
  await assert.rejects(reloaded.respondRuntimeRequest(created.id, workspace.id, 'expired-approval', { decision: 'accept' }), /no longer answerable/);
  assert.equal(server.commands.filter(command => command.type === 'runtime-request.respond').length, 1);
  assert.equal(server.commands.filter(command => command.type === 'message.dispatch').length, 0);
});

test('creation evaluates its launch guard before building the attempt', async t => {
  const { host, server, spec } = await fixture(t);
  const guarded = spec();
  guarded.guard = { async allowed() { return false; }, stillAllowed() { assert.fail('guard already refused'); } };
  guarded.attempt = () => assert.fail('a refused guard must not build an attempt');
  await assert.rejects(host.createAgent(guarded), /launch guard refused/);
  assert.equal(server.commands.length, 0);
});

test('guarded sends preserve final synchronous fences and block changed guards before any write', async t => {
  const { host, server, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const order: string[] = [];
  server.controls.mutationObserver = () => { order.push('native'); };
  const input = { messageId: 'guarded', text: 'Guarded message', expectedWorkspaceId: workspace.id };
  assert.deepEqual(await host.sendGuarded(created.id, input, {
    async allowed() { await Promise.resolve(); order.push('allowed'); return true; },
    stillAllowed() { order.push('stillAllowed'); return true; }, beforeSend() { order.push('beforeSend'); },
  }), { sent: true });
  assert.deepEqual(order, ['allowed', 'stillAllowed', 'beforeSend', 'native']);
  const count = server.commands.length;
  await assert.rejects(host.sendGuarded(created.id, { ...input, messageId: 'changed-guard' }, {
    async allowed() { return true; }, stillAllowed() { return false; },
  }), ProvenPreSendRefusalError);
  assert.equal(server.commands.length, count);
  assert.equal((await host.sendGuarded(created.id, { ...input, messageId: 'wrong-workspace', expectedWorkspaceId: 'foreign' }, {
    async allowed() { assert.fail('wrong workspace must refuse before allowed'); }, stillAllowed() { return true; },
  })).sent, false);
});

test('host identity conflicts and unsupported per-thread bindings refuse before mutation', async t => {
  const { host, server, options, workspace, spec, root } = await fixture(t);
  const mcp = spec(); mcp.mcpBindingPath = 'synthetic-binding';
  await assert.rejects(host.createAgent(mcp), /MCP reporting/);
  const environment = spec(); environment.attempt = () => ({ requestId: 'environment', prompt: 'Synthetic', labels: wireLabels({ task: 'synthetic-task', run: 'worker-run' }), environment: { SYNTHETIC: 'value' } });
  await assert.rejects(host.createAgent(environment), /launch environment/);
  const guarded = spec(); guarded.guard = { async allowed() { return true; }, stillAllowed() { return false; } };
  await assert.rejects(host.createAgent(guarded), /guard changed/);
  await assert.rejects(host.raiseDecision('synthetic-probe', workspace.id, { id: 'decision', question: 'Synthetic', options: [], signal: new AbortController().signal }), /decisions/);
  assert.equal(server.commands.length, 0);
  const absent = join(root, 'missing'); mkdirSync(absent);
  await assert.rejects(host.createWorkspace({ title: 'Unknown project', requestId: 'unknown', directory: absent, project: { projectId: 'absent-project' } }), error => {
    assert.match(String(error), /T3Code cannot create a project for/);
    assert.ok(String(error).includes(absent), 'the refusal names the repository path');
    assert.match(String(error), /add that folder as a project in T3Code, then restart the task/);
    return true;
  });
  host.close(); server.controls.environmentId = 'different-environment';
  const changed = new T3CodeHost(options); t.after(() => changed.close());
  await assert.rejects(changed.connect(), /environmentId changed/);
  assert.equal(changed.connected, false);
  assert.equal(server.commands.length, 0);
});

test('the origin read answers authoritative absence, and only an unread inventory is unknown', async t => {
  const { host, server, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  assert.deepEqual(await host.originAgent(created.id),
    { id: created.id, workspaceId: workspace.id, title: '225: Synthetic role', archived: false });
  // T3 has no such thread: a complete shell plus archive read proves absence, so
  // the lookup answers not-mine instead of throwing.
  assert.equal(await host.originAgent('native-id-t3-does-not-have'), null);
  // A projection that cannot be read completely proves nothing about the thread.
  server.controls.incompleteThread = true;
  await assert.rejects(host.originAgent(created.id), /incomplete projection/);
  server.controls.incompleteThread = false;
  // A read that cannot run at all is a failed read, never authoritatively absent.
  host.close();
  await assert.rejects(host.originAgent(created.id), /authenticated host connection/);
});

test('workspace creation registers a missing repository project once through the nightly projects.mutate route', async t => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, 'repository');
  const worktree = join(root, 'worktree');
  mkdirSync(repository); mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  assert.equal(project.workspaceRoot, await realpath(repository));
  const workspace = await host.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-create', directory: worktree, project });
  const creation = server.commands.find(command => command.method === 'projects.mutate');
  assert.ok(creation, 'projects.mutate carried the project.create mutation');
  assert.equal(creation!.type, 'project.create');
  for (const field of ['type', 'commandId', 'projectId', 'title', 'workspaceRoot']) assert.ok(Object.hasOwn(creation!, field), field);
  assert.equal(server.commands.filter(command => command.method === 'orchestration.dispatchCommand' && command.type === 'project.create').length, 0,
    'the nightly dispatch union has no project.create; registration never rides it');
  assert.equal(creation!.workspaceRoot, await realpath(repository));
  assert.equal(creation!.title, 'repository');
  assert.equal(server.projects.length, 1);
  assert.equal(server.projects[0]!.id, creation!.projectId);
  const workspaceRef = host.workspaceRef(workspace.id);
  assert.equal(await workspaceRef.refresh(), true);
  assert.equal(workspaceRef.current()?.projectId, creation!.projectId);
  await host.createWorkspace({ title: 'Retry', requestId: 'workspace-create-again', directory: worktree, project });
  assert.equal(server.commands.filter(command => command.method === 'projects.mutate').length, 1, 'the same root is not duplicated');
});

test('unknown project creation delivery is reconciled from inventory before retry', async t => {
  const { host, server, options, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, 'repository');
  const worktree = join(root, 'worktree');
  mkdirSync(repository); mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  server.controls.disconnectAfterEffect = true;
  await assert.rejects(host.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-lost', directory: worktree, project }), /unknown/i);
  assert.equal(server.commands.filter(command => command.method === 'projects.mutate').length, 1);
  host.close();
  server.controls.disconnectAfterEffect = false;
  const reloaded = new T3CodeHost(options); t.after(() => reloaded.close());
  await reloaded.connect();
  const workspace = await reloaded.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-lost', directory: worktree, project });
  const workspaceRef = reloaded.workspaceRef(workspace.id);
  await workspaceRef.refresh();
  assert.equal(workspaceRef.current()?.projectId, server.projects[0]!.id);
  assert.equal(server.commands.filter(command => command.method === 'projects.mutate').length, 1, 'inventory adoption avoids a second create');
});

test('a lost registration resends once with its recorded command id after the inventory re-read', async t => {
  const { host, server, options, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, 'repository');
  const worktree = join(root, 'worktree');
  mkdirSync(repository); mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  server.controls.disconnectMutation = true;
  await assert.rejects(host.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-lost', directory: worktree, project }));
  const lost = server.commands.filter(command => command.method === 'projects.mutate');
  assert.equal(lost.length, 1);
  assert.equal(server.projects.length, 0, 'the lost request created nothing');
  host.close();
  server.controls.disconnectMutation = false;
  const reloaded = new T3CodeHost(options); t.after(() => reloaded.close());
  await reloaded.connect();
  const workspace = await reloaded.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-lost', directory: worktree, project });
  assert.equal(workspace.directory, await realpath(worktree));
  const sent = server.commands.filter(command => command.method === 'projects.mutate');
  assert.equal(sent.length, 2, 'the re-read found no project, so the recorded create resent exactly once');
  assert.equal(sent[0]!.commandId, sent[1]!.commandId, 'the resend uses the recorded command id, so the receipt keeps it idempotent');
  assert.equal(sent[0]!.projectId, sent[1]!.projectId);
  assert.equal(server.projects.length, 1);
  assert.equal((await reloaded.workspaceRef(workspace.id).refresh()), true);
});

test('an unsupported registration method stays unknown delivery while naming the manual project setup', async t => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, 'repository');
  const worktree = join(root, 'worktree');
  mkdirSync(repository); mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  server.controls.unsupportedProjectCreate = true;
  await assert.rejects(host.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-unsupported', directory: worktree, project }), error => {
    assert.ok(error instanceof HostUnknownDeliveryError, 'remote unknown-method text is not a proven pre-send refusal');
    assert.ok(String(error).includes(project.workspaceRoot!));
    assert.match(String(error), /guidance T3Code cannot create a project for/);
    assert.match(String(error), /add that folder as a project in T3Code, then restart the task/);
    assert.match(String(error), /unknown.*not resent/);
    return true;
  });
  const key = Object.keys(host.state.read().intents).find(candidate => candidate.startsWith('nucleus-project-create-'))!;
  const intent = host.state.read().intents[key];
  assert.equal(intent?.status, 'unknown', 'the create is never marked refused on remote text');
  assert.equal(intent?.diagnostic?.reason, 'unknown_request_tag');
  assert.equal(intent?.diagnostic?.guidance, `T3Code cannot create a project for ${project.workspaceRoot}; add that folder as a project in T3Code, then restart the task`);
    // The unknown delivery still permits the owner path: the re-read finds
  // nothing, so the recorded create resends exactly once.
  await assert.rejects(host.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-unsupported', directory: worktree, project }), /unknown/i);
  assert.equal(server.commands.filter(command => command.method === 'projects.mutate').length, 2);
  assert.equal(server.projects.length, 0);
});

test('a long repository path keeps its complete identity while the reason and fix stay bounded', async t => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  // Two near-maximum path components put the repository root far past every
  // bounded budget.
  const deep = join(root, 'long'.repeat(50), 'path'.repeat(50), 'repository');
  mkdirSync(deep, { recursive: true });
  const worktree = join(root, 'worktree');
  mkdirSync(worktree);
  const project = await host.repositoryProject(deep);
  assert.ok(project.workspaceRoot && project.workspaceRoot.length > 420, 'the fixture path is longer than the reason cap');
  server.controls.unsupportedProjectCreate = true;
  await assert.rejects(host.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-long-path', directory: worktree, project }), error => {
    assert.ok(error instanceof HostUnknownDeliveryError);
    const diagnostic = (error as HostUnknownDeliveryError).diagnostic;
    assert.equal(diagnostic.reason, 'unknown_request_tag', 'the canonical remote reason is intact');
    assert.equal(diagnostic.guidance, `T3Code cannot create a project for ${project.workspaceRoot}; add that folder as a project in T3Code, then restart the task`, 'the manual fix carries the complete untruncated path');
    assert.match(String(error), /add that folder as a project in T3Code, then restart the task/);
    assert.ok(String(error).includes(project.workspaceRoot!), 'the attention text carries the full path');
    return true;
  });
});

test('a typed failure keeps its fixed wire message as the reason in the durable intent and attention detail', async t => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, 'repository');
  const worktree = join(root, 'worktree');
  mkdirSync(repository); mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  server.controls.projectMutationFailure = true;
  await assert.rejects(host.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-reason', directory: worktree, project }), error => {
    assert.ok(error instanceof HostUnknownDeliveryError);
    assert.deepEqual(error.diagnostic, { command: 'project.create', reason: 'ProjectMutationError:project_mutation_failed' });
    assert.match(error.message, /unknown.*not resent.*command project\.create.*reason ProjectMutationError:project_mutation_failed/);
    return true;
  });
  const key = Object.keys(host.state.read().intents).find(candidate => candidate.startsWith('nucleus-project-create-'))!;
  assert.equal(host.state.read().intents[key]?.status, 'unknown');
  assert.deepEqual(host.state.read().intents[key]?.diagnostic, { command: 'project.create', reason: 'ProjectMutationError:project_mutation_failed' });
  // The reason is diagnostic evidence only: the delivery stays unknown and is never resent.
  server.controls.projectMutationFailure = false;
  const sent = server.commands.filter(command => command.method === 'projects.mutate');
  assert.equal(sent.length, 1);
});

test('arbitrary typed-failure text retains only the tag, never its unquoted secrets', async t => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, 'repository');
  const worktree = join(root, 'worktree');
  mkdirSync(repository); mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  server.controls.projectMutationSecretFailure = true;
  await assert.rejects(host.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-secret', directory: worktree, project }), error => {
    assert.ok(error instanceof HostUnknownDeliveryError);
    assert.deepEqual(error.diagnostic, { command: 'project.create', reason: 'ProjectMutationError' });
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /api_key|synthetic-secret/);
    return true;
  });
  const key = Object.keys(host.state.read().intents).find(candidate => candidate.startsWith('nucleus-project-create-'))!;
  const durable = JSON.stringify(host.state.read().intents[key]);
  assert.equal(host.state.read().intents[key]?.status, 'unknown');
  assert.doesNotMatch(durable, /api_key|synthetic-secret/);
});

test('guidance preserves a repository path with repeated whitespace exactly', async t => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, 'my  repository');
  const worktree = join(root, 'worktree');
  mkdirSync(repository); mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  assert.ok(project.workspaceRoot && project.workspaceRoot.includes('  '), 'the fixture path carries repeated whitespace');
  server.controls.unsupportedProjectCreate = true;
  await assert.rejects(host.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-whitespace', directory: worktree, project }), error => {
    assert.ok(error instanceof HostUnknownDeliveryError);
    const guidance = (error as HostUnknownDeliveryError).diagnostic.guidance ?? '';
    assert.equal(guidance, `T3Code cannot create a project for ${project.workspaceRoot}; add that folder as a project in T3Code, then restart the task`,
      'the guidance preserves the local path exactly, whitespace included');
    assert.ok(String(error).includes(project.workspaceRoot!), 'the attention text carries the path byte-exactly');
    return true;
  });
});

test('the catalog reports each model\'s real option choices from server.getConfig', async t => {
  const { host } = await fixture(t);
  const [provider] = (await host.catalog()).providers;
  const model = provider!.models[0]!;
  // The nightly's reasoning select: every choice, the default from isDefault.
  assert.deepEqual(model.thinkingOptions, [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High', isDefault: true }]);
  assert.equal(model.defaultThinkingOptionId, 'high');
  assert.deepEqual(model.aliases, ['synthetic-alias']);
  const tier = model.features.find(f => f.id === 'serviceTier');
  assert.equal(tier?.type, 'select');
  assert.equal(tier?.type === 'select' && tier.value, 'standard');
  assert.ok(tier?.type === 'select' && tier.options.some(option => option.id === 'priority'));
  const verbose = model.features.find(f => f.id === 'verbose');
  assert.deepEqual(verbose, { type: 'toggle', id: 'verbose', label: 'Verbose', value: true });
});

test('a profile with a supported thinking level launches with the mapped modelSelection options', async t => {
  const { host, server, spec } = await fixture(t);
  const thinking: Profile = { ...profile, thinkingOptionId: 'high', supportedThinking: ['high'],
    featureValues: { serviceTier: 'priority', verbose: false } };
  await host.createAgent({ ...spec(), profile: thinking });
  const command = server.commands[0]!;
  assert.deepEqual(command.modelSelection, { instanceId: 'synthetic-provider', model: 'synthetic-model',
    options: [{ id: 'reasoningEffort', value: 'high' }, { id: 'serviceTier', value: 'priority' }, { id: 'verbose', value: false }] });
});

test('an unreported option value is refused before send with the option and value named', async t => {
  const { host, server, spec } = await fixture(t);
  const xhigh: Profile = { ...profile, thinkingOptionId: 'xhigh', supportedThinking: ['xhigh'] };
  await assert.rejects(host.createAgent({ ...spec('launch-xhigh'), profile: xhigh }),
    /T3Code model synthetic-model has no reasoningEffort "xhigh"/);
  const unknownChoice: Profile = { ...profile, featureValues: { serviceTier: 'ultra' } };
  await assert.rejects(host.createAgent({ ...spec('launch-tier'), profile: unknownChoice }),
    /T3Code model synthetic-model has no serviceTier "ultra"/);
  const unknownOption: Profile = { ...profile, featureValues: { contextWindow: 200000 } };
  await assert.rejects(host.createAgent({ ...spec('launch-window'), profile: unknownOption }),
    /T3Code model synthetic-model has no "contextWindow" option/);
  assert.equal(server.commands.length, 0, 'nothing was sent');
  assert.equal(Object.keys(host.state.read().intents).length, 0, 'no durable launch intent was recorded for a refusal');
});

test('workspace archive is the native project.update archived mutation, observed positively', async t => {
  const { host, server, workspace } = await fixture(t);
  assert.equal(await host.workspaceArchived(workspace.id), false);
  const ref = host.workspaceRef(workspace.id);
  await ref.refresh();
  assert.ok(ref.current());
  const result = await ref.archive('ns-archive-check');
  assert.equal(result.error, null);
  assert.ok(result.archivedAt);
  const command = server.commands.find(c => c.method === 'projects.mutate');
  assert.equal(command?.type, 'project.update');
  assert.equal(command?.archived, true);
  assert.equal(command?.projectId, 'synthetic-project');
  assert.equal(await host.workspaceArchived(workspace.id), true);
  assert.equal(await host.workspaceAvailable(workspace.id), false);
  await ref.refresh();
  assert.equal(ref.current(), null, 'an archived project is no longer a current registration');
  // The durable intent replays the settled outcome; no second mutation is sent.
  const again = await ref.archive('ns-archive-check');
  assert.equal(again.error, null);
  assert.equal(server.commands.filter(c => c.method === 'projects.mutate').length, 1);
});

test('createWorkspace reopens an archived project for its root instead of registering a second one', async t => {
  const { host, server, workspace, directory } = await fixture(t);
  await host.workspaceRef(workspace.id).archive('ns-archive-recreate');
  const reopened = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace-archived-root', directory, project: { projectId: 'synthetic-project', workspaceRoot: directory } });
  assert.equal(await host.workspaceAvailable(reopened.id), true, 'the archived registration was reopened, not replaced');
  const updates = server.commands.filter(c => c.method === 'projects.mutate');
  assert.deepEqual(updates.map(c => c.type), ['project.update', 'project.update'], 'archive then reopen, never a second project.create');
  assert.equal(updates[1]?.archived, false);
  assert.equal(updates[1]?.projectId, 'synthetic-project');
});

test('atomic interrupt and continue steers the live run through steer_active', async t => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  p.runs = [{ id: 'run-1', status: 'running', startedAt: STAMP }];
  await host.interruptAndContinue(created.id, 'ns-steer-live', 'Change course: X');
  const command = server.commands.at(-1)!;
  assert.equal(command.type, 'message.dispatch');
  assert.deepEqual(command.dispatchMode, { type: 'steer_active', targetRunId: 'run-1' });
  // With no active run there is nothing to steer: proven refusal before send.
  p.runs = [];
  await assert.rejects(host.interruptAndContinue(created.id, 'ns-steer-idle', 'Change course: Y'), /no active run to steer/);
  assert.equal(server.commands.filter(c => c.type === 'message.dispatch').length, 1);
});

// #1148: a thread read cut mid-turn is an observation outage, not a verdict on the
// worker. The next observation is a fresh read, and it reports the live activity.
test('an interrupted thread read is a transport outage, and the next read reports the live run', async t => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  const LATER = '2026-01-01T00:05:00.000Z';
  server.controls.interruptThreadReads = 1;
  await assert.rejects(host.observe(created.id), error => isTransportFailure(error));
  p.runs = [{ id: 'live-run', status: 'running', startedAt: LATER }];
  p.thread.updatedAt = LATER; p.updatedAt = LATER;
  const live = await host.observe(created.id);
  assert.equal(live.active, true);
  assert.equal(live.activeTurnId, 'live-run');
  assert.equal(live.updatedAt, LATER, 'the observed activity stamp advances with the thread');
});

// #1148: after the T3 socket drops, observation is an outage until the host
// reconnects; then every live thread's observation resumes from a fresh read.
test('after a socket drop, observation is an outage until reconnect, then resumes for the live thread', async t => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  server.dropSockets();
  for (let i = 0; i < 100 && host.connected; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(host.connected, false);
  await assert.rejects(host.observe(created.id), error => isTransportFailure(error));
  await host.connect();
  assert.equal(host.connected, true);
  p.runs = [{ id: 'resumed-run', status: 'running', startedAt: STAMP }];
  const resumed = await host.observe(created.id);
  assert.equal(resumed.active, true);
  assert.equal(resumed.activeTurnId, 'resumed-run');
});
