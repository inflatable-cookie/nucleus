import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// The host wraps contributed components with these providers from the SDK's host
// entry; the invoke stub below stands in for the Queue service.
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { boardShellPlugin, mount, useNativeStubs } from './support/render';
import { Store } from '../core/store/store';
import { agentMessageRecordSchema, completionSchema, eventSchema, profileSchema, runSchema, submissionSchema, taskControlInputSchema, taskSummarySchema } from '../shared/contracts';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { createTaskDetailCache } from '../core/telemetry/task-detail';
import { chooseProfile } from '../core/dispatch/routing';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { formatLocalDateTime } from '../shared/date-time';
import { fixture as retainedSourceFixture } from './support/retained-external-merge-fixture';

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
const workerProfile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test/worker', notes: '', available: true, problem: '', supportedThinking: [] };

const repo = { origin: 'owner/app', path: '/app' };
const project = { key: 'app', name: 'App', repositories: [repo], primary: repo };

async function settle(probe: () => boolean, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('the surface did not settle');
}

/** Select the named detail tab before inspecting its content. */
async function selectDetailTab(tree: ReturnType<typeof mountBoard>, title: string) {
  await settle(() => tree.query(title)?.props.accessibilityRole === 'tab');
  if (!tree.query(title)?.props.accessibilityState?.selected) tree.press(title);
  await settle(() => tree.query(title)?.props.accessibilityState?.selected === true);
}
async function showMoreVerbs(tree: ReturnType<typeof mountBoard>) {
  const more = tree.all(/^Show \d+ further owner verbs$/)[0];
  if (more) tree.press(more.props.accessibilityLabel as string);
  await settle(() => Boolean(tree.all(/^Hide further owner verbs$/)[0]));
}

const summaryOf = (overrides: Record<string, unknown>) => taskSummarySchema.parse({
  id: 'task', title: 'Task', repoPath: '/app', version: 1, number: null, reference: null, entrypoint: 'worker',
  phase: 'needs_attention', reason: 'Waiting for the operator', held: false, parked: false, dependsOn: [], queuePriority: 0,
  profile: null, prUrl: null, resumePrNumber: null, completionPrNumber: null, originError: '', originLookupError: '',
  lanes: [], disposition: null, resolution: { attention: false, mergedCommit: null }, ...overrides,
});
const board = (tasks: ReturnType<typeof summaryOf>[]) => ({
  revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: true,
  activeWorkers: 0, unsettled: 0, occupiedSlots: 0, globalLimit: 32, projectLimit: 5,
  tasks, profiles: [workerProfile], pool: [{ profileId: workerProfile.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] }],
  availability: [], assignments: {}, recentAssignments: {}, lanes: [], projects: [project], prStates: {},
});
const serviceState = { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };

function mountBoard(invoke: (method: string, input: unknown) => Promise<unknown>, compact = false) {
  const surfaceProps = { theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact, platform: 'ios' as const } };
  const client = new QueryClient();
  return mount(h(QueryClientProvider, {
    client,
    children: h(PluginRpcProvider, { invoke, children: h(queue.MainSurface as never, surfaceProps) }),
  }));
}

test('task detail renders the Next section and submits a derived verb with the operator caller', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'parked', title: 'Parked pre-dispatch', repoPath: '/app', planningCommit: head, handoffPath: 'parked.md', originAgentId: 'origin' }), 'host', 'handoff', head);
    const task = store.update(inserted.id, { phase: 'needs_attention', reason: 'Waiting for the operator' });
    const read = createTaskDetailCache(store);
    const calls: unknown[] = [];
    const invoke = async (method: string, input: unknown) => {
      if (method === 'queue.ui-snapshot') return board([summaryOf({ id: task.id, title: 'Parked pre-dispatch', phase: 'needs_attention', parked: true, resolution: { attention: true, mergedCommit: null } })]);
      if (method === 'queue.service-state') return serviceState;
      if (method === 'queue.detail') return read(task.id);
      // The section reads the real registry against the real store, so the
      // buttons are exactly what `task.next` reports for this task.
      if (method === 'task.next') return ownerTaskNext(collectOwnerVerbFacts(store, store.task(task.id)));
      if (method === 'queue.task') {
        calls.push(input);
        return store.update(task.id, { phase: 'queued', reason: 'Requeued through an owner verb' });
      }
      if (method === 'project.qa.list' || method === 'host.run.list' || method === 'host.run.board') return [];
      if (method === 'lead.board') return { cards: [], links: [] };
      if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list' || method === 'project.owner-candidates') return [];
      void input;
      return {};
    };
    const tree = mountBoard(invoke); mounted = tree;
    await settle(() => tree.text().includes('Parked pre-dispatch'));
    tree.press(/Parked pre-dispatch/);
    await settle(() => Boolean(tree.query(/^Wait: /)));
    assert.match(tree.text(), /Waiting for the operator/, 'the summary says what the task waits on');
    assert.ok(tree.query('Stop: attention; operator_needed; Waiting for the operator'), 'the stop line names its category, reason and detail');
    // Task 538: a verb that does not apply is not an action; its refusal stays readable in Technical.
    assert.equal(tree.all(/unavailable/).length, 0, 'no refused verb is offered as an action');
    await selectDetailTab(tree, 'Technical');
    assert.ok(tree.query(/^move: unavailable, move work: Move to work requires the task author/), 'the technical reference names the refusal');
    // Round 4: the parked task restarts with the derived args plus the owner's reason.
    await selectDetailTab(tree, 'Overview');
    tree.press('restart');
    await settle(() => Boolean(tree.query('Reason (required)')));
    tree.type('Reason (required)', 'The operator repaired the planning base');
    const expectedVersion = store.task(task.id).version;
    tree.press('Confirm restart');
    await settle(() => tree.text().includes('Applied restart'));
    const { role: _role, ...submitted } = calls[0] as Record<string, unknown>;
    assert.deepEqual(submitted, { action: 'restart', taskId: task.id, version: expectedVersion, reason: 'The operator repaired the planning base', caller: 'operator (board)' });
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('queued dependency edits submit reference lists and allow an empty list to clear them', async () => {
  await load();
  const store=new Store(':memory:');
  let mounted:ReturnType<typeof mountBoard>|undefined;
  const calls:Array<Record<string,unknown>>=[];
  const task=store.insert(submissionSchema.parse({submissionId:'dependency-form',title:'Edit prerequisites',repoPath:'/app',planningCommit:head,handoffPath:'task.md',originAgentId:'origin'}),'host','handoff',head);
  const read=createTaskDetailCache(store);
  const invoke=async(method:string,input:unknown)=>{
    if(method==='queue.ui-snapshot')return board([summaryOf({id:task.id,title:task.title,phase:'queued'})]);
    if(method==='queue.service-state')return serviceState;
    if(method==='queue.detail')return read(task.id);
    if(method==='task.next')return ownerTaskNext(collectOwnerVerbFacts(store,store.task(task.id)));
    if(method==='queue.task'){calls.push(taskControlInputSchema.parse(input));return store.task(task.id);}
    if(method==='lead.board')return {cards:[],links:[]};
    return [];
  };
  try {
    const tree=mountBoard(invoke);mounted=tree;
    await settle(()=>tree.text().includes(task.title));tree.press(/Edit prerequisites/);
    await settle(()=>Boolean(tree.query(/^Wait: /)));
    if(!tree.query('set dependencies'))await showMoreVerbs(tree);
    tree.press('set dependencies');
    await settle(()=>Boolean(tree.query('Prerequisites (optional)')));
    tree.type('Prerequisites (optional)','nucleus#1070, nucleus#1071');
    tree.press('Confirm set dependencies');
    await settle(()=>calls.length===1);
    assert.deepEqual(calls[0].dependsOn,['nucleus#1070','nucleus#1071']);
    await settle(()=>tree.text().includes('Applied set dependencies'));
    tree.press('set dependencies');
    await settle(()=>Boolean(tree.query('Confirm set dependencies')));
    tree.press('Confirm set dependencies');
    await settle(()=>calls.length===2);
    assert.deepEqual(calls[1].dependsOn,[]);
  } finally {mounted?.update(h('View',null));store.close();}
});

test('a verb with fill fields requires them before submit and reports refusals inline', async () => {
  await load();
  const store = new Store(':memory:');
  // A fresh store is paused; the verb buttons this test drives are deferred while paused.
  store.setMeta('paused', false);
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'revise-me', title: 'Revise me', repoPath: '/app', planningCommit: head, handoffPath: 'revise-me.md', originAgentId: 'origin' }), 'host', 'handoff', head);
    const task = store.update(inserted.id, {
      phase: 'changes_requested', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: profileSchema.parse(workerProfile),
      resumePrNumber: 12, prUrl: 'https://example.test/pull/12', prHead: head,
      resolution: { ...inserted.resolution, currentRunId: 'worker-run' },
      completion: completionSchema.parse({ eventId: 'e1', taskId: inserted.id, runId: 'worker-run', status: 'changes_required', summary: 'Address the review findings', prNumber: 12, head }),
    });
    // The retained revision run is still live and owns the task, so the Next
    // section names it as the participant. A released or finished run is
    // history and is never presented as active (Queue #477 review 5675206214).
    store.putRun(runSchema.parse({
      id: 'worker-run', taskId: task.id, role: 'revision', generation: 1, head, base: head,
      agentId: 'worker-agent', workspaceId: 'workspace', profile: profileSchema.parse(workerProfile), status: 'running',
      createdAt: at, lastObservedAt: at, active: true, idleSince: null, completion: null, released: false,
    }));
    const read = createTaskDetailCache(store);
    const calls: unknown[] = [];
    let refuse = true;
    const invoke = async (method: string, input: unknown) => {
      if (method === 'queue.ui-snapshot') return board([
        summaryOf({ id: task.id, title: 'Revise me', phase: 'changes_requested', prUrl: 'https://example.test/pull/12' }),
        // A second, stopped task badges its stop category on the card.
        summaryOf({ id: 'stopped', title: 'Stopped mid-flight', phase: 'working', stop: 'incident' }),
      ]);
      if (method === 'queue.service-state') return serviceState;
      if (method === 'queue.detail') return read(task.id);
      if (method === 'task.next') return ownerTaskNext(collectOwnerVerbFacts(store, store.task(task.id)));
      if (method === 'queue.task') {
        if (refuse) throw new Error('A live worker run still owns this task; settle it first');
        calls.push(input);
        return store.update(task.id, { phase: 'working', resolution: { ...store.task(task.id).resolution, pendingRevisionCause: 'review' } });
      }
      if (method === 'project.qa.list' || method === 'host.run.list' || method === 'host.run.board') return [];
      if (method === 'lead.board') return { cards: [], links: [] };
      if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list' || method === 'project.owner-candidates') return [];
      void input;
      return {};
    };
    const tree = mountBoard(invoke); mounted = tree;
    await settle(() => tree.text().includes('Revise me'));
    // A stopped task's card carries the stop-category badge; the progressing one carries none.
    await settle(() => Boolean(tree.query('Stop: Incident')));
    assert.equal(tree.all('Stop: Incident').length, 1);
    tree.press(/Revise me/);
    await settle(() => tree.text().includes('No stop or wait; the task is progressing.'));
    assert.match(tree.text(), /Revision Worker is working\./, 'the summary names the active run role and profile');
    tree.press('move to work');
    await settle(() => Boolean(tree.query('Instruction (required)')));
    tree.type('Reason (required)', 'Return to the retained author');
    assert.equal(tree.query('Confirm move')!.props.accessibilityState.disabled, true, 'the required instruction blocks submit');
    tree.type('Instruction (required)', 'Address the findings on the figures');
    assert.equal(tree.query('Confirm move')!.props.accessibilityState.disabled, false);
    tree.press('Confirm move');
    await settle(() => tree.text().includes('A live worker run still owns this task; settle it first'));
    refuse = false;
    const expectedVersion = store.task(task.id).version;
    tree.press('Confirm move');
    await settle(() => tree.text().includes('Applied move'));
    assert.deepEqual(calls[0], {
      action:'move',to:'work',reason:'Return to the retained author', taskId: task.id, version: expectedVersion,
      instruction: 'Address the findings on the figures', caller: 'operator (board)',
    });
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('a dispatched descendant closeout takes its qualifying pair all or none through the real closeout handler', { timeout: 120000 }, async () => {
  await load();
  // A real dispatched retained-source lifecycle: the PR merged at a descendant
  // final head while the retained checkout stays at the recorded source.
  const f = await retainedSourceFixture(true, true);
  const { runtime, taskId } = f;
  const store = runtime.store;
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const read = createTaskDetailCache(store);
    const calls: Record<string, unknown>[] = [];
    const invoke = async (method: string, input: unknown) => {
      const task = store.task(taskId);
      if (method === 'queue.ui-snapshot') return board([summaryOf({ id: taskId, title: 'Retained source', phase: task.phase, prUrl: task.prUrl, resolution: { attention: false, mergedCommit: null } })]);
      if (method === 'queue.service-state') return serviceState;
      if (method === 'queue.detail') return read(taskId);
      if (method === 'task.next') return ownerTaskNext(collectOwnerVerbFacts(store, task));
      if (method === 'queue.task') {
        calls.push(input as Record<string, unknown>);
        return runtime.taskControl(taskControlInputSchema.parse(input));
      }
      if (method === 'project.qa.list' || method === 'host.run.list' || method === 'host.run.board') return [];
      if (method === 'lead.board') return { cards: [], links: [] };
      if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list' || method === 'project.owner-candidates') return [];
      void input;
      return {};
    };
    const tree = mountBoard(invoke); mounted = tree;
    await settle(() => tree.text().includes('Retained source'));
    tree.press(/Retained source/);
    await settle(() => Boolean(tree.query('move to closeout')) || Boolean(tree.all(/^Show \d+ further owner verbs$/).length));
    await showMoreVerbs(tree);
    assert.ok(tree.query('move to closeout'), 'the closeout move stays reachable');
    tree.press('move to closeout');
    await settle(() => Boolean(tree.query('Reason (required)')));
    assert.ok(tree.query('Qualification (optional)'), 'the descendant pair is offered as optional fields');
    assert.ok(tree.query('Final PR head (optional)'), 'the final head is typed by the operator, never prefilled');
    tree.type('Reason (required)', 'Accept the external merge');
    // The ordinary reason-only closeout is available; at a descendant head the
    // handler refuses it with nothing written, and the form reports the refusal.
    tree.press('Confirm move');
    await settle(() => tree.text().includes('External merge head differs'), 600);
    assert.equal(store.task(taskId).resolution.ownerAcceptances?.length ?? 0, 0, 'the refused reason-only closeout writes no acceptance');
    assert.equal(store.task(taskId).resolution.mergedCommit, null, 'nothing merged during the refusal');
    // A qualification without the exact head is incomplete: Apply stays blocked and nothing is sent.
    tree.type('Qualification (optional)', 'I accept this exact final source as is');
    assert.equal(tree.query('Confirm move')!.props.accessibilityState.disabled, true, 'a partial acceptance cannot be submitted');
    assert.equal(calls.length, 1, 'only the refused reason-only submit reached the handler');
    // The complete pair reaches the handler unchanged with the operator board caller.
    tree.type('Final PR head (optional)', f.final);
    assert.equal(tree.query('Confirm move')!.props.accessibilityState.disabled, false);
    const expectedVersion = store.task(taskId).version;
    tree.press('Confirm move');
    await settle(() => tree.text().includes('Applied move'), 600);
    assert.deepEqual(calls.at(-1), {
      action: 'move', to: 'closeout', taskId, version: expectedVersion, reason: 'Accept the external merge',
      qualification: 'I accept this exact final source as is', head: f.final, caller: 'operator (board)',
    });
    // The accepted exact final head and merge are recorded; the source, the original verdict and the proof history are untouched.
    const after = store.task(taskId);
    assert.equal(after.resolution.mergedCommit, f.mergeCommit);
    const record = after.resolution.ownerAcceptances?.at(-1);
    assert.equal(record?.kind, 'operator_source');
    assert.equal(record?.head, f.final);
    assert.deepEqual(record?.actor, { agentId: 'operator (board)', role: 'operator' });
    assert.equal(after.prHead, f.head, 'the recorded source is never rewritten');
    assert.equal(after.resolution.review?.status, 'changes_required', 'the original verdict stays as history');
    assert.equal(f.counts().mergeCalls, 0, 'Queue never merges; the PR merged outside it');
  } finally { mounted?.update(h('View', null)); await f.close(); }
});

const loadBundle = async () => {
  const bytes = (await build({ entryPoints: [new URL('../client/queue.tsx', import.meta.url).pathname], bundle: true, plugins: [boardShellPlugin],
    platform: 'node', format: 'cjs', packages: 'external', write: false })).outputFiles[0]!.text;
  const compiled = { exports: {} as QueueModule };
  new Function('require', 'module', 'exports', bytes)(createRequire(import.meta.url), compiled, compiled.exports);
  queue = compiled.exports;
};

type Node = { children: Array<Node | string> };
const flat = (node: Node | string): string => typeof node === 'string' ? node : node.children.map(flat).join('');

test('Spec 052: bundled dark task detail explains each named profile\'s usage policy and the route chooser keeps it explicit, through expiry', async () => {
  await loadBundle();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const frontier = { ...workerProfile, id: 'frontier', name: 'Frontier Opus', model: 'test/opus' };
  const cheap = { ...workerProfile, id: 'cheap', name: 'Cheap', model: 'test/cheap' };
  const pool = [
    { profileId: 'frontier', enabled: true, group: 'frontier', roles: ['worker', 'reviewer'], weight: 1, scopes: ['general'], cost: 'very_high', capability: 'frontier' },
    { profileId: 'cheap', enabled: true, group: 'cheap', roles: ['worker', 'reviewer'], weight: 1, scopes: ['general'], cost: 'low', capability: 'frontier' },
    { profileId: 'coord', enabled: true, group: 'coord', roles: ['coordinator'], weight: 1, scopes: ['general'], cost: 'very_high', capability: 'frontier' },
    { profileId: 'complex', enabled: true, group: 'complex', roles: ['reviewer'], weight: 1, scopes: ['complex'], cost: 'very_high', capability: 'frontier' },
  ];
  const coord = { ...workerProfile, id: 'coord', name: 'Coordinator only', model: 'test/coord' };
  const longName = 'Complex-only frontier reviewer with a deliberately long profile name';
  const complex = { ...workerProfile, id: 'complex', name: longName, model: 'test/complex' };
  const dark = new Proxy({ surface0: '#111111', surface1: '#1b1b1b', foreground: '#eeeeee' }, { get: (value, key) => value[key as keyof typeof value] ?? '#888888' }) as never;
  const store = new Store(':memory:');
  store.setMeta('pool', pool);
  const setUsage = (expired: boolean) => store.setMeta('usageLevel', { level: 'maximum', until: expired ? new Date(Date.now() - 1000).toISOString() : until, setAt: at });
  try {
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'policy', title: 'Policy task', repoPath: '/app', planningCommit: head, handoffPath: 'policy.md', originAgentId: 'origin', preferredProfileId: 'cheap' }), 'host', 'handoff', head);
    const task = store.update(inserted.id, { phase: 'working', profile: profileSchema.parse(frontier) });
    const read = createTaskDetailCache(store);
    const writes: string[] = [];
    for (const compact of [false, true]) {
      setUsage(false);
      const invoke = async (method: string) => {
        if (method === 'queue.ui-snapshot') return { ...board([summaryOf({ id: task.id, title: 'Policy task', phase: 'working' })]), profiles: [frontier, cheap, coord, complex], pool, usage: store.usageView() };
        if (method === 'queue.service-state') return serviceState;
        if (method === 'queue.detail') return read(task.id);
        if (method === 'task.next') return ownerTaskNext(collectOwnerVerbFacts(store, store.task(task.id)));
        if (method === 'project.qa.list' || method === 'host.run.list' || method === 'host.run.board') return [];
        if (method === 'lead.board') return { cards: [], links: [] };
        if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list' || method === 'project.owner-candidates') return [];
        if (method !== 'queue.backup-list') writes.push(method);
        return {};
      };
      const client = new QueryClient();
      const tree = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke: invoke as never,
        children: h(queue.MainSurface as never, { theme: { colors: dark }, host: { id: 'host', label: 'Host' }, layout: { compact, platform: 'ios' as const } }) }) }));
      try {
        await settle(() => tree.text().includes('Policy task'));
        tree.press(/Policy task/);
        await selectDetailTab(tree, 'Technical');
        await settle(() => Boolean(tree.query('Routing policy for worker profile frontier')));
        const line = (role: string, id: string) => tree.get(`Routing policy for ${role} profile ${id}`).children.join('');
        assert.equal(line('worker', 'frontier'), `worker · frontier · Recorded worker run used it (history, not today's policy); automatic selection: Frontier · Automatic at Maximum until ${formatLocalDateTime(until)}`);
        assert.equal(line('worker', 'cheap'), `worker · cheap · Worker preference; automatic selection: Frontier · Automatic at Maximum until ${formatLocalDateTime(until)}`, 'a cheap frontier profile is automatic at Maximum');
        assert.equal(tree.get('Routing policy for worker profile frontier').props.style.flexShrink, 1, 'the line wraps instead of truncating');
        // The route chooser: tags read the effective policy; the chosen profile keeps route explicit.
        await selectDetailTab(tree, 'Overview');
        await showMoreVerbs(tree);
        tree.press('route reviewer');
        await settle(() => Boolean(tree.query('Profile Frontier Opus')));
        assert.equal(flat(tree.get('Profile Frontier Opus')), 'Frontier Opus', 'automatic at Maximum: no tag');
        assert.equal(flat(tree.get('Profile Cheap')), 'Cheap');
        // Spec 053: role and scope switches no longer gate, so a coordinator-only or
        // complex-only entry is offered for the reviewer under the usage policy.
        assert.equal(flat(tree.get('Profile Coordinator only')), 'Coordinator only');
        assert.equal(flat(tree.get(`Profile ${longName}`)), longName);
        // A long label wraps inside the row rather than overflowing the compact dialog.
        const button = tree.get(`Profile ${longName}`);
        assert.deepEqual([button.props.style.maxWidth, button.props.style.flexShrink], ['100%', 1]);
        const label = tree.ofType('Text').find(node => flat(node) === longName)!;
        assert.equal(label.props.style.flexShrink, 1, 'the label text shrinks and wraps');
        tree.press('Profile Frontier Opus');
        assert.match(tree.text(), new RegExp(`Route is an explicit request and applies at every usage level\\. Automatic selection: Frontier · Automatic at Maximum until ${formatLocalDateTime(until).replace(/[()]/g, '\\$&')}\\.`));
        // Expiry on an isolated store: fresh reads (next, and a cached detail) show Normal.
        setUsage(true);
        await client.refetchQueries({ queryKey: ['nucleus', 'state'], exact: true });
        await client.refetchQueries({ queryKey: ['nucleus', 'next', task.id], exact: true });
        await selectDetailTab(tree, 'Technical');
        await settle(() => line('worker', 'frontier').includes('Normal'));
        assert.match(line('worker', 'frontier'), /automatic selection: Explicit request required at Normal: very high cost is above its ceiling \(Maximum ended /);
        await selectDetailTab(tree, 'Overview');
        assert.equal(flat(tree.get('Profile Frontier Opus')), 'Frontier Opus · request only');
        assert.equal(flat(tree.get('Profile Cheap')), 'Cheap · frontier', 'below Maximum a frontier profile needs a request whatever its cost');
        assert.equal(read(task.id).routingPolicy.usage.level, 'normal', 'the cached detail read re-projects too');
        assert.deepEqual(writes, [], 'nothing was written');
      } finally { tree.update(h('View', null)); client.clear(); }
    }
  } finally { store.close(); }
});

test('Spec 052: bundled dark choosers name an unavailable subscription group instead of reading automatic', async () => {
  await loadBundle();
  const down = { ...workerProfile, id: 'down', name: 'Frontier in a paused group', model: 'test/down' };
  const pool = [{ profileId: 'down', enabled: true, group: 'down', roles: ['worker', 'reviewer'], weight: 1, scopes: ['general'], cost: 'very_high', capability: 'frontier' }];
  const retryAt = new Date(Date.now() + 7_200_000).toISOString();
  const availability = [{ group: 'down', unavailable: true, reason: 'Quota exhausted', retryAt }];
  const dark = new Proxy({ surface0: '#111111', surface1: '#1b1b1b', foreground: '#eeeeee', statusWarning: '#f0883e' }, { get: (value, key) => value[key as keyof typeof value] ?? '#888888' }) as never;
  const store = new Store(':memory:');
  store.setMeta('pool', pool);
  store.setMeta('usageLevel', { level: 'maximum', until: null, setAt: at });
  const writes: string[] = [];
  try {
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'group', title: 'Group task', repoPath: '/app', planningCommit: head, handoffPath: 'group.md', originAgentId: 'origin' }), 'host', 'handoff', head);
    const task = store.update(inserted.id, { phase: 'needs_attention', reason: 'Waiting for the operator' });
    // The selector agrees: the level lifts the flag, the group still holds automatic selection.
    assert.equal(chooseProfile(store.task(task.id), [down], store.pool(), {}, new Set(), 'reviewer', {}, 'maximum')?.profile.id, 'down');
    assert.equal(chooseProfile(store.task(task.id), [down], store.pool(), {}, new Set(['down']), 'reviewer', {}, 'maximum'), null);
    const read = createTaskDetailCache(store);
    for (const compact of [false, true]) {
      const invoke = async (method: string) => {
        if (method === 'queue.ui-snapshot') return { ...board([summaryOf({ id: task.id, title: 'Group task', phase: 'needs_attention' })]), profiles: [down], pool, availability, usage: store.usageView() };
        if (method === 'queue.service-state') return serviceState;
        if (method === 'queue.detail') return read(task.id);
        if (method === 'task.next') return ownerTaskNext(collectOwnerVerbFacts(store, store.task(task.id)));
        if (method === 'project.qa.list' || method === 'host.run.list' || method === 'host.run.board') return [];
        if (method === 'lead.board') return { cards: [], links: [] };
        if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list' || method === 'project.owner-candidates') return [];
        if (method !== 'queue.backup-list') writes.push(method);
        return {};
      };
      const client = new QueryClient();
      const tree = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke: invoke as never,
        children: h(queue.MainSurface as never, { theme: { colors: dark }, host: { id: 'host', label: 'Host' }, layout: { compact, platform: 'ios' as const } }) }) }));
      const warning = new RegExp(`Subscription group down is unavailable: Quota exhausted · until ${formatLocalDateTime(retryAt).replace(/[()]/g, '\\$&')}\\. Nothing dispatches to this profile until the group returns, whatever the usage level\\.`);
      try {
        await settle(() => tree.text().includes('Group task'));
        tree.press(/Group task/);
        await selectDetailTab(tree, 'Overview');
        await settle(() => Boolean(tree.query('route reviewer')) || Boolean(tree.all(/^Show \d+ further owner verbs$/).length));
        await showMoreVerbs(tree);
        tree.press('route reviewer');
        await settle(() => Boolean(tree.query('Profile Frontier in a paused group')));
        assert.equal(flat(tree.get('Profile Frontier in a paused group')), 'Frontier in a paused group · group unavailable');
        tree.press('Profile Frontier in a paused group');
        assert.match(tree.text(), warning);
        assert.doesNotMatch(tree.text(), /Automatic selection: (Frontier · )?Automatic/);
        // The worker preference chooser in Routing reads the same.
        await selectDetailTab(tree, 'Technical');
        tree.press('Change routing');
        const preference = tree.ofType('Text').find(node => flat(node) === 'Frontier in a paused group · group unavailable' && !tree.get('Profile Frontier in a paused group').children.includes(node));
        assert.ok(preference, 'the preference button names the unavailable group');
        assert.deepEqual(writes, [], 'nothing was written');
      } finally { tree.update(h('View', null)); client.clear(); }
    }
  } finally { store.close(); }
});

/**
 * Queue #395: the task detail quotes the recorded run-bound build output
 * cleanup before an owner or worker continuation reuses artifacts, so an
 * earlier build is never read as present output. Visibility only: the record's
 * `complete` state is stated as Queue's own obligation, and the quoted detail
 * stays bounded.
 */
test('task detail shows the recorded run-bound build output cleanup beside the continuation gates', async () => {
  await load();
  const store = new Store(':memory:');
  store.setMeta('paused', false);
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'built-task', title: 'Built once', repoPath: '/app', planningCommit: head, handoffPath: 'built.md', originAgentId: 'origin' }), 'host', 'handoff', head);
    const longDetail = `Removed task-local Cargo target output at ${'/app/target/debug/'.repeat(90)}`;
    const task = store.update(inserted.id, {
      phase: 'blocked', workspaceId: 'workspace', directory: '/app', branch: 'ns-built', agentId: 'worker-agent',
      reason: 'Blocked after a build',
      completion: completionSchema.parse({ eventId: 'e1', taskId: inserted.id, runId: 'worker-run', status: 'blocked', summary: 'Blocked after a build', head }),
      resolution: { ...inserted.resolution, buildOutputCleanups: [
        { workspaceId: 'workspace', directory: '/app', runId: 'worker-run', agentId: 'worker-agent', state: 'complete', at,
          detail: `${longDetail}. Retained node_modules at /app/node_modules for the task's next continuation` },
        { workspaceId: 'review-view', directory: '/review-view', runId: 'review-run', state: 'skipped', at,
          detail: 'Skipped build output roots: /review-view/target: Git reports tracked files at or under this build root' },
      ] },
    });
    const read = createTaskDetailCache(store);
    const invoke = async (method: string, input: unknown) => {
      if (method === 'queue.ui-snapshot') return board([summaryOf({ id: task.id, title: 'Built once', phase: 'blocked' })]);
      if (method === 'queue.service-state') return serviceState;
      if (method === 'queue.detail') return read(task.id);
      if (method === 'task.next') return ownerTaskNext(collectOwnerVerbFacts(store, store.task(task.id)));
      if (method === 'project.qa.list' || method === 'host.run.list' || method === 'host.run.board') return [];
      if (method === 'lead.board') return { cards: [], links: [] };
      if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list' || method === 'project.owner-candidates') return [];
      void input;
      return {};
    };
    const tree = mountBoard(invoke); mounted = tree;
    await settle(() => tree.text().includes('Built once'));
    tree.press(/Built once/);
    await selectDetailTab(tree, 'Runs & agents');
    await settle(() => tree.text().includes('Run-bound build output'));
    const rendered = tree.query('Run-bound build output cleanup')?.props.children;
    assert.equal(typeof rendered, 'string');
    assert.match(rendered, /Run-bound build output cleanup disclosure — Nucleus's own records, not a proof of present outputs/);
    assert.match(rendered, /run worker-run \(the run being continued\) in workspace workspace, recorded complete at .*a recorded removal and output retained for the next continuation/);
    assert.match(rendered, /run review-run in workspace review-view, another workspace rather than this checkout, recorded skipped at/);
    assert.match(rendered, /"complete" records Nucleus's own cleanup obligation for that root; it does not prove the output was deleted/);
    assert.match(rendered, /Prior build artifacts are not guaranteed retained: re-run every command whose output you rely on/);
    assert.match(rendered, /…/, 'a long recorded detail is bounded with a visible ellipsis');
    assert.ok(rendered.length < 2600, `the detail disclosure stays bounded, got ${rendered.length}`);
    // The disclosure is prominent: it precedes the run history and the
    // continuation guidance an owner reads before sending the task back to work.
    // Task identity now lives in Technical (task 860), so it is not on this tab.
    const text = tree.text();
    assert.ok(text.indexOf('Run-bound build output') < text.indexOf('Runs and delivery'));
    assert.ok(text.indexOf('Run-bound build output') < text.indexOf('A blocked pre-PR worker resumes through restart'));
  } finally { mounted?.update(h('View', null)); store.close(); }
});

/**
 * Task 860: the evidence tabs read in one order. Live runs lead Runs & agents
 * with earlier runs behind a disclosure; task messages name their delivery in
 * plain words; Activity bounds long event detail; raw identity sits behind a
 * disclosure in Technical. The cases mount at narrow and wide sizes.
 */
const evidenceTask = (store: Store) => {
  const inserted = store.insert(submissionSchema.parse({ submissionId: 'evidence', title: 'Evidence', repoPath: '/app', planningCommit: head, handoffPath: 'evidence.md', originAgentId: 'origin' }), 'host', 'handoff', head);
  return store.update(inserted.id, { phase: 'blocked', reason: 'Blocked for evidence' });
};
/** Serves the real detail cache with the test's own runs, messages or events laid over it. */
const evidenceInvoke = (store: Store, taskId: string, overlay: (detail: Record<string, unknown>) => Record<string, unknown>) => {
  const read = createTaskDetailCache(store);
  return async (method: string, input: unknown) => {
    if (method === 'queue.ui-snapshot') return board([summaryOf({ id: taskId, title: 'Evidence', phase: 'blocked' })]);
    if (method === 'queue.service-state') return serviceState;
    if (method === 'queue.detail') return overlay(read(taskId) as unknown as Record<string, unknown>);
    if (method === 'task.next') return ownerTaskNext(collectOwnerVerbFacts(store, store.task(taskId)));
    if (method === 'project.qa.list' || method === 'host.run.list' || method === 'host.run.board') return [];
    if (method === 'lead.board') return { cards: [], links: [] };
    if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list' || method === 'project.owner-candidates') return [];
    void input;
    return {};
  };
};

for (const compact of [false, true]) {
  const size = compact ? 'narrow' : 'wide';

  test(`task 895 (${size}): all five detail sections stay visible and accessible`, async () => {
    await load();
    const store = new Store(':memory:');
    let mounted: ReturnType<typeof mountBoard> | undefined;
    try {
      const task = evidenceTask(store);
      const read = evidenceInvoke(store, task.id, detail => detail);
      let detailReads = 0;
      const tree = mountBoard((method, input) => {
        if (method === 'queue.refresh') return Promise.resolve({ ok: true });
        if (method === 'queue.detail') detailReads++;
        return read(method, input);
      }, compact); mounted = tree;
      await settle(() => tree.text().includes('Evidence'));
      tree.press(/Evidence/);
      await settle(() => tree.query('Task detail sections')?.props.accessibilityRole === 'tablist');
      const labels = ['Overview', 'Technical', 'Runs & agents', 'Messages', 'Activity'];
      for (const label of labels) assert.equal(tree.query(label)?.props.accessibilityRole, 'tab', `${label} has a screen-reader tab role`);
      assert.equal(tree.query('Overview')?.props.accessibilityState?.selected, true);
      assert.equal(tree.query('Overview')?.props.style.minHeight, 44, 'tab controls keep a 44-point touch target');
      await selectDetailTab(tree, 'Activity');
      tree.press('Refresh');
      await settle(() => detailReads > 1 && tree.query('Activity')?.props.accessibilityState?.selected === true && tree.text().includes('Recorded events'));
    } finally { mounted?.update(h('View', null)); store.close(); }
  });

  test(`task 860 (${size}): live runs lead Runs & agents and earlier runs sit behind a disclosure`, async () => {
    await load();
    const store = new Store(':memory:');
    let mounted: ReturnType<typeof mountBoard> | undefined;
    try {
      const task = evidenceTask(store);
      const run = (overrides: Record<string, unknown>) => runSchema.parse({ id: 'run', taskId: task.id, role: 'executor', generation: 1, head, base: head, agentId: null, workspaceId: 'workspace', profile: null, status: 'running', createdAt: at, lastObservedAt: null, active: null, idleSince: null, completion: null, released: false, ...overrides });
      const runs = [
        run({ id: 'earlier-run', role: 'reviewer', generation: 1, agentId: 'reviewer-agent', released: true }),
        run({ id: 'live-run', generation: 2, agentId: 'worker-agent' }),
      ];
      const tree = mountBoard(evidenceInvoke(store, task.id, detail => ({ ...detail, runs })), compact); mounted = tree;
      await settle(() => tree.text().includes('Evidence'));
      tree.press(/Evidence/);
      await selectDetailTab(tree, 'Runs & agents');
      await settle(() => Boolean(tree.query('Earlier runs (1)')));
      const collapsed = tree.text();
      assert.ok(collapsed.indexOf('executor · running') >= 0 && collapsed.indexOf('executor · running') < collapsed.indexOf('Earlier runs (1)'), 'the live run leads and the earlier one follows');
      assert.doesNotMatch(collapsed, /reviewer · running/, 'an earlier run stays behind its disclosure until asked for');
      assert.equal(tree.query('Earlier runs (1)')?.props.accessibilityState?.expanded, false);
      tree.press('Earlier runs (1)');
      await settle(() => tree.text().includes('reviewer · running'));
      assert.equal(tree.query('Earlier runs (1)')?.props.accessibilityState?.expanded, true);
    } finally { mounted?.update(h('View', null)); store.close(); }
  });

  test(`task 860 (${size}): messages say what their delivery state is, and the empty tab says what a message is`, async () => {
    await load();
    const store = new Store(':memory:');
    let mounted: ReturnType<typeof mountBoard> | undefined;
    try {
      const task = evidenceTask(store);
      const message =(id: string, status: 'queued' | 'delivered' | 'expired', error = '') => agentMessageRecordSchema.parse({
        id, contentKey: id, fromTaskId: task.id, fromRole: 'worker', fromAgentId: 'worker-agent', fromReference: null, fromProject: 'app',
        toTaskId: 'other', toRole: 'reviewer', toAgentId: null, toReference: 'owner/app#7', textDigest: id, text: `Message ${id}`,
        status, createdAt: at, deliveredAt: status === 'delivered' ? at : null, error,
      });
      const messages = [message('queued-one', 'queued', 'recipient busy'), message('delivered-one', 'delivered'), message('expired-one', 'expired')];
      const tree = mountBoard(evidenceInvoke(store, task.id, detail => ({ ...detail, messages })), compact); mounted = tree;
      await settle(() => tree.text().includes('Evidence'));
      tree.press(/Evidence/);
      await selectDetailTab(tree, 'Messages');
      await settle(() => tree.text().includes('Message queued-one'));
      const text = tree.text();
      assert.match(text, /Queued · waiting for the recipient’s next turn · last note: recipient busy/);
      assert.match(text, /Delivered/);
      assert.match(text, /Not delivered · expired before delivery/);
      assert.ok(tree.query(/^Delivery Not delivered/), 'each delivery state has an accessible label');
    } finally { mounted?.update(h('View', null)); store.close(); }
  });

  test(`task 860 (${size}): Activity bounds long event detail behind a disclosure and counts the recorded events`, async () => {
    await load();
    const store = new Store(':memory:');
    let mounted: ReturnType<typeof mountBoard> | undefined;
    try {
      const task = evidenceTask(store);
      const long = 'Worker report body. '.repeat(20);
      const events = [
        eventSchema.parse({ id: 1, taskId: task.id, at, kind: 'worker_report', detail: long }),
        eventSchema.parse({ id: 2, taskId: task.id, at, kind: 'telemetry_stage', detail: 'validation_wait' }),
        eventSchema.parse({ id: 3, taskId: task.id, at, kind: 'note', detail: 'recorded by Tom: Confirmed the exact review head.' }),
      ];
      const tree = mountBoard(evidenceInvoke(store, task.id, detail => ({ ...detail, events })), compact); mounted = tree;
      await settle(() => tree.text().includes('Evidence'));
      tree.press(/Evidence/);
      await selectDetailTab(tree, 'Activity');
      await settle(() => tree.text().includes('Recorded events'));
      assert.doesNotMatch(tree.text(), /Recorded events · \d/, 'the events heading carries no count: the detail holds only the newest window');
      assert.match(tree.text(), /Add a coordination note/);
      assert.match(tree.text(), /Worker Report/, 'the kind reads in words, not as a snake_case key');
      assert.match(tree.text(), /Not recorded ·/, 'events are honest when the event record has no actor field');
      assert.match(tree.text(), /Tom · /, 'the recorded actor stops at the colon before the note text');
      assert.match(tree.text(), /Show technical events \(1\)/, 'low-value stage mechanics stay behind an explicit disclosure');
      assert.equal(tree.text().includes('validation_wait'), false);
      assert.equal(tree.text().includes(long), false, 'the full detail waits behind its disclosure');
      assert.ok(tree.query(/^Worker Report, actor Not recorded, /), 'the event row announces its event, actor and time');
      tree.press('Original event 1');
      await settle(() => tree.text().includes(long));
      assert.match(tree.text(), /Event ID · 1/);
      assert.match(tree.text(), new RegExp(`Task ID · ${task.id}`));
      assert.equal(tree.query('Complete original event detail')?.props.selectable, true, 'the full original detail can be selected on demand');
      tree.press(/^Show technical events \(1\), collapsed$/);
      await settle(() => tree.text().includes('validation_wait'));
    } finally { mounted?.update(h('View', null)); store.close(); }
  });
}

test('task 860: a capped run history says the earlier count is the latest window', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const task = evidenceTask(store);
    const earlier = Array.from({ length: 200 }, (_, index) => runSchema.parse({ id: `old-${index}`, taskId: task.id, role: 'reviewer', generation: index + 1, head, base: head, agentId: null, workspaceId: 'workspace', profile: null, status: 'running', createdAt: at, lastObservedAt: null, active: null, idleSince: null, completion: null, released: true }));
    const tree = mountBoard(evidenceInvoke(store, task.id, detail => ({ ...detail, runs: earlier }))); mounted = tree;
    await settle(() => tree.text().includes('Evidence'));
    tree.press(/Evidence/);
    await selectDetailTab(tree, 'Runs & agents');
    await settle(() => Boolean(tree.query('Earlier runs (200, of the latest 200 runs)')));
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('task 860: an empty Messages tab says what a message is and names no tool', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const task = evidenceTask(store);
    const tree = mountBoard(evidenceInvoke(store, task.id, detail => ({ ...detail, messages: [] }))); mounted = tree;
    await settle(() => tree.text().includes('Evidence'));
    tree.press(/Evidence/);
    await selectDetailTab(tree, 'Messages');
    await settle(() => tree.text().includes('No messages yet'));
    assert.match(tree.text(), /They carry information only and never change a task/);
    assert.doesNotMatch(tree.text(), /northstar_message/, 'the empty copy names no tool');
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('task 860: Activity names its window when the detail holds the newest 100 events, and an empty read says so', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const task = evidenceTask(store);
    const full = Array.from({ length: 100 }, (_, index) => eventSchema.parse({ id: index + 1, taskId: task.id, at, kind: 'note', detail: `Event ${index + 1}` }));
    const tree = mountBoard(evidenceInvoke(store, task.id, detail => ({ ...detail, events: full }))); mounted = tree;
    await settle(() => tree.text().includes('Evidence'));
    tree.press(/Evidence/);
    await selectDetailTab(tree, 'Activity');
    await settle(() => tree.text().includes('Showing the newest 100 events, newest first.'));
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('task 860: Activity with no recorded events says so, and Technical keeps raw identity behind a disclosure', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const task = evidenceTask(store);
    const tree = mountBoard(evidenceInvoke(store, task.id, detail => ({ ...detail, events: [] }))); mounted = tree;
    await settle(() => tree.text().includes('Evidence'));
    tree.press(/Evidence/);
    await selectDetailTab(tree, 'Activity');
    await settle(() => tree.text().includes('No events recorded for this task yet.'));
    await selectDetailTab(tree, 'Technical');
    await settle(() => Boolean(tree.query('Raw IDs and records')));
    assert.match(tree.text(), /Repository/, 'the repository reads as a fact');
    assert.doesNotMatch(tree.text(), /Planning commit/, 'raw identity waits behind its disclosure');
    tree.press('Raw IDs and records');
    await settle(() => tree.text().includes('Planning commit'));
  } finally { mounted?.update(h('View', null)); store.close(); }
});
