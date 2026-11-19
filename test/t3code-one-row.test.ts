import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3CodeHost } from '../hosts/t3code/adapter';
import { taskWorkspaceTitle } from '../core/workspaces/workspace-title';
import { PARENT_MODEL, PARENT_PROVIDER } from '../hosts/t3code/nesting';
import { SNOOZE_HORIZON_MS, SNOOZE_RENEW_BEFORE_MS } from '../hosts/t3code/presentation';
import type { AcpSessionSurface } from '../shared/acp/surface';
import type { HostAgentSpec } from '../shared/host';
import type { Profile, Task } from '../shared/contracts';
import type { TaskAttention } from '../shared/task-attention';
import { t3Fake, STAMP, syntheticRun, syntheticRuntimeRequest } from './support/t3code-fake';
import { storedT3Labels } from './support/t3code-labels';

/**
 * A task's one row on T3 (Tom, 2026-11-15; nucleus#1366): the parent thread is the
 * row, it names the step its role children are doing, and it is snoozed — never
 * settled — while the task waits on nothing Nucleus runs and needs no one. Every
 * record here is a synthetic Nightly shape served by the fake transport; no live T3
 * is touched.
 */

const profile: Profile = { id: 'synthetic-profile', name: 'Synthetic', provider: 'synthetic-provider', model: 'synthetic-model',
  available: true, problem: '', notes: '', supportedThinking: [] };
const taskId = 'synthetic-task';

const nucleusProvider = {
  instanceId: PARENT_PROVIDER, displayName: 'Nucleus', driver: 'acpRegistry', enabled: true, status: 'ready',
  models: [{ slug: PARENT_MODEL, name: 'Nucleus' }],
};

/** The ACP surface: the parent's held turn ends when the service releases it. */
function acpStub(server: Awaited<ReturnType<typeof t3Fake>>) {
  const released: string[] = [];
  const surface: AcpSessionSurface = {
    bind: input => ({ sessionId: `session:${input.taskId}`, taskId: input.taskId, bindingPath: `/synthetic/acp/sessions/${input.taskId}.json` }),
    async turn() { throw new Error('the agent is not driven in this test'); },
    async message() { throw new Error('the agent is not driven in this test'); },
    release(sessionId) {
      released.push(sessionId);
      for (const thread of server.threads.values()) {
        if (thread.thread.providerInstanceId !== PARENT_PROVIDER) continue;
        for (const run of thread.runs) if (['preparing', 'starting', 'running', 'waiting'].includes(run.status)) run.status = 'completed';
      }
    },
  };
  return { surface, released };
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 't3code-one-row-'));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  server.controls.providers = [nucleusProvider, { instanceId: 'synthetic-provider', displayName: 'Synthetic provider', driver: 'codex',
    enabled: true, status: 'ready', models: [{ slug: 'synthetic-model', name: 'Synthetic model' }] }];
  const acp = acpStub(server);
  const host = new T3CodeHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath: join(root, 'state.json'),
    timeoutMs: 2_000, probeThreadId: 'synthetic-probe', acp: () => acp.surface, reentryTimeoutMs: 300 });
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace-intent', directory, project: { projectId: 'synthetic-project' } });
  const spec = (requestId: string, role = 'worker'): HostAgentSpec => ({ workspaceId: workspace.id, profile,
    title: role === 'worker' ? 'Synthetic role' : `${role}: Synthetic role`, taskNumber: 225, mcpBindingPath: null,
    attempt: () => ({ requestId, prompt: role === 'worker' ? 'Worker prompt' : `${role} prompt`,
      labels: storedT3Labels(role, { taskId, runId: `${requestId}-run` }), environment: {} }) });
  /** The task record core hands the adapter with the shared title helper's answer. */
  const task = (overrides: Partial<Task> = {}): Task => ({ id: taskId, number: 225, title: 'Synthetic role', held: false,
    hostId: host.hostId, workspaceId: workspace.id, phase: 'awaiting_review', ...overrides }) as Task;
  const parentOf = () => Object.values(host.state.read().parents ?? {})[0];
  return { root, directory, server, host, workspace, spec, task, acp, parentOf };
}

/** One recorded command by dispatch type, or by method for a launch (which carries no `type`). */
const commandsOf = (server: Awaited<ReturnType<typeof t3Fake>>, type: string) =>
  server.commands.filter(command => (command.type ?? command.method) === type);
const waiting = (cause = 'Waiting on nucleus#1364'): TaskAttention => ({ state: 'waiting', cause });

test('the inbox counts each active task once and excludes waiting, snoozed and finished tasks', async t => {
  const { acp, directory, host, parentOf, server, spec } = await fixture(t);
  const inboxDir = mkdtempSync(join(directory, 'inbox-'));
  acp.surface.bindInbox = ({ hostId }) => ({
    sessionId: 'synthetic-inbox', hostId, directory: inboxDir, bindingPath: join(inboxDir, 'binding'),
  });
  const worker = await host.createAgent(spec('worker-launch'));
  const reviewer = await host.createAgent(spec('reviewer-launch', 'reviewer'));
  const roleThreads = [worker, reviewer].map(role => server.threads.get(role.id)!);
  for (const role of roleThreads) {
    role.runs = [syntheticRun(role.thread.id, 1, { status: 'running' })];
  }

  const otherTask = 'synthetic-other-task';
  await host.reconcileTaskRow(taskId, { state: 'active' });
  await host.reconcileTaskRow(otherTask, waiting());
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  const inboxTitle = () => server.threads.get(inbox.threadId)!.thread.title;
  assert.equal(inboxTitle(), '1 task running');

  await host.reconcileTaskRow(taskId, { state: 'active' });
  await host.reconcileTaskRow(otherTask, { state: 'active' });
  await host.reconcileThreadTitles([]);
  assert.equal(inboxTitle(), '2 tasks running');

  for (const role of roleThreads) {
    role.runs = [syntheticRun(role.thread.id, 1, { status: 'completed' })];
  }
  await host.reconcileTaskRow(taskId, waiting());
  assert.ok(server.threads.get(parentOf()!.threadId)!.thread.snoozedUntil);
  await host.reconcileThreadTitles([]);
  assert.equal(inboxTitle(), '1 task running');

  await host.reconcileTaskRow(otherTask, { state: 'finished' });
  await host.reconcileThreadTitles([]);
  assert.equal(inboxTitle(), 'All quiet');
});

test('the parent row names the step its role children are doing (acceptance 2)', async t => {
  const { host, server, spec, task, parentOf } = await fixture(t);
  await host.createAgent(spec('worker-launch'));
  const parent = parentOf()!;
  const reviewer = await host.createAgent(spec('reviewer-launch', 'reviewer'));
  server.threads.get(reviewer.id)!.runs = [syntheticRun('nightly-review-run', 1, { id: 'nightly-review-run', status: 'running', rootNodeId: 'review-node' })];

  // The reviewer is running: the one row says so, on top of the task's own state title.
  const state = task({ agentId: parent.threadId });
  await host.setTaskWorkspaceTitle(state, taskWorkspaceTitle(state), 'row-title-1', false);
  const titles = () => commandsOf(server, 'thread.metadata.update').filter(command => command.threadId === parent.threadId);
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role · reviewing');
  assert.equal(server.threads.get(parent.threadId)!.thread.title, 'Review: 225 Synthetic role · reviewing');

  // The reviewer asks its own question: the row names that instead.
  const reviewerProjection = server.threads.get(reviewer.id)!;
  reviewerProjection.runs = [];
  reviewerProjection.runtimeRequests = [syntheticRuntimeRequest({ id: 'reviewer-question', status: 'pending', kind: 'user_input' })];
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role · reviewer needs input');

  // The question is answered and the reviewer ends: the row drops the step.
  reviewerProjection.runtimeRequests = [];
  reviewerProjection.runs = [syntheticRun('nightly-review-run', 1, { id: 'nightly-review-run', status: 'completed', rootNodeId: 'review-node' })];
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role');
});

test('a later round writes the same step again under a fresh command identity (acceptance 2)', async t => {
  const { host, server, spec, task, parentOf } = await fixture(t);
  await host.createAgent(spec('worker-launch'));
  const parent = parentOf()!;
  const reviewer = await host.createAgent(spec('reviewer-launch', 'reviewer'));
  const reviewerProjection = server.threads.get(reviewer.id)!;
  const state = task({ agentId: parent.threadId });
  const titles = () => commandsOf(server, 'thread.metadata.update').filter(command => command.threadId === parent.threadId);
  const running = [syntheticRun('nightly-review-run', 1, { id: 'nightly-review-run', status: 'running', rootNodeId: 'review-node' })];
  const ended = [syntheticRun('nightly-review-run', 1, { id: 'nightly-review-run', status: 'completed', rootNodeId: 'review-node' })];

  reviewerProjection.runs = ended;
  await host.setTaskWorkspaceTitle(state, taskWorkspaceTitle(state), 'row-base', false);
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role');

  reviewerProjection.runs = running;
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role · reviewing');
  reviewerProjection.runs = ended;
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role');

  // Round two asks for the same step text again: the row needs a fresh identity, so
  // the previous title is never left on it while the reviewer works.
  reviewerProjection.runs = running;
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role · reviewing');
  assert.equal(new Set(titles().map(command => command.commandId)).size, titles().length);
});

test('a superseded role thread never leaves its fault on the row (acceptance 2)', async t => {
  const { host, server, spec, task, parentOf } = await fixture(t);
  await host.createAgent(spec('worker-launch'));
  const parent = parentOf()!;
  const state = task({ agentId: parent.threadId });
  const titles = () => commandsOf(server, 'thread.metadata.update').filter(command => command.threadId === parent.threadId);
  await host.setTaskWorkspaceTitle(state, taskWorkspaceTitle(state), 'row-base', false);

  const failedRecovery = await host.createAgent(spec('recovery-launch-1', 'recovery'));
  server.threads.get(failedRecovery.id)!.runs = [syntheticRun('recovery-run-1', 1, { id: 'recovery-run-1', status: 'failed', rootNodeId: 'recovery-node-1' })];
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role · blocked: recovery');

  const recovery = await host.createAgent(spec('recovery-launch-2', 'recovery'));
  server.threads.get(recovery.id)!.runs = [syntheticRun('recovery-run-2', 1, { id: 'recovery-run-2', status: 'completed', rootNodeId: 'recovery-node-2' })];
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role', "the superseded thread's fault is dropped");

  server.threads.get(recovery.id)!.runs = [syntheticRun('recovery-run-3', 1, { id: 'recovery-run-3', status: 'running', rootNodeId: 'recovery-node-2' })];
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role · recovery');
});

test('a waiting task snoozes its parent row once, reads the horizon back, and renews before it lapses', async t => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec('worker-launch'));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;

  await host.reconcileTaskRow(taskId, waiting());
  const snoozes = () => commandsOf(server, 'thread.snooze');
  assert.equal(snoozes().length, 1, 'one snooze for one wait');
  const [snooze] = snoozes();
  assert.equal(snooze!.threadId, parent.threadId, 'the parent row is the task row');
  assert.equal(projection.thread.snoozedUntil, snooze!.snoozedUntil, 'the horizon is read back from the thread');
  assert.ok(Date.parse(snooze!.snoozedUntil) > Date.now(), 'the horizon is in the future');
  const record = host.state.read().snoozes?.[parent.threadId];
  assert.equal(record?.state, 'snoozed');
  assert.equal(record?.until, snooze!.snoozedUntil);

  // A repeated pass adds no write: the recorded row is inside its horizon.
  const commands = server.commands.length;
  await host.reconcileTaskRow(taskId, waiting());
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(server.commands.length, commands, 'an unchanged row sends nothing');
  assert.equal(projection.thread.settledOverride, null, 'the row is never settled');

  // The sweep renews before the horizon: a row inside the renew margin gets the
  // next horizon under a fresh command, so the row never wakes itself while the
  // task still waits.
  projection.thread.snoozedUntil = new Date(Date.now() + SNOOZE_RENEW_BEFORE_MS / 2).toISOString();
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(snoozes().length, 2, 'the renewal is one more snooze');
  const renewed = snoozes().at(-1)!;
  assert.notEqual(renewed.commandId, snooze!.commandId);
  assert.ok(Date.parse(renewed.snoozedUntil) - Date.now() > SNOOZE_HORIZON_MS / 2, 'the renewed horizon is a full one');
  assert.equal(projection.thread.snoozedUntil, renewed.snoozedUntil);
});

test('a task that needs a person unsnoozes a row this host snoozed', async t => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec('worker-launch'));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  await host.reconcileTaskRow(taskId, waiting());
  assert.ok(projection.thread.snoozedUntil, 'the row starts snoozed');

  await host.reconcileTaskRow(taskId, { state: 'attention', cause: 'Worker creation refused before send' });
  assert.equal(commandsOf(server, 'thread.unsnooze').length, 1, 'a person who must act surfaces the row');
  assert.equal(projection.thread.snoozedUntil, null);
  assert.equal(projection.thread.settledOverride, null, 'the row is surfaced, never settled');
  assert.equal(host.state.read().snoozes?.[parent.threadId], undefined, 'the snooze record is retired');

  // Already shown: a repeated attention pass sends nothing.
  const commands = server.commands.length;
  await host.reconcileTaskRow(taskId, { state: 'attention', cause: 'Worker creation refused before send' });
  assert.equal(server.commands.length, commands);
});

test("an operator's own settled row is left alone", async t => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec('worker-launch'));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  projection.thread.settledOverride = 'settled';
  projection.thread.settledAt = STAMP;
  const commands = server.commands.length;
  await host.reconcileTaskRow(taskId, waiting());
  await host.reconcileTaskRow(taskId, { state: 'attention', cause: 'Needs a person' });
  assert.equal(server.commands.length, commands, 'neither a snooze nor an unsettle is sent');
  assert.equal(projection.thread.settledOverride, 'settled');
  assert.equal(projection.thread.snoozedUntil, null);
});

test('unknown snooze delivery keeps its identity and a later landed snooze is undone', async t => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec('worker-launch'));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  const until = new Date(Date.now() + SNOOZE_HORIZON_MS).toISOString();
  host.state.update(state => {
    state.snoozes = { ...state.snoozes, [parent.threadId]: {
      episode: 0, commandId: 'unknown-snooze', until, state: 'unknown', recordedAt: STAMP,
    } };
  });
  await host.reconcileTaskRow(taskId, waiting());
  await host.reconcileTaskRow(taskId, { state: 'attention', cause: 'Needs a person' });
  assert.equal(commandsOf(server, 'thread.snooze').length, 0);
  assert.equal(host.state.read().snoozes?.[parent.threadId]?.state, 'unknown');
  projection.thread.snoozedUntil = until;
  await host.reconcileTaskRow(taskId, { state: 'attention', cause: 'Needs a person' });
  assert.equal(commandsOf(server, 'thread.unsnooze').length, 1);
  assert.equal(projection.thread.snoozedUntil, null);
});

test('a later wait can snooze after an unknown send and its horizon expire', async t => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec('worker-launch'));
  const parent = parentOf()!;
  const until = new Date(Date.now() + SNOOZE_HORIZON_MS).toISOString();
  host.state.update(state => {
    state.snoozes = { ...state.snoozes, [parent.threadId]: {
      episode: 0, commandId: 'uncertain-old-wait', until, state: 'unknown', recordedAt: STAMP,
    } };
  });
  await host.reconcileTaskRow(taskId, { state: 'attention', cause: 'Needs a person' });
  assert.equal(host.state.read().snoozes?.[parent.threadId]?.ended, true);
  await host.reconcileTaskRow(taskId, waiting('A later wait'));
  assert.equal(commandsOf(server, 'thread.snooze').length, 0, 'the old send can still land');
  host.state.update(state => { state.snoozes![parent.threadId]!.until = STAMP; });
  await host.reconcileTaskRow(taskId, waiting('A later wait'));
  assert.equal(commandsOf(server, 'thread.snooze').length, 1);
  assert.equal(host.state.read().snoozes?.[parent.threadId]?.state, 'snoozed');
});

test('re-entry leaves a manually settled parent untouched', async t => {
  const { host, server, spec, parentOf, acp } = await fixture(t);
  await host.createAgent(spec('worker-launch'));
  const parent = parentOf()!;
  acp.surface.release(`session:${taskId}`, "test");
  server.threads.get(parent.threadId)!.thread.settledOverride = 'settled';
  const before = server.commands.length;
  await assert.rejects(host.createAgent(spec('reviewer-launch', 'reviewer')), /settled/i);
  assert.equal(server.commands.slice(before).some(command => command.type === 'thread.unsettle' || command.type === 'message.dispatch'), false);
});

test('a snooze refused for a pending approval stays active with no retry loop', async t => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec('worker-launch'));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  projection.runtimeRequests = [syntheticRuntimeRequest({ id: 'parent-approval', status: 'pending', kind: 'permission' })];

  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(commandsOf(server, 'thread.snooze').length, 1, 'the refused snooze was sent once');
  assert.equal(projection.thread.snoozedUntil, null, 'the row stays active');
  assert.equal(host.state.read().snoozes?.[parent.threadId]?.state, 'unknown');

  // The same wait keeps the row active: this episode never retries.
  const commands = server.commands.length;
  await host.reconcileTaskRow(taskId, waiting());
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(server.commands.length, commands, 'a refused snooze is not retried for the same wait');
});

test('Nucleus never settles a task thread, on any decision', async t => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec('worker-launch'));
  const reviewer = await host.createAgent(spec('reviewer-launch', 'reviewer'));
  assert.ok(parentOf());
  for (const attention of [waiting(), { state: 'active' } as TaskAttention, { state: 'attention', cause: 'Needs a person' } as TaskAttention, { state: 'finished' } as TaskAttention])
    await host.reconcileTaskRow(taskId, attention);
  assert.equal(commandsOf(server, 'thread.settle').length, 0);
  assert.equal(commandsOf(server, 'thread.snooze').length, 1, 'the waiting decision snoozed once');
  assert.ok(reviewer.id);
});

test('a role whose create refuses launches no top-level thread and names the fix', async t => {
  const { host, server, parentOf, workspace } = await fixture(t);
  server.controls.providers = [{ instanceId: 'synthetic-provider', displayName: 'Synthetic provider', driver: 'codex',
    enabled: true, status: 'ready', models: [{ slug: 'synthetic-model', name: 'Synthetic model' }] }];
  await assert.rejects(
    () => host.createAgent({ workspaceId: workspace.id, profile, title: 'Synthetic role', taskNumber: 225, mcpBindingPath: null,
      attempt: () => ({ requestId: 'refused-launch', prompt: 'Worker prompt', labels: storedT3Labels('worker', { taskId }), environment: {} }) }),
    (error: unknown) => error instanceof Error && /T3 provider not ready: .*run `nucleus t3 install`/.test(error.message),
  );
  assert.equal(commandsOf(server, 'orchestration.launchThread').length, 0, 'nothing is launched');
  assert.equal(parentOf(), undefined);
});
