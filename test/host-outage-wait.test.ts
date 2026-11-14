import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { T3CodeHost } from '../hosts/t3code/adapter';
import { t3Fake, threadProjection } from './support/t3code-fake';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema, summarizeTask, type Profile } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';
import { formatAgentId, parseAgentId } from '../shared/agent-identity';

/**
 * Tom, 2026-11-14 (T3 lane document v18, "Rulings (Tom, 2026-11-14)", host
 * dropout option 1: wait). A task's host is part of its identity. While the host
 * is unavailable the task waits visibly on that host, spends no budget and
 * starts no recovery; when it returns the retained thread is re-observed before
 * anything is sent and the task continues on the same host and threads, with no
 * duplicated send and no replay of unknown delivery.
 *
 * The transport here is the fake Nightly (`test/support/t3code-fake.ts`, records
 * in the Nightly's own wire shape), really disconnected with `dropSockets()`; the
 * task row is written through the real Store, so it carries every real field.
 */

const base = 'b'.repeat(40);
const profile: Profile = {
  id: 'synthetic-profile', name: 'Synthetic', provider: 'synthetic-provider', model: 'synthetic-model',
  available: true, problem: '', notes: '', supportedThinking: [],
};

const waitUntil = async (ready: () => boolean, label: string, timeoutMs = 5_000) => {
  const start = Date.now();
  while (!ready() && Date.now() - start < timeoutMs) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(ready(), label);
};

function gitHead(directory: string): string {
  execFileSync('git', ['init', '-q'], { cwd: directory });
  writeFileSync(join(directory, 'README.md'), 'synthetic\n');
  execFileSync('git', ['add', 'README.md'], { cwd: directory });
  execFileSync('git', ['-c', 'user.email=synthetic@example.com', '-c', 'user.name=Synthetic', 'commit', '-q', '-m', 'Synthetic'], { cwd: directory });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
}

test('a working task on a disconnected Nightly transport waits on its host, then re-observes and resumes once', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ns-host-outage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = realpathSync(root);
  const server = await t3Fake(t, directory);
  const host = new T3CodeHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer',
    statePath: join(root, 'state.json'), timeoutMs: 1_000, probeThreadId: 'synthetic-probe' });
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace-intent',
    directory, project: { projectId: 'synthetic-project' } });
  // The worker's thread is a Nightly projection served over the real transport.
  server.threads.set('synthetic-worker', threadProjection('synthetic-worker', directory));
  const head = gitHead(directory);

  const store = new Store(':memory:');
  t.after(() => store.close());
  store.setMeta('paused', false);
  store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'synthetic', roles: ['worker', 'reviewer'],
    weight: 1, scopes: ['general'], capability: 'medium' }]);
  const inserted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Host outage',
    repoPath: directory, planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), host.hostId, 'handoff.md', base);
  store.update(inserted.id, {
    phase: 'working', workspaceIntent: true, agentIntent: true, workspaceId: workspace.id,
    agentId: 'synthetic-worker', runId: 'initial', directory, branch: 'ns-host-outage', baseBranch: 'main',
    profile, workerModel: profile.model, workerModels: [profile.model],
    prHead: head, prUrl: 'https://github.com/synthetic/repo/pull/1',
    idleSince: new Date(Date.now() - 3_600_000).toISOString(),
  }, 'dispatched');

  const calls: string[] = [];
  const adapter = {
    hostId: host.hostId,
    observe: async (id: string) => { calls.push(`observe:${id}`); return host.observe(id); },
    notify: async (_id: string, messageId: string) => { calls.push(`notify:${messageId}`); },
    originAgent: async (id: string) => ({ id, workspaceId: workspace.id, title: id, archived: false }),
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.hostIds = () => [host.hostId];
  engine.hostAvailable = id => id === host.hostId && host.connected;
  engine.profiles = [profile];
  engine.identifyOriginHost = async () => host.hostId;
  t.after(() => engine.stop());

  // The Nightly transport really drops: no observation, no send, no recovery.
  server.dropSockets();
  await waitUntil(() => !host.connected, 'the fake Nightly transport is disconnected');
  calls.length = 0;
  await engine.wake();

  const waiting = store.task(inserted.id);
  assert.equal(waiting.resolution.stop?.reason, 'host_unavailable', waiting.reason);
  assert.match(waiting.resolution.stop?.detail ?? '', /^Waiting on T3Code host synthetic-environment since \d{4}-\d{2}-\d{2}T/);
  assert.equal(waiting.phase, 'working', 'the outage does not move the phase');
  assert.equal(waiting.agentId, 'synthetic-worker', 'the task keeps its retained thread');
  assert.equal(waiting.workspaceId, workspace.id, 'the task keeps its workspace');
  assert.ok(waiting.resolution.budgetClock?.since, 'the wall-time budget pauses for the outage');
  assert.equal(calls.length, 0, 'nothing is sent to or read from the disconnected host');
  assert.deepEqual(store.runs(inserted.id), [], 'no recovery or other run was recorded');
  const kinds = store.eventsAll(inserted.id).map(event => event.kind);
  for (const never of ['stalled_turn', 'run_stalled', 'incident', 'needs_attention', 'recovery_escalated', 'telemetry_recovery'])
    assert.equal(kinds.includes(never), false, `${never} is not raised by the outage: ${kinds.join(', ')}`);
  assert.equal(store.notices(inserted.id).length, 0, 'the wait raises no escalation notice');
  // The board card reads the same wait.
  const card = summarizeTask(waiting, false, false, {}, [], undefined, host.hostId, store.eventsAll(inserted.id));
  assert.equal(card.stop, 'wait');
  assert.match(card.stopRecord?.detail ?? '', /Waiting on T3Code host synthetic-environment since /);

  // The transport returns: re-observe first, then one continuation, and never
  // the same continuation twice.
  await host.connect();
  await waitUntil(() => host.connected, 'the fake Nightly transport is back');
  calls.length = 0;
  await engine.wake();

  const resumed = store.task(inserted.id);
  assert.notEqual(resumed.resolution.stop?.reason, 'host_unavailable', 'the wait clears when the host is back');
  assert.equal(resumed.resolution.budgetClock?.since, null, 'the wall clock runs again');
  assert.equal(resumed.agentId, 'synthetic-worker', 'the task resumed on the same host and thread');
  const observedAt = calls.indexOf('observe:synthetic-worker');
  const continuationAt = calls.findIndex(call => call.startsWith('notify:ns-push-continuation'));
  assert.ok(observedAt >= 0, `the thread was re-observed: ${calls.join(', ')}`);
  assert.ok(continuationAt > observedAt, `the continuation followed the observation: ${calls.join(', ')}`);
  assert.equal(calls.filter(call => call.startsWith('notify:ns-push-continuation')).length, 1,
    'the resume sends its continuation once');

  calls.length = 0;
  await engine.wake();
  assert.equal(calls.filter(call => call.startsWith('notify:ns-push-continuation')).length, 0,
    'a later pass does not repeat the continuation');
});

/**
 * The one long-outage notice (Tom, 2026-11-14; T3 lane v18, host dropout option
 * 1: wait). Past the dispatch-limits bound each affected project's planner hears
 * once, with the host, its outage start and the waiting tasks; a shorter outage
 * hears nothing, and the same outage never asks again.
 */
test('an outage past the bound tells each affected project planner once and a shorter one tells nobody', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.setMeta('paused', false);
  const taskHost = 't3code:synthetic-outage';
  const plannerHost = 'paseo:synthetic-planner';
  const sends: { agentId: string; messageId: string; text: string }[] = [];
  const adapter = {
    hostId: plannerHost,
    notify: async (agentId: string, messageId: string, text: string) => { sends.push({ agentId, messageId, text }); },
    originAgent: async (id: string) => ({ id, workspaceId: 'synthetic-workspace', title: id, archived: false }),
    observe: async (id: string) => ({ id, workspaceId: 'synthetic-workspace', status: 'idle', active: false, permissions: false, error: '' }),
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 60_000);
  t.after(() => engine.stop());
  engine.hostIds = () => [taskHost, plannerHost];
  engine.hostAvailable = id => id === plannerHost;
  engine.identifyOriginHost = async id => parseAgentId(id)?.hostId;

  const plannerA = formatAgentId(plannerHost, 'planner-a');
  const plannerB = formatAgentId(plannerHost, 'planner-b');
  for (const [key, name, planner] of [['project-a', 'Project A', plannerA], ['project-b', 'Project B', plannerB]] as const) {
    store.upsertProject({ key, name, repositories: [{ origin: `synthetic/${key}`, path: `/synthetic/${key}` }] });
    store.setProjectPlanner({ key, agentId: planner, setBy: 'operator' });
  }
  const make = (title: string, project: string) => {
    const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title,
      repoPath: `/synthetic/${project}`, planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }),
      taskHost, 'handoff.md', base);
    return store.update(task.id, { phase: 'working', workspaceId: `workspace-${task.id}`, agentId: `worker-${task.id}`, runId: 'initial' }, 'dispatched');
  };
  const a1 = make('First project A task', 'project-a');
  const a2 = make('Second project A task', 'project-a');
  const b1 = make('Project B task', 'project-b');

  // A shorter outage: every task waits visibly, and no planner hears anything.
  await engine.wake();
  for (const task of [a1, a2, b1]) assert.equal(store.task(task.id).resolution.stop?.reason, 'host_unavailable');
  assert.equal(store.notices().filter(notice => notice.kind === 'host_outage').length, 0, 'a shorter outage sends no planner notice');
  assert.equal(sends.length, 0);

  // The same outage is now past the bound: one notice for each affected project.
  const outages = store.getMeta<Record<string, { since: string; noticeSentAt: string | null }>>('hostOutages')!;
  const since = new Date(Date.now() - 3 * 3_600_000).toISOString();
  store.setMeta('hostOutages', { ...outages, [taskHost]: { ...outages[taskHost]!, since } });
  await engine.wake();
  const notices = store.notices().filter(notice => notice.kind === 'host_outage');
  assert.equal(notices.length, 2, 'one notice per affected project, not per task');
  assert.deepEqual(notices.map(notice => notice.agentId).sort(), [plannerA, plannerB].sort(),
    'each notice addressed to its project planner');
  assert.deepEqual(sends.map(send => send.agentId).sort(), ['planner-a', 'planner-b'], 'each project planner heard once');
  const textFor = (nativeId: string) => sends.filter(send => send.agentId === nativeId).map(send => send.text).join('\n');
  assert.match(textFor('planner-a'), new RegExp(`Host ${taskHost}`));
  assert.match(textFor('planner-a'), new RegExp(`unavailable since ${since}`));
  assert.match(textFor('planner-a'), /First project A task/);
  assert.match(textFor('planner-a'), /Second project A task/);
  assert.doesNotMatch(textFor('planner-a'), /Project B task/, 'a project hears only about its own waiting tasks');
  assert.match(textFor('planner-b'), /Project B task/);

  // The same outage never asks again.
  await engine.wake();
  assert.equal(store.notices().filter(notice => notice.kind === 'host_outage').length, 2);
  assert.equal(sends.length, 2, 'the same outage repeats no notice');
});
