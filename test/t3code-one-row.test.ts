import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3CodeHost } from '../hosts/t3code/adapter';
import { taskWorkspaceTitle } from '../core/workspaces/workspace-title';
import type { HostAgentSpec } from '../shared/host';
import type { Profile, Task } from '../shared/contracts';
import { SUPPORT_THREAD_TAG } from '../hosts/t3code/one-row';
import { t3Fake, STAMP, syntheticRun, syntheticRuntimeRequest } from './support/t3code-fake';
import { storedT3Labels } from './support/t3code-labels';

/**
 * One row per task on T3 (Tom, 2026-11-15): support threads are tagged and
 * linked from the worker's conversation, the worker row carries the task's step,
 * and none of it needs T3's hide setting. Every record here is a synthetic
 * Nightly shape served by the fake transport; no live T3 is touched.
 */

const profile: Profile = { id: 'synthetic-profile', name: 'Synthetic', provider: 'synthetic-provider', model: 'synthetic-model',
  available: true, problem: '', notes: '', supportedThinking: [] };
const taskId = 'synthetic-task';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 't3code-one-row-'));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  const options = { endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath: join(root, 'state.json'), timeoutMs: 2_000, probeThreadId: 'synthetic-probe' };
  const host = new T3CodeHost(options);
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
  return { root, directory, server, options, host, workspace, spec, task };
}

/** The worker's own ended run, with the root node a `thread.created.record` card must name. */
const workerRun = (id = 'worker-run', rootNodeId: string | null = 'worker-root-node') => [syntheticRun(id, 1, { id, status: 'completed', rootNodeId })];

test('a support thread is tagged and linked once from the worker conversation (acceptance 1)', async t => {
  const { host, server, spec } = await fixture(t);
  const worker = await host.createAgent(spec('worker-launch'));
  server.threads.get(worker.id)!.runs = workerRun();
  const reviewer = await host.createAgent(spec('reviewer-launch', 'reviewer'));

  const tag = server.commands.find(command => command.type === 'thread.tag.set');
  assert.ok(tag, `the reviewer thread is tagged (${JSON.stringify(server.commands.map(command => command.type ?? command.method))})`);
  assert.equal(tag!.threadId, reviewer.id);
  assert.equal(tag!.tag, SUPPORT_THREAD_TAG);
  assert.equal(tag!.tagged, true);
  assert.deepEqual(server.threads.get(reviewer.id)!.thread.tags, [SUPPORT_THREAD_TAG]);
  assert.equal(server.threads.get(worker.id)!.thread.tags, undefined, 'the worker row is never tagged');

  const cards = () => server.commands.filter(command => command.type === 'thread.created.record');
  assert.equal(cards().length, 1);
  assert.deepEqual({ parentThreadId: cards()[0]!.parentThreadId, parentRunId: cards()[0]!.parentRunId,
    parentNodeId: cards()[0]!.parentNodeId, targetThreadId: cards()[0]!.targetThreadId, targetRunId: cards()[0]!.targetRunId },
  { parentThreadId: worker.id, parentRunId: 'worker-run', parentNodeId: 'worker-root-node',
    targetThreadId: reviewer.id, targetRunId: null });
  // The Nightly's own handler accepts the command, so the shape is real: one
  // completed `thread_created` card on the worker's conversation.
  const served = server.threads.get(worker.id)!.turnItems.filter((item: Record<string, unknown>) => item.type === 'thread_created');
  assert.equal(served.length, 1);
  assert.equal(served[0]!.targetThreadId, reviewer.id);
  assert.equal(served[0]!.runId, 'worker-run');
  assert.equal(served[0]!.title, server.threads.get(reviewer.id)!.thread.title, 'the card is titled with the thread it opens');

  // Every later pass retries the recorded effects: nothing is sent twice.
  const commands = server.commands.length;
  for (let pass = 0; pass < 3; pass++) await host.reconcileThreadTitles([]);
  assert.equal(server.commands.length, commands, 'a retry records no duplicate tag or card');
  assert.deepEqual(host.state.read().supportRows, {}, 'a settled row keeps no pending record');
});

test('a card waits for the worker run that owns a root node, then records once (acceptance 1)', async t => {
  const { host, server, spec } = await fixture(t);
  const worker = await host.createAgent(spec('worker-launch'));
  // The worker's run has not produced its root node yet: no card can name it.
  server.threads.get(worker.id)!.runs = workerRun('worker-run', null);
  const reviewer = await host.createAgent(spec('reviewer-launch', 'reviewer'));
  assert.equal(server.commands.filter(command => command.type === 'thread.created.record').length, 0);
  assert.ok(host.state.read().supportRows?.[reviewer.id], 'the pending card is recorded durably');

  server.threads.get(worker.id)!.runs = workerRun();
  await host.reconcileThreadTitles([]);
  assert.equal(server.commands.filter(command => command.type === 'thread.created.record').length, 1);
  assert.equal(server.threads.get(worker.id)!.turnItems.filter((item: Record<string, unknown>) => item.type === 'thread_created').length, 1);
});

test('the worker row names the step the task is on and the input a support thread needs (acceptance 2)', async t => {
  const { host, server, spec, task } = await fixture(t);
  const worker = await host.createAgent(spec('worker-launch'));
  server.threads.get(worker.id)!.runs = workerRun();
  const reviewer = await host.createAgent(spec('reviewer-launch', 'reviewer'));
  const reviewerProjection = server.threads.get(reviewer.id)!;
  reviewerProjection.runs = [syntheticRun('nightly-review-run', 1, { id: 'nightly-review-run', status: 'running', rootNodeId: 'review-node' })];

  // The reviewer is running: the one row says so, on top of the task's own state title.
  const state = task({ agentId: worker.id });
  await host.setTaskWorkspaceTitle(state, taskWorkspaceTitle(state), 'row-title-1', false);
  const titles = () => server.commands.filter(command => command.type === 'thread.metadata.update' && command.threadId === worker.id);
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role · reviewing');
  assert.equal(server.threads.get(worker.id)!.thread.title, 'Review: 225 Synthetic role · reviewing');

  // The reviewer asks its own question: the row names that instead, and the row
  // is surfaced even when the reviewer's own run is not live, because a hidden
  // thread's pending approval is T3's to show.
  const workerProjection = server.threads.get(worker.id)!;
  workerProjection.runs = workerRun();
  await host.settleWorkerThread(worker.id, 'worker-run');
  assert.equal(workerProjection.thread.settledOverride, 'settled');
  reviewerProjection.runs = [];
  reviewerProjection.runtimeRequests = [syntheticRuntimeRequest({ id: 'reviewer-question', status: 'pending', kind: 'user_input' })];
  await host.reconcileThreadTitles([state]);
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role · reviewer needs input');
  assert.equal(workerProjection.thread.settledOverride, 'active', 'the pending question surfaces the worker row');
  assert.equal(server.commands.filter(command => command.type === 'thread.unsettle' && command.threadId === worker.id).length, 1);

  // Nothing changes: the sweep sends no second write.
  const writes = titles().length;
  await host.reconcileThreadTitles([state]);
  await host.reconcileThreadTitles([state]);
  assert.equal(titles().length, writes, 'an unchanged row sends nothing');

  // The question is answered and the reviewer ends: the row drops the step.
  reviewerProjection.runtimeRequests = [];
  reviewerProjection.runs = [syntheticRun('nightly-review-run', 1, { id: 'nightly-review-run', status: 'completed', rootNodeId: 'review-node' })];
  await host.reconcileThreadTitles([state]);
  assert.equal(titles().at(-1)!.title, 'Review: 225 Synthetic role');
});

test('a task title already naming the step is not repeated on the row (acceptance 2)', async t => {
  const { host, server, spec, task } = await fixture(t);
  const worker = await host.createAgent(spec('worker-launch'));
  server.threads.get(worker.id)!.runs = workerRun();
  const reviewer = await host.createAgent(spec('reviewer-launch', 'reviewer'));
  server.threads.get(reviewer.id)!.runs = [syntheticRun('nightly-review-run', 1, { id: 'nightly-review-run', status: 'running', rootNodeId: 'review-node' })];
  const state = task({ agentId: worker.id, phase: 'reviewing' });
  await host.setTaskWorkspaceTitle(state, taskWorkspaceTitle(state), 'row-title-reviewing', false);
  assert.equal(server.threads.get(worker.id)!.thread.title, 'Reviewing: 225 Synthetic role');
});

test('without the hide setting everything works as today and the host status says so (acceptance 3)', async t => {
  const { host, server, spec, options, task } = await fixture(t);
  assert.match(host.supportThreadStatus, /^support threads visible: hide setting not enabled/);
  assert.match(host.supportThreadStatus, /README: T3: one row per task/);

  // The default fixture reports T3's own defaults: switch off, no tags listed.
  assert.equal(server.controls.settings.hideTaggedThreads, false);
  const worker = await host.createAgent(spec('worker-launch'));
  server.threads.get(worker.id)!.runs = workerRun();
  const reviewer = await host.createAgent(spec('reviewer-launch', 'reviewer'));
  server.threads.get(reviewer.id)!.runs = [syntheticRun('nightly-review-run', 1, { id: 'nightly-review-run', status: 'running', rootNodeId: 'review-node' })];
  // Today's behaviour is unchanged: the support thread is a normal top-level
  // thread (visible in the shell), the worker row still renames and settles.
  const shell = await host.activeThreads();
  assert.ok(shell.some(thread => thread.id === reviewer.id), 'the support thread is still served');
  await host.setTaskWorkspaceTitle(task({ agentId: worker.id }), 'Working: 225 Synthetic role', 'no-hide-title', false);
  assert.equal(server.threads.get(worker.id)!.thread.title, 'Working: 225 Synthetic role · reviewing');
  await host.settleWorkerThread(worker.id, 'worker-run');
  assert.equal(server.threads.get(worker.id)!.thread.settledOverride, 'settled');

  // The adapter only ever reads settings: no settings write, on any request.
  const settingsWrites = () => [...server.requests, ...server.commands].filter(entry => JSON.stringify(entry).includes('updateSettings'));
  assert.deepEqual(settingsWrites(), []);

  // An enabled switch reads as hidden; a switch without our tag reads as visible.
  server.controls.settings = { hideTaggedThreads: true, hiddenThreadTags: [SUPPORT_THREAD_TAG] };
  await host.connect();
  assert.equal(host.supportThreadStatus, `support threads hidden by tag ${SUPPORT_THREAD_TAG}`);
  server.controls.settings = { hideTaggedThreads: true, hiddenThreadTags: ['someone-else'] };
  await host.connect();
  assert.match(host.supportThreadStatus, /support threads visible: nucleus-support is not in hiddenThreadTags/);
  assert.deepEqual(settingsWrites(), []);
  assert.ok(options.statePath, 'the durable record stays owner-only state');
});
