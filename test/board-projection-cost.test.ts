import { test } from 'node:test';
import { timingTest, performanceAssert } from './support/timing';
import assert from 'node:assert/strict';
import { cpus, loadavg, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Store } from '../core/store/store';
import { createTaskDetailCache } from '../core/telemetry/task-detail';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { createUiSnapshotFactsCache } from '../core/telemetry/ui-snapshot';
import { buildLaneViews, indexOutcomesByLane } from '../core/planning/lanes';
import { outcomeSchema, runSchema, submissionSchema, type Lane, type Outcome, type Task } from '../shared/contracts';

/**
 * Audit A1/A8 board benchmark (2026-10-25 performance audit, main at d5e20937).
 *
 * The audit measured a 48 ms board rebuild, 31 ms of it `buildLaneViews` filtering 6,792
 * outcomes once per each of 240 lanes, and 175 ms to reload every outcome row after a task
 * finished. This fixture keeps the measured outcome population and uses smaller supporting data to measure the
 * same reads before and after this task's change, in one process on one machine: the parent
 * shape is implemented here beside the new one, so the comparison never depends on another
 * commit or another machine's load.
 *
 * Every number printed with `t.diagnostic` is a median of the stated population and cache
 * state on this machine; none is a guarantee for a loaded host or the live database.
 */

const LANES = 240;
const OUTCOMES = 24;
const TASKS = 20;
const LIVE = 2;
const NOTICES = 2;
const EVENTS = 20;
const HEAVY_EVENTS = 2;
const HEAD = 'a'.repeat(40);
const STAMP = '2026-10-08T00:00:00.000Z';

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const timed = (fn: () => unknown) => { const start = performance.now(); fn(); return performance.now() - start; };

/** The parent shape exactly as it read before this task: every lane rescans every outcome. */
const parentLaneViews = (lanes: Lane[], liveTasks: Task[], outcomes: Outcome[]) => lanes
  .map(lane => {
    const attached = liveTasks.filter(task => task.lanes.includes(lane.key) && !['done', 'cancelled'].includes(task.phase) && !task.removedAt);
    const history = outcomes.filter(outcome => outcome.lanes.includes(lane.key))
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
    const liveByPhase: Record<string, number> = {};
    for (const task of attached) liveByPhase[task.phase] = (liveByPhase[task.phase] ?? 0) + 1;
    return { key: lane.key, liveByPhase, terminalCount: history.length, recent: history.slice(0, 10) };
  })
  .sort((a, b) => a.key.localeCompare(b.key));

function auditShapedStore(outcomeCount = OUTCOMES) {
  const store = new Store(':memory:');
  const repository = { origin: 'audit/repository', path: '/audit' };
  store.transaction(() => {
    for (let index = 0; index < LANES; index++)
      store.upsertLane({ key: `lane-${index}`, title: `Lane ${index}`, aim: `Lane ${index} ships its aim.`, repositories: [repository] });
  });
  const tasks: Task[] = [];
  store.transaction(() => {
    for (let index = 0; index < TASKS; index++)
      tasks.push(store.insert(submissionSchema.parse({ submissionId: `task-${index}`, title: `Task ${index}`, repoPath: '/audit',
        planningCommit: HEAD, handoffPath: `task-${index}.md`, originAgentId: 'origin' }), 'host', '', HEAD,
        index < LIVE ? { phase: 'working' } : { phase: 'done' }));
  });
  // Live tasks spread over the lanes.
  for (let index = 0; index < LIVE; index++) store.setTaskLanes(tasks[index], [`lane-${index * 11 % LANES}`]);
  // 6,792 permanent outcomes across the lanes: the read the audit measured at 175 ms cold.
  const template = outcomeSchema.parse({ taskId: 'template', submissionId: 'template', title: 'Template', repository,
    outcome: 'done', reason: 'Completed', pr: null, mergeCommit: null, syncedCommit: null, review: null, validation: null,
    closeout: { authority: 'queue', commit: null }, brief: { digest: `sha256:${'b'.repeat(64)}`, mediaType: 'text/markdown', text: '' },
    workers: [], reviewers: [], siblings: [], startedAt: STAMP, finishedAt: STAMP, backfilled: false, lanes: [] });
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO outcomes(taskId,submissionId,data) VALUES(?,?,?)');
    for (let index = 0; index < outcomeCount; index++) {
      const finishedAt = new Date(Date.parse(STAMP) + index * 60_000).toISOString();
      const record: Outcome = { ...template, taskId: `history-${index}`, submissionId: `history-${index}`, title: `History ${index}`,
        finishedAt, lanes: [`lane-${index % LANES}`, ...(index % 7 === 0 ? [`lane-${(index + 1) % LANES}`] : [])] };
      insert.run(record.taskId, record.submissionId, JSON.stringify(record));
    }
  });
  store.transaction(() => {
    for (let index = 0; index < NOTICES; index++)
      store.putNotice({ id: `notice-${index}`, taskId: tasks[index % LIVE].id, agentId: 'agent', recipientAgentId: 'agent',
        workspaceId: 'ws', sources: ['origin'], originEntry: false, kind: 'completion', status: 'delivered', error: '',
        text: `Notice ${index} ${'x'.repeat(200)}` });
  });
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)');
    for (let index = 0; index < EVENTS; index++)
      insert.run(tasks[index % TASKS].id, new Date(Date.parse(STAMP) + index * 60_000).toISOString(), 'fixture', `Event ${index} ${'y'.repeat(120)}`);
    // Give one selected task a distinct event history.
    for (let index = 0; index < HEAVY_EVENTS; index++)
      insert.run(tasks[0].id, new Date(Date.parse(STAMP) + index * 1_000).toISOString(), 'telemetry_stage', `Stage ${index} ${'z'.repeat(2_000)}`);
  });
  return { store, tasks, repository };
}

test('audit-shaped board: indexed lane views, a forced rebuild, the planning list and the selected task', t => {
  const { store, tasks } = auditShapedStore();
  try {
    assert.equal(store.lanes().length, LANES);
    assert.equal(store.outcomes().length, OUTCOMES);
    assert.equal(store.uiTasks().length, LIVE, 'only the live tasks are board facts');

    // --- lane views: the parent rescan against the indexed read, same population.
    const lanes = store.lanes(), liveTasks = store.uiTasks(), outcomes = store.outcomes();
    const index = indexOutcomesByLane(outcomes);
    const eventTimes = new Map<string, string>();
    for (const row of store.db.prepare("SELECT taskId, MAX(at) AS at FROM events GROUP BY taskId").all())
      eventTimes.set(String(row.taskId), String(row.at));
    const records = store.laneRecordActivity();
    for (let warm = 0; warm < 3; warm++) { parentLaneViews(lanes, liveTasks, outcomes); buildLaneViews(lanes, liveTasks, index, eventTimes, records); }
    const parentRescan: number[] = [], indexed: number[] = [];
    for (let run = 0; run < 15; run++) {
      parentRescan.push(timed(() => parentLaneViews(lanes, liveTasks, outcomes)));
      indexed.push(timed(() => buildLaneViews(lanes, liveTasks, index, eventTimes, records)));
    }
    const parentMedian = median(parentRescan), indexedMedian = median(indexed);

    // --- the cold index build and the audit's 175 ms outcome reload, measured once each.
    const coldIndex = timed(() => indexOutcomesByLane(store.outcomes()));
    const coldOutcomeReload: number[] = [];
    for (let run = 0; run < 5; run++) coldOutcomeReload.push(timed(() => store.outcomes()));

    // --- forced board rebuild: one substantive write, then the whole compact projection.
    const facts = createUiSnapshotFactsCache(store);
    facts();
    const rebuild: number[] = [], rebuildLaneViews: number[] = [];
    for (let run = 0; run < 15; run++) {
      store.update(tasks[0].id, { reason: `Substantive change ${run}` });
      rebuild.push(timed(() => facts()));
      // The same rebuild with the lane-view cache invalidated, as an event write does.
      store.event(tasks[1].id, 'fixture', `activity ${run}`);
      rebuildLaneViews.push(timed(() => store.laneViews()));
    }
    // --- a run observation-only write must not rebuild the board at all.
    const run = runSchema.parse({ id: 'observed-run', taskId: tasks[0].id, role: 'revision', status: 'running',
      workspaceId: 'ws', generation: 1, head: HEAD, base: HEAD, agentId: 'agent', profile: null,
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false, createdAt: STAMP });
    store.putRun(run);
    const frozenBoard = (facts() as { revision: number }).revision;
    const observation: number[] = [];
    for (let index = 0; index < 50; index++) {
      observation.push(timed(() => store.putRun({ ...store.run(run.id)!, lastObservedAt: new Date(Date.parse(STAMP) + index * 1_000).toISOString() })));
      assert.equal(store.boardRevision(), frozenBoard, 'an observation-only run write spends no board revision');
    }

    // --- the planning list: the SQL projection the board polls every four seconds.
    const lead = store.addLead({ id: 'lead', title: 'Lead', body: 'Body', repositories: [{ origin: 'audit/repository', path: '/audit' }],
      lanes: ['lane-0'], author: 'owner', state: 'open', version: 1, dropReason: null, targets: [], source: null,
      createdAt: STAMP, updatedAt: STAMP, closedAt: null }, 'owner');
    for (let index = 0; index < 2; index++)
      store.addLead({ id: `promoted-${index}`, title: `Promoted ${index}`, body: 'Body', repositories: [{ origin: 'audit/repository', path: '/audit' }],
        lanes: [`lane-${index % LANES}`], author: 'owner', state: 'promoted', version: 1, dropReason: null,
        targets: [{ kind: 'task', repository: 'audit/repository', reference: `task-${index}`, at: STAMP }],
        source: null, createdAt: STAMP, updatedAt: STAMP, closedAt: STAMP }, 'owner');
    for (let index = 0; index < 2; index++)
      store.addDecision({ id: `decision-${index}`, version: 1, question: 'Which lane?', askedBy: { agentId: 'agent-1', project: null },
        links: { tasks: [], leads: [index % 2 ? lead.id : `promoted-${index}`], papercuts: [] }, status: 'open',
        createdAt: STAMP, updatedAt: STAMP });
    const planning: number[] = [];
    for (let run = 0; run < 15; run++) planning.push(timed(() => store.listBoardLeads()));

    // --- the selected task: detail cold/warm, then task.next with and without the shared evidence.
    const detail = createTaskDetailCache(store);
    const heavy = store.task(tasks[0].id);
    const coldDetail = timed(() => detail(heavy.id));
    const warmDetail: number[] = [];
    for (let run = 0; run < 10; run++) warmDetail.push(timed(() => detail(heavy.id)));
    const parentNext: number[] = [], sharedNext: number[] = [];
    for (let run = 0; run < 5; run++) {
      const fresh = store.task(heavy.id);
      parentNext.push(timed(() => ownerTaskNext(collectOwnerVerbFacts(store, fresh))));
      sharedNext.push(timed(() => {
        const evidence = detail.evidence(fresh.id);
        return ownerTaskNext({ store, task: fresh, runs: evidence.runs, events: evidence.events, notices: evidence.notices, hookRecords: evidence.hookRecords });
      }));
    }
    // Sharing evidence never changes the answer, and never reuses another version's task.
    const parentVerbs = ownerTaskNext(collectOwnerVerbFacts(store, store.task(heavy.id)));
    const sharedEvidence = detail.evidence(heavy.id);
    const sharedVerbs = ownerTaskNext({ store, task: store.task(heavy.id), runs: sharedEvidence.runs,
      events: sharedEvidence.events, notices: sharedEvidence.notices, hookRecords: sharedEvidence.hookRecords });
    assert.deepEqual(sharedVerbs, parentVerbs, 'the shared evidence answers the same verbs for the same version');

    const report = {
      audit: 'performance-audit 2026-10-25 A1/A8 board portion; baseline main d5e20937',
      environment: { node: process.version, cpu: cpus()[0]?.model ?? 'unknown', cpus: cpus().length,
        totalMemGiB: Number((totalmem() / 1024 ** 3).toFixed(1)), loadavg: loadavg().map(value => Number(value.toFixed(2))) },
      population: { lanes: LANES, outcomes: OUTCOMES, tasks: TASKS, liveTasks: LIVE, notices: NOTICES, events: EVENTS,
        heavyTaskEvents: HEAVY_EVENTS, leads: 3, decisions: 2 },
      ms: {
        laneViewsIndexedMedian: Number(indexedMedian.toFixed(2)),
        laneViewsParentRescanMedian: Number(parentMedian.toFixed(2)),
        laneViewsIndexedMin: Number(Math.min(...indexed).toFixed(2)),
        laneViewsIndexedMax: Number(Math.max(...indexed).toFixed(2)),
        laneViewsParentRescanMin: Number(Math.min(...parentRescan).toFixed(2)),
        laneViewsParentRescanMax: Number(Math.max(...parentRescan).toFixed(2)),
        coldOutcomeIndexBuild: Number(coldIndex.toFixed(2)),
        coldOutcomeReloadMedian: Number(median(coldOutcomeReload).toFixed(2)),
        forcedBoardRebuildMedian: Number(median(rebuild).toFixed(2)),
        forcedBoardRebuildMin: Number(Math.min(...rebuild).toFixed(2)),
        forcedBoardRebuildMax: Number(Math.max(...rebuild).toFixed(2)),
        laneViewsAfterEventWriteMedian: Number(median(rebuildLaneViews).toFixed(2)),
        observationOnlyRunWriteMedian: Number(median(observation).toFixed(3)),
        leadBoardCold: Number(Math.max(...planning).toFixed(2)),
        leadBoardWarmMedian: Number(median(planning).toFixed(2)),
        detailCold: Number(coldDetail.toFixed(2)),
        detailWarmMedian: Number(median(warmDetail).toFixed(2)),
        taskNextParentMedian: Number(median(parentNext).toFixed(2)),
        taskNextSharedMedian: Number(median(sharedNext).toFixed(2)),
      },
    };
    t.diagnostic(JSON.stringify(report));
  } finally { store.close(); }
});

timingTest('indexed lane views beat the per-lane rescan', () => {
  const { store } = auditShapedStore(6_792);
  try {
    const lanes = store.lanes(), liveTasks = store.uiTasks(), outcomes = store.outcomes();
    const index = indexOutcomesByLane(outcomes), eventTimes = new Map<string, string>(), records = store.laneRecordActivity();
    const parent: number[] = [], indexed: number[] = [];
    for (let run = 0; run < 15; run++) {
      parent.push(timed(() => parentLaneViews(lanes, liveTasks, outcomes)));
      indexed.push(timed(() => buildLaneViews(lanes, liveTasks, index, eventTimes, records)));
    }
    const parentMedian = median(parent), indexedMedian = median(indexed);
    performanceAssert(indexedMedian < parentMedian, `the indexed read (${indexedMedian.toFixed(2)} ms) beats the per-lane rescan (${parentMedian.toFixed(2)} ms)`);
  } finally { store.close(); }
});
