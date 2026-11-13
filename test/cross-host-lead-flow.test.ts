import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';
import { git } from '../core/git/index';
import { leadSubmit, submissionSchema, type Profile } from '../shared/contracts';
import { formatAgentId } from '../shared/agent-identity';
import { taskPlannerTicketKey } from '../core/dispatch/participant-tickets';
import { writeRunTicket } from '../core/dispatch/agent-creation';
import { fakeAdapter } from './support/fakes';
import { paseoCatalog } from './support/pool-shapes';
import type { Adapter } from '../core/host';

const paseoHost = 'paseo:primary';
const t3Host = 't3code:trial';

const waitUntil = async (ready: () => boolean, label: string, timeoutMs = 10_000) => {
  const start = Date.now();
  while (!ready() && Date.now() - start < timeoutMs) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(ready(), label);
};

interface HostRecording {
  workspaces: string[];
  agents: Array<{ id: string; promptIncludesTicket: boolean }>;
  asks: Array<{ recipient: string; prompt: string }>;
  notifications: Array<{ id: string; text: string; messageId?: string }>;
  origins: string[];
}

const recording = () => ({ workspaces: [], agents: [], asks: [], notifications: [], origins: [] } as HostRecording);

// The recorded Paseo catalog (#1143's shared shape): the profile names a model it
// really reports, so selection judges the real translation. A provider key the
// canonical vocabulary does not name is invisible here, never a passing fixture.
const testProfile: Profile = { id: 'worker', name: 'Worker', provider: 'codex', model: 'gpt-6-luna', notes: '', available: true, problem: '', supportedThinking: ['low'] };

const catalog = paseoCatalog();

interface Fixture {
  runtime: QueueRuntime;
  repo: string;
  root: string;
  paseo: HostRecording;
  t3: HostRecording;
  planner: string;
  close: () => Promise<void>;
}

/** One service, two registered hosts: the primary fake Paseo adapter and a registered fake T3 adapter. */
async function fixture(): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cross-host-lead-')));
  const repo = join(root, 'repo');
  await git(root, 'init', '--bare', '--initial-branch=main', join(root, 'origin.git'));
  await git(root, 'clone', join(root, 'origin.git'), repo);
  await git(repo, 'config', 'user.name', 'Queue test');
  await git(repo, 'config', 'user.email', 'queue@example.invalid');
  await mkdirSync(join(repo, '.paseo'), { recursive: true });
  writeFileSync(join(repo, '.paseo/queue.json'), JSON.stringify({ schema: 'paseo.queue.control.v5', closeout: 'queue', hooks: [] }));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'fixture');
  await git(repo, 'push', 'origin', 'main');

  const paseoRecord = recording(), t3Record = recording();
  const socketPath = join(root, 'callback.sock'), helperPath = join(root, 'worker-report.mjs');

  // The Paseo host: the planner thread lives here, so identity reads, asks and
  // notices for the planner must arrive on this adapter and no other.
  const paseoAdapter = fakeAdapter({
    client: { isConnected: true },
    hostId: paseoHost, socketPath, helperPath,
    connect: async () => {}, close: async () => {},
    catalog: async () => catalog,
    validate: async (task: { planningCommit: string }) => task.planningCommit,
    verifyWorkspace: async (_task: unknown, directory: string) => directory,
    createWorkspace: async (task: { id: string }) => { paseoRecord.workspaces.push(task.id); return { id: `paseo-ws-${task.id}`, directory: repo }; },
    createAgent: async () => { throw new Error('Paseo adapter must never create this task\'s worker'); },
    observe: async (id: string) => ({ id, workspaceId: 'planner-ws', status: 'idle', active: false, permissions: false, error: '' }),
    originAgent: async (id: string) => { paseoRecord.origins.push(id); return { id, workspaceId: 'planner-ws', title: 'Planner', archived: false }; },
    notify: async (id: string, messageId: string, text: string) => { paseoRecord.notifications.push({ id, text }); },
    askPlanner: async (recipient: string, input: { prompt: string }) => { paseoRecord.asks.push({ recipient, prompt: input.prompt }); return null; },
    archiveAgent: async () => {},
    findOpenBranchPr: async () => [],
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/1', head: 'abc', repository: 'example/repo', headRepository: 'example/repo' }),
  }) as Adapter;

  // The T3 host: the trial repository's worker runs here.
  const t3Adapter = fakeAdapter({
    client: { isConnected: true },
    hostId: t3Host, socketPath, helperPath,
    connect: async () => {}, close: async () => {},
    catalog: async () => catalog,
    validate: async (task: { planningCommit: string }) => task.planningCommit,
    verifyWorkspace: async (_task: unknown, directory: string) => directory,
    createWorkspace: async (task: { id: string }) => { t3Record.workspaces.push(task.id); return { id: `t3-ws-${task.id}`, directory: repo }; },
    createAgent: (task, token, prompt) => {
      // The host policy writes the worker's run ticket before create; the fake
      // writes the same ticket so the helper can report through the callback.
      writeRunTicket({ socketPath, helperPath }, task, { id: task.runId ?? '', role: 'worker', generation: 0 }, token);
      t3Record.agents.push({ id: `t3-agent-${task.id}`, promptIncludesTicket: prompt.includes(runTicketMarker(helperPath)) });
      return Promise.resolve({ id: `t3-agent-${task.id}`, workspaceId: task.workspaceId ?? null });
    },
    observe: async (id: string) => ({ id, workspaceId: `t3-ws-${id}`, status: 'idle', active: false, permissions: false, error: '' }),
    originAgent: async (id: string) => {
      if (id === 'planner') return null;
      t3Record.origins.push(id);
      return { id, workspaceId: 't3-ws', title: 'Thread', archived: false as const };
    },
    notify: async (id: string, messageId: string, text: string) => { t3Record.notifications.push({ id, text, messageId }); },
    archiveAgent: async () => {},
    findOpenBranchPr: async () => [],
  }) as Adapter;

  const runtime = new QueueRuntime({ dataDir: join(root, 'data'), adapterFactory: () => paseoAdapter, timers: false });
  await runtime.started;
  await runtime.bootstrap;
  runtime.hostRegistry.connect(t3Host, 't3code-endpoint', { adapter: t3Adapter, admission: runtime.admission });
  // The trial repository opts into T3; the planner lives on the Paseo host.
  runtime.store.putRepository({ origin: repo, path: repo }, null, '', null, null, null, undefined, undefined, 't3code');
  runtime.store.upsertProject({ key: 'trial', name: 'Trial', repositories: [{ origin: repo, path: repo }] });
  const planner = formatAgentId(paseoHost, 'planner');
  runtime.store.setProjectPlanner({ key: 'trial', agentId: planner, setBy: 'operator (board)' });
  runtime.store.setProfiles([{ id: testProfile.id, name: testProfile.name, provider: testProfile.provider, model: testProfile.model, notes: '' }]);
  runtime.store.setMeta('pool', [{ profileId: testProfile.id, enabled: true, group: 'test', weight: 1, roles: ['worker' as const], scopes: ['general' as const] }]);
  // A fresh store starts paused with an empty catalog; this fixture runs the service unpaused with the profile routed.
  runtime.store.setMeta('paused', false);
  await runtime.engine.refresh();
  // The worker's ask resolves inside the helper's bounded window, and the delegated answer waits briefly.
  runtime.engine.resolution.agentAskWaitMs = 15_000;
  runtime.engine.resolution.agentAskPollMs = 20;
  runtime.engine.resolution.delegatedAnswerWaitMs = 8_000;
  const close = async () => { await runtime.drain(); };
  return { runtime, repo, root, paseo: paseoRecord, t3: t3Record, planner, close };
}

/** The worker run ticket the dispatch writes under the shared helper directory. */
const runTicketMarker = (helperPath: string) => join(dirname(helperPath), 'tickets');

const leadBody = `---\ntitle: Cross-host lead\nqueue:\n  complexity: medium\n  notifyOriginOnCloseout: true\n---\n\n## Outcome\n\nBuild the cross-host fixture.\n`;

function spawnCli(env: NodeJS.ProcessEnv, args: string[], payload: unknown, cwd = process.cwd()) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(cwd, 'bin', 'nucleus.mjs'), ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(), ...env } });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('a paseo planner submits a lead for a t3code repository, the task dispatches on t3, its ask reaches the paseo planner, and the closeout notice follows', async () => {
  const f = await fixture();
  try {
    const result = leadSubmit.output.parse(await f.runtime.submitLead({
      repository: { origin: f.repo, path: f.repo }, title: 'Cross-host lead', body: leadBody,
      baseBranch: 'main', lanes: [], tags: [], agent: f.planner, note: 'Tom authorized this fixture',
    }));
    // The lead check passed with a cross-host author, and the promotion names the T3 host.
    assert.ok('taskId' in result, JSON.stringify(result));
    const task = f.runtime.store.task(result.taskId);
    assert.ok(task.hostSelection, 'the promoted task records its host selection');
    assert.equal(task.hostSelection!.hostId, t3Host);
    assert.equal(task.hostId, t3Host);
    assert.equal(task.originHostId, paseoHost, 'the origin (the planner) stays on the Paseo host');
    const lead = f.runtime.store.leads().find(candidate => candidate.title === 'Cross-host lead');
    assert.equal(lead?.check?.ok, true, lead?.check?.message);
    // The Paseo planner's identity was read on its own host, from inside the T3-bound check.
    assert.ok(f.paseo.origins.includes('planner'), 'the Paseo adapter served the author check');

    // The worker dispatches on the T3 adapter, never on Paseo.
    await f.runtime.engine.dispatchTask(task.id, false);
    for (let i = 0; i < 400 && !f.runtime.store.task(task.id).agentId; i++) await new Promise(resolve => setTimeout(resolve, 25));
    await waitUntil(() => f.runtime.store.task(task.id).agentId?.startsWith('t3-agent-') === true, 'worker dispatched on the T3 adapter');
    assert.equal(f.paseo.workspaces.length, 0, 'no workspace was created on Paseo');
    assert.equal(f.t3.workspaces.length, 1, 'the workspace was created on T3');
    assert.equal(f.t3.agents.length, 1, 'the worker was created on T3');
    assert.ok(f.t3.agents[0]!.promptIncludesTicket, 'the T3 worker prompt carries its run ticket');
    const runId = f.runtime.store.task(task.id).runId!;
    const runTicketPath = join(f.root, 'tickets', `${runId}.json`);
    assert.ok(existsSync(runTicketPath), 'the worker run ticket exists for helper reporting');

    // The worker asks through the real helper; the ask routes to the Paseo planner on its own host.
    const helper = join(f.root, 'worker-report.mjs');
    const pendingAsk = new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [helper, runTicketPath, 'ask'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { err += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, out, err }));
      child.stdin.end(JSON.stringify({ question: 'May the worker extend this task by one budget step?', kind: 'budget', headline: 'Budget extension', choices: ['Extend', 'Finish now'] }));
    });
    await waitUntil(() => f.paseo.asks.length === 1, 'the worker ask reached the Paseo planner adapter');
    assert.equal(f.paseo.asks[0]!.recipient, 'planner', 'the planner was asked by its native id on its own host');
    assert.match(f.paseo.asks[0]!.prompt, /May the worker extend this task by one budget step\?/);
    const askEvent = f.runtime.store.eventsAll(task.id).find(event => event.kind === 'agent_ask');
    assert.ok(askEvent, 'the ask is recorded');
    const askId = askEvent!.detail.split(':')[0]!;
    assert.ok(f.runtime.store.eventsAll(`delegation:ns-agent-ask-${askId}`).some(event => event.kind === 'delegated_delivery'), 'the delegated question was opened');

    // The planner answers through the question.answer service route with its qualified caller.
    const answer = await f.runtime.answerDelegatedQuestion({
      questionId: `ns-agent-ask-${askId}`, answer: 'Extend', reason: 'Within the approved outcome', caller: f.planner,
    });
    assert.equal((answer as { questionId?: string }).questionId, `ns-agent-ask-${askId}`);
    const receipt = JSON.parse(await pendingAsk.then(result => { assert.equal(result.code, 0, result.err); return result.out; })) as { status: string; answer?: string };
    assert.equal(receipt.status, 'answered');
    assert.match(receipt.answer ?? '', /Extend/, 'the planner answer reached the waiting helper');

    // Closeout: the origin notice reaches the Paseo planner through its own host.
    f.runtime.store.update(task.id, { phase: 'done', reason: 'Fixture complete' }, 'task_completed', 'The cross-host fixture completed');
    await f.runtime.engine.resolution.deliverNotices();
    await waitUntil(() => f.paseo.notifications.some(notification => notification.text.includes('Nucleus completion') && notification.text.includes('Cross-host lead')),
      'the closeout notice reached the Paseo planner');
    assert.ok(f.t3.notifications.every(notification => !notification.text.includes('Nucleus completion')),
      `no completion notice went to the T3 host: ${JSON.stringify(f.t3.notifications)}`);
    assert.ok(f.paseo.notifications.every(notification => !notification.text.includes('Your Nucleus question')),
      'the worker answer went back to the T3 worker, not to the planner thread');

    // A legacy bare author still resolves to Paseo during a T3 lead check.
    const t3Recipient = formatAgentId(t3Host, 'observer');
    const legacyBody = leadBody.replace('Cross-host lead', 'Legacy author lead')
      .replace('  notifyOriginOnCloseout: true', `  notifyOriginOnCloseout: true\n  completionNotificationAgentIds: ['${t3Recipient}']`);
    const legacy = leadSubmit.output.parse(await f.runtime.submitLead({
      repository: { origin: f.repo, path: f.repo }, title: 'Legacy author lead',
      body: legacyBody, baseBranch: 'main', lanes: [], tags: [],
      agent: 'planner', note: 'Tom authorized this fixture',
    }));
    assert.ok('taskId' in legacy, JSON.stringify(legacy));
    const legacyTask = f.runtime.store.task(legacy.taskId);
    const legacyLead = f.runtime.store.leads().find(candidate => candidate.title === 'Legacy author lead');
    assert.equal(legacyLead?.check?.ok, true, legacyLead?.check?.message);
    assert.equal(legacyTask.hostId, t3Host);
    assert.equal(legacyTask.originAgentId, 'planner');
    assert.equal(legacyTask.originHostId, paseoHost);
    assert.ok(f.t3.origins.includes('observer'), 'the T3 completion recipient was looked up on its own host');
    await f.runtime.engine.dispatchTask(legacyTask.id, false);
    await waitUntil(() => f.runtime.store.task(legacyTask.id).agentId?.startsWith('t3-agent-') === true, 'legacy author task dispatched on T3');
    f.runtime.store.update(legacyTask.id, { phase: 'done', reason: 'Legacy fixture complete' }, 'task_completed', 'The legacy cross-host fixture completed');
    await f.runtime.engine.resolution.deliverNotices();
    await waitUntil(() => f.paseo.notifications.some(notification => notification.text.includes('Nucleus completion') && notification.text.includes('Legacy author lead')),
      'the closeout notice reached the bare-ID Paseo author');
    await waitUntil(() => f.t3.notifications.some(notification => notification.text.includes('Nucleus completion') && notification.text.includes('Legacy author lead')),
      'the completion notice reached its T3 recipient');
  } finally { await f.close(); }
});

test('a proven caller keeps its ticket: caller.resolve repeats return the same path, and nucleus tell succeeds', async () => {
  const f = await fixture();
  try {
    // The project planner was set by another thread; Paseo hands the ticket over on the planner's own call.
    const first = await f.runtime.resolveHostCaller({ hostKind: 'paseo', nativeAgentId: 'planner' });
    assert.equal(first.source, 'host');
    const projectTicket = first.participantTicket;
    assert.ok(projectTicket, 'the first resolution hands over the project planner ticket');
    const second = await f.runtime.resolveHostCaller({ hostKind: 'paseo', nativeAgentId: 'planner' });
    assert.equal(second.participantTicket, projectTicket, 'a proven caller gets the same ticket path again');

    // nucleus tell from that thread, through the real CLI, succeeds with the resolved ticket.
    const told = await spawnCli({ NUCLEUS_TICKET: projectTicket! }, ['tell', '-'],
      { to: { project: 'trial' }, text: 'The cross-host lead promoted and its worker asked one budget question; answered Extend.' });
    assert.equal(told.code, 0, told.err || told.out);
    assert.match(told.out, /"status"/);

    // A T3 task planner: its ticket was issued once by message; every later resolution names that same path.
    const taskPlanner = formatAgentId(t3Host, 'task-planner');
    const task = f.runtime.store.insert(submissionSchema.parse({
      submissionId: 'cross-host-task-planner', title: 'Task planner ticket', repoPath: f.repo, planningCommit: 'a'.repeat(40),
      handoffPath: 'handoff.md', originAgentId: taskPlanner,
    }), t3Host, 'handoff', 'a'.repeat(40));
    await f.runtime.engine.resolution.ensurePlannerTicket?.(taskPlanner, t3Host);
    const record = f.runtime.store.getMeta<{ path: string; delivery: string }>(taskPlannerTicketKey(t3Host, 'task-planner'));
    assert.ok(record, 'the task planner received its ticket');
    assert.equal(record!.delivery, 'delivered');
    assert.equal(f.t3.notifications.length, 1, 'one message delivered the ticket');
    assert.match(f.t3.notifications[0]!.messageId ?? '', /^nucleus-planner-ticket-/, 'the ticket message reached the task planner thread');
    const resolved = await f.runtime.resolveHostCaller({ hostKind: 't3code', nativeAgentId: 'task-planner' });
    assert.equal(resolved.participantTicket, record!.path, 'the task planner resolution returns the issued ticket');
    const resolvedAgain = await f.runtime.resolveHostCaller({ hostKind: 't3code', nativeAgentId: 'task-planner' });
    assert.equal(resolvedAgain.participantTicket, record!.path, 'the same ticket path comes back on every resolution');
  } finally { await f.close(); }
});
