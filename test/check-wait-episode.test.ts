import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskSchema } from '../shared/contracts';
import type { Task } from '../shared/contracts';
import type { Store } from '../core/store/store';
import { checkEpisodeStep, type CheckEpisodeFacts, type CheckEpisodeStep } from '../core/merge/check-episode';
import { CheckEvidence } from '../core/merge/check-evidence';
import { CheckWaits, type CheckWaitsContext } from '../core/merge/check-waits';

const head = 'a'.repeat(40);
const otherHead = 'b'.repeat(40);
const base = 'c'.repeat(40);

function task(overrides: Partial<Task> = {}): Task {
  return taskSchema.parse({
    submissionId: 's', title: 'T', repoPath: '/repo', planningCommit: base, handoffPath: 'h.md', originAgentId: 'o',
    id: 'task-1', hostId: 'host', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1, phase: 'verifying', reason: '', held: false, handoffText: '', planningBase: base,
    workspaceId: 'ws', directory: '/worktree', branch: 'ns-task-1', agentId: null, runId: null, profile: null,
    workspaceIntent: false, agentIntent: false, lastAgentStatus: null, idleSince: null, completion: null,
    agentActive: null, lastObservedAt: null, prUrl: null, prHead: head, coordinatorGeneration: 1,
    ...overrides,
  });
}

const incident = { id: 'incident-1', role: 'worker' as const, runId: null, fingerprint: 'f', attempt: 0,
  cause: 'other', detail: '', action: '' as const, status: 'escalated' as const,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

type EventRow = { id: number; taskId: string; at: string; kind: string; detail: string };
type ResolutionPatch = Record<string, unknown>;
type UpdateCall = [Task, ResolutionPatch, Record<string, unknown>];

/** The store surface the check-wait owner touches, recorded rather than persisted. */
function fakeStore(options: { task?: Task; events?: EventRow[]; runs?: Record<string, unknown>; meta?: Map<string, unknown> } = {}) {
  const meta = options.meta ?? new Map<string, unknown>();
  const events = options.events ?? [];
  const runs = options.runs ?? {};
  const writes: { kind: string; detail: string }[] = [];
  const updates: UpdateCall[] = [];
  let current = options.task ?? task();
  const store = {
    task: () => current,
    run: (id: string) => runs[id] ?? null,
    eventsAll: () => events,
    events: () => events,
    getMeta: (key: string) => meta.get(key),
    setMeta: (key: string, value: unknown) => { meta.set(key, value); },
    deleteMeta: (key: string) => { meta.delete(key); },
    putRun: (run: unknown) => { runs[(run as { id: string }).id] = run; },
    event: (_id: string, kind: string, detail: string) => { writes.push({ kind, detail }); },
    update: (t: Task, resolution: ResolutionPatch = {}, patch: Record<string, unknown> = {}) => {
      updates.push([t, resolution, patch]);
      current = { ...t, ...patch, resolution: { ...t.resolution, ...resolution } } as Task;
      return current;
    },
  };
  return { store: store as unknown as Store, meta, writes, updates };
}

function waitsFor(store: Store, overrides: Partial<CheckWaitsContext> = {}) {
  const recorded = store as unknown as { update: (...args: unknown[]) => Task };
  return new CheckWaits({
    adapter: {} as CheckWaitsContext['adapter'],
    attention: () => {}, paused: () => false, recordIncidentEvent: () => {},
    refusePreMerge: () => {}, reviewerSetting: () => null, settleAttentionEpisode: () => {},
    update: (...args: unknown[]) => recorded.update(...args), waiting: () => {}, store,
    ...overrides,
  } as CheckWaitsContext);
}

test('the pending-check wait step is one decision over typed facts', () => {
  const facts = (overrides: Partial<CheckEpisodeFacts> = {}): CheckEpisodeFacts => ({
    overdue: true, attention: false, incidentId: null, recoveryRunId: null, recoveryFinished: false,
    checkStillQueued: true, waitedMs: 0, attentionRaisedAt: null, ...overrides,
  });
  const bound = 60 * 60_000;
  const cases: [string, CheckEpisodeFacts, CheckEpisodeStep][] = [
    ['an unexamined overdue wait raises attention', facts(), 'attention'],
    ['an overdue wait inside a visible episode holds it', facts({ attention: true }), 'hold'],
    ['a recovery still running holds the episode', facts({ recoveryRunId: 'run-1' }), 'hold'],
    ['a finished recovery parks itself', facts({ recoveryRunId: 'run-1', recoveryFinished: true }), 'park'],
    ['a still-queued check past the bound escalates once', facts({ recoveryRunId: 'run-1', recoveryFinished: true, waitedMs: bound }), 'escalate'],
    ['a still-queued check below the bound parks', facts({ recoveryRunId: 'run-1', recoveryFinished: true, waitedMs: bound - 1 }), 'park'],
    ['an already-raised escalation keeps waiting without attention', facts({ recoveryRunId: 'run-1', recoveryFinished: true, waitedMs: bound, attentionRaisedAt: 5 }), 'wait'],
    ['an already-raised escalation holds a visible attention state', facts({ recoveryRunId: 'run-1', recoveryFinished: true, attentionRaisedAt: 5, attention: true }), 'hold'],
    ['a check that stopped being queued parks its recovery', facts({ recoveryRunId: 'run-1', recoveryFinished: true, checkStillQueued: false, waitedMs: bound }), 'park'],
    ['a general pending wait is never escalated as overdue', facts({ overdue: false }), 'wait'],
    ['a general pending wait parks attention it did not raise', facts({ overdue: false, attention: true }), 'park'],
  ];
  for (const [label, input, expected] of cases) assert.equal(checkEpisodeStep(input), expected, label);
});

test('check evidence is current only while the settings row it read still stands', () => {
  const evidence = (revision: number | null) => new CheckEvidence({
    adapter: {} as never, reviewerSetting: () => null,
    store: { canonicalRepository: () => revision === null ? undefined : { revision } } as unknown as Store,
  });
  const observed = (settingsRevision: number | null | undefined) => ({ head, base, wait: '', settingsRevision });
  assert.equal(evidence(4).settingsCurrent(task(), observed(4)), true, 'the same revision is current');
  assert.equal(evidence(5).settingsCurrent(task(), observed(4)), false, 'a later revision makes the evidence stale');
  assert.equal(evidence(null).settingsCurrent(task(), observed(null)), true, 'no settings row observed and none now is current');
  assert.equal(evidence(3).settingsCurrent(task(), observed(null)), false, 'a row that appeared makes revision-less evidence stale');
  assert.equal(evidence(null).settingsCurrent(task(), observed(undefined)), true, 'unrevisioned evidence is current only while there is no row');
  assert.equal(evidence(7).settingsCurrent(task(), observed(undefined)), false, 'an unknown revision is not current beside a row');
});

test('a pending-check episode is owned by its durable record, not by the reason text', () => {
  const prose = "Required check 'build' (queued, no runner yet) has been pending past its deadline (2h elapsed, bound 1h); job URL: https://example.test/job/1";
  const plain = task({ reason: prose, resolution: { incident } as Task['resolution'] });
  const noEpisode = fakeStore({ task: plain });
  waitsFor(noEpisode.store).finishRequiredCheckWait(plain, 'Required check reached a failed terminal state');
  assert.deepEqual(noEpisode.updates, [], 'a prose-only reason is not an episode: nothing is settled');
  assert.deepEqual(noEpisode.writes, [], 'no settlement is recorded for a reason without an episode');

  const counted = task({ reason: prose, resolution: { incident, attention: true } as Task['resolution'] });
  const episode = fakeStore({ task: counted });
  episode.meta.set(`requiredCheckPoll:${counted.id}:${head}`, { head, nextAt: 0, incidentId: incident.id });
  const incidents: unknown[] = [];
  waitsFor(episode.store, { recordIncidentEvent: (_id, record) => { incidents.push(record); } })
    .finishRequiredCheckWait(counted, 'Required check reached a failed terminal state');
  assert.equal(episode.meta.has(`requiredCheckPoll:${counted.id}:${head}`), false, 'the settled episode record is cleared');
  assert.equal(episode.updates.length, 1, 'the recorded episode is settled once');
  const [settledTask, resolutionPatch] = episode.updates[0]!;
  assert.equal(settledTask.id, counted.id);
  assert.equal(resolutionPatch.attention, false, 'the episode attention is cleared');
  assert.equal((resolutionPatch.incident as { status: string }).status, 'resolved', 'the incident named by the record is resolved');
  assert.equal(incidents.length, 1, 'the resolved incident is recorded once');
  assert.equal((incidents[0] as { status: string }).status, 'resolved');
});

test('a green gate settles the escalation it raised for failed checks, matched by its recorded refusal class', () => {
  const cause = 'd'.repeat(64);
  const escalationId = 'escalation-1';
  const withRefusal = (refusal: string | undefined, instruction = 'PR checks failed: lint (job URL: https://example.test/job/1)') => fakeStore({
    task: task(),
    runs: { 'run-1': { id: 'run-1', role: 'revision', revisionCause: 'pre_merge', head, released: true, status: 'finished', instruction } },
    events: [
      { id: 1, taskId: 'task-1', at: '2026-01-01T00:00:00.000Z', kind: 'unchanged_check_revision_refused', detail: 'refused at the reviewed head' },
      { id: 2, taskId: 'task-1', at: '2026-01-01T00:00:01.000Z', kind: 'planner_escalation', detail: `${escalationId}: cause ${cause}; run run-1; question digest (1 chars); options move | route` },
      { id: 3, taskId: 'task-1', at: '2026-01-01T00:00:02.000Z', kind: 'planner_escalation_payload', detail: `${escalationId}: ${JSON.stringify({ id: escalationId, runId: 'run-1', question: 'q', ...(refusal === undefined ? {} : { refusal }) })}` },
    ],
  });
  const typed = withRefusal('failed_checks');
  waitsFor(typed.store).resolvePassedUnchangedCheckEscalation(task());
  assert.deepEqual(typed.writes.map(write => write.kind), ['planner_escalation_resolved'],
    'the typed failed-check escalation is settled by a green gate');

  const untyped = withRefusal('pre_merge');
  waitsFor(untyped.store).resolvePassedUnchangedCheckEscalation(task());
  assert.deepEqual(untyped.writes, [], 'a pre-merge refusal escalation is not a check escalation');

  const unrevisioned = fakeStore({ task: task() });
  waitsFor(unrevisioned.store).resolvePassedUnchangedCheckEscalation(task());
  assert.deepEqual(unrevisioned.writes, [], 'a task with no unchanged-check refusal event is never settled');

  // An escalation opened before payloads carried the class names none. It keeps
  // the previous identification through the revision instruction it wrote.
  const legacy = withRefusal(undefined);
  waitsFor(legacy.store).resolvePassedUnchangedCheckEscalation(task());
  assert.deepEqual(legacy.writes.map(write => write.kind), ['planner_escalation_resolved'],
    'a pre-class escalation still settles on a failed-check instruction');

  const legacyOther = withRefusal(undefined, 'Pre-merge refusal is unchanged at the reviewed head: repository hook refused');
  waitsFor(legacyOther.store).resolvePassedUnchangedCheckEscalation(task());
  assert.deepEqual(legacyOther.writes, [], 'a pre-class escalation for another refusal is not a check escalation');
});

test('a pre-class poll record adopts only the deadline wait it recorded, never an unrelated attention', () => {
  const prose = "Required check 'build' (queued, no runner yet) has been pending past its deadline (2h elapsed, bound 1h); job URL: https://example.test/job/1";
  const waiting = task({ reason: prose, resolution: { incident, attention: true } as Task['resolution'] });
  const legacy = fakeStore({ task: waiting });
  legacy.meta.set(`requiredCheckPoll:${waiting.id}:${head}`, { head, nextAt: 0, incidentId: null });
  const incidents: unknown[] = [];
  waitsFor(legacy.store, { recordIncidentEvent: (_id, record) => { incidents.push(record); } })
    .finishRequiredCheckWait(waiting, 'Required checks settled');
  assert.equal(incidents.length, 1, 'the deadline wait settles the incident it raised');
  assert.equal((incidents[0] as { status: string }).status, 'resolved');

  const unrelated = task({ reason: 'A different fault holds this task', resolution: { incident, attention: true } as Task['resolution'] });
  const other = fakeStore({ task: unrelated });
  other.meta.set(`requiredCheckPoll:${unrelated.id}:${head}`, { head, nextAt: 0, incidentId: null });
  const untouched: unknown[] = [];
  waitsFor(other.store, { recordIncidentEvent: (_id, record) => { untouched.push(record); } })
    .finishRequiredCheckWait(unrelated, 'Required checks settled');
  assert.deepEqual(untouched, [], 'an unrelated attention is never settled by a green gate');
  assert.deepEqual(other.updates, [], 'nor is its record rewritten');
});

test('a poll record for another head is not this episode', () => {
  const store = fakeStore({ task: task() });
  store.meta.set(`requiredCheckPoll:${'task-1'}:${otherHead}`, { head: otherHead, nextAt: 0 });
  store.meta.set(`requiredCheckPoll:${'task-1'}:${head}`, { head, nextAt: 42 });
  const waits = waitsFor(store.store);
  assert.equal(waits.requiredCheckPollState(task())?.nextAt, 42, 'only the current head record is the episode');
  assert.equal(waits.requiredCheckPollState(task({ prHead: otherHead }))?.head, otherHead);
});
