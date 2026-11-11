import { test } from 'node:test';
import { timingTest, performanceAssert } from './support/timing';
import assert from 'node:assert/strict';
import { cpus, loadavg, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Store } from '../core/store/store';
import { planningPlanSnapshotSchema, projectPlanSchema, type Project, type ProjectPlan } from '../shared/contracts';

/**
 * Audit A2 plans benchmark (2026-10-25 performance audit, main at d5e20937).
 *
 * The audit measured `plans` at 279 ms with 1,248 saved plan versions, 240 lanes and
 * about 37 projects: every project re-read every lane row for its open list and again
 * per saved entry in the Done band (228 `lanes()` calls in one call), and every saved
 * version of a project's plan was parsed in full to find one entry per lane. This
 * fixture uses a smaller population in an isolated store and measures the parent
 * shape against this task's read, in one process on one machine: the parent is
 * implemented here beside the read under test, so the comparison never depends on
 * another commit or another machine's load.
 *
 * Every number printed with `t.diagnostic` is a median of the stated population and
 * cache state on this machine; none is a guarantee for a loaded host or the live
 * database.
 */

const PROJECTS = 2;
const LANES = 240;
const VERSIONS = 6;
const HEAD = 'a'.repeat(40);

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const timed = (fn: () => unknown) => { const start = performance.now(); fn(); return performance.now() - start; };

/**
 * The parent shape exactly as it read before this task: whole-project scan, whole-lane
 * scan per project, a full-plan parse per retained version, and a whole-lane scan per
 * saved entry that is now closed. The counters are the audit's cost claim, read from
 * this code rather than assumed.
 */
function parentPlans(store: Store, counts = { projects: 0, lanes: 0, planParses: 0, laneLookups: 0 }): ProjectPlan[] {
  const projects = store.projects();
  counts.projects += projects.length;
  return projects.map(project => {
    const readLanes = () => { counts.lanes += 1; return store.lanes(); };
    const saved = (() => {
      const row = store.db.prepare('SELECT data FROM project_plans WHERE project=? ORDER BY version DESC LIMIT 1').get(project.key);
      return row ? projectPlanSchema.parse(JSON.parse(String(row.data))) : null;
    })();
    const open = readLanes().filter(lane => (lane.status === 'active' || lane.status === 'paused')
      && project.repositories.some(repo => lane.repositories.some(candidate => (repo.origin ? candidate.origin === repo.origin : candidate.path === repo.path && Boolean(repo.path)))));
    const openKeys = new Set(open.map(lane => lane.key));
    const kept = (saved?.entries ?? []).filter(entry => openKeys.has(entry.lane));
    const named = new Set(kept.map(entry => entry.lane));
    const joined = open.filter(lane => !named.has(lane.key)).map(lane => ({ lane: lane.key, note: '', horizon: 'now' as const }));
    const found = new Map<string, ProjectPlan['entries'][number]>();
    for (const row of store.db.prepare('SELECT data FROM project_plans WHERE project=? ORDER BY version DESC').all(project.key)) {
      counts.planParses += 1;
      for (const entry of projectPlanSchema.parse(JSON.parse(String(row.data))).entries) if (!found.has(entry.lane)) found.set(entry.lane, entry);
    }
    const done: NonNullable<ProjectPlan['done']> = [];
    for (const [key, entry] of found) {
      counts.laneLookups += 1;
      const lane = readLanes().find(item => item.key === key);
      if (lane && (lane.status === 'done' || lane.status === 'abandoned')) done.push({ ...entry, status: lane.status, closedAt: lane.closedAt });
    }
    done.sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
    return planningPlanSnapshotSchema.parse({ project: project.key, version: saved?.version ?? 0, entries: [...kept, ...joined], savedEntries: saved?.entries ?? [], ...(done.length ? { done } : {}),
      author: saved?.author ?? null, createdAt: saved?.createdAt ?? null, ...(saved?.idle ? { idle: saved.idle } : {}) });
  });
}

/**
 * A smaller population over 240 shared lanes and six saved plan versions, with lanes that closed after later versions named them so
 * the Done band has real history to read.
 */
function auditShapedStore() {
  const store = new Store(':memory:');
  store.transaction(() => {
    for (let index = 0; index < PROJECTS; index++)
      store.upsertProject({ key: `project-${index}`, name: `Project ${index}`, repositories: [{ origin: `audit/project-${index}`, path: `/audit/project-${index}` }] });
  });
  const projects = store.projects();
  // Each lane lists three projects, as cross-project lanes do in the live board.
  store.transaction(() => {
    for (let index = 0; index < LANES; index++) {
      const members = [(index % PROJECTS), (index + 7) % PROJECTS, (index + 13) % PROJECTS].filter((value, at, all) => all.indexOf(value) === at);
      store.upsertLane({ key: `lane-${index}`, title: `Lane ${index}`, aim: `Lane ${index} ships its aim.`,
        repositories: members.map(project => ({ origin: projects[project].primary.origin ?? `audit/project-${project}`, path: projects[project].primary.path })) });
    }
  });
  const lanesFor = (project: Project) => store.lanes()
    .filter(lane => lane.repositories.some(repo => project.repositories.some(member => member.origin === repo.origin)));
  // Each project keeps three plan versions.
  for (const [index, project] of projects.entries()) {
    const versions = 3;
    const candidates = lanesFor(project);
    let version = 0;
    for (let saved = 0; saved < versions; saved++) {
      const entries = candidates.slice(0, Math.min(10, candidates.length))
        .filter((_, position) => (position + saved) % 5 !== 0)
        .map((lane, position) => ({ lane: lane.key, note: `Version ${saved} note ${position}`, horizon: (['now', 'next', 'later'] as const)[(position + saved) % 3],
          ...(position === 0 ? { doneWhen: `Step ${saved} lands` } : {}) }));
      version = store.setPlan({ project: project.key, version, entries, author: 'operator (bench)' }).version;
    }
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS versions FROM project_plans').get()!.versions, VERSIONS);
  // Close every third lane and abandon every eleventh: the Done band now reads history.
  for (let index = 0; index < LANES; index++) {
    if (index % 3 === 0) store.setLaneStatus(`lane-${index}`, 'done');
    else if (index % 11 === 0) store.setLaneStatus(`lane-${index}`, 'abandoned');
  }
  return { store, projects };
}

test('audit-shaped plans: one project and lane read, a cached Done band, and the parent shape falsified', t => {
  const { store } = auditShapedStore();
  try {
    const planned = store.db.prepare('SELECT COUNT(*) AS versions FROM project_plans').get()!.versions;
    assert.equal(planned, VERSIONS);
    assert.equal(store.lanes().length, LANES);
    assert.equal(store.projects().length, PROJECTS);
    const closed = store.lanes().filter(lane => lane.status === 'done' || lane.status === 'abandoned').length;
    assert.ok(closed > 80, `the Done band has closed lanes to read (${closed})`);

    // --- the parent cost claim, read from the parent shape itself.
    const counts = { projects: 0, lanes: 0, planParses: 0, laneLookups: 0 };
    const parent = parentPlans(store, counts);
    assert.deepEqual(parent, store.plans(), 'the parent shape and the read under test answer the same plans');
    assert.ok(counts.lanes > PROJECTS, `the parent reads every lane row once per project (${counts.lanes} reads over ${PROJECTS} projects)`);
    assert.equal(counts.planParses, VERSIONS, 'the parent parses every retained plan version in full');
    assert.equal(counts.lanes, PROJECTS + counts.laneLookups, 'and scans them again for every saved entry, not only the closed ones');
    assert.ok(counts.laneLookups > PROJECTS * 5, `multiple lane lookups per project (${counts.laneLookups})`);

    // --- timing: the parent shape against a cold (invalidated) and a warm read.
    for (let warm = 0; warm < 2; warm++) { parentPlans(store); store.plans(); }
    const parentTimes: number[] = [];
    for (let run = 0; run < 5; run++) parentTimes.push(timed(() => parentPlans(store)));
    const warm: number[] = [];
    for (let run = 0; run < 15; run++) warm.push(timed(() => store.plans()));
    // Cold: every retained plan row is written again, so both caches rebuild from scratch.
    const cold: number[] = [], coldLaneInvalidated: number[] = [], coldRepairedRow: number[] = [];
    for (let run = 0; run < 5; run++) {
      store.db.exec('UPDATE project_plans SET data=data');
      cold.push(timed(() => store.plans()));
      // A lane write moves the lane revision only: the Done band's lane side is re-read.
      store.upsertLane({ key: 'lane-1', title: `Lane 1 revision ${run}`, aim: 'Lane 1 ships its aim.', repositories: store.lanes()[1].repositories });
      coldLaneInvalidated.push(timed(() => store.plans()));
      // A repair that bypasses the store still moves the plan write clock.
      store.db.prepare("UPDATE project_plans SET data=json_set(data,'$.entries[0].note',?) WHERE project=? AND version=1")
        .run(`Repaired ${run}`, 'project-0');
      coldRepairedRow.push(timed(() => store.plans()));
      assert.equal(store.plan({ project: 'project-0' }).version, 3, 'a repair to a retained version moves no version number');
    }
    // A save, the ordinary mutation, invalidates the Done band exactly once.
    const afterSave: number[] = [];
    const plan = store.plan({ project: 'project-0' });
    let version = plan.version;
    for (let run = 0; run < 5; run++) {
      version = store.setPlan({ project: 'project-0', version, entries: plan.entries.map(entry => ({ lane: entry.lane, note: `Save ${run}`, horizon: entry.horizon })), author: 'operator (bench)' }).version;
      afterSave.push(timed(() => store.plans()));
    }

    // A closed lane's plan reads it back as done, an abandoned one does too, and a reopen
    // returns it to the plan: the read is never served from a stale lane fact.
    const doneLane = store.lanes().find(lane => lane.status === 'done' && lane.repositories.some(repo => repo.origin === 'audit/project-1'))!;
    store.setLaneStatus(doneLane.key, 'active');
    const reopened = store.plan({ project: 'project-1' });
    assert.ok(reopened.entries.some(entry => entry.lane === doneLane.key), 'a reopened lane returns to the plan order');
    assert.ok(!(reopened.done ?? []).some(entry => entry.lane === doneLane.key), 'and leaves the Done band');
    store.setLaneStatus(doneLane.key, 'done');
    assert.ok((store.plan({ project: 'project-1' }).done ?? []).some(entry => entry.lane === doneLane.key), 'closing it again puts it back');

    // Historical reads are still exactly as saved, whatever the caches hold.
    const saved = store.plan({ project: 'project-0', version: 2 });
    const storedRow = store.db.prepare('SELECT data FROM project_plans WHERE project=? AND version=2').get('project-0')!;
    assert.deepEqual(saved, projectPlanSchema.parse(JSON.parse(String(storedRow.data))));

    const report = {
      audit: 'performance-audit 2026-10-25 A2 plans read; baseline main d5e20937',
      environment: { node: process.version, cpu: cpus()[0]?.model ?? 'unknown', cpus: cpus().length,
        totalMemGiB: Number((totalmem() / 1024 ** 3).toFixed(1)), loadavg: loadavg().map(value => Number(value.toFixed(2))) },
      population: { projects: PROJECTS, lanes: LANES, planVersions: VERSIONS, closedLanes: closed },
      parentCostCounts: counts,
      ms: {
        parentMedian: Number(median(parentTimes).toFixed(2)),
        parentMin: Number(Math.min(...parentTimes).toFixed(2)),
        plansWarmMedian: Number(median(warm).toFixed(2)),
        plansWarmMin: Number(Math.min(...warm).toFixed(2)),
        plansWarmMax: Number(Math.max(...warm).toFixed(2)),
        plansColdAllRows: Number(median(cold).toFixed(2)),
        plansAfterLaneWrite: Number(median(coldLaneInvalidated).toFixed(2)),
        plansAfterRepairedRow: Number(median(coldRepairedRow).toFixed(2)),
        plansAfterSaveMedian: Number(median(afterSave).toFixed(2)),
      },
    };
    // Relative only: the host is shared and loaded, so the absolute medians live in the receipt.
    t.diagnostic(JSON.stringify(report));
  } finally { store.close(); }
});

timingTest('cached plans beat the parent by an order of magnitude', () => {
  const { store } = auditShapedStore();
  try {
    for (let warm = 0; warm < 2; warm++) { parentPlans(store); store.plans(); }
    const parentTimes: number[] = [], warm: number[] = [];
    for (let run = 0; run < 5; run++) parentTimes.push(timed(() => parentPlans(store)));
    for (let run = 0; run < 15; run++) warm.push(timed(() => store.plans()));
    performanceAssert(median(warm) < median(parentTimes) / 10, `the cached read (${median(warm).toFixed(2)} ms) beats the parent (${median(parentTimes).toFixed(2)} ms) by an order of magnitude`);
  } finally { store.close(); }
});
