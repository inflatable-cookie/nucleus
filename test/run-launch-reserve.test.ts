import { fakeAdapter, profile } from './support/fakes';
/**
 * Row X5c send-boundary pin: a throw at each post-reservation effect leaves
 * the run_intent record. The reservation transaction writes the intent, the
 * credential and the slot charge before deliver sends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const prUrl = 'https://github.com/example/repo/pull/1';


function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'run-launch-reserve-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const worker = profile('author'), reviewer = profile('reviewer');
  store.setMeta('paused', false);
  store.putRepository({ origin: null, path: '/repo' }, 'agent', 'fixture keeps agent closeout');
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'], capability: 'medium', cost: 'low' },
    { profileId: reviewer.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'], capability: 'medium', cost: 'medium' },
  ]);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const task = store.update(submitted.id, {
    phase: 'awaiting_review', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker', runId: 'initial', profile: worker, workerModel: worker.model, prHead: head, prUrl,
    agentActive: false, lastAgentStatus: 'idle', lastObservedAt: new Date().toISOString(),
    completion: { taskId: submitted.id, runId: 'initial', eventId: 'initial-result', status: 'ready_for_review', summary: 'Ready', prNumber: 1 },
  });
  const states = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = 'workspace') => states.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  idle('worker');
  const tokens = new Map<string, string>();
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => [worker, reviewer], validate: async () => base, verifyWorkspace: async t => t.branch,
    createWorkspace: async () => { throw new Error('Review must not create workspaces'); },
    createAgent: async () => { throw new Error('No initial dispatch'); },
    observe: async id => { const state = states.get(id); if (!state) throw new Error('Agent missing'); return state; },
     stopAgentTurn: async () => {},
    agentTimelinePage: async () => ({ entries: [], hasOlder: false, hasNewer: false, gap: false, staleCursor: false, reset: false, epoch: 'fixture', projection: 'projected', startCursor: null, endCursor: null }),
    verifyPr: async () => ({ head, url: prUrl }), verifyPrIdentity: async () => ({ head, url: prUrl }),
    verifyCleanQueueWorktree: async () => {}, coveringEvidence: async () => ({ head, base, wait: '' }),
    authorCommentEvidence: async () => '',
    createRun: async (_t, run, token) => {
      tokens.set(run.id, token);
      const id = `agent-${run.id}`;
      states.set(id, { id, workspaceId: run.workspaceId, status: 'running', active: true, permissions: false, error: '' });
      return { id, workspaceId: run.workspaceId };
    },
    sendRun: async (_t, run, token) => { tokens.set(run.id, token); },
    findRunAgents: async () => [], verifyReview: async () => {},
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }),
    syncMain: async () => base, verifyCloseout: async () => {}, notify: async () => {},
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker, reviewer];
  return {
    dir, store, engine, adapter, task, worker, reviewer, tokens,
    current: () => store.task(task.id),
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function intentRecord(store: Store, taskId: string) {
  const events = store.eventsAll(taskId).filter(event => event.kind === 'run_intent');
  const run = store.runs(taskId).findLast(item => item.role === 'reviewer') ?? null;
  const credential = run ? store.db.prepare('SELECT hash FROM credentials WHERE run=?').get(run.id) : null;
  return { events, run, credential };
}

test('a throw at deliverLaunchRun after reservation leaves the run_intent record', async () => {
  const f = fixture();
  try {
    f.engine.resolution.deliverLaunchRun = async () => { throw new Error('boom at deliver'); };
    await assert.rejects(() => f.engine.resolution.launch(f.current(), 'reviewer'), /boom at deliver/);
    const { events, run, credential } = intentRecord(f.store, f.task.id);
    assert.equal(events.length, 1);
    assert.equal(run?.status, 'intent');
    assert.equal(run?.released, false);
    assert.ok(credential);
    assert.equal(f.current().resolution.currentRunId, run!.id);
    assert.ok(f.store.counts()['profile:reviewer'] ?? f.store.counts()['review']);
  } finally { await f.close(); }
});

test('a throw at createRun after reservation leaves the run_intent record', async () => {
  const f = fixture();
  try {
    f.adapter.createRun = async () => { throw new Error('boom at createRun'); };
    await assert.rejects(() => f.engine.resolution.launch(f.current(), 'reviewer'), /boom at createRun/);
    const { events, run, credential } = intentRecord(f.store, f.task.id);
    assert.equal(events.length, 1);
    assert.ok(run);
    assert.ok(credential);
    assert.equal(f.current().resolution.currentRunId, run!.id);
  } finally { await f.close(); }
});

test('a throw at purgeReportingFiles after reservation leaves the run_intent and duplicate_run_superseded records', async () => {
  const f = fixture();
  try {
    const orphan: Run = {
      id: 'orphan-reviewer', taskId: f.task.id, role: 'reviewer', generation: 0, head, base,
      agentId: 'reviewer-agent', workspaceId: 'workspace', profile: f.reviewer, status: 'running',
      createdAt: new Date(Date.now() - 2000).toISOString(), lastObservedAt: null, active: true, idleSince: null,
      completion: null, released: false,
    };
    const prior: Run = {
      id: 'prior-reviewer', taskId: f.task.id, role: 'reviewer', generation: 0, head, base,
      agentId: 'reviewer-agent', workspaceId: 'workspace', profile: f.reviewer, status: 'finished',
      createdAt: new Date(Date.now() - 1000).toISOString(), lastObservedAt: null, active: false, idleSince: null,
      completion: { taskId: f.task.id, runId: 'prior-reviewer', eventId: 'prior-review', status: 'changes_required', summary: 'Fix', head, reviewCommentId: 1, reviewResponsibility: 'author' },
      released: true,
    };
    f.store.putRun(orphan);
    f.store.putRun(prior);
    f.store.setCredential('orphan-reviewer', 'orphan-token');
    f.store.update(f.task.id, { resolution: { ...f.current().resolution, reviewerAgentId: 'reviewer-agent', reviewerProfile: f.reviewer } });
    f.adapter.observe = async id => {
      if (id === 'reviewer-agent') return { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: f.reviewer.model };
      if (id === 'worker') return { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: f.worker.model };
      throw new Error('Agent missing');
    };
    f.adapter.purgeReportingFiles = () => { throw new Error('boom at purgeReportingFiles'); };
    f.engine.resolution.deliverLaunchRun = async () => { throw new Error('must not reach deliver'); };
    await assert.rejects(() => f.engine.resolution.launch(f.current(), 'reviewer'), /boom at purgeReportingFiles/);
    const { events, run, credential } = intentRecord(f.store, f.task.id);
    assert.equal(events.length, 1);
    assert.equal(run?.status, 'intent');
    assert.ok(credential);
    assert.equal(f.store.run('orphan-reviewer')?.status, 'superseded');
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'duplicate_run_superseded'));
  } finally { await f.close(); }
});
