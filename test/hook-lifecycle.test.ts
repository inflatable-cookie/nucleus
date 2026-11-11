import { configuredClone, materializeSeed } from './support/git-seed';
import { fakeAdapter } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CURRENT_SCHEMA, Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { cancelQueuedTask } from '../core/hooks/hooks';
import { git, command } from '../core/git/index';
import { submissionSchema, type Profile } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';

const profile: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };

function hookManifest(events: string[], outcome: 'ok' | 'blocked' | 'failed', delivery = 'required') {
  const script = `#!/usr/bin/env node
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:${JSON.stringify(outcome)},summary:${JSON.stringify(outcome === 'ok' ? 'policy passed' : 'policy refused')},metadata:{},changedPaths:[],commitSubjectSuffix:null}));});
`;
  return {
    script,
    manifest: JSON.stringify({ schema: 'paseo.queue.control.v1', hooks: [{ id: 'policy', events, mode: 'read_only', delivery, executable: '.paseo/hooks/policy', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null }] }, null, 2),
  };
}

async function repoWithPolicy(t: any, events: string[], outcome: 'ok' | 'blocked' | 'failed', delivery = 'required', withManifest = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-life-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(configuredClone, root);
  const repo = join(root, 'repo');
  const { script, manifest } = hookManifest(events, outcome, delivery);
  await mkdir(join(repo, '.paseo/hooks'), { recursive: true });
  await mkdir(join(repo, 'docs'), { recursive: true });
  if (withManifest) await writeFile(join(repo, '.paseo/queue.json'), manifest);
  await writeFile(join(repo, '.paseo/hooks/policy'), script);
  await chmod(join(repo, '.paseo/hooks/policy'), 0o755);
  await writeFile(join(repo, 'docs/plan.json'), '{}');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'base');
  await git(repo, 'push', 'origin', 'main');
  const head = await git(repo, 'rev-parse', 'HEAD');
  const dir = await mkdtemp(join(tmpdir(), 'nsq-lifestore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('lastRetentionAt', Date.now());
  store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', weight: 1, scopes: ['general'] }]);
  const calls = { workspaces: 0, agents: 0 };
  let observation: Partial<AgentObservation> = { status: 'idle', active: false };
  const adapter: Adapter = fakeAdapter({
    profiles: async () => [profile], validate: async () => head,
    createWorkspace: async (task) => { calls.workspaces++; return { id: `ws-${task.id}`, directory: repo }; },
     verifyWorkspace: async task => task.branch,
    createAgent: async (task) => { calls.agents++; return { id: `agent-${task.id}`, workspaceId: task.workspaceId }; },
    observe: async id => ({ id, workspaceId: `ws-${id.slice(6)}`, status: 'idle', active: false, permissions: false, error: '', ...observation }),
     verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/1', head }),
  });
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  const add = () => store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Lifecycle', repoPath: repo, planningCommit: head, handoffPath: 'docs/plan.json', originAgentId: 'origin' }), 'host', 'handoff', head);
  return { root, repo, head, store, engine, calls, add, dbPath: join(dir, 'queue.sqlite'), observe: (value: Partial<AgentObservation>) => { observation = value; } };
}

test('required pre_dispatch hook holds dispatch before any workspace intent', async t => {
  const f = await repoWithPolicy(t, ['task.pre_dispatch'], 'blocked');
  const task = f.add();
  await f.engine.wake();
  const current = f.store.task(task.id);
  assert.equal(current.phase, 'needs_attention');
  assert.equal(current.workspaceIntent, false);
  assert.equal(f.calls.workspaces, 0);
  assert.equal(f.store.hookEvents(task.id).length, 1);
  assert.equal(f.store.hookEvents(task.id)[0].state, 'blocked');
});

test('pre-dispatch preview rejects a required hold without creating a durable task or hook record', async t => {
  const f = await repoWithPolicy(t, ['task.pre_dispatch'], 'blocked');
  const submission = submissionSchema.parse({ submissionId: randomUUID(), title: 'Rejected preview', repoPath: f.repo,
    planningCommit: f.head, handoffPath: 'docs/plan.json', originAgentId: 'origin' });
  await assert.rejects(f.engine.hooks.previewPreDispatch(submission, 'handoff', f.head), /policy refused/);
  assert.equal(f.store.tasks().length, 0);
  assert.equal(f.store.hookEvents().length, 0);
  assert.equal(f.calls.workspaces, 0);
});

test('successful pre_dispatch hook allows dispatch to proceed', async t => {
  const f = await repoWithPolicy(t, ['task.pre_dispatch'], 'ok');
  const task = f.add();
  await f.engine.wake();
  const current = f.store.task(task.id);
  assert.equal(current.phase, 'working');
  assert.equal(f.calls.workspaces, 1);
  assert.equal(f.store.hookEvents(task.id)[0].state, 'result');
});

test('advisory pre_dispatch failure advances on a clean repository', async t => {
  const f = await repoWithPolicy(t, ['task.pre_dispatch'], 'failed', 'advisory');
  const task = f.add();
  await f.engine.wake();
  assert.equal(f.store.task(task.id).phase, 'working');
  assert.equal(f.store.hookEvents(task.id)[0].state, 'failed');
});

test('durable worker blocked result emits task.blocked and a required policy holds the phase', async t => {
  const f = await repoWithPolicy(t, ['task.blocked'], 'blocked');
  const task = f.add();
  const runId = 'blocked-run';
  f.store.update(task.id, {
    phase: 'working', workspaceIntent: true, workspaceId: 'ws-task', directory: f.repo, agentIntent: true, agentId: 'agent-task', runId, profile,
    completion: { eventId: 'blocked-event', taskId: task.id, runId, status: 'blocked', summary: 'Waiting for an external contract' },
  });
  await f.engine.wake();
  const current = f.store.task(task.id);
  assert.equal(current.phase, 'needs_attention');
  assert.match(current.reason, /task\.blocked/);
  assert.equal(f.store.hookEvents(task.id).length, 1);
});

test('advisory blocked policy records a failure but lets the durable blocked phase stand', async t => {
  const f = await repoWithPolicy(t, ['task.blocked'], 'blocked', 'advisory');
  const task = f.add();
  const runId = 'blocked-run';
  f.store.update(task.id, {
    phase: 'working', workspaceIntent: true, workspaceId: 'ws-task', directory: f.repo, agentIntent: true, agentId: 'agent-task', runId, profile,
    completion: { eventId: 'blocked-event', taskId: task.id, runId, status: 'blocked', summary: 'Waiting for an external contract' },
  });
  await f.engine.wake();
  assert.equal(f.store.task(task.id).phase, 'blocked');
  assert.equal(f.store.hookEvents(task.id)[0].state, 'failed');
});

test('queued cancellation runs task.cancelled and a required failure holds the task', async t => {
  const f = await repoWithPolicy(t, ['task.cancelled'], 'blocked');
  const task = f.add();
  const held = await cancelQueuedTask(f.store, f.engine.hooks, task);
  assert.equal(held.phase, 'needs_attention');
  assert.equal(f.store.hookEvents(task.id)[0].state, 'blocked');

  const g = await repoWithPolicy(t, ['task.cancelled'], 'ok');
  const cancellable = g.add();
  const cancelled = await cancelQueuedTask(g.store, g.engine.hooks, cancellable);
  assert.equal(cancelled.phase, 'cancelled');
});

test('operator supersession closes a pre-workspace task when cancellation repeats its admission refusal', async t => {
  const f = await repoWithPolicy(t, ['task.pre_dispatch', 'task.cancelled'], 'blocked');
  const malformed = f.add();
  await f.engine.wake();
  const held = f.store.task(malformed.id);
  assert.equal(held.phase, 'needs_attention');
  assert.equal(held.workspaceIntent, false);
  const replacement = f.add();

  const superseded = await f.engine.disposeTask({
    taskId: held.id, version: held.version, action: 'supersede', reason: 'Corrected immutable submission replaces malformed admission',
    replacementTaskId: replacement.id,
  });

  assert.equal(superseded.phase, 'cancelled');
  assert.equal(superseded.disposition?.kind, 'supersede');
  assert.equal(superseded.disposition?.status, 'complete');
  assert.equal(superseded.disposition?.replacementTaskId, replacement.id);
  assert.equal(superseded.disposition?.workspaceEvidence, 'No task workspace was created');
  assert.deepEqual(f.store.hookEvents(malformed.id).map(record => [record.event, record.state]), [
    ['task.pre_dispatch', 'blocked'], ['task.cancelled', 'blocked'],
  ]);
  assert.ok(f.store.eventsAll(malformed.id).some(event => event.kind === 'disposition_hook_refusal_reconciled'));
  assert.equal(f.calls.workspaces, 0);
});

test('a repository without a manifest keeps serialized dispatch behaviour', async t => {
  const f = await repoWithPolicy(t, ['task.pre_dispatch'], 'ok', 'required', false);
  const task = f.add();
  await f.engine.wake();
  assert.equal(f.store.task(task.id).phase, 'working');
  assert.equal(f.store.hookEvents(task.id).length, 0);
});

test('schema 50 databases upgrade to the current schema with data intact', async t => {
  const f = await repoWithPolicy(t, ['task.pre_dispatch'], 'ok');
  const task = f.add();
  f.store.setMeta('paused', true);
  f.store.setMeta('globalLimit', 32);
  f.store.setMeta('projectLimit', 5);
  f.store.update(task.id, { phase: 'working', agentId: 'legacy-agent' });
  f.store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
  f.store.setMeta('schema', 50);
  f.store.close();
  const upgraded = new Store(f.dbPath);
  assert.equal(upgraded.getMeta('schema'), CURRENT_SCHEMA);
  assert.equal(upgraded.getMeta('globalLimit'), 32);
  assert.equal(upgraded.getMeta('projectLimit'), 5);
  assert.equal(upgraded.hookEvents().length, 0);
  assert.equal(upgraded.task(task.id).agentId, 'legacy-agent');
  upgraded.close();
});

test('an unverified host validation scan holds a blocked worker result in working, and a complete absent scan lets the required policy hold the phase (milestone 6257017a)', async t => {
  const f = await repoWithPolicy(t, ['task.blocked'], 'blocked');
  const task = f.add();
  const runId = 'blocked-run';
  f.store.update(task.id, {
    phase: 'working', workspaceIntent: true, workspaceId: 'ws-task', directory: f.repo, agentIntent: true, agentId: 'agent-task', runId, profile,
    completion: { eventId: 'blocked-event', taskId: task.id, runId, status: 'blocked', summary: 'Waiting for an external contract' },
  });
  // A host listing that could not finish is not absence: the result waits on validation.
  f.engine.adapter.worktreeValidation = () => ({ state: 'unverified', reason: 'process listing failed' });
  await f.engine.wake();
  assert.equal(f.store.task(task.id).phase, 'working');
  assert.match(f.store.task(task.id).reason, /Worktree validation scan is unverified/);
  assert.equal(f.store.hookEvents(task.id).length, 0, 'no hook runs while validation is unverified');
  // A complete scan with nothing running lets the same result reach the real hook.
  f.engine.adapter.worktreeValidation = () => ({ state: 'absent' });
  await f.engine.wake();
  assert.equal(f.store.task(task.id).phase, 'needs_attention');
  assert.match(f.store.task(task.id).reason, /task\.blocked/);
  assert.equal(f.store.hookEvents(task.id).length, 1);
});
