/**
 * Queue #691: a late report can't pull a finished task back out of done.
 *
 * A completion from a run that was under way when its task finished (closed_out
 * to done, or cancelled) is recorded as history. It releases its run, raises no
 * ladder, escalation or incident, and moves no phase. A restart on a finished
 * task refuses and says so. Live shape: a recovery coordinator reported
 * `blocked` after closed_out, and the blocker ladder parked the done task.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { Reports } from '../core/intake/report';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { runSchema, submissionSchema, taskNextSchema, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const profile = { id: 'p', name: 'p', provider: 'test', model: 'test/p', notes: '', available: true, problem: '', supportedThinking: [] };

function fixture(phase: 'done' | 'cancelled' = 'done') {
  const dir = mkdtempSync(join(tmpdir(), 'ns-finished-late-report-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const states = new Map<string, AgentObservation>();
  const observe = (id: string, state: Partial<AgentObservation> = {}) => states.set(id, {
    id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '', ...state,
  });
  const adapter = {
    supportsCoordinatorRecovery: true,
    observe: async (id: string) => {
      const state = states.get(id);
      if (!state) throw new Error(`Agent ${id} missing`);
      return state;
    },
    findRunAgents: async () => [],
    hostProcessListing: async () => [],
    agentTimelinePage: async () => ({ entries: [], nextCursor: null }),
    archiveAgent: async () => {}, notify: async () => {},
    verifyPr: async () => ({ head, url: 'https://github.com/example/repo/pull/7' }),
    verifyPrIdentity: async () => ({ head, url: 'https://github.com/example/repo/pull/7' }),
    verifyCleanQueueWorktree: async () => {}, verifyResume: async () => {},
    merged: async () => ({ merged: true, commit: base, head, base: 'main' }),
    archiveTaskWorkspace: async () => true,
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Finished late report', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin', responsible: true,
  }), 'host', 'handoff', base);
  const taskId = submitted.id;
  // A finished responsible task whose coordinator is still under way.
  store.update(taskId, {
    phase, responsible: true, workspaceId: 'ws', directory: join(dir, 'worktree'), agentId: 'worker-agent',
    runId: 'worker-run', profile, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
    reason: phase === 'done' ? 'Queue-owned closeout at the synchronized integration commit' : 'Cancelled by the operator',
    resolution: { ...store.task(taskId).resolution, mergedCommit: base, syncedCommit: base,
      recoveryActive: true, recovery: { id: 'episode', key: 'episode', generation: 1, runId: 'recovery-run',
        agentId: 'coordinator-agent', status: 'pending', summary: '', idleSince: null, incidentId: null, progress: '' } as never },
  });
  store.setCredential('recovery-run', 'recovery-token');
  observe('coordinator-agent');
  const run = (overrides: Partial<Run> & { id: string }): Run => store.putRun(runSchema.parse({
    taskId, role: 'recovery', generation: store.task(taskId).coordinatorGeneration, head, base,
    agentId: null, workspaceId: 'ws', profile: null, status: 'running',
    createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null,
    completion: null, released: false, ...overrides,
  })) as unknown as Run;
  run({ id: 'recovery-run', agentId: 'coordinator-agent' });
  const current = () => store.task(taskId);
  const events = (kind: string) => store.eventsAll(taskId).filter(event => event.kind === kind);
  return {
    dir, store, engine, adapter, taskId, current, events, observe, run, states,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const assertNoLadder = (f: ReturnType<typeof fixture>, phase: string) => {
  assert.equal(f.current().phase, phase, 'the finished task keeps its phase');
  assert.equal(f.current().resolution.attention, false, 'no attention is raised');
  assert.equal(f.current().resolution.incident, null, 'no incident is raised');
  assert.equal(f.events('blocker_ladder_park').length, 0, 'the ladder never parks a finished task');
  assert.equal(f.events('blocker_ladder_classified').length, 0);
  assert.equal(f.events('planner_escalation').length, 0, 'no planner escalation');
  assert.equal(f.events('reviewer_consult').length, 0, 'no reviewer consult');
  assert.equal(f.events('recovery_escalated').length, 0, 'no recovery escalation');
};

for (const phase of ['done', 'cancelled'] as const) {
  test(`a recovery coordinator's blocked report on a ${phase} task is evidence: the phase holds, the run releases, and nothing escalates`, async () => {
    const f = fixture(phase);
    try {
      const accepted = await new Reports(f.engine).report({
        eventId: 'late-recovery-blocked', taskId: f.taskId, runId: 'recovery-run', status: 'blocked',
        summary: 'GitHub merge state is UNKNOWN; the task is already merged and closed, so nothing is left to do.',
      } as never, 'recovery-token');
      assert.equal(accepted.accepted, true);
      // The live recovery pass runs against the same finished task.
      await f.engine.resolution.recovery.pass(f.taskId);
      await f.engine.wakeTask(f.taskId);
      assertNoLadder(f, phase);
      assert.equal(f.store.run('recovery-run')!.released, true, 'the coordinator run releases with its history kept');
      assert.equal(f.store.run('recovery-run')!.completion?.status, 'blocked', 'the report is kept as evidence');
      assert.equal(f.events('late_callback_evidence').length, 1);
      assert.equal(f.store.runs(f.taskId).filter(run => !run.released).length, 0, 'terminal cleanup has no unreleased run to wait on');
    } finally { await f.close(); }
  });
}

test('a late worker and reviewer report on a done task are evidence and move nothing', async () => {
  const f = fixture();
  try {
    f.run({ id: 'revision-run', role: 'revision', agentId: 'worker-agent', status: 'running', active: true, profile });
    f.store.setCredential('revision-run', 'revision-token');
    f.run({ id: 'reviewer-run', role: 'reviewer', agentId: 'reviewer-agent', status: 'running', active: true, profile });
    f.store.setCredential('reviewer-run', 'reviewer-token');
    f.observe('reviewer-agent');
    const reports = new Reports(f.engine);
    await reports.report({ eventId: 'late-revision', taskId: f.taskId, runId: 'revision-run', status: 'blocked',
      summary: 'Revision turn ended blocked after the merge.' } as never, 'revision-token');
    await reports.report({ eventId: 'late-reviewer', taskId: f.taskId, runId: 'reviewer-run', status: 'blocked',
      summary: 'Reviewer ended without a verdict after the merge.', head } as never, 'reviewer-token');
    await f.engine.wakeTask(f.taskId);
    assertNoLadder(f, 'done');
    assert.equal(f.store.run('revision-run')!.released, true);
    assert.equal(f.store.run('reviewer-run')!.released, true);
    assert.equal(f.events('late_callback_evidence').length, 2);
  } finally { await f.close(); }
});

test('a restart on a done task refuses through next and the applied verb, and starts nothing', async () => {
  const f = fixture();
  try {
    const task = f.current();
    const next = taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(f.store, task)));
    const restart = next.verbs.find(verb => verb.verb === 'restart');
    assert.equal(restart?.available, false);
    assert.equal(restart?.refusal, 'restart requires an unfinished, unmerged task; this task is done');
    await assert.rejects(f.engine.performTaskControl({ taskId: task.id, version: task.version, action: 'restart',
      reason: 'try again', caller: 'operator (board)' } as never), /restart requires an unfinished, unmerged task; this task is done/);
    assert.equal(f.current().phase, 'done', 'a refused restart leaves the task done');
    assert.equal(f.current().resolution.currentRunId, null);
  } finally { await f.close(); }
});
