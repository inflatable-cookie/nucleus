/**
 * Three live tasks (2026-11-23) sat with no live run while a stale owner record
 * kept every pass from moving them. These tests reproduce each stored shape.
 *
 * - A planner-ladder wait whose prerequisite was released and which a later
 *   owner `move` superseded was never retired: the fleet's question pass read
 *   host availability outside the task's host context, where only the primary
 *   host answers, so it skipped every task on a secondary host.
 * - A worker reported ready_for_review and its binding was released before the
 *   result applied: the task stayed `working` with no worker bound and no PR
 *   recorded, and nothing owned the report.
 * - A recovery episode that observed "recovered, no action" resolved, but the
 *   attention it was opened for stayed set, keeping admission and the orphan
 *   backstop away from a task ready for review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, digest } from '../core/store/store';
import { Engine } from '../core/engine';
import { resultApplied, recordResultApplied } from '../core/intake/applied-result';
import { publishedReviewDecision } from '../core/intake/result-application';
import { runSchema, submissionSchema, type Completion, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const HOST = 't3code:secondary';
const PR = 'https://github.com/example/repo/pull/7';
const ESCALATION = 'e'.repeat(64);
const PREREQUISITE = randomUUID(), WAIT_ID = randomUUID();

const profile = (id: string, model: string): Profile =>
  ({ id, name: id, provider: 'test', model, notes: '', available: true, problem: '', supportedThinking: [] });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-stale-owner-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const worker = profile('worker', 'test/worker'), reviewer = profile('reviewer', 'test/reviewer');
  const all = [worker, reviewer];
  store.setMeta('pool', all.map(item => ({ profileId: item.id, enabled: true, group: item.id,
    roles: [item.id === 'reviewer' ? 'reviewer' : 'worker'], weight: 'default', scopes: ['general'] })));
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Stale owner record', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), HOST, 'handoff', base);
  const observations = new Map<string, AgentObservation>();
  const idle = (id: string) =>
    observations.set(id, { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test' });
  const createdRuns: Run[] = [];
  const adapter = {
    hostId: HOST,
    profiles: async () => all, validate: async () => base, verifyWorkspace: async () => {},
    createWorkspace: async () => { throw new Error('fixtures do not create workspaces'); },
    findWorkspaces: async () => [], findAgents: async () => [],
    createAgent: async () => { throw new Error('fixtures do not create agents'); },
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test' },
    originAgent: async (id: string) => ({ id, workspaceId: 'workspace', title: id, archived: false }),
    archiveAgent: async () => {}, notify: async () => {}, findRunAgents: async () => [],
    verifyPr: async () => ({ head, url: PR }),
    verifyPrIdentity: async () => ({ head, url: PR }),
    verifyCleanQueueWorktree: async () => {}, verifyResume: async () => {},
    publishReview: async () => 4242, verifyReview: async () => 4242,
    coveringEvidence: async () => ({ head, base, wait: '' }), authorCommentEvidence: async () => '',
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {},
    createRun: async (_t: Task, r: Run) => { createdRuns.push(r); return { id: `agent-${r.id}`, workspaceId: r.workspaceId }; },
    sendRun: async (_t: Task, r: Run) => { createdRuns.push(r); },
    stopAgentTurn: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = all;
  // The service's rule for a secondary host (service/host-connections.ts): it is
  // available only inside its own host context; outside any context only the
  // primary host answers, and this one is not primary.
  engine.hostAvailable = (id: string) => engine.activeHostId === id;
  const current = () => store.task(submitted.id);
  const settle = async () => { await engine.wake(); await engine.quiesce(); };
  return {
    store, engine, taskId: submitted.id, profiles: { worker, reviewer }, current, settle, createdRuns, idle,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
type Fixture = ReturnType<typeof fixture>;

const reviewerRun = (taskId: string, id: string, changes: Partial<Run>): Run => runSchema.parse({
  id, taskId, role: 'reviewer', generation: 1, head, base, agentId: `agent-${id}`, workspaceId: 'workspace',
  hostId: HOST, profile: null, status: 'finished', createdAt: minutesAgo(30), lastObservedAt: null, active: false, idleSince: null,
  completion: null, released: true, ...changes,
});

/** A released reviewer whose authenticated comment verdict is still bound as the current run. */
function reportedCommentVerdict(f: Fixture, runId: string) {
  const completion = { taskId: f.taskId, runId, eventId: `${runId}-report`, status: 'ready_to_merge',
    summary: 'Reviewed the exact head', head, reviewCommentId: 7001 } as Completion;
  f.store.putRun(reviewerRun(f.taskId, runId, { profile: f.profiles.reviewer, completion, completionReceivedAt: minutesAgo(20) }));
  f.store.setCompletionReceipt(completion.eventId, f.taskId, runId, digest(JSON.stringify(f.store.run(runId)!.completion)),
    JSON.stringify({ accepted: true, eventId: completion.eventId }));
  f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: runId,
    reviewerAgentId: `agent-${runId}`, reviewerProfile: f.profiles.reviewer } });
}

const authorCompletion = (taskId: string) =>
  ({ taskId, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7, head }) as Completion;

test('an answered escalation wait whose prerequisite released and an owner move superseded is retired on a secondary host', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'reviewing', workspaceIntent: true, workspaceId: 'workspace', directory: null, agentIntent: true,
      agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      prUrl: PR, prHead: head, resumePrNumber: 7, completion: authorCompletion(f.taskId),
    });
    recordResultApplied(f.store, f.taskId, 'worker-run');
    // The stored ladder records: raised, answered with a task wait, then the wait released.
    f.store.event(f.taskId, 'planner_escalation', `${ESCALATION}: cause ${'c'.repeat(64)}; run worker-run; question q (10 chars); options Wait for a task`);
    f.store.event(f.taskId, 'planner_escalation_payload', `${ESCALATION}: ${JSON.stringify({ cause: 'c'.repeat(64), runId: 'worker-run', source: 'revision', refusal: 'failed_checks', question: 'Checks failed' })}`);
    f.store.event(f.taskId, 'planner_escalation_answer_pending', `${ESCALATION}: ${JSON.stringify({ questionId: `ns-escalation-${ESCALATION}`, who: 'planner', answer: 'Wait for a task', control: { kind: 'task', target: PREREQUISITE } })}`);
    f.store.event(f.taskId, 'planner_escalation_wait', `${ESCALATION}: ${JSON.stringify({ kind: 'task', target: PREREQUISITE, waitId: WAIT_ID })}`);
    f.store.event(f.taskId, 'planner_escalation_answered', `${ESCALATION}: answered by planner: Wait for a task`);
    f.store.event(f.taskId, 'planner_escalation_applied', `${ESCALATION}: waiting for task`);
    f.store.event(f.taskId, 'operator_control', 'move');
    f.store.event(f.taskId, 'prerequisite_wait_released', JSON.stringify({ waitId: WAIT_ID, waitsFor: [PREREQUISITE], reason: `Escalation ${ESCALATION}: waiting` }));
    reportedCommentVerdict(f, 'reported-review');
    const blocked = publishedReviewDecision(f.store, f.current());
    assert.equal(blocked.kind, 'blocked');
    assert.match(blocked.kind === 'blocked' ? blocked.refusal : '', /planner ladder still owns escalation/);

    await f.engine.resolution.resumeAskQuestions();
    const superseded = f.store.eventsAll(f.taskId).filter(event => event.kind === 'planner_escalation_wait_superseded');
    assert.equal(superseded.length, 1, 'the fleet pass reaches the task on its own host');
    assert.match(superseded[0]!.detail, new RegExp(`^${ESCALATION}: a later owner control changed the task`));
    assert.equal(publishedReviewDecision(f.store, f.current()).kind, 'ready', 'the ladder no longer blocks the verdict');
  } finally { await f.close(); }
});

test('an initial worker result whose binding was released before it applied goes through ordinary result application', async () => {
  const f = fixture(); try {
    f.idle('reviewer-agent');
    // The worker reported, then `run.release` (before nucleus#1551) cleared its binding.
    f.store.update(f.taskId, {
      phase: 'working', workspaceIntent: true, workspaceId: 'workspace', directory: null, agentIntent: false,
      agentId: null, runId: null, agentActive: false, profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      prUrl: null, prHead: head, completion: authorCompletion(f.taskId),
    });
    f.store.event(f.taskId, 'completion_received', 'Ready');
    f.store.event(f.taskId, 'owner_resolution', JSON.stringify({ command: 'run.release', arguments: { run: 'worker-run' } }));
    reportedCommentVerdict(f, 'reported-review');
    // The verdict's admission names the missing PR as the task's lifecycle wait (nucleus#462).
    await f.settle();
    let task = f.current();
    assert.equal(task.resolution.stop?.reason, 'lifecycle', JSON.stringify(task.resolution.stop));
    assert.match(task.resolution.stop?.detail ?? '', /forge and task owner must reconcile/);
    assert.equal(resultApplied(f.store, f.taskId, 'worker-run'), false);

    f.engine.taskQuantumOwner.orphanPhases.graceMs = 0;
    await f.settle();
    task = f.current();
    assert.equal(f.store.eventsAll(f.taskId).filter(event => event.kind === 'orphan_result_rebound').length, 1,
      JSON.stringify(f.store.eventsAll(f.taskId).slice(-10).map(event => `${event.kind}: ${event.detail.slice(0, 160)}`)));
    assert.equal(resultApplied(f.store, f.taskId, 'worker-run'), true, `${task.phase}: ${task.reason}`);
    assert.equal(task.prUrl, PR, 'the result recorded the PR it named, verified at the exact head');
    assert.equal(task.prHead, head);
    assert.notEqual(task.phase, 'working');
  } finally { await f.close(); }
});

/**
 * The same task one hour later: its lifecycle wait (the refused verdict's) had
 * launched a recovery coordinator that stopped without a result, so the episode
 * and its missing-callback incident escalated. Nothing an escalated episode or
 * its owner can apply settles the initial worker's report, so it must not hold it.
 */
test('an escalated recovery over the refused verdict wait does not hold the released initial worker result', async () => {
  const f = fixture(); try {
    f.store.patchRepository({ path: '/repo', origin: null }, { reviewer: { login: 'review-bot' } });
    f.idle('reviewer-agent');
    f.store.update(f.taskId, {
      phase: 'working', workspaceIntent: true, workspaceId: 'workspace', directory: null, agentIntent: false,
      agentId: null, runId: null, agentActive: false, profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      prUrl: null, prHead: head, completion: authorCompletion(f.taskId),
    });
    f.store.event(f.taskId, 'completion_received', 'Ready');
    f.store.event(f.taskId, 'owner_resolution', JSON.stringify({ command: 'run.release', arguments: { run: 'worker-run' } }));
    reportedCommentVerdict(f, 'first-review');
    reportedCommentVerdict(f, 'reported-review');
    const incident = 'd'.repeat(64);
    f.store.putRun(runSchema.parse({
      id: 'recovery-run', taskId: f.taskId, role: 'recovery', generation: 1, head, base, agentId: 'recovery-agent',
      workspaceId: 'workspace', hostId: HOST, profile: null, status: 'finished', createdAt: minutesAgo(25), lastObservedAt: null,
      active: false, idleSince: null, completion: null, released: true,
    }));
    const stopped = 'The recovery coordinator stopped without a result. Inspect its thread; the plugin has not repeated its prompt.';
    f.store.update(f.taskId, { resolution: { ...f.current().resolution,
      stop: { reason: 'lifecycle', detail: 'The forge and task owner must reconcile the canonical PR and exact verdict head',
        since: minutesAgo(45), suggestedVerbs: [], fact: null },
      recovery: { id: randomUUID(), key: 'k'.repeat(64), generation: 1, runId: 'recovery-run', agentId: 'recovery-agent',
        status: 'escalated', summary: stopped, idleSince: null, incidentId: incident },
      incident: { id: incident, fingerprint: incident, role: 'worker', runId: null, turnId: null, attempt: 0,
        cause: 'missing_callback', detail: stopped, action: '', status: 'escalated', createdAt: minutesAgo(15), updatedAt: minutesAgo(15) },
    } } as Partial<Task>);
    f.store.event(f.taskId, 'recovery_escalated', stopped);

    f.engine.taskQuantumOwner.orphanPhases.graceMs = 0;
    await f.settle();
    const task = f.current();
    assert.equal(f.store.eventsAll(f.taskId).filter(event => event.kind === 'orphan_result_rebound').length, 1,
      JSON.stringify(f.store.eventsAll(f.taskId).slice(-10).map(event => `${event.kind}: ${event.detail.slice(0, 160)}`)));
    assert.equal(resultApplied(f.store, f.taskId, 'worker-run'), true, `${task.phase}: ${task.reason}`);
    assert.equal(task.prUrl, PR, 'the result recorded the PR it named, verified at the exact head');
    assert.notEqual(task.phase, 'working');
    // The comment-only verdict can never apply in a formal-review repository: it
    // is superseded and a fresh formal reviewer reads the exact head.
    await f.settle();
    assert.ok(f.store.eventsAll(f.taskId).some(event => event.kind === 'reported_verdict_superseded'));
    const fresh = f.createdRuns.filter(run => run.role === 'reviewer');
    assert.equal(fresh.length, 1, `${f.current().phase}: ${f.current().reason}`);
    assert.equal(fresh[0]!.head, head);
    assert.equal(f.store.run(fresh[0]!.id)?.formalReview, true);
  } finally { await f.close(); }
});

test('a recovered no-action observation that settles its incident ends the attention, and review is admitted', async () => {
  const f = fixture(); try {
    const incident = 'f'.repeat(64);
    f.store.update(f.taskId, {
      phase: 'awaiting_review', workspaceIntent: true, workspaceId: 'workspace', directory: null, agentIntent: true,
      agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      prUrl: PR, prHead: head, resumePrNumber: 7, completion: authorCompletion(f.taskId),
    });
    recordResultApplied(f.store, f.taskId, 'worker-run');
    const recoveryRun = runSchema.parse({
      id: 'recovery-run', taskId: f.taskId, role: 'recovery', generation: 1, head, base, agentId: 'recovery-agent',
      workspaceId: 'workspace', hostId: HOST, profile: null, status: 'running', createdAt: minutesAgo(5), lastObservedAt: null,
      active: false, idleSince: null, completion: null, released: false,
    });
    f.store.putRun(recoveryRun);
    const action = {
      eventId: 'recovery-report', runId: 'recovery-run', reportStatus: 'recovered' as const,
      coordinatorAction: { verb: 'none' as const, reason: 'no action: scheduler to dispatch independent review' },
      summary: 'PR head recorded and matches author head; scheduler to dispatch reviewer.', status: 'pending' as const,
    };
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, attention: true, recoveryActive: true,
      recovery: { id: randomUUID(), key: 'k'.repeat(64), generation: 1, runId: 'recovery-run', agentId: 'recovery-agent',
        status: 'running', summary: 'Recovery running', idleSince: null, incidentId: incident, action },
      incident: { id: incident, role: 'reviewer', runId: 'worker-run', turnId: null, fingerprint: incident, attempt: 0,
        cause: 'repository_identity', detail: 'GraphQL rate limit', action: '', status: 'reconciling',
        createdAt: minutesAgo(10), updatedAt: minutesAgo(10) } } } as Partial<Task>);

    f.engine.resolution.recovery.settleObservedNoAction(f.current(), f.store.run('recovery-run')!, action);
    const task = f.current();
    assert.equal(task.resolution.recovery?.status, 'resolved');
    assert.equal(task.resolution.incident?.status, 'resolved');
    assert.equal(task.resolution.attention, false, 'a resolved episode never leaves its attention behind');

    await f.settle();
    assert.ok(f.createdRuns.some(run => run.role === 'reviewer'),
      `the reviewer was admitted: ${JSON.stringify({ phase: f.current().phase, reason: f.current().reason })}`);
  } finally { await f.close(); }
});

test('a blocked no-action observation keeps the attention it was opened for', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, { phase: 'awaiting_review', workspaceIntent: true, workspaceId: 'workspace', directory: null,
      agentId: 'worker-agent', runId: 'worker-run', prUrl: PR, prHead: head, completion: authorCompletion(f.taskId) });
    f.store.putRun(runSchema.parse({
      id: 'recovery-run', taskId: f.taskId, role: 'recovery', generation: 1, head, base, agentId: 'recovery-agent',
      workspaceId: 'workspace', hostId: HOST, profile: null, status: 'running', createdAt: minutesAgo(5), lastObservedAt: null,
      active: false, idleSince: null, completion: null, released: false,
    }));
    const action = { eventId: 'recovery-report', runId: 'recovery-run', reportStatus: 'blocked' as const,
      coordinatorAction: { verb: 'none' as const, reason: 'cannot settle' }, summary: 'Still rate limited', status: 'pending' as const };
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, attention: true, recoveryActive: true,
      recovery: { id: randomUUID(), key: 'k'.repeat(64), generation: 1, runId: 'recovery-run', agentId: 'recovery-agent',
        status: 'running', summary: 'Recovery running', idleSince: null, incidentId: null, action } } } as Partial<Task>);
    f.engine.resolution.recovery.settleObservedNoAction(f.current(), f.store.run('recovery-run')!, action);
    assert.equal(f.current().resolution.recovery?.status, 'resolved');
    assert.equal(f.current().resolution.attention, true);
  } finally { await f.close(); }
});
