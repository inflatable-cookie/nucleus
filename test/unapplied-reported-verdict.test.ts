/**
 * A live task (2026-11-23): a reviewer started with the explicit `run.start`
 * command in a formal-review repository reported ready_to_merge at the exact PR
 * head, its run released from the recorded completion, and nothing applied the
 * verdict. The task kept "reviewer result received; waiting for thread release"
 * with no stop, no wait and no live run.
 *
 * The stored shape these tests reproduce: an earlier reviewer run superseded and
 * released with no agent ever bound, and the reporting reviewer released with an
 * authenticated completion, both in the task workspace, the reporter still bound
 * as the current run.
 *
 * - The explicit command recorded no publication form on the run, so the reviewer
 *   was told to post a PR comment. A formal-review repository applies a verdict
 *   only with a review ID, and no later fact gives that report one: it is
 *   superseded, never applied, and the next pass admits a fresh formal reviewer.
 * - A refusal that waits on another owner keeps the report governing, as the
 *   task's visible typed wait.
 * - The released, never-bound superseded run is history: it does not keep a
 *   formal verdict from applying on the next pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, digest } from '../core/store/store';
import { Engine } from '../core/engine';
import { resultApplied } from '../core/intake/applied-result';
import { threadReleasePendingReason } from '../core/intake/thread-waits';
import { runSchema, submissionSchema, taskControlInputSchema, type Completion, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const REVIEWER_AGENT = 'review-agent';
const PR = 'https://github.com/example/repo/pull/7';

const profile = (id: string, model: string): Profile =>
  ({ id, name: id, provider: 'test', model, notes: '', available: true, problem: '', supportedThinking: [] });

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-unapplied-verdict-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const worker = profile('worker', 'test/worker'), reviewer = profile('reviewer', 'test/reviewer');
  const all = [worker, reviewer];
  store.setMeta('pool', all.map(item => ({ profileId: item.id, enabled: true, group: item.id,
    roles: [item.id === 'reviewer' ? 'reviewer' : 'worker'], weight: 'default', scopes: ['general'] })));
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Reported verdict', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  // The repository opts into formal reviews (Spec 033).
  store.patchRepository({ path: '/repo', origin: null }, { reviewer: { login: 'review-bot' } });
  const observations = new Map<string, AgentObservation>();
  const idle = (id: string, model?: string) =>
    observations.set(id, { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model });
  idle('worker-agent', worker.model);
  idle(REVIEWER_AGENT, reviewer.model);
  const published: { status: string; login: string | null }[] = [];
  const createdRuns: Run[] = [];
  const adapter = {
    profiles: async () => all, validate: async () => base, verifyWorkspace: async () => {},
    createWorkspace: async () => { throw new Error('fixtures do not create workspaces'); },
    findWorkspaces: async () => [], findAgents: async () => [],
    createAgent: async () => { throw new Error('fixtures do not create agents'); },
    observe: async (id: string) => {
      const state = observations.get(id);
      if (!state) throw new Error('Agent was not found');
      return state;
    },
    originAgent: async (id: string) => ({ id, workspaceId: 'workspace', title: id, archived: false }),
    archiveAgent: async () => {}, notify: async () => {}, findRunAgents: async () => [],
    verifyPr: async () => ({ head, url: PR }),
    verifyPrIdentity: async () => ({ head, url: PR }),
    verifyCleanQueueWorktree: async () => {}, verifyResume: async () => {},
    publishReview: async (_store: Store, _task: Task, _run: Run, status: string, _text: string, _allowed: unknown, setting?: { login: string }) => {
      published.push({ status, login: setting?.login ?? null });
      return 4242;
    },
    verifyReview: async () => 4242,
    coveringEvidence: async () => ({ head, base, wait: '' }), authorCommentEvidence: async () => '',
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {},
    createRun: async (_t: Task, r: Run) => { createdRuns.push(r); return { id: `agent-${r.id}`, workspaceId: r.workspaceId }; },
    sendRun: async (_t: Task, r: Run) => { createdRuns.push(r); },
    stopAgentTurn: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = all;
  const current = () => store.task(submitted.id);
  const settle = async () => { await engine.wake(); await engine.quiesce(); };
  const control = (args: Record<string, unknown>) => engine.performTaskControl(taskControlInputSchema.parse({
    taskId: submitted.id, version: current().version, reason: 'Owner control', caller: 'owner-thread', ...args,
  }));
  return {
    store, engine, taskId: submitted.id, control, profiles: { worker, reviewer }, current, settle, published, createdRuns,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const reviewerRun = (taskId: string, id: string, createdAt: string, changes: Partial<Run>): Run => runSchema.parse({
  id, taskId, role: 'reviewer', generation: 1, head, base, agentId: REVIEWER_AGENT, workspaceId: 'workspace',
  hostId: 'host', profile: null, status: 'finished', createdAt, lastObservedAt: null, active: false, idleSince: null,
  completion: null, released: true, ...changes,
});

/**
 * The live shape. `published` chooses what the reviewer did: a PR comment (what
 * a reviewer told to comment reports) or nothing, leaving Nucleus to publish the
 * formal review from the findings text.
 */
function reportedVerdictShape(f: ReturnType<typeof fixture>, published: 'comment' | 'formal') {
  f.store.update(f.taskId, {
    phase: 'awaiting_review', workspaceIntent: true, agentIntent: false, workspaceId: 'workspace', directory: null,
    agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
    prUrl: PR, prHead: head, resumePrNumber: 7,
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-1', status: 'ready_for_review', summary: 'Ready', prNumber: 7, head },
    reason: threadReleasePendingReason('reviewer'),
  });
  // An earlier reviewer whose creation settled without an agent: superseded and released, never bound.
  f.store.putRun(reviewerRun(f.taskId, 'superseded-review', minutesAgo(30), {
    agentId: null, status: 'superseded', profile: f.profiles.reviewer,
  }));
  const completion: Completion = {
    taskId: f.taskId, runId: 'reported-review', eventId: 'review-1', status: 'ready_to_merge',
    summary: 'Reviewed the exact head', head,
    ...(published === 'comment' ? { reviewCommentId: 7001 } : { reviewText: 'All required checks pass at the exact head.' }),
  } as Completion;
  f.store.putRun(reviewerRun(f.taskId, 'reported-review', minutesAgo(20), {
    profile: f.profiles.reviewer, completion, completionReceivedAt: minutesAgo(10),
    ...(published === 'formal' ? { formalReview: true } : {}),
  }));
  // Callback intake's authenticated receipt for that completion, as stored.
  const stored = f.store.run('reported-review')!.completion!;
  f.store.setCompletionReceipt(completion.eventId, f.taskId, 'reported-review', digest(JSON.stringify(stored)),
    JSON.stringify({ accepted: true, eventId: completion.eventId }));
  f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: 'reported-review',
    reviewerAgentId: REVIEWER_AGENT, reviewerProfile: f.profiles.reviewer } });
}

test('a comment-only verdict in a formal-review repository is superseded and the next pass admits a fresh formal reviewer', async () => {
  const f = fixture(); try {
    reportedVerdictShape(f, 'comment');
    await f.settle();
    const task = f.current();
    // Never applied: no accepted verdict, nothing published for it.
    assert.equal(task.resolution.review, null, 'a verdict without a review ID is never accepted');
    assert.deepEqual(f.published, [], 'nothing is published for a refused verdict');
    const superseded = f.store.eventsAll(f.taskId).filter(event => event.kind === 'reported_verdict_superseded');
    assert.equal(superseded.length, 1, JSON.stringify(f.store.eventsAll(f.taskId).slice(-8).map(event => event.kind)));
    assert.match(superseded[0]!.detail, /^reported-review ready_to_merge at a{40}: Review publication must prove a review ID/);
    // The report stops governing: a fresh reviewer is admitted at the exact head, told to publish formally.
    const fresh = f.createdRuns.filter(run => run.role === 'reviewer');
    assert.equal(fresh.length, 1, `${task.phase}: ${task.reason}`);
    assert.notEqual(fresh[0]!.id, 'reported-review');
    assert.equal(fresh[0]!.head, head);
    assert.equal(f.store.run(fresh[0]!.id)?.formalReview, true);
    assert.equal(task.resolution.currentRunId, fresh[0]!.id);
    assert.notEqual(task.reason, threadReleasePendingReason('reviewer'));
  } finally { await f.close(); }
});

for (const [verb, args] of [
  ['restart', { action: 'restart', role: 'reviewer' }],
  ['route', { action: 'route', role: 'reviewer', profileId: 'reviewer' }],
] as const) {
  test(`${verb} role=reviewer on a permanently refused report launches a fresh formal reviewer`, async () => {
    const f = fixture(); try {
      reportedVerdictShape(f, 'comment');
      await f.control(args);
      await f.settle();
      const fresh = f.createdRuns.filter(run => run.role === 'reviewer' && run.id !== 'reported-review');
      assert.ok(fresh.length >= 1, `${f.current().phase}: ${f.current().reason}`);
      assert.ok(fresh.every(run => f.store.run(run.id)?.formalReview === true), 'every new reviewer run publishes formally');
      assert.equal(f.current().resolution.review, null, 'the refused report is never accepted');
    } finally { await f.close(); }
  });
}

test('a refusal that waits on another owner keeps the report governing and names the wait', async () => {
  const f = fixture(); try {
    // A comment-path repository: the published comment verdict is valid evidence.
    f.store.patchRepository({ path: '/repo', origin: null }, { reviewer: null });
    reportedVerdictShape(f, 'comment');
    // A dispatch hold's owner must release the task before this verdict applies.
    f.store.update(f.taskId, { holds: { dispatch: { owner: 'planner', reason: 'Waiting on a source ruling', at: new Date().toISOString(), generation: 1, until: null } } });
    await f.settle();
    const task = f.current();
    assert.equal(resultApplied(f.store, f.taskId, 'reported-review'), false, JSON.stringify(f.store.eventsAll(f.taskId).slice(-12).map(e => `${e.kind}: ${e.detail.slice(0, 120)}`)));
    assert.equal(f.store.eventsAll(f.taskId).some(event => event.kind === 'reported_verdict_superseded'), false);
    assert.deepEqual(f.createdRuns.filter(run => run.role === 'reviewer'), [], 'no fresh review while the report can still apply');
    assert.equal(task.resolution.currentRunId, 'reported-review');
    assert.match(`${task.resolution.stop?.detail ?? ''} ${task.reason}`, /held/i, JSON.stringify(task.resolution.stop));
  } finally { await f.close(); }
});

test('a formal verdict applies on the next pass beside a released superseded run that never bound an agent', async () => {
  const f = fixture(); try {
    reportedVerdictShape(f, 'formal');
    await f.settle();
    const task = f.current();
    assert.equal(resultApplied(f.store, f.taskId, 'reported-review'), true, `${task.phase}: ${task.reason}`);
    assert.equal(task.resolution.review?.runId, 'reported-review');
    assert.equal(task.resolution.review?.head, head, 'the verdict binds the exact PR head');
    assert.deepEqual(f.published, [{ status: 'ready_to_merge', login: 'review-bot' }]);
    assert.notEqual(task.phase, 'awaiting_review');
  } finally { await f.close(); }
});
