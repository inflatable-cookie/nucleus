import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs } from './support/render';
import { Store } from '../core/store/store';
import { submissionSchema, taskNextSchema, taskNextVerbSchema, taskSummarySchema, type TaskNext } from '../shared/contracts';
import { createTaskDetailCache } from '../core/telemetry/task-detail';

// Task Overview (UI lane step 3): the wait, its owner, the next action and the owner
// verbs that apply, with the refusal for each suggested verb that does not. The
// rendered tree is read through the render helper at a narrow and a wide layout.
useNativeStubs();
type QueueModule = typeof import('../client/queue');
let queue: QueueModule;
const load = async () => {
  queue = await import('../client/queue');
  return queue;
};

const h = React.createElement;
/** Dark-theme palette: every themed style resolves to one of these tokens. */
const dark = {
  accent: '#1f6feb', accentForeground: '#ffffff', surface0: '#0d1117', surface1: '#161b22',
  surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e',
  statusWarning: '#f0883e', statusDanger: '#f85149',
} as const;
const c = dark as never;
const head = 'a'.repeat(40), at = '2026-10-27T00:00:00.000Z';
const workerProfile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test/worker', notes: '', available: true, problem: '', supportedThinking: [] };
const repo = { origin: 'owner/app', path: '/app' };
const project = { key: 'app', name: 'App', repositories: [repo], primary: repo };
const TITLE = 'Decide whether the retained reviewer restarts';
const LONG_DETAIL = 'The operator decides whether the retained reviewer restarts after the stalled turn, and the record keeps the observed evidence for that restart and for every refusal so the decision can be audited later without reading the whole thread again.';

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('the surface did not settle');
}

const summaryOf = (overrides: Record<string, unknown>) => taskSummarySchema.parse({
  id: 'task', title: TITLE, repoPath: '/app', version: 1, number: null, reference: null, entrypoint: 'worker',
  phase: 'needs_attention', reason: 'Waiting for the operator', held: false, parked: false, dependsOn: [], queuePriority: 0,
  profile: null, prUrl: null, resumePrNumber: null, completionPrNumber: null, originError: '', originLookupError: '',
  lanes: [], disposition: null, resolution: { attention: true, mergedCommit: null }, ...overrides,
});
const board = (tasks: ReturnType<typeof summaryOf>[]) => ({
  revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: true,
  activeWorkers: 0, unsettled: 0, occupiedSlots: 0, globalLimit: 32, projectLimit: 5,
  tasks, profiles: [workerProfile], pool: [{ profileId: workerProfile.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] }],
  availability: [], assignments: {}, recentAssignments: {}, lanes: [], projects: [project], prStates: {},
});
const serviceState = { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };

/** A `task.next` reading for a task waiting on the operator: restart applies, move and route are refused. */
function waitingNext(taskId: string, overrides: Record<string, unknown> = {}): TaskNext {
  return taskNextSchema.parse({
    taskId, title: TITLE, phase: 'needs_attention', version: 1, repository: 'owner/app', number: null, reference: null,
    attention: true, reason: 'Waiting for the operator', activeRun: null, prHead: null, prUrl: null, branch: 'ns-task',
    stop: { kind: 'attention', reason: 'operator_needed', detail: LONG_DETAIL, since: at, suggestedVerbs: ['restart', 'route', 'move'], owner: 'operator', evidence: null },
    outcome: {
      accepted: null, reported: null, impediment: null, impediments: [], reader: null, authorResult: null,
      decision: 'Nothing outstanding', revision: { runs: 0, budget: 3, exhausted: false },
    },
    holds: {},
    verbs: [
      taskNextVerbSchema.parse({ verb: 'restart', action: 'restart', available: true, args: { action: 'restart', taskId, version: 1 } }),
      taskNextVerbSchema.parse({ verb: 'move', action: 'move', available: false, refusal: 'Moving to work requires the task author' }),
      taskNextVerbSchema.parse({ verb: 'route', action: 'route', available: false, refusal: 'No eligible worker profile is enabled' }),
    ],
    ...overrides,
  }) as TaskNext;
}

function mountBoard(invoke: (method: string, input: unknown) => Promise<unknown>, compact: boolean) {
  const surfaceProps = { theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact, platform: 'ios' as const } };
  // Queries do not retry, so a failed read settles into its error state at once.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mount(h(QueryClientProvider, {
    client,
    children: h(PluginRpcProvider, { invoke, children: h(queue.MainSurface as never, surfaceProps) }),
  }));
}

/** A parked task on the board, opened on its Overview tab through the real detail read. */
function setup(readNext: (taskId: string) => Promise<unknown>) {
  const store = new Store(':memory:');
  store.setMeta('paused', false);
  const inserted = store.insert(submissionSchema.parse({ submissionId: 'overview', title: TITLE, repoPath: '/app', planningCommit: head, handoffPath: 'overview.md', originAgentId: 'origin' }), 'host', 'handoff', head);
  const task = store.update(inserted.id, { phase: 'needs_attention', reason: 'Waiting for the operator' });
  const read = createTaskDetailCache(store);
  const invoke = async (method: string, input: unknown) => {
    if (method === 'queue.ui-snapshot') return board([summaryOf({ id: task.id, phase: 'needs_attention', parked: true, resolution: { attention: true, mergedCommit: null } })]);
    if (method === 'queue.service-state') return serviceState;
    if (method === 'queue.detail') return read(task.id);
    if (method === 'task.next') return readNext(task.id);
    if (method === 'project.qa.list' || method === 'host.run.list') return [];
    if (method === 'host.run.board') return { runs: [], accounting: { readAt: at, entries: [], complete: true } };
    if (method === 'lead.board') return { cards: [], links: [] };
    if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list' || method === 'project.owner-candidates') return [];
    void input;
    return {};
  };
  return { store, task, invoke };
}

async function openOverview(tree: ReturnType<typeof mountBoard>) {
  await settle(() => tree.text().includes(TITLE));
  tree.press(new RegExp(TITLE));
  await settle(() => Boolean(tree.query(/^Wait: /)));
}

for (const compact of [false, true]) {
  const layout = compact ? 'narrow' : 'wide';
  test(`the Overview leads with the wait, its owner, the next action and the owner verbs that apply at a ${layout} layout`, async () => {
    await load();
    let mounted: ReturnType<typeof mountBoard> | undefined;
    const { store, invoke } = setup(async taskId => waitingNext(taskId));
    try {
      mounted = mountBoard(invoke, compact);
      await openOverview(mounted);
      // The wait line says the state, its owner and next action in one accessible label.
      const wait = mounted.query(/^Wait: /);
      assert.match(String(wait?.props.accessibilityLabel), /^Wait: .+; owner .+; next .+$/, 'the wait names state, owner and next action');
      assert.match(mounted.text(), /Owner · operator/);
      assert.match(mounted.text(), /Next · /);
      // The stop's line keeps its category, reason and detail, and the age of the stop.
      assert.ok(mounted.query(`Stop: attention; operator_needed; ${LONG_DETAIL}`), 'the stop line names its category, reason and full detail');
      // Owner verbs that apply are actions; a suggested verb that does not apply says why.
      assert.ok(mounted.query('restart'), 'the available restart is an action');
      assert.ok(mounted.text().includes('Suggested, not available now'), 'the refusals have a heading');
      assert.ok(mounted.query('move not available: Moving to work requires the task author'), 'the refused move names its refusal');
      assert.ok(mounted.query('route not available: No eligible worker profile is enabled'), 'the refused route names its refusal');
      assert.equal(mounted.all(/unavailable/).length, 0, 'no refused verb is offered as an action');
      // The Overview does not repeat the full verb reference; it stays on Technical.
      assert.equal(mounted.text().includes('Owner verbs'), false, 'the verb reference is not on the Overview');
      // The wait is not repeated on the Technical tab.
      mounted.press('Technical');
      await settle(() => mounted!.query('Technical')?.props.accessibilityState.selected === true);
      assert.ok(mounted.query(/^move: unavailable, Moving to work requires the task author/), 'the full verb reference stays on Technical');
      assert.equal(mounted.all(/^Wait state: /).length, 0, 'the wait state is not repeated on Technical');
    } finally {
      mounted?.update(h('View', null));
      store.close();
    }
  });
}

test('while the owner verbs are being read, the Overview keeps the wait it already knows and says the verbs are loading', async () => {
  await load();
  let mounted: ReturnType<typeof mountBoard> | undefined;
  const { store, invoke } = setup(() => new Promise(() => undefined));
  try {
    mounted = mountBoard(invoke, false);
    await openOverview(mounted);
    // The task's stored reason stands in for the stop until the read arrives.
    assert.match(String(mounted.query(/^Wait: /)?.props.accessibilityLabel), /^Wait: .+; owner .+; next .+$/, 'the wait is still named while the verbs load');
    assert.ok(mounted.query('Reading owner verbs'), 'the loading state is named');
    assert.ok(mounted.text().includes('Reading owner verbs…'));
    assert.equal(mounted.all('Retry reading owner verbs').length, 0, 'no retry is offered while the read is in flight');
  } finally {
    mounted?.update(h('View', null));
    store.close();
  }
});

test('a failed read names the failure and retries from the same control', async () => {
  await load();
  let mounted: ReturnType<typeof mountBoard> | undefined;
  let reads = 0;
  let fail = true;
  const { store, invoke } = setup(async taskId => {
    reads++;
    if (fail) throw new Error('Queue did not answer the owner-verb read');
    return waitingNext(taskId);
  });
  try {
    mounted = mountBoard(invoke, false);
    await openOverview(mounted);
    await settle(() => Boolean(mounted!.query('Retry reading owner verbs')));
    assert.ok(mounted.text().includes('Owner verbs could not be read: Queue did not answer the owner-verb read'), 'the failed operation is named');
    assert.equal(mounted.all('restart').length, 0, 'no action is offered from a failed read');
    const readsBeforeRetry = reads;
    fail = false;
    mounted.press('Retry reading owner verbs');
    await settle(() => Boolean(mounted!.query('restart')));
    assert.ok(reads > readsBeforeRetry, 'the retry reads again');
    assert.equal(mounted.all('Retry reading owner verbs').length, 0);
  } finally {
    mounted?.update(h('View', null));
    store.close();
  }
});
