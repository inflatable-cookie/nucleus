/**
 * Step 8 of the UI lane: QA detail lives in the QA runs tab and Planning links to
 * it; decisions and native questions use the shared controls. These tests pin the
 * states the lane asks for (empty, loading, error, long content, accessible
 * labels), the touch and layout sizes, and that every refusal and unknown-delivery
 * case still reads as unconfirmed rather than safe to retry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mount, useNativeStubs } from './support/render';
import { hostRunRecordSchema, type DecisionView, type HostRunRecord, type Project, type ProjectQaRun } from '../shared/contracts';

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => '#000' }) as never;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (probe()) return;
    await tick();
  }
  assert.ok(probe(), 'the condition never settled');
}

const repository = { origin: 'owner/consumer', path: '/consumer' };
const project = { key: 'consumer-b-v2', name: 'consumer-b-v2', repositories: [repository], primary: repository, visibility: 'active',
  owner: { agentId: 'thread', assignedBy: 'operator', assignedAt: '2026-11-07T00:00:00.000Z', note: '' } } as unknown as Project;
const at = new Date(Date.now() - 60_000).toISOString();

function qaRun(over: Partial<ProjectQaRun> = {}): ProjectQaRun {
  return {
    id: 'qa-run', key: 'owner/consumer', repository, state: 'passed', baseBranch: 'main', base: 'a'.repeat(40), argv: ['effigy', 'qa'],
    digest: 'b'.repeat(64), exitCode: 0, durationMs: 1000, outputTail: '', startedAt: at, finishedAt: at, pid: null,
    admission: null, capacityWait: null, capacityUnavailable: false, steps: [], failedStep: null, interruptedStep: null,
    hostSettlement: null, escapedDescendants: [], cancelReason: null, logWriteErrors: [], ...over,
  } as ProjectQaRun;
}

const hostRun = (id: string, state: 'queued' | 'running' | 'settled'): HostRunRecord => hostRunRecordSchema.parse({
  id, epoch: 1, caller: 'queue:milestone:consumer-b-v2:run', repository, selector: 'qa', runClass: 'heavy', classSource: 'manifest',
  priority: 'milestone', state, submittedAt: at, capacityDeadlineAt: at, runTimeoutMs: 60_000,
  budgetFallback: { cpu: 1, memoryBytes: 100 }, budget: { cpu: 1, memoryBytes: 100, wallMs: null, source: 'fallback' },
  position: state === 'queued' ? 2 : null, admittedAt: state === 'queued' ? null : at, launchedAt: state === 'queued' ? null : at,
  settledAt: state === 'settled' ? at : null, capacitySample: null, pid: 4242, processGroupId: 4242, startIdentity: 'start-1',
  settlement: null, wallMs: null, cpuMs: null, containers: [],
  capacityReleasedAt: state === 'settled' ? at : null, capacityReleaseReason: state === 'settled' ? 'settled' : null,
  capacityReleaseKind: state === 'settled' ? 'automatic' : null,
});

// ---- Planning: the latest result, linked to the QA runs tab ----------------

const plan = {
  project: project.key, version: 1,
  entries: [{ lane: 'ui', note: 'The lane note', horizon: 'now', doneWhen: 'The plan reads in one pass' }],
  savedEntries: [{ lane: 'ui', note: 'The lane note', horizon: 'now', doneWhen: 'The plan reads in one pass' }],
  author: 'operator', createdAt: at, done: [],
} as never;
const planSection = { project, latest: plan, saved: { ...(plan as object), entries: [{ lane: 'ui', note: 'The lane note', horizon: 'now', doneWhen: 'The plan reads in one pass' }] } };

/** The plan column at either viewport, so the compact latest QA is proved at both. */
function renderPlan(props: Record<string, unknown>) {
  return import('../client/planning-panel').then(({ PlanningTab }) => mount(h(PlanningTab, {
    sections: [planSection], lanes: [], edits: {}, selectedLane: '', step: 'plan', busy: false, lanePanel: null,
    onStep() {}, onOpenLane() {}, onEdit() {}, onSave() {}, onCancel() {}, ...props, c,
  } as never)));
}

test('Planning shows the latest QA result in one line and opens its run in the QA runs tab', async () => {
  const { ProjectQaLatest } = await import('../client/planning-panel');
  const failed = qaRun({ id: 'qa-failed', state: 'failed', failedStep: 'teardown', outputTail: 'teardown failed', steps: [{ name: 'teardown', exitCode: 1 } as never] });
  const opened: string[] = [];
  const ui = mount(h(ProjectQaLatest, { project, runs: [failed], onOpenRun: (id: string) => opened.push(id), c } as never));
  assert.match(ui.text(), /teardown failed · consumer-b-v2/, 'the concise failure leads with its project');
  assert.match(ui.text(), /Failed · Finished/, 'time and state follow the failure');
  assert.doesNotMatch(ui.text(), /Commit a{12}/, 'commit identity is kept in the linked run detail');
  assert.equal(ui.query('Retry teardown for consumer-b-v2'), undefined, 'teardown retry is consolidated into the QA runs tab');
  ui.press('View the latest QA run for consumer-b-v2');
  assert.deepEqual(opened, ['qa-failed']);
});

test('a queued milestone run reads as waiting, never running, and Planning offers no launch or cancel of its own', async () => {
  const { ProjectQaLatest } = await import('../client/planning-panel');
  const queued = qaRun({ id: 'qa-queued', state: 'queued', finishedAt: null, exitCode: null });
  const ui = mount(h(ProjectQaLatest, { project, runs: [queued], onOpenRun() {}, c } as never));
  assert.match(ui.text(), /Queued · waiting, not running/);
  assert.doesNotMatch(ui.text(), /Running/, 'a queued run is never described as running');
  assert.equal(ui.query(/^Run full QA/), undefined, 'starting QA belongs to the QA runs tab');
  assert.equal(ui.query(/^Cancel full QA/), undefined, 'cancelling QA belongs to the QA runs tab');
  assert.ok(ui.query('View the latest QA run for consumer-b-v2'), 'a waiting run still links to its shared detail');
});

test('Planning with no milestone run says so, and nothing links to a run that does not exist', async () => {
  const { ProjectQaLatest } = await import('../client/planning-panel');
  const ui = mount(h(ProjectQaLatest, { project, runs: [], onOpenRun() {}, c } as never));
  assert.match(ui.text(), /No full-QA run yet/);
  assert.equal(ui.query('View the latest QA run for consumer-b-v2'), undefined);
});

test('a first QA read is loading, not an empty result, and a failed read names itself with a retry', async () => {
  const { ProjectQaLatest } = await import('../client/planning-panel');
  const loading = mount(h(ProjectQaLatest, { project, loading: true, onOpenRun() {}, c } as never));
  assert.match(loading.text(), /Loading the latest QA run…/);
  assert.doesNotMatch(loading.text(), /No full-QA run yet/, 'an unread list is never presented as empty');
  assert.equal(loading.query('View the latest QA run for consumer-b-v2'), undefined);
  let retried = 0;
  const failedRead = mount(h(ProjectQaLatest, { project, error: 'socket closed', onOpenRun() {}, onRetry: () => { retried++; }, c } as never));
  assert.match(failedRead.text(), /Couldn’t load QA runs: socket closed/);
  assert.match(failedRead.text(), /Nothing here is an empty result until that read succeeds/);
  assert.doesNotMatch(failedRead.text(), /No full-QA run yet/);
  failedRead.press('Retry the latest QA read for consumer-b-v2');
  assert.equal(retried, 1);
});

test('a refresh failure keeps the last QA result and says it may be out of date', async () => {
  const { ProjectQaLatest } = await import('../client/planning-panel');
  const passed = qaRun({ id: 'qa-passed', state: 'passed' });
  const ui = mount(h(ProjectQaLatest, { project, runs: [passed], error: 'socket closed', onOpenRun() {}, c } as never));
  assert.match(ui.text(), /Passed/, 'the last result read stays visible');
  assert.match(ui.text(), /Showing the last result read\. The QA runs could not be refreshed: socket closed\. It may be out of date\./);
});

test('Planning names capacity waits, unavailable capacity and escaped descendants as alerts, not failures', async () => {
  const { ProjectQaLatest } = await import('../client/planning-panel');
  const waiting = qaRun({ id: 'qa-wait', state: 'queued', finishedAt: null, capacityWait: { position: 3, since: at } as never });
  const waitingUi = mount(h(ProjectQaLatest, { project, runs: [waiting], onOpenRun() {}, c } as never));
  assert.match(waitingUi.text(), /waiting for QA capacity \(position 3\)/);
  const unavailable = qaRun({ id: 'qa-cap', state: 'failed', capacityUnavailable: true, failedStep: null });
  const unavailableUi = mount(h(ProjectQaLatest, { project, runs: [unavailable], onOpenRun() {}, c } as never));
  assert.match(unavailableUi.text(), /QA capacity unavailable: .* This is not a QA failure\./);
  const escaped = qaRun({ id: 'qa-escaped', state: 'hold', escapedDescendants: [{ pid: 9, startIdentity: 'x' }] as never });
  const escapedUi = mount(h(ProjectQaLatest, { project, runs: [escaped], onOpenRun() {}, c } as never));
  assert.match(escapedUi.text(), /Escaped descendants not proven dead: 1/);
});

test('the latest QA sits in the project plan at the wide and the narrow size, linked to the shared detail', async () => {
  const failed = qaRun({ id: 'qa-plan', state: 'failed', failedStep: 'qa' });
  for (const compact of [false, true]) {
    const opened: string[] = [];
    const ui = await renderPlan({ compact, qaRuns: [failed], onOpenQaRun: (id: string) => opened.push(id) });
    const planBox = ui.get('Plan for consumer-b-v2');
    assert.ok(planBox, 'the plan is on screen');
    const latest = ui.get('Latest QA for consumer-b-v2');
    assert.equal(latest.props.accessibilityLabel, 'Latest QA for consumer-b-v2');
    assert.match(ui.text(), /Latest QA[\s\S]*qa failed · consumer-b-v2/, 'the concise failure and project sit inside the plan');
    ui.press('View the latest QA run for consumer-b-v2');
    assert.deepEqual(opened, ['qa-plan'], 'the link opens the run in the QA runs tab');
    assert.equal(ui.query(/^Run full QA/), undefined, 'the plan never duplicates the QA runs tab launch control');
  }
});

test('the plan reads a queued QA as waiting at both sizes, never as running', async () => {
  const queued = qaRun({ id: 'qa-plan-queued', state: 'queued', finishedAt: null, exitCode: null });
  for (const compact of [false, true]) {
    const ui = await renderPlan({ compact, qaRuns: [queued] });
    assert.match(ui.text(), /Queued · waiting, not running/);
    assert.doesNotMatch(ui.text(), /Running/, 'a queued plan result never reads as running');
  }
});

test('the plan keeps a loading QA read, a failed one and no run apart', async () => {
  const loading = await renderPlan({ qaLoading: true });
  assert.match(loading.text(), /Loading the latest QA run…/);
  assert.doesNotMatch(loading.text(), /No full-QA run yet/);
  const failedRead = await renderPlan({ qaError: 'socket closed' });
  assert.match(failedRead.text(), /Couldn’t load QA runs: socket closed/);
  const empty = await renderPlan({ qaRuns: [] });
  assert.match(empty.text(), /No full-QA run yet/);
});

// ---- QA runs tab: the one place QA detail lives ---------------------------

async function renderTab(props: Record<string, unknown>) {
  const { QaRunsTab } = await import('../client/qa-runs-tab');
  const calls = { retry: [] as Array<[string, string]>, cancel: [] as Array<[string, string]>, opened: [] as string[] };
  const runs = (props.runs as HostRunRecord[] | undefined) ?? [];
  const ui = mount(h(QaRunsTab, {
    runs, qaRuns: [], projects: [project], tasks: [], selectedProjects: [], busy: false,
    onRunQa() {}, onCancelQa(id: string, reason: string) { calls.cancel.push([id, reason]); },
    onRetryTeardownQa(id: string, reason: string) { calls.retry.push([id, reason]); }, onReleaseCapacity() {}, onOpenTask(id: string) { calls.opened.push(id); },
    ...props, c,
  } as never));
  return { ui, calls };
}

test('a Planning link opens its run on the QA runs tab, with the teardown retry and a required reason', async () => {
  const failed = qaRun({ id: 'qa-failed', state: 'failed', failedStep: 'teardown' });
  const { ui, calls } = await renderTab({ runs: [hostRun('qa-failed', 'settled')], qaRuns: [failed], focusRunId: 'qa-failed' });
  assert.ok(ui.query('QA run detail qa-failed'), 'the detail opens on the focused run');
  assert.equal(ui.get('Retry teardown for run qa-failed').props.accessibilityState.disabled, true, 'disabled until a reason is entered');
  ui.type('Teardown retry reason for run qa-failed', 'colima restarted');
  ui.press('Retry teardown for run qa-failed');
  assert.deepEqual(calls.retry, [['qa-failed', 'colima restarted']]);
});

test('PID, epoch and the output tail are behind a diagnostics disclosure, closed by default', async () => {
  const running = qaRun({ id: 'qa-live', state: 'running', finishedAt: null, outputTail: 'compiling crate wibble' });
  const { ui } = await renderTab({ runs: [hostRun('qa-live', 'running')], qaRuns: [running], focusRunId: 'qa-live' });
  const toggle = 'Diagnostics: identity, host process and output';
  assert.equal(ui.get(toggle).props.accessibilityState.expanded, false);
  assert.equal(ui.query('QA run identity'), undefined, 'identity is hidden until asked for');
  assert.doesNotMatch(ui.text(), /PID 4242/);
  ui.press(toggle);
  assert.equal(ui.get(toggle).props.accessibilityState.expanded, true);
  assert.match(ui.text(), /Host process · PID 4242/);
  assert.ok(ui.query('QA output tail'), 'the output tail opens with the identity');
});

test('the detail sheet is full width on a narrow screen and capped at 720 on a wide one; the failed-only switch is 44 points', async () => {
  const failed = qaRun({ id: 'qa-failed', state: 'failed', failedStep: 'test' });
  const { ui } = await renderTab({ runs: [hostRun('qa-failed', 'settled')], qaRuns: [failed], focusRunId: 'qa-failed' });
  const sheet = ui.get('QA run detail qa-failed').props.style;
  assert.equal(sheet.width, '100%');
  assert.equal(sheet.maxWidth, 720);
  assert.equal(ui.get('Failed only').props.style.minHeight, 44);
});

test('empty, loading and error states say what is absent, what is loading, and that a failed list may be stale', async () => {
  const empty = await renderTab({ runs: [] });
  assert.match(empty.ui.text(), /Nothing is running or waiting\./);
  assert.match(empty.ui.text(), /No settled runs in the past 24 hours\./);
  const loading = await renderTab({ runs: [], loading: true });
  assert.match(loading.ui.text(), /Loading QA runs…/);
  const failed = await renderTab({ runs: [], loadError: 'service unavailable' });
  assert.match(failed.ui.text(), /Could not load QA runs: service unavailable\. The list may be out of date\./);
});

test('a long failure line is cut to a readable summary and stays in the row', async () => {
  const long = `${'expected value '.repeat(40)}end`;
  const failed = qaRun({ id: 'qa-long', state: 'failed', failedStep: 'test', outputTail: long });
  const { ui } = await renderTab({ runs: [hostRun('qa-long', 'settled')], qaRuns: [failed] });
  const summary = ui.get('Failure summary for qa-long');
  const text = summary.children.join('');
  assert.ok(text.length < 240, `the summary is bounded, got ${text.length}`);
  assert.match(text, /…/);
  const row = ui.all(/.*/).find(node => node.props.accessibilityRole === 'button' && String(node.props.accessibilityLabel).includes('Open QA run details'));
  assert.ok(row, 'the row stays a single pressable target');
  assert.match(row!.props.accessibilityLabel, /consumer-b-v2, Failed, Milestone QA, expected value/);
  assert.match(row!.props.accessibilityLabel, /Open QA run details/);
  assert.doesNotMatch(row!.props.accessibilityLabel, /qa-long/);
});

test('unknown QA results and capacity waits remain distinct from failed runs', async () => {
  const unknown = await renderTab({ runs: [hostRun('qa-unknown', 'settled')] });
  assert.match(unknown.ui.text(), /Unknown result/);
  const waiting = await renderTab({ runs: [hostRun('qa-waiting', 'queued')] });
  assert.match(waiting.ui.text(), /Queued #2/);
  assert.doesNotMatch(waiting.ui.text(), /Failure summary for qa-waiting/);
});

// ---- Decisions: the pill popover on the shared controls -------------------

const decision = (over: Partial<DecisionView> = {}): DecisionView => {
  const { askerLabel, ...rest } = over;
  return {
    id: 'decision-1', version: 1, question: 'Which branch do we cut?', headline: 'Which branch do we cut?',
    choices: [{ label: 'main', consequence: 'Use the stable branch.' }, { label: 'branch', consequence: 'Start from the feature branch.' }],
    recommended: 'main', details: null, overtakenBy: [], context: null, options: ['main', 'branch'], recommendation: 'main',
    askedBy: { agentId: 'agent-asker', project: { origin: 'owner/decisions', path: '/fixture/decisions' } }, links: { tasks: [], leads: [], papercuts: [] },
    askerLabel: askerLabel ?? 'agent-asker',
    status: 'open', answer: null, withdrawal: null, supersededBy: null, delivery: null,
    createdAt: '2026-09-29T10:00:00Z', updatedAt: '2026-09-29T10:00:00Z', versions: [], stale: false, projectKey: 'decisions', ...rest,
  };
};
const popoverProps = () => ({
  theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const },
  context: 'agent' as const, workspaceId: 'ws-1', agentId: 'agent-asker', close: () => {},
});

/**
 * A client whose decision reads and answers are scripted, counting every read.
 * It serves no board snapshot, so every read here also proves a failed snapshot
 * falls back to a direct decision read (task 1030 keyed the read on it).
 */
function decisionClient(script: { reads: Array<DecisionView[] | Error | 'pending'>; answer?: Error }) {
  const state = { reads: 0, answers: [] as unknown[] };
  const client = {
    rpc: async (contract: { name: string }, input: Record<string, unknown>) => {
      if (contract.name === 'decision.list') {
        state.reads++;
        const next = script.reads.length > 1 ? script.reads.shift()! : script.reads[0]!;
        if (next === 'pending') return new Promise<DecisionView[]>(() => {});
        if (next instanceof Error) throw next;
        return next;
      }
      if (contract.name === 'decision.answer') {
        if (script.answer) throw script.answer;
        state.answers.push(input);
        return decision({ status: 'answered' });
      }
      throw new Error(`unexpected rpc ${contract.name}`);
    },
    openPanel() {},
  };
  return { client, state };
}

async function popover(client: unknown) {
  const { decisionPillPopover } = await import('../client/decision-pill');
  return decisionPillPopover({ client: client as never, boardPanelId: 'queue-board' });
}

test('a decision list that fails says so with a retry, and never reads as loading', async () => {
  const { client, state } = decisionClient({ reads: [new Error('connection reset'), [decision()]] });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes('Could not load decisions: connection reset'));
  assert.doesNotMatch(ui.text(), /Loading decisions…/, 'a failed read is not still loading');
  ui.press('Retry loading open decisions');
  await settle(() => ui.text().includes('Which branch do we cut?'));
  assert.ok(state.reads >= 2, 'the retry reads Queue again');
});

test('while the first read is in flight the popover says it is loading decisions', async () => {
  const { client } = decisionClient({ reads: ['pending'] });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  assert.match(ui.text(), /Loading decisions…/);
});

test('with no open decisions the popover says so, with no answer box to fill', async () => {
  const { client } = decisionClient({ reads: [[]] });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes('No open decisions.'));
  assert.equal(ui.query(/Answer box:/), undefined);
});

test('the answer button names why it is unavailable, and the option rows meet the 44-point target', async () => {
  const { client } = decisionClient({ reads: [[decision()]] });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes('Which branch do we cut?'));
  assert.equal(ui.get(/Answer decision: Which branch do we cut\?/).props.accessibilityHint, 'Write an answer or pick an option first');
  assert.equal(ui.get(/^Use option: main/).props.style.minHeight, 44);
  ui.type(/Answer box: Which branch do we cut\?/, 'Cut from main.');
  assert.equal(ui.get(/Answer decision: Which branch do we cut\?/).props.accessibilityHint, undefined, 'an enabled button carries no reason');
});

test('a refused answer is not confirmed, keeps the draft, and reloads the decision', async () => {
  const { client, state } = decisionClient({ reads: [[decision()]], answer: new Error('Decision changed to version 2') });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes('Which branch do we cut?'));
  ui.type(/Answer box: Which branch do we cut\?/, 'Cut from main.');
  ui.press(/Answer decision: Which branch do we cut\?/);
  await settle(() => ui.text().includes('Answer not confirmed: Decision changed to version 2'));
  assert.match(ui.text(), /Check the decision before answering again; your draft is kept\./);
  assert.equal(ui.query(/Answer box: Which branch do we cut\?/)?.props.value, 'Cut from main.', 'the draft survives the refusal');
  assert.equal(state.answers.length, 0);
});

// ---- Native questions: the thread's own requests on the shared controls ---

test('a native question submit names why it is unavailable, and a failed answer is not confirmed', async () => {
  const { NativeQuestionAnswer, bindWebQuestions } = await import('../client/native-questions');
  const sent: unknown[] = [];
  const unbind = bindWebQuestions(async (agentId, requestId, answers) => {
    sent.push([agentId, requestId, answers]);
    throw new Error('Thread is no longer waiting');
  });
  try {
    const request = { id: 'permission-1', questions: [{ header: 'Question 1', question: 'Ship it?', options: ['release', 'hold'] }] };
    const ui = mount(h(NativeQuestionAnswer as never, { agentId: 'worker', request, onAnswered() {}, c }));
    assert.equal(ui.get('Submit answer').props.accessibilityState.disabled, true);
    assert.equal(ui.get('Submit answer').props.accessibilityHint, 'Answer every question first');
    assert.equal(ui.get('Answer Question 1: release').props.accessibilityState.selected, false);
    ui.press('Answer Question 1: release');
    assert.equal(ui.get('Answer Question 1: release').props.accessibilityState.selected, true);
    ui.press('Submit answer');
    await settle(() => ui.text().includes('Answer not confirmed: Thread is no longer waiting'));
    assert.match(ui.text(), /Check the question before answering again\./);
    assert.deepEqual(sent, [['worker', 'permission-1', { 'Question 1': 'release' }]]);
  } finally {
    unbind();
  }
});
