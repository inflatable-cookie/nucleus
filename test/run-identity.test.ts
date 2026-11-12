import { fakeAdapter, profile } from './support/fakes';
import { historicalWireLabel, wireLabel, wireLabels } from "../shared/wire-labels";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { PaseoAdapter, type Adapter, type AgentObservation } from '../service/paseo-composition';
import { reportingIdentityMismatch } from '../core/intake/reporting-identity';
import { checkoutRunScratchPlacement } from '../core/workspaces/run-scratch';
import type { CheckoutVolumeInfo } from '../core/workspaces/checkout-volume';
import { submissionSchema, type Profile, type Run, type Task } from '../shared/contracts';

const base = 'b'.repeat(40), head = 'a'.repeat(40);


function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-identity-')), store = new Store(join(dir, 'queue.sqlite'));
  const worker = profile('worker');
  store.setMeta('paused', false);
  store.setMeta('pool', [{ profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] }]);
  const creates: { taskId: string; runId: string; token: string; requestId: string }[] = [];
  const states = new Map<string, AgentObservation>();
  let gate: { promise: Promise<void>; release: () => void; reached: Promise<void>; onCall: () => void } | null = null;
  const adapter: Adapter = fakeAdapter({
    profiles: async () => [worker], validate: async t => t.planningCommit ?? base,
    createWorkspace: async t => ({ id: `ws-${t.id}`, directory: '/worktree' }),
    preflightWorkerContinuation: async () => ({ available: true }),
    verifyWorkspace: async t => { if (gate) { gate.onCall(); await gate.promise; } return t.branch; },
    createAgent: async (t, token) => {
      creates.push({ taskId: t.id, runId: t.runId!, token, requestId: `ns-agent-${t.runId}` });
      const id = `agent-${t.runId}`;
      states.set(id, { id, workspaceId: t.workspaceId!, status: 'running', active: true, permissions: false, error: '', labels: { 'nucleus.mcpBinding': t.runId! } });
      return { id, workspaceId: t.workspaceId };
    },
    observe: async id => { const state = states.get(id); if (!state) throw new Error('Agent missing'); return state; },
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/1', head }),
    findOpenBranchPr: async () => [],
  });
  const engine = new Engine(store, adapter, 0); engine.profiles = [worker];
  const add = () => store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  /** A retained live initial worker before any completion, PR or resolution run. */
  const working = (changes: Partial<Task> = {}) => {
    const submitted = add();
    const runId = `run-${submitted.id.slice(0, 8)}`, agentId = `agent-${runId}`;
    states.set(agentId, { id: agentId, workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '', labels: { 'nucleus.mcpBinding': runId } });
    return store.update(submitted.id, { phase: 'working', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree', agentId, runId,
      profile: worker, profileGroup: 'author', workerModel: worker.model, agentActive: true, lastAgentStatus: 'running', lastObservedAt: new Date().toISOString(), ...changes });
  };
  const credentialCount = () => Number(store.db.prepare('SELECT COUNT(*) AS n FROM credentials').get()!.n);
  const gateVerifyWorkspace = () => {
    let release!: () => void, reachedResolve!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { reachedResolve = resolve; });
    gate = { promise, release, reached, onCall: reachedResolve };
    return gate;
  };
  const putRun = (task: Task, role: Run['role']): Run => {
    const run: Run = { id: randomUUID(), taskId: task.id, role, generation: task.coordinatorGeneration, head: task.prHead ?? base, base, agentId: null, workspaceId: task.workspaceId ?? 'workspace', profile: worker, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null, released: false };
    store.putRun(run);
    return run;
  };
  return { dir, store, engine, adapter, worker, add, working, states, creates, credentialCount, gateVerifyWorkspace, putRun,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('one worker creation mints exactly one run identity across task, credential and binding', async () => {
  const f = fixture(); try {
    const task = f.add();
    await f.engine.wake();
    const current = f.store.task(task.id);
    assert.equal(current.phase, 'working');
    assert.equal(f.creates.length, 1);
    const created = f.creates[0];
    assert.equal(created.taskId, task.id);
    assert.ok(created.runId);
    // The durable task, the stored credential and the created worker all name one run.
    assert.equal(current.runId, created.runId);
    assert.equal(created.requestId, `ns-agent-${created.runId}`);
    assert.equal(f.credentialCount(), 1);
    assert.doesNotThrow(() => f.store.authenticate(created.runId, created.token));
    assert.throws(() => f.store.authenticate(created.runId, 'other-token'), /Unauthorized callback/);
    assert.equal(current.agentId, `agent-${created.runId}`);
    assert.equal(f.states.get(current.agentId!)!.labels!['nucleus.mcpBinding'], current.runId);
    assert.equal(f.store.events(task.id).filter(event => event.kind === 'agent_intent').length, 1);
    assert.equal(f.store.events(task.id).filter(event => event.kind === 'agent_created').length, 1);
  } finally { await f.close(); }
});

test('new runs retain their task host even when a stale writer omits it', async () => {
  const f = fixture(); try {
    const task = f.add();
    const run = f.putRun(task, 'reviewer');
    assert.equal(f.store.runs(task.id).find(item => item.id === run.id)?.hostId, 'host');
    f.store.putRun({ ...run, status: 'finished' });
    assert.equal(f.store.runs(task.id).find(item => item.id === run.id)?.hostId, 'host');
  } finally { await f.close(); }
});

test('credential binding refuses an unproven or conflicting run host', async () => {
  const f = fixture(); try {
    const task = f.working();
    const run = f.putRun(task, 'reviewer');
    f.store.setCredential(run.id, 'secret');
    assert.doesNotThrow(() => f.store.authenticate(run.id, 'secret'));
    f.store.db.prepare("UPDATE runs SET data=json_set(data,'$.hostId','other') WHERE id=?").run(run.id);
    assert.throws(() => f.store.authenticate(run.id, 'secret'), /proven run host/);
    assert.throws(() => f.store.authenticate(run.id, 'wrong'), /Unauthorized/);
  } finally { await f.close(); }
});

test('unreleased run lookup separates equal native IDs by host', async () => {
  const f = fixture(); try {
    const a = f.add();
    const b = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Other', repoPath: '/repo', planningCommit: base, handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'other-host', 'handoff', base);
    const ra = f.putRun(a, 'reviewer'), rb = f.putRun(b, 'reviewer');
    f.store.putRun({ ...ra, agentId: 'same' }); f.store.putRun({ ...rb, agentId: 'same' });
    assert.deepEqual(f.store.unreleasedRunsForAgent('same', 'host').map(run => run.id), [ra.id]);
    assert.deepEqual(f.store.unreleasedRunsForAgent('same', 'other-host').map(run => run.id), [rb.id]);
  } finally { await f.close(); }
});

test('review independence refuses a reviewer whose host is unknown or different', async () => {
  const f = fixture(); try {
    const task = f.working(), run = f.putRun(task, 'reviewer');
    assert.throws(() => f.engine.resolution.assertReviewProfileIndependent(task, { ...run, hostId: undefined }), /proven reviewer host/);
    assert.throws(() => f.engine.resolution.assertReviewProfileIndependent(task, { ...run, hostId: 'other' }), /proven reviewer host/);
  } finally { await f.close(); }
});

test('a concurrent second launcher for one creation fails closed with no second identity or agent', async () => {
  const f = fixture(); try {
    const task = f.add();
    const prepared = f.store.update(task.id, { phase: 'dispatching', planningBase: base, workspaceIntent: true, workspaceId: 'workspace', directory: '/worktree', profile: f.worker, profileGroup: 'author' });
    const gate = f.gateVerifyWorkspace();
    const first = (f.engine as unknown as { launchAgent(t: Task): Promise<void> }).launchAgent(prepared);
    const second = (f.engine as unknown as { launchAgent(t: Task): Promise<void> }).launchAgent(prepared);
    await gate.reached;
    gate.release();
    await Promise.all([first, second]);
    const current = f.store.task(task.id);
    assert.equal(f.creates.length, 1);
    assert.equal(f.store.events(task.id).filter(event => event.kind === 'agent_intent').length, 1);
    assert.equal(f.store.events(task.id).filter(event => event.kind === 'agent_created').length, 1);
    assert.equal(f.credentialCount(), 1);
    assert.equal(current.runId, f.creates[0].runId);
    assert.equal(current.agentId, `agent-${f.creates[0].runId}`);
  } finally { await f.close(); }
});

test('createAgent binds the durable run identity into the live reporting ticket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-identity-adapter-'));
  try {
    const adapter = new PaseoAdapter('ws://127.0.0.1:1', join(dir, 'callback.sock'), join(dir, 'worker-report.mjs'), undefined, join(dir, 'mcp-report.mjs'));
    const mount = join(realpathSync(dir), 'Builds');
    mkdirSync(mount, { recursive: true });
    const volume: CheckoutVolumeInfo = { MountPoint: mount, VolumeUUID: 'fixture', Internal: false, Writable: true, WritableVolume: true };
    adapter.runScratch = checkoutRunScratchPlacement({ mount, uuid: 'fixture', observe: () => volume });
    const calls: { labels: Record<string, string> }[] = [];
    (adapter as unknown as { api: unknown }).api = { workspaces: { ref: () => ({ agents: { create: async (input: { labels: Record<string, string> }) => { calls.push({ labels: input.labels }); return { id: 'worker', workspaceId: 'workspace' }; } } }) } };
    const task = { id: 'task', title: 'Task', workspaceId: 'workspace', profile: profile('worker'), runId: 'run-1', branch: 'ns-task' } as Task;
    await adapter.createAgent(task, 'token-1', 'prompt');
    assert.equal(calls[0].labels['nucleus.mcpBinding'], 'run-1');
    assert.equal(calls[0].labels['nucleus.mcpBindingPath'], join(dir, 'tickets', 'mcp-run-1.json'));
    // The binding path is a live label; the retired family is never written beside it.
    assert.equal(calls[0].labels['northstar.mcpBindingPath'], undefined);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'tickets', 'run-1.json'), 'utf8')), { socketPath: join(dir, 'callback.sock'), taskId: 'task', runId: 'run-1', token: 'token-1' });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'tickets', 'mcp-run-1.json'), 'utf8')), { socketPath: join(dir, 'callback.sock'), taskId: 'task', runId: 'run-1', token: 'token-1' });
    assert.equal(existsSync(join(dir, 'tickets', 'mcp-run-1.json')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a release revokes the credential, a live re-bind restores it, and replaced is not released', async () => {
  const f = fixture(); try {
    const task = f.add(), run = f.putRun(task, 'reviewer'), token = 'rebind-token';
    const tickets = join(f.dir, 'tickets'); mkdirSync(tickets, { recursive: true });
    for (const name of [`${run.id}.json`, `mcp-${run.id}.json`])
      writeFileSync(join(tickets, name), JSON.stringify({ socketPath: 'socket', taskId: task.id, runId: run.id, token }));
    f.store.setCredential(run.id, token);
    // A release revokes: the released credential authenticates nothing and its
    // ticket files go, while run history and the stored hash stay.
    const completion = { taskId: task.id, runId: run.id, eventId: 'finished', status: 'blocked' as const, summary: 'Finished' };
    f.store.putRun({ ...run, status: 'finished', completion, released: true });
    assert.equal(f.credentialCount(), 1, 'the row is kept revoked, not deleted');
    assert.throws(() => f.store.authenticate(run.id, token), /Unauthorized callback/);
    assert.equal(f.store.credentialRunForToken(token), null, 'a revoked credential maps to no run');
    assert.equal(existsSync(join(tickets, `${run.id}.json`)), false);
    assert.equal(existsSync(join(tickets, `mcp-${run.id}.json`)), false);
    const recorded = f.store.run(run.id)!;
    assert.equal(recorded.status, 'finished'); assert.equal(recorded.released, true);
    assert.deepEqual(recorded.completion, completion);
    assert.equal(recorded.hostId, 'host');
    // Re-binding the same run identity restores the same credential: the restart
    // path re-binds rather than minting.
    f.store.putRun({ ...run, status: 'running', released: false });
    f.store.authenticate(run.id, token);
    assert.equal(f.store.credentialRunForToken(token), run.id);
    // Replaced is not released (planner ruling, 2026-11-09): a replaced reviewer
    // holds its claim — its credential stays live while the claim holds.
    const replaced = { ...run, id: randomUUID(), role: 'reviewer' as const, status: 'superseded' as const, released: false };
    f.store.putRun(replaced);
    const replacedTickets = [`${replaced.id}.json`, `mcp-${replaced.id}.json`];
    for (const name of replacedTickets)
      writeFileSync(join(tickets, name), JSON.stringify({ socketPath: 'socket', taskId: task.id, runId: replaced.id, token }));
    f.store.setCredential(replaced.id, token);
    assert.doesNotThrow(() => f.store.authenticate(replaced.id, token));
    assert.equal(existsSync(join(tickets, `mcp-${replaced.id}.json`)), true);
    // The claim ends when the review settles: the replaced run is released, and
    // the release revokes unconditionally.
    f.store.putRun({ ...replaced, released: true, active: false });
    assert.throws(() => f.store.authenticate(replaced.id, token), /Unauthorized callback/);
    assert.equal(existsSync(join(tickets, `mcp-${replaced.id}.json`)), false);
    // An explicit revocation point — cancellation, removal, absent-run replacement —
    // deletes the row, and nothing authenticates or maps it afterwards.
    f.store.db.prepare('DELETE FROM credentials WHERE run=?').run(replaced.id);
    assert.throws(() => f.store.authenticate(replaced.id, token), /Unauthorized callback/);
  } finally { await f.close(); }
});

test('continueWorker re-issues a rotated retained binding on the same path and leaves a matched binding alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-identity-continue-'));
  try {
    const adapter = new PaseoAdapter('ws://127.0.0.1:1', join(dir, 'callback.sock'), join(dir, 'worker-report.mjs'), undefined, join(dir, 'mcp-report.mjs'));
    const sends: { text: string; messageId: string }[] = [];
    let labels: Record<string, string> = { 'nucleus.mcpBinding': 'old-run' };
    (adapter as unknown as { api: unknown }).api = {
      workspaces: { ref: () => ({ directory: dir, refresh: async () => true, current: () => ({ projectRootPath: '/repo' }) }) },
      agents: { ref: () => ({
        refresh: async () => true, archivedAt: null, workspaceId: 'workspace',
        current: () => ({ labels }), send: async (text: string, options: { messageId: string }) => { sends.push({ text, messageId: options.messageId }); },
      }) },
    };
    const task = { id: 'task', title: 'Task', repoPath: '/repo', workspaceId: 'workspace', directory: dir, agentId: 'worker', runId: 'new-run', branch: 'ns-task' } as Task;
    let issued = 0;
    await adapter.continueWorker(task, 'intent-1', 'continue', () => { issued++; return { runId: 'new-run', token: 'fresh-token' }; });
    assert.equal(issued, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'tickets', 'mcp-old-run.json'), 'utf8')), { socketPath: join(dir, 'callback.sock'), taskId: 'task', runId: 'new-run', token: 'fresh-token' });
    assert.deepEqual(sends, [{ text: 'continue', messageId: 'ns-checkpoint-intent-1' }]);
    // A binding that already names the durable run is not rotated.
    labels = { 'nucleus.mcpBinding': 'new-run' };
    await adapter.continueWorker(task, 'intent-2', 'continue again', () => { throw new Error('a matched binding must not be re-issued'); });
    assert.equal(issued, 1);
    assert.equal(sends.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the read-only reporting identity diagnostic reports a split binding and mutates nothing', async () => {
  const f = fixture(); try {
    const task = f.working();
    const snapshot = () => JSON.stringify([f.store.task(task.id), f.store.db.prepare('SELECT run,hash FROM credentials ORDER BY run').all()]);
    const before = snapshot();
    assert.deepEqual(reportingIdentityMismatch(task, 'other-run'), { runId: task.runId, bindingRunId: 'other-run' });
    assert.equal(reportingIdentityMismatch(task, task.runId), null);
    assert.equal(reportingIdentityMismatch(task, null), null);
    // Only a live initial worker is diagnostic: accepted work, a resolution run or a PR identity keeps its own gates.
    assert.equal(reportingIdentityMismatch({ ...task, completion: { taskId: task.id, runId: task.runId!, eventId: 'e', status: 'ready_for_review', summary: 'Ready', prNumber: 1 } }, 'other-run'), null);
    assert.equal(reportingIdentityMismatch({ ...task, prHead: head, prUrl: 'https://github.com/example/repo/pull/1' }, 'other-run'), null);
    assert.equal(reportingIdentityMismatch({ ...task, resolution: { ...task.resolution, currentRunId: 'run-revision' } }, 'other-run'), null);
    assert.equal(reportingIdentityMismatch({ ...task, phase: 'done' }, 'other-run'), null);
    assert.equal(snapshot(), before);
  } finally { await f.close(); }
});

test('a split live binding is reported into needs_attention and a supported recovery returns the same identities', async () => {
  const f = fixture(); try {
    const task = f.working();
    const retained = () => f.states.set(task.agentId!, { ...f.states.get(task.agentId!)!, labels: { 'nucleus.mcpBinding': 'run-earlier' } });
    // An active worker is not diagnosed: its callback is still authoritative and
    // the automatic branch-PR reconciliation path must stay available.
    retained();
    await f.engine.wake();
    assert.equal(f.store.task(task.id).phase, 'working');
    // A working phase offers no supported pre-PR worker recovery.
    assert.throws(() => f.engine.resolution.resumeWorker(f.store.task(task.id), 'continue', true), /stopped pre-callback worker/);
    // The retained worker stops with its binding still naming an earlier run.
    f.states.set(task.agentId!, { ...f.states.get(task.agentId!)!, status: 'idle', active: false });
    await f.engine.wake();
    const reported = f.store.task(task.id);
    assert.equal(reported.phase, 'needs_attention');
    assert.equal(reported.resolution.attention, true);
    assert.match(reported.reason, /binding names run run-earlier but the task holds/);
    // The supported recovery returns the retained task, worker, workspace, branch and handoff.
    const recovered = await f.engine.performTaskControl({ taskId: task.id, version: reported.version, action: 'restart', role: 'worker', reason: 'Resume the retained worker', instruction: 'Continue the handoff after reconciling the binding' });
    assert.equal(recovered.id, task.id);
    assert.equal(recovered.phase, 'changes_requested');
    assert.equal(recovered.agentId, task.agentId);
    assert.equal(recovered.runId, task.runId);
    assert.equal(recovered.workspaceId, task.workspaceId);
    assert.equal(recovered.branch, task.branch);
    assert.equal(recovered.handoffPath, task.handoffPath);
    assert.equal(recovered.planningCommit, task.planningCommit);
    assert.equal(recovered.resolution.attention, false);
  } finally { await f.close(); }
});

test('a checkpoint continuation re-issues a rotated working binding and its credential', async () => {
  const f = fixture(); try {
    const task = f.working();
    const intent = { id: 'intent-1', ordinal: 1, summary: 'Partial work landed', head: 'c'.repeat(40), runId: task.runId!, eventId: 'event-1', status: 'pending' as const, createdAt: new Date().toISOString(), deliveredAt: null, attempts: 0, error: '' };
    f.store.update(task.id, { checkpoints: { records: [], intent } });
    const issued: { runId: string; token: string }[] = [];
    f.adapter.continueWorker = async (_t, _intentId, _text, issueBinding) => { if (issueBinding) issued.push(issueBinding()); };
    await f.engine.resolution.checkpoints.pass();
    assert.equal(issued.length, 1);
    assert.equal(issued[0].runId, task.runId);
    // The fresh credential authenticates the durable run identity the binding now names.
    assert.doesNotThrow(() => f.store.authenticate(task.runId!, issued[0].token));
    assert.throws(() => f.store.authenticate(task.runId!, 'stale-token'), /Unauthorized callback/);
    assert.equal(f.store.task(task.id).checkpoints.intent!.status, 'delivered');
  } finally { await f.close(); }
});

test('ownerless attention lands needs_attention while mid-flight callers keep their phase', async () => {
  const f = fixture(); try {
    // A reviewer callback reminder still holds its live run.
    const reviewing = f.working({ phase: 'reviewing' });
    const reviewerRun = f.putRun(reviewing, 'reviewer');
    f.store.update(reviewing.id, { resolution: { ...f.store.task(reviewing.id).resolution, currentRunId: reviewerRun.id } });
    f.engine.resolution.attention(f.store.task(reviewing.id), 'The reviewer thread stopped and its one callback reminder expired without a result; coordinator attention required');
    assert.equal(f.store.task(reviewing.id).phase, 'reviewing');
    assert.equal(f.store.task(reviewing.id).resolution.attention, true);

    // A coordinator run keeps its phase.
    const verifying = f.working({ phase: 'verifying' });
    const coordinatorRun = f.putRun(verifying, 'closeout');
    f.store.update(verifying.id, { resolution: { ...f.store.task(verifying.id).resolution, currentRunId: coordinatorRun.id } });
    f.engine.resolution.attention(f.store.task(verifying.id), 'Repository pre-merge gate could not prove the reviewed head');
    assert.equal(f.store.task(verifying.id).phase, 'verifying');

    // A repository pre-merge gate holding accepted PR identity keeps its phase.
    const merging = f.working({ phase: 'merging', prUrl: 'https://github.com/example/repo/pull/1', prHead: head });
    f.engine.resolution.attention(f.store.task(merging.id), 'Repository pre-merge gate could not run: hook transport failed');
    assert.equal(f.store.task(merging.id).phase, 'merging');

    // A task with no completion, no PR identity and no current run lands in needs_attention.
    const ownerless = f.working();
    f.engine.resolution.attention(f.store.task(ownerless.id), 'Worker stopped without a completion callback; inspect the thread');
    assert.equal(f.store.task(ownerless.id).phase, 'needs_attention');
    assert.equal(f.store.task(ownerless.id).resolution.attention, true);
    // Repeated identical observations keep one phase and one incident identity.
    const incident = f.store.task(ownerless.id).resolution.incident!.id;
    f.engine.resolution.attention(f.store.task(ownerless.id), 'Worker stopped without a completion callback; inspect the thread');
    assert.equal(f.store.task(ownerless.id).phase, 'needs_attention');
    assert.equal(f.store.task(ownerless.id).resolution.incident!.id, incident);
  } finally { await f.close(); }
});


test('launches write only nucleus labels and only stored history still reads northstar names', () => {
  const labels = wireLabels({ task: 'task', run: 'run', mcpBinding: 'binding' });
  assert.deepEqual(labels, {
    'nucleus.plugin': 'nucleus', 'nucleus.task': 'task', 'nucleus.run': 'run', 'nucleus.mcpBinding': 'binding',
  });
  for (const key of Object.keys(labels)) assert.doesNotMatch(key, /^northstar\./);
  assert.equal(wireLabel(labels, 'run'), 'run');
  assert.equal(wireLabel({ 'nucleus.run': 'new' }, 'run'), 'new');
  // A live thread is never accepted under the retired names.
  assert.equal(wireLabel({ 'northstar.run': 'old' }, 'run'), undefined);
  // Stored history keeps its recorded names readable.
  assert.equal(historicalWireLabel({ 'northstar.run': 'old' }, 'run'), 'old');
  assert.equal(historicalWireLabel({ 'nucleus.run': 'new' }, 'run'), 'new');
  assert.equal(historicalWireLabel(labels, 'mcpBinding'), 'binding');
  // A retained thread's split identity is still refused rather than guessed.
  assert.throws(() => historicalWireLabel({ 'northstar.run': 'old', 'nucleus.run': 'new' }, 'run'), /Conflicting/);
  assert.throws(() => wireLabel({ 'nucleus.plugin': 'northstar-queue' }, 'run'), /Invalid nucleus plugin label/);
  // The recorded pre-Nucleus plugin value is history, not a rejected live label.
  assert.equal(historicalWireLabel({ 'northstar.plugin': 'northstar-queue', 'northstar.task': 't' }, 'task'), 't');
  assert.throws(() => historicalWireLabel({ 'northstar.plugin': 'other' }, 'task'), /Invalid northstar plugin label/);
});

test('nucleus#1139: a proven refusal at worker creation names the step and skips the absent-creation ladder', async () => {
  const f = fixture(); try {
    const { ProvenPreSendRefusalError } = await import('../core/recovery/task-reasons');
    const original = f.adapter.createAgent;
    f.adapter.createAgent = async (...args: Parameters<Adapter['createAgent']>) => {
      await original(...args);
      throw new ProvenPreSendRefusalError('T3Code model luna-model has no reasoningEffort "xhigh"');
    };
    const task = f.add();
    await f.engine.wake();
    const current = f.store.task(task.id);
    assert.equal(current.phase, 'needs_attention');
    assert.equal(current.agentIntent, false);
    assert.equal(current.runId, null);
    assert.match(current.reason, /^Worker creation refused before send: T3Code model luna-model has no reasoningEffort "xhigh"$/);
    assert.equal(f.credentialCount(), 0, 'the creation credential is revoked');
    assert.equal(current.resolution.incident?.action ?? null, null, 'no exact-lookup incident: nothing was delivered');
    assert.equal(f.creates.length, 1, 'exactly one creation was attempted');
    const event = f.store.events(task.id).find(candidate => candidate.kind === 'worker_creation_refused_before_send');
    assert.ok(event, 'the refusal is recorded as its own event kind');
    // Spec 058 budgets (nucleus#1153): a proven pre-send refusal is the host's cause,
    // so the task's wall clock stops while it waits for the Nucleus fix. The launch
    // that refuses runs after this pass's quanta, so the next sweep visit settles it
    // exactly as core/scheduling/sweep.ts does.
    f.engine.resolution.settleBudgetClock(f.store.task(task.id));
    const held = f.store.task(task.id).resolution.budgetClock!;
    assert.ok(held.since, 'the refusal pauses the wall clock');
    assert.match(held.reason ?? '', /refusal stopped the task before any send/);
    // A later dispatch reselects; no stale run identity blocks it.
    assert.equal(current.resolution.currentRunId ?? null, null);
  } finally { await f.close(); }
});
