import { createTaskAgent, profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { AGENT_NOT_FOUND, HostReadRefusalError } from '../core/host/errors';
import { HostTransportFault } from '../core/host/adapter-routing';
import { DEAD_PARTICIPANT_ATTEMPTS } from '../core/recovery/dead-participant';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { COORDINATOR_UNOBSERVED_BOUND_MS } from '../core/recovery/coordinator-pass';
import { COORDINATOR_OBSERVATION_DEFERRED_EVENT } from '../shared/task-activity';
import { runSchema, submissionSchema, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import { taskStopVerbsFor } from '../shared/task-stop';

/**
 * Spec 068 §3: a coordinator whose agent is provably gone is a dead participant
 * like any other. Its thread absent or removed on an exact read releases the
 * run, closes the episode and lets the stop admit a fresh coordinator under the
 * ordinary cap. An unreadable read or an archived thread proves nothing, and
 * the episode keeps its old handling.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const worker = profile('worker', 'test/worker');
const coordinator = profile('coordinator', 'test/coordinator');
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

type Origin = 'absent' | 'deleted' | 'archived' | 'unreadable' | 'transport' | 'decode';

function fixture(initial: Origin) {
  let origin: Origin = initial;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ns-dead-coordinator-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 'default', scopes: ['general'] },
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 'default', scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Dead coordinator', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const stallDetail = 'The worker run worker-run (agent worker, active turn stalled-turn) looks stalled: no agent activity while the host still reports it running.';
  store.update(submitted.id, {
    phase: 'needs_attention', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace',
    directory: '/worktree', agentId: 'worker', runId: 'worker-run', profile: worker, workerModel: worker.model,
    coordinatorAgentId: 'coord-agent', reason: stallDetail,
  }, 'dispatched');
  const current = store.task(submitted.id);
  const coordinatorRun: Run = runSchema.parse({
    id: 'coord-run', taskId: submitted.id, role: 'recovery', generation: current.coordinatorGeneration, head: base, base,
    agentId: 'coord-agent', workspaceId: 'workspace', profile: coordinator, status: 'running', createdAt: minutesAgo(70),
    lastObservedAt: minutesAgo(1), active: true, idleSince: null, completion: null, released: false,
  });
  store.putRun(coordinatorRun);
  store.setCredential(coordinatorRun.id, 'coordinator-token');
  store.update(submitted.id, {
    resolution: {
      ...current.resolution,
      attention: true,
      stop: { reason: 'run_stalled', detail: stallDetail, since: minutesAgo(70), suggestedVerbs: taskStopVerbsFor('run_stalled') },
      recovery: {
        id: 'episode-1', key: 'stall-episode', generation: current.coordinatorGeneration, runId: coordinatorRun.id,
        agentId: 'coord-agent', status: 'running', summary: '', idleSince: null, incidentId: null, progress: null,
      },
    },
    recoveryActive: true,
  } as Partial<Task>, 'test_coordinator_running');

  const states = new Map<string, AgentObservation>([
    ['worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '',
      updatedAt: minutesAgo(70), turnStartedAt: minutesAgo(71), activeTurnId: 'stalled-turn' }],
  ]);
  const createdRuns: Run[] = [];
  let originReads = 0;
  const adapter = {
    hostId: 'host',
    profiles: async () => [worker, coordinator],
    validate: async () => base,
    createWorkspace: async () => ({ id: 'workspace', directory: '/worktree' }),
    verifyWorkspace: async (task: Task) => task.branch,
    findWorkspaces: async () => [],
    findAgents: async () => [],
    findRunAgents: async () => [],
    createAgent: createTaskAgent,
    observe: async (id: string) => {
      if (id === 'coord-agent') {
        if (origin === 'transport') throw new HostTransportFault('host', new Error('connection reset'));
        if (origin === 'decode') throw new Error('Could not decode the thread projection: unexpected token');
        if (origin === 'unreadable') throw new HostReadRefusalError('host read refused: shell snapshot is stale');
        throw new Error(AGENT_NOT_FOUND);
      }
      return states.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' };
    },
    originAgent: async (id: string) => {
      if (id === 'coord-agent') originReads++;
      if (id !== 'coord-agent') return { id, workspaceId: 'workspace', title: id, archived: false };
      if (origin === 'transport') throw new HostTransportFault('host', new Error('connection reset'));
      if (origin === 'unreadable') throw new HostReadRefusalError('host read refused: shell snapshot is stale');
      if (origin === 'absent') return null;
      return { id, workspaceId: 'workspace', title: id, archived: origin === 'archived', deleted: origin === 'deleted' };
    },
    archiveAgent: async () => {},
    deleteAgent: async () => {},
    notify: async () => {},
    createRun: async (_task: Task, run: Run) => {
      createdRuns.push(run);
      const id = `agent-${run.id}`;
      states.set(id, { id, workspaceId: run.workspaceId, status: 'running', active: true, permissions: false, error: '' });
      return { id, workspaceId: run.workspaceId };
    },
    supportsCoordinatorRecovery: true,
  } as unknown as Adapter & { supportsCoordinatorRecovery?: boolean };
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker, coordinator];
  return {
    store, engine, taskId: submitted.id, createdRuns,
    setOrigin: (next: Origin) => { origin = next; },
    originReads: () => originReads,
    current: () => store.task(submitted.id),
    events: (kind: string) => store.eventsAll(submitted.id).filter((event) => event.kind === kind),
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

for (const origin of ['absent', 'deleted'] as const) {
  test(`a coordinator whose thread is ${origin} on an exact read is released, and the stop admits a fresh coordinator`, async () => {
    const f = fixture(origin);
    try {
      await f.engine.resolution.recovery.pass(f.taskId);
      const released = f.store.run('coord-run')!;
      assert.equal(released.released, true, 'the dead coordinator run is released');
      assert.throws(() => f.store.authenticate('coord-run', 'coordinator-token'), /Unauthorized/, 'its credential is revoked');
      const task = f.current();
      assert.equal(task.resolution.recovery, null, 'the episode closes without a result');
      assert.equal(task.resolution.recoveryActive, false);
      assert.equal(task.coordinatorAgentId, '', 'the dead coordinator binding clears');
      assert.equal(task.resolution.stop?.reason, 'run_stalled', 'the stop it answered stays');
      const gone = f.events('participant_gone');
      assert.equal(gone.length, 1);
      const proof = JSON.parse(gone[0]!.detail) as { role: string; runId: string; evidence: string };
      assert.deepEqual([proof.role, proof.runId, proof.evidence], ['recovery', 'coord-run', `thread_${origin}`]);
      assert.equal(f.events('recovery_escalated').length, 0, 'nothing reaches the planner');

      await f.engine.resolution.recovery.route(f.current());
      const fresh = f.createdRuns.filter((run) => run.role === 'recovery');
      assert.equal(fresh.length, 1, 'a fresh coordinator is launched for the same stop');
      assert.notEqual(fresh[0]!.id, 'coord-run');
      assert.equal(fresh[0]!.agentId, null, 'on a fresh thread, never the dead one');
      assert.equal(f.current().resolution.recovery?.runId, fresh[0]!.id);
    } finally { await f.close(); }
  });
}

for (const origin of ['unreadable', 'archived'] as const) {
  test(`a coordinator whose thread read is ${origin} proves nothing and is never released`, async () => {
    const f = fixture(origin);
    try {
      await f.engine.resolution.recovery.pass(f.taskId);
      const run = f.store.run('coord-run')!;
      assert.equal(run.released, false, 'the coordinator run stays owned');
      assert.equal(f.current().resolution.recovery?.runId, 'coord-run');
      assert.equal(f.current().coordinatorAgentId, 'coord-agent');
      assert.equal(f.events('participant_gone').length, 0);
    } finally { await f.close(); }
  });
}

for (const origin of ['transport', 'decode'] as const) {
  test(`a ${origin} failure waits visibly for the host, then escalates at its bound while the host reads up`, async () => {
    const f = fixture(origin);
    try {
      for (let pass = 0; pass < 3; pass++) await f.engine.resolution.recovery.pass(f.taskId);
      assert.equal(f.store.run('coord-run')!.released, false);
      assert.equal(f.current().resolution.recovery?.status, 'running');
      assert.equal(f.events('participant_gone').length, 0);
      assert.equal(f.events('recovery_escalated').length, 0, 'inside the bound the observation waits');
      assert.equal(f.originReads(), 0, 'no proof is read on a host fault');
      const deferred = f.events(COORDINATOR_OBSERVATION_DEFERRED_EVENT);
      assert.equal(deferred.length, 1, 'the wait is recorded once, not per pass');
      assert.equal(JSON.parse(deferred[0]!.detail).runId, 'coord-run');
      const waiting = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).activity;
      assert.equal(waiting?.state, 'nucleus', `${waiting?.state}: ${waiting?.detail}`);
      assert.equal(waiting?.role, 'coordinator');
      // The coordinator stays unobserved past the bound with its host up: it escalates.
      const run = f.store.run('coord-run')!;
      f.store.putRun({ ...run, lastObservedAt: new Date(Date.now() - COORDINATOR_UNOBSERVED_BOUND_MS - 60_000).toISOString() });
      await f.engine.resolution.recovery.pass(f.taskId);
      assert.equal(f.events('recovery_escalated').length, 1, 'the bounded wait escalates');
      assert.equal(f.store.run('coord-run')!.released, false, 'an unproved coordinator is never released');
      const escalated = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).activity;
      assert.equal(escalated?.state, 'needs_person');
    } finally { await f.close(); }
  });
}

test('an archived coordinator thread proves nothing and escalates as before, over several passes', async () => {
  const f = fixture('archived');
  try {
    for (let pass = 0; pass < 3; pass++) await f.engine.resolution.recovery.pass(f.taskId);
    assert.equal(f.store.run('coord-run')!.released, false);
    assert.equal(f.events('participant_gone').length, 0);
    assert.equal(f.events(COORDINATOR_OBSERVATION_DEFERRED_EVENT).length, 0, 'a thread-gone answer is not a host fault to wait out');
    assert.equal(f.events('recovery_escalated').length, 1);
    assert.equal(f.current().resolution.recovery?.status, 'escalated');
  } finally { await f.close(); }
});

test('unreadable, then absent: the earlier escalation goes with the closed episode and the fresh coordinator reads as recovering', async () => {
  const f = fixture('unreadable');
  try {
    // Right after a reboot the thread cannot be read: no proof, so the episode escalates as before.
    await f.engine.resolution.recovery.pass(f.taskId);
    assert.equal(f.current().resolution.recovery?.status, 'escalated');
    const fault = f.current().resolution.incident;
    assert.equal(fault?.status, 'escalated');
    assert.equal(f.store.run('coord-run')!.released, false);
    // A later pass reads the thread absent: the dead run releases.
    f.setOrigin('absent');
    await f.engine.resolution.recovery.pass(f.taskId);
    assert.equal(f.store.run('coord-run')!.released, true);
    const task = f.current();
    assert.equal(task.resolution.recovery, null);
    assert.equal(task.resolution.incident?.id, fault!.id, 'the underlying fault is kept');
    assert.equal(task.resolution.incident?.status, 'reconciling', 'its escalation closed with the episode');
    await f.engine.resolution.recovery.route(f.current());
    assert.equal(f.createdRuns.filter((run) => run.role === 'recovery').length, 1, 'a fresh coordinator is launched');
    const reading = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).activity;
    assert.notEqual(reading?.state, 'needs_person', `${reading?.state}: ${reading?.detail}`);
    assert.equal(reading?.state, 'recovering');
  } finally { await f.close(); }
});

test(`past ${DEAD_PARTICIPANT_ATTEMPTS} gone coordinators at one head the task stops for a person with its command`, async () => {
  const f = fixture('absent');
  try {
    const head = f.store.run('coord-run')!.head;
    for (let index = 0; index < DEAD_PARTICIPANT_ATTEMPTS; index++)
      f.store.event(f.taskId, 'participant_gone', JSON.stringify({ runId: `earlier-${index}`, role: 'recovery', head, evidence: 'thread_absent' }));
    await f.engine.resolution.recovery.pass(f.taskId);
    assert.equal(f.store.run('coord-run')!.released, false, 'the dead run stays bound, so no coordinator cycles');
    assert.equal(f.events('participant_gone').length, DEAD_PARTICIPANT_ATTEMPTS, 'no further release');
    const stop = f.current().resolution.stop;
    assert.equal(stop?.reason, 'operator_needed');
    assert.equal(stop?.fact?.code, 'participant_gone');
    assert.equal(stop?.fact?.subject, 'coord-run');
    assert.match(f.current().reason, /run\.start coordinator fresh replacing=coord-run/);
    await f.engine.resolution.recovery.route(f.current());
    assert.equal(f.createdRuns.length, 0, 'no fresh coordinator past the bound');
  } finally { await f.close(); }
});

test('while the coordinator host itself reads as down, its outage owns the wait and nothing escalates past the bound', async () => {
  const f = fixture('transport');
  try {
    const run = f.store.run('coord-run')!;
    f.store.putRun({ ...run, lastObservedAt: new Date(Date.now() - COORDINATOR_UNOBSERVED_BOUND_MS - 60_000).toISOString() });
    f.engine.hostAvailable = () => false;
    for (let pass = 0; pass < 3; pass++) await f.engine.resolution.recovery.pass(f.taskId);
    assert.equal(f.events('recovery_escalated').length, 0);
    assert.equal(f.store.run('coord-run')!.released, false);
    assert.equal(f.current().resolution.recovery?.status, 'running');
  } finally { await f.close(); }
});
