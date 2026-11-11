import { fakeAdapter, profile } from './support/fakes';
/**
 * Row X5d send-boundary pin: a throw at each effect of delivery leaves the
 * record that effect wrote. The reservation already wrote the run intent, its
 * credential and its slot charge; every step after it is a separate effect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, digest } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema, type Completion, type Profile, type Run } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { ABSENT_RESOLUTION_REASON, ProvenPreSendRefusalError } from '../core/recovery/task-reasons';
import { queueOperationSchema } from '../shared/operations';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const prUrl = 'https://github.com/example/repo/pull/1';


function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'run-launch-deliver-'));
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
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => [worker, reviewer], validate: async () => base, verifyWorkspace: async t => t.branch,
    createWorkspace: async () => { throw new Error('Delivery must not create workspaces'); },
    createAgent: async () => { throw new Error('No initial dispatch'); },
    observe: async id => { const state = states.get(id); if (!state) throw new Error('Agent missing'); return state; },
     stopAgentTurn: async () => {},
    agentTimelinePage: async () => ({ entries: [], hasOlder: false, hasNewer: false, gap: false, staleCursor: false, reset: false, epoch: 'fixture', projection: 'projected', startCursor: null, endCursor: null }),
    verifyPr: async () => ({ head, url: prUrl }), verifyPrIdentity: async () => ({ head, url: prUrl }),
    verifyCleanQueueWorktree: async () => {}, coveringEvidence: async () => ({ head, base, wait: '' }),
    authorCommentEvidence: async () => '',
    createRun: async (_t, run) => ({ id: `agent-${run.id}`, workspaceId: run.workspaceId }),
    sendRun: async () => {},
    findRunAgents: async () => [], verifyReview: async () => {},
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }),
    syncMain: async () => base, verifyCloseout: async () => {}, notify: async () => {},
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker, reviewer];
  return {
    dir, store, engine, adapter, task, worker, reviewer,
    current: () => store.task(task.id),
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** The reservation's durable record, without running the reservation. */
function reserved(f: ReturnType<typeof fixture>, overrides: Partial<Run> = {}) {
  const run: Run = {
    id: randomUUID(), taskId: f.task.id, role: 'reviewer', generation: 0, head, base,
    agentId: null, workspaceId: 'workspace', profile: f.reviewer, status: 'intent',
    createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null,
    completion: null, released: false, ...overrides,
  };
  const token = `token-${run.id}`;
  f.store.setCredential(run.id, token);
  f.store.putRun(run);
  f.store.update(f.task.id, { resolution: { ...f.current().resolution, currentRunId: run.id } }, 'run_intent', 'Dispatching reviewer');
  const context = { agentId: run.agentId, profile: f.reviewer, group: 'review', workspaceId: 'workspace', firstReviewEntryWorker: false, nonDeliveryReplacement: false, run, token };
  return { run, token, context };
}

const credential = (store: Store, runId: string) => store.db.prepare('SELECT hash FROM credentials WHERE run=?').get(runId) ?? null;

/** The settled earlier round an ordinary detached review needs before it may send. */
function earlierRound(f: ReturnType<typeof fixture>) {
  const completion: Completion = { taskId: f.task.id, runId: 'prior-review', eventId: 'prior-review-result', status: 'changes_required', summary: 'Fix', head, reviewCommentId: 1, reviewResponsibility: 'author' };
  const prior: Run = {
    id: 'prior-review', taskId: f.task.id, role: 'reviewer', generation: 0, head, base,
    agentId: 'reviewer-agent', workspaceId: 'workspace', profile: f.reviewer, status: 'finished',
    createdAt: new Date(Date.now() - 2000).toISOString(), lastObservedAt: null, active: false, idleSince: null,
    completion, released: true,
  };
  f.store.putRun(prior);
  f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)')
    .run(completion.eventId, f.task.id, prior.id, digest(JSON.stringify(completion)), JSON.stringify({ accepted: true, eventId: completion.eventId }));
  return prior;
}

test('a throw at sendRun on a retained thread leaves the intent, its credential and the exact-lookup incident', async () => {
  const f = fixture();
  try {
    const { run, token, context } = reserved(f, { agentId: 'reviewer-agent' });
    f.adapter.sendRun = async () => { throw new Error('boom at sendRun'); };
    await assert.rejects(() => f.engine.resolution.deliverLaunchRun(f.current(), 'reviewer', context), /boom at sendRun/);
    assert.equal(f.store.run(run.id)?.status, 'uncertain');
    assert.equal(f.store.run(run.id)?.agentId, 'reviewer-agent');
    assert.ok(credential(f.store, run.id));
    assert.equal(f.current().resolution.currentRunId, run.id);
    assert.equal(f.current().resolution.incident?.action, 'exact_lookup');
    assert.equal(f.current().resolution.incident?.detail, ABSENT_RESOLUTION_REASON);
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'run_intent'));
    assert.ok(token);
  } finally { await f.close(); }
});

test('a throw at createRun leaves the intent and its credential', async () => {
  const f = fixture();
  try {
    const { run, context } = reserved(f);
    f.adapter.createRun = async () => { throw new Error('boom at createRun'); };
    await assert.rejects(() => f.engine.resolution.deliverLaunchRun(f.current(), 'reviewer', context), /boom at createRun/);
    assert.equal(f.store.run(run.id)?.status, 'uncertain');
    assert.ok(credential(f.store, run.id));
    assert.equal(f.current().resolution.currentRunId, run.id);
    assert.equal(f.current().resolution.incident?.action, 'exact_lookup');
  } finally { await f.close(); }
});

test('a throw after creation keeps the agent the run bound before it', async () => {
  const f = fixture();
  try {
    const { run, context } = reserved(f);
    f.adapter.createRun = async () => ({ id: 'agent-created', workspaceId: 'elsewhere' });
    await assert.rejects(() => f.engine.resolution.deliverLaunchRun(f.current(), 'reviewer', context), /Created run is in the wrong workspace/);
    assert.equal(f.store.run(run.id)?.agentId, 'agent-created');
    assert.equal(f.store.run(run.id)?.status, 'uncertain');
    assert.ok(credential(f.store, run.id));
    assert.equal(f.current().resolution.reviewerAgentId ?? null, null);
    assert.equal(f.current().resolution.incident?.action, 'exact_lookup');
  } finally { await f.close(); }
});

test('a prompt-too-large refusal leaves its pre-send receipt and rethrows the typed refusal', async () => {
  const f = fixture();
  try {
    const { run, context } = reserved(f);
    f.adapter.createRun = async () => { throw new Error('prompt is too long: maximum context length exceeded'); };
    await assert.rejects(() => f.engine.resolution.deliverLaunchRun(f.current(), 'reviewer', context), (error: unknown) =>
      error instanceof ProvenPreSendRefusalError && /Review prompt refused before send for size/.test(error.message));
    assert.equal(f.store.run(run.id)?.status, 'superseded');
    assert.equal(f.store.run(run.id)?.released, true);
    assert.equal(credential(f.store, run.id), null);
    assert.equal(f.current().resolution.currentRunId, null);
    assert.equal(f.current().resolution.attention, true);
    assert.equal(f.current().phase, 'needs_attention');
    assert.match(f.current().reason, /Review prompt refused before send for size/);
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'review_prompt_refused_before_send'));
  } finally { await f.close(); }
});

test('a pre-send failure on an ordinary round settles the refusal without sending', async () => {
  const f = fixture();
  try {
    const prior = earlierRound(f);
    const { run, context } = reserved(f, { ordinaryDetached: true, priorRunId: prior.id });
    // The checkout named by the task does not exist, so the exact-head proof is
    // the first thing to refuse; nothing of this round was sent.
    await f.engine.resolution.deliverLaunchRun(f.current(), 'reviewer', context);
    assert.equal(f.store.run(run.id)?.status, 'superseded');
    assert.equal(f.store.run(run.id)?.released, true);
    assert.equal(credential(f.store, run.id), null);
    assert.equal(f.current().resolution.currentRunId, null);
    assert.equal(f.current().resolution.attention, true);
    assert.equal(f.current().phase, 'needs_attention');
    assert.match(f.current().reason, /^Ordinary review reviewer refused before send:/);
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'ordinary_review_refused_before_send'));
  } finally { await f.close(); }
});

test('a blocking recovery effect settles the run as superseded and hands the wait back', async () => {
  const f = fixture();
  try {
    const prior = earlierRound(f);
    const { run, context } = reserved(f, { ordinaryDetached: true, priorRunId: prior.id });
    f.store.putOperation(queueOperationSchema.parse({
      id: 'c'.repeat(64), key: 'pending-effect', kind: 'task_control', inputHash: 'a'.repeat(64), state: 'pending',
      taskId: f.task.id, expectedVersion: null, repoPath: '/repo', submissionId: null, createdAt: new Date().toISOString(),
      startedAt: null, settledAt: null, attempts: 0, diagnostic: '', result: null, effect: null,
    }));
    await f.engine.resolution.deliverLaunchRun(f.current(), 'reviewer', context);
    assert.equal(f.store.run(run.id)?.status, 'superseded');
    assert.equal(f.store.run(run.id)?.released, true);
    assert.equal(f.store.run(run.id)?.active, false);
    assert.equal(f.current().resolution.currentRunId, null);
    assert.equal(f.current().resolution.attention, false);
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'review_waiting_on_effects'));
    assert.match(f.current().reason, /settle it with retry_effect/);
  } finally { await f.close(); }
});

test('a delivered run binds its agent and settles running', async () => {
  const f = fixture();
  try {
    const { run, context } = reserved(f);
    f.adapter.createRun = async (_t, sent) => ({ id: `agent-${sent.id}`, workspaceId: sent.workspaceId });
    await f.engine.resolution.deliverLaunchRun(f.current(), 'reviewer', context);
    assert.equal(f.store.run(run.id)?.agentId, `agent-${run.id}`);
    assert.equal(f.store.run(run.id)?.status, 'running');
    assert.equal(f.current().resolution.reviewerAgentId, `agent-${run.id}`);
    assert.equal(f.current().resolution.reviewerProfile?.id, f.reviewer.id);
    assert.equal(f.current().resolution.incident ?? null, null);
  } finally { await f.close(); }
});

test('retained send keeps the guard immediately before the native send', async () => {
  const f = fixture();
  try {
    const { run, token } = reserved(f, { agentId: 'reviewer-agent' });
    const order: string[] = [];
    const { sendRunVia } = await import('../core/dispatch/run-launch/send');
    await sendRunVia({
      helperPath: '/helper',
      scratchPlacement: () => ({ mount: f.dir, root: f.dir, create: () => { order.push('scratch'); }, remove: () => false }),
      retainedAgentRef: () => ({
        workspaceId: 'workspace', archivedAt: null, status: 'idle', activeTurn: null, pendingPermissions: [], runtimeInfo: null,
        refresh: async () => { order.push('refresh'); },
        current: () => ({ labels: { 'nucleus.mcpBinding': 'key' } }),
        send: async () => { order.push('send'); },
      }),
      binding: () => { order.push('binding'); },
      ticket: () => { order.push('ticket'); return '/ticket'; },
      continueReviewer: async () => { throw Error('unexpected ordinary send'); },
    }, f.current(), run, token, null, null, {
      allowed: async () => { order.push('allowed'); return true; },
      stillAllowed: () => { order.push('stillAllowed'); return true; },
    });
    assert.deepEqual(order, ['scratch', 'refresh', 'binding', 'ticket', 'allowed', 'stillAllowed', 'send']);
  } finally { await f.close(); }
});
