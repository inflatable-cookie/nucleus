import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { DISPATCH_HELD_REASON } from '../core/dispatch/capacity';
import { holdsOf, submissionSchema, taskControlInputSchema, type Profile, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { toolTimelinePage } from './support/tool-timeline';

/**
 * Queue #531 (effigy#524 / task 5766f0ad, 2026-11-01): an owner stop recorded
 * before merge intent always prevents that merge. The live shape: the owner
 * stopped a task in `merging`, the stop placed its dispatch hold, and the next
 * pass read the merge gate and recorded merge intent anyway because the last
 * check before the request looked only at merge holds. A stop is a stop: any
 * hold fences merge intent, and a merge already requested is reported as
 * unknown delivery instead of being implied cancelled.
 */
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const workerProfile: Profile = { id: 'worker', name: 'worker', provider: 'test', model: 'test/worker', notes: '', available: true, problem: '', supportedThinking: [] };

type Fixture = Awaited<ReturnType<typeof fixture>>;

function fixture(options: {
  /** Stop the task from inside the merge gate read, after the gate started. */
  stopDuringGate?: boolean;
  /** Stop the task from inside the merge adapter call, after merge intent. */
  stopDuringMerge?: boolean;
  /** A gate wait that keeps the task in `merging` without recording intent. */
  gateWait?: string;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-merge-stop-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Stop before merge', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  store.setMeta('pool', [{ profileId: workerProfile.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] }]);
  const observations = new Map<string, AgentObservation>();
  const idle = (id: string) => observations.set(id, { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
  idle('worker-agent');
  const counts = { merges: 0, gateReads: 0, stops: 0 };
  const state = { gateWait: options.gateWait ?? '', stopPhase: '', stopResult: null as Task | null };
  let stopNow: () => Promise<Task> = async () => { throw new Error('the fixture engine is not ready'); };
  const adapter = {
    profiles: async () => [workerProfile],
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: null, status: 'idle', active: false, permissions: false, error: '' },
    agentTimelinePage: async () => toolTimelinePage([]),
    archiveAgent: async () => {}, notify: async () => {},
    findAgents: async () => [], findRunAgents: async () => [],
    verifyWorkspace: async () => 'branch',
    findWorkspaces: async () => [],
    verifyPr: async (t: Task) => ({ url: t.prUrl!, head }),
    mergeGate: async (t: Task) => {
      counts.gateReads++;
      // The exact race: the stop lands while the merge gate is being read, so
      // every await inside the gate has already happened before the pre-intent fence.
      if (options.stopDuringGate && !counts.stops) {
        counts.stops++; state.stopPhase = t.phase; state.stopResult = await stopNow();
      }
      return { head: t.prHead!, base, wait: state.gateWait };
    },
    merge: async (t: Task) => {
      counts.merges++;
      // Intent is already recorded when the adapter is called, so this stop is
      // unknown-delivery territory: the request may still land.
      if (options.stopDuringMerge && !counts.stops) {
        counts.stops++; state.stopPhase = t.phase; state.stopResult = await stopNow();
      }
    },
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }),
    syncMain: async () => base,
    verifyCloseout: async () => {},
    createRun: async () => { throw new Error('no dispatch is expected in these fixtures'); },
    sendRun: async () => {},
    stopAgentTurn: async (id: string) => {
      const observed = observations.get(id);
      if (observed) observations.set(id, { ...observed, status: 'idle', active: false, activeTurnId: undefined });
    },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [workerProfile];
  engine.resolution.worktreeValidationProbe = () => ({ state: 'absent' });
  stopNow = () => engine.performTaskControl(taskControlInputSchema.parse({
    taskId: inserted.id, version: store.task(inserted.id).version, action: 'stop',
    reason: 'The operator stopped this task before the merge', caller: 'operator (board)',
  })) as Promise<Task>;
  // A dispatched, reviewed-by-acceptance task at the exact published head.
  store.update(inserted.id, {
    phase: 'changes_requested', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, workerModel: workerProfile.model,
    prHead: head, prUrl: 'https://github.com/example/repo/pull/903',
    completion: { taskId: inserted.id, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 903 },
  });
  const task = () => store.task(inserted.id);
  const events = (kind: string) => store.eventsAll(inserted.id).filter(event => event.kind === kind);
  const accept = () => engine.performTaskControl(taskControlInputSchema.parse({
    taskId: inserted.id, version: task().version, action: 'move', to: 'merge',
    reason: 'The operator accepts the exact published head', qualification: 'The reviewed source is accepted as it is',
    caller: 'operator (board)',
  })) as Promise<Task>;
  const settle = async (rounds = 6) => { for (let round = 0; round < rounds; round++) { await engine.wake(); await engine.quiesce(); } };
  return {
    dir, store, engine, counts, state, taskId: inserted.id, task, events, accept, settle, stopNow,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Acceptance → ordinary verification → `merging`, held there by a gate wait. */
async function merging(f: Fixture) {
  f.state.gateWait = 'Required checks are still settling';
  await f.accept();
  await f.settle(1);
  f.store.update(f.taskId, { phase: 'merging' });
  assert.equal(f.task().phase, 'merging', f.task().reason);
  assert.equal(f.task().resolution.mergeIntent, false, 'no intent while the gate still waits');
  f.state.gateWait = '';
}

test('a stop recorded after the merge gate read and before intent prevents the merge', async () => {
  const f = fixture({ stopDuringGate: true });
  try {
    await f.accept();
    await f.settle(6);
    const task = f.task();
    assert.equal(f.counts.stops, 1, 'the stop landed while the gate was being read');
    assert.equal(f.state.stopPhase, 'verifying', 'the stop was recorded during the final verification');
    assert.ok(f.state.stopResult);
    assert.equal(holdsOf(task).dispatch?.reason.startsWith('Owner stop:'), true, 'the stop placed its dispatch hold');
    assert.equal(task.resolution.mergeIntent, false, 'no merge intent was recorded after the stop');
    assert.equal(f.counts.merges, 0, 'the merge adapter was never called');
    assert.equal(f.events('merge_intent').length, 0);
    assert.equal(task.resolution.stop?.reason, 'held', task.reason);
    assert.equal(task.reason, DISPATCH_HELD_REASON, 'the wait is the dispatch hold, not a lifecycle step');
  } finally { await f.close(); }
});

test('a task stopped in merging waits held on the next pass and never merges', async () => {
  const f = fixture();
  try {
    await merging(f);
    // The task is in `merging` and has already claimed the integration turn.
    const stopped = await f.stopNow();
    assert.equal(stopped.phase, 'merging');
    assert.equal(stopped.resolution.integrationTurn, null, 'stop releases the turn immediately');
    assert.equal(holdsOf(stopped).dispatch?.reason.startsWith('Owner stop:'), true);
    await f.settle(4);
    const task = f.task();
    assert.equal(task.phase, 'merging');
    assert.equal(task.resolution.mergeIntent, false, 'the held task records no merge intent');
    assert.equal(f.counts.merges, 0, 'no merge request is sent');
    assert.equal(f.events('merge_intent').length, 0);
    assert.equal(task.resolution.stop?.reason, 'held', task.reason);
    assert.equal(task.reason, DISPATCH_HELD_REASON);
    // The stopped task is out of the repository's integration turn, so it does
    // not stall every later merge behind it while the owner decides.
    assert.equal(f.engine.resolution.integrationActive(task), false);
    assert.equal(f.engine.resolution.holdsIntegrationTurn(task), false);
  } finally { await f.close(); }
});

test('a stop after merge intent reports the request may still land and does not cancel it', async () => {
  const f = fixture({ stopDuringMerge: true });
  try {
    await f.accept();
    await f.settle(3);
    assert.ok(f.counts.merges >= 1, 'the merge path reached its request');
    assert.equal(f.counts.stops, 1, 'the stop landed while the request was being sent');
    const stopped = f.state.stopResult!;
    assert.equal(stopped.resolution.integrationTurn, null, 'stop releases the turn even after merge intent');
    assert.equal(f.state.stopPhase, 'merging');
    assert.match(stopped.reason, /merge was already requested for a+ before this stop, so it may still land/);
    assert.match(stopped.reason, /Nucleus cannot cancel a request it already sent/);
    const task = f.task();
    assert.equal(task.resolution.mergeIntent, true, 'the recorded intent stands; the stop does not unwind it');
    assert.equal(task.resolution.mergeHead, head);
    assert.equal(holdsOf(task).dispatch?.reason.startsWith('Owner stop:'), true, 'the stop still parks the task');
    assert.match(holdsOf(task).dispatch!.reason, /may still land/, 'the hold reason carries the same disclosure');
    const recorded = JSON.parse(f.events('owner_stopped')[0]!.detail);
    assert.equal(recorded.mergeAlreadyRequested.head, head);
    assert.equal(typeof recorded.mergeAlreadyRequested.requestedAt, 'string');
    assert.deepEqual(recorded.cancelled, [], 'nothing invented as cancelled');
  } finally { await f.close(); }
});
