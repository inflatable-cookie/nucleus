import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs } from './support/render';
import { Store } from '../core/store/store';
import { submissionSchema, taskSummarySchema } from '../shared/contracts';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { createTaskDetailCache } from '../core/telemetry/task-detail';

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => '#000' }) as never;
const head = 'a'.repeat(40);
const repo = { origin: 'owner/app', path: '/app' };
const project = { key: 'app', name: 'App', repositories: [repo], primary: repo };

async function settle(probe: () => boolean, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('the surface did not settle');
}

/**
 * Task 538: a task waiting on the operator shows the native question and its
 * answer controls in the detail, not only in the thread's pill. The answer goes
 * through the same native request, so Queue observes one resolution.
 */
test('task detail shows a pending native question and answers it in place', async () => {
  const queue = await import('../client/queue');
  const { registerNativeQuestionPills } = await import('../client/native-questions');
  const store = new Store(':memory:');
  let stopPills: (() => void) | undefined;
  let mounted: ReturnType<typeof mount> | undefined;
  try {
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'question-task', title: 'Question task', repoPath: '/app', planningCommit: head, handoffPath: 'question-task.md', originAgentId: 'origin' }), 'host', 'handoff', head);
    const task = store.update(inserted.id, { phase: 'needs_attention', reason: 'Waiting for the operator', agentId: 'worker', workspaceId: 'workspace' });
    const read = createTaskDetailCache(store);

    let pending: unknown[] = [{ id: 'permission-1', kind: 'question', input: { questions: [
      { header: 'Approach', question: 'Which approach should the worker take?', options: [{ label: 'Rewrite the parser' }, { label: 'Patch the parser' }] },
    ] } }];
    const answers: unknown[] = [];
    const agent = () => ({ id: 'worker', workspaceId: 'workspace', pendingPermissions: pending });
    const paseoClient = { agents: {
      list: async () => ({ entries: [{ agent: agent() }], pageInfo: { hasMore: false } }),
      ref: () => ({ refresh: async () => ({ agent: agent() }), respondToPermission: async (input: unknown) => { answers.push(input); pending = []; } }),
    }, addComposerPill: () => ({ remove() {}, update() {} }) } as never;
    stopPills = registerNativeQuestionPills(paseoClient, 10);

    const summary = taskSummarySchema.parse({
      id: task.id, title: 'Question task', repoPath: '/app', version: task.version, number: null, reference: null, entrypoint: 'worker',
      phase: 'needs_attention', reason: 'Waiting for the operator', held: false, parked: true, dependsOn: [], queuePriority: 0,
      profile: null, prUrl: null, resumePrNumber: null, completionPrNumber: null, originError: '', originLookupError: '',
      lanes: [], disposition: null, resolution: { attention: true, mergedCommit: null },
    });
    let boardRevision = 1;
    const board = {
      revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: true,
      activeWorkers: 0, unsettled: 0, occupiedSlots: 0, globalLimit: 32, projectLimit: 5,
      tasks: [summary], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
      lanes: [], projects: [project], prStates: {},
    };
    const invoke = async (method: string) => {
      if (method === 'queue.ui-snapshot') return { ...board, revision: boardRevision };
      if (method === 'queue.service-state') return { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };
      if (method === 'queue.detail') return read(task.id);
      if (method === 'task.next') return ownerTaskNext(collectOwnerVerbFacts(store, store.task(task.id)));
      if (method === 'project.qa.list' || method === 'host.run.list') return [];
      if (method === 'host.run.board') return { runs: [], accounting: { readAt: new Date().toISOString(), entries: [], complete: true } };
      if (method === 'lead.board') return { cards: [], links: [] };
      if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list' || method === 'project.owner-candidates') return [];
      return {};
    };
    const client = new QueryClient();
    const tree = mount(h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, { invoke: invoke as never,
        children: h(queue.MainSurface as never, { theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } }) }),
    }));
    mounted = tree;
    await settle(() => tree.text().includes('Question task'));
    tree.press(/Question task/);
    await settle(() => tree.text().includes('Waiting for your answer'));
    await settle(() => tree.query('Task detail sections')?.props.accessibilityRole === 'tablist');
    assert.equal(tree.query('Overview')?.props.accessibilityState.selected, true, 'the dialog opens on its Overview tab');
    assert.match(tree.text(), /Which approach should the worker take\?/, 'the detail shows the question the task waits on');
    assert.match(tree.text(), /worker asked/, 'the detail names the thread that asked');
    assert.equal(tree.query('Submit answer')!.props.accessibilityState.disabled, true, 'an unanswered question cannot be submitted');
    tree.press('Technical');
    assert.equal(tree.query('Technical')?.props.accessibilityState.selected, true, 'the Technical tab is selected');
    assert.match(tree.text(), /Which approach should the worker take\?/, 'the pending answer stays visible outside Overview');
    assert.ok(tree.query('Submit answer'), 'the answer control stays available outside Overview');
    boardRevision = 2;
    await client.refetchQueries({ queryKey: ['nucleus', 'state'], exact: true });
    await settle(() => client.getQueryData<{ revision: number }>(['nucleus', 'state'])?.revision === 2);
    assert.equal(tree.query('Technical')?.props.accessibilityState.selected, true, 'a board refresh preserves the selected tab');
    // The offered choices are the native request's own options, as buttons.
    tree.press('Answer Approach: Patch the parser');
    assert.equal(tree.query('Submit answer')!.props.accessibilityState.disabled, false);
    tree.press('Submit answer');
    await settle(() => answers.length === 1);
    assert.deepEqual(answers[0], { requestId: 'permission-1', response: { behavior: 'allow', updatedInput: { answers: { Approach: 'Patch the parser' } } } });
  } finally {
    mounted?.update(h('View', null));
    stopPills?.();
    store.close();
  }
});
