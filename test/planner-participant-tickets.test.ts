import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { PlannerParticipantTickets, resolveTicketCaller, plannerTicketKey, plannerTicketPendingKey, taskPlannerTicketKey } from '../core/dispatch/participant-tickets';
import { formatAgentId } from '../shared/agent-identity';
import { runSchema, submissionSchema } from '../shared/contracts';
import { RuntimeRepositories, type RepositoriesContext } from '../core/runtime/repositories';
import { QueueRuntime } from '../service/runtime-owner';
import { startCallbacks } from '../service/callbacks/callback';
import { callbackRequest } from '../shared/service/callback-client.mjs';
import { callerResolve } from '../shared/rpc/service';
import { projectSetPlanner } from '../shared/rpc/projects';
import { projectSchema } from '../shared/schema/projects';
import { buildProjectSettings } from '../core/planning/project-settings';
import { projectSettingsSchema } from '../shared/schema/project-settings';

const t3 = 't3code:synthetic';
const paseo = 'paseo:synthetic';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'planner-ticket-'));
  const store = new Store(':memory:');
  const messages: Array<{ id: string; text: string }> = [];
  let available = true, sendFailure = false;
  let observe: () => Promise<{ id: string; workspaceId: string | null; status: string; active: boolean; permissions: boolean; error: string }> = async () => ({ id: 'planner', workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' });
  let archived: boolean | null = false;
  const engine = new Engine(store, {
    hostId: t3,
    notify: async (id: string, _messageId: string, text: string) => {
      messages.push({ id, text }); if (sendFailure) throw Error('send outcome unknown');
    },
    originAgent: async (id: string) => archived === null ? null : ({ id, workspaceId: 'ws', title: 'Planner', archived }),
    observe: (id: string) => observe().then(observation => ({ ...observation, id })),
  } as unknown as Adapter, 0);
  engine.identifyOriginHost = async () => t3;
  engine.hostAvailable = () => available;
  const paths = { socketPath: join(directory, 'callback.sock'), helperPath: join(directory, 'helper.mjs') };
  const tickets = new PlannerParticipantTickets(engine, paths);
  store.upsertProject({ key: 'example', name: 'Example', repositories: [{ origin: 'synthetic/example', path: '/synthetic/example' }] });
  const assign = (agentId: string | null, setBy = 'operator') => store.setProjectPlanner({ key: 'example', agentId, setBy });
  const ticket = () => {
    const record = store.getMeta<{ path: string }>(plannerTicketKey('example'))!;
    return JSON.parse(readFileSync(record.path, 'utf8')) as { socketPath: string; participantId: string; token: string };
  };
  return { directory, store, engine, messages, paths, tickets, assign, ticket,
    record: () => store.getMeta<{ path: string; delivery: string }>(plannerTicketKey('example')),
    pending: () => store.getMeta<{ agentId: string; setAt: string; reason: string } | null>(plannerTicketPendingKey('example')),
    offline() { available = false; }, online() { available = true; }, failSend() { sendFailure = true; },
    setArchived(value: boolean | null) { archived = value; },
    unknownObservation() { observe = async () => { throw Error('inventory is unreadable'); }; },
    setStatus(status: string) { observe = async () => ({ id: 'planner', workspaceId: 'ws', status, active: false, permissions: false, error: '' }); } };
}

test('startup with an archived recorded planner sends nothing and records the ticket as pending', async () => {
  const f = fixture();
  try {
    f.assign(formatAgentId(t3, 'planner'));
    f.setArchived(true);
    await f.tickets.ensure();
    assert.deepEqual(f.messages, []);
    assert.equal(f.record(), undefined);
    assert.equal(f.pending()!.agentId, formatAgentId(t3, 'planner'));
    assert.ok(f.tickets.pendingPlanners().has('example'));
    // The board's project entry says so, not just the store.
    const settings = projectSettingsSchema.parse(buildProjectSettings({ projects: f.store.projects(), repositories: [],
      overrides: {}, defaultSlots: 4, liveAgentIds: new Set(), liveKnown: false, latestQaRuns: [],
      plannerTicketPending: f.tickets.pendingPlanners() }));
    assert.equal(settings.projects[0]?.plannerTicket, 'pending');
    assert.ok(settings.projects[0]?.problems.includes('Planner ticket pending'));
  } finally { f.store.close(); }
});

test('a live planner receives its ticket in the response to its own next call', async () => {
  const f = fixture();
  try {
    f.assign(formatAgentId(t3, 'planner'));
    await f.tickets.ensure();
    assert.deepEqual(f.messages, []);
    const handed = await f.tickets.forCaller(formatAgentId(t3, 'planner'));
    assert.equal(handed, f.record()?.path);
    assert.equal(f.record()?.delivery, 'self');
    assert.equal(f.pending(), undefined);
    assert.equal(f.tickets.pendingPlanners().size, 0);
    // The response carries the ticket path; nothing was sent into the thread.
    assert.deepEqual(f.messages, []);
    assert.equal(callerResolve.output.parse({ caller: formatAgentId(t3, 'planner'), hostId: t3, source: 'host', participantTicket: handed }).participantTicket, handed);
    // A planner with a ticket is never handed a second one.
    assert.equal(await f.tickets.forCaller(formatAgentId(t3, 'planner')), undefined);
    // Another thread never takes this planner's ticket.
    assert.equal(await f.tickets.forCaller(formatAgentId(t3, 'other-thread')), undefined);
    assert.equal(await f.tickets.forCaller(formatAgentId(paseo, 'planner')), undefined);
  } finally { f.store.close(); }
});

test('caller.resolve hands a registered planner its ticket in the response and sends nothing', async () => {
  const f = fixture();
  try {
    f.assign(formatAgentId(t3, 'planner'));
    await f.tickets.ensure();
    // The runtime's own resolution path, with only the pieces it reads here.
    const resolved = await QueueRuntime.prototype.resolveHostCaller.call(
      { hostRegistry: { onlineIds: () => [t3] }, plannerTickets: f.tickets } as never,
      { hostKind: 't3code', nativeAgentId: 'planner' });
    assert.equal(resolved.caller, formatAgentId(t3, 'planner'));
    assert.equal(resolved.participantTicket, f.record()?.path);
    assert.deepEqual(f.messages, []);
    const second = await QueueRuntime.prototype.resolveHostCaller.call(
      { hostRegistry: { onlineIds: () => [t3] }, plannerTickets: f.tickets } as never,
      { hostKind: 't3code', nativeAgentId: 'planner' });
    assert.equal(second.participantTicket, undefined, 'the ticket is handed over once');
  } finally { f.store.close(); }
});

test('board assignment of a live T3 planner sends one message and names it in the response schema', async () => {
  const f = fixture();
  try {
    const handed = await f.tickets.assigned('example');
    assert.equal(handed, undefined, 'a board assignment answers with the project, not a ticket');
    f.assign(formatAgentId(t3, 'planner'));
    await f.tickets.assigned('example');
    const ticket = f.ticket();
    assert.deepEqual(f.messages.map(message => message.id), ['planner']);
    assert.ok(f.messages[0]?.text.includes(f.record()!.path));
    assert.equal(f.record()?.delivery, 'delivered');
    assert.equal(resolveTicketCaller(f.store, { participantId: ticket.participantId }, ticket.token).caller, formatAgentId(t3, 'planner'));
    assert.equal(statSync(f.record()!.path).mode & 0o777, 0o600);
    await f.tickets.ensure();
    await f.tickets.assigned('example');
    assert.equal(f.messages.length, 1, 'a delivered ticket is never messaged again');
    assert.equal(projectSetPlanner.output.parse({ ...projectSchema.parse(f.store.projectByKey('example')), participantTicket: f.record()!.path }).participantTicket, f.record()!.path);
  } finally { f.store.close(); }
});

test('an unknown observation of the planner thread sends nothing', async () => {
  const f = fixture();
  try {
    f.assign(formatAgentId(t3, 'planner'));
    f.unknownObservation();
    await f.tickets.assigned('example');
    assert.deepEqual(f.messages, []);
    assert.equal(f.record(), undefined);
    assert.ok(f.pending(), 'the board keeps saying the ticket is pending');
    f.setArchived(null);
    f.setStatus('idle');
    await f.tickets.assigned('example');
    assert.deepEqual(f.messages, [], 'a missing thread is not a live one');
    assert.ok(f.pending());
    f.setArchived(false);
    f.setStatus('archived');
    await f.tickets.assigned('example');
    assert.deepEqual(f.messages, [], 'an archived observation sends nothing');
  } finally { f.store.close(); }
});

test('a self-naming planner takes its ticket from the assignment response instead of a message', async () => {
  const f = fixture();
  try {
    const setter = formatAgentId(t3, 'planner');
    const repositories = new RuntimeRepositories({ store: f.store, engine: f.engine,
      markStoreAccess() {}, plannerChanged: (key: string) => f.tickets.assigned(key) } as unknown as RepositoriesContext);
    const project = await repositories.setProjectPlanner({ key: 'example', agentId: 'planner', setBy: setter });
    assert.equal(project.planner?.agentId, setter);
    const handed = (project as { participantTicket?: string }).participantTicket;
    assert.equal(handed, f.record()?.path);
    assert.deepEqual(f.messages, []);
    const ticket = f.ticket();
    assert.equal(resolveTicketCaller(f.store, { participantId: ticket.participantId }, ticket.token).caller, setter);
  } finally { f.store.close(); }
});

test('reassigning, clearing, and returning to a planner revoke every previous ticket', async () => {
  const f = fixture();
  try {
    const first = formatAgentId(t3, 'planner'), second = formatAgentId(t3, 'replacement');
    f.assign(first); await f.tickets.forCaller(first); const original = f.ticket();
    f.assign(second); await f.tickets.forCaller(second); const replacement = f.ticket();
    assert.throws(() => resolveTicketCaller(f.store, original, original.token), /revoked or invalid/);
    f.assign(null);
    assert.throws(() => resolveTicketCaller(f.store, replacement, replacement.token), /revoked or invalid/);
    f.assign(first); await f.tickets.forCaller(first);
    assert.notEqual(f.ticket().participantId, original.participantId);
    assert.throws(() => resolveTicketCaller(f.store, original, original.token), /revoked or invalid/);
  } finally { f.store.close(); }
});

test('a failed delivery is recorded unknown and never replayed', async () => {
  const f = fixture();
  try {
    f.assign(formatAgentId(t3, 'planner'));
    f.failSend();
    await f.tickets.assigned('example');
    assert.equal(f.messages.length, 1);
    assert.equal(f.record()?.delivery, 'unknown');
    f.online();
    await f.tickets.assigned('example');
    await f.tickets.ensure();
    assert.equal(f.messages.length, 1, 'an unknown delivery is never resent');
  } finally { f.store.close(); }
});

test('caller callback authenticates a run or current participant and refuses revoked tickets', async () => {
  const f = fixture();
  const close = await startCallbacks(f.paths.socketPath, f.paths.helperPath, f.engine);
  try {
    const planner = formatAgentId(t3, 'planner');
    f.assign(planner); await f.tickets.forCaller(planner); const participant = f.ticket();
    const request = { participantId: participant.participantId };
    assert.equal((await callbackRequest(participant, '/caller', request) as { caller: string }).caller, planner);
    const task = f.store.insert(submissionSchema.parse({ submissionId: 'caller-ticket', title: 'Caller', repoPath: '/synthetic/example', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'planner' }), t3, 'handoff', 'a'.repeat(40));
    f.store.update(task.id, { runId: 'worker-run', agentId: 'worker' });
    f.store.setCredential('worker-run', 'worker-token');
    const run = await callbackRequest({ socketPath: f.paths.socketPath, token: 'worker-token' }, '/caller', { taskId: task.id, runId: 'worker-run' });
    assert.deepEqual(run, { caller: formatAgentId(t3, 'worker'), hostId: t3, source: 'run-ticket' });
    f.store.putRun(runSchema.parse({ id: 'released-reviewer', taskId: task.id, role: 'reviewer', generation: 0,
      head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: 'reviewer', workspaceId: 'synthetic-workspace', profile: null,
      status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null,
      completion: null, released: true }));
    f.store.setCredential('released-reviewer', 'released-token');
    await assert.rejects(callbackRequest({ socketPath: f.paths.socketPath, token: 'released-token' }, '/caller', { taskId: task.id, runId: 'released-reviewer' }), /released/);
    f.assign(null);
    await assert.rejects(callbackRequest(participant, '/caller', request), /revoked or invalid/);
    await assert.rejects(callbackRequest({ socketPath: f.paths.socketPath, token: 'wrong' }, '/caller', { taskId: task.id, runId: 'worker-run' }), /Unauthorized/);
  } finally { await close(); f.store.close(); }
});

test('a planner reassigned during host lookup never receives the superseded ticket', async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.engine.identifyOriginHost = async () => { entered(); await waiting; return t3; };
  try {
    f.assign('old-planner');
    const issuing = f.tickets.assigned('example'); await started;
    f.assign('current-planner'); const changed = f.tickets.assigned('example'); release();
    await Promise.all([issuing, changed]);
    assert.deepEqual(f.messages.map(message => message.id), ['current-planner']);
    const current = f.ticket();
    assert.equal(resolveTicketCaller(f.store, current, current.token).caller, formatAgentId(t3, 'current-planner'));
  } finally { f.store.close(); }
});

test('a registered planner question prompt names its participant ticket on a host without environment identity', async () => {
  const f = fixture();
  try {
    const planner = formatAgentId(t3, 'planner');
    f.assign(planner); await f.tickets.forCaller(planner);
    const task = f.store.insert(submissionSchema.parse({ submissionId: 'planner-question', title: 'Question', repoPath: '/synthetic/example', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'planner' }), t3, 'handoff', 'a'.repeat(40));
    Object.assign(f.engine.adapter, { ...f.paths, reportingViaMcp: false });
    const command = f.engine.resolution.delegatePrompt(task, 'planner-question', 'Continue?', 'planner', t3);
    const record = f.store.getMeta<{ path: string }>(plannerTicketKey('example'))!;
    assert.ok(command.includes(record.path));
    assert.ok(command.includes('nucleus question.answer -'));
    assert.ok(!command.includes('NUCLEUS_TICKET= nucleus'));
  } finally { f.store.close(); }
});

test('task 1109: a task planner on a ticket-only host answers, and reparenting moves the ticket scope', async () => {
  const f = fixture();
  const close = await startCallbacks(f.paths.socketPath, f.paths.helperPath, f.engine);
  try {
    const planner = formatAgentId(t3, 'task-planner');
    const task = f.store.insert(submissionSchema.parse({ submissionId: 'task-planner-ticket', title: 'Task planner',
      repoPath: '/synthetic/example', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: planner }), t3, 'handoff', 'a'.repeat(40));
    const key = taskPlannerTicketKey(t3, 'task-planner');
    // A host that supplies no calling-thread identity receives one message naming its ticket.
    await f.tickets.ensureFor(planner, t3);
    const record = f.store.getMeta<{ path: string; delivery: string }>(key)!;
    assert.ok(record, 'the task planner received a participant ticket');
    assert.equal(record.delivery, 'delivered');
    assert.deepEqual(f.messages.map(message => message.id), ['task-planner']);
    assert.ok(f.messages[0]!.text.includes(record.path));
    const ticket = JSON.parse(readFileSync(record.path, 'utf8')) as { participantId: string; token: string };
    const caller = resolveTicketCaller(f.store, { participantId: ticket.participantId }, ticket.token);
    assert.deepEqual(caller, { caller: planner, hostId: t3, source: 'participant-ticket' });
    assert.equal(statSync(record.path).mode & 0o777, 0o600);
    // The ticket answers the question the task's own planner was asked.
    f.engine.resolution.openDelegatedQuestion(task, 'task-planner-window', planner, 'Question: Continue?', 10_000, 'planner', t3, 'task');
    const receipt = await f.engine.resolution.answerDelegatedQuestionFromHost({ questionId: 'task-planner-window', answer: 'Continue', reason: 'Within the brief' }, caller.caller);
    assert.equal(receipt.answer, 'Continue');
    // Reparenting moves the scope: the old planner's ticket is revoked and the new owner takes one.
    await f.engine.reparent({ toAgentId: 'successor', taskIds: [task.id], caller: 'operator (board)', reason: 'The successor promotes this task' } as never);
    assert.equal(f.store.task(task.id).notificationAgentId, 'successor');
    assert.throws(() => resolveTicketCaller(f.store, { participantId: ticket.participantId }, ticket.token), /revoked or invalid/);
    const before = f.messages.length;
    const handed = await f.tickets.forCaller(formatAgentId(t3, 'successor'));
    const successor = f.store.getMeta<{ path: string; delivery: string }>(taskPlannerTicketKey(t3, 'successor'))!;
    assert.equal(handed, successor.path, 'the new owner takes its ticket in its own call');
    assert.equal(successor.delivery, 'self');
    assert.equal(f.messages.length, before, 'the self route sends nothing into the thread');
    const successorTicket = JSON.parse(readFileSync(successor.path, 'utf8')) as { participantId: string; token: string };
    assert.equal(resolveTicketCaller(f.store, { participantId: successorTicket.participantId }, successorTicket.token).caller,
      formatAgentId(t3, 'successor'));
  } finally { await close(); f.store.close(); }
});
