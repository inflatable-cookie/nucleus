import { fakeAdapter, profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, digest } from '../core/store/store';
import { Engine } from '../core/engine';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { runSchema, submissionSchema, taskControlInputSchema, taskNextSchema,
  type Completion, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { toolTimelinePage } from './support/tool-timeline';

/**
 * Task 553: `move to=review` on a responsible task continues the retained
 * reviewer (Spec 057 delta review at the new head) instead of clearing it.
 * Only `fresh: true`, or a closed or unavailable reviewer, starts a new one.
 * A null prHead with an authenticated pushed head in the report is resolved
 * against the task's PR before review, and `next` names which reviewer the
 * move will use.
 *
 * The retained-path tests prove the dispatch itself, not just the stored
 * fields: after the move, the engine's own lifecycle pass must deliver the
 * next reviewer run to the retained agent's existing thread (sendRun) with no
 * new reviewer agent created. A retained second round is an ordinary detached
 * round, so the fixture carries a real bare origin, repository and worktree;
 * every head is a real pushed commit.
 */

const CALLER = 'owner-thread';
const PR = 201, PR_URL = 'https://github.com/example/repo/pull/201';



const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ns-move-review-retained-')));
  const origin = join(dir, 'origin.git'), repo = join(dir, 'repo'), worktree = join(dir, 'worktree');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.name', 'Queue Fixture');
  git(repo, 'config', 'user.email', 'queue@example.test');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'planning');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'worktree', 'add', '-b', 'feature/retained', worktree, 'main');
  writeFileSync(join(worktree, 'feature.txt'), 'first round\n');
  git(worktree, 'add', 'feature.txt'); git(worktree, 'commit', '-m', 'first round');
  const oldHead = git(worktree, 'rev-parse', 'HEAD');
  git(worktree, 'push', '-q', 'origin', 'feature/retained');
  // The author's pushed revision: the worktree sits on the branch at the new
  // head, exactly the checkout an ordinary retained round's custody proves.
  writeFileSync(join(worktree, 'feature.txt'), 'second round\n');
  git(worktree, 'add', 'feature.txt'); git(worktree, 'commit', '-m', 'second round');
  const newHead = git(worktree, 'rev-parse', 'HEAD');
  git(worktree, 'push', '-q', 'origin', 'feature/retained');

  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const worker = profile('worker', 'test/worker'), reviewer = profile('reviewer', 'test/reviewer');
  const all = [worker, reviewer];
  store.setMeta('pool', all.map(item => ({ profileId: item.id, enabled: true, group: item.id,
    roles: [item.id === 'reviewer' ? 'reviewer' : 'worker'], weight: 1, scopes: ['general'] })));
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Retained review across a new head', repoPath: repo, planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const current = () => store.task(submitted.id);
  const observations = new Map<string, { id: string; workspaceId: string | null; status: string; active: boolean;
    permissions: boolean; error: string; provider?: string; model?: string }>();
  observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false,
    permissions: false, error: '', provider: 'test', model: worker.model });
  observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false,
    permissions: false, error: '', provider: 'test', model: reviewer.model });
  const prs = new Map<number, { url: string; head: string }>();
  prs.set(PR, { url: PR_URL, head: newHead });
  /** Runs delivered to an existing agent's thread: the retained reviewer path. */
  const sentRuns: Run[] = [];
  /** Runs that required creating a new agent: the fresh reviewer path. */
  const createdRuns: Run[] = [];
  const tokens = new Map<string, string>();
  const adapter = fakeAdapter({
    profiles: async () => all, validate: async () => base, verifyWorkspace: async () => {},
    createWorkspace: async () => { throw new Error('no workspaces here'); },
    createAgent: async () => { throw new Error('no fresh workers here'); },
    findRunAgents: async () => [],
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: 'workspace', status: 'idle',
      active: false, permissions: false, error: '' },
     notify: async () => {},
    agentTimelinePage: async () => toolTimelinePage([]),
    verifyPr: async (t: Task, n: number) => {
      const pr = prs.get(n);
      if (!pr || n !== PR) throw new Error(`PR #${n} is not the task PR`);
      return { url: pr.url, head: pr.head, repository: 'example/repo', headRepository: 'example/repo' };
    },
    coveringEvidence: async (t: Task) => ({ head: t.prHead!, base: t.resolution.mergeBase ?? t.planningBase, wait: '' }),
    verifyPrIdentity: async (t: Task, n: number) => {
      const pr = prs.get(n);
      if (!pr || n !== PR) throw new Error(`PR #${n} is not the task PR`);
      return { url: pr.url, head: pr.head, repository: 'example/repo', headRepository: 'example/repo' };
    },
    verifyResume: async () => {},
    verifyInspectedRevisionHead: async () => {},
    verifyCleanQueueWorktree: async () => {}, verifyReview: async () => 12345, publishReview: async () => 12345,
    mergeGate: async () => ({ head: newHead, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head: newHead, base: 'main' }),
    syncMain: async () => base, verifyCloseout: async () => {},
    createRun: async (_t: Task, r: Run, token: string) => {
      createdRuns.push(r); tokens.set(r.id, token);
      const id = `fresh-reviewer-${createdRuns.length}`;
      observations.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true,
        permissions: false, error: '', provider: 'test', model: r.profile!.model });
      return { id, workspaceId: r.workspaceId };
    },
    sendRun: async (_t: Task, r: Run, token: string, _context: unknown, _owner: unknown,
      guard?: { allowed: () => Promise<boolean>; stillAllowed: () => boolean }) => {
      assert.ok(guard, 'a retained reviewer round carries a final send guard');
      assert.equal(await guard.allowed(), true, 'the retained round send guard allows the delivery');
      assert.equal(guard.stillAllowed(), true, 'the retained round final gate still allows the delivery');
      sentRuns.push(r); tokens.set(r.id, token);
      observations.set(r.agentId!, { id: r.agentId!, workspaceId: r.workspaceId, status: 'running', active: true,
        permissions: false, error: '', provider: 'test', model: r.profile!.model });
    },
    stopAgentTurn: async () => {},
  } as unknown as Adapter);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = all;
  const control = (args: Record<string, unknown>) => engine.performTaskControl(taskControlInputSchema.parse({
    taskId: submitted.id, version: current().version, reason: 'Owner continuation', caller: CALLER, ...args,
  }));
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, current())));
  const setResolution = (patch: Partial<Task['resolution']>) =>
    store.update(submitted.id, { resolution: { ...current().resolution, ...patch } });
  const dispatched = () => {
    const runId = current().resolution.currentRunId;
    return runId ? store.run(runId) : null;
  };
  return { store, engine, taskId: submitted.id, profiles: { worker, reviewer }, heads: { base, oldHead, newHead },
    worktree, current, control, next, observations, prs, sentRuns, createdRuns, dispatched, setResolution,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
type Fixture = ReturnType<typeof fixture>;

/** A responsible task with a retained reviewer at the old head, ready for a new-head review. */
function responsibleShape(f: Fixture) {
  f.store.update(f.taskId, {
    responsible: true,
    phase: 'changes_requested', agentId: 'worker-agent', workspaceId: 'workspace', directory: f.worktree,
    profile: f.profiles.worker, workerModel: f.profiles.worker.model, branch: 'feature/retained',
    workspaceIntent: true, agentIntent: true,
    prHead: f.heads.oldHead, prUrl: PR_URL, resumePrNumber: PR,
  });
  f.setResolution({ reviewerAgentId: 'review-agent', reviewerProfile: f.profiles.reviewer });
}

/**
 * The retained reviewer's finished first round at the old head: released, with
 * its accepted changes_required receipt, so the same agent is eligible for the
 * delta round at the new head.
 */
function priorReviewerRound(f: Fixture, overrides: Partial<Run> = {}) {
  const completion: Completion = {
    eventId: 'prior-review-event', taskId: f.taskId, runId: 'prior-review-run', status: 'changes_required',
    summary: 'Fix the feature before merge', reviewText: 'Earlier finding: the gate misses the empty case.',
    reviewResponsibility: 'author', head: f.heads.oldHead,
  };
  f.store.putRun(runSchema.parse({
    id: 'prior-review-run', taskId: f.taskId, role: 'reviewer', generation: 1, head: f.heads.oldHead,
    base: f.heads.base, agentId: 'review-agent', workspaceId: 'workspace', profile: f.profiles.reviewer,
    status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(),
    active: false, idleSince: new Date().toISOString(), completion, released: true, ...overrides,
  }));
  f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)')
    .run(completion.eventId, f.taskId, 'prior-review-run', digest(JSON.stringify(completion)), JSON.stringify({ accepted: true }));
}

const moveReview = (f: Fixture, extra: Record<string, unknown> = {}) =>
  f.control({ action: 'move', to: 'review', reason: 'Review the new head', ...extra });

test('move to=review on a responsible task keeps the retained reviewer at the new head', async () => {
  const f = fixture();
  try {
    responsibleShape(f);
    priorReviewerRound(f);
    f.engine.resolution.waiting(f.current(), 'Coordinator recovery: 1 of 3', 'operator_needed');
    const moved = await moveReview(f) as Task;
    assert.equal(moved.phase, 'awaiting_review');
    assert.equal(moved.prHead, f.heads.newHead);
    assert.equal(moved.resolution.reviewerAgentId, 'review-agent', 'the retained reviewer continues');
    assert.equal(moved.resolution.stop, null, 'starting the reviewer clears the stale recovery stop');
    assert.deepEqual(moved.resolution.reviewerProfile, f.profiles.reviewer);
    // Beyond the stored fields: the engine's own dispatch sends the next
    // reviewer run to the retained agent's existing thread, creates no new
    // reviewer agent, and binds the run to the new head as the retained
    // reviewer's delta round.
    await f.engine.wake();
    const run = f.dispatched();
    assert.ok(run, `a reviewer run was dispatched: ${f.current().reason}`);
    assert.equal(run!.role, 'reviewer');
    assert.equal(run!.agentId, 'review-agent', 'the run continues the retained agent');
    assert.equal(f.sentRuns.some(sent => sent.id === run!.id), true, 'the run was delivered to the retained thread');
    assert.equal(f.createdRuns.length, 0, 'no fresh reviewer agent was created');
    assert.equal(run!.head, f.heads.newHead, 'the retained reviewer reads the new head');
    assert.equal(run!.priorRunId, 'prior-review-run', 'the round continues the prior review');
    assert.equal(run!.retainedRounds, 1, 'the same reviewer advances its retained round');
    assert.match(run!.reviewDelta ?? '', /Earlier finding: the gate misses the empty case/);
    assert.equal(f.current().resolution.reviewerAgentId, 'review-agent');
  } finally { await f.close(); }
});

test('move to=review with fresh: true starts a new reviewer', async () => {
  const f = fixture();
  try {
    responsibleShape(f);
    priorReviewerRound(f);
    const moved = await moveReview(f, { fresh: true }) as Task;
    assert.equal(moved.phase, 'awaiting_review');
    assert.equal(moved.prHead, f.heads.newHead);
    assert.equal(moved.resolution.reviewerAgentId, null, 'fresh review clears the retained reviewer');
    assert.equal(moved.resolution.reviewerProfile, null);
    await f.engine.wake();
    const run = f.dispatched();
    assert.ok(run, `a reviewer run was dispatched: ${f.current().reason}`);
    assert.equal(run!.role, 'reviewer');
    assert.notEqual(run!.agentId, 'review-agent', 'fresh starts a new reviewer agent, not the retained one');
    assert.equal(f.createdRuns.some(created => created.id === run!.id), true, 'the run created a new agent');
    assert.equal(f.sentRuns.length, 0, 'the retained thread was not reused');
    assert.equal(run!.head, f.heads.newHead);
    assert.equal(f.current().resolution.reviewerAgentId, run!.agentId, 'the new agent is the recorded reviewer');
  } finally { await f.close(); }
});

test('move to=review with a closed retained reviewer starts a fresh one', async () => {
  const f = fixture();
  try {
    responsibleShape(f);
    priorReviewerRound(f, { status: 'superseded', completion: null, retainedAgentClosedAt: new Date().toISOString() });
    const moved = await moveReview(f) as Task;
    assert.equal(moved.resolution.reviewerAgentId, null, 'a closed reviewer cannot continue');
    assert.equal(moved.resolution.reviewerProfile, null);
    await f.engine.wake();
    const run = f.dispatched();
    assert.ok(run, `a reviewer run was dispatched: ${f.current().reason}`);
    assert.notEqual(run!.agentId, 'review-agent', 'the closed agent is not reused');
    assert.equal(f.createdRuns.some(created => created.id === run!.id), true, 'a new agent was created');
    assert.equal(f.sentRuns.length, 0, 'the closed thread received no send');
  } finally { await f.close(); }
});

test('next names the retained reviewer the move will use', async () => {
  const f = fixture();
  try {
    responsibleShape(f);
    const review = f.next().verbs.find(view => view.verb === 'move' && (view.args as Record<string, unknown> | undefined)?.to === 'review');
    assert.equal(review?.available, true, `move to review is offered: ${JSON.stringify(review)}`);
    assert.match(review?.note ?? '', /review-agent/, 'the note names the retained reviewer');
    assert.match(review?.note ?? '', /fresh: true/, 'the note names the fresh escape hatch');
  } finally { await f.close(); }
});

test('next says fresh when the retained reviewer is closed', async () => {
  const f = fixture();
  try {
    responsibleShape(f);
    f.store.putRun(runSchema.parse({
      id: 'review-closed', taskId: f.taskId, role: 'reviewer', generation: 1, head: f.heads.oldHead,
      base: f.heads.base, agentId: 'review-agent', workspaceId: 'workspace', profile: f.profiles.reviewer,
      status: 'superseded', createdAt: new Date().toISOString(), lastObservedAt: null, active: false,
      idleSince: null, released: true, completion: null, retainedAgentClosedAt: new Date().toISOString(),
    }));
    const review = f.next().verbs.find(view => view.verb === 'move' && (view.args as Record<string, unknown> | undefined)?.to === 'review');
    assert.equal(review?.available, true, `move to review is offered: ${JSON.stringify(review)}`);
    assert.match(review?.note ?? '', /fresh/i, 'the note says the move starts a fresh reviewer');
  } finally { await f.close(); }
});

test('a null prHead with an authenticated pushed head in the report is resolved before review', async () => {
  const f = fixture();
  try {
    const completion = {
      taskId: f.taskId, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review' as const,
      summary: 'Pushed the revision', prNumber: PR, head: f.heads.newHead,
    };
    f.store.update(f.taskId, {
      responsible: true,
      phase: 'awaiting_review', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace',
      directory: f.worktree, profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      branch: 'feature/retained', completion,
    });
    f.setResolution({ reviewerAgentId: 'review-agent', reviewerProfile: f.profiles.reviewer });
    // The receipt authenticates the stored completion form (the store normalizes
    // key order), exactly as the report path records it.
    const stored = f.current().completion!;
    f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)')
      .run(stored.eventId, f.taskId, stored.runId, digest(JSON.stringify(stored)), JSON.stringify({ accepted: true }));
    await f.engine.resolution.launch(f.current(), 'reviewer');
    const after = f.current();
    assert.equal(after.prHead, f.heads.newHead, 'the reported head binds before review');
    assert.equal(after.prUrl, PR_URL);
    assert.equal(after.resumePrNumber, PR);
    const run = f.store.runs(f.taskId).find(item => item.role === 'reviewer' && !item.released);
    assert.ok(run, 'a reviewer run dispatched');
    assert.equal(run!.head, f.heads.newHead, 'the reviewer has the bound head to review');
    assert.equal(f.createdRuns.some(created => created.id === run!.id), true, 'the reviewer run created its agent');
  } finally { await f.close(); }
});
