import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardSource } from './support/board-source';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs, type HostNode } from './support/render';
import { Store } from '../core/store/store';
import { LEAD_PREVIEW_MAX, projectSchema, submissionSchema, summarizeTask, syncHoldProjection, visibleTaskSummaries, type Task, type TaskSummary } from '../shared/contracts';
import { taskStopReasons } from '../shared/task-stop';
import { waitStates } from '../shared/wait-state';

// UI lane step 2 (Tom, 2026-11-07): a board task card says what is happening, what is
// waiting and who or what moves it next; IDs, lanes, profiles and timestamps move to the
// task view. Synthetic rows only; the rendered tree is read through the render helper.
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
const LONG_TITLE = 'Board cards keep the title to two lines when the task title runs well past what a narrow column can show, so the reader still sees where the task starts';
const MERGE = 'Merge held by operator: external receipt pending';
const DISPATCH = 'Dispatch held by operator: planning owes a ruling on the cleared origin';
const fence = (reason: string) => ({ owner: 'operator', reason, at, generation: 1, until: null });

const repo = { origin: 'owner/app', path: '/app' };
const project = { key: 'app', name: 'App', repositories: [repo], primary: repo };
const workerProfile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test/worker', notes: '', available: true, problem: '', supportedThinking: [] };

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('the surface did not settle');
}
const board = (tasks: TaskSummary[], queuedCounts: Array<{ repoPath: string; count: number }> = []) => ({
  revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: true,
  activeWorkers: 0, unsettled: 0, occupiedSlots: 0, globalLimit: 32, projectLimit: 5,
  tasks, queuedCounts, profiles: [workerProfile], pool: [{ profileId: workerProfile.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] }],
  availability: [], assignments: {}, recentAssignments: {}, lanes: [], projects: [project], prStates: {},
});
const serviceState = { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };

/** Mounts the board at a narrow (compact) or wide layout. Queries do not retry, so an error settles at once. */
function mountBoard(invoke: (method: string, input: unknown) => Promise<unknown>, compact = false) {
  const surfaceProps = { theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact, platform: 'ios' as const } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mount(h(QueryClientProvider, {
    client,
    children: h(PluginRpcProvider, { invoke, children: h(queue.MainSurface as never, surfaceProps) }),
  }));
}

function seed(store: Store, id: string, patch: Partial<Task>) {
  const inserted = store.insert(submissionSchema.parse({
    submissionId: id, title: id, repoPath: '/app', planningCommit: head, handoffPath: `${id}.md`, originAgentId: '0b355fd4',
  }), 'host', 'handoff', head);
  return store.update(inserted.id, { notificationAgentId: '56e9c969', originError: '', originLookupError: '', ...patch });
}

/** Board fixtures: one card per state the card renders, all from real stored tasks and summaries. */
function fixtures(store: Store) {
  const long = seed(store, 'long-title', { title: LONG_TITLE, phase: 'working', reason: 'Worker is editing' });
  const held = seed(store, 'both-holds', { phase: 'queued', reason: 'Waiting for dispatch', ...syncHoldProjection({ dispatch: fence(DISPATCH), merge: fence(MERGE) }) });
  const closing = seed(store, 'archive-failed', { phase: 'closing', reason: 'Closing the workspace' });
  const stopped = seed(store, 'stopped', { phase: 'needs_attention', reason: 'Needs a decision' });
  const queued = seed(store, 'waiting-heavy', { phase: 'queued', reason: 'Waiting for dispatch' });
  const reporting = seed(store, 'reporting', { phase: 'working', reason: 'Worker is editing' });
  const empty = seed(store, 'empty-card', { phase: 'needs_attention', reason: '' });
  const summary = (id: string) => summarizeTask(store.task(id));
  return {
    long: summary(long.id),
    held: summary(held.id),
    // The archive failure is attention: the card shows the error, not the attempt count or retry time.
    closing: { ...summary(closing.id), resolution: { ...summary(closing.id).resolution, archiveRetry: { workspaceId: 'ws-1', attempts: 3, error: 'EBUSY: resource busy', nextAttemptAt: at } } },
    stopped: { ...summary(stopped.id), stop: 'attention' as const, stopRecord: { reason: 'operator_needed' as const, detail: 'Operator decides whether to restart', since: at, suggestedVerbs: ['restart' as const, 'route' as const] } },
    heavy: { ...summary(queued.id), heavyRun: { selector: 'npm test', state: 'queued' as const, position: 2, submittedAt: at, launchedAt: null, holder: 'milestone QA' } },
    reporting: { ...summary(reporting.id), headline: 'Parser written; tests are next' },
    // An attention stop with no reason, no report and no next action: the chips row must not render empty.
    empty: { ...summary(empty.id), stop: 'attention' as const, waitState: undefined },
    queued: summary(queued.id),
  };
}

/** The shared invoke: every method the board reads, with the queued page supplied by the test. */
function invokeWith(snapshot: unknown, queuedPage: () => Promise<unknown>, leads: unknown[] = [], decisions: unknown[] = []) {
  return async (method: string, input: unknown) => {
    if (method === 'queue.ui-snapshot') return snapshot;
    if (method === 'queue.service-state') return serviceState;
    if (method === 'queue.detail') return undefined;
    if (method === 'task.next') return null;
    if (method === 'queue.queued-page') return queuedPage();
    if (method === 'project.qa.list' || method === 'host.run.list') return [];
    if (method === 'host.run.board') return { runs: [], accounting: { readAt: at, entries: [], complete: true } };
    if (method === 'lead.board') return { cards: leads, links: [] };
    if (method === 'decision.list') return decisions;
    if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'project.owner-candidates') return [];
    void input;
    return {};
  };
}

/** Counts View nodes with a wrapping chip style and no children: an empty chips row. */
function emptyChipRows(node: HostNode): number {
  const own = node.type === 'View' && node.props.style?.flexWrap === 'wrap' && node.props.style?.gap === 6 && node.children.length === 0 ? 1 : 0;
  return own + node.children.reduce((sum, child) => sum + (typeof child === 'string' ? 0 : emptyChipRows(child)), 0);
}

test('a board card says what is happening and what moves it next; IDs, timestamps and profile stay out', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const f = fixtures(store);
    const extra = { ...f.queued, id: 'extra-1', title: 'Second queued', number: 99, phase: 'queued' as const };
    // Three loaded queued cards (held, heavy, extra) out of 12 queued in the project: the column shows 9 more.
    const snapshot = board([f.long, f.held, f.closing, f.stopped, f.heavy, f.reporting, extra], [{ repoPath: '/app', count: 12 }]);
    mounted = mountBoard(invokeWith(snapshot, async () => ({ tasks: [], hasMore: false })));
    const tree = mounted;
    await settle(() => tree.text().includes('Parser written; tests are next') && tree.text().includes('Dispatch held'));

    // What is happening, and who moves it next (the body of each card).
    assert.match(tree.text(), /Workspace archive failed: EBUSY: resource busy/, 'the failed archive is the next action');
    assert.ok(tree.text().includes('Needs attention · Your decision is next'), 'attention says who moves it next in human terms');
    assert.ok(tree.text().includes('Operator decides whether to restart'), 'attention leads with the human reason');
    assert.ok(!tree.text().includes('operator_needed') && !tree.text().includes('next: restart, route'), 'technical stop mechanics stay off the card');
    assert.match(tree.text(), /Waiting for QA capacity · position 2/, 'a queued heavy run names its place');
    assert.ok(tree.text().includes('Parser written; tests are next'), 'a card reads its latest report');
    // Holds keep their own distinct chips, and the hold age comes from the summary's since field.
    assert.ok(tree.text().includes('Dispatch held'), 'the dispatch hold keeps its chip');
    assert.ok(tree.text().includes('Merge held'), 'the merge hold keeps its chip');
    assert.ok(!tree.text().includes('age not recorded'), 'the summary carries the hold since time');

    // Moved to the task view: no attempt count, retry time, profile placeholder or report caption on the card.
    assert.ok(!tree.text().includes('Attempt 3'), 'the attempt count is in the task view');
    assert.ok(!tree.text().includes('next retry'), 'the retry time is in the task view');
    assert.ok(!tree.text().includes('Automatic'), 'the profile placeholder is in the task view');
    assert.ok(!tree.text().includes('Latest report'), 'the report caption is gone');
    assert.ok(!tree.text().includes(head), 'the planning commit is not on the card');

    // Real totals and the in-column overflow card: the project's 12 queued tasks, three loaded.
    assert.ok(tree.text().includes('…and 9 more'), 'the overflow card carries the server total');

    // Long content: the full title stays in the accessible label, and the visible title is capped at two lines.
    assert.ok(tree.query(new RegExp(`^app, ${LONG_TITLE.slice(0, 40)}`)), 'the accessible label names the whole task');
    const stoppedLabel = tree.query(/^app, stopped,/ )?.props.accessibilityLabel as string;
    assert.match(stoppedLabel, /Operator decides whether to restart/);
    assert.match(stoppedLabel, /Action: open task details/);
    assert.doesNotMatch(stoppedLabel, /operator_needed|restart, route/);
    const heldLabel = tree.all(/.*/).find(node => String(node.props.accessibilityLabel ?? '').includes('Full hold reason:'))?.props.accessibilityLabel as string;
    assert.match(heldLabel, /Full hold reason: Dispatch held by operator: planning owes a ruling on the cleared origin/);
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('the card lays out the same content at a narrow and a wide board', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const f = fixtures(store);
    const snapshot = board([f.long, f.held, f.closing, f.stopped, f.heavy, f.reporting]);
    for (const compact of [true, false]) {
      mounted?.update(h('View', null));
      mounted = mountBoard(invokeWith(snapshot, async () => ({ tasks: [], hasMore: false })), compact);
      const tree = mounted;
      await settle(() => tree.text().includes('Parser written; tests are next') && tree.text().includes('Workspace archive failed'));
      const label = compact ? 'narrow' : 'wide';
      assert.ok(tree.query(/^app, Board cards keep the title/), `the ${label} card keeps its accessible label`);
      assert.match(tree.text(), /Dispatch held/, `the ${label} card keeps the hold chip`);
      assert.match(tree.text(), /Workspace archive failed: EBUSY/, `the ${label} card keeps the error next action`);
      assert.equal(emptyChipRows(tree.get(/^app, Board cards keep the title/) as HostNode), 0, `the ${label} card has no empty chips row`);
    }
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('a queued hold previews its first sentence and keeps the complete reason accessible', async () => {
  await load();
  const store = new Store(':memory:');
  try {
    const { held } = fixtures(store);
    const fullReason = 'The planner needs to record the source ruling. The task can start after that decision.';
    const task = { ...held, holds: { ...(held.holds ?? {}), dispatch: { ...(held.holds?.dispatch ?? fence(fullReason)), reason: fullReason } } };
    const ui = mount(h(queue.TaskCard as never, { task, selected: false, onPress: () => {}, c, board: true }));
    try {
      assert.ok(ui.text().includes('Hold reason preview · The planner needs to record the source ruling.'));
      assert.ok(!ui.text().includes('The task can start after that decision.'), 'the card keeps its preview to the first sentence');
      const label = ui.all(/.*/).find(node => String(node.props.accessibilityLabel ?? '').includes('Full hold reason:'))?.props.accessibilityLabel as string;
      assert.ok(label.includes(fullReason), 'the accessible name retains the unmodified full reason');
    } finally { ui.update(h('View', null)); }
  } finally { store.close(); }
});

test('a card with nothing to show renders no empty chips row, and its state line stays', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const f = fixtures(store);
    // Attention stop on a needs-attention task: the phase line says it, so the stop badge is suppressed.
    const snapshot = board([f.empty]);
    mounted = mountBoard(invokeWith(snapshot, async () => ({ tasks: [], hasMore: false })));
    const tree = mounted;
    await settle(() => Boolean(tree.query(/^app, empty-card,/)));
    const card = tree.query(/^app, empty-card,/) as HostNode;
    assert.equal(emptyChipRows(card), 0, 'a suppressed stop leaves no empty chips row');
    assert.ok(tree.query(/^app, empty-card, Attention/), 'the accessible label still says what is happening');
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('waits, holds and progress stops use operator words in visible and accessible card text', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const dependent = seed(store, 'dependency', { phase: 'queued', reason: 'Waiting for prerequisites: Machine ports move out of the Paseo adapter (84aa4e89-0f2c-4ea4-ae22-b11111111111): changes_requested; Publish adapter (84aa4e89-0f2c-4ea4-ae22-b22222222222): reviewing', dependsOn: ['84aa4e89-0f2c-4ea4-ae22-b11111111111', '84aa4e89-0f2c-4ea4-ae22-b22222222222'] });
    const progress = seed(store, 'progress', { phase: 'blocked', reason: 'lifecycle: Reviewer continuing from checkpoint 2' });
    const task = store.task(dependent.id);
    const projectWithPlanner = projectSchema.parse({ ...project, planner: { agentId: 'planner-id', setBy: 'operator', setAt: at } });
    const summaries = visibleTaskSummaries([task, store.task(progress.id)], [projectWithPlanner]);
    const prereq = { ...summaries[0]!, waitingOn: '#874', waitState: { state: 'waiting_prerequisite' as const, owner: 'prerequisites', nextAction: 'Wait for prerequisites to finish' } };
    const progressSummary = { ...summaries[1]!, stop: 'run' as const, stopRecord: { reason: 'run_stalled' as const, detail: 'lifecycle: Reviewer continuing from checkpoint 2', since: at, suggestedVerbs: [] } };
    const holder = seed(store, 'held-by-planner', { phase: 'queued', reason: 'Waiting for dispatch', ...syncHoldProjection({ dispatch: { ...fence('Dispatch held by planner'), owner: 'planner-id' } }) });
    const heldSummary = visibleTaskSummaries([store.task(holder.id)], [projectWithPlanner])[0]!;
    const mergeHolder = seed(store, 'merge-held-by-planner', { phase: 'merging', reason: 'Merge held by planner-id: waiting for receipt', ...syncHoldProjection({ merge: { ...fence('waiting for receipt'), owner: 'planner-id' } }) });
    const mergeSummary = { ...visibleTaskSummaries([store.task(mergeHolder.id)], [projectWithPlanner])[0]!, waitState: { state: 'merge_hold' as const, owner: 'planner', nextAction: 'Release the hold' }, stop: 'run' as const, stopRecord: { reason: 'held' as const, detail: 'Merge held by planner-id: waiting for receipt', since: at, suggestedVerbs: [] } };
    const operatorHolder = seed(store, 'held-by-operator', { phase: 'queued', reason: 'Waiting for dispatch', ...syncHoldProjection({ dispatch: { ...fence('Dispatch held by operator'), owner: 'operator' } }) });
    const otherHolder = seed(store, 'held-by-other-thread', { phase: 'queued', reason: 'Waiting for dispatch', ...syncHoldProjection({ dispatch: { ...fence('Dispatch held by another thread'), owner: 'other-thread' } }) });
    assert.equal(visibleTaskSummaries([store.task(operatorHolder.id)], [projectWithPlanner])[0]?.holdDisplayOwner, 'you');
    assert.equal(visibleTaskSummaries([store.task(otherHolder.id)], [projectWithPlanner])[0]?.holdDisplayOwner, 'a planner thread');
    for (const compact of [true, false]) {
      mounted?.update(h('View', null));
      mounted = mountBoard(invokeWith(board([prereq, progressSummary, heldSummary, mergeSummary]), async () => ({ tasks: [], hasMore: false })), compact);
      const tree = mounted;
      await settle(() => tree.text().includes('After #874'));
      assert.ok(tree.text().includes('After #874 · Machine ports move out of the Paseo adapter · Changes · +1 more'));
      assert.ok(!tree.text().includes('84aa4e89'));
      assert.ok(tree.text().includes('Reviewer continuing from checkpoint 2'));
      assert.ok(!tree.text().includes('Stopped just now'));
      assert.ok(tree.text().includes('Dispatch held by App planner'));
      assert.ok(tree.text().includes('Merge held by App planner'));
      assert.match(tree.text(), /Held · \d+d ago/);
      assert.ok(!tree.query(/^app, progress,/)?.props.accessibilityLabel?.includes('no owner verb'));
      const prerequisiteLabel = tree.query(/^app, dependency,/)?.props.accessibilityLabel as string;
      assert.ok(prerequisiteLabel.includes('Waiting for prerequisite: After #874 · Machine ports move out of the Paseo adapter · Changes · +1 more'));
      assert.ok(!prerequisiteLabel.includes('84aa4e89'));
      assert.ok(!prerequisiteLabel.includes('Waiting for prerequisite, Waiting for prerequisite'));
      assert.ok(tree.query(/^app, progress,/)?.props.accessibilityLabel?.includes('Waiting: lifecycle: Reviewer continuing from checkpoint 2'));
    }
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('every task and decision card keeps stored IDs and hashes out of visible and accessible text', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const uuid = '7a3c4bc4-e0db-48bb-9071-4ae6f3a09222';
    const digest = '79768fb6010d5f4859798c1040303dff4a9cb3697ad3f773f755480d4a4164a8';
    const rows = [
      seed(store, 'operator-wait', { phase: 'blocked', reason: 'Needs decision' }),
      seed(store, 'escalation-wait', { phase: 'blocked', reason: 'Waiting with the planner or task owner ' + uuid + ': blocker escalation ' + digest }),
      seed(store, 'source-wait', { phase: 'queued', reason: `Waiting for source ${uuid} ${digest}` }),
      seed(store, 'held-attention', { phase: 'needs_attention', reason: `Merge held by ${uuid}: receipt ${digest}` }),
      seed(store, 'reason-card', { phase: 'working', reason: `Working on ${uuid}; ref ${digest}` }),
    ];
    const plannerProject = projectSchema.parse({ ...project, planner: { agentId: uuid, setBy: 'operator', setAt: at } });
    const escalation = store.task(rows[1]!.id);
    store.update(escalation.id, { resolution: { ...escalation.resolution, stop: { reason: 'escalated', detail: `Waiting with the planner or task owner ${uuid}: blocker escalation ${digest}`, since: at, suggestedVerbs: [] } } });
    const base = visibleTaskSummaries(rows.map(row => store.task(row.id)), [plannerProject]);
    const decision = {
      id: 'decision-card', version: 1, question: `Should we keep ${uuid} at ${digest}?`,
      choices: [{ label: `Keep ${uuid}`, consequence: `Build ${digest}` }, { label: `Pause ${uuid}`, consequence: `Wait ${digest}` }],
      recommended: `Keep ${uuid}`, details: null, context: null, options: [], recommendation: null,
      overtakenBy: [], askedBy: { agentId: 'agent-asker', project: null },
      links: { tasks: [], leads: [], papercuts: [] }, status: 'open', answer: null, withdrawal: null,
      supersededBy: null, delivery: null, createdAt: at, updatedAt: at, versions: [], stale: false, projectKey: 'app',
    };
    const cards = [
      { ...base[0]!, waitState: { state: 'needs_operator_input' as const, owner: 'operator', nextAction: `Answer ${uuid}`, decisionId: uuid }, reason: `Waiting on ${uuid} ${digest}` },
      { ...base[1]!, stop: 'run' as const, stopRecord: { reason: 'escalated' as const, detail: `Waiting with the planner or task owner ${uuid}: blocker escalation ${digest}`, since: at, suggestedVerbs: [] } },
      { ...base[2]!, waitState: { state: 'needs_source_rights' as const, owner: 'operator', nextAction: `Accept ${digest}` } },
      { ...base[3]!, holdEscalated: true, hold: { owner: uuid, reason: `receipt ${uuid} ${digest}`, since: at } },
      { ...base[4]!, reason: `Working on ${uuid}; ref ${digest}` },
    ];
    const snapshot = { ...board(cards), projects: [plannerProject] };
    for (const compact of [true, false]) {
      mounted?.update(h('View', null));
      mounted = mountBoard(invokeWith(snapshot, async () => ({ tasks: [], hasMore: false }), [], [decision]), compact);
      const tree = mounted;
      await settle(() => Boolean(tree.query(/^app, reason-card,/)));
      const raw = new RegExp(`(?:${uuid}|\\b[0-9a-f]{40}\\b|\\b[0-9a-f]{64}\\b)`, 'i');
      const texts = tree.ofType('Text').flatMap(node => node.children.filter((child): child is string => typeof child === 'string'));
      assert.equal(texts.some(text => raw.test(text)), false, 'visible card text contains no UUID or digest');
      const labels = tree.all(/.*/).map(node => node.props.accessibilityLabel).filter((value): value is string => typeof value === 'string');
      assert.equal(labels.some(label => raw.test(label)), false, 'card labels contain no UUID or digest');
      assert.ok(tree.text().includes('Waiting on App planner · blocker escalation'));
      assert.ok(tree.text().includes('Waiting on you'));

      const decisionTree = mount(h(queue.DecisionCard as never, { decision, selected: false, onPress: () => {}, c, board: compact }));
      try {
        assert.ok(decisionTree.text().includes('Should we keep task at details?'), 'the decision question is visible in plain form');
        const decisionTexts = decisionTree.ofType('Text').flatMap(node => node.children.filter((child): child is string => typeof child === 'string'));
        assert.equal(decisionTexts.some(text => raw.test(text)), false, 'decision text contains no UUID or digest');
        const decisionLabels = decisionTree.all(/.*/).map(node => node.props.accessibilityLabel).filter((value): value is string => typeof value === 'string');
        assert.equal(decisionLabels.some(label => raw.test(label)), false, 'decision labels contain no UUID or digest');
      } finally { decisionTree.update(h('View', null)); }
    }

    const raw = new RegExp(`(?:${uuid}|\\b[0-9a-f]{40}\\b|\\b[0-9a-f]{64}\\b)`, 'i');
    const assertPlainCard = (task: TaskSummary) => {
      const card = mount(h(queue.TaskCard as never, { task, selected: false, onPress: () => {}, c, board: true }));
      try {
        const text = card.ofType('Text').flatMap(node => node.children.filter((child): child is string => typeof child === 'string'));
        assert.equal(text.some(value => raw.test(value)), false, `visible text leaks from ${task.waitState?.state ?? task.stopRecord?.reason ?? 'task'}`);
        const labels = card.all(/.*/).map(node => node.props.accessibilityLabel).filter((value): value is string => typeof value === 'string');
        assert.equal(labels.some(value => raw.test(value)), false, `accessible text leaks from ${task.waitState?.state ?? task.stopRecord?.reason ?? 'task'}`);
      } finally { card.update(h('View', null)); }
    };
    for (const state of waitStates) assertPlainCard({ ...base[4]!, waitState: {
      state, owner: state === 'needs_operator_input' || state === 'needs_source_rights' ? 'operator' : 'task',
      nextAction: `Resolve ${uuid} ${digest}`, ...(state === 'needs_operator_input' ? { decisionId: uuid } : {}),
    } });
    for (const reason of taskStopReasons) assertPlainCard({ ...base[4]!, stop: 'run', stopRecord: {
      reason, detail: reason === 'held' ? `Merge held by ${uuid}: receipt ${digest}` : `Waiting with the planner or task owner ${uuid}: blocker escalation ${digest}`,
      since: at, suggestedVerbs: [],
    } });
    for (const kind of ['dispatch', 'merge'] as const) assertPlainCard({ ...base[4]!, holds: {
      [kind]: { owner: uuid, reason: `${kind} hold ${uuid} ${digest}`, since: at },
    }, holdDisplayOwner: 'App planner' });
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('a long shell command card shows only its recorded elapsed time', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const startedAt = new Date(Date.now() - 26 * 60_000).toISOString();
    const command = `Worker is executing a shell command that has run for over 15 minutes (started at ${startedAt}): TMPDIR='/scratch/qa/project-a' effigy check`;
    const task = seed(store, 'long-command', { phase: 'working', reason: command });
    const summary = summarizeTask(store.task(task.id));
    for (const compact of [true, false]) {
      mounted?.update(h('View', null));
      mounted = mountBoard(invokeWith(board([summary]), async () => ({ tasks: [], hasMore: false })), compact);
      const tree = mounted;
      await settle(() => tree.text().includes('Long shell command'));
      assert.match(tree.text(), /Long shell command · 26m/);
      const label = tree.query(/^app, long-command,/)?.props.accessibilityLabel as string;
      assert.match(label, /Long shell command · 26m/);
      assert.ok(!label.includes('TMPDIR='));
      assert.ok(!tree.text().includes('TMPDIR='));
    }
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('the overflow card shows loading, then an error, while its queued page loads', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const f = fixtures(store);
    const snapshot = board([f.held, f.heavy, f.queued], [{ repoPath: '/app', count: 12 }]);
    // Loading: the page does not answer yet.
    mounted = mountBoard(invokeWith(snapshot, () => new Promise(() => undefined)));
    let tree = mounted;
    await settle(() => Boolean(tree.query('9 more queued in app')));
    tree.press('9 more queued in app');
    await settle(() => tree.text().includes('Loading queued tasks…'));
    mounted.update(h('View', null));

    // Error: the page refuses; the overflow says so.
    mounted = mountBoard(invokeWith(snapshot, async () => { throw new Error('queue unavailable'); }));
    tree = mounted;
    await settle(() => Boolean(tree.query('9 more queued in app')));
    tree.press('9 more queued in app');
    await settle(() => tree.text().includes('Could not load queued tasks. Try again.'));
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('the card keeps two-line titles, drops the repository and phase chips, and moves lanes to the task view', () => {
  const ui = boardSource();
  const start = ui.indexOf('function TaskCard(');
  const end = ui.indexOf('\n});\n', start);
  const card = ui.slice(start, end);
  // The title is capped at two lines and carries the short number, never the multi-repo reference.
  assert.match(card, /numberOfLines=\{2\} style=\{\{ color: c\.foreground, fontWeight: "600"/);
  assert.match(card, /taskNumberLabel\(task, false\)/);
  assert.doesNotMatch(card, /repoChip|phaseChip|laneChips|profile\?\.name/);
  // The board call site passes only what the card still uses.
  const call = ui.slice(ui.indexOf('<TaskCard'), ui.indexOf('/>', ui.indexOf('<TaskCard')));
  assert.doesNotMatch(call, /phaseChip|repoChip|laneChips/);
  assert.match(card, /return <BoardCard/);
  assert.match(card, /Hold reason preview · \{holdReasonPreview\(dispatchWait\.reason\)\}/);
  assert.match(ui, /Stop category · \{taskSummaryStop\.reason\}/);
  assert.match(ui, /Suggested owner verbs · \{taskSummaryStop\.suggestedVerbs\.join\(\", \"\)\}/);
});

// Triage (Tom, 2026-11-07): a lead card is a title, a kind, the project and one state line. The
// body preview the read carries stays out of the card; the record holds it.
// The read bounds a preview to LEAD_PREVIEW_MAX characters; the fixture is exactly that long.
const LONG_BODY = `What happened ${'the reader stops at the first line. '.repeat(12)}Impact`.slice(0, LEAD_PREVIEW_MAX);
const LONG_CUT = 'A papercut whose title runs well past the single line a Triage card can show, so the row stays short and the record carries the rest';
const triageLead = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
  id, title, preview: LONG_BODY, repositories: [repo], lanes: [], tags: [], papercutArea: null,
  state: 'open', version: 1, check: null, approved: false, targets: [], ...patch,
});
const triagePapercuts = (count: number) => Array.from({ length: count }, (_, index) => {
  const letter = 'abcdefghijklmnop'[index];
  return triageLead(`cut-${letter}`, `Papercut ${letter}`, { tags: ['papercut'] });
});

test('a long papercut and a long lead render as one-line cards with a kind, a project and one state line', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const leads = [
      triageLead('long-cut', LONG_CUT, { tags: ['papercut'], papercutArea: 'board' }),
      triageLead('long-lead', LONG_TITLE, { tags: ['idea'], check: { ok: true } }),
    ];
    mounted = mountBoard(invokeWith(board([]), async () => ({ tasks: [], hasMore: false }), leads));
    const tree = mounted;
    await settle(() => tree.text().includes('Checks passed · unapproved'));
    assert.ok(tree.query(`Triage: ${LONG_CUT}`), 'the papercut card keeps its accessible label');
    assert.match(tree.text(), /Open · board/, 'a papercut states its area');
    assert.match(tree.text(), /Papercut/, 'the kind chip names a papercut');
    assert.match(tree.text(), /Lead/, 'the kind chip names a lead');
    assert.ok(!tree.text().includes('What happened'), 'the body passage stays in the record');
    for (const title of [LONG_CUT, LONG_TITLE]) {
      const lines = tree.ofType('Text').filter(node => node.children.join('') === title).map(node => node.props.numberOfLines);
      assert.deepEqual(lines, [1], `the title "${title.slice(0, 24)}…" is one line`);
    }
  } finally { mounted?.update(h('View', null)); store.close(); }
});

// #940 removed swim-lane groups; the overflow card remains inside Triage.
test('Triage shows a page of eight, an in-column card loads the rest, and the header shows the real total', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    mounted = mountBoard(invokeWith(board([]), async () => ({ tasks: [], hasMore: false }), triagePapercuts(10)));
    const tree = mounted;
    await settle(() => Boolean(tree.query('Triage, 10')));
    assert.equal(tree.all(/^Triage: Papercut /).length, 8, 'the first page holds eight cards');
    assert.ok(tree.text().includes('…and 2 more'), 'the overflow card carries the rest of the total');
    tree.press('Show 2 more in Triage');
    await settle(() => tree.all(/^Triage: Papercut /).length === 10);
    assert.equal(tree.query('Show 2 more in Triage'), undefined, 'no overflow card once every card shows');
    assert.ok(tree.query('Triage, 10'), 'paging leaves the header total alone');
  } finally { mounted?.update(h('View', null)); store.close(); }
});

test('the Triage tag filter narrows the cards, the header total and the paging', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const leads = [...triagePapercuts(10), triageLead('idea-lead', 'Idea lead', { tags: ['idea'] })];
    mounted = mountBoard(invokeWith(board([]), async () => ({ tasks: [], hasMore: false }), leads));
    const tree = mounted;
    await settle(() => Boolean(tree.query('Triage, 11')));
    tree.press('Filter Triage by tag, All tags (11)');
    tree.press('Filter Triage by tag: idea (1)');
    await settle(() => Boolean(tree.query('Triage: Idea lead')));
    assert.equal(tree.all(/^Triage: Papercut /).length, 0, 'the papercut tag filters the papercuts out');
    assert.ok(tree.query('Triage, 1'), 'the header shows the filtered total');
    assert.equal(tree.query('Show 2 more in Triage'), undefined, 'a filtered column that fits one page has no overflow card');
  } finally { mounted?.update(h('View', null)); store.close(); }
});

// #1042 review: the Pipeline's view state lives in the shell, so a visit to another tab keeps it.
test('the Triage tag, Triage page and open queued-more page survive a round trip to Planning', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const leads = [...triagePapercuts(10), triageLead('idea-lead', 'Idea lead', { tags: ['idea'] })];
    mounted = mountBoard(invokeWith(board([], [{ repoPath: '/app', count: 3 }]), async () => ({ tasks: [], hasMore: false }), leads));
    const tree = mounted;
    await settle(() => Boolean(tree.query('Triage, 11')) && Boolean(tree.query('3 more queued in app')));
    tree.press('Show 3 more in Triage');
    await settle(() => tree.all(/^Triage: /).length === 11);
    tree.press('3 more queued in app');
    await settle(() => Boolean(tree.query('Previous')));
    tree.press('Planning');
    await settle(() => !tree.query(/^Triage, /));
    tree.press(/^Tasks \(/);
    await settle(() => Boolean(tree.query(/^Triage, /)));
    assert.equal(tree.all(/^Triage: /).length, 11, 'the expanded Triage page is kept');
    assert.ok(tree.query('Previous'), 'the open queued-more page is kept');
    tree.press('Filter Triage by tag, All tags (11)');
    tree.press('Filter Triage by tag: idea (1)');
    await settle(() => Boolean(tree.query('Triage, 1')));
    tree.press('Planning');
    await settle(() => !tree.query(/^Triage, /));
    tree.press(/^Tasks \(/);
    await settle(() => Boolean(tree.query(/^Triage, /)));
    assert.ok(tree.query('Triage, 1'), 'the Triage tag filter is kept');
    assert.ok(tree.query('Filter Triage by tag, idea (1)'), 'the filter shows the kept tag');
  } finally { mounted?.update(h('View', null)); store.close(); }
});

// #940 removed swim-lane groups; per-project queue overflow stays in the Queued cell.
test('per-project Queued overflow cards render in narrow and wide board layouts', async () => {
  await load();
  for (const compact of [true, false]) {
    const store = new Store(':memory:');
    let mounted: ReturnType<typeof mountBoard> | undefined;
    try {
      mounted = mountBoard(invokeWith(board([], [{ repoPath: '/app', count: 3 }]), async () => ({ tasks: [], hasMore: false })), compact);
      const tree = mounted;
      await settle(() => Boolean(tree.query('3 more queued in app')));
      assert.ok(tree.query('3 more queued in app'), `${compact ? 'narrow' : 'wide'} layout renders the per-project overflow card`);
      assert.ok(tree.query('Queued, 3'), 'the Queued header retains the actual server total');
    } finally { mounted?.update(h('View', null)); store.close(); }
  }
});

test('a Triage card names its project, not its repository, when the two are named differently', async () => {
  await load();
  const store = new Store(':memory:');
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    // The project is "Board Surface"; its repository is owner/app, so the directory name "app" must not show.
    const named = { ...project, name: 'Board Surface' };
    const snapshot = { ...board([]), projects: [named] };
    mounted = mountBoard(invokeWith(snapshot, async () => ({ tasks: [], hasMore: false }), [triageLead('named-lead', 'Named lead', { tags: ['idea'] })]));
    const tree = mounted;
    await settle(() => Boolean(tree.query('Triage: Named lead')));
    const eyebrows = tree.ofType('Text').map(node => node.children.join('')).filter(text => text === 'Board Surface' || text === 'app');
    assert.deepEqual(eyebrows, ['Board Surface'], 'the card shows the project name and no repository name');
  } finally { mounted?.update(h('View', null)); store.close(); }
});
