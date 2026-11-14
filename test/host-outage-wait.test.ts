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
import { submissionSchema, summarizeTask, type Profile, type Run } from '../shared/contracts';
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
 * The acceptance transport is the fake Nightly (`test/support/t3code-fake.ts`,
 * records in the Nightly's own wire shape), really disconnected with
 * `dropSockets()`; task and run rows are written through the real Store, so they
 * carry every real field.
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

/** The identity fields of a stored run row; observation owns the rest. */
const runIdentity = (run: Run) => ({ id: run.id, role: run.role, agentId: run.agentId, workspaceId: run.workspaceId, head: run.head });

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
  // A real stored run row: the retained worker's current revision, unreleased and
  // observed by the sweep. Its identity must survive the outage unchanged.
  const revision: Run = {
    id: 'revision-run', taskId: inserted.id, hostId: host.hostId, role: 'revision', generation: 1,
    head, base, agentId: 'synthetic-worker', workspaceId: workspace.id, profile, profileGroup: 'synthetic',
    status: 'running', createdAt: new Date(Date.now() - 3_600_000).toISOString(), lastObservedAt: null,
    active: null, idleSince: null, completion: null, released: false,
  };
  store.putRun(revision);

  const calls: string[] = [];
  const adapter = {
    hostId: host.hostId,
    observe: async (id: string) => { calls.push(`observe:${id}`); return host.observe(id); },
    notify: async (_id: string, messageId: string) => { calls.push(`notify:${messageId}`); },
    originAgent: async (id: string) => ({ id, workspaceId: workspace.id, title: id, archived: false }),
  } as unknown as Adapter;
  // The ordinary 60 s idle grace: the resume pass re-observes the stored run
  // without reminding it, so the one send is the worker continuation.
  const engine = new Engine(store, adapter, 60_000);
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
  assert.deepEqual(waiting.resolution.hostWait && { hostId: waiting.resolution.hostWait.hostId }, { hostId: host.hostId },
    'the task records its own host wait');
  assert.equal(waiting.phase, 'working', 'the outage does not move the phase');
  assert.equal(waiting.agentId, 'synthetic-worker', 'the task keeps its retained thread');
  assert.equal(waiting.workspaceId, workspace.id, 'the task keeps its workspace');
  assert.ok(waiting.resolution.budgetClock?.since, 'the wall-time budget pauses for the outage');
  assert.equal(calls.length, 0, 'nothing is sent to or read from the disconnected host');
  const offlineRuns = store.runs(inserted.id);
  assert.equal(offlineRuns.length, 1, 'the stored run row is kept and no recovery run was added');
  assert.deepEqual(runIdentity(offlineRuns[0]!), runIdentity(revision), 'the stored run identity is untouched');
  const kinds = store.eventsAll(inserted.id).map(event => event.kind);
  for (const never of ['stalled_turn', 'run_stalled', 'incident', 'needs_attention', 'recovery_escalated', 'telemetry_recovery'])
    assert.equal(kinds.includes(never), false, `${never} is not raised by the outage: ${kinds.join(', ')}`);
  assert.equal(store.notices(inserted.id).length, 0, 'the wait raises no escalation notice');
  // The board card reads the same wait, independently of the stop record.
  const card = summarizeTask(waiting, false, true, {}, offlineRuns, undefined, host.hostId, store.eventsAll(inserted.id));
  assert.equal(card.stop, 'wait');
  assert.deepEqual(card.hostWait && { hostId: card.hostWait.hostId }, { hostId: host.hostId });

  // The transport returns: re-observe first, then one continuation, and never
  // the same continuation twice.
  await host.connect();
  await waitUntil(() => host.connected, 'the fake Nightly transport is back');
  calls.length = 0;
  await engine.wake();

  const resumed = store.task(inserted.id);
  assert.notEqual(resumed.resolution.stop?.reason, 'host_unavailable', 'the wait clears when the host is back');
  assert.equal(resumed.resolution.hostWait, null, 'the independent host wait is cleared');
  assert.equal(resumed.resolution.budgetClock?.since, null, 'the wall clock runs again');
  assert.equal(resumed.agentId, 'synthetic-worker', 'the task resumed on the same host and thread');
  const observedAt = calls.indexOf('observe:synthetic-worker');
  const continuationAt = calls.findIndex(call => call.startsWith('notify:ns-push-continuation'));
  assert.ok(observedAt >= 0, `the retained thread was re-observed: ${calls.join(', ')}`);
  assert.ok(continuationAt > observedAt, `the continuation followed the observation: ${calls.join(', ')}`);
  assert.equal(calls.filter(call => call.startsWith('notify:ns-push-continuation')).length, 1,
    'the resume sends its continuation once');
  const resumedRuns = store.runs(inserted.id);
  assert.equal(resumedRuns.length, 1, 'no replacement run was created for the resumed thread');
  assert.deepEqual(runIdentity(resumedRuns[0]!), runIdentity(revision), 'the resumed run is the same stored row');

  calls.length = 0;
  await engine.wake();
  assert.equal(calls.filter(call => call.startsWith('notify:ns-push-continuation')).length, 0,
    'a later pass does not repeat the continuation');
});

/**
 * The outage notice and the independent wait, over an engine with two healthy
 * planner hosts and one task host that is away. No T3 transport is needed here:
 * the availability signal is the engine's own `hostAvailable`.
 */
function noticeFixture() {
  const store = new Store(':memory:');
  store.setMeta('paused', false);
  const host = 't3code:synthetic-outage';
  const plannerHost = 'paseo:synthetic-planner';
  const sends: { agentId: string; messageId: string; text: string }[] = [];
  const adapter = {
    hostId: plannerHost,
    notify: async (agentId: string, messageId: string, text: string) => { sends.push({ agentId, messageId, text }); },
    originAgent: async (id: string) => ({ id, workspaceId: 'synthetic-workspace', title: id, archived: false }),
    observe: async (id: string) => ({ id, workspaceId: 'synthetic-workspace', status: 'idle', active: false, permissions: false, error: '' }),
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 60_000);
  engine.hostIds = () => [host, plannerHost];
  // The task host starts away; a test may recover it. The planner host starts
  // reachable and may also go away.
  const online = { task: false, planner: true };
  engine.hostAvailable = id => id === plannerHost ? online.planner : id === host ? online.task : false;
  engine.identifyOriginHost = async id => parseAgentId(id)?.hostId;
  const makeProject = (key: string, planner: string | null) => {
    store.upsertProject({ key, name: `Project ${key}`, repositories: [{ origin: `synthetic/${key}`, path: `/synthetic/${key}` }] });
    if (planner) store.setProjectPlanner({ key, agentId: planner, setBy: 'operator' });
  };
  const makeTask = (title: string, project: string) => {
    const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title,
      repoPath: `/synthetic/${project}`, planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }),
      host, 'handoff.md', base);
    return store.update(task.id, { phase: 'working', workspaceId: `workspace-${task.id}`, agentId: `worker-${task.id}`, runId: 'initial' }, 'dispatched');
  };
  /** Move the current outage's start back, as a long outage would be. */
  const ageOutage = (minutes: number) => {
    const outages = store.getMeta<Record<string, { since: string; notifiedProjects: Record<string, string> }>>('hostOutages')!;
    store.setMeta('hostOutages', { ...outages, [host]: { ...outages[host]!, since: new Date(Date.now() - minutes * 60_000).toISOString() } });
  };
  return { store, engine, sends, online, host, plannerHost, makeProject, makeTask, ageOutage,
    close: () => { void engine.stop(); store.close(); } };
}

test('an outage past the bound tells each affected project planner once and a shorter one tells nobody', async () => {
  const f = noticeFixture();
  const plannerA = formatAgentId(f.plannerHost, 'planner-a');
  const plannerB = formatAgentId(f.plannerHost, 'planner-b');
  f.makeProject('project-a', plannerA);
  f.makeProject('project-b', plannerB);
  const a1 = f.makeTask('First project A task', 'project-a');
  const a2 = f.makeTask('Second project A task', 'project-a');
  const b1 = f.makeTask('Project B task', 'project-b');
  try {
    // A shorter outage: every task waits visibly, and no planner hears anything.
    await f.engine.wake();
    for (const task of [a1, a2, b1]) {
      assert.equal(f.store.task(task.id).resolution.stop?.reason, 'host_unavailable');
      assert.ok(f.store.task(task.id).resolution.hostWait, 'the task records its own host wait');
    }
    assert.equal(f.store.notices().filter(notice => notice.kind === 'host_outage').length, 0, 'a shorter outage sends no planner notice');
    assert.equal(f.sends.length, 0);

    // The same outage is now past the bound: one notice for each affected project.
    f.ageOutage(180);
    await f.engine.wake();
    const notices = f.store.notices().filter(notice => notice.kind === 'host_outage');
    assert.equal(notices.length, 2, 'one notice per affected project, not per task');
    assert.deepEqual(notices.map(notice => notice.agentId).sort(), [plannerA, plannerB].sort(),
      'each notice addressed to its project planner');
    assert.deepEqual(f.sends.map(send => send.agentId).sort(), ['planner-a', 'planner-b'], 'each project planner heard once');
    const textFor = (nativeId: string) => f.sends.filter(send => send.agentId === nativeId).map(send => send.text).join('\n');
    assert.match(textFor('planner-a'), new RegExp(`Host ${f.host}`));
    assert.match(textFor('planner-a'), /unavailable since \d{4}-\d{2}-\d{2}T/);
    assert.match(textFor('planner-a'), /First project A task/);
    assert.match(textFor('planner-a'), /Second project A task/);
    assert.doesNotMatch(textFor('planner-a'), /Project B task/, 'a project hears only about its own waiting tasks');
    assert.match(textFor('planner-b'), /Project B task/);

    // The same outage never asks again.
    await f.engine.wake();
    assert.equal(f.store.notices().filter(notice => notice.kind === 'host_outage').length, 2);
    assert.equal(f.sends.length, 2, 'the same outage repeats no notice');
  } finally { f.close(); }
});

test('a project that becomes affected later, or gains its planner later, still hears once for the same outage', async () => {
  const f = noticeFixture();
  const plannerA = formatAgentId(f.plannerHost, 'planner-a');
  const plannerB = formatAgentId(f.plannerHost, 'planner-b');
  const plannerC = formatAgentId(f.plannerHost, 'planner-c');
  f.makeProject('project-a', plannerA);
  // Project C has no planner yet when the outage passes its bound.
  f.makeProject('project-c', null);
  f.makeTask('Project A task', 'project-a');
  f.makeTask('Project C task', 'project-c');
  try {
    await f.engine.wake();
    f.ageOutage(180);
    await f.engine.wake();
    assert.deepEqual(f.sends.map(send => send.agentId), ['planner-a'], 'only the project with a planner was told');
    assert.equal(f.store.notices().filter(notice => notice.kind === 'host_outage').length, 1);

    // A project that only submits work now is affected by the still-open outage.
    f.makeProject('project-b', plannerB);
    f.makeTask('Project B task', 'project-b');
    await f.engine.wake();
    assert.equal(f.sends.length, 2, 'the later project heard once');
    assert.deepEqual(f.sends.map(send => send.agentId).sort(), ['planner-a', 'planner-b']);

    // A project skipped for want of a planner is retried once it has one.
    f.store.setProjectPlanner({ key: 'project-c', agentId: plannerC, setBy: 'operator' });
    await f.engine.wake();
    assert.equal(f.sends.length, 3, 'the previously skipped project heard once');
    assert.deepEqual(f.sends.map(send => send.agentId).sort(), ['planner-a', 'planner-b', 'planner-c']);
    // And project A did not hear again.
    assert.equal(f.sends.filter(send => send.agentId === 'planner-a').length, 1);
    assert.equal(f.store.notices().filter(notice => notice.kind === 'host_outage').length, 3);
  } finally { f.close(); }
});

test('an owner-facing stop keeps its question while the host wait still pauses the clock, shows on the card and joins the notice', async () => {
  const f = noticeFixture();
  const plannerA = formatAgentId(f.plannerHost, 'planner-a');
  f.makeProject('project-a', plannerA);
  const task = f.makeTask('Interactive task', 'project-a');
  try {
    // An interactive turn is the operator's answer to give; the outage neither
    // raises nor answers it.
    f.store.update(task.id, { interactive: true, phase: 'working' }, 'interactive');
    f.engine.resolution.waiting(f.store.task(task.id), "Interactive session: waiting for the operator in the worker's thread", 'interactive');
    await f.engine.wake();

    const waiting = f.store.task(task.id);
    assert.equal(waiting.resolution.stop?.reason, 'interactive', 'the question stays the current stop');
    assert.deepEqual(waiting.resolution.hostWait && { hostId: waiting.resolution.hostWait.hostId }, { hostId: f.host },
      'the host wait is recorded independently of the stop');
    assert.ok(waiting.resolution.budgetClock?.since, 'the outage still pauses the wall clock');
    const card = summarizeTask(waiting, false, false, {}, [], undefined, f.plannerHost, f.store.eventsAll(task.id));
    assert.equal(card.stopRecord?.reason, 'interactive', 'the card keeps the owner question');
    assert.deepEqual(card.hostWait && { hostId: card.hostWait.hostId }, { hostId: f.host }, 'and shows the host wait');

    // The preserved-stop task is in its project's notice, and the notice reaches
    // the planner once the outage passes the bound.
    f.ageOutage(180);
    await f.engine.wake();
    assert.equal(f.sends.length, 1, 'the project planner heard once');
    assert.match(f.sends[0]!.text, /Interactive task/, 'the waiting task is named even with an owner-facing stop');
    assert.equal(f.store.task(task.id).resolution.stop?.reason, 'interactive', 'the notice does not replace the question');
  } finally { f.close(); }
});

test('a pending long-outage notice is delivered once its planner is reachable, even after the host recovered', async () => {
  const f = noticeFixture();
  const plannerA = formatAgentId(f.plannerHost, 'planner-a');
  f.makeProject('project-a', plannerA);
  const task = f.makeTask('Project A task', 'project-a');
  try {
    // The planner's own host is unreachable when the outage passes the bound.
    f.online.planner = false;
    await f.engine.wake();
    f.ageOutage(180);
    await f.engine.wake();
    const pending = f.store.notices().filter(notice => notice.kind === 'host_outage');
    assert.equal(pending.length, 1, 'the notice is raised for the project');
    assert.equal(pending[0]!.status, 'pending', 'and waits for its planner');
    assert.match(pending[0]!.error, /Waiting for host paseo:synthetic-planner/);
    const plannerSends = () => f.sends.filter(send => send.agentId === 'planner-a');
    assert.equal(plannerSends().length, 0);

    // The task's host recovers before the planner is reachable: the notice is
    // still the record of that outage and must not be discarded.
    f.online.task = true;
    await f.engine.wake();
    assert.equal(f.store.task(task.id).resolution.hostWait, null, 'the task host wait cleared');
    assert.equal(f.store.notices().filter(notice => notice.kind === 'host_outage')[0]?.status, 'pending',
      'a recovered host does not discard the pending notice');
    assert.equal(plannerSends().length, 0, 'the recovered host alone does not deliver the notice');

    // The planner becomes reachable later: it hears once, for the outage that
    // already ended.
    f.online.planner = true;
    await f.engine.wake();
    assert.equal(plannerSends().length, 1, 'the planner hears once when it becomes reachable');
    assert.match(plannerSends()[0]!.text, new RegExp(`Host ${f.host}`));
    assert.equal(f.store.notices().filter(notice => notice.kind === 'host_outage')[0]?.status, 'delivered');

    await f.engine.wake();
    assert.equal(plannerSends().length, 1, 'the delivered notice is never resent');
  } finally { f.close(); }
});
