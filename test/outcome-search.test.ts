import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { command } from '../core/git/index';
import { submissionSchema, outcomeSchema, outcomeSearchInputSchema, type Outcome } from '../shared/contracts';
import { timingTest, performanceAssert } from './support/timing';
import { cpuSample } from './support/cpu-time';

/**
 * Spec 025 outcome search. One named test per acceptance row: filters (1),
 * stemmed text search with excerpts (2), commit prefixes (3), pr with
 * repository (4), stable paging (5), same-transaction searchability (6),
 * superseded replacement (7 after 8), the Spec 012 read
 * budget on a live-size copied store (9, a timing test), and no bulk brief
 * text (10).
 */

const BASE = 'a'.repeat(40);

interface Fixture {
  dir: string; store: Store; alphaPath: string; localPath: string;
  close(): void;
}

function openFixture(): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nsq-outcome-search-')));
  const store = new Store(join(dir, 'queue.sqlite'));
  const alphaPath = join(dir, 'alpha');
  const localPath = join(dir, 'local');
  mkdirSync(alphaPath, { recursive: true });
  mkdirSync(localPath, { recursive: true });
  // repositoryIdentity resolves a submitted path to its realpath when the
  // checkout has no origin; the alpha tasks carry an explicit origin instead.
  return {
    dir, store, alphaPath, localPath,
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

interface TaskOptions {
  title: string; brief?: string; reason?: string;
  origin?: string; repoPath?: string; lanes?: string[];
  finishedAt?: string; mergeCommit?: string | null; syncedCommit?: string | null;
  prHead?: string | null; prNumber?: number | null; prUrl?: string;
  reviewSummary?: string; outcome?: 'done' | 'cancelled' | 'superseded';
  replacementTaskId?: string | null; backfilled?: boolean;
}

/** One terminal task through the real update path, so the row and its search projection are written as production writes them. */
function terminalTask(f: Fixture, options: TaskOptions): string {
  const repoPath = options.repoPath ?? f.alphaPath;
  const submission = submissionSchema.parse({
    submissionId: randomUUID(), title: options.title, repoPath, planningCommit: BASE,
    originAgentId: 'origin', ...(options.lanes ? { lanes: options.lanes } : {}),
  });
  const origin = options.origin ?? null;
  const task = f.store.insert(submission, 'host', options.brief ?? `Handoff for ${options.title}.`, BASE, {}, undefined, origin);
  const superseded = options.outcome === 'superseded';
  const cancelled = options.outcome === 'cancelled' || superseded;
  f.store.update(task.id, {
    phase: cancelled ? 'cancelled' : 'done',
    ...(options.reason ? { reason: options.reason } : {}),
    ...(superseded ? {
      disposition: {
        kind: 'supersede' as const, status: 'complete' as const, requestedAt: new Date().toISOString(),
        requestedBy: 'test', reason: options.reason ?? 'superseded', replacementTaskId: options.replacementTaskId ?? null,
        replacementBranch: null, replacementWorkspaceId: null, workDisposition: 'preserve' as const,
        workspaceId: null, workspaceArchived: false, workspaceEvidence: '', hookEmitted: false,
        effects: [], completedAt: null, attention: '', refSnapshot: null, postDispositionRefs: [], proofPolicies: [],
      },
    } : {}),
    ...(options.prNumber ? { prUrl: options.prUrl ?? `https://github.com/${options.origin ?? 'example/alpha'}/pull/${options.prNumber}`, resumePrNumber: options.prNumber, ...(options.prHead ? { prHead: options.prHead } : {}) } : {}),
    resolution: {
      ...task.resolution,
      ...(options.mergeCommit ? { mergedCommit: options.mergeCommit, syncedCommit: options.syncedCommit ?? options.mergeCommit } : {}),
      ...(options.reviewSummary ? { review: { eventId: 'review', taskId: task.id, runId: 'review-run', status: 'ready_to_merge', summary: options.reviewSummary, head: options.prHead ?? options.mergeCommit ?? BASE } } : {}),
    },
  });
  if (options.finishedAt) setFinishedAt(f, task.id, options.finishedAt);
  return task.id;
}

/** Rewrites the durable finish time in the row and its indexed column together, to control the fixture clock. */
function setFinishedAt(f: Fixture, taskId: string, finishedAt: string) {
  f.store.db.prepare("UPDATE outcomes SET finished_at=?, data=json_set(data,'$.finishedAt',?) WHERE taskId=?").run(finishedAt, finishedAt, taskId);
}

test('1. outcome search filters by repository, lane, outcome and date range, newest first', () => {
  const f = openFixture();
  try {
    f.store.upsertLane({ key: 'lean-northstar', title: 'Lean Northstar', aim: 'Move task state into Queue', repositories: [{ origin: 'example/alpha', path: f.alphaPath }] });
    const laneOld = terminalTask(f, { title: 'Lane task', lanes: ['lean-northstar'], origin: 'example/alpha', finishedAt: '2026-09-01T10:00:00.000Z' });
    const alpha = terminalTask(f, { title: 'Alpha task', origin: 'example/alpha', finishedAt: '2026-09-05T10:00:00.000Z' });
    const local = terminalTask(f, { title: 'Local task', repoPath: f.localPath, finishedAt: '2026-09-10T10:00:00.000Z' });
    const cancelled = terminalTask(f, { title: 'Cancelled task', origin: 'example/alpha', outcome: 'cancelled', reason: 'Duplicate of another task', finishedAt: '2026-09-15T10:00:00.000Z' });

    // Default outcome is done; rows come back newest finishedAt first.
    const all = f.store.searchOutcomes({});
    assert.deepEqual(all.results.map(row => row.taskId), [local, alpha, laneOld]);
    assert.equal(all.hasMore, false);
    assert.equal(all.cursor, null);
    assert.ok(all.results.every(row => row.outcome === 'done'), 'done is the default outcome filter');
    assert.ok(all.results.every(row => row.excerpt === null), 'no text search, no excerpt');

    // Repository matches the origin identity and a resolving local path.
    const byOrigin = f.store.searchOutcomes({ repository: 'example/alpha' });
    assert.deepEqual(byOrigin.results.map(row => row.taskId).sort(), [alpha, laneOld].sort());
    const byPath = f.store.searchOutcomes({ repository: f.localPath });
    assert.deepEqual(byPath.results.map(row => row.taskId), [local]);

    // Lane and outcome filters.
    assert.deepEqual(f.store.searchOutcomes({ lane: 'lean-northstar' }).results.map(row => row.taskId), [laneOld]);
    assert.deepEqual(f.store.searchOutcomes({ outcome: 'cancelled' }).results.map(row => row.taskId), [cancelled]);
    assert.equal(f.store.searchOutcomes({ outcome: 'superseded' }).results.length, 0);

    // Date bounds are inclusive on finishedAt.
    const window = f.store.searchOutcomes({ since: '2026-09-02T00:00:00.000Z', until: '2026-09-10T10:00:00.000Z' });
    assert.deepEqual(window.results.map(row => row.taskId), [local, alpha]);
    assert.deepEqual(f.store.searchOutcomes({ since: '2026-09-06T00:00:00.000Z' }).results.map(row => row.taskId), [local]);
    // Filters combine with AND.
    assert.deepEqual(f.store.searchOutcomes({ repository: 'example/alpha', lane: 'lean-northstar', since: '2026-08-01T00:00:00.000Z' }).results.map(row => row.taskId), [laneOld]);
    assert.equal(f.store.searchOutcomes({ repository: 'example/alpha', lane: 'lean-northstar' }).results.length, 1);
  } finally { f.close(); }
});

test('1b. a checkout path resolves through its origin remote to the recorded repository', async () => {
  const f = openFixture();
  try {
    const checkout = join(f.dir, 'clone');
    mkdirSync(checkout, { recursive: true });
    await command('git', ['init', '-q'], checkout);
    await command('git', ['-C', checkout, 'remote', 'add', 'origin', 'https://github.com/example/alpha.git'], checkout);
    // No origin hint: insert resolves the identity from the checkout's remote,
    // exactly as dispatch records it.
    const submission = submissionSchema.parse({
      submissionId: randomUUID(), title: 'Checkout task', repoPath: checkout, planningCommit: BASE, originAgentId: 'origin',
    });
    const task = f.store.insert(submission, 'host', 'Handoff for the checkout task.', BASE);
    f.store.update(task.id, { phase: 'done' });

    assert.equal(f.store.outcome(task.id)!.repository.origin, 'example/alpha');
    assert.deepEqual(f.store.searchOutcomes({ repository: checkout }).results.map(row => row.taskId), [task.id], 'the checkout path resolves to the recorded origin');
    assert.deepEqual(f.store.searchOutcomes({ repository: 'example/alpha' }).results.map(row => row.taskId), [task.id]);
    // The raw path also stays a candidate so rows recorded without an origin match.
    const plain = terminalTask(f, { title: 'Plain path task', repoPath: f.localPath });
    assert.deepEqual(f.store.searchOutcomes({ repository: f.localPath }).results.map(row => row.taskId), [plain]);
  } finally { f.close(); }
});

test('2. text search finds stemmed matches and names the matched field', () => {
  const f = openFixture();
  try {
    const titleTask = terminalTask(f, { title: 'Reconcile the durable hook outbox', brief: 'Unrelated brief body.', origin: 'example/alpha' });
    const briefTask = terminalTask(f, { title: 'Separate title words', brief: 'The papercut triage workflow needs a bounded intake.', origin: 'example/alpha' });
    const reviewTask = terminalTask(f, { title: 'Third task title', brief: 'Different brief text entirely.', reviewSummary: 'Independent review verified the merge candidate cleanly.', origin: 'example/alpha' });
    const reasonTask = terminalTask(f, { title: 'Fourth task title', brief: 'Another unrelated brief.', outcome: 'cancelled', reason: 'Superseded by the follow-up restructuring plan', origin: 'example/alpha' });

    // Porter stemming: the query form differs from the indexed form.
    const byTitle = f.store.searchOutcomes({ text: 'reconciling' });
    assert.deepEqual(byTitle.results.map(row => row.taskId), [titleTask]);
    assert.equal(byTitle.results[0].excerpt?.field, 'title');
    assert.match(byTitle.results[0].excerpt!.text, /\[/);

    const byBrief = f.store.searchOutcomes({ text: 'triaging' });
    assert.deepEqual(byBrief.results.map(row => row.taskId), [briefTask]);
    assert.equal(byBrief.results[0].excerpt?.field, 'brief');
    assert.match(byBrief.results[0].excerpt!.text, /papercut \[triage\]/);

    const byReview = f.store.searchOutcomes({ text: 'verifies' });
    assert.deepEqual(byReview.results.map(row => row.taskId), [reviewTask]);
    assert.equal(byReview.results[0].excerpt?.field, 'review');

    const byReason = f.store.searchOutcomes({ text: 'restructured', outcome: 'cancelled' });
    assert.deepEqual(byReason.results.map(row => row.taskId), [reasonTask]);
    assert.equal(byReason.results[0].excerpt?.field, 'reason');

    // Space-separated terms AND-combine within one row.
    assert.equal(f.store.searchOutcomes({ text: 'reconciling intake' }).results.length, 0);
    assert.deepEqual(f.store.searchOutcomes({ text: 'reconciling durable' }).results.map(row => row.taskId), [titleTask]);
    // Text combines with structured filters.
    assert.deepEqual(f.store.searchOutcomes({ repository: 'example/alpha', text: 'triage' }).results.map(row => row.taskId), [briefTask]);
    assert.equal(f.store.searchOutcomes({ repository: 'example/other', text: 'triage' }).results.length, 0);
  } finally { f.close(); }
});

test('3. a commit prefix matches merge commit, synced commit or PR head; shorter prefixes are refused', () => {
  const f = openFixture();
  try {
    const merged = '1'.repeat(40);
    const head = '2'.repeat(40);
    const mergedTask = terminalTask(f, { title: 'Merged task', mergeCommit: merged, syncedCommit: merged, origin: 'example/alpha' });
    const headTask = terminalTask(f, { title: 'PR head task', prNumber: 9, prHead: head, origin: 'example/alpha' });

    assert.deepEqual(f.store.searchOutcomes({ commit: merged.slice(0, 7) }).results.map(row => row.taskId), [mergedTask]);
    assert.deepEqual(f.store.searchOutcomes({ commit: head.slice(0, 8) }).results.map(row => row.taskId), [headTask]);
    assert.deepEqual(f.store.searchOutcomes({ commit: head.slice(0, 7).toUpperCase() }).results.map(row => row.taskId), [headTask], 'hex prefixes match case-insensitively');
    assert.deepEqual(f.store.searchOutcomes({ repository: 'example/alpha', commit: head.slice(0, 10) }).results.map(row => row.taskId), [headTask]);

    for (const bad of [head.slice(0, 6), head + '0', 'nothex!']) {
      const parsed = outcomeSearchInputSchema.safeParse({ commit: bad });
      assert.equal(parsed.success, false, `commit ${bad} must be refused`);
    }
  } finally { f.close(); }
});

test('4. pr search needs its repository and finds its task with it', () => {
  const f = openFixture();
  try {
    const prTask = terminalTask(f, { title: 'PR task', prNumber: 7, prHead: '3'.repeat(40), origin: 'example/alpha' });
    terminalTask(f, { title: 'Other PR task', prNumber: 7, prHead: '4'.repeat(40), repoPath: f.localPath, prUrl: 'https://git.example.invalid/local/repo/pull/7' });

    const found = f.store.searchOutcomes({ repository: 'example/alpha', pr: 7 });
    assert.deepEqual(found.results.map(row => row.taskId), [prTask]);
    assert.equal(found.results[0].prNumber, 7);
    assert.equal(found.results[0].prUrl, 'https://github.com/example/alpha/pull/7');
    assert.deepEqual(f.store.searchOutcomes({ repository: f.localPath, pr: 7 }).results.map(row => row.taskId).length, 1);

    assert.equal(outcomeSearchInputSchema.safeParse({ pr: 7 }).success, false, 'pr without repository is refused');
  } finally { f.close(); }
});

test('5. paging with equal finishedAt values returns every row exactly once in stable order', () => {
  const f = openFixture();
  try {
    const total = 250;
    const ids: string[] = [];
    for (let index = 0; index < total; index++) {
      const record = outcomeSchema.parse({
        taskId: `task-${String(index).padStart(4, '0')}`, submissionId: randomUUID(),
        title: `Backlog task ${index}`, repository: { origin: `example/repo-${index % 5}`, path: `/tmp/repo-${index}` },
        outcome: 'done', replacementTaskId: null, reason: 'Merged',
        pr: null, mergeCommit: null, syncedCommit: null, review: null, validation: null, closeout: null,
        brief: { digest: `sha256:${'b'.repeat(64)}`, mediaType: 'text/markdown', text: `Brief ${index} with filler terms`, source: 'handoff', version: null, earlierDigests: [] },
        workers: [], reviewers: [], startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.000Z', backfilled: true, lanes: [],
      });
      f.store.putOutcome(record);
      ids.push(record.taskId);
    }
    // Every row shares one finishedAt, so only the taskId tiebreak orders them.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      const result = f.store.searchOutcomes({ cursor: cursor ?? undefined, limit: 37 });
      const pageIds = result.results.map(row => row.taskId);
      assert.ok(pageIds.length <= 37);
      assert.equal(result.results.every(row => row.excerpt === null), true);
      seen.push(...pageIds);
      if (!result.hasMore) { assert.equal(result.cursor, null); break; }
      assert.ok(result.cursor, `page ${page} must carry a cursor`);
      cursor = result.cursor;
      assert.ok(page < 10, 'paging must terminate');
    }
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total, 'no row repeats across pages');
    assert.deepEqual([...seen].sort(), [...ids].sort(), 'every fixture row is returned exactly once');
    const expectedOrder = [...ids].sort().reverse();
    assert.deepEqual(seen, expectedOrder, 'equal finishedAt rows fall back to a stable taskId order');
    // limit caps at 100.
    assert.equal(outcomeSearchInputSchema.safeParse({ limit: 101 }).success, false);
    assert.throws(() => f.store.searchOutcomes({ cursor: 'not-a-cursor' }), /Invalid outcome search cursor/);
  } finally { f.close(); }
});

test('6. a terminal task is searchable inside the same transaction that writes its outcome row', () => {
  const f = openFixture();
  try {
    const submission = submissionSchema.parse({
      submissionId: randomUUID(), title: 'Transaction visibility task', repoPath: f.alphaPath,
      planningCommit: BASE, originAgentId: 'origin',
    });
    const task = f.store.insert(submission, 'host', 'The quantum tunnel brief for transaction visibility.', BASE);
    assert.equal(f.store.searchOutcomes({ text: 'quantum tunnel' }).results.length, 0);
    f.store.db.exec('BEGIN IMMEDIATE');
    try {
      f.store.update(task.id, { phase: 'done' });
      const inside = f.store.searchOutcomes({ text: 'quantum tunnel' });
      assert.equal(inside.results.length, 1, 'row and search projection commit together');
      assert.equal(inside.results[0].taskId, task.id);
    } finally { f.store.db.exec('COMMIT'); }
    assert.equal(f.store.searchOutcomes({ text: 'quantum tunnel' }).results.length, 1);
  } finally { f.close(); }
});


test('8. a superseded outcome names its replacement task', () => {
  const f = openFixture();
  try {
    const replacement = terminalTask(f, { title: 'Replacement task', origin: 'example/alpha' });
    const superseded = terminalTask(f, {
      title: 'Superseded task', origin: 'example/alpha', outcome: 'superseded',
      reason: 'Replaced by the restructured plan', replacementTaskId: replacement,
    });
    const rows = f.store.searchOutcomes({ outcome: 'superseded' });
    assert.deepEqual(rows.results.map(row => row.taskId), [superseded]);
    assert.equal(rows.results[0].replacementTaskId, replacement);
    assert.equal(f.store.searchOutcomes({}).results.some(row => row.taskId === superseded), false, 'superseded rows stay out of the done default');
  } finally { f.close(); }
});

test('10. results never carry brief text; the full row stays one outcome call away', () => {
  const f = openFixture();
  try {
    const marker = 'SECRETBRIEFMARKER-only-the-excerpt-may-leave';
    terminalTask(f, {
      title: 'Marker task with a searchable outbox in the title', brief: `Long brief body. ${marker} More filler text follows the marker.`,
      origin: 'example/alpha',
    });
    const matched = f.store.searchOutcomes({ text: 'outbox' });
    assert.equal(matched.results.length, 1);
    assert.equal(matched.results[0].excerpt?.field, 'title', 'a title match excerpts the title, never the brief');
    assert.equal(JSON.stringify(matched).includes('SECRETBRIEFMARKER'), false, 'bulk brief text never leaves the store');

    const briefMatch = f.store.searchOutcomes({ text: 'filler' });
    assert.equal(briefMatch.results.length, 1);
    const excerpt = briefMatch.results[0].excerpt;
    assert.ok(excerpt && excerpt.field === 'brief');
    assert.ok(excerpt.text.length < 400, 'the excerpt is short, not the brief');
    assert.equal(briefMatch.results[0].title.includes('SECRETBRIEFMARKER'), false);

    // The full row keeps the brief text, one exact-identity call away.
    const full: Outcome | null = f.store.outcome(matched.results[0].taskId);
    assert.ok(full && full.brief.text.includes('SECRETBRIEFMARKER'));
  } finally { f.close(); }
});

timingTest('outcome search meets the Spec 012 read budget on a live-size copied store', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nsq-outcome-timing-')));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    // Live-size: about 2,400 permanent rows across 40 repositories, ~11 MB of
    // JSON today. Rows are written through the production projection path.
    const total = 2400;
    const words = ['hook', 'lane', 'brief', 'review', 'merge', 'outbox', 'workflow', 'checkpoint'];
    const hash = (index: number) => (index % 16).toString(16).repeat(40);
    for (let index = 0; index < total; index++) {
      const repository = `example/repo-${index % 40}`;
      const word = words[index % words.length];
      const brief = Array.from({ length: 64 }, (_, line) => `Paragraph ${line} explains the ${word} contract for ${repository} with enough prose to resemble a real brief.`).join(' ');
      store.putOutcome(outcomeSchema.parse({
        taskId: `timing-task-${index}`, submissionId: randomUUID(),
        title: `Timing task ${index}: ${word} handling`, repository: { origin: repository, path: `/tmp/repo-${index}` },
        outcome: index % 10 === 9 ? 'cancelled' : 'done', replacementTaskId: null,
        reason: `Landed after review; ${word} budget held`,
        pr: index % 3 === 0 ? { url: `https://github.com/${repository}/pull/${index + 1}`, number: index + 1, head: hash(index) } : null,
        mergeCommit: index % 2 ? hash(index) : null, syncedCommit: index % 2 ? hash(index) : null,
        review: { status: 'ready_to_merge', summary: `Independent review accepted the ${word} head`, commentId: null },
        validation: null, closeout: { authority: 'queue', commit: null },
        brief: { digest: `sha256:${'c'.repeat(64)}`, mediaType: 'text/markdown', text: brief, source: 'queue', version: 1, earlierDigests: [] },
        workers: [], reviewers: [], startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(index / 40), 12)).toISOString(),
        backfilled: index % 97 === 0, lanes: index % 2 ? ['lean-northstar'] : [],
      }));
    }
    assert.equal(store.searchOutcomes({ limit: 100 }).results.length, 100);
    const sample = (run: () => void): number => cpuSample(run).ms;
    const measurements: number[] = [];
    for (let index = 0; index < 40; index++) {
      measurements.push(sample(() => store.searchOutcomes({ repository: `example/repo-${index % 40}` })));
      measurements.push(sample(() => store.searchOutcomes({ text: words[index % words.length] })));
      measurements.push(sample(() => store.searchOutcomes({ repository: `example/repo-${index % 40}`, text: words[(index + 3) % words.length], lane: index % 2 ? 'lean-northstar' : undefined })));
      measurements.push(sample(() => store.searchOutcomes({ commit: hash(index).slice(0, 7) })));
    }
    const sorted = [...measurements].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    performanceAssert(p95 <= 100, `outcome search p95 ${p95.toFixed(1)} ms exceeds the Spec 012 read budget of 100 ms`);
    // Correctness spot checks on the timing fixture.
    assert.equal(store.searchOutcomes({ text: 'hooks' }).results.length > 0, true);
    assert.ok(store.searchOutcomes({ repository: 'example/repo-3' }).results.every(row => row.repository === 'example/repo-3'));
  } finally { store.close(); rm(dir, { recursive: true, force: true }); }
});
