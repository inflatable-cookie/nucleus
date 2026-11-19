import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3CodeHost } from '../hosts/t3code/adapter';
import { PARENT_MODEL, PARENT_PROVIDER } from '../hosts/t3code/nesting';
import { identity } from '../hosts/t3code/intents';
import { canonical } from '../hosts/t3code/state';
import { ProvenPreSendRefusalError } from '../core/host';
import type { AcpSessionSurface } from '../shared/acp/surface';
import type { HostAgentSpec } from '../shared/host';
import type { Profile } from '../shared/contracts';
import { t3Fake, STAMP } from './support/t3code-fake';
import { storedT3Labels } from './support/t3code-labels';

/**
 * Tom, 2026-11-19: "I explicitly want nucleus to unsettle threads like that". A message,
 * decision, re-entry or follow-up to a thread the operator settled unsettles it first,
 * reads it back until T3 shows it active, and only then sends. These cases run the real
 * T3 host against the private synthetic server: the recorded wire commands, their order,
 * and the command identities are what is asserted. Nucleus never issues `thread.settle`.
 */

const profile: Profile = { id: 'synthetic-profile', name: 'Synthetic', provider: 'synthetic-provider', model: 'synthetic-model',
  available: true, problem: '', notes: '', supportedThinking: [] };
const taskId = 'synthetic-task';

const nucleusProvider = {
  instanceId: PARENT_PROVIDER, displayName: 'Nucleus', driver: 'acpRegistry', enabled: true, status: 'ready',
  models: [{ slug: PARENT_MODEL, name: 'Nucleus' }],
};

/** The ACP surface the parent's held turn needs; the test never drives a turn itself. */
function acpStub(server: Awaited<ReturnType<typeof t3Fake>>) {
  const surface: AcpSessionSurface = {
    bind: input => ({ sessionId: `session:${input.taskId}`, taskId: input.taskId, bindingPath: `/synthetic/acp/sessions/${input.taskId}.json` }),
    async turn() { throw new Error('the agent is not driven in this test'); },
    async message() { throw new Error('the agent is not driven in this test'); },
    release() {
      for (const thread of server.threads.values()) {
        if (thread.thread.providerInstanceId !== PARENT_PROVIDER) continue;
        for (const run of thread.runs) if (['preparing', 'starting', 'running', 'waiting'].includes(run.status)) run.status = 'completed';
      }
    },
  };
  return { surface };
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 't3code-settled-delivery-'));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  server.controls.providers = [nucleusProvider, { instanceId: 'synthetic-provider', displayName: 'Synthetic provider', driver: 'codex',
    enabled: true, status: 'ready', models: [{ slug: 'synthetic-model', name: 'Synthetic model' }] }];
  const acp = acpStub(server);
  const options = { endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath: join(root, 'state.json'),
    timeoutMs: 2_000, probeThreadId: 'synthetic-probe', acp: () => acp.surface, reentryTimeoutMs: 300 };
  const host = new T3CodeHost(options);
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace-intent', directory, project: { projectId: 'synthetic-project' } });
  const spec = (requestId: string, role = 'worker'): HostAgentSpec => ({ workspaceId: workspace.id, profile,
    title: role === 'worker' ? 'Synthetic role' : `${role}: Synthetic role`, taskNumber: 225, mcpBindingPath: null,
    attempt: () => ({ requestId, prompt: role === 'worker' ? 'Worker prompt' : `${role} prompt`,
      labels: storedT3Labels(role, { taskId, runId: `${requestId}-run` }), environment: {} }) });
  const worker = await host.createAgent(spec('worker-launch'));
  return { host, server, options, worker, spec, acp };
}

/** The recorded commands since `before`, in the order the host sent them. */
const since = (server: Awaited<ReturnType<typeof t3Fake>>, before: number) => server.commands.slice(before);
const unsettleCommandId = (threadId: string, messageId: string) => identity('unsettle', canonical([threadId, messageId]));

test('a message to an operator-settled thread unsettles it, then sends, with the unsettle recorded under the message identity', async t => {
  const { host, server, worker } = await fixture(t);
  const thread = server.threads.get(worker.id)!.thread;
  thread.settledOverride = 'settled';
  thread.settledAt = STAMP;
  const before = server.commands.length;
  await host.sendMessage(worker.id, { messageId: 'settled-message', text: 'Nucleus has news.' });
  const sent = since(server, before);
  const unsettle = sent.findIndex(command => command.type === 'thread.unsettle');
  const dispatch = sent.findIndex(command => command.type === 'message.dispatch');
  assert.ok(unsettle >= 0, 'the settled thread is unsettled');
  assert.ok(dispatch > unsettle, 'the message is sent only after the unsettle');
  assert.equal(sent[unsettle]!.threadId, worker.id);
  assert.equal(sent[unsettle]!.reason, 'user');
  assert.equal(sent[unsettle]!.commandId, unsettleCommandId(worker.id, 'settled-message'));
  assert.equal(sent[dispatch]!.messageId, identity('message', 'settled-message'));
  assert.equal(sent.some(command => command.type === 'thread.settle'), false, 'Nucleus never settles');
  assert.equal(thread.settledOverride, 'active', 'T3 shows the thread active once the message is delivered');
});

test('an already-visible thread is sent to with no unsettle', async t => {
  const { host, server, worker } = await fixture(t);
  const before = server.commands.length;
  await host.sendMessage(worker.id, { messageId: 'visible-message', text: 'Nucleus has news.' });
  const sent = since(server, before);
  assert.equal(sent.some(command => command.type === 'thread.unsettle'), false);
  assert.equal(sent.filter(command => command.type === 'message.dispatch').length, 1);
});

test('an archived thread is fenced: a settled archived thread is neither unsettled nor sent to', async t => {
  const { host, server, worker } = await fixture(t);
  const thread = server.threads.get(worker.id)!.thread;
  thread.settledOverride = 'settled';
  thread.archivedAt = STAMP;
  const before = server.commands.length;
  await assert.rejects(host.sendMessage(worker.id, { messageId: 'archived-message', text: 'hello' }), (error: unknown) =>
    error instanceof ProvenPreSendRefusalError && /archived or removed/.test(error.message));
  const sent = since(server, before);
  assert.equal(sent.some(command => command.type === 'thread.unsettle' || command.type === 'message.dispatch'), false);
  assert.equal(thread.settledOverride, 'settled', 'the operator\'s settle is left as it is');
});

test('a delayed unsettle is read back until T3 shows the thread active, then the message is sent', async t => {
  const { host, server, worker } = await fixture(t);
  server.threads.get(worker.id)!.thread.settledOverride = 'settled';
  server.controls.unsettleLagReads = 2;
  t.after(() => { server.controls.unsettleLagReads = 0; });
  const before = server.commands.length;
  await host.sendMessage(worker.id, { messageId: 'lagging-message', text: 'hello' });
  const sent = since(server, before);
  assert.equal(sent.filter(command => command.type === 'thread.unsettle').length, 1);
  assert.ok(sent.findIndex(command => command.type === 'message.dispatch') > sent.findIndex(command => command.type === 'thread.unsettle'));
});

test('an unsettle T3 never shows active is refused before send and stays queued; a later read delivers it once T3 shows it', async t => {
  const { host, server, worker } = await fixture(t);
  const thread = server.threads.get(worker.id)!;
  thread.thread.settledOverride = 'settled';
  server.controls.unsettleLagReads = 1000;
  t.after(() => { server.controls.unsettleLagReads = 0; });
  const before = server.commands.length;
  await assert.rejects(host.sendMessage(worker.id, { messageId: 'waiting-message', text: 'hello' }), (error: unknown) =>
    error instanceof ProvenPreSendRefusalError && /still shows the thread settled/.test(error.message));
  assert.equal(since(server, before).some(command => command.type === 'message.dispatch'), false, 'nothing was sent');
  // The next pass: the unsettle is already recorded, so it is read again, not resent.
  thread.unsettleLagReads = 1;
  server.controls.unsettleLagReads = 0;
  await host.sendMessage(worker.id, { messageId: 'waiting-message', text: 'hello' });
  const sent = since(server, before);
  assert.equal(sent.filter(command => command.type === 'thread.unsettle').length, 1, 'the unsettle is never resent once recorded');
  assert.equal(sent.filter(command => command.type === 'message.dispatch').length, 1, 'the message is sent once, after the wake');
});

test('an unsettle the wire drops before T3 applies it is resent under the same identity only after a fresh read proves it did not land', async t => {
  const { host, server, options, worker } = await fixture(t);
  server.threads.get(worker.id)!.thread.settledOverride = 'settled';
  server.controls.unsettleFaults.push('drops');
  const before = server.commands.length;
  await assert.rejects(host.sendMessage(worker.id, { messageId: 'dropped-message', text: 'hello' }), ProvenPreSendRefusalError);
  assert.equal(server.threads.get(worker.id)!.thread.settledOverride, 'settled', 'T3 never applied the dropped unsettle');
  host.close();
  const reloaded = new T3CodeHost(options);
  t.after(() => reloaded.close());
  await reloaded.connect();
  await reloaded.sendMessage(worker.id, { messageId: 'dropped-message', text: 'hello' });
  const sent = since(server, before);
  const unsettles = sent.filter(command => command.type === 'thread.unsettle');
  assert.equal(unsettles.length, 2, 'the unsettle was resent once a fresh read showed it had not landed');
  assert.equal(new Set(unsettles.map(command => command.commandId)).size, 1, 'both sends carry the same command identity');
  assert.equal(sent.filter(command => command.type === 'message.dispatch').length, 1);
});

test('an unsettle that lands before its reply is lost is not repeated: a fresh read shows it active and the message is sent once', async t => {
  const { host, server, options, worker } = await fixture(t);
  server.threads.get(worker.id)!.thread.settledOverride = 'settled';
  server.controls.unsettleFaults.push('lands');
  const before = server.commands.length;
  await assert.rejects(host.sendMessage(worker.id, { messageId: 'landed-message', text: 'hello' }), ProvenPreSendRefusalError);
  assert.equal(server.threads.get(worker.id)!.thread.settledOverride, 'active', 'T3 applied the unsettle before the reply was lost');
  host.close();
  const reloaded = new T3CodeHost(options);
  t.after(() => reloaded.close());
  await reloaded.connect();
  await reloaded.sendMessage(worker.id, { messageId: 'landed-message', text: 'hello' });
  const sent = since(server, before);
  assert.equal(sent.filter(command => command.type === 'thread.unsettle').length, 1, 'the landed unsettle is not repeated');
  assert.equal(sent.filter(command => command.type === 'message.dispatch').length, 1, 'the message is sent once');
});

