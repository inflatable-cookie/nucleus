import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// The host wraps contributed components with these providers from the SDK's host
// entry; the invoke stub below stands in for the Queue service.
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs } from './support/render';
import { Store } from '../core/store/store';
import { summarizeTask, submissionSchema, taskSummarySchema } from '../shared/contracts';
import { fenceDisposition } from '../core/verbs/disposition';
import { createTaskDetailCache } from '../core/telemetry/task-detail';

useNativeStubs();
type QueueModule = typeof import('../client/queue');
let queue: QueueModule;
const load = async () => {
  queue = await import('../client/queue');
  return queue;
};

const h = React.createElement;
const c = new Proxy({}, { get: () => '#000' }) as never;
const head = 'a'.repeat(40), at = '2026-10-01T00:00:00.000Z';

const repo = { origin: 'owner/app', path: '/app' };
const project = { key: 'app', name: 'App', repositories: [repo], primary: repo };

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('the surface did not settle');
}

test('a backpressured queue.remove surfaces its reason and retry delay and keeps the detail open', async () => {
  await load();
  const store = new Store(':memory:');
  try {
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'removable', title: 'Removable task', repoPath: '/app', planningCommit: head, handoffPath: 'removable.md', originAgentId: 'origin' }), 'host', 'handoff', head);
    const task = store.update(inserted.id, { phase: 'blocked' });
    const read = createTaskDetailCache(store);
    const summary = taskSummarySchema.parse({
      id: task.id, title: 'Removable task', repoPath: '/app', version: task.version, number: null, reference: null, entrypoint: 'worker',
      phase: 'blocked', reason: 'Waiting for the operator', held: false, parked: false, dependsOn: [], queuePriority: 0, profile: null,
      prUrl: null, resumePrNumber: null, completionPrNumber: null, originError: '', originLookupError: '', lanes: [], disposition: null,
      resolution: { attention: false, mergedCommit: null },
    });
    const board = {
      revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: true,
      activeWorkers: 0, unsettled: 0, occupiedSlots: 0, globalLimit: 32, projectLimit: 5,
      tasks: [summary], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
      lanes: [], projects: [project], prStates: {},
    };
    let removeResponse: unknown = {
      backpressured: true, pending: 3, retryAfterMs: 1000,
      reason: 'Queue operation backlog 3 reached the configured bound of 3; retry after the queue drains',
    };
    const invoke = async (method: string, input: unknown) => {
      if (method === 'queue.ui-snapshot') return board;
      if (method === 'queue.service-state') return { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };
      if (method === 'queue.detail') return read(task.id);
      if (method === 'queue.remove') return removeResponse;
      if (method === 'project.qa.list' || method === 'host.run.list' || method === 'host.run.board') return [];
      if (method === 'lead.board') return { cards: [], links: [] };
      if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list') return [];
      void input;
      return {};
    };
    const surfaceProps = { theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } };
    const client = new QueryClient();
    const tree = mount(h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, { invoke, children: h(queue.MainSurface as never, surfaceProps) }),
    }));
    await settle(() => tree.text().includes('Removable task'));
    tree.press(/Removable task/);
    // Task 538: the queue controls live on the Technical tab.
    await settle(() => Boolean(tree.query('Technical')));
    tree.press('Technical');
    await settle(() => Boolean(tree.query('Remove task from queue')));
    tree.press('Remove task from queue');
    await settle(() => tree.text().includes('backpressured'));
    assert.match(tree.text(), /Queue operation backlog 3 reached the configured bound of 3/, 'the banner names the backpressure reason');
    assert.match(tree.text(), /Retry in about 1s/, 'the banner names the retry delay');
    assert.ok(tree.query('Remove task from queue'), 'the detail stays open so the operator can retry');
    // Once the removal settles removed, the same action closes the detail.
    removeResponse = store.update(task.id, { removedAt: new Date().toISOString() });
    tree.press('Remove task from queue');
    await settle(() => !tree.query('Remove task from queue'));
    tree.update(h('View', null));
  } finally { store.close(); }
});

test('task detail offers withdrawal while a cancel has only a pending thread-stop request', async () => {
  await load();
  const store = new Store(':memory:');
  try {
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'withdrawable', title: 'Reversible cancellation', repoPath: '/app', planningCommit: head, handoffPath: 'withdrawable.md', originAgentId: 'origin' }), 'host', 'handoff', head);
    const working = store.update(inserted.id, { phase: 'working', workspaceIntent: true, agentIntent: true, workspaceId: 'worker-workspace', directory: '/missing-worker-workspace', agentId: 'worker' });
    const fenced = fenceDisposition(store, { taskId: working.id, version: working.version, action: 'cancel', reason: 'Duplicate work' });
    const draining = store.update(fenced.id, { disposition: {
      ...fenced.disposition!, status: 'draining',
      effects: [{ kind: 'stop_thread', target: 'worker', intentAt: at, result: null, resultAt: null, uncertain: false }],
    } });
    const read = createTaskDetailCache(store);
    const summary = summarizeTask(draining);
    const board = {
      revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: false,
      activeWorkers: 1, unsettled: 1, occupiedSlots: 1, globalLimit: 32, projectLimit: 5,
      tasks: [summary], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
      lanes: [], projects: [project], prStates: {},
    };
    let withdrawal: unknown;
    const invoke = async (method: string, input: unknown) => {
      if (method === 'queue.ui-snapshot') return board;
      if (method === 'queue.service-state') return { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };
      if (method === 'queue.detail') return read(draining.id);
      if (method === 'queue.task') { withdrawal = input; return store.update(draining.id, { disposition: null }); }
      if (method === 'project.qa.list' || method === 'host.run.list' || method === 'host.run.board') return [];
      if (method === 'lead.board') return { cards: [], links: [] };
      if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list') return [];
      return {};
    };
    const surfaceProps = { theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } };
    const client = new QueryClient();
    const tree = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke, children: h(queue.MainSurface as never, surfaceProps) }) }));
    await settle(() => tree.text().includes('Reversible cancellation'));
    tree.press(/Reversible cancellation/);
    await settle(() => Boolean(tree.query('Technical')));
    tree.press('Technical');
    await settle(() => tree.text().includes('Withdraw cancellation'));
    tree.type('Withdrawal reason (required)', 'Planner reversed the decision');
    tree.press('Withdraw cancellation');
    await settle(() => Boolean(withdrawal));
    assert.deepEqual(withdrawal, { taskId: draining.id, version: draining.version, action: 'withdraw_cancel', reason: 'Planner reversed the decision' });
    tree.update(h('View', null));
  } finally { store.close(); }
});

test('cancelling detail names the interrupted turn and refs pushed after disposition', async () => {
  await load();
  const store = new Store(':memory:');
  try {
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'post-refs', title: 'Release after cancel', repoPath: '/app', planningCommit: head, handoffPath: 'post-refs.md', originAgentId: 'origin' }), 'host', 'handoff', head);
    const working = store.update(inserted.id, { phase: 'working', workspaceIntent: true, agentIntent: true, workspaceId: 'worker-workspace', directory: '/missing-worker-workspace', agentId: 'worker' });
    const fenced = fenceDisposition(store, { taskId: working.id, version: working.version, action: 'cancel', reason: 'Superseded' });
    const draining = store.update(fenced.id, { disposition: {
      ...fenced.disposition!, status: 'draining',
      effects: [{ kind: 'stop_thread', target: 'worker', intentAt: at, result: null, resultAt: null, uncertain: false }],
      postDispositionRefs: [{ ref: 'refs/tags/v0.11.0', sha: 'b'.repeat(40), observedAt: at }],
    } });
    const read = createTaskDetailCache(store);
    const summary = summarizeTask(draining);
    const board = {
      revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: false,
      activeWorkers: 1, unsettled: 1, occupiedSlots: 1, globalLimit: 32, projectLimit: 5,
      tasks: [summary], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
      lanes: [], projects: [project], prStates: {},
    };
    const invoke = async (method: string, input: unknown) => {
      if (method === 'queue.ui-snapshot') return board;
      if (method === 'queue.service-state') return { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };
      if (method === 'queue.detail') return read(draining.id);
      if (method === 'project.qa.list' || method === 'host.run.list' || method === 'host.run.board') return [];
      if (method === 'lead.board') return { cards: [], links: [] };
      if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list') return [];
      void input;
      return {};
    };
    const surfaceProps = { theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } };
    const client = new QueryClient();
    const tree = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke, children: h(queue.MainSurface as never, surfaceProps) }) }));
    await settle(() => tree.text().includes('Release after cancel'));
    tree.press(/Release after cancel/);
    await settle(() => Boolean(tree.query('Technical')));
    tree.press('Technical');
    await settle(() => tree.text().includes('refs/tags/v0.11.0'));
    assert.match(tree.text(), /The worker turn was interrupted and is still stopping/);
    assert.match(tree.text(), /Refs pushed after disposition: refs\/tags\/v0\.11\.0 bbbbbbbbbbbb/);
    tree.update(h('View', null));
  } finally { store.close(); }
});
