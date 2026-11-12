import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3CodeHost } from '../hosts/t3code/adapter';
import { ProvenPreSendRefusalError, HostUnknownDeliveryError } from '../core/host';
import type { HostAgentSpec } from '../shared/host';
import type { Profile } from '../shared/contracts';
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
  const spec = (requestId = 'launch-intent', prompt = 'Synthetic prompt'): HostAgentSpec => ({ workspaceId: workspace.id, profile, title: 'Synthetic role', mcpBindingPath: null,
    attempt: () => ({ requestId, prompt, labels: { task: 'synthetic-task', role: 'worker' }, environment: {} }) });
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
  assert.equal(command.initialMessage.attachments.length, 0);
  assert.equal(created.workspaceId, workspace.id);
  for (const field of ['parentThreadId', 'parentRunId', 'delegatedFrom', 'environment', 'mcpServers']) assert.equal(Object.hasOwn(command, field), false, field);
  assert.equal((await host.observe(created.id)).workspaceId, workspace.id);
  assert.deepEqual(await host.findAgents({ task: 'synthetic-task' }), [created]);
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
  const changed = spec(); changed.attempt = () => ({ requestId: 'launch-intent', prompt: 'Synthetic prompt', labels: { task: 'other-task' }, environment: {} });
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

test('decoder-formatted defects keep durable diagnostics while remaining unknown after reload', async t => {
  const { host, server, spec, options } = await fixture(t);
  const created = await host.createAgent(spec());
  server.controls.postEffectDefect = true;
  await assert.rejects(host.sendMessage(created.id, { messageId: 'schema-refusal', text: 'Synthetic' }), error => {
    assert.ok(error instanceof HostUnknownDeliveryError);
    assert.deepEqual(error.diagnostic, { command: 'message.dispatch', field: 'commandId', reason: 'Missing key at ["commandId"]' });
    return true;
  });
  assert.equal(host.state.read().intents['schema-refusal']?.status, 'unknown');
  assert.deepEqual(host.state.read().intents['schema-refusal']?.diagnostic, { command: 'message.dispatch', field: 'commandId', reason: 'Missing key at ["commandId"]' });
  assert.ok(server.threads.get(created.id)!.messages.some((message: { text: string }) => message.text === 'Synthetic'), 'handler performed the effect before the identical defect');
  const sent = server.commands.length;
  server.controls.postEffectDefect = false;
  host.close();
  const reloaded = new T3CodeHost(options); t.after(() => reloaded.close()); await reloaded.connect();
  await assert.rejects(reloaded.sendMessage(created.id, { messageId: 'schema-refusal', text: 'Synthetic' }), error => {
    assert.ok(error instanceof HostUnknownDeliveryError);
    assert.deepEqual(error.diagnostic, { command: 'message.dispatch', field: 'commandId', reason: 'Missing key at ["commandId"]' });
    assert.match(error.message, /unknown.*not resent.*message.dispatch.*commandId/);
    return true;
  });
  assert.equal(server.commands.length, sent);
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
  assert.equal((await host.observe(created.id)).status, 'archived');
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

test('an unarchive between live and archive reads refuses complete inventory instead of losing the live thread', async t => {
  const { host, server, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  for (const read of [
    () => host.listLiveAgents(), () => host.activeThreads(), () => host.workspaceThreads([workspace.id]),
  ]) {
    p.thread.archivedAt = STAMP;
    server.controls.beforeArchiveRead = () => {
      p.thread.archivedAt = null;
      server.controls.snapshotSequence++;
      server.controls.beforeArchiveRead = () => {};
    };
    await assert.rejects(read(), /inventory.snapshotSequence changed/);
  }
  assert.ok((await host.listLiveAgents()).some(agent => agent.id === created.id));
  assert.ok((await host.activeThreads()).some(agent => agent.id === created.id));
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
  const environment = spec(); environment.attempt = () => ({ requestId: 'environment', prompt: 'Synthetic', labels: {}, environment: { SYNTHETIC: 'value' } });
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
    { id: created.id, workspaceId: workspace.id, title: 'Synthetic role', archived: false });
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

test('an unsupported T3 project-create command names the manual project setup', async t => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, 'repository');
  const worktree = join(root, 'worktree');
  mkdirSync(repository); mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  server.controls.unsupportedProjectCreate = true;
  await assert.rejects(host.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-unsupported', directory: worktree, project }), error => {
    assert.ok(String(error).includes(project.workspaceRoot!));
    assert.match(String(error), /add that folder as a project in T3Code, then restart the task/);
    return true;
  });
  assert.equal(host.state.read().intents[Object.keys(host.state.read().intents).find(key => key.startsWith('nucleus-project-create-')) ?? '']?.status, 'refused');
});

test('a refused remote mutation keeps its bounded reason in the durable intent and attention detail', async t => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, 'repository');
  const worktree = join(root, 'worktree');
  mkdirSync(repository); mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  server.controls.projectMutationFailure = true;
  await assert.rejects(host.createWorkspace({ title: 'Synthetic task', requestId: 'workspace-reason', directory: worktree, project }), error => {
    assert.ok(error instanceof HostUnknownDeliveryError);
    assert.deepEqual(error.diagnostic, { command: 'project.create', reason: 'ProjectMutationError: Failed to mutate project.' });
    assert.match(error.message, /unknown.*not resent.*command project\.create.*reason ProjectMutationError: Failed to mutate project\./);
    return true;
  });
  const key = Object.keys(host.state.read().intents).find(candidate => candidate.startsWith('nucleus-project-create-'))!;
  assert.equal(host.state.read().intents[key]?.status, 'unknown');
  assert.deepEqual(host.state.read().intents[key]?.diagnostic, { command: 'project.create', reason: 'ProjectMutationError: Failed to mutate project.' });
  // The refused reason is diagnostic evidence only: the delivery stays unknown and is never resent.
  server.controls.projectMutationFailure = false;
  const sent = server.commands.filter(command => command.method === 'projects.mutate');
  assert.equal(sent.length, 1);
});
