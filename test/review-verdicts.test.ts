import { fakeAdapter, profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CURRENT_SCHEMA, Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { Reports, reportSchema } from '../core/intake/report';
import { startCallbacks } from '../service/callbacks/callback';
import {
  MAX_REVIEW_VERDICT_BYTES, REVISION_BUDGET, completionSchema, reviewRecordSchema, reviewVerdictListSchema, runSchema, submissionSchema,
  type Completion, type ReviewVerdict, type Run, type Task,
} from '../shared/contracts';
import { assertReviewResponsibility, latestReviewVerdicts, reviewRecordFor } from '../core/review/review-verdicts';
import { reviewPublicationBody, reviewVerdictTable, publishFormalReview } from '../core/forge/index';
import { git } from '../core/git/index';
import { runPrompt } from '../core/dispatch/prompts';
import { parseNorthstarDocument, submissionQueueFields } from '../core/planning/handoff';
import type { Adapter } from '../core/host';
import { isAcceptedReview, type ResolutionAdapter } from '../core/resolution';
import { requiredMergeReview } from '../core/forge/index';
import { observedParticipantTimeline } from './support/tool-timeline';

const base = 'b'.repeat(40), head = 'a'.repeat(40);

const verdict = (over: Partial<ReviewVerdict> = {}): ReviewVerdict => ({ id: 'v1', subject: 'Spec compliance', verdict: 'pass', evidence: 'Read the diff at the exact head', ...over });

// ---------------------------------------------------------------------------
// Schema and validation
// ---------------------------------------------------------------------------

test('a verdict list is bounded, id-unique and value-closed', () => {
  assert.deepEqual(reviewVerdictListSchema.parse([verdict()]), [verdict()]);
  assert.throws(() => reviewVerdictListSchema.parse([verdict(), verdict()]), /unique/);
  assert.throws(() => reviewVerdictListSchema.parse([verdict({ verdict: 'maybe' as never })]), /verdict/);
  assert.throws(() => reviewVerdictListSchema.parse([{ ...verdict(), extra: true } as never]), /Unrecognized/);
  assert.throws(() => reviewVerdictListSchema.parse([{ id: 'v', subject: 's', verdict: 'pass' } as never]), /evidence/);
  // Oversized: more than 500 entries and a total size beyond the bound.
  const many = Array.from({ length: 501 }, (_, index) => verdict({ id: `v${index}` }));
  assert.throws(() => reviewVerdictListSchema.parse(many), /at most 500|Too big/);
  const fat = Array.from({ length: 500 }, (_, index) => verdict({ id: `v${index}`, subject: 's'.repeat(600), evidence: 'e'.repeat(4000), note: 'n'.repeat(4000) }));
  assert.throws(() => reviewVerdictListSchema.parse(fat), /at most 4194304 bytes/);
});

test('verdicts are reviewer-only and no brief frontmatter can require them', () => {
  const reviewer = { role: 'reviewer' } as Run, worker = { role: 'revision' } as Run;
  // A non-reviewer report never carries verdicts; a reviewer report may.
  assert.throws(() => assertReviewResponsibility({ status: 'ready_for_review', verdicts: [verdict()] }, worker), /only accepted for reviewer reports/);
  assert.doesNotThrow(() => assertReviewResponsibility({ status: 'ready_to_merge', verdicts: [verdict()] }, reviewer));
  assert.doesNotThrow(() => assertReviewResponsibility({ status: 'ready_to_merge' }, reviewer), 'an approval without verdicts is the ordinary shape');
});

test('an approval omits reviewResponsibility; unfinished coverage is review_in_progress with reviewer responsibility only', () => {
  const reviewer = { role: 'reviewer', reviewResponsibilityRequired: true } as Run;
  // Approval carries no responsibility, whichever responsibility is named.
  for (const responsibility of ['author', 'reviewer', 'environment'] as const)
    assert.throws(() => assertReviewResponsibility({ status: 'ready_to_merge', reviewResponsibility: responsibility, verdicts: [verdict()] }, reviewer), /ready_to_merge must omit reviewResponsibility/);
  assert.doesNotThrow(() => assertReviewResponsibility({ status: 'ready_to_merge', verdicts: [verdict()] }, reviewer));
  // Unfinished coverage is reviewer-owned only on review_in_progress; never a verdict.
  assert.doesNotThrow(() => assertReviewResponsibility({ status: 'review_in_progress', reviewResponsibility: 'reviewer' }, reviewer));
  assert.throws(() => assertReviewResponsibility({ status: 'changes_required', reviewResponsibility: 'reviewer' }, reviewer), /Unfinished reviewer coverage is not an author defect/);
  // A concrete author defect and an external impediment keep their own statuses.
  assert.doesNotThrow(() => assertReviewResponsibility({ status: 'changes_required', reviewResponsibility: 'author' }, reviewer));
  assert.doesNotThrow(() => assertReviewResponsibility({ status: 'blocked', reviewResponsibility: 'environment' }, reviewer));
});

test('retired verdict, gate and manual-verification frontmatter is refused with the replacement named', () => {
  const document = (queue: string) => `---\ntitle: Brief\nqueue_approval: "operator approved"\nqueue:\n${queue}---\n\nBody.\n`;
  assert.throws(() => parseNorthstarDocument(document('  reviewVerdicts: true\n'), 'brief'), /queue\.reviewVerdicts is no longer available; state the outcome and acceptance in prose.*queue\.mergeHold/);
  assert.throws(() => parseNorthstarDocument(document('  reviewVerdicts: [spec, tests]\n'), 'brief'), /queue\.reviewVerdicts is no longer available/);
  assert.throws(() => parseNorthstarDocument(document('  reviewPassGate: [publication]\n'), 'brief'), /queue\.reviewPassGate is no longer available; state the acceptance conditions in prose.*queue\.mergeHold/);
  assert.throws(() => parseNorthstarDocument(document('  manualVerification: true\n'), 'brief'), /queue\.manualVerification is no longer available/);
  // reviewContinuationIds is retired with the automatic-review-loop concept: it
  // still parses inertly on historical briefs (bounded, unique ids) and no code reads it.
  const continuation = parseNorthstarDocument(document('  reviewContinuationIds: [scope]\n'), 'brief');
  assert.deepEqual(submissionQueueFields(continuation.queue).reviewContinuationIds, ['scope']);
  assert.throws(() => parseNorthstarDocument(document('  reviewContinuationIds: []\n'), 'brief'), /reviewContinuationIds/);
  assert.throws(() => parseNorthstarDocument(document('  reviewContinuationIds: [a, a]\n'), 'brief'), /unique/);
  // A brief with neither field keeps today's shape.
  const plain = parseNorthstarDocument(document('  scope: general\n'), 'brief');
  assert.equal(plain.queue.reviewPassGate, undefined);
  assert.equal(plain.queue.reviewVerdicts, undefined);
  assert.equal(plain.queue.manualVerification, undefined);
});

test('a review record keeps the reviewer agent, run, head and review id, and only a verdict-bearing review appends one', () => {
  const run = { id: 'review-run', agentId: 'review-agent', head } as Run;
  const record = reviewRecordFor(run, { status: 'ready_to_merge', reviewId: 77, verdicts: [verdict()] } as Completion, '2026-10-01T00:00:00.000Z')!;
  assert.deepEqual(reviewRecordSchema.parse(record), record);
  assert.deepEqual(record, { runId: 'review-run', agentId: 'review-agent', head, status: 'ready_to_merge', reviewId: 77, reviewCommentId: null, at: '2026-10-01T00:00:00.000Z', verdicts: [verdict()] });
  assert.equal(reviewRecordFor(run, { status: 'ready_to_merge' } as Completion, 'now'), null, 'a review without verdicts does not change the task record');
  const commentRecord = reviewRecordFor({ ...run, agentId: null } as Run, { status: 'changes_required', reviewCommentId: 5, verdicts: [verdict()] } as Completion, 'now')!;
  assert.equal(commentRecord.reviewCommentId, 5);
  assert.equal(commentRecord.reviewId, null);
});

test('task_reviews survives ordinary updates and the schema 50 upgrade (Tom 2026-10-21)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-review-history-'));
  const path = join(dir, 'queue.sqlite');
  let store = new Store(path);
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
    const review = completionSchema.parse({ eventId: 'review-event', taskId: task.id, runId: 'review-run', status: 'changes_required', summary: 'Fix v1', reviewText: 'Long review text', verdicts: [verdict({ verdict: 'fail' })] });
    const records = ['r1', 'r2'].map((runId, i) => reviewRecordSchema.parse({ runId, head, status: i ? 'ready_to_merge' : 'changes_required', at: `2026-10-0${i + 1}T00:00:00.000Z`, verdicts: [verdict()] }));
    store.update(task.id, { resolution: { ...store.task(task.id).resolution, review, reviews: records } });
    const row = () => JSON.parse(String((store.db.prepare('SELECT data FROM tasks WHERE id=?').get(task.id) as { data: string }).data));
    const stored = () => store.db.prepare('SELECT seq,data FROM task_reviews WHERE taskId=? ORDER BY seq').all(task.id).map(r => ({ ...r }));
    assert.equal(Object.hasOwn(row().resolution, 'review'), false, 'the task row carries no current review');
    assert.equal(Object.hasOwn(row().resolution, 'reviews'), false, 'the task row carries no review records');
    const before = stored();
    assert.deepEqual(before.map(r => r.seq), [0, 1, 2], 'the current review is seq 0; records follow oldest first');
    const changes = () => Number((store.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
    let start = changes();
    store.update(task.id, { reason: 'An ordinary observation' });
    const ordinary = changes() - start;
    assert.deepEqual(stored(), before, 'an ordinary update leaves every stored review untouched');
    assert.deepEqual(store.task(task.id).resolution.review, review);
    assert.deepEqual(store.task(task.id).resolution.reviews, records);
    // Shared reads are frozen, so an in-place edit cannot hide a change from storage.
    const read = store.task(task.id);
    assert.throws(() => (read.resolution.reviews as typeof records).push(records[0]), TypeError);
    assert.throws(() => { (read.resolution.review as { summary: string }).summary = 'edited'; }, TypeError);
    // A new record writes one row; clearing the current review deletes its row.
    const third = reviewRecordSchema.parse({ runId: 'r3', head, status: 'ready_to_merge', at: '2026-10-03T00:00:00.000Z', verdicts: [verdict()] });
    start = changes();
    store.update(task.id, { resolution: { ...store.task(task.id).resolution, review: null, reviews: [...records, third] } });
    assert.equal(changes() - start - ordinary, 2, 'one record insert and one current-review delete beyond the row write');
    assert.deepEqual(stored().map(r => r.seq), [1, 2, 3]);
    assert.equal(stored()[0].data, before[1].data);

    store.close(); store = new Store(path);
    assert.equal(store.task(task.id).resolution.review, null);
    assert.deepEqual(store.task(task.id).resolution.reviews, [...records, third], 'a restart reads the records back');

    store.update(task.id, { resolution: { ...store.task(task.id).resolution, review, reviews: records } });
    store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
    store.setMeta('schema', 50);
    store.close(); store = new Store(path);
    assert.equal(store.getMeta('schema'), CURRENT_SCHEMA);
    assert.equal(Object.hasOwn(row().resolution, 'review'), false, 'the current review stays out of the row');
    assert.equal(Object.hasOwn(row().resolution, 'reviews'), false, 'review history stays out of the row');
    assert.deepEqual(stored(), before, 'upgrade keeps each review as stored');
    assert.deepEqual(store.task(task.id).resolution.review, review);
    assert.deepEqual(store.task(task.id).resolution.reviews, records);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Report bridge
// ---------------------------------------------------------------------------

function bridgeFixture(role: Run['role'] = 'reviewer', taskGeneration = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-rv-bridge-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const task = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  store.putRun(runSchema.parse({
    id: 'review-run', taskId: task.id, role, generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
    profile: profile('reviewer'), status: 'running', createdAt: 'now', lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
  }));
  store.setCredential('review-run', 'token');
  store.update(task.id, { coordinatorGeneration: taskGeneration, resolution: { ...store.task(task.id).resolution, currentRunId: 'review-run', reviewerAgentId: 'review-agent' } });
  const captured: Completion[] = [];
  const engine = { store, complete: async (completion: Completion) => { captured.push(completion); return { accepted: true as const, eventId: completion.eventId }; } };
  const reports = new Reports(engine as unknown as Engine);
  const report = async (input: Record<string, unknown>) => reports.report(reportSchema.parse({ eventId: randomUUID(), taskId: task.id, runId: 'review-run', summary: 'Reviewed', ...input }), 'token');
  const callback = async (input: Record<string, unknown>) => {
    const { callbackRequest } = await import(new URL('../shared/service/callback-client.mjs', import.meta.url).href);
    const socketPath = join(dir, 'callback.sock');
    const stop = await startCallbacks(socketPath, join(dir, 'worker-report.mjs'), engine as unknown as Engine);
    try {
      return await callbackRequest({ socketPath, token: 'token' }, '/report', {
        eventId: randomUUID(), taskId: task.id, runId: 'review-run', summary: 'Reviewed', ...input,
      });
    } finally { await stop(); }
  };
  return { store, task, captured, report, callback, dir, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function exactCapVerdicts(): ReviewVerdict[] {
  const rows = Array.from({ length: 500 }, (_, index) => verdict({
    id: `row-${String(index).padStart(3, '0')}`, subject: 's'.repeat(600), evidence: 'e'.repeat(4000), note: '',
  }));
  let remaining = MAX_REVIEW_VERDICT_BYTES - Buffer.byteLength(JSON.stringify(rows));
  for (const row of rows) {
    const added = Math.min(4000, remaining);
    row.note = 'n'.repeat(added);
    remaining -= added;
  }
  assert.equal(remaining, 0, 'the schema allows enough note bytes to reach the boundary');
  assert.equal(Buffer.byteLength(JSON.stringify(rows)), MAX_REVIEW_VERDICT_BYTES);
  return rows;
}

test('the report bridge accepts valid verdicts and stores them with the completion', async () => {
  const f = bridgeFixture(); try {
    await f.report({ status: 'ready_to_merge', reviewText: 'Findings', verdicts: [verdict(), verdict({ id: 'v2', subject: 'Tests', verdict: 'insufficient', evidence: 'No fixture' })] });
    assert.equal(f.captured.length, 1);
    assert.deepEqual(f.captured[0].verdicts, [verdict(), verdict({ id: 'v2', subject: 'Tests', verdict: 'insufficient', evidence: 'No fixture' })]);
  } finally { f.close(); }
});

test('the authenticated report accepts the exact 4 MiB boundary and refuses one byte over', async () => {
  const verdicts = exactCapVerdicts();
  const f = bridgeFixture(); try {
    await f.callback({ status: 'ready_to_merge', reviewText: 'Complete boundary review', verdicts });
    assert.equal(f.captured.length, 1);
    assert.equal(Buffer.byteLength(JSON.stringify(f.captured[0].verdicts)), MAX_REVIEW_VERDICT_BYTES);

    const oversized = verdicts.map(row => ({ ...row }));
    const room = oversized.find(row => (row.note?.length ?? 0) < 4000)!;
    room.note = `${room.note ?? ''}n`;
    assert.equal(Buffer.byteLength(JSON.stringify(oversized)), MAX_REVIEW_VERDICT_BYTES + 1);
    await assert.rejects(f.report({ status: 'ready_to_merge', reviewText: 'One byte over', verdicts: oversized }), /Verdicts must be at most 4194304 bytes/);
    assert.equal(f.captured.length, 1, 'an oversized report never reaches the engine');
  } finally { f.close(); }
});

test('blocked reviewer findings are accepted without weakening role, head or reading boundaries', async () => {
  const f = bridgeFixture(); try {
    const findings = [verdict({ id: 'native', verdict: 'insufficient', evidence: 'Owner activation is outstanding' })];
    await f.report({ status: 'blocked', reviewText: 'Source review complete; required native evidence is missing', verdicts: findings });
    assert.equal(f.captured[0].status, 'blocked');
    assert.equal(f.captured[0].head, head);
    assert.equal(f.captured[0].reviewText, 'Source review complete; required native evidence is missing');
    assert.deepEqual(f.captured[0].verdicts, findings);
    await assert.rejects(f.report({ status: 'blocked', head: base, reviewText: 'Wrong head', verdicts: findings }), /requested exact head/);
    await assert.rejects(f.report({ status: 'blocked', reviewResponsibility: 'reviewer', reviewText: 'Reading incomplete' }), /Unfinished reviewer coverage/);
    assert.equal(f.captured.length, 1, 'refused reports never reach completion');
  } finally { f.close(); }
  const otherRole = bridgeFixture('revision'); try {
    await assert.rejects(otherRole.report({ status: 'blocked', reviewText: 'A worker cannot submit review findings' }), /only accepted for reviewer/);
  } finally { otherRole.close(); }
});

test('the report bridge refuses malformed, oversized or non-reviewer verdicts with the reason', async () => {
  const f = bridgeFixture(); try {
    await assert.rejects(f.report({ status: 'ready_to_merge', reviewText: 'Findings', verdicts: [{ id: 'v1', subject: 's', verdict: 'maybe', evidence: 'e' }] }), /verdict/);
    await assert.rejects(f.report({ status: 'ready_to_merge', reviewText: 'Findings', verdicts: [verdict(), verdict()] }), /unique/);
    await assert.rejects(f.report({ status: 'ready_to_merge', reviewText: 'Findings', verdicts: Array.from({ length: 501 }, (_, i) => verdict({ id: `v${i}` })) }), /at most 500|Too big/);
    await assert.rejects(f.report({ status: 'ready_to_merge', reviewText: 'Findings', verdicts: [{ ...verdict(), unexpected: 1 }] }), /Unrecognized/);
    assert.equal(f.captured.length, 0, 'no malformed report reaches the engine');
  } finally { f.close(); }
});

test('larger report limits leave run, reviewer-role and coordinator-generation checks intact', async () => {
  const wrongRun = bridgeFixture(); try {
    await assert.rejects(wrongRun.report({ runId: 'misspelled-run', status: 'ready_to_merge', reviewText: 'Findings', verdicts: [verdict()] }), /Unknown run misspelled-run|Stale reporting run/);
  } finally { wrongRun.close(); }

  const wrongRole = bridgeFixture('revision'); try {
    await assert.rejects(wrongRole.report({ status: 'ready_to_merge', reviewText: 'Findings', verdicts: [verdict()] }), /only accepted for reviewer reports/);
  } finally { wrongRole.close(); }

  const wrongGeneration = bridgeFixture('closeout', 2); try {
    await assert.rejects(wrongGeneration.report({ status: 'closed' }), /Stale reporting run/);
  } finally { wrongGeneration.close(); }
});

// ---------------------------------------------------------------------------
// Published review body
// ---------------------------------------------------------------------------

test('the published review renders the verdicts as a table under the reviewer text, and a review without them is unchanged', () => {
  const task = { id: 'task' } as Task, run = { id: 'run', head } as Run;
  assert.equal(reviewPublicationBody(task, run, 'ready_to_merge', 'Findings'), `Findings\n\n${reviewMarker(task, run, 'ready_to_merge')}`);
  const body = reviewPublicationBody(task, run, 'ready_to_merge', 'Findings', [verdict({ evidence: 'line one\nline two', note: 'a | b' })]);
  assert.ok(body.startsWith('Findings\n\n### Review verdicts'));
  assert.ok(body.includes('| `v1` | Spec compliance | `pass` | line one line two | a \\| b |'));
  assert.ok(body.endsWith(reviewMarker(task, run, 'ready_to_merge')));
  assert.equal(reviewVerdictTable([]), '');
  const supplied = `Approval: ${reviewMarker(task, run, 'ready_to_merge')}`;
  assert.equal(reviewPublicationBody(task, run, 'ready_to_merge', supplied, [verdict()]), `${supplied}${reviewVerdictTable([verdict()])}`);
});

function reviewMarker(task: Task, run: Run, status: string) { return `<!-- northstar-review:${task.id}:${run.id}:${run.head}:${status} -->`; }

test('the formal review body carries the stored verdicts to GitHub', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-review-verdicts-formal-'));
  const repo = join(dir, 'repo');
  await git(dir, 'init', '--initial-branch=main', repo);
  await git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  const store = new Store(join(dir, 'queue.sqlite'));
  const task = { id: 'task-1', repoPath: repo, branch: 'ns-task', baseBranch: 'main', directory: repo, resumePrNumber: 1, resolution: { review: null } } as unknown as Task;
  const run = { id: 'review-run', taskId: task.id, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace', profile: null, status: 'finished', createdAt: 'now', lastObservedAt: null, active: false, idleSince: null, released: false } as Run;
  store.putRun({ ...run, completion: { eventId: 'e', taskId: task.id, runId: run.id, status: 'ready_to_merge', summary: 'Approved', head, verdicts: [verdict()] } as Completion });
  const bodies: string[] = [];
  const id = await publishFormalReview(store, task, run, 'ready_to_merge', 'Substantive findings', { login: 'northstar-reviewer' }, () => true, {
    readToken: async () => 'token',
    verifyPr: async () => ({ url: 'https://github.com/acme/app/pull/1', head }),
    runGh: async (_task, endpoint, args) => {
      if (args.includes('-X')) { const body = args.find(value => value.startsWith('body='))!.slice(5); bodies.push(body); return { id: 900, user: { login: 'northstar-reviewer' }, commit_id: head, state: 'APPROVED', body }; }
      throw new Error(`unexpected ${endpoint}`);
    },
  });
  assert.equal(id, 900);
  assert.ok(bodies[0].includes('### Review verdicts'));
  assert.ok(bodies[0].includes('| `v1` | Spec compliance | `pass` |'));
  assert.ok(bodies[0].includes(`<!-- northstar-review:${task.id}:${run.id}:${head}:ready_to_merge -->`));
  store.close(); rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Engine flow: storage, revision prompt, re-review prompt
// ---------------------------------------------------------------------------

function engineFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-review-verdicts-engine-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.putRepository({ origin: null, path: '/repo' }, 'agent', 'review verdicts fixture');
  const worker = profile('author'), reviewer = profile('reviewer'), coordinator = profile('coordinator');
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewer.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
    responsible: true,
  }), 'host', 'handoff', base);
  let currentHead = head;
  const task = store.update(submitted.id, {
    phase: 'reviewing', workspaceId: 'workspace', directory: '/worktree', branch: submitted.branch, baseBranch: 'main',
    agentId: 'worker', runId: 'initial', profile: worker, workerModel: worker.model, prHead: head, prUrl: 'https://github.com/example/repo/pull/1',
    completion: { taskId: submitted.id, runId: 'initial', eventId: 'initial-result', status: 'ready_for_review', summary: 'Ready', prNumber: 1 },
  });
  const states = new Map<string, { id: string; workspaceId: string; status: string; active: boolean; permissions: boolean; error: string; provider?: string; model?: string }>();
  const idle = (id: string, workspaceId = 'workspace') => states.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '', provider: reviewer.provider, model: id === 'worker' ? worker.model : store.runs(task.id).findLast(run => run.agentId === id)?.profile?.model ?? reviewer.model });
  idle('worker');
  const tokens = new Map<string, string>(), creates: Run[] = [], prompts: string[] = [], published: { run: Run; status: string; text: string; body: string }[] = [];
  const adapter = fakeAdapter({
    profiles: async () => [worker, reviewer, coordinator], validate: async () => base, verifyWorkspace: async () => task.branch,
    createWorkspace: async () => { throw new Error('review verdicts fixture must not create workspaces'); },
    createAgent: async () => { throw new Error('review verdicts fixture must not create agents'); },
    observe: async (id: string) => { const state = states.get(id); if (!state) throw new Error('Agent missing'); return state; },
    agentTimelinePage: observedParticipantTimeline(states),
    verifyPr: async () => ({ head: currentHead, url: task.prUrl! }), verifyPrIdentity: async () => ({ head: currentHead, url: task.prUrl! }), verifyCleanQueueWorktree: async () => {},
    verifyInspectedRevisionHead: async () => {},
    createRun: async (t: Task, run: Run, token: string) => { creates.push(run); tokens.set(run.id, token); prompts.push(runPrompt(t, run, '/helper', '/ticket', true)); const id = `agent-${run.id}`; states.set(id, { id, workspaceId: run.workspaceId, status: 'running', active: true, permissions: false, error: '' }); return { id, workspaceId: run.workspaceId }; },
    sendRun: async (t: Task, run: Run, token: string) => { prompts.push(runPrompt(t, run, '/helper', '/ticket', true)); tokens.set(run.id, token); states.set(run.agentId!, { ...states.get(run.agentId!)!, active: true, status: 'running' }); },
    findRunAgents: async () => [],
    publishReview: async (s: Store, t: Task, run: Run, status: string, text: string) => { published.push({ run, status, text, body: reviewPublicationBody(t, run, status, text, s.run(run.id)?.completion?.verdicts ?? []) }); return 1; },
    verifyReview: async () => {},
    mergeGate: async () => ({ head: currentHead, base: 'main', wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head: currentHead, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {}, notify: async () => {},
  });
  const engine = new Engine(store, adapter as unknown as Adapter & ResolutionAdapter, 0);
  engine.profiles = [worker, reviewer, coordinator];
  const current = () => store.task(task.id);
  const run = () => store.run(current().resolution.currentRunId!)!;
  const complete = (status: Completion['status'], extra: Partial<Completion> = {}) => {
    const r = run(); idle(r.agentId!, r.workspaceId);
    const input: Completion = { eventId: randomUUID(), taskId: task.id, runId: r.id, status, summary: status, head: r.head, ...(r.role === 'reviewer' && status === 'changes_required' ? { reviewResponsibility: 'author' as const } : r.role === 'reviewer' && ['blocked', 'error'].includes(status) ? { reviewResponsibility: 'environment' as const } : {}), ...extra };
    engine.resolution.complete(input, tokens.get(r.id)!);
    // The real sweep releases a finished thread before the next resolution pass;
    // a direct advance needs the same boundary.
    store.putRun({ ...store.run(r.id)!, released: true, status: 'finished' });
    return input;
  };
  const advance = () => engine.resolution.advance(current());
  return { store, engine, task, current, run, complete, advance, prompts, published, idle, tokens, close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('blocked and errored reviewer assessments survive release and reload without approval, publication or an author round', async () => {
  for (const status of ['blocked', 'error'] as const) {
    const f = engineFixture(); try {
      await f.advance();
      const run = f.run();
      const prior = completionSchema.parse({ eventId: 'prior-approval', taskId: f.task.id, runId: 'prior-reviewer', head,
        status: 'ready_to_merge', summary: 'Earlier approval remains history', reviewCommentId: 77, verdicts: [verdict()] });
      const history = reviewRecordFor({ ...run, id: prior.runId } as Run, prior, '2026-10-01T00:00:00.000Z')!;
      f.store.update(f.task.id, { resolution: { ...f.current().resolution, review: prior, reviews: [history] } });
      const findings = [verdict({ id: 'source', evidence: 'Exact source assessment complete' }),
        verdict({ id: 'native', verdict: 'insufficient', evidence: 'Owner-gated proof has not run' })];
      // Exercise the authenticated MCP bridge and real completion/lifecycle paths;
      // omit the background wake so this fixture controls the release boundary.
      const reports = new Reports({ store: f.store, complete: (input: Completion, token: string) => f.engine.resolution.complete(input, token) } as unknown as Engine);
      const input = reportSchema.parse({ eventId: randomUUID(), taskId: f.task.id, runId: run.id, status, head,
        summary: 'Awaiting owner-gated evidence', reviewResponsibility: 'environment',
        reviewText: 'Source assessment is complete. Native proof remains insufficient.', verdicts: findings });
      const token = f.tokens.get(run.id)!;
      await assert.rejects(reports.report(input, 'wrong-token'), /Unauthorized callback/);
      const accepted = await reports.report(input, token);
      assert.deepEqual(await reports.report(input, token), accepted, 'same event replays only its receipt');
      f.idle(run.agentId!, run.workspaceId);
      f.store.putRun({ ...f.store.run(run.id)!, status: 'finished', released: true });
      await f.advance();
      const task = f.current();
      assert.equal(task.phase, status);
      assert.equal(task.resolution.review?.status, status);
      assert.equal(task.resolution.review?.reviewText, input.reviewText);
      assert.deepEqual(latestReviewVerdicts(task), findings);
      assert.equal(isAcceptedReview(task.resolution.review), false);
      assert.equal(task.resolution.integrationTurn, null);
      assert.equal(task.resolution.revisionRuns, 0);
      assert.deepEqual(task.resolution.reviews, [history], 'earlier approval remains history; no new accepted verdict is fabricated');
      assert.equal(f.published.length, 0, 'blocked findings are not published as a review');
      assert.equal(f.store.runs(task.id).filter(item => item.role === 'revision').length, 0);
      await assert.rejects(requiredMergeReview(task), /does not approve merging/);
      const reopened = new Store(f.store.path);
      try {
        assert.deepEqual(reopened.run(run.id)?.completion, f.store.run(run.id)?.completion);
        assert.deepEqual(reopened.task(task.id).resolution.review, task.resolution.review);
      } finally { reopened.close(); }
      await assert.rejects(reports.report({ ...input, eventId: randomUUID() }, token), /Unauthorized callback/);
    } finally { await f.close(); }
  }
});

test('a holding blocked hook cannot revive an older approval or churn the retained findings', async () => {
  const f = engineFixture(); try {
    await f.advance();
    const prior: Completion = { eventId: 'prior', taskId: f.task.id, runId: 'prior-review', head,
      status: 'ready_to_merge', summary: 'Earlier approval', reviewCommentId: 77 };
    f.store.update(f.task.id, { resolution: { ...f.current().resolution, review: prior } });
    const blocked = f.complete('blocked', { reviewText: 'Source complete; owner proof missing', verdicts: [verdict({ verdict: 'insufficient' })] });
    f.engine.hooks.emit = async () => ({ hold: true, attention: true, records: [] });
    await f.advance();
    assert.equal(f.current().resolution.attention, true, 'the existing hook hold still applies');
    assert.equal(f.current().resolution.review?.eventId, blocked.eventId);
    assert.equal(f.current().resolution.review?.status, 'blocked');
    const heldVersion = f.current().version;
    await f.advance();
    assert.equal(f.current().version, heldVersion, 'the same held findings are not rewritten');
    await assert.rejects(f.engine.moveToMerge({ taskId: f.task.id, version: f.current().version,
      reason: 'An earlier approval cannot replace missing proof' }), /review|approval|acceptance/i);
    assert.notEqual(f.current().phase, 'verifying');
    assert.equal(f.published.length, 0);
  } finally { await f.close(); }
});

test('a summary-only reviewer error displaces an older approval without publishing a verdict', async () => {
  const f = engineFixture(); try {
    await f.advance();
    const prior: Completion = { eventId: 'prior', taskId: f.task.id, runId: 'prior-review', head,
      status: 'ready_to_merge', summary: 'Earlier approval', reviewCommentId: 77 };
    f.store.update(f.task.id, { resolution: { ...f.current().resolution, review: prior } });
    const failed = f.complete('error');
    await f.advance();
    assert.equal(f.current().resolution.review?.eventId, failed.eventId);
    assert.equal(f.current().resolution.review?.status, 'error');
    assert.equal(f.published.length, 0);
    await assert.rejects(requiredMergeReview(f.current()), /does not approve merging/);
  } finally { await f.close(); }
});

test('direct reviewer callbacks cannot attach blocked findings to another head', async () => {
  const f = engineFixture(); try {
    await f.advance();
    assert.throws(() => f.complete('blocked', { head: base, reviewText: 'Findings from another head' }), /requested exact head/);
    assert.equal(f.run().completion, null);
  } finally { await f.close(); }
});

test('an accepted review with verdicts is stored with reviewer agent, run, head and review id, and rendered in the published review', async () => {
  const f = engineFixture(); try {
    await f.advance(); // launch the reviewer
    assert.equal(f.run().role, 'reviewer');
    const reviewed = verdict({ id: 'spec', subject: 'Spec 037', verdict: 'pass', evidence: 'Read the diff' });
    f.complete('changes_required', { reviewText: 'Fix the table', verdicts: [reviewed] });
    await f.advance();
    const task = f.current();
    assert.equal(task.resolution.review?.verdicts?.[0]?.id, 'spec');
    assert.equal(task.resolution.reviews.length, 1);
    assert.deepEqual(task.resolution.reviews[0], {
      runId: f.store.runs(task.id).find(run => run.role === 'reviewer')!.id,
      agentId: f.store.runs(task.id).find(run => run.role === 'reviewer')!.agentId,
      head, status: 'changes_required', reviewId: null, reviewCommentId: 1, at: task.resolution.reviews[0].at, verdicts: [reviewed],
    });
    assert.ok(f.published[0].body.includes('### Review verdicts'), 'the published review shows the verdicts');
    assert.equal(f.store.task(task.id).resolution.reviews[0].verdicts[0].id, 'spec', 'detail exposes the verdicts');
  } finally { await f.close(); }
});

test('a review without verdicts leaves the record and prompt bytes untouched', async () => {
  const f = engineFixture(); try {
    await f.advance();
    f.complete('changes_required', { reviewText: 'Fix the links' });
    await f.advance();
    assert.deepEqual(f.current().resolution.reviews, [], 'no record is appended');
    assert.equal(f.current().resolution.review?.verdicts, undefined);
    assert.doesNotMatch(f.prompts.at(-1)!, /Review verdicts/);
  } finally { await f.close(); }
});

test('the revision prompt carries the latest verdicts as JSON and the re-review carries the earlier list', async () => {
  const f = engineFixture(); try {
    await f.advance();
    const reviewed = verdict({ id: 'spec', subject: 'Spec 037', verdict: 'pass', evidence: 'Read the diff' });
    f.complete('changes_required', { reviewText: 'Fix the table', verdicts: [reviewed] });
    await f.advance();
    await f.advance(); // launch the revision for the review findings
    const revision = f.prompts.at(-1)!;
    assert.equal(f.run().role, 'revision');
    assert.match(revision, /Review verdicts \(recorded by review comment ID 1;/);
    assert.ok(revision.includes('```json'));
    assert.ok(revision.includes('"id": "spec"'));
    assert.ok(revision.includes('"verdict": "pass"'));
    // The revision returns a new head; the next reviewer sees the earlier list.
    f.complete('ready_for_review', { prNumber: 1 });
    await f.advance(); // apply the revision, clearing the applied review
    assert.equal(f.current().resolution.review, null);
    await f.advance(); // launch the re-review
    assert.equal(f.run().role, 'reviewer');
    const reReview = f.prompts.at(-1)!;
    assert.match(reReview, /report every subject at the current exact head/);
    assert.match(reReview, /A changed judgment is allowed when the head supports it/);
    assert.match(reReview, /use the new verdict's optional note to say it supersedes the earlier verdict by id/);
    assert.match(reReview, /separately inspect values the worker published that cite an earlier review ID/);
    assert.match(reReview, /only with the immutable verdict for that id in the exact review it cites/);
    assert.match(reReview, /Earlier recorded verdicts from review comment ID 1/);
    assert.doesNotMatch(reReview, /opts into structured review verdicts/);
    assert.ok(reReview.includes('"id": "spec"'));
  } finally { await f.close(); }
});

test('an insufficient changes_required verdict at the revision budget waits on the planner', async () => {
  const f = engineFixture(); try {
    f.store.update(f.task.id, { resolution: { ...f.current().resolution, revisionRuns: REVISION_BUDGET } });
    await f.advance();
    const reviewerId = f.run().id;
    f.complete('changes_required', { reviewText: 'Body approved; publication pending', verdicts: [verdict({ id: 'body', subject: 'Body', verdict: 'pass' }), verdict({ id: 'publication', subject: 'Publication', verdict: 'insufficient' })] });
    await f.advance();
    assert.equal(f.current().phase, 'needs_attention');
    assert.match(f.current().reason, /Waiting with the planner(?: or task owner [^:]+)?: blocker escalation/);
    assert.equal(f.current().resolution.pendingRevisionCause, null);
    assert.equal(f.current().resolution.reviews.at(-1)?.runId, reviewerId);
    assert.equal(f.store.runs(f.task.id).filter(r => r.revisionCause === 'continuation').length, 0);
  } finally { await f.close(); }
});

test('old pending publication continuations proceed once their named run is gone', async () => {
  const f = engineFixture(); try {
    f.store.update(f.task.id, { phase: 'changes_requested', resolution: { ...f.current().resolution, currentRunId: null, pendingRevisionCause: 'continuation' } });
    await f.advance(); await f.advance();
    // nucleus#1106: a recorded continuation cause with no current, unreleased
    // reviewer run cannot hold a checkpoint wait, so the recorded cause alone
    // never parks the task — the pending revision relaunches.
    const runs = f.store.runs(f.task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.role, 'revision');
    assert.equal(runs[0]!.revisionCause, 'continuation');
    assert.equal(f.current().resolution.currentRunId, runs[0]!.id);
    assert.equal(f.current().resolution.pendingRevisionCause, null);
    assert.match(f.current().reason, /proceeds to its next step/);
    // The relaunched continuation owns the work while it runs, so a retry still
    // waits for the explicit operator revision.
    assert.throws(() => f.engine.resolution.retry(f.current(), true, 'Resume publication', false), /continues the same reviewer from it once its turn ends/);
  } finally { await f.close(); }
});

test('an already persisted publication intent cannot restart or be reminded after the responsible task budget', async () => {
  const f = engineFixture(); try {
    const old = runSchema.parse({ id: 'old-publication', taskId: f.task.id, role: 'revision', revisionCause: 'continuation', generation: 1, head, base, agentId: 'old-worker', workspaceId: 'workspace', profile: null, lastObservedAt: null, active: null, idleSince: null, status: 'intent', createdAt: '2026-10-06T00:00:00.000Z', completion: null, released: false });
    f.store.putRun(old);
    f.store.update(f.task.id, { phase: 'changes_requested', resolution: { ...f.current().resolution, currentRunId: old.id } });
    await f.advance();
    await f.engine.resolution.launch(f.current(), 'revision');
    await f.engine.resolution.remindStoppedRun(f.current(), old);
    assert.equal(f.store.runs(f.task.id).length, 1);
    assert.equal(f.store.run(old.id)?.released, false);
    assert.equal(f.current().resolution.incident, null);
    assert.match(f.current().reason, /Budget reached: 180 minutes of wall time since the responsible lifecycle began/);
  } finally { await f.close(); }
});

test('a later review can change a verdict and appends its own list without editing the earlier one', async () => {
  const f = engineFixture(); try {
    await f.advance();
    const first = verdict({ id: 'spec', subject: 'Spec 037', verdict: 'fail', evidence: 'The old head misses a requirement' });
    f.complete('changes_required', { reviewText: 'Fix the table', verdicts: [first] });
    await f.advance();
    const earlier = f.current().resolution.reviews[0];
    await f.advance(); // launch revision
    f.complete('ready_for_review', { prNumber: 1 });
    await f.advance();
    await f.advance(); // launch the second reviewer
    const second = verdict({ id: 'spec', subject: 'Spec 037', verdict: 'pass', evidence: 'The new head satisfies the requirement' });
    f.complete('ready_to_merge', { reviewText: 'The revised head satisfies the requirement', verdicts: [second] });
    await f.advance();
    const reviews = f.current().resolution.reviews;
    assert.equal(reviews.length, 2);
    assert.deepEqual(reviews[0], earlier, 'the earlier record is unchanged');
    assert.deepEqual(reviews[1].verdicts, [second]);
    assert.notEqual(reviews[1].runId, reviews[0].runId);
  } finally { await f.close(); }
});

test('the reviewer prompt carries the ordinary verdict guidance and never a brief gate', () => {
  const run = { id: 'run', role: 'reviewer', generation: 1, head } as Run;
  const prompt = runPrompt({ resolution: { review: null, reviews: [] }, id: 'task', title: 'Task', originAgentId: 'origin', repoPath: '/repo', workspaceId: 'workspace', directory: '/worktree', handoffPath: 'handoff.md', planningCommit: head, skipPRReview: false, prUrl: 'https://github.com/example/repo/pull/1', reason: 'Review', branch: 'ns-task', baseBranch: 'main' } as unknown as Task, run, '/helper', '/ticket', true);
  assert.match(prompt, /optional verdicts array \(id, subject, verdict, evidence, optional note\)/);
  assert.doesNotMatch(prompt, /opts into structured review verdicts/);
  assert.doesNotMatch(prompt, /queue\.reviewPassGate/);
});

test('a re-review prompt travels the earlier verdict list even for a stored row that opted in before the cutover', () => {
  const review: Completion = { eventId: 'e', taskId: 'task', runId: 'review-run', status: 'changes_required', summary: 'Findings', head, verdicts: [verdict()] } as Completion;
  const task = { resolution: { review, reviews: [] } } as unknown as Pick<Task, 'resolution'>;
  assert.deepEqual(latestReviewVerdicts(task), [verdict()]);
  const run = { id: 'run', role: 'reviewer', generation: 1, head } as Run;
  const prompt = runPrompt({ ...task, id: 'task', title: 'Task', originAgentId: 'origin', repoPath: '/repo', workspaceId: 'workspace', directory: '/worktree', handoffPath: 'handoff.md', planningCommit: head, skipPRReview: false, prUrl: 'https://github.com/example/repo/pull/1', reason: 'Review', branch: 'ns-task', baseBranch: 'main' } as unknown as Task, run, '/helper', '/ticket', true);
  assert.match(prompt, /separately inspect values the worker published that cite an earlier review ID/);
  assert.match(prompt, /Earlier recorded verdicts from/);
  assert.ok(prompt.includes('"id": "v1"'));
});

test('an accepted review with verdicts reaches merge intent', async () => {
  const f = engineFixture(); try {
    await f.advance(); // launch the reviewer
    f.complete('ready_to_merge', { reviewText: 'All clear', verdicts: [verdict({ id: 'spec' })] });
    await f.advance(); // apply the accepted review -> verifying
    assert.equal(f.current().resolution.review?.status, 'ready_to_merge');
    await f.advance(); // mechanical verification -> merging
    await f.advance(); // merge intent
    assert.equal(f.current().resolution.mergeIntent, true);
  } finally { await f.close(); }
});

test('a new intent on a pre-roll retained reviewer preserves its old bridge contract', async () => {
  const f = engineFixture(); try {
    const profile = f.engine.profiles.find(p => p.id === 'reviewer')!;
    f.idle('pre-roll-reviewer');
    f.store.putRun(runSchema.parse({ id: 'pre-roll', taskId: f.task.id, role: 'reviewer', generation: 1, head, base,
      agentId: 'pre-roll-reviewer', workspaceId: 'workspace', profile, status: 'finished', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, released: true,
      completion: { eventId: 'legacy-review', taskId: f.task.id, runId: 'pre-roll', status: 'blocked', summary: 'Prior settled environment report', head } }));

    f.store.update(f.task.id, { resolution: { ...f.current().resolution, reviewerAgentId: 'pre-roll-reviewer', reviewerProfile: profile } });
    await f.engine.resolution.advance(f.current());
    const run = f.run();
    assert.equal(run.agentId, 'pre-roll-reviewer');
    assert.equal(run.reviewResponsibilityRequired, false);
    // An old z.object tool catalog can strip the new field. The actual callback
    // with no field must still finish this retained agent's new run.
    const receipt = f.engine.resolution.complete({ eventId: randomUUID(), taskId: f.task.id, runId: run.id,
      status: 'changes_required', summary: 'Concrete author defect through old catalog', head: run.head,
      reviewCommentId: 1, reviewText: 'Concrete author defect' }, f.tokens.get(run.id)!);
    assert.equal(receipt.accepted, true);
    assert.equal(f.store.run(run.id)!.completion?.reviewResponsibility, undefined);
  } finally { await f.close(); }
});

test('fresh reviewer bridge contract persists into a retained new run', async () => {
  const f = engineFixture(); try {
    await f.engine.resolution.advance(f.current());
    const first = f.run();
    assert.equal(first.reviewResponsibilityRequired, true);
    f.complete('blocked');
    f.store.putRun({ ...f.store.run(first.id)!, released: true, status: 'finished' });
    f.idle(first.agentId!);
    f.store.update(f.task.id, { phase: 'awaiting_review', resolution: { ...f.current().resolution, currentRunId: null } });
    await f.engine.resolution.advance(f.current());
    assert.notEqual(f.run().id, first.id);
    assert.equal(f.run().agentId, first.agentId, JSON.stringify(f.store.eventsAll(f.task.id).filter(e => e.kind.includes('reviewer_'))));
    assert.equal(f.run().reviewResponsibilityRequired, true);
    assert.throws(() => f.engine.resolution.complete({ eventId: randomUUID(), taskId: f.task.id, runId: f.run().id,
      status: 'changes_required', summary: 'Must name responsibility', head: f.run().head,
      reviewCommentId: 1, reviewText: 'Concrete author defect' }, f.tokens.get(f.run().id)!), /Name reviewResponsibility/);
  } finally { await f.close(); }
});

test('legacy stored gates parse and permit ordinary review without verdicts', async () => {
  const f = engineFixture();
  try {
    const row = f.store.db.prepare('SELECT data FROM tasks WHERE id=?').get(f.task.id) as { data: string };
    const data = JSON.parse(row.data);
    Object.assign(data, { reviewVerdicts: ['spec'], reviewPassGate: ['spec'], manualVerification: true });
    f.store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(data), f.task.id);
    assert.equal(f.current().manualVerification, true);
    await f.advance();
    assert.equal(f.run().role, 'reviewer');
    f.complete('ready_to_merge', { reviewText: 'Approved' });
    await f.advance();
    assert.equal(f.current().resolution.review?.status, 'ready_to_merge');
  } finally { await f.close(); }
});
