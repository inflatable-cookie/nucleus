import { fakeAdapter, profile } from './support/fakes';
import { waitFor } from './support/budgets';
import { holdLifecycleFollowUps } from './support/hold-lifecycle-follow-ups';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { ForeignPrIdentity } from '../core/forge/index';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { runPrompt } from '../core/dispatch/prompts';
import { runSchema, submissionSchema, taskControlInputSchema, taskNextSchema, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';

/**
 * Project-D #117, papercut 641a958a (Tom, 2026-10-23: "Fix Project-D
 * (Recommended)"). A PR the task knows only from a reported completion is an
 * identity candidate: a continuation on it binds it through the existing
 * verification or refuses, and `move to=review` binds the PR the current
 * authenticated ready result names at the exact remote head, in one mutation
 * with the review entry.
 */

const base = 'b'.repeat(40), oldHead = 'c'.repeat(40), readyHead = 'd'.repeat(40), otherHead = 'e'.repeat(40);
const CALLER = 'owner-thread';
const PR = 201, PR_URL = 'https://github.com/example/repo/pull/201';



type FakePr = { url: string; head: string; state: 'open' | 'closed'; draft: boolean; branch: string; base: string; onOrigin: boolean; headRepository: string | null };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-continued-pr-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const worker = profile('worker', 'test/worker'), reviewer = profile('reviewer', 'test/reviewer'), coord = profile('coord', 'test/coord');
  const all = [worker, reviewer, coord];
  store.setMeta('pool', all.map(item => ({ profileId: item.id, enabled: true, group: item.id, roles: [item.id === 'reviewer' ? 'reviewer' : item.id === 'coord' ? 'coordinator' : 'worker'], weight: 1, scopes: ['general'] })));
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Bind the continued PR', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const current = () => store.task(submitted.id);
  const observations = new Map<string, { id: string; workspaceId: string | null; status: string; active: boolean; permissions: boolean; error: string; provider?: string; model?: string }>();
  const idle = (id: string, model?: string) => observations.set(id, { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model });
  idle('worker-agent', worker.model); idle('review-agent', reviewer.model); idle('coord-agent', coord.model);
  // The forge: PR 201 on the task's own branch and base, open, ready, its head on origin.
  const prs = new Map<number, FakePr>();
  prs.set(PR, { url: PR_URL, head: readyHead, state: 'open', draft: false, branch: current().branch, base: current().baseBranch, onOrigin: true, headRepository: 'example/repo' });
  const prFor = (t: Task, n: number, allowDraft: boolean) => {
    const pr = prs.get(n);
    if (pr && pr.branch !== t.branch) throw new ForeignPrIdentity("PR must be open, ready, and match the task's branch and base");
    if (!pr || pr.state !== 'open' || (!allowDraft && pr.draft) || pr.base !== t.baseBranch)
      throw new Error("PR must be open, ready, and match the task's branch and base");
    return { url: pr.url, head: pr.head, repository: 'example/repo', headRepository: pr.headRepository };
  };
  /** Test seams: run during PR verification and during an owner-verb turn cancellation. */
  const hooks: { onVerify?: () => void; onStop?: (agentId: string) => void } = {};
  const createdRuns: Run[] = [];
  const tokens = new Map<string, string>();
  const adapter = fakeAdapter({
    profiles: async () => all, validate: async () => base, verifyWorkspace: async () => {},
    createWorkspace: async () => { throw new Error('no workspaces here'); },
    createAgent: async () => { throw new Error('no fresh workers here'); }, findRunAgents: async () => [],
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' },
     notify: async () => {},
    verifyPr: async (t: Task, n: number) => prFor(t, n, false),
    verifyPrIdentity: async (t: Task, n: number, options?: { allowDraft?: boolean }) => { const pr = prFor(t, n, options?.allowDraft === true); hooks.onVerify?.(); return pr; },
    verifyResume: async () => {},
    // The published clean source proof: the PR head is the origin branch head and the retained worktree HEAD.
    verifyInspectedRevisionHead: async (_t: Task, n: number, expected: string) => {
      const pr = prs.get(n);
      if (!pr?.onOrigin || pr.head !== expected) throw new Error(`Inspected PR head ${expected} does not match the observed worktree, remote and PR heads`);
    },
    verifyCleanQueueWorktree: async () => {}, verifyReview: async () => 12345, publishReview: async () => 12345,
    mergeGate: async () => ({ head: readyHead, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head: readyHead, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {},
    createRun: async (_t: Task, r: Run, token: string) => { createdRuns.push(r); tokens.set(r.id, token); return { id: `agent-${r.id}`, workspaceId: r.workspaceId }; },
    sendRun: async (_t: Task, r: Run, token: string) => { createdRuns.push(r); tokens.set(r.id, token); },
    stopAgentTurn: async (agentId: string) => { hooks.onStop?.(agentId); },
  } as unknown as Adapter);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = all;
  const control = (args: Record<string, unknown>) => engine.performTaskControl(taskControlInputSchema.parse({
    taskId: submitted.id, version: current().version, reason: 'Owner continuation', caller: CALLER, ...args,
  }));
  const events = (kind: string) => store.eventsAll(submitted.id).filter(event => event.kind === kind);
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, current())));
  /** What a refusal must leave untouched: the task row and every run. */
  const snapshot = () => JSON.stringify({ task: current(), runs: store.runs(submitted.id) });
  return {
    store, engine, taskId: submitted.id, profiles: { worker, reviewer }, current, control, events, next, snapshot, prs, observations, createdRuns, tokens, hooks,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
type Fixture = ReturnType<typeof fixture>;

/** The worker blocked and named PR 201; Queue never bound it (no prUrl, resumePrNumber or prHead). */
function blockedNamingPr(f: Fixture) {
  f.store.update(f.taskId, {
    phase: 'blocked', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
    profile: f.profiles.worker, workerModel: f.profiles.worker.model,
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-blocked', status: 'blocked', summary: 'Blocked on a ruling', prNumber: PR, head: oldHead },
  });
}

const revisionRun = (f: Fixture, id: string, completion: Run['completion'], extra: Partial<Run> = {}): Run => runSchema.parse({
  id, taskId: f.taskId, role: 'revision', generation: 1, head: oldHead, base, agentId: 'worker-agent', workspaceId: 'workspace',
  profile: f.profiles.worker, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null,
  released: true, completion, ...extra,
});
const ready = (f: Fixture, runId: string, prNumber = PR, reportedHead = readyHead) =>
  ({ taskId: f.taskId, runId, eventId: `${runId}-ready`, status: 'ready_for_review' as const, summary: 'Ready', prNumber, head: reportedHead });

/**
 * Project-D #117 as it stands: changes_requested, no bound PR, prHead from the
 * revision launch, the worker's blocked report naming PR 201, and the
 * revision released ready on PR 201 at a newer head.
 */
function projectDShape(f: Fixture) {
  blockedNamingPr(f);
  f.store.update(f.taskId, { phase: 'changes_requested', prHead: oldHead, reason: 'Revision result could not be applied' });
  f.store.putRun(revisionRun(f, 'rev-1', ready(f, 'rev-1')));
}

const moveReview = (f: Fixture, extra: Record<string, unknown> = { prNumber: PR }) =>
  f.control({ action: 'move', to: 'review', reason: 'Bind the PR the revision reported and review it', ...extra });

const assertNothingBound = (f: Fixture, before: string, label: string) => {
  assert.equal(f.snapshot(), before, `${label}: the task and its runs are unchanged`);
  assert.equal(f.current().prUrl, null, `${label}: no PR is bound`);
  assert.equal(f.events('continued_pr_bound').length + f.events('move_review_pr_bound').length, 0, `${label}: no binding event`);
};

// (a) Bind or refuse at continuation.

test('Project-D #117, #612 route: restart role=worker on a blocked report naming an unbound PR binds it with the continuation, and the revision dispatches on it', async () => {
  const f = fixture(); try {
    blockedNamingPr(f);
    const task = await f.control({ action: 'restart', role: 'worker', instruction: 'Continue on the PR you opened' });
    assert.equal(task.phase, 'changes_requested');
    assert.equal(task.prUrl, PR_URL, 'the PR identity is bound in the accepted transition');
    assert.equal(task.resumePrNumber, PR);
    assert.equal(task.prHead, readyHead, 'at the head the verification observed');
    assert.equal(task.completion?.status, 'blocked', 'the blocked report stays evidence; it is not rewritten');
    const bound = f.events('continued_pr_bound');
    assert.equal(bound.length, 1);
    assert.match(bound[0]!.detail, /^move work: .*PR #201 at d{40}, known only from the blocked report worker-blocked/);
    await f.engine.wake();
    const revision = f.createdRuns.findLast(run => run.role === 'revision');
    assert.ok(revision, 'the revision dispatched');
    assert.equal(revision!.head, readyHead);
    assert.equal(f.events('continued_pr_bound').length, 1, 'the dispatch finds the PR bound and binds nothing again');
    const release = holdLifecycleFollowUps(f.engine);
    await f.engine.complete({ eventId: randomUUID(), taskId: f.taskId, runId: revision!.id, status: 'ready_for_review', summary: 'Ready', head: readyHead, prNumber: PR }, f.tokens.get(revision!.id)!);
    await waitFor(() => f.current().phase !== 'changes_requested', 10_000, 'revision to enter review');
    assert.equal(f.current().phase, 'awaiting_review', 'the ready revision enters review on the bound PR');
    release();
  } finally { await f.close(); }
});

for (const [label, change] of [
  ['closed', (pr: FakePr) => { pr.state = 'closed'; }],
  ['against another base', (pr: FakePr) => { pr.base = 'release'; }],
] as const) {
  test(`Project-D #117, #612 route: restart role=worker refuses and writes nothing when the reported PR is ${label}`, async () => {
    const f = fixture(); try {
      blockedNamingPr(f);
      change(f.prs.get(PR)!);
      const before = f.snapshot();
      await assert.rejects(f.control({ action: 'restart', role: 'worker', instruction: 'Continue' }),
        /Move to work cannot bind PR #201, which the task knows only from its blocked report: PR must be open, ready, and match the task's branch and base\. Nothing was written/);
      assertNothingBound(f, before, label);
      assert.equal(f.createdRuns.length, 0, 'nothing dispatched');
    } finally { await f.close(); }
  });
}

test('Project-D #117: the revision dispatch binds an unbound reported PR in the run reservation (restart without a role)', async () => {
  const f = fixture(); try {
    blockedNamingPr(f);
    const task = await f.control({ action: 'restart' });
    assert.equal(task.phase, 'changes_requested', 'the worker-blocked report routes back to its worker');
    assert.equal(task.prUrl, null, 'nothing is bound until the dispatch verifies the PR');
    await f.engine.wake();
    const revision = f.createdRuns.findLast(run => run.role === 'revision');
    assert.ok(revision, 'the revision dispatched');
    const after = f.current();
    assert.equal(after.resolution.currentRunId, revision!.id);
    assert.equal(after.prUrl, PR_URL);
    assert.equal(after.resumePrNumber, PR);
    assert.equal(after.prHead, readyHead);
    assert.equal(revision!.head, readyHead, 'the run carries the head bound with it');
    assert.match(f.events('continued_pr_bound')[0]!.detail, new RegExp(`^revision dispatch ${revision!.id}: PR #201 at d{40}`));
    assert.equal(f.events('revision_head').length, 0, 'the head is written with the binding, not separately');
  } finally { await f.close(); }
});

test('Project-D #117: a revision dispatch whose reported PR fails verification binds nothing and dispatches nothing', async () => {
  const f = fixture(); try {
    blockedNamingPr(f);
    await f.control({ action: 'restart' });
    f.prs.get(PR)!.state = 'closed';
    await f.engine.wake();
    const after = f.current();
    assert.equal(f.createdRuns.length, 0, 'no revision run was sent');
    assert.equal(f.store.runs(f.taskId).length, 0, 'no run was reserved');
    assert.equal(after.prUrl, null);
    assert.equal(after.resumePrNumber, null);
    assert.equal(after.prHead, null);
    assert.equal(f.events('continued_pr_bound').length, 0);
  } finally { await f.close(); }
});

// (b) move to=review binds the PR the current ready result names.

test('Project-D #117, already stuck: move to=review with the reported PR binds it and enters review in one mutation', async () => {
  const f = fixture(); try {
    projectDShape(f);
    const review = f.next().verbs.find(view => view.verb === 'move' && (view.args as Record<string, unknown> | undefined)?.to === 'review');
    assert.equal(review?.available, true, `next offers the move: ${JSON.stringify(review)}`);
    const versionBefore = f.current().version;
    const task = await moveReview(f);
    assert.equal(task.phase, 'awaiting_review');
    assert.equal(task.prUrl, PR_URL);
    assert.equal(task.resumePrNumber, PR);
    assert.equal(task.prHead, readyHead, 'the exact reported and remote head');
    assert.equal(task.resolution.review, null, 'no review credit: a fresh reviewer judges the head');
    assert.equal(task.version, versionBefore + 1, 'binding and review entry are one task write');
    const moved = f.events('move_review_requested');
    assert.equal(moved.length, 1);
    assert.deepEqual(JSON.parse(moved[0]!.detail).boundPr, { prNumber: PR, head: readyHead, runId: 'rev-1', eventId: 'rev-1-ready' });
    assert.match(f.events('move_review_pr_bound')[0]!.detail, /^PR #201 at d{40} from the ready result rev-1-ready of run rev-1/);
  } finally { await f.close(); }
});

test('Project-D #117: move to=review without a number binds the PR the ready result names', async () => {
  const f = fixture(); try {
    projectDShape(f);
    const task = await moveReview(f, {});
    assert.equal(task.phase, 'awaiting_review');
    assert.equal(task.resumePrNumber, PR);
  } finally { await f.close(); }
});

test('Project-D #117: the worker\'s own ready result, with no revision, is the current one', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'needs_attention', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
      profile: f.profiles.worker, workerModel: f.profiles.worker.model, reason: 'PR must be open, ready, and match the task\'s branch and base',
      completion: ready(f, 'worker-run'),
    });
    const task = await moveReview(f);
    assert.equal(task.phase, 'awaiting_review');
    assert.equal(task.prUrl, PR_URL);
  } finally { await f.close(); }
});

// With no current ready result, a number selects replacement adoption and no number finds no task PR; both refuse.
const superseded = /Replacement PR adoption requires an active PR identity repair|Move to review needs a task PR/;
const refusals: [string, (f: Fixture) => void, RegExp, Record<string, unknown>?][] = [
  ['a different PR number selects replacement adoption, which refuses', () => {}, /Replacement PR adoption requires/, { prNumber: 202 }],
  ['the remote head moved past the reported head', f => { f.prs.get(PR)!.head = otherHead; }, /PR #201 is at e{40}, not the head d{40} its current ready result reports; nothing was bound/],
  ['a later blocked revision supersedes the ready one', f => {
    f.store.putRun(revisionRun(f, 'rev-2', { taskId: f.taskId, runId: 'rev-2', eventId: 'rev-2-blocked', status: 'blocked', summary: 'Blocked again', prNumber: PR, head: readyHead }));
  }, superseded],
  ['a later errored revision supersedes the ready one', f => {
    f.store.putRun(revisionRun(f, 'rev-2', { taskId: f.taskId, runId: 'rev-2', eventId: 'rev-2-error', status: 'error', summary: 'Crashed' }));
  }, superseded],
  ['a newer revision without a result supersedes the ready one', f => {
    f.store.putRun(revisionRun(f, 'rev-2', null, { status: 'superseded' }));
  }, superseded],
  ['a newer ready revision names another head than the remote one', f => {
    f.store.putRun(revisionRun(f, 'rev-2', ready(f, 'rev-2', PR, otherHead)));
  }, /PR #201 is at d{40}, not the head e{40} its current ready result reports/],
  ['the ready revision is unreleased', f => {
    f.store.putRun({ ...f.store.run('rev-1')!, released: false });
  }, superseded],
  ['the ready revision was run by another worker', f => {
    f.store.putRun({ ...f.store.run('rev-1')!, agentId: 'retired-agent' });
  }, superseded],
  ['merge intent is recorded', f => {
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, mergeIntent: true, mergeHead: readyHead } });
  }, /Move to review needs an unmerged task before merge intent/],
  ['the PR is on a foreign branch', f => { f.prs.get(PR)!.branch = 'someone-else'; }, /PR must be open, ready, and match the task's branch and base/],
  ['the PR head is not on the canonical origin branch (a fork)', f => { f.prs.get(PR)!.onOrigin = false; }, /Inspected PR head d{40} does not match/],
  ['the PR is a draft', f => { f.prs.get(PR)!.draft = true; }, /PR must be open, ready/],
  ['the PR is closed', f => { f.prs.get(PR)!.state = 'closed'; }, /PR must be open, ready/],
  ['the retained worker is live', f => {
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
  }, /requires the retained workers to be observably inactive/],
  ['a run delivery is unknown', f => {
    f.store.putRun(runSchema.parse({ id: 'review-uncertain', taskId: f.taskId, role: 'reviewer', generation: 1, head: readyHead, base, agentId: 'review-agent',
      workspaceId: 'workspace', profile: f.profiles.reviewer, status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null, active: null,
      idleSince: null, released: false, completion: null }));
  }, /uncertain delivery|delivery is unknown/],
];

for (const [label, arrange, refusal, args] of refusals) {
  test(`Project-D #117: move to=review refuses and writes nothing when ${label}`, async () => {
    const f = fixture(); try {
      projectDShape(f);
      arrange(f);
      const before = f.snapshot();
      await assert.rejects(moveReview(f, args), refusal);
      assertNothingBound(f, before, label);
      if (!args) {
        await assert.rejects(moveReview(f, {}), refusal, 'and without a number');
        assertNothingBound(f, before, `${label}, without a number`);
      }
    } finally { await f.close(); }
  });
}

// Sol's review of #620 at 7933a14e: each finding as a deterministic regression.

const forkRefusal = /PR #201 comes from someone\/repo, not the canonical example\/repo; nothing was bound/;

test('#620 review P1: restart role=worker refuses a fork PR with the task branch name and writes nothing', async () => {
  const f = fixture(); try {
    blockedNamingPr(f);
    f.prs.get(PR)!.headRepository = 'someone/repo';
    const before = f.snapshot();
    await assert.rejects(f.control({ action: 'restart', role: 'worker', instruction: 'Continue' }), forkRefusal);
    assertNothingBound(f, before, 'fork at the verb');
    assert.equal(f.createdRuns.length, 0);
  } finally { await f.close(); }
});

test('#620 review P1: a deleted fork (no head repository) is refused at the verb too', async () => {
  const f = fixture(); try {
    blockedNamingPr(f);
    f.prs.get(PR)!.headRepository = null;
    const before = f.snapshot();
    await assert.rejects(f.control({ action: 'restart', role: 'worker', instruction: 'Continue' }), /comes from an unknown or deleted repository/);
    assertNothingBound(f, before, 'deleted fork');
  } finally { await f.close(); }
});

test('#620 review P1: the revision dispatch refuses a fork PR with the task branch name, binding and reserving nothing', async () => {
  const f = fixture(); try {
    blockedNamingPr(f);
    await f.control({ action: 'restart' });
    f.prs.get(PR)!.headRepository = 'someone/repo';
    await f.engine.wake();
    const after = f.current();
    assert.equal(f.store.runs(f.taskId).length, 0, 'no run was reserved');
    assert.equal(f.createdRuns.length, 0);
    assert.equal(after.prUrl, null);
    assert.equal(after.resumePrNumber, null);
    assert.equal(f.events('continued_pr_bound').length, 0);
  } finally { await f.close(); }
});

test('#620 review P1: move to=review refuses a fork PR whose head also sits on origin, and writes nothing', async () => {
  const f = fixture(); try {
    projectDShape(f);
    f.prs.get(PR)!.headRepository = 'someone/repo';
    const before = f.snapshot();
    await assert.rejects(moveReview(f), forkRefusal);
    assertNothingBound(f, before, 'fork at move review');
  } finally { await f.close(); }
});

test('#620 review P1: the canonical repository compares case-insensitively', async () => {
  const f = fixture(); try {
    projectDShape(f);
    f.prs.get(PR)!.headRepository = 'Example/Repo';
    assert.equal((await moveReview(f)).phase, 'awaiting_review');
  } finally { await f.close(); }
});

test('#620 review P2: an instruction changed during the dispatch verification binds and reserves nothing, and the newer instruction is kept', async () => {
  const f = fixture(); try {
    blockedNamingPr(f);
    f.store.update(f.taskId, { phase: 'changes_requested', reason: 'Retry requested after resolving the blocker',
      resolution: { ...f.current().resolution, pendingWorkerInstruction: 'Original instruction' } });
    f.hooks.onVerify = () => {
      f.hooks.onVerify = undefined;
      f.store.update(f.taskId, { resolution: { ...f.current().resolution, pendingWorkerInstruction: 'Newer instruction' } }, 'owner_instruction_changed');
    };
    await f.engine.resolution.advance(f.current());
    const after = f.current();
    assert.equal(f.store.runs(f.taskId).length, 0, 'no run was reserved');
    assert.equal(f.createdRuns.length, 0, 'nothing was sent');
    assert.equal(after.prUrl, null, 'nothing was bound');
    assert.equal(after.resumePrNumber, null);
    assert.equal(after.resolution.pendingWorkerInstruction, 'Newer instruction', 'the newer instruction is kept');
    assert.equal(f.events('continued_pr_bound').length, 0);
  } finally { await f.close(); }
});

test('#620 review P2: a retained worker that starts during the reviewer cancel refuses move to=review with nothing bound', async () => {
  const f = fixture(); try {
    projectDShape(f);
    f.store.putRun(runSchema.parse({ id: 'review-live', taskId: f.taskId, role: 'reviewer', generation: 1, head: readyHead, base, agentId: 'review-agent',
      workspaceId: 'workspace', profile: f.profiles.reviewer, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true,
      idleSince: null, released: false, completion: null }));
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    f.hooks.onStop = agentId => {
      if (agentId !== 'review-agent') return;
      f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
      f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    };
    await assert.rejects(moveReview(f), /requires the retained workers to be observably inactive/);
    const after = f.current();
    assert.equal(f.events('owner_stop_sent').length >= 1, true, 'the reviewer turn was cancelled first');
    assert.equal(after.phase, 'changes_requested');
    assert.equal(after.prUrl, null);
    assert.equal(after.resumePrNumber, null);
    assert.equal(f.events('move_review_pr_bound').length, 0);
  } finally { await f.close(); }
});

test('#620 final review: a remote head that moves during the last worker observation refuses move to=review with nothing bound', async () => {
  const f = fixture(); try {
    projectDShape(f);
    // After the clean-source re-proof, the next retained-worker observation is slow and the PR head moves meanwhile.
    const adapter = (f.engine as unknown as { adapter: Adapter }).adapter as unknown as { verifyResume: () => Promise<void>; observe: (id: string) => Promise<unknown> };
    const resume = adapter.verifyResume, observe = adapter.observe;
    // Armed by the post-cancel re-proof (the second clean-source check), so the head moves inside Sol's window.
    let armed = false, resumes = 0;
    adapter.verifyResume = async () => { await resume(); if (++resumes === 2) armed = true; };
    adapter.observe = async (id: string) => {
      const state = await observe(id);
      if (armed && id === 'worker-agent') { f.prs.get(PR)!.head = 'e'.repeat(40); armed = false; }
      return state;
    };
    await assert.rejects(moveReview(f), /does not match the observed worktree, remote and PR heads/);
    const after = f.current();
    assert.equal(after.phase, 'changes_requested');
    assert.equal(after.prUrl, null);
    assert.equal(after.resumePrNumber, null);
    assert.equal(f.events('move_review_pr_bound').length, 0);
  } finally { await f.close(); }
});

/**
 * Queue #392 (Tom, 2026-10-24): a discovered PR is identity, never readiness, so
 * a blocked or errored report stays the task's block and the owner's explicit
 * continuation carries it into the next turn. These tests start from the state
 * the branch-PR discovery now leaves — the report plus PR identity, nothing
 * else — and hold the continuation that follows it.
 */

/** The state the branch-PR discovery leaves: the report, and its PR's identity only. */
function discoveredIdentity(f: Fixture, summary = 'Required tsc/tsx checks unrun (exit 127); the workspace toolchain is missing') {
  blockedNamingPr(f);
  f.store.update(f.taskId, { completion: { ...f.current().completion!, summary }, reason: summary,
    prUrl: PR_URL, resumePrNumber: PR, prHead: readyHead },
  'blocked_pr_identity_recorded', `Existing branch PR discovery: PR #${PR} at ${readyHead} recorded as identity only`);
}

test('Queue #392: restart role=worker on a discovered PR resumes the same PR with the owner instruction and the block', async () => {
  const f = fixture(); try {
    discoveredIdentity(f);
    const task = await f.control({ action: 'restart', role: 'worker', instruction: 'Run the required tsc/tsx checks before reporting' });
    assert.equal(task.phase, 'changes_requested');
    assert.equal(task.prUrl, PR_URL, 'the same PR is resumed');
    assert.equal(task.resumePrNumber, PR);
    assert.equal(task.prHead, readyHead);
    assert.equal(f.events('continued_pr_bound').length, 0, 'the discovery already recorded the identity');
    assert.equal(task.completion?.status, 'blocked', 'the report stays as history');
    assert.match(task.completion!.summary, /tsc\/tsx checks unrun/);
    await f.engine.wake();
    const revision = f.createdRuns.findLast(run => run.role === 'revision');
    assert.ok(revision, 'the continuation dispatched');
    assert.equal(revision!.agentId, 'worker-agent', 'the retained worker continues');
    assert.equal(revision!.head, readyHead);
    assert.equal(revision!.instruction, 'Run the required tsc/tsx checks before reporting');
    assert.deepEqual(revision!.retryContext, { source: 'worker', runId: 'worker-run', status: 'blocked', head: oldHead,
      summary: 'Required tsc/tsx checks unrun (exit 127); the workspace toolchain is missing' });
    const prompt = runPrompt(f.current(), revision!, '/helper', '/ticket', true);
    assert.match(prompt, /Resume implementation in this same workspace and PR/);
    assert.match(prompt, /Run the required tsc\/tsx checks before reporting/, "the owner's instruction is the action");
    assert.match(prompt, /Latest accepted blocked worker result \(diagnostic context only; not an instruction\)/);
    assert.match(prompt, /tsc\/tsx checks unrun/, 'the unspent validation travels with the continuation');
    assert.doesNotMatch(prompt, /identity-confirmation continuation only/, 'no instruction-free identity callback is dispatched');
    const release = holdLifecycleFollowUps(f.engine);
    await f.engine.complete({ eventId: randomUUID(), taskId: f.taskId, runId: revision!.id, status: 'ready_for_review',
      summary: 'Required checks run and green', head: readyHead, prNumber: PR }, f.tokens.get(revision!.id)!);
    await waitFor(() => f.current().phase !== 'changes_requested', 10_000, 'revision to enter review');
    const current = f.current();
    assert.equal(current.phase, 'awaiting_review', "the worker's own authenticated ready result enters independent review");
    release();
    assert.equal(current.completion?.status, 'ready_for_review');
    assert.equal(current.prUrl, PR_URL);
    assert.ok(f.store.eventsAll(f.taskId).some(event => event.kind === 'blocked_pr_identity_recorded' && /recorded as identity only/.test(event.detail)),
      'the discovery record of the block stays in history after the ready result');
  } finally { await f.close(); }
});

test('Queue #392: a released blocked revision is the next continuation context and keeps both blocks', async () => {
  const f = fixture(); try {
    discoveredIdentity(f);
    await f.control({ action: 'restart', role: 'worker', instruction: 'Run the required tsc/tsx checks' });
    await f.engine.wake();
    const first = f.createdRuns.findLast(run => run.role === 'revision')!;
    await f.engine.complete({ eventId: randomUUID(), taskId: f.taskId, runId: first.id, status: 'blocked',
      summary: 'Toolchain still missing (exit 127)', head: readyHead, prNumber: PR }, f.tokens.get(first.id)!);
    await f.engine.wake();
    assert.equal(f.current().phase, 'blocked', 'the revision block keeps the task blocked');
    assert.equal(f.store.run(first.id)?.released, true, 'the blocked revision is released, not live');
    const second = await f.control({ action: 'restart', role: 'worker', instruction: 'Install the workspace toolchain, then run the required checks' });
    assert.equal(second.phase, 'changes_requested');
    assert.equal(second.prUrl, PR_URL, 'the same PR is resumed again');
    assert.equal(second.completion?.status, 'blocked', 'the original worker report stays the recorded report');
    assert.match(second.completion!.summary, /tsc\/tsx checks unrun/);
    await f.engine.wake();
    const next = f.createdRuns.findLast(run => run.role === 'revision')!;
    assert.notEqual(next.id, first.id);
    assert.equal(next.instruction, 'Install the workspace toolchain, then run the required checks');
    assert.deepEqual(next.retryContext, { source: 'revision', runId: first.id, status: 'blocked', head: readyHead,
      summary: 'Toolchain still missing (exit 127)' }, 'the latest authenticated block is the context');
    assert.equal(f.store.run(first.id)?.completion?.summary, 'Toolchain still missing (exit 127)', 'the released revision keeps its own report');
  } finally { await f.close(); }
});


test('move to work clears a proven foreign unbound completion and retains its receipt as history', async () => {
 const f=fixture(); try {
  blockedNamingPr(f); f.prs.get(PR)!.branch='another-branch';
  const task=await f.control({action:'move',to:'work',instruction:'Continue on the task branch'});
  assert.equal(task.completion,null); assert.equal(task.prUrl,null);
  assert.equal(f.events('foreign_completion_cleared').length,1);
  assert.match(f.events('foreign_completion_cleared')[0]!.detail,/worker-blocked/);
 } finally {await f.close();}
});
