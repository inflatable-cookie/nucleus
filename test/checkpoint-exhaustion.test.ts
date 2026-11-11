import { fakeAdapter, profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { workerPrompt } from '../core/dispatch/prompts';
import { checkpointPrompt, runPrompt } from '../core/dispatch/prompts';
import { isPseudoCheckpointError, postBudgetPrePrResumes } from '../core/recovery/recovery';
import { CHECKPOINT_BUDGET, submissionSchema, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';

const head = 'a'.repeat(40), base = 'b'.repeat(40);

const INCOMPLETE = 'Assessment incomplete; committed the chunk. Not a provider/external blocker.';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-pseudo-checkpoint-')), store = new Store(join(dir, 'queue.sqlite'));
  const worker = profile('author'), coordinator = profile('coordinator');
  store.setMeta('paused', false);
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Long task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  const states = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = 'workspace') => states.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  idle('worker');
  const tokens = new Map<string, string>(), creates: Run[] = [];
  const adapter = fakeAdapter({
    profiles: async () => [worker, coordinator], validate: async () => base, verifyWorkspace: async () => submitted.branch,
    createWorkspace: async () => { throw new Error('No dispatch'); }, createAgent: async () => { throw new Error('No dispatch'); },
    observe: async (id: string) => { const s = states.get(id); if (!s) throw new Error('Agent missing'); return s; },
    verifyPr: async () => { throw new Error('No PR pre-PR'); },
    createRun: async (t: Task, r: Run, token: string) => { creates.push(r); tokens.set(r.id, token); const id = `agent-${r.id}`; states.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' }); return { id, workspaceId: r.workspaceId }; },
    sendRun: async () => {}, findRunAgents: async () => [],
    continueRun: async () => {}, verifyReview: async () => {}, mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {}, notify: async () => {},
  } as unknown as Adapter & ResolutionAdapter);
  Object.assign(adapter, { supportsCoordinatorRecovery: true });
  const engine = new Engine(store, adapter, 0); engine.profiles = [worker, coordinator];
  store.update(submitted.id, {
    phase: 'working', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker', runId: 'initial', profile: worker, workerModel: worker.model, agentActive: false, lastAgentStatus: 'idle', lastObservedAt: new Date().toISOString(),
  });
  const current = () => store.task(submitted.id);
  const spendBudget = () => {
    const records = [1, 2, 3].map(ordinal => ({ ordinal, summary: `Chunk ${ordinal}`, head, at: new Date().toISOString(), runId: 'initial' }));
    store.update(submitted.id, { checkpoints: { records, intent: { id: 'intent-3', ordinal: 3, summary: 'Chunk 3', head, runId: 'initial', eventId: 'cp-3', status: 'delivered', createdAt: new Date().toISOString(), deliveredAt: new Date().toISOString(), attempts: 1, error: '' } } });
    for (const record of records) store.event(submitted.id, 'progress_checkpoint', `${record.summary} @ ${record.head}`);
  };
  const reportIncompleteError = (summary: string) => {
    const task = current();
    store.update(submitted.id, {
      phase: 'error', reason: summary,
      completion: { taskId: submitted.id, runId: 'initial', eventId: randomUUID(), status: 'error', summary },
      resolution: { ...task.resolution, attention: true },
    });
    // The task quantum records the Spec 050 stop for an errored task before it
    // routes recovery; mirror that here so the routed episode's stop key matches.
    engine.note(submitted.id, summary, 'classify', 'error');
    return store.task(submitted.id);
  };
  return { dir, store, engine, adapter, worker, coordinator, submitted, current, creates, tokens, idle, spendBudget, reportIncompleteError,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('the worker prompt reserves blocked/error for execution failures and sends a spent budget to the PR', async () => {
  const f = fixture(); try {
    const prompt = workerPrompt({ ...f.current(), runId: 'initial', dependsOn: [], coordinatorAgentId: null, retiredWorkers: [] } as unknown as Task, true);
    assert.match(prompt, /Report blocked or error only for a concrete external impediment or an observed execution failure/);
    assert.match(prompt, /continue toward the PR instead of reporting error as another checkpoint/);
    assert.doesNotMatch(prompt, /context pressure stops the turn, commit and report blocked/);
    assert.match(prompt, /Use progress_checkpoint for a deliberate bounded handover of real committed progress/);
    assert.match(prompt, /self-assessed context pressure is not one/);
  } finally { await f.close(); }
});

test('the continuation prompt keeps the budget rule and the coordinator prompt names the one-action contract', async () => {
  const f = fixture(); try {
    const task = f.current();
    const continuation = checkpointPrompt(task, { id: 'intent-1', ordinal: 3, summary: 'Chunk 3', head, runId: 'initial', eventId: 'cp-3', status: 'pending', createdAt: 'now', deliveredAt: null, attempts: 0, error: '' });
    assert.match(continuation, /When the checkpoint budget is spent, continue to the PR/);
    assert.match(continuation, /never another checkpoint/);
    // Spec 050: the pseudo-checkpoint rule is enforced in Queue's recovery
    // route, not restated in the coordinator prompt. The prompt names the one
    // typed owner-verb action a coordinator may report.
    const recovery = runPrompt(task, { id: 'recovery', role: 'recovery', generation: 1, head } as Run, '/helper', '/ticket', true);
    assert.match(recovery, /Report exactly one coordinatorAction: restart, route, move, retry_effect, or cannot/);
    assert.match(recovery, /restart may include role, instruction and fresh/);
  } finally { await f.close(); }
});

test('the classifier accepts a self-declared incomplete error and refuses genuine failures', async () => {
  const f = fixture(); try {
    f.spendBudget();
    // Project-A #1980 shape: spent budget plus an incomplete/no-failure error.
    assert.equal(isPseudoCheckpointError(f.reportIncompleteError(INCOMPLETE)), true);
    // A genuine execution failure with the same spent budget still recovers normally.
    assert.equal(isPseudoCheckpointError(f.reportIncompleteError('Integration check failed: 2 tests failing on main')), false);
    // Explicit failure evidence wins even when both classifier phrases are present
    // (review ID 5421300262): naming concrete failing tests is a genuine failure.
    assert.equal(isPseudoCheckpointError(f.reportIncompleteError('Integration tests failed (3 incomplete); not a provider/external blocker')), false);
    assert.equal(isPseudoCheckpointError(f.reportIncompleteError('Assessment incomplete because the build command failed with exit code 1; not a provider issue')), false);
    // Generic error and timeout wording also vetoes (review ID 5421422283).
    assert.equal(isPseudoCheckpointError(f.reportIncompleteError('Assessment incomplete because a request timed out; not a provider/external blocker')), false);
    assert.equal(isPseudoCheckpointError(f.reportIncompleteError('Assessment incomplete after an error occurred; not a provider/external blocker')), false);
    // providerUnavailable is never a pseudo-checkpoint.
    const exhausted = f.reportIncompleteError(INCOMPLETE);
    f.store.update(f.submitted.id, { completion: { ...exhausted.completion!, providerUnavailable: true } });
    assert.equal(isPseudoCheckpointError(f.current()), false);
    // A task PR ends the pre-PR shape.
    const pr = f.reportIncompleteError(INCOMPLETE);
    f.store.update(f.submitted.id, { prHead: head });
    void pr;
    assert.equal(isPseudoCheckpointError(f.current()), false);
    f.store.update(f.submitted.id, { prHead: null });
    // Before the budget is spent the same error is an ordinary worker error.
    const fresh = fixture(); try {
      assert.equal(isPseudoCheckpointError(fresh.reportIncompleteError(INCOMPLETE)), false);
    } finally { await fresh.close(); }
  } finally { await f.close(); }
});

test('only post-budget pre-PR resumes count toward the one-resume bound', () => {
  assert.equal(postBudgetPrePrResumes([]), 0);
  const events = [
    { id: 1, kind: 'progress_checkpoint' }, { id: 2, kind: 'progress_checkpoint' },
    { id: 3, kind: 'worker_resume_requested' }, { id: 4, kind: 'progress_checkpoint' },
    { id: 5, kind: 'worker_resume_requested' },
  ];
  // The resume at id 3 precedes the budget-exhausting checkpoint at id 4.
  assert.equal(postBudgetPrePrResumes(events), 1);
  assert.equal(CHECKPOINT_BUDGET, 3);
});

test('the first pseudo-checkpoint error gets one recovery; an owner restart resumes; the repeat escalates without launching recovery', async () => {
  const f = fixture(); try {
    f.spendBudget();
    f.reportIncompleteError(INCOMPLETE);
    assert.equal(await f.engine.resolution.recovery.route(f.current()), null);
    assert.equal(f.creates.length, 1, 'the first pseudo-checkpoint error gets its one recovery');
    const recovery = f.store.run(f.current().resolution.recovery!.runId!)!;
    f.idle(recovery.agentId!, recovery.workspaceId);
    const instruction = 'Continue the approved work from the committed chunk';
    // Spec 050: the coordinator continues a worker through the owner `restart`
    // verb; the retired narrow `resume_worker` recovery action no longer runs.
    f.engine.resolution.complete({ eventId: randomUUID(), taskId: f.submitted.id, runId: recovery.id, status: 'recovered', summary: instruction, coordinatorGeneration: recovery.generation,
      coordinatorAction: { verb: 'restart', role: 'worker', instruction, reason: 'The retained worker can continue the committed chunk' } }, f.tokens.get(recovery.id)!);
    await f.engine.resolution.recovery.pass();
    assert.equal(f.current().phase, 'changes_requested');
    assert.equal(f.current().resolution.recovery, null, 'the applied owner restart settles and clears the episode');
    assert.equal(f.current().resolution.stop, null, 'the applied owner restart clears the stop it acted on');
    assert.ok(f.store.eventsAll(f.submitted.id).some(event => event.kind === 'coordinator_action_applied'), 'the owner restart is applied and recorded');
    assert.equal(f.store.run(recovery.id)?.released, true, 'the coordinator run settles with its applied action');
    // The resumed worker commits its next chunk and reports error as a checkpoint again.
    f.reportIncompleteError('Assessment incomplete; committed the next chunk. Not a provider/external blocker.');
    const routed = await f.engine.resolution.recovery.route(f.current());
    assert.match(routed!, /pseudo-checkpoint/);
    assert.match(routed!, /already resumed pre-PR once/);
    assert.equal(f.creates.length, 1, 'no second recovery run is launched for the loop');
    assert.equal(f.current().resolution.recovery?.status, 'escalated');
    assert.equal(f.current().phase, 'error', 'the task waits on the planner, not another resume');
  } finally { await f.close(); }
});

test('a coordinator narrow resume action is refused at intake instead of resuming', async () => {
  const f = fixture(); try {
    f.spendBudget();
    f.reportIncompleteError(INCOMPLETE);
    assert.equal(await f.engine.resolution.recovery.route(f.current()), null);
    assert.equal(f.creates.length, 1, 'the pseudo-checkpoint error gets its one recovery');
    const run = f.store.run(f.current().resolution.recovery!.runId!)!;
    f.idle(run.agentId!, run.workspaceId);
    const resumesBefore = f.store.eventsAll(f.submitted.id).filter(event => event.kind === 'worker_resume_requested').length;
    // Spec 050: the narrow `resume_worker` recovery action is retired and is
    // refused at intake, so it never resumes the worker.
    assert.throws(() => f.engine.resolution.complete({ eventId: randomUUID(), taskId: f.submitted.id, runId: run.id, status: 'recovered', summary: 'Resume for the next chunk',
      coordinatorGeneration: run.generation, recoveryAction: 'resume_worker' }, f.tokens.get(run.id)!), /recoveryAction is retired/);
    await f.engine.resolution.recovery.pass();
    const current = f.current();
    assert.equal(current.phase, 'error', 'the retired action never returns the worker to work');
    assert.equal(f.store.eventsAll(f.submitted.id).filter(event => event.kind === 'worker_resume_requested').length, resumesBefore, 'no pre-PR resume is granted');
  } finally { await f.close(); }
});
