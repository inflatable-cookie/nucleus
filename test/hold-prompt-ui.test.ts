import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs } from './support/render';
import { Store } from '../core/store/store';
import { submissionSchema, taskSummarySchema } from '../shared/contracts';

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => '#000' }) as never;
const repo = { origin: 'owner/app', path: '/app' };
const project = { key: 'app', name: 'App', repositories: [repo], primary: repo };

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('the surface did not settle');
}
/**
 * A local transactional control answers with the updated task, so the mock hands
 * back a real stored row: `{}` fails the method's output union, and `act` then
 * reports a failed control and never refetches the board it just changed.
 */
const heldTask = (() => {
  const store = new Store(':memory:');
  const inserted = store.insert(submissionSchema.parse({
    submissionId: 'held-task', title: 'Held reviewed task', repoPath: '/app', planningCommit: 'a'.repeat(40),
    handoffPath: 'held-task.md', originAgentId: 'agent-1',
  }), 'host', 'handoff', 'a'.repeat(40));
  return store.update(inserted.id, { phase: 'verifying', reason: 'Merge held by operator; release to continue' });
})();
const summary = (escalated: boolean) => taskSummarySchema.parse({
  id: 'held-task', title: 'Held reviewed task', repoPath: '/app', version: 4, number: null, reference: null, entrypoint: 'worker',
  phase: 'verifying', reason: 'Merge held by operator; release to continue', held: true, holdKind: 'merge', parked: false, dependsOn: [], queuePriority: 0, profile: null,
  prUrl: null, resumePrNumber: null, completionPrNumber: null, originError: '', originLookupError: '', lanes: [], disposition: null,
  resolution: { attention: false, mergedCommit: null },
  hold: { owner: 'agent-1', reason: 'External receipt pending', since: '2026-10-02T08:00:00.000Z' }, ...(escalated ? { holdEscalated: true } : {}),
});

test('Spec 040 row 7: an escalated hold appears in Pipeline; Release and Keep act there and Keep asks for a reason', async () => {
  const queue = await import('../client/queue');
  let escalated = true, revision = 1;
  const calls: Record<string, unknown>[] = [];
  const board = () => ({
    revision: escalated ? revision++ : 1000, connected: true, hostId: 'host', paused: false, error: '', quiet: true, activeWorkers: 0, unsettled: 0, occupiedSlots: 0, globalLimit: 32, projectLimit: 5,
    tasks: [summary(escalated)], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {}, lanes: [], projects: [project], prStates: {},
  });
  const invoke = async (method: string, input: unknown) => {
    if (method === 'queue.ui-snapshot') return board();
    if (method === 'queue.service-state') return { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };
    if (method === 'queue.task') { calls.push(input as Record<string, unknown>); escalated = false; return heldTask; }
    if (method === 'project.qa.list' || method === 'host.run.list') return [];
    if (method === 'host.run.board') return { runs: [], accounting: { readAt: '2026-10-02T08:00:00.000Z', entries: [], complete: true } };
    if (method === 'lead.board') return { cards: [], links: [] };
    if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list') return [];
    return {};
  };
  const surfaceProps = { theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } };
  const tree = mount(h(QueryClientProvider, { client: new QueryClient(), children: h(PluginRpcProvider, { invoke, children: h(queue.MainSurface as never, surfaceProps) }) }));
  await settle(() => tree.text().includes('Ready to merge, held for External receipt pending'));
  assert.match(tree.text(), /owner agent-1/);
  // Keep needs a reason: the confirm button stays disabled until one is typed.
  tree.press('Keep');
  assert.equal(tree.get('Keep hold').props.disabled, true);
  tree.type('Why keep the hold (required)', 'Receipt arrives tonight');
  assert.notEqual(tree.get('Keep hold').props.disabled, true);
  tree.press('Keep hold');
  await settle(() => calls.length === 1);
  assert.deepEqual(calls[0], { taskId: 'held-task', version: 4, action: 'keep_hold', reason: 'Receipt arrives tonight' });
  await settle(() => tree.query(/^Held merge: Held reviewed task$/) === undefined);
  assert.equal(tree.query(/^Held merge:/), undefined, 'the Queue-raised item clears from Pipeline without a reload');
});

test('Spec 040: Release from Pipeline sends the release action', async () => {
  const queue = await import('../client/queue');
  let escalated = true, revision = 1;
  const calls: Record<string, unknown>[] = [];
  const invoke = async (method: string, input: unknown) => {
    if (method === 'queue.ui-snapshot') return {
      revision: escalated ? revision++ : 1000, connected: true, hostId: 'host', paused: false, error: '', quiet: true, activeWorkers: 0, unsettled: 0, occupiedSlots: 0, globalLimit: 32, projectLimit: 5,
      tasks: [summary(escalated)], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {}, lanes: [], projects: [project], prStates: {},
    };
    if (method === 'queue.service-state') return { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };
    if (method === 'queue.task') { calls.push(input as Record<string, unknown>); escalated = false; return heldTask; }
    if (method === 'project.qa.list' || method === 'host.run.list') return [];
    if (method === 'host.run.board') return { runs: [], accounting: { readAt: '2026-10-02T08:00:00.000Z', entries: [], complete: true } };
    if (method === 'lead.board') return { cards: [], links: [] };
    if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list') return [];
    return {};
  };
  const surfaceProps = { theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } };
  const tree = mount(h(QueryClientProvider, { client: new QueryClient(), children: h(PluginRpcProvider, { invoke, children: h(queue.MainSurface as never, surfaceProps) }) }));
  await settle(() => Boolean(tree.query('Release')));
  tree.press('Release');
  await settle(() => calls.length === 1);
  assert.deepEqual(calls[0], { taskId: 'held-task', version: 4, action: 'release' });
  await settle(() => tree.query(/^Held merge: Held reviewed task$/) === undefined);
});
