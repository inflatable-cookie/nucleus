import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost, createAdapter } from '../hosts/t3code';
import { HostFacade } from '../core/host/host-facade';
import { HostRegistry, type KnownHost } from '../core/host/host-registry';
import { Admission, admitAdapter } from '../core/host/admission';
import { HostUnknownDeliveryError, ProvenPreSendRefusalError, type Adapter } from '../core/host';
import { answerHostPermission } from '../service/host-permissions';
import { QueueService } from '../service/transport/server';
import { ServiceClient } from '../shared/service/client';
import { readServiceInfo } from '../service/transport/identity';
import { hostPermissionAnswer, type HostPermissionAnswerInput } from '../shared/rpc/questions';
import { callCatalogueMethod } from '../service/transport/dispatch';
import { t3Fake } from './support/t3code-fake';
import { QueueRuntime } from '../service/runtime-owner';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema, type Run } from '../shared/contracts';

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

function permissionTask(store: Store, key: string, hostId: string, input: HostPermissionAnswerInput, own = true) {
  const base = 'a'.repeat(40);
  return store.insert(submissionSchema.parse({ submissionId: key, title: 'Synthetic permission owner', repoPath: '/fixture',
    planningCommit: base, handoffPath: 'synthetic-handoff', originAgentId: own ? 'synthetic-origin' : input.agentId }),
  hostId, 'Synthetic handoff', base, { phase: 'working', ...(own ? { agentId: input.agentId, workspaceId: input.workspaceId } : {}) });
}

async function permissionRuntime(t: TestContext, fixture: Awaited<ReturnType<typeof nativeFixture>>) {
  const directory = join(fixture.directory, 'service');
  const primary = { client: { isConnected: true }, hostId: 'synthetic-primary', socketPath: join(directory, 'callback.sock'), helperPath: join(directory, 'helper.mjs'),
    connect: async () => {}, close: async () => {}, catalog: async () => ({ providers: [] }) } as unknown as Adapter;
  const runtime = new QueueRuntime({ dataDir: directory, adapterFactory: () => primary, timers: false });
  t.after(() => runtime.drain());
  await runtime.started; await runtime.bootstrap;
  const admission = new Admission({ startIntervalMs: 0 });
  const adapter = admitAdapter(createAdapter(fixture.host), admission);
  runtime.hostRegistry.connect(fixture.host.hostId, fixture.server.endpoint, { adapter, admission });
  return runtime;
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

test('a host-qualified catalogue call reaches only the registered T3 adapter; Adapter lifecycleDispatch is on, Host stays off', async t => {
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
  assert.equal(host.capabilities().lifecycleDispatch, false);
  assert.equal(native.capabilities().lifecycleDispatch, true);
  assert.throws(() => native.createAgent({} as never, 'unused', 'unused'), /helper path/);

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

test('reported command and field enter the exact owning task attention and survive store/host reload', async t => {
  const fixture = await nativeFixture(t);
  const { host, server, input, directory, config } = fixture;
  const runtime = await permissionRuntime(t, fixture);
  const store = runtime.store;
  const task = permissionTask(store, 'permission-review-owner', host.hostId, input, false);
  const run: Run = { id: 'synthetic-review-run', taskId: task.id, hostId: host.hostId, role: 'reviewer', generation: 1,
    head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: input.agentId, workspaceId: input.workspaceId, profile: null,
    status: 'running', createdAt: '2026-01-01T00:00:00.000Z', lastObservedAt: null, active: true, idleSince: null, completion: null, released: false };
  store.putRun(run);
  store.update(task.id, { phase: 'reviewing', resolution: { ...store.task(task.id).resolution, currentRunId: run.id, reviewerAgentId: input.agentId } });
  const collision = permissionTask(store, 'permission-foreign-host', 'different-host', input);
  const otherWorkspace = permissionTask(store, 'permission-foreign-workspace', host.hostId, { ...input, workspaceId: `${input.workspaceId}-other` });
  const originOnly = permissionTask(store, 'permission-origin-only', host.hostId, input, false);
  const terminal = permissionTask(store, 'permission-terminal', host.hostId, input);
  store.update(terminal.id, { phase: 'cancelled', finishedAt: '2026-01-01T00:00:00.000Z' });
  const untouched = [collision, otherWorkspace, originOnly, terminal].map(item => ({ id: item.id, task: store.task(item.id) }));
  server.controls.postEffectDefect = true;
  await assert.rejects(runtime.answerHostPermission(input), error => {
    assert.ok(error instanceof HostUnknownDeliveryError);
    assert.deepEqual(error.diagnostic, { command: 'runtime-request.respond', field: 'commandId' });
    return true;
  });
  const attention = store.task(task.id);
  assert.equal(attention.resolution.attention, true);
  assert.equal(attention.phase, 'reviewing', 'existing attention policy preserves a live run phase');
  assert.equal(attention.resolution.incident?.cause, 'uncertain_delivery');
  assert.match(attention.reason, /delivery is unknown/);
  assert.match(attention.reason, /command runtime-request\.respond/);
  assert.match(attention.reason, /field commandId/);
  assert.equal(store.run(run.id)?.released, false);
  const deliveryEvents = store.eventsAll(task.id).filter(event => event.kind === 'host_permission_delivery_unknown');
  assert.equal(deliveryEvents.length, 1);
  const evidence = JSON.parse(deliveryEvents[0]!.detail);
  assert.equal(evidence.command, 'runtime-request.respond'); assert.equal(evidence.field, 'commandId'); assert.equal(evidence.delivery, 'unknown');
  assert.doesNotMatch(JSON.stringify({ reason: attention.reason, evidence, intent: host.state.read().intents[input.intentId]!.diagnostic }), /synthetic-bearer|Missing key|\n  at|synthetic-ticket/);
  for (const item of untouched) assert.deepEqual(store.task(item.id), item.task, 'colliding, foreign, origin-only and terminal tasks are untouched');
  const storePath = store.path;
  await runtime.drain(); host.close();

  const saved = new Store(storePath);
  const reloaded = createHost({ ...config, statePath: join(directory, 'hosts', 't3code.json'), timeoutMs: 2_000 });
  t.after(() => reloaded.close());
  await reloaded.connect();
  let known: readonly KnownHost[] = [];
  const registry = new HostRegistry<{ adapter: Adapter; admission: Admission }>({ read: () => known, write: hosts => { known = hosts; }, transaction: work => work() });
  const admission = new Admission({ startIntervalMs: 0 });
  const adapter = admitAdapter(createAdapter(reloaded), admission);
  registry.connect(reloaded.hostId, server.endpoint, { adapter, admission });
  const engine = new Engine(saved, adapter);
  try {
    assert.equal(saved.task(task.id).resolution.attention, true);
    assert.equal(saved.task(task.id).reason, attention.reason);
    const requests = server.requests.length;
    for (const intentId of [input.intentId, 'new-intent-after-task-reload']) {
      await assert.rejects(answerHostPermission(registry, { ...input, intentId }, { store: saved,
        attention: (current, reason) => engine.withHost(current.hostId, () => engine.resolution.attention(current, reason, 'uncertain_delivery')),
      }), error => {
        assert.ok(error instanceof HostUnknownDeliveryError);
        assert.deepEqual(error.diagnostic, { command: 'runtime-request.respond', field: 'commandId' });
        return true;
      });
    }
    assert.equal(server.requests.length, requests);
    assert.equal(server.commands.filter(command => command.type === 'runtime-request.respond').length, 1);
    assert.equal(saved.eventsAll(task.id).filter(event => event.kind === 'host_permission_delivery_unknown').length, 1);
    assert.equal(saved.task(task.id).reason, attention.reason);
    for (const item of untouched) assert.deepEqual(saved.task(item.id), item.task);
  } finally { await engine.stop(); saved.close(); }
});

test('ambiguous exact-host task ownership refuses before a response and before altering either task', async t => {
  const fixture = await nativeFixture(t);
  const runtime = await permissionRuntime(t, fixture);
  const first = permissionTask(runtime.store, 'ambiguous-first', fixture.host.hostId, fixture.input);
  const second = permissionTask(runtime.store, 'ambiguous-second', fixture.host.hostId, fixture.input);
  const before = [runtime.store.task(first.id), runtime.store.task(second.id)];
  await assert.rejects(runtime.answerHostPermission(fixture.input), /ownership is ambiguous/);
  assert.equal(fixture.server.commands.filter(command => command.type === 'runtime-request.respond').length, 0);
  assert.deepEqual([runtime.store.task(first.id), runtime.store.task(second.id)], before);
});

test('ownership moving during an uncertain send retains history on the original task without flagging the new owner', async t => {
  const fixture = await nativeFixture(t);
  const runtime = await permissionRuntime(t, fixture);
  const original = permissionTask(runtime.store, 'permission-original-owner', fixture.host.hostId, fixture.input);
  const next = permissionTask(runtime.store, 'permission-next-owner', fixture.host.hostId, { ...fixture.input, workspaceId: 'different-workspace' });
  fixture.server.controls.postEffectDefect = true;
  fixture.server.controls.mutationObserver = () => {
    runtime.store.update(original.id, { agentId: 'replacement-agent', workspaceId: 'replacement-workspace' });
    runtime.store.update(next.id, { agentId: fixture.input.agentId, workspaceId: fixture.input.workspaceId });
  };
  await assert.rejects(runtime.answerHostPermission(fixture.input), HostUnknownDeliveryError);
  assert.equal(runtime.store.task(original.id).resolution.attention, false);
  assert.equal(runtime.store.task(next.id).resolution.attention, false);
  const events = runtime.store.eventsAll(original.id).filter(event => event.kind === 'host_permission_delivery_unknown');
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0]!.detail).field, 'commandId');
  assert.equal(runtime.store.eventsAll(next.id).some(event => event.kind === 'host_permission_delivery_unknown'), false);
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
