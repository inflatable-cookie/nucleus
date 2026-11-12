import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskNextSchema, taskNextVerbSchema, type TaskNext } from '../shared/contracts';
import {
  budgetBars, budgetNeedsAttention, checkTicks, firstSentence, formatSpan, formatTokenCount,
  latestTaskReport, PRIMARY_ACTION_LIMIT, reportHeadline, REPORT_HEADLINE_MAX, suggestedVerbRefusals, taskActionPlan, taskElapsed,
  taskHoldRows, taskOverviewWait, taskReviewProgress, taskWaitCardLabel,
} from '../shared/task-detail-summary';
import { taskBudgetViewSchema } from '../shared/task-budget';
import type { Run, Task } from '../shared/contracts';

const head = 'a'.repeat(40), at = '2026-11-01T00:00:00.000Z';
const verb = (name: string, available = true, args: Record<string, unknown> = { action: name }) =>
  taskNextVerbSchema.parse(available ? { verb: name, action: name, available, args } : { verb: name, action: name, available, refusal: `${name} does not apply now` });

test('a report headline leads, and an older report falls back to the first sentence of its summary', () => {
  assert.equal(reportHeadline({ headline: 'Merged after the second review', summary: 'Long text. More text.' }), 'Merged after the second review');
  assert.equal(reportHeadline({ summary: 'Parser landed. The API layer is next.' }), 'Parser landed.');
  assert.equal(reportHeadline({ headline: null, summary: 'No sentence end here' }), 'No sentence end here');
  assert.equal(reportHeadline(null), '');
  assert.equal(firstSentence(''), '');
  assert.equal(firstSentence('  spaced   out\nsummary. Second. '), 'spaced out summary.');
  const long = 'x'.repeat(REPORT_HEADLINE_MAX + 50);
  const clipped = reportHeadline({ headline: long });
  assert.equal(clipped.length, REPORT_HEADLINE_MAX);
  assert.ok(clipped.endsWith('…'), 'a long headline is clipped with a visible ellipsis');
});

test('the summary keeps the two or three verbs that fit this state and hides refused ones', () => {
  // A held task: clearing the hold leads, whatever the registry order.
  const held = taskActionPlan([verb('stop'), verb('restart'), verb('move'), verb('release', true, { action: 'release', kind: 'merge' }), verb('keep_hold', true, { action: 'keep_hold', kind: 'merge' })]);
  assert.deepEqual(held.primary.map(item => item.verb), ['release', 'keep_hold', 'move']);
  assert.deepEqual(held.more.map(item => item.verb), ['restart', 'stop']);
  assert.equal(held.primary.length, PRIMARY_ACTION_LIMIT);

  // A task waiting on the operator: the answer and its dispositions lead.
  const waiting = taskActionPlan([verb('stop'), verb('move', true, { action: 'move', to: 'work' }), verb('proof'), verb('restart')]);
  assert.deepEqual(waiting.primary.map(item => item.verb), ['move', 'proof', 'restart']);
  assert.equal(waiting.more.length, 1);

  // A refused verb never leads and never sits behind More.
  const refused = taskActionPlan([verb('move', false), verb('restart'), verb('stop', false)]);
  assert.deepEqual(refused.primary.map(item => item.verb), ['restart']);
  assert.deepEqual(refused.more, []);

  // A finished task with one available verb shows exactly that.
  assert.deepEqual(taskActionPlan([verb('complete')]).primary.map(item => item.verb), ['complete']);
  assert.deepEqual(taskActionPlan(null), { primary: [], more: [] });
});

const nextOf = (overrides: Record<string, unknown>) => taskNextSchema.parse({
  taskId: 'task', title: 'Task', phase: 'working', version: 1, repository: null, number: null, reference: null,
  attention: false, reason: 'Waiting', activeRun: null, prHead: null, prUrl: null, branch: 'ns-task', stop: null,
  outcome: {
    accepted: null, reported: null, impediment: null, impediments: [], reader: null, authorResult: null,
    decision: 'Nothing outstanding', revision: { runs: 0, budget: 3, exhausted: false },
  },
  holds: {}, verbs: [], ...overrides,
}) as TaskNext;

test('operator wait cards replace decision IDs with the title and stay readable while it is unavailable', () => {
  const wait = { state: 'needs_operator_input' as const, owner: 'operator', nextAction: 'Answer decision dec-123', decisionId: 'dec-123' };
  assert.equal(taskWaitCardLabel(wait, 'Choose the release window'), 'Waiting on you · Choose the release window');
  assert.equal(taskWaitCardLabel(wait), 'Waiting on you · operator decision');
  assert.equal(taskWaitCardLabel({ ...wait, state: 'waiting_capacity' }), null);
});

test('the overview wait comes from the current stop or wait state, so a superseded reason never lingers', () => {
  const held = taskNow({ stop: { kind: 'hold', reason: 'held', detail: 'Merge held by reviewer · awaiting the external proof', since: at, suggestedVerbs: [], owner: 'reviewer', evidence: null } });
  const heldWait = taskOverviewWait(null, held, 'Source approved at abc1234; awaiting proof');
  assert.equal(heldWait.state, 'Held');
  assert.equal(heldWait.owner, 'reviewer');
  assert.equal(heldWait.nextAction, '', 'a hold names no owner verb to choose');
  assert.equal(heldWait.detail, 'Merge held by reviewer · awaiting the external proof');
  assert.equal(heldWait.detail.includes('Source approved'), false, 'the stale stored reason is dropped');
  assert.equal(heldWait.stop?.since, at, 'the stop keeps its age');

  // The operator's answer leads: the available restart is the next action, the refused move says why.
  const answering = taskNow({
    stop: { kind: 'attention', reason: 'operator_needed', detail: 'Budget reached; the operator chooses', since: at, suggestedVerbs: ['move', 'restart'], owner: 'Queue', evidence: null },
    verbs: [
      taskNextVerbSchema.parse({ verb: 'move', action: 'move', available: false, refusal: 'Moving to work requires the task author' }),
      verb('restart'),
    ],
  });
  const answeringWait = taskOverviewWait(null, answering);
  assert.equal(answeringWait.state, 'Waiting on the operator');
  assert.equal(answeringWait.owner, 'Nucleus', 'the board names Queue as Nucleus');
  assert.equal(answeringWait.nextAction, 'Choose an owner verb below.');
  assert.equal(answeringWait.detail, 'Budget reached; the operator chooses');

  // A recorded wait state is what the card shows, so it wins the state, owner and next action.
  const capacity = taskOverviewWait({ state: 'waiting_capacity', owner: 'Queue QA scheduler', nextAction: 'Wait for a QA slot', reason: 'Waiting for a QA slot' }, held, 'stale');
  assert.equal(capacity.state, 'Waiting for capacity');
  assert.equal(capacity.owner, 'Nucleus QA scheduler');
  assert.equal(capacity.nextAction, 'Wait for a QA slot');
  assert.equal(capacity.detail, 'Merge held by reviewer · awaiting the external proof', 'the live stop still supplies the detail');

  const working = taskNow({ activeRun: { runId: 'run', role: 'reviewer', agentId: 'agent', profileId: 'p', profileName: 'Reader', status: 'running', released: false, lastActivity: at, summary: null } });
  assert.equal(taskOverviewWait(null, working).state, 'No stop or wait; the task is progressing.');
  assert.equal(taskOverviewWait(null, working).owner, '');
  assert.equal(taskOverviewWait(null, working).actor, 'Reviewer Reader is working.', 'the working run names who holds the task');
  assert.equal(taskOverviewWait(null, held).actor, '', 'a stop with no run names no one working');

  assert.equal(taskOverviewWait(null, null, 'Waiting for a slot. More detail.').state, 'Waiting for a slot.');
  assert.equal(taskOverviewWait(null, null, '').state, "Reading the task's current state…", 'before any read, the state says it is loading');
});

test('a suggested owner verb that does not apply is a refusal with its reason, and an available one is not', () => {
  const stop = { kind: 'attention', reason: 'operator_needed', detail: 'The operator chooses', since: at, owner: 'operator', evidence: null };
  const refusals = taskNow({
    stop: { ...stop, suggestedVerbs: ['move', 'route', 'restart'] },
    verbs: [
      taskNextVerbSchema.parse({ verb: 'move', action: 'move', available: false, refusal: 'Moving to work requires the task author' }),
      taskNextVerbSchema.parse({ verb: 'route', action: 'route', available: false, refusal: 'No eligible worker profile' }),
      verb('restart'),
    ],
  });
  assert.deepEqual(suggestedVerbRefusals(refusals), [
    { verb: 'move', reason: 'Moving to work requires the task author' },
    { verb: 'route', reason: 'No eligible worker profile' },
  ]);
  // A route with one available form is an action, not a refusal; a suggestion the registry never lists is not shown.
  const routed = taskNow({
    stop: { ...stop, suggestedVerbs: ['route', 'proof'] },
    verbs: [taskNextVerbSchema.parse({ verb: 'route', action: 'route', available: false, refusal: 'No worker' }), verb('route', true, { action: 'route', role: 'reviewer' })],
  });
  assert.deepEqual(suggestedVerbRefusals(routed), []);
  assert.deepEqual(suggestedVerbRefusals(taskNow({})), [], 'no stop, no refusals');
  assert.deepEqual(suggestedVerbRefusals(null), []);
});

test('the budget shows on the summary only when it is spent or near its limit', () => {
  const figures = { level: 'medium', effectiveTokens: { used: 1_000_000, limit: 5_000_000, evidence: 'exact' }, wallMs: { used: 3_600_000, limit: 180 * 60_000 }, exhausted: null };
  assert.equal(budgetNeedsAttention(taskBudgetViewSchema.parse(figures)), false, 'a budget with room is left to Technical');
  const near = taskBudgetViewSchema.parse({ ...figures, effectiveTokens: { used: 4_200_000, limit: 5_000_000, evidence: 'exact' } });
  assert.equal(budgetNeedsAttention(near), true, 'at or above 80% of a limit it reads on the summary');
  assert.equal(budgetNeedsAttention(taskBudgetViewSchema.parse({ ...figures, exhausted: 'wall_time' })), true);
  assert.equal(budgetNeedsAttention(null), false);
});

// A held/waiting `next` with a null stop needs the same schema shape; name the helper without shadowing `next`.
function taskNow(overrides: Record<string, unknown>) { return nextOf(overrides); }

test('holds are one row each, with holder, reason and age source', () => {
  const rows = taskHoldRows(nextOf({ holds: {
    dispatch: { owner: 'operator', reason: 'Waiting for a dispatch slot', since: at },
    merge: { owner: 'reviewer', reason: 'External receipt pending', since: at },
  } }));
  assert.deepEqual(rows, [
    { kind: 'dispatch', holder: 'operator', reason: 'Waiting for a dispatch slot', since: at },
    { kind: 'merge', holder: 'reviewer', reason: 'External receipt pending', since: at },
  ]);
  assert.deepEqual(taskHoldRows(nextOf({ holds: {} })), []);
  assert.deepEqual(taskHoldRows(null), []);
});

test('review progress names the round against its allowance and the verdict head', () => {
  const accepted = nextOf({ outcome: {
    accepted: { status: 'ready_to_merge', head, currentHead: true, superseded: false, runId: 'r', eventId: 'e', reviewerAgentId: 'a', reviewId: 1, published: true, summary: 'Approved' },
    reported: null, impediment: null, impediments: [], reader: null, authorResult: null,
    decision: 'Merge', revision: { runs: 1, budget: 3, exhausted: false },
  } });
  assert.deepEqual(taskReviewProgress(accepted.outcome), { round: 'Review round 2 of 3', verdict: `Approved at ${head.slice(0, 7)}` });

  const older = nextOf({ outcome: {
    accepted: { status: 'changes_required', head, currentHead: false, superseded: true, runId: 'r', eventId: 'e', reviewerAgentId: 'a', reviewId: null, published: false, summary: null },
    reported: null, impediment: null, impediments: [], reader: null, authorResult: null,
    decision: 'Revise', revision: { runs: 3, budget: 3, exhausted: true },
  } });
  assert.deepEqual(taskReviewProgress(older.outcome), { round: 'Review rounds spent (3 of 3)', verdict: `Changes requested at ${head.slice(0, 7)} (an older head) · superseded` });

  // A task that has not reached review yet shows no round.
  assert.deepEqual(taskReviewProgress(nextOf({}).outcome), { round: '', verdict: '' });
  assert.deepEqual(taskReviewProgress(null), { round: '', verdict: '' });
});

test('the budget reads as two bounded bars and the elapsed clock starts at the first dispatch', () => {
  const budget = taskBudgetViewSchema.parse({
    level: 'medium',
    effectiveTokens: { used: 1_250_000, limit: 5_000_000, evidence: 'exact' },
    wallMs: { used: 3 * 3_600_000, limit: 180 * 60_000 },
    exhausted: null,
  });
  const bars = budgetBars(budget);
  assert.deepEqual(bars.map(bar => bar.key), ['tokens', 'time']);
  assert.equal(bars[0].text, '1.3M / 5M');
  assert.ok(Math.abs(bars[0].ratio - 0.25) < 1e-9);
  assert.equal(bars[1].text, '3h / 3h');
  assert.equal(bars[1].ratio, 1);
  assert.deepEqual(budgetBars(null), []);

  // nucleus#1153: time held on a Nucleus-side cause is named on the time bar, so the
  // board says why the elapsed clock and the budget disagree.
  const paused = budgetBars(taskBudgetViewSchema.parse({ ...budget, level: 'medium',
    effectiveTokens: { used: 1_250_000, limit: 5_000_000, evidence: 'exact' },
    wallMs: { used: 40 * 60_000, limit: 180 * 60_000, pausedMs: 110 * 60_000 } }));
  assert.equal(paused[1].text, '40m / 3h · 1h 50m held on Nucleus faults');
  assert.equal(paused[1].used, 40 * 60_000, 'the bar measures the task\'s own work, not the held time');

  assert.equal(formatTokenCount(950), '950');
  assert.equal(formatTokenCount(12_400), '12.4k');
  assert.equal(formatTokenCount(1_200_000), '1.2M');
  assert.equal(formatSpan(2_700_000), '45m');
  assert.equal(formatSpan(8_040_000), '2h 14m');
  assert.equal(formatSpan(100_800_000), '1d 4h');

  const runs = [{ createdAt: '2026-11-01T00:00:00.000Z' }, { createdAt: '2026-11-01T01:00:00.000Z' }] as Run[];
  assert.equal(taskElapsed(runs, Date.parse('2026-11-01T02:00:00.000Z')), 2 * 3_600_000);
  assert.equal(taskElapsed([], Date.now()), null);
});

test('check ticks read the latest recorded results and never invent one', () => {
  assert.deepEqual(checkTicks({}), []);
  assert.deepEqual(checkTicks({
    validation: { state: 'passed', exitCode: 0 }, milestoneQa: { state: 'running' }, verdict: 'changes_required',
  }), [
    { label: 'Validation', state: 'pass' },
    { label: 'Milestone QA', state: 'pending' },
    { label: 'Review', state: 'fail' },
  ]);
  assert.equal(checkTicks({ validation: { state: 'refused', exitCode: 1 } })[0].state, 'fail');
  assert.equal(checkTicks({ validation: { state: 'hold', exitCode: null, capacityUnavailable: true } })[0].state, 'pending');
  assert.equal(checkTicks({ milestoneQa: { state: 'timed_out' } })[0].state, 'fail');
  assert.equal(checkTicks({ milestoneQa: { state: 'cancelled' } })[0].state, 'info');
});

const taskWith = (overrides: Record<string, unknown>) => ({ ...overrides }) as unknown as Task;

test('the newest worker or reviewer report is the latest line, with its role, model and age', () => {
  const runs = [{
    id: 'r1', taskId: 'task', role: 'reviewer', generation: 1, head, base: head, agentId: 'agent-r', workspaceId: 'w',
    profile: { id: 'p', name: 'Reader', provider: 'provider', model: 'provider/reader', notes: '', available: true, problem: '', supportedThinking: [] },
    status: 'finished', createdAt: '2026-10-01T00:00:00.000Z', lastObservedAt: '2026-10-01T01:00:00.000Z', active: null, idleSince: null,
    released: true, completion: { eventId: 'e', taskId: 'task', runId: 'r1', status: 'changes_required', summary: 'Two findings. Both in the parser.', headline: 'Needs two parser fixes', reviewText: 'Full findings text' },
  }] as unknown as Run[];
  const latest = latestTaskReport(taskWith({ completion: null }), runs);
  assert.equal(latest?.role, 'reviewer');
  assert.equal(latest?.headline, 'Needs two parser fixes');
  assert.equal(latest?.fullText, 'Full findings text');
  assert.equal(latest?.at, '2026-10-01T01:00:00.000Z');
  assert.match(latest!.author, /provider\/reader/);

  // An older report carries no headline: the summary's first sentence stands in.
  const older = [{ ...runs[0], completion: { eventId: 'e', taskId: 'task', runId: 'r1', status: 'blocked', summary: 'Blocked on the fixture. Waiting.' } }] as unknown as Run[];
  assert.equal(latestTaskReport(taskWith({ completion: null }), older)?.headline, 'Blocked on the fixture.');

  // With no completed run, the task row's own worker result is the latest report.
  const rowOnly = latestTaskReport(taskWith({ head: undefined, agentId: 'worker', profile: { name: 'Builder', model: 'provider/builder' },
    completion: { eventId: 'e', taskId: 'task', runId: 'worker', status: 'ready_for_review', headline: 'PR opened for review', summary: 'Opened PR 7' } }));
  assert.equal(rowOnly?.role, 'worker');
  assert.equal(rowOnly?.headline, 'PR opened for review');
  assert.equal(latestTaskReport(taskWith({ completion: null }), []), null);
});
