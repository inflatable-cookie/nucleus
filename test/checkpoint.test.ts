import { fakeAdapter, profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CURRENT_SCHEMA, Store, digest } from '../core/store/store';
import { Engine } from '../core/engine';
import { workerPrompt } from '../core/dispatch/prompts';
import { startCallbacks } from '../service/callbacks/callback';
import { checkpointPrompt } from '../core/dispatch/prompts';
import { runPrompt } from '../core/dispatch/prompts';
import { CHECKPOINT_BUDGET, checkpointStateSchema, completionSchema, submissionSchema, taskSchema, type CheckpointIntent, type CheckpointResult, type Profile, type Run, type Task } from '../shared/contracts';
import { reportSchema } from '../core/intake/report';
import type { Adapter } from '../core/host';
import { deriveTaskTelemetry, telemetrySnapshot } from '../core/telemetry/telemetry';
import { checkpointStateLabel } from '../shared/task-state';

const base = 'b'.repeat(40), headOne = 'c'.repeat(40), headTwo = 'd'.repeat(40), headThree = 'e'.repeat(40), headFour = 'f'.repeat(40);


function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-checkpoint-')), store = new Store(join(dir, 'queue.sqlite'));
  const worker = profile('worker');
  store.setMeta('paused', false);
  store.setMeta('pool', [{ profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] }]);
  const continuations: { intentId: string; text: string }[] = [], createdRuns: Run[] = [], reminders: string[] = [];
  let verify: (task: Task, head: string) => Promise<void> = async () => {};
  let workspacePreflight: () => Promise<{ available: true } | { available: false; reason: string }> = async () => ({ available: true });
  const adapter = fakeAdapter({
    profiles: async () => [worker], validate: async (t: Task) => t.planningBase, createWorkspace: async () => { throw new Error('fixtures do not create workspaces'); },
     verifyWorkspace: async (t: Task) => t.branch, createAgent: async () => { throw new Error('fixtures do not create agents'); },
     observe: async () => ({ id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' }),
     verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/1', head: headOne }),
    notify: async (id: string, key: string) => { reminders.push(`${id}:${key}`); },
    findRunAgents: async () => [],
    createRun: async (t: Task, r: Run, token: string) => { createdRuns.push(r); return { id: `agent-${r.id}`, workspaceId: r.workspaceId }; },
    sendRun: async () => {}, verifyReview: async () => {}, mergeGate: async () => ({ head: headOne, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head: headOne, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {},
    verifyCheckpoint: (t: Task, head: string) => verify(t, head),
    preflightWorkerContinuation: () => workspacePreflight(),
    continueWorker: async (_t: Task, intentId: string, text: string) => { continuations.push({ intentId, text }); },
  } as unknown as Adapter);
  const engine = new Engine(store, adapter, 0); engine.profiles = [worker];
  const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Bounded checkpoint', repoPath: '/repo', planningCommit: base, handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  const taskId = submitted.id, runId = `run-${taskId}`, token = 'checkpoint-token';
  store.update(taskId, { phase: 'working', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree', agentId: 'worker', runId, profile: worker, workerModel: worker.model, agentActive: true, lastAgentStatus: 'running', lastObservedAt: new Date().toISOString() });
  store.setCredential(runId, token);
  let sequence = 0;
  const checkpoint = async (summary: string, head: string, eventId = `cp-${++sequence}`) =>
    await engine.complete({ eventId, taskId, runId, status: 'progress_checkpoint', summary, head }, token) as CheckpointResult;
  const current = () => store.task(taskId);
  const events = (kind: string) => store.events(taskId).filter(event => event.kind === kind);
  return { dir, store, engine, adapter, worker, submitted, taskId, runId, token, checkpoint, current, events, continuations, createdRuns, reminders,
    setVerify: (fn: (task: Task, head: string) => Promise<void>) => { verify = fn; },
    setWorkspacePreflight: (fn: typeof workspacePreflight) => { workspacePreflight = fn; },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function accept(f: ReturnType<typeof fixture>, summary: string, head: string, eventId?: string) {
  const receipt = await f.checkpoint(summary, head, eventId);
  await f.engine.wake(); await f.engine.wake();
  return receipt;
}

test('a clean pushed partial head continues the exact retained worker without a coordinator', async () => {
  const f = fixture(); try {
    const intent = await accept(f, 'Parser and migrations landed', headOne);
    assert.equal(intent.accepted, true);
    assert.deepEqual(intent.checkpoint, { ordinal: 1, budget: CHECKPOINT_BUDGET, continued: true });
    const task = f.current();
    assert.equal(task.checkpoints.records.length, 1);
    assert.equal(task.checkpoints.records[0].head, headOne);
    assert.equal(task.checkpoints.intent?.status, 'delivered');
    assert.ok(task.checkpoints.intent?.deliveredAt);
    assert.equal(task.agentId, 'worker'); assert.equal(task.workspaceId, 'workspace'); assert.equal(task.branch, f.submitted.branch);
    assert.equal(task.runId, f.runId); assert.equal(task.completion, null);
    // One continuation turn; no coordinator, reviewer, new agent, workspace or branch.
    assert.equal(f.continuations.length, 1);
    assert.equal(f.continuations[0].intentId, task.checkpoints.intent!.id);
    assert.equal(f.createdRuns.length, 0);
    assert.equal(f.store.runs(f.taskId).length, 0);
    assert.equal(f.events('progress_checkpoint').length, 1);
    assert.equal(f.events('checkpoint_continued').length, 1);
    assert.match(f.continuations[0].text, /Parser and migrations landed/);
    assert.match(f.continuations[0].text, new RegExp(f.submitted.branch));
  } finally { await f.close(); }
});

test('duplicate deliveries reconcile one ordinal and one continuation', async () => {
  const f = fixture(); try {
    const first = await accept(f, 'First milestone', headOne);
    const replay = await f.checkpoint('First milestone', headOne, `cp-1`);
    assert.deepEqual(replay, first);
    assert.equal(f.current().checkpoints.records.length, 1);
    assert.equal(f.continuations.length, 1);
    assert.equal(f.events('checkpoint_continued').length, 1);
    // A different event id with identical evidence is a duplicate of the closed turn, not a new one.
    await assert.rejects(f.checkpoint('First milestone', headOne), /already accepted/);
    assert.equal(f.current().checkpoints.records.length, 1);
    assert.equal(f.continuations.length, 1);
  } finally { await f.close(); }
});

test('restart reconciliation resumes one persisted intent with the same message identity', async () => {
  const f = fixture(); try {
    await accept(f, 'Durable partial', headOne);
    const intent = f.current().checkpoints.intent!;
    // Simulate a crash after the intent was persisted but before delivery confirmation was stored.
    f.store.update(f.taskId, { checkpoints: { ...f.current().checkpoints, intent: { ...intent, status: 'pending', deliveredAt: null } } });
    const restarted = new Engine(f.store, f.adapter, 0); restarted.profiles = [f.worker];
    try {
      await restarted.wake(); await restarted.wake();
      const current = f.current();
      assert.equal(current.checkpoints.records.length, 1);
      assert.equal(current.checkpoints.intent?.ordinal, 1);
      assert.equal(current.checkpoints.intent?.status, 'delivered');
      // One persisted intent, one turn identity: both attempts reuse the same message id.
      assert.equal(f.continuations.length, 2);
      assert.equal(f.continuations[0].intentId, f.continuations[1].intentId);
      assert.equal(f.continuations[0].intentId, intent.id);
      assert.equal(f.events('progress_checkpoint').length, 1);
      await restarted.wake();
      assert.equal(f.continuations.length, 2);
    } finally { await restarted.stop(); }
  } finally { await f.close(); }
});

test('an archived retained workspace is recorded before any deferred checkpoint continuation is sent', async () => {
  const f = fixture(); try {
    f.setWorkspacePreflight(async () => ({ available: false, reason: 'Retained worker workspace workspace was archived or removed before continuation dispatch; no continuation was sent' }));
    await f.checkpoint('Partial work', headOne);
    await f.engine.wake();

    const intent = f.current().checkpoints.intent!;
    assert.equal(intent.status, 'uncertain');
    assert.equal(intent.attempts, 0, 'a failed preflight consumes no delivery attempt');
    assert.match(intent.error, /archived or removed before continuation dispatch/);
    assert.equal(f.continuations.length, 0, 'the worker receives no message after its worktree disappears');
    assert.equal(f.current().phase, 'needs_attention');
    assert.match(f.current().reason, /was not sent/);
    assert.match(f.events('checkpoint_continuation_preflight_failed')[0].detail, /workspace was archived or removed/);
  } finally { await f.close(); }
});

test('an unavailable workspace preflight defers delivery without consuming the checkpoint attempt', async () => {
  const f = fixture(); try {
    f.setWorkspacePreflight(async () => { throw new Error('Paseo is temporarily unavailable'); });
    await f.checkpoint('Partial work', headOne);
    await f.engine.wake();

    const intent = f.current().checkpoints.intent!;
    assert.equal(intent.status, 'pending');
    assert.equal(intent.attempts, 0);
    assert.equal(f.continuations.length, 0);
    assert.match(f.events('checkpoint_continuation_preflight_deferred')[0].detail, /temporarily unavailable/);
  } finally { await f.close(); }
});

test('dirty work and an unpushed head fail closed through existing recovery', async () => {
  const f = fixture(); try {
    f.setVerify(async () => { throw new Error('Bounded checkpoint requires a clean worktree; commit or report blocked instead'); });
    await assert.rejects(f.checkpoint('Dirty', headOne), /clean worktree/);
    assert.equal(f.current().checkpoints.records.length, 0);
    assert.equal(f.continuations.length, 0);
    f.setVerify(async () => { throw new Error(`Bounded checkpoint head ${headOne} is not the exact pushed queue-branch head`); });
    await assert.rejects(f.checkpoint('Unpushed', headOne), /not the exact pushed queue-branch head/);
    assert.equal(f.current().checkpoints.records.length, 0);
    assert.equal(f.current().checkpoints.intent, null);
    // The failure leaves the task on its ordinary working path: no completion, no attention rewrite.
    assert.equal(f.current().phase, 'working');
    assert.equal(f.current().completion, null);
  } finally { await f.close(); }
});

test('a checkpoint is rejected for another role, an unrecognised run, an accepted PR or a settled turn', async () => {
  const f = fixture(); try {
    // A revision row that is not the task's current run is stale history, never a checkpoint.
    f.store.putRun({ id: f.runId, taskId: f.taskId, role: 'revision', generation: 1, head: headOne, base, agentId: 'worker', workspaceId: 'workspace', profile: f.worker, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false });
    await assert.rejects(f.checkpoint('Wrong role', headOne), /Stale worker run/);
    assert.equal(f.current().checkpoints.records.length, 0);
    f.store.putRun({ id: 'reviewer-run', taskId: f.taskId, role: 'reviewer', generation: 1, head: headOne, base, agentId: 'reviewer', workspaceId: 'workspace', profile: f.worker, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false });
    f.store.setCredential('reviewer-run', 'reviewer-token');
    await assert.rejects(f.engine.complete({ eventId: 'cp-reviewer', taskId: f.taskId, runId: 'reviewer-run', status: 'progress_checkpoint', summary: 'A reviewer cannot checkpoint here', head: headOne }, 'reviewer-token'), /only valid for the task worker or its current revision run/);
    assert.equal(f.current().checkpoints.records.length, 0);
  } finally { await f.close(); }
  const g = fixture(); try {
    g.store.update(g.taskId, { prUrl: 'https://github.com/example/repo/pull/7', prHead: headOne });
    await assert.rejects(g.checkpoint('After PR', headOne), /before an accepted PR/);
    g.store.update(g.taskId, { prUrl: null, prHead: null, completion: { eventId: 'settled', taskId: g.taskId, runId: g.runId, status: 'blocked', summary: 'Stopped' } });
    await assert.rejects(g.checkpoint('After result', headOne), /Stale worker run/);
    assert.equal(g.current().checkpoints.records.length, 0);
    assert.equal(g.continuations.length, 0);
  } finally { await g.close(); }
});

/** Move the fixture's task onto one current, unreleased revision run in the retained workspace. */
function revision(f: ReturnType<typeof fixture>) {
  const id = 'revision-run';
  f.store.putRun({ id, taskId: f.taskId, role: 'revision', generation: 1, head: headOne, base, agentId: 'worker', workspaceId: 'workspace',
    profile: f.worker, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false });
  f.store.setCredential(id, 'revision-token');
  f.store.update(f.taskId, { phase: 'changes_requested', prUrl: 'https://github.com/example/repo/pull/7', prHead: headOne, resumePrNumber: 7,
    completion: { eventId: 'initial-ready', taskId: f.taskId, runId: f.runId, status: 'ready_for_review', summary: 'Initial delivery', prNumber: 7, head: headOne },
    resolution: { ...f.current().resolution, currentRunId: id } });
  return { id, token: 'revision-token' };
}

test('a current revision run checkpoints on the task budget and continues on its own run', async () => {
  const f = fixture(); try {
    await accept(f, 'Initial parser landed', headOne);
    assert.equal(f.current().checkpoints.records.length, 1);
    const run = revision(f);
    const receipt = await f.engine.complete({ eventId: 'cp-revision', taskId: f.taskId, runId: run.id, status: 'progress_checkpoint',
      summary: 'Review fixes: half the findings are applied', head: headTwo }, run.token) as CheckpointResult;
    // The budget is the task's: the revision's receipt carries the shared ordinal.
    assert.deepEqual(receipt.checkpoint, { ordinal: 2, budget: CHECKPOINT_BUDGET, continued: true });
    await f.engine.wake(); await f.engine.wake();
    const task = f.current();
    assert.equal(task.checkpoints.records.length, 2);
    assert.equal(task.checkpoints.records[1].runId, run.id);
    assert.equal(task.checkpoints.intent?.runId, run.id);
    assert.equal(task.checkpoints.intent?.status, 'delivered');
    assert.equal(task.agentId, 'worker');
    assert.equal(task.resolution.currentRunId, run.id, 'the same run continues; no new run or agent');
    assert.equal(f.createdRuns.length, 0);
    assert.equal(f.store.runs(f.taskId).length, 1);
    assert.equal(f.continuations.length, 2);
    assert.match(f.continuations[1].text, new RegExp(`run ID: ${run.id}`), 'the continuation names the revision run');
    assert.match(f.continuations[1].text, /review fixes: half the findings are applied/i);
  } finally { await f.close(); }
});

test('a revision checkpoint past the shared task budget reaches attention without a turn', async () => {
  const f = fixture(); try {
    await accept(f, 'One', headOne);
    await accept(f, 'Two', headTwo);
    const run = revision(f);
    await f.engine.complete({ eventId: 'cp-revision-finish', taskId: f.taskId, runId: run.id, status: 'progress_checkpoint',
      summary: 'Three', head: headThree }, run.token);
    await f.engine.wake(); await f.engine.wake();
    assert.equal(f.current().checkpoints.records.length, 3);
    const fourth = await f.engine.complete({ eventId: 'cp-revision-fourth', taskId: f.taskId, runId: run.id, status: 'progress_checkpoint',
      summary: 'Four', head: headFour }, run.token) as CheckpointResult;
    assert.equal(fourth.checkpoint.continued, false);
    assert.equal(f.current().checkpoints.records.length, 3);
    assert.equal(f.continuations.length, 3, 'a fourth checkpoint sends no continuation');
    assert.match(f.current().reason, /beyond the bounded budget/);
  } finally { await f.close(); }
});

test('three checkpoints continue and the fourth reaches needs attention without a turn', async () => {
  const f = fixture(); try {
    await accept(f, 'One', headOne);
    await accept(f, 'Two', headTwo);
    await accept(f, 'Three', headThree);
    assert.equal(f.current().checkpoints.records.length, 3);
    assert.equal(f.continuations.length, 3);
    const fourth = await f.checkpoint('Four', headFour);
    assert.equal(fourth.accepted, true);
    assert.equal(fourth.checkpoint.ordinal, 3);
    assert.equal(fourth.checkpoint.budget, CHECKPOINT_BUDGET);
    assert.equal(fourth.checkpoint.continued, false);
    assert.match(String(fourth.checkpoint.attention), /beyond the bounded budget/);
    await f.engine.wake(); await f.engine.wake();
    const task = f.current();
    assert.equal(task.checkpoints.records.length, 3);
    assert.equal(f.continuations.length, 3);
    assert.equal(task.resolution.attention, true);
    assert.match(f.events('checkpoint_rejected')[0].detail, /beyond the bounded budget of 3/);
    assert.match(String(task.resolution.incident?.detail), /beyond the bounded budget/);
    assert.equal(f.events('checkpoint_rejected').length, 1);
    assert.equal(f.createdRuns.length, 0);
  } finally { await f.close(); }
});

test('checkpoint receipts and continuation turns stay outside recovery, revision and administration counters', async () => {
  const f = fixture(); try {
    await accept(f, 'One', headOne);
    await accept(f, 'Two', headTwo);
    const task = f.current();
    const telemetry = deriveTaskTelemetry(task, f.store.eventsAll(f.taskId), f.store.runs(f.taskId), f.store.notices(f.taskId), []);
    assert.equal(telemetry.interventions.checkpoints, 2);
    assert.equal(telemetry.interventions.checkpointContinuations, 2);
    assert.equal(telemetry.interventions.recoveryRuns, 0);
    assert.equal(telemetry.interventions.revisions, 0);
    assert.equal(telemetry.interventions.administrativeRevisions, 0);
    assert.equal(telemetry.interventions.replacements, 0);
    assert.equal(telemetry.interventions.operatorActions.length, 0);
    // Checkpoint time stays worker active time and does not create an intervention task.
    assert.equal(telemetry.currentStage, 'worker_active');
    assert.ok(telemetry.stages.some(stage => stage.stage === 'worker_active' && stage.elapsedMs > 0));
    const group = telemetrySnapshot(f.store, { window: 'all' }).groups[0];
    assert.equal(group.interventions.checkpoints, 2);
    assert.equal(group.interventions.checkpointContinuations, 2);
    assert.equal(group.interventionTaskCount, 0);
  } finally { await f.close(); }
});

test('worker and continuation instructions expose the bounded outcome without expanding scope', async () => {
  const f = fixture(); try {
    const task = f.current();
    const prompt = workerPrompt(task, true);
    assert.match(prompt, /progress_checkpoint/);
    assert.match(prompt, /exact local head/);
    assert.match(prompt, /at most three per task/);
    const intent: CheckpointIntent = { id: 'intent-1', ordinal: 2, summary: 'Migrations landed', head: headOne, runId: f.runId, eventId: 'event-1', status: 'pending', createdAt: '2026-09-15T10:00:00.000Z', deliveredAt: null, attempts: 0, error: '' };
    const continuation = checkpointPrompt(task, intent);
    assert.match(continuation, /Migrations landed/);
    assert.match(continuation, new RegExp(headOne));
    assert.match(continuation, new RegExp(f.submitted.branch));
    assert.match(continuation, /Do not change scope/);
    assert.match(continuation, /progress_checkpoint/);
    assert.match(continuation, new RegExp(`2/${CHECKPOINT_BUDGET}`));
    // Resolution runs never gain the checkpoint authority.
    const revision = runPrompt(task, { id: 'rev', role: 'revision', generation: 1, head: headOne } as Run, '/helper', '/ticket', true);
    assert.doesNotMatch(revision, /progress_checkpoint/);
  } finally { await f.close(); }
});

test('the authenticated callback helper carries a checkpoint head and continues the worker', async () => {
  const f = fixture();
  let close: (() => Promise<void>) | undefined;
  try {
    const socket = join(f.dir, 'callback.sock'), helper = join(f.dir, 'worker-report.mjs');
    close = await startCallbacks(socket, helper, f.engine);
    const run = (input: object, prefix = 'NUCLEUS') => new Promise<string>((resolve, reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NUCLEUS_') && !key.startsWith('NORTHSTAR_')));
      const child = spawn(process.execPath, [helper], { env: { ...env, [`${prefix}_SOCKET`]: socket, [`${prefix}_TASK_ID`]: f.taskId, [`${prefix}_RUN_ID`]: f.runId, [`${prefix}_RUN_TOKEN`]: f.token } });
      let out = '', err = ''; child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(out) : reject(new Error(err))); child.stdin.end(JSON.stringify(input));
    });
    const accepted = JSON.parse(await run({ status: 'progress_checkpoint', summary: 'Helper milestone', head: headOne }));
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.checkpoint.continued, true);
    // The retired environment family is never a live session's callback credential.
    await assert.rejects(run({ status: 'progress_checkpoint', summary: 'Retired names', head: headOne }, 'NORTHSTAR'), /Missing Nucleus callback environment/);
    await f.engine.wake(); await f.engine.wake();
    const task = f.current();
    assert.equal(task.checkpoints.records.length, 1);
    assert.equal(task.checkpoints.records[0].head, headOne);
    assert.equal(f.continuations.length, 1);
  } finally { await close?.(); await f.close(); }
});

test('schemas, migration and reporting expose the checkpoint outcome additively', async () => {
  const parsed = completionSchema.parse({ eventId: 'e', taskId: 't', runId: 'r', status: 'progress_checkpoint', summary: 'Partial', head: headOne });
  assert.equal(parsed.status, 'progress_checkpoint');
  assert.equal(reportSchema.parse({ eventId: 'e', taskId: 't', runId: 'r', status: 'progress_checkpoint', summary: 'Partial', head: headOne }).head, headOne);
  assert.ok(typeof reportSchema.parse({ eventId: 'e', taskId: 't', runId: 'r', status: 'progress_checkpoint', summary: 'Partial' }).status === 'string');
  const legacy = { ...taskSchema.parse({ ...submissionSchema.parse({ submissionId: 's', title: 'T', repoPath: '/r', planningCommit: base, handoffPath: 'h.md', originAgentId: 'o' }), id: 't', hostId: 'h', createdAt: 'now', updatedAt: 'now', version: 1, phase: 'working', reason: '', held: false, handoffText: '', planningBase: base, workspaceId: null, directory: null, branch: 'ns-t', agentId: null, runId: null, profile: null, workspaceIntent: false, agentIntent: false, lastAgentStatus: null, idleSince: null, completion: null, agentActive: null, lastObservedAt: null, prUrl: null, prHead: null, coordinatorGeneration: 1 }) };
  delete (legacy as Record<string, unknown>).checkpoints;
  assert.deepEqual(taskSchema.parse(legacy).checkpoints, { records: [], intent: null });
  assert.deepEqual(checkpointStateSchema.parse({}), { records: [], intent: null });
  const mcpSource = readFileSync(new URL('../bin/mcp-report.mjs', import.meta.url), 'utf8');
  assert.match(mcpSource, /'progress_checkpoint'/);
  assert.match(mcpSource, /head:z\.string\(\)\.regex/);
  assert.match(checkpointStateLabel({ records: [], intent: null }), /^Checkpoints 0\/3$/);
  const delivered = checkpointStateLabel({ records: [{ ordinal: 1, summary: 'Landed', head: headOne, at: 'now', runId: 'r' }], intent: { id: 'i', ordinal: 1, summary: 'Landed', head: headOne, runId: 'r', eventId: 'e', status: 'delivered', createdAt: 'now', deliveredAt: 'now', attempts: 1, error: '' } });
  assert.match(delivered, /continued: Landed/);
  assert.match(checkpointStateLabel({ records: [], intent: { id: 'i', ordinal: 1, summary: 'Landed', head: headOne, runId: 'r', eventId: 'e', status: 'pending', createdAt: 'now', deliveredAt: null, attempts: 1, error: '' } }), /continuation pending/);
});

test('a schema 50 database preserves legacy task checkpoint defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-checkpoint-migrate-'));
  let upgraded: Store | undefined;
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'legacy', title: 'Legacy', repoPath: '/repo', planningCommit: base, handoffPath: 'h.md', originAgentId: 'o' }), 'host', 'handoff', base);
    const raw = JSON.parse(String(store.db.prepare('SELECT data FROM tasks WHERE id=?').get(task.id)!.data));
    delete raw.checkpoints;
    store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(raw), task.id);
    store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
    store.setMeta('schema', 50);
    store.close();
    upgraded = new Store(join(dir, 'queue.sqlite'));
    assert.equal(upgraded.getMeta('schema'), CURRENT_SCHEMA);
    assert.deepEqual(upgraded.task(task.id).checkpoints, { records: [], intent: null });
    assert.equal(digest(JSON.stringify(upgraded.task(task.id).checkpoints)), digest(JSON.stringify({ records: [], intent: null })));
  } finally { upgraded?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('an unreachable origin refuses the checkpoint with the git cause, not a bare "cannot prove"', async () => {
  const { verifyCheckpoint } = await import('../core/git/index');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'nsq-checkpoint-origin-'));
  try {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    run('init', '-q', '-b', 'main'); run('config', 'user.email', 'q@example.com'); run('config', 'user.name', 'Queue');
    run('commit', '-q', '--allow-empty', '-m', 'base'); const base = run('rev-parse', 'HEAD');
    run('checkout', '-q', '-b', 'ns-checkpoint'); run('commit', '-q', '--allow-empty', '-m', 'partial'); const head = run('rev-parse', 'HEAD');
    run('remote', 'add', 'origin', join(dir, 'missing-origin.git'));
    const task = { directory: dir, branch: 'ns-checkpoint', baseBranch: 'main', planningBase: base } as Task;
    await assert.rejects(verifyCheckpoint(task, head), (error: Error) =>
      /cannot prove the pushed queue-branch head \(.+\)/.test(error.message) && /missing-origin|repository/i.test(error.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
