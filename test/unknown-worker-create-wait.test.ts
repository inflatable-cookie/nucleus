import { fakeAdapter, profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { HostCreateInFlightError, HostUnknownDeliveryError } from '../core/host/errors';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { submissionSchema, type Task } from '../shared/contracts';

/**
 * Spec 068 §3: a first-dispatch worker create whose delivery is unknown is
 * Nucleus's to settle. It records the same wait a run launch records —
 * `creation_in_flight` while the host may still answer, else the creation
 * lookup — never a person's `operator_needed` stop, and nothing is resent.
 */

const base = 'b'.repeat(40);

function fixture(create: () => Error, options: { lateReply: boolean }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ns-unknown-create-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const worker = profile('worker');
  store.setMeta('paused', false);
  store.setMeta('pool', [{ profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 'default', scopes: ['general'] }]);
  let creates = 0;
  const adapter = fakeAdapter({
    profiles: async () => [worker],
    validate: async (t: Task) => t.planningCommit ?? base,
    createWorkspace: async (t: Task) => ({ id: `ws-${t.id}`, directory: '/worktree' }),
    preflightWorkerContinuation: async () => ({ available: true }),
    verifyWorkspace: async (t: Task) => t.branch,
    createAgent: async () => {
      creates++;
      throw create();
    },
    // The creation lookup the host answers: a late reply may still land, or no thread yet.
    findRunAgents: async () => {
      if (options.lateReply) throw new HostCreateInFlightError('the create may still answer');
      return [];
    },
  });
  // A long grace: an absent lookup keeps waiting inside it instead of relaunching.
  const engine = new Engine(store, adapter, 60 * 60_000);
  engine.profiles = [worker];
  const add = () => store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo',
    planningCommit: base, handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  return {
    store, engine, add, creates: () => creates,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const late = () => {
  const error = new HostUnknownDeliveryError({ command: 'thread.create', reason: 'timeout' });
  error.late = new Promise(() => {});
  return error;
};

for (const scenario of [
  { name: 'a create the host may still answer waits on its reply', error: late, lateReply: true, code: 'creation_in_flight', state: 'nucleus' },
  { name: 'a create with no reply pending waits on its creation lookup', error: () => new HostUnknownDeliveryError({ command: 'thread.create' }), lateReply: false, code: 'worker_lookup', state: 'recovering' },
] as const) {
  test(`unknown first-dispatch worker create: ${scenario.name}, never a person's stop`, async () => {
    const f = fixture(scenario.error, { lateReply: scenario.lateReply });
    try {
      const submitted = f.add();
      await f.engine.wake();
      await f.engine.quiesce();
      await f.engine.wake();
      await f.engine.quiesce();
      const task = f.store.task(submitted.id);
      assert.equal(task.phase, 'dispatching', task.reason);
      assert.equal(task.agentIntent, true, 'the creation stays owned by its lookup');
      assert.equal(task.agentId, null);
      assert.ok(task.runId);
      assert.equal(task.resolution.stop?.reason, 'lifecycle', JSON.stringify(task.resolution.stop));
      assert.equal(task.resolution.stop?.fact?.code, scenario.code);
      assert.equal(task.resolution.stop?.fact?.subject, task.runId);
      const reading = ownerTaskNext(collectOwnerVerbFacts(f.store, task)).activity;
      assert.equal(reading?.state, scenario.state, `${reading?.state}: ${reading?.detail}`);
      assert.match(`${reading?.role ?? ''} ${reading?.detail}`, /worker/i, 'the reading names the worker creation');
      assert.equal(f.creates(), 1, 'the unknown create is never resent while its outcome is open');
      assert.equal(f.store.eventsAll(task.id).some(event => event.kind === 'task_stopped' && event.detail.includes('operator_needed')), false);
    } finally { await f.close(); }
  });
}

test('an unknown create whose text mentions a rate limit is still unknown: never requeued under a fresh run id', async () => {
  const f = fixture(() => new HostUnknownDeliveryError({ command: 'thread.create', guidance: 'Provider answered 429 Too Many Requests (rate limit); the create outcome is unknown.' }), { lateReply: false });
  try {
    const submitted = f.add();
    await f.engine.wake();
    await f.engine.quiesce();
    const task = f.store.task(submitted.id);
    assert.match(task.reason, /creation|Uncertain/i, task.reason);
    assert.equal(task.phase, 'dispatching', task.reason);
    assert.equal(task.agentIntent, true);
    assert.equal(task.resolution.stop?.fact?.code, 'worker_lookup');
    assert.equal(f.store.eventsAll(task.id).some(event => event.kind === 'rate_limit_launch_paced'), false);
    assert.equal(f.creates(), 1);
  } finally { await f.close(); }
});

test('a worker create that failed for another reason keeps its ordinary step failure', async () => {
  const f = fixture(() => new Error('synthetic adapter failure'), { lateReply: false });
  try {
    const submitted = f.add();
    await f.engine.wake();
    await f.engine.quiesce();
    const task = f.store.task(submitted.id);
    assert.notEqual(task.resolution.stop?.fact?.code, 'creation_in_flight');
    assert.notEqual(task.resolution.stop?.fact?.code, 'worker_lookup');
    assert.equal(task.phase, 'needs_attention', task.reason);
  } finally { await f.close(); }
});
