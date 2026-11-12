import { fakeAdapter } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { groupIsUnavailable } from '../shared/pool';
import { submissionSchema, type Profile } from '../shared/contracts';
import type { Adapter } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';

/**
 * Task 646: provider rate limits back off and spread launches; a moved-on task
 * never leaves a `Failed` workspace.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const GLM_RATE_LIMIT = 'opencode-go API error (429): {"code":"1302","message":"Rate limit reached for requests"}';

const glm = (id: string, model: string, provider: string): Profile =>
  ({ id, name: id, provider, model, notes: '', available: true, problem: '', supportedThinking: [] });

function fixture(profiles: Profile[], pool: Array<{ profileId: string; group: string }>) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-rate-limit-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('pool', pool.map(entry => ({ ...entry, enabled: true, roles: ['worker'], weight: 1, scopes: ['general'] })));
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Rate limit', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const states = new Map<string, { id: string; workspaceId: string; status: string; active: boolean; permissions: boolean; error: string; updatedAt?: string }>();
  states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
  const created: string[] = [];
  const archived: string[] = [];
  const continuations: string[] = [];
  const adapter = fakeAdapter({
    profiles: async () => profiles,
    validate: async () => base, verifyWorkspace: async (t: { branch: string }) => t.branch, verifyCleanQueueWorktree: async () => {},
    createWorkspace: async (t: { id: string }) => ({ id: 'workspace', directory: '/worktree' }),
    createAgent: async (t: { profile?: { id: string } | null; workspaceId?: string | null }) => {
      const id = `agent-${created.length + 1}`;
      states.set(id, { id, workspaceId: t.workspaceId ?? 'workspace', status: 'running', active: true, permissions: false, error: '' });
      created.push(id);
      return { id, workspaceId: t.workspaceId ?? 'workspace' };
    },
    observe: async (id: string) => {
      const state = states.get(id);
      if (!state) throw new Error('Agent missing');
      return state as never;
    },
    continueWorker: async () => { continuations.push('sent'); },
    archiveAgent: async (id: string) => { archived.push(id); states.delete(id); }, notify: async () => {},
    findRunAgents: async () => [],
    verifyPr: async () => ({ head, url: 'https://github.com/example/repo/pull/1' }),
    verifyPrIdentity: async () => ({ head, url: 'https://github.com/example/repo/pull/1' }),
    verifyResume: async () => {},
    createRun: async () => { throw new Error('no run creation in rate-limit fixtures'); },
    sendRun: async () => {}, verifyReview: async () => {},
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base,
    verifyCloseout: async () => {},
  } as unknown as Adapter & ResolutionAdapter);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = profiles;
  const working = (patch: Record<string, unknown> = {}) => store.update(submitted.id, {
    phase: 'working', reason: 'Working', workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker', runId: 'initial', profile: profiles[0], profileGroup: pool[0]!.group,
    workerModel: profiles[0]!.model, workerModels: [profiles[0]!.model], ...patch,
  });
  return { dir, store, engine, adapter, taskId: submitted.id, working, states, created, archived, continuations,
    current: () => store.task(submitted.id),
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a 429 rate limit schedules a future backoff retry instead of an immediate resume', async () => {
  const author = glm('author', 'glm-5.3-flash', 'zai');
  const f = fixture([author], [{ profileId: 'author', group: 'zai' }]);
  try {
    f.working();
    f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: GLM_RATE_LIMIT, updatedAt: new Date().toISOString() });
    await f.engine.wake();
    const waiting = f.current();
    assert.equal(waiting.transientProviderRetry?.status, 'waiting');
    assert.equal(waiting.transientProviderRetry?.resumes, 0);
    assert.ok(Date.parse(waiting.transientProviderRetry!.retryAt!) > Date.now(), 'the resume waits for its backoff');
    assert.equal(f.continuations.length, 0, 'nothing resumes before the backoff elapses');
    const availability = f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('zai') as { data: string } | undefined;
    assert.ok(availability, 'the rate-limited group is recorded in capacity state');
    const row = JSON.parse(availability.data);
    assert.equal(groupIsUnavailable(row), true, 'new launches avoid the group until its cool-down expires');
    assert.match(row.reason, /Rate limit/);
    // The task keeps working through its provider wait instead of parking failed.
    assert.notEqual(waiting.phase, 'needs_attention');
  } finally { await f.close(); }
});

test('repeated 429s route to another profile at the same capability before any escalation', async () => {
  const author = glm('author', 'glm-5.3-flash', 'zai');
  const sol = glm('sol', 'sol-model', 'other');
  const f = fixture([author, sol], [
    { profileId: 'author', group: 'zai' },
    { profileId: 'sol', group: 'other' },
  ]);
  try {
    f.working();
    (f.adapter as { continueWorker: unknown }).continueWorker = async () => {
      f.continuations.push('sent');
      f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    };
    const reportRateLimited = (n: number) => f.states.set('worker',
      { id: 'worker', workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: `${GLM_RATE_LIMIT} (${n})`, updatedAt: new Date(Date.now() + n * 1000).toISOString() });
    const replaced = () => f.current().profile?.id === 'sol' && f.current().retiredWorkers.length === 1;
    reportRateLimited(1);
    await f.engine.wake();
    for (let attempt = 1; attempt <= 12 && !replaced(); attempt++) {
      const latest = f.current();
      if (latest.transientProviderRetry?.status === 'waiting')
        f.store.update(f.taskId, { transientProviderRetry: { ...latest.transientProviderRetry!, retryAt: '2000-01-01T00:00:00.000Z' } });
      await f.engine.wake();
      if (replaced()) break;
      reportRateLimited(attempt + 1);
      await f.engine.wake();
    }
    const armed = f.current();
    assert.equal(f.continuations.length, 4, 'the backoff schedule runs four same-thread resumes first');
    assert.ok(f.store.eventsAll(f.taskId).some(event => event.kind === 'rate_limit_failover_armed'), 'the failover is armed at the same capability');
    assert.equal(armed.profile?.id, 'sol', 'the replacement runs on another eligible profile');
    assert.equal(armed.retiredWorkers.length, 1, 'the exhausted worker is retired');
    assert.equal(armed.resolution.stop?.reason ?? null, null, 'no operator attention precedes the failover');
    assert.equal(armed.failoverReason, '', 'the armed failover is consumed by the replacement');
    await f.engine.wake();
    const settled = f.current();
    assert.equal(settled.profile?.id, 'sol', 'the replacement stays on the alternate profile');
    assert.equal(settled.retiredWorkers.length, 1);
    assert.ok(!String(settled.reason).includes('operator_needed'), 'escalation never goes to operator-needed first');
  } finally { await f.close(); }
});

test('repeated 429s with no alternate profile escalate to the planner, never operator-needed', async () => {
  const author = glm('author', 'glm-5.3-flash', 'zai');
  const f = fixture([author], [{ profileId: 'author', group: 'zai' }]);
  try {
    f.working();
    (f.adapter as { continueWorker: unknown }).continueWorker = async () => {
      f.continuations.push('sent');
      f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    };
    const reportRateLimited = (n: number) => f.states.set('worker',
      { id: 'worker', workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: `${GLM_RATE_LIMIT} (${n})`, updatedAt: new Date(Date.now() + n * 1000).toISOString() });
    const escalated = () => f.store.eventsAll(f.taskId).some(event => event.kind === 'planner_escalation');
    reportRateLimited(1);
    await f.engine.wake();
    for (let attempt = 1; attempt <= 12 && !escalated(); attempt++) {
      const latest = f.current();
      if (latest.transientProviderRetry?.status === 'waiting')
        f.store.update(f.taskId, { transientProviderRetry: { ...latest.transientProviderRetry!, retryAt: '2000-01-01T00:00:00.000Z' } });
      await f.engine.wake();
      if (escalated()) break;
      reportRateLimited(attempt + 1);
      await f.engine.wake();
    }
    const parked = f.current();
    assert.equal(parked.resolution.stop?.reason, 'escalated', 'the planner owns the no-alternative decision');
    assert.ok(f.store.eventsAll(f.taskId).some(event => event.kind === 'planner_escalation'), 'a planner escalation is recorded');
    assert.ok(!String(parked.reason).toLowerCase().includes('operator needed'), 'never operator-needed first');
  } finally { await f.close(); }
});

test('repeated 429s fail over to a different group on the same provider', async () => {
  const author = glm('author', 'glm-5.3-flash', 'zai');
  const mate = glm('mate', 'glm-5.3-other', 'zai');
  const f = fixture([author, mate], [
    { profileId: 'author', group: 'zai-a' },
    { profileId: 'mate', group: 'zai-b' },
  ]);
  try {
    f.working();
    (f.adapter as { continueWorker: unknown }).continueWorker = async () => {
      f.continuations.push('sent');
      f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    };
    const reportRateLimited = (n: number) => f.states.set('worker',
      { id: 'worker', workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: `${GLM_RATE_LIMIT} (${n})`, updatedAt: new Date(Date.now() + n * 1000).toISOString() });
    const replaced = () => f.current().profile?.id === 'mate' && f.current().retiredWorkers.length === 1;
    reportRateLimited(1);
    await f.engine.wake();
    for (let attempt = 1; attempt <= 12 && !replaced(); attempt++) {
      const latest = f.current();
      if (latest.transientProviderRetry?.status === 'waiting')
        f.store.update(f.taskId, { transientProviderRetry: { ...latest.transientProviderRetry!, retryAt: '2000-01-01T00:00:00.000Z' } });
      await f.engine.wake();
      if (replaced()) break;
      reportRateLimited(attempt + 1);
      await f.engine.wake();
    }
    assert.equal(f.continuations.length, 4, 'the backoff schedule runs four same-thread resumes first');
    assert.ok(f.store.eventsAll(f.taskId).some(event => event.kind === 'rate_limit_failover_armed'), 'the failover is armed');
    assert.equal(f.current().profile?.id, 'mate', 'the exhausted subscription group is out, not the whole provider');
    assert.equal(f.current().profileGroup, 'zai-b');
  } finally { await f.close(); }
});

test('a 429 at creation paces the group and requeues instead of parking failed', async () => {
  const author = glm('author', 'glm-5.3-flash', 'zai');
  const sol = glm('sol', 'sol-model', 'other');
  const f = fixture([author, sol], [
    { profileId: 'author', group: 'zai' },
    { profileId: 'sol', group: 'other' },
  ]);
  try {
    let launches = 0;
    (f.adapter as { createAgent: unknown }).createAgent = async (t: { profile?: { id: string } | null; workspaceId?: string | null }) => {
      launches++;
      if (launches === 1) throw new Error(GLM_RATE_LIMIT);
      const id = `agent-${launches}`;
      f.states.set(id, { id, workspaceId: t.workspaceId ?? 'workspace', status: 'running', active: true, permissions: false, error: '' });
      f.created.push(id);
      return { id, workspaceId: t.workspaceId ?? 'workspace' };
    };
    await f.engine.wake();
    const paced = f.current();
    assert.equal(paced.phase, 'queued', 'the rate-limited launch requeues instead of parking');
    assert.equal(paced.profile, null);
    const availability = f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('zai') as { data: string } | undefined;
    assert.ok(availability && groupIsUnavailable(JSON.parse(availability.data)), 'the group cool-down is recorded in capacity state');
    assert.ok(f.store.eventsAll(f.taskId).some(event => event.kind === 'rate_limit_launch_paced'));
  } finally { await f.close(); }
});

function retiredErroredAgentFixture() {
  const author = glm('author', 'glm-5.3-flash', 'zai');
  const sol = glm('sol', 'sol-model', 'other');
  const f = fixture([author, sol], [
    { profileId: 'author', group: 'zai' },
    { profileId: 'sol', group: 'other' },
  ]);
  (f.adapter as { archiveAgent: unknown }).archiveAgent = async (id: string) => { f.archived.push(id); };
  f.states.set('old-worker', { id: 'old-worker', workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: GLM_RATE_LIMIT });
  f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
  f.working({
    agentId: 'worker', profile: sol, profileGroup: 'other',
    retiredWorkers: [{ agentId: 'old-worker', runId: 'old-run', profile: author, reason: 'rate-limit failover' }],
  });
  return f;
}

test('a moved-on task archives its retired errored agent only once across due sweeps', async () => {
  const f = retiredErroredAgentFixture();
  try {
    await f.engine.wake();
    assert.equal(f.archived.filter(id => id === 'old-worker').length, 1, 'the retired errored agent is archived');
    assert.ok(f.store.eventsAll(f.taskId).some(event => event.kind === 'retired_errored_agent_archived'));
    assert.ok(!f.archived.includes('worker'), 'the live replacement agent is never archived');
    const sweep = f.store.getMeta<Record<string, { count: number; at: string; archived?: string[] }>>('retiredArchiveSweep')!;
    f.store.setMeta('retiredArchiveSweep', { ...sweep, [f.taskId]: { ...sweep[f.taskId]!, at: new Date(0).toISOString() } });
    await f.engine.wake();
    assert.equal(f.archived.filter(id => id === 'old-worker').length, 1, 'a later due sweep does not archive it again');
  } finally { await f.close(); }
});

test('a removable host keeps retired errored workers and superseded support threads until closeout (#1155)', async () => {
  const f = retiredErroredAgentFixture();
  try {
    const deleted: string[] = [];
    f.adapter.deleteAgent = async id => { deleted.push(id); };
    for (const role of ['reviewer', 'recovery'] as const) {
      const agentId = `old-${role}`;
      f.states.set(agentId, { id: agentId, workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: 'Old run failed' });
      f.store.putRun({ id: `old-${role}-run`, taskId: f.taskId, hostId: 'host', role, generation: 1,
        head, base, agentId, workspaceId: 'workspace', profile: null, status: 'superseded',
        createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null, released: true });
    }

    await f.engine.archiveRetiredErroredAgents();
    assert.deepEqual(f.archived, [], 'no thread of the open task is archived');
    assert.deepEqual(deleted, [], 'no thread of the open task is deleted');
    assert.ok(f.states.has('old-worker') && f.states.has('old-reviewer') && f.states.has('old-recovery'),
      'all retired threads remain available until closeout');

    // A host without removal keeps the existing Failed-workspace cleanup.
    delete f.adapter.deleteAgent;
    await f.engine.archiveRetiredErroredAgents();
    assert.deepEqual([...f.archived].sort(), ['old-recovery', 'old-reviewer', 'old-worker']);
  } finally { await f.close(); }
});

test('retired archive sweep prunes records for inactive tasks', async () => {
  const f = retiredErroredAgentFixture();
  try {
    f.store.setMeta('retiredArchiveSweep', { obsolete: { count: 1, at: new Date(0).toISOString() } });
    await f.engine.wake();
    const sweep = f.store.getMeta<Record<string, { count: number; at: string; archived?: string[] }>>('retiredArchiveSweep')!;
    assert.ok(!('obsolete' in sweep), 'inactive task sweep records are pruned');
  } finally { await f.close(); }
});
