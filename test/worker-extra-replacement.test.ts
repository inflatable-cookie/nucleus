import { fakeAdapter } from './support/fakes';
import { profile as sharedProfile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { submissionSchema, taskControlInputSchema, WORKER_REPLACEMENT_CEILING, type Profile, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';

/** The per-task replacement ceiling and its operator-relayed restart escape. */

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const profile = (id: string, extra: Partial<Profile> = {}): Profile => sharedProfile(id, id, extra);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-extra-replacement-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const worker = profile('author');
  store.setMeta('paused', false);
  store.putRepository({ origin: null, path: '/repo' }, 'agent', 'fixture keeps agent closeout');
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Long-running task', repoPath: '/repo',
    planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const states = new Map<string, AgentObservation>();
  const creates: { taskId: string; profile: string | null; agentId: string }[] = [];
  const idle = (agentId: string, workspaceId = 'workspace') =>
    states.set(agentId, { id: agentId, workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => [worker], validate: async () => base,
    verifyWorkspace: async t => t.branch, verifyResume: async () => {},
    createWorkspace: async () => { throw new Error('fixtures do not create workspaces') },
    verifyCleanQueueWorktree: async () => {},
    createAgent: async (t, _token) => {
      const agentId = `agent-${creates.length + 1}`; idle(agentId);
      creates.push({ taskId: t.id, profile: t.profile?.id ?? null, agentId });
      return { id: agentId, workspaceId: t.workspaceId }; },
    agentTimelinePage: async () => null,
    observe: async id => { const state = states.get(id); if (!state) throw new Error('Agent missing'); return state },
    stopAgentTurn: async id => {
      const state = states.get(id); if (state) states.set(id, { ...state, active: false, status: 'idle', activeTurnId: undefined } as AgentObservation);
    },
    createRun: async (_t, r, _token) => { const agentId = `run-agent-${r.id}`; states.set(agentId, { id: agentId, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' }); return { id: agentId, workspaceId: r.workspaceId }; },
    sendRun: async () => {},
    findRunAgents: async () => [],
    verifyReview: async (_t, _r, checkpoint) => { if (checkpoint.head !== head) throw new Error('Stale PR head'); },
    verifyPr: async () => ({ head, url: 'https://github.com/example/repo/pull/1' }),
    verifyPrIdentity: async () => ({ head, url: 'https://github.com/example/repo/pull/1' }),
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => head,
    verifyCloseout: async () => {}, notify: async () => {},
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker];
  const retired = (count: number) => Array.from({ length: count }, (_, index) =>
    ({ agentId: `retired-${index + 1}`, runId: `retired-run-${index + 1}`, profile: worker, reason: 'Provider exhausted' }));
  for (let index = 1; index <= 8; index++) idle(`retired-${index}`);
  idle('worker');
  // The recurring shape: a long-lived task with an open reviewed PR whose own
  // worker stopped on provider exhaustion after the ordinary replacements.
  let task = store.update(submitted.id, {
    phase: 'needs_attention', reason: 'Provider exhausted; waiting for a worker',
    workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker', runId: 'initial', profile: worker, profileGroup: 'author', workerModel: worker.model,
    prUrl: 'https://github.com/example/repo/pull/1', prHead: head, resumePrNumber: 1,
    retiredWorkers: retired(8), resolution: { ...store.task(submitted.id).resolution, attention: true },
  });
  const current = () => store.task(task.id);
  const next = () => ownerTaskNext(collectOwnerVerbFacts(store, current()));
  /** The worker's own provider exhaustion, as the ordinary recovery pass observes it. */
  const exhaust = (agentId = current().agentId ?? 'worker') =>
    states.set(agentId, { id: agentId, workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: 'weekly usage limit exceeded' });
  const control = (input: Record<string, unknown>) =>
    engine.performTaskControl(taskControlInputSchema.parse({ taskId: task.id, version: current().version, ...input }));
  const restartFresh = (options: Record<string, unknown> = {}) =>
    control({ action: 'restart', role: 'worker', fresh: true, reason: 'Replace the exhausted worker for the remaining bounded work', caller: 'operator (board)', ...options });
  return { store, engine, current, next, exhaust, restartFresh, creates, dir,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Run the ordinary recovery pass and return the task as it stands afterwards. */
async function recover(f: ReturnType<typeof fixture>): Promise<Task> {
  await f.engine.wake();
  return f.current();
}

test('the retirement ceiling still stops automatic replacement and next reports the count', async () => {
  const f = fixture(); try {
    const before = f.next();
    assert.equal(before.replacement?.retirements, 8);
    assert.equal(before.replacement?.ceiling, WORKER_REPLACEMENT_CEILING);
    assert.equal(before.replacement?.ceilingReached, true);
    assert.equal('authorization' in (before.replacement ?? {}), false);

    f.exhaust();
    const after = await recover(f);
    assert.equal(after.retiredWorkers.length, 8, 'nothing was retired');
    assert.equal(f.creates.length, 0, 'no worker was created');
    assert.match(after.reason, /replacement ceiling of 8/);
  } finally { await f.close(); }
});

test('an operator-relayed fresh worker restart passes the ceiling once', async () => {
  const f = fixture(); try {
    await assert.rejects(f.restartFresh({ caller: 'owner-thread' }), /replacement ceiling of 8.*operator-relayed restart/);
    await f.restartFresh({ caller: 'relay-agent', relayed: true, note: 'Operator directs a fresh worker replacement' });
    assert.equal(f.current().replacementProfile?.operatorRelayed, true);
    const after = await recover(f);
    assert.equal(after.retiredWorkers.length, 9);
    assert.equal(f.creates.length, 1);
    assert.equal(after.workspaceId, 'workspace');
    assert.equal(after.prUrl, 'https://github.com/example/repo/pull/1');
    assert.equal(after.retiredWorkers.length, 9, 'the restart retires once and records no grant history');
  } finally { await f.close(); }
});

test('a legacy extraReplacements row is stripped on open; the ceiling math never reads it', async () => {
  const f = fixture();
  let store: Store | null = null;
  try {
    const legacy = {
      id: 'legacy-extra', via: 'restart', grantedAt: '2026-01-01T00:00:00.000Z', grantedBy: 'operator',
      authority: 'operator', note: null, reason: 'historical grant', profileId: 'author', retirements: 8,
      status: 'granted', consumedAt: null, consumedRetirements: null, supersededAt: null,
    };
    const raw = JSON.parse(String((f.store.db.prepare('SELECT data FROM tasks WHERE id=?').get(f.current().id) as { data: string }).data)) as Record<string, unknown>;
    raw.extraReplacements = [legacy];
    f.store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(raw), f.current().id);
    await f.engine.stop();
    f.store.close();
    store = new Store(join(f.dir, 'queue.sqlite'));
    const task = store.task(store.db.prepare('SELECT id FROM tasks LIMIT 1').get()!['id'] as string);
    assert.equal('extraReplacements' in (task as unknown as Record<string, unknown>), false,
      'the store step strips the retired grant history the strict schema refuses');
    assert.equal(task.retiredWorkers.length, 8);
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(store, task)).replacement?.retirements, 8);
  } finally {
    store?.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
