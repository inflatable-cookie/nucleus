import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost, createAdapter } from '../hosts/t3code';
import { HostFacade } from '../core/host/host-facade';
import { HostRegistry, type KnownHost } from '../core/host/host-registry';
import { Admission, admitAdapter } from '../core/host/admission';
import { ProvenPreSendRefusalError, type Adapter } from '../core/host';
import { answerHostPermission } from '../service/host-permissions';
import { QueueService } from '../service/transport/server';
import { ServiceClient } from '../shared/service/client';
import { readServiceInfo } from '../service/transport/identity';
import { hostPermissionAnswer, type HostPermissionAnswerInput } from '../shared/rpc/questions';
import { callCatalogueMethod } from '../service/transport/dispatch';
import { t3Fake } from './support/t3code-fake';

async function nativeFixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 't3p-')));
  const server = await t3Fake(t, directory);
  const config = { endpoint: server.endpoint, bearer: 'synthetic-bearer', probeThreadId: 'synthetic-probe' };
  const host = createHost({ ...config, statePath: join(directory, 'hosts', 't3code.json'), timeoutMs: 2_000 });
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace', directory, project: { projectId: 'synthetic-project' } });
  const agent = await host.createAgent({ workspaceId: workspace.id, title: 'Synthetic worker', mcpBindingPath: null,
    profile: { id: 'profile', name: 'Synthetic', provider: 'synthetic-provider', model: 'synthetic-model', notes: '', available: true, problem: '', supportedThinking: [] },
    attempt: () => ({ requestId: 'create-thread', prompt: 'Synthetic prompt', labels: { 'nucleus.task': 'synthetic' }, environment: {} }),
  });
  const projection = server.threads.get(agent.id)!;
  const permission = (id: string) => ({ id, kind: 'command', status: 'pending', responseCapability: { type: 'live', providerSessionId: 'synthetic-session' } });
  projection.runtimeRequests.push(permission('synthetic-permission'));
  const input = { hostId: host.hostId, agentId: agent.id, workspaceId: workspace.id, requestId: 'synthetic-permission', decision: 'accept' as const, intentId: 'permission-answer' };
  return { directory, config, host, server, workspace, agent, projection, permission, input };
}

function registered(host: ReturnType<typeof createHost>, endpoint: string) {
  let known: readonly KnownHost[] = [];
  const registry = new HostRegistry<{ adapter: Adapter; admission: Admission }>({ read: () => known, write: hosts => { known = hosts; }, transaction: work => work() });
  const admission = new Admission({ startIntervalMs: 0 });
  registry.connect(host.hostId, endpoint, { adapter: admitAdapter(createAdapter(host), admission), admission });
  return (input: HostPermissionAnswerInput) => answerHostPermission(registry, input);
}

function isUnknown(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error instanceof ProvenPreSendRefusalError, false, 'an uncertain original response never becomes a known pre-send refusal');
  assert.match(error.message, /unknown.*not resent/);
  return true;
}

test('the permission façade is late-bound and returns the registered adapter promise unchanged', async () => {
  const calls: unknown[][] = [];
  const done = Promise.resolve();
  const owner = { adapter: {} as Adapter };
  const facade = new HostFacade(owner);
  await assert.rejects(facade.answerNativePermission('agent', 'workspace', 'request', 'accept', 'intent'), /cannot answer native permissions/);
  owner.adapter = { answerNativePermission: (...args: unknown[]) => { calls.push(args); return done; } } as Adapter;
  assert.equal(facade.answerNativePermission('agent', 'workspace', 'request', 'decline', 'stable-intent'), done);
  assert.deepEqual(calls, [['agent', 'workspace', 'request', 'decline', 'stable-intent']]);
});

test('a host-qualified catalogue call reaches only the registered T3 adapter and keeps workflow dispatch refused', async t => {
  const { host, server, workspace, input, projection, permission } = await nativeFixture(t);
  let known: readonly KnownHost[] = [];
  const registry = new HostRegistry<{ adapter: Adapter; admission: Admission }>({ read: () => known, write: hosts => { known = hosts; }, transaction: work => work() });
  const native = createAdapter(host);
  const admission = new Admission({ startIntervalMs: 0 });
  let otherCalls = 0;
  const other = { answerNativePermission: async () => { otherCalls++; } } as unknown as Adapter;
  registry.connect('paseo-synthetic', 'ws://127.0.0.1:10001/ws', { adapter: other, admission: new Admission() });
  const token = registry.connect(host.hostId, server.endpoint, { adapter: admitAdapter(native, admission), admission });
  const owner = { answerHostPermission: (request: typeof input) => answerHostPermission(registry, request) };
  assert.deepEqual(await callCatalogueMethod(owner, 'host.permission-answer', input), { ok: true });
  assert.equal(admission.snapshot().control.completed, 1, 'the registered permission mutation goes through host admission');
  const responses = server.commands.filter(command => command.type === 'runtime-request.respond');
  assert.equal(responses.length, 1);
  assert.equal(responses[0]!.threadId, input.agentId);
  assert.equal(responses[0]!.requestId, input.requestId);
  assert.equal(responses[0]!.commandId, input.intentId);
  assert.equal(responses[0]!.decision, 'accept');
  assert.equal(otherCalls, 0, 'equal native IDs on another host never redirect the response');
  await assert.rejects(native.validate({} as never), /trial step 2/);
  await assert.rejects(native.createAgent({} as never, 'unused', 'unused'), /trial step 2/);

  projection.runtimeRequests.push(permission('another-request'));
  await assert.rejects(callCatalogueMethod(owner, 'host.permission-answer', { ...input, requestId: 'another-request', workspaceId: `${workspace.id}-other`, intentId: 'wrong-workspace' }), /workspace changed/);
  projection.runtimeRequests.push({ id: 'question', kind: 'user_input', status: 'pending', responseCapability: { type: 'message' } });
  await assert.rejects(callCatalogueMethod(owner, 'host.permission-answer', { ...input, requestId: 'question', intentId: 'question-is-not-permission' }), /kind/);
  await assert.rejects(callCatalogueMethod(owner, 'host.permission-answer', { ...input, hostId: 'unknown-host', requestId: 'another-request', intentId: 'unknown-host' }), /registered host/);
  registry.disconnect(host.hostId, token);
  await assert.rejects(callCatalogueMethod(owner, 'host.permission-answer', { ...input, requestId: 'another-request', intentId: 'offline-host' }), /registered host/);
  assert.equal(server.commands.filter(command => command.type === 'runtime-request.respond').length, 1);
  assert.equal(otherCalls, 0, 'an offline host never falls back to the online host');
});

test('permission RPC input requires every explicit identity, a stable intent and a typed decision', () => {
  const input = { hostId: 'host-a', agentId: 'agent', workspaceId: 'workspace', requestId: 'request', intentId: 'intent', decision: 'decline' };
  assert.deepEqual(hostPermissionAnswer.input.parse(input), input);
  for (const key of ['hostId', 'agentId', 'workspaceId', 'requestId', 'intentId', 'decision']) {
    const missing: Record<string, unknown> = { ...input }; delete missing[key];
    assert.equal(hostPermissionAnswer.input.safeParse(missing).success, false, key);
  }
  assert.equal(hostPermissionAnswer.input.safeParse({ ...input, decision: 'approve-anything' }).success, false);
  assert.equal(hostPermissionAnswer.input.safeParse({ ...input, hostId: '' }).success, false);
  assert.equal(hostPermissionAnswer.input.safeParse({ ...input, answers: { arbitrary: 'answer' } }).success, false);
});

test('concurrent changed decisions under one intent reach the native payload fence instead of coalescing success', async t => {
  const { host, server, input } = await nativeFixture(t);
  let known: readonly KnownHost[] = [];
  const registry = new HostRegistry<{ adapter: Adapter; admission: Admission }>({ read: () => known, write: hosts => { known = hosts; }, transaction: work => work() });
  const admission = new Admission({ startIntervalMs: 0 });
  registry.connect(host.hostId, server.endpoint, { adapter: admitAdapter(createAdapter(host), admission), admission });
  const replies = await Promise.allSettled([
    answerHostPermission(registry, input),
    answerHostPermission(registry, { ...input, decision: 'decline' }),
  ]);
  assert.equal(replies.filter(reply => reply.status === 'fulfilled').length, 1);
  const refused = replies.find(reply => reply.status === 'rejected');
  assert.ok(refused && refused.status === 'rejected');
  assert.match(String(refused.reason), /payload changed|no longer answerable|unknown.*not resent|changed answer/);
  assert.equal(admission.snapshot().control.coalesced, 0, 'changed decision is not an equivalent admitted call');
  assert.equal(server.commands.filter(command => command.type === 'runtime-request.respond').length, 1);
});

for (const observed of ['resolved', 'expired', 'pending'] as const) {
  test(`a lost permission reply stays unknown across reload and changed intents when the native request is ${observed}`, async t => {
    const { host, server, directory, config, input, projection } = await nativeFixture(t);
    const send = registered(host, server.endpoint);
    server.controls.disconnectAfterEffect = observed !== 'pending';
    server.controls.disconnectMutation = observed === 'pending';
    await assert.rejects(send(input), error => {
      assert.equal(error instanceof ProvenPreSendRefusalError, false);
      return true;
    });
    assert.equal(host.state.read().intents[input.intentId]?.status, 'unknown');
    const disconnectedReads = server.requests.length;
    await assert.rejects(send(input), isUnknown);
    await assert.rejects(send({ ...input, intentId: 'disconnected-new-intent', decision: 'decline' }), isUnknown);
    assert.equal(server.requests.length, disconnectedReads, 'socket loss does not move the durable unknown fence behind connection checks');
    const request = projection.runtimeRequests.find((item: { id: string }) => item.id === input.requestId)!;
    request.status = observed;
    if (observed === 'expired') request.responseCapability = { type: 'not_resumable', reason: 'Synthetic server restart' };
    server.controls.disconnectAfterEffect = false;
    server.controls.disconnectMutation = false;
    host.close();

    const reloaded = createHost({ ...config, statePath: join(directory, 'hosts', 't3code.json'), timeoutMs: 2_000 });
    t.after(() => reloaded.close());
    await reloaded.connect();
    const replay = registered(reloaded, server.endpoint);
    const reads = server.requests.length;
    for (const retry of [
      input,
      { ...input, intentId: 'new-permission-intent' },
      { ...input, decision: 'decline' as const },
      { ...input, intentId: 'new-changed-intent', decision: 'decline' as const },
      { ...input, intentId: 'new-workspace-intent', workspaceId: `${input.workspaceId}-changed` },
    ]) await assert.rejects(replay(retry), isUnknown);
    assert.equal(server.requests.length, reads, 'the durable unknown fence runs before any native status read');
    assert.equal(server.commands.filter(command => command.type === 'runtime-request.respond').length, 1, 'a new intent cannot mint another native response');
    assert.equal(reloaded.state.read().intents[input.intentId]?.status, 'unknown');
  });
}

test('a settled permission answer replays the original result under same and new intents without native reads', async t => {
  const { host, server, directory, config, input, agent } = await nativeFixture(t);
  const original = registered(host, server.endpoint);
  assert.deepEqual(await original(input), { ok: true });
  assert.equal(host.state.read().intents[input.intentId]?.status, 'settled');
  host.close();
  const disconnectedReads = server.requests.length;
  assert.deepEqual(await original(input), { ok: true });
  assert.deepEqual(await original({ ...input, intentId: 'settled-offline-new-intent' }), { ok: true });
  assert.equal(server.requests.length, disconnectedReads, 'an already authenticated instance replays its settled result while disconnected');
  server.threads.delete(agent.id);
  const reloaded = createHost({ ...config, statePath: join(directory, 'hosts', 't3code.json'), timeoutMs: 2_000 });
  t.after(() => reloaded.close());
  await reloaded.connect();
  const replay = registered(reloaded, server.endpoint);
  const reads = server.requests.length;
  assert.deepEqual(await replay(input), { ok: true });
  assert.deepEqual(await replay({ ...input, intentId: 'settled-new-intent' }), { ok: true });
  await assert.rejects(replay({ ...input, intentId: 'settled-changed-decision', decision: 'decline' }), error => {
    assert.ok(error instanceof ProvenPreSendRefusalError);
    assert.match(error.message, /original runtime response is settled|changed answer/);
    return true;
  });
  assert.equal(server.requests.length, reads, 'settled replay and changed-call refusal do not inspect an absent native thread');
  assert.equal(server.commands.filter(command => command.type === 'runtime-request.respond').length, 1);
  assert.equal(reloaded.state.read().intents[input.intentId]?.status, 'settled');
});

test('a known local refusal can be corrected only by a new explicit permission intent', async t => {
  const { host, server, input } = await nativeFixture(t);
  const send = registered(host, server.endpoint);
  const wrong = { ...input, workspaceId: `${input.workspaceId}-changed` };
  await assert.rejects(send(wrong), ProvenPreSendRefusalError);
  const reads = server.requests.length;
  await assert.rejects(send(wrong), ProvenPreSendRefusalError);
  await assert.rejects(send(input), ProvenPreSendRefusalError);
  assert.equal(server.requests.length, reads, 'a known refused intent is not re-inspected or rewritten');
  assert.equal(server.commands.filter(command => command.type === 'runtime-request.respond').length, 0);
  assert.deepEqual(await send({ ...input, intentId: 'corrected-explicit-intent' }), { ok: true });
  assert.equal(server.commands.filter(command => command.type === 'runtime-request.respond').length, 1);
  assert.equal(host.state.read().intents[input.intentId]?.status, 'refused');
  assert.equal(host.state.read().intents['corrected-explicit-intent']?.status, 'settled');
});

test('an older unbound refused permission intent remains unknown when a new intent is supplied', async t => {
  const { host, server, input } = await nativeFixture(t);
  host.state.update(state => {
    state.intents['legacy-refused'] = { status: 'refused', payload: JSON.stringify({ method: 'orchestration.dispatchCommand', payload: {
      type: 'runtime-request.respond', commandId: 'legacy-refused', threadId: input.agentId, requestId: input.requestId, decision: 'accept',
    } }) };
  });
  const reads = server.requests.length;
  await assert.rejects(registered(host, server.endpoint)(input), isUnknown);
  assert.equal(server.requests.length, reads);
  assert.equal(server.commands.filter(command => command.type === 'runtime-request.respond').length, 0);
  assert.equal(host.state.read().intents['legacy-refused']?.status, 'refused', 'the historical record is not relabelled');
});

test('the owner-authenticated service socket answers a permission on its registered T3 host', async t => {
  const { directory, config, host, server, input } = await nativeFixture(t);
  host.close();
  const service = new QueueService({ owner: { dataDir: directory, timers: false, settings: { daemonUrl: 'ws://127.0.0.1:10001/ws', t3code: config } }, fixture: 'fake' });
  let client: ServiceClient | undefined;
  t.after(async () => { client?.close(); await service.stop(); });
  await service.start();
  const info = readServiceInfo(directory); assert.ok(info);
  client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  const deadline = Date.now() + 10_000;
  while (true) {
    const health = await client.health() as { t3code?: { connected: boolean } };
    if (health.t3code?.connected) break;
    assert.ok(Date.now() < deadline, 'private service must finish read-only T3 registration');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const unauthorized = new ServiceClient({ socketPath: info.socketPath, credential: 'f'.repeat(64) });
  t.after(() => unauthorized.close());
  await assert.rejects(unauthorized.connect(), /auth|credential/i);
  assert.equal(server.commands.filter(command => command.type === 'runtime-request.respond').length, 0);
  assert.deepEqual(await client.request('host.permission-answer', input), { ok: true });
  assert.equal(server.commands.filter(command => command.type === 'runtime-request.respond').length, 1);
  await assert.rejects(client.request('host.permission-answer', { ...input, hostId: 'fixture-host', intentId: 'wrong-host' }), /cannot answer native permissions/);
  assert.equal(server.commands.filter(command => command.type === 'runtime-request.respond').length, 1);
});
