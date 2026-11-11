import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { ParticipantTickets, agentTicketKey, resolveTicketCaller } from '../core/dispatch/participant-tickets';
import { formatAgentId } from '../shared/agent-identity';
import { runSchema, submissionSchema } from '../shared/contracts';
import { RuntimeRepositories, type RepositoriesContext } from '../core/runtime/repositories';
import { startCallbacks } from '../service/callbacks/callback';
import { callbackRequest } from '../shared/service/callback-client.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'planner-ticket-'));
  const store = new Store(':memory:');
  const messages: Array<{ id: string; text: string }> = [];
  let available = true, sendFailure = false;
  const engine = new Engine(store, { notify: async (id: string, _messageId: string, text: string) => {
    messages.push({ id, text }); if (sendFailure) throw Error('send outcome unknown');
  } } as unknown as Adapter, 0);
  engine.identifyOriginHost = async () => 't3code:synthetic';
  engine.hostAvailable = () => available;
  const paths = { socketPath: join(directory, 'callback.sock'), helperPath: join(directory, 'helper.mjs') };
  const tickets = new ParticipantTickets(engine, paths);
  store.upsertProject({ key: 'example', name: 'Example', repositories: [{ origin: 'synthetic/example', path: '/synthetic/example' }] });
  const assign = (agentId: string | null) => store.setProjectPlanner({ key: 'example', agentId, setBy: 'operator' });
  const ticket = () => {
    const record = store.getMeta<{ path: string }>(agentTicketKey('example', 'planner'))!;
    return JSON.parse(readFileSync(record.path, 'utf8')) as { socketPath: string; participantId: string; token: string };
  };
  return { directory, store, engine, messages, paths, tickets, assign, ticket,
    offline() { available = false; }, online() { available = true; }, failSend() { sendFailure = true; } };
}

test('planner assignment issues an owner-only ticket through a host with no environment identity', async () => {
  const f = fixture();
  try {
    const repositories = new RuntimeRepositories({ store: f.store, engine: f.engine,
      markStoreAccess() {}, plannerChanged: () => f.tickets.ensure() } as unknown as RepositoriesContext);
    await repositories.setProjectPlanner({ key: 'example', agentId: formatAgentId('t3code:synthetic', 'planner') });
    const ticket = f.ticket();
    assert.deepEqual(resolveTicketCaller(f.store, { participantId: ticket.participantId }, ticket.token), {
      caller: formatAgentId('t3code:synthetic', 'planner'), hostId: 't3code:synthetic', source: 'participant-ticket',
    });
    const record = f.store.getMeta<{ path: string }>(agentTicketKey('example', 'planner'))!;
    assert.equal(statSync(record.path).mode & 0o777, 0o600);
    assert.equal(f.messages[0]?.id, 'planner');
    assert.ok(f.messages[0]?.text.includes(record.path));
    await f.tickets.ensure();
    assert.equal(f.messages.length, 1);
    assert.throws(() => resolveTicketCaller(f.store, { participantId: ticket.participantId }, 'wrong'), /revoked or invalid/);
  } finally { f.store.close(); }
});

test('reassigning the planner name revokes the previous thread; clearing the fallback keeps the registration and its ticket', async () => {
  const f = fixture();
  try {
    f.assign('planner'); await f.tickets.ensure(); const original = f.ticket();
    f.assign('replacement'); await f.tickets.ensure(); const replacement = f.ticket();
    assert.throws(() => resolveTicketCaller(f.store, original, original.token), /revoked or invalid/,
      'the planner name moved to another thread, so its old ticket is revoked');
    f.assign(null);
    assert.equal(resolveTicketCaller(f.store, replacement, replacement.token).caller, formatAgentId('t3code:synthetic', 'replacement'),
      'clearing the fallback role does not unregister the named agent');
    f.assign('planner'); await f.tickets.ensure();
    assert.notEqual(f.ticket().participantId, original.participantId);
    assert.throws(() => resolveTicketCaller(f.store, original, original.token), /revoked or invalid/);
    assert.throws(() => resolveTicketCaller(f.store, replacement, replacement.token), /revoked or invalid/,
      'reassigning the name back revokes the replacement');
  } finally { f.store.close(); }
});

test('recorded planners receive a ticket when their host connects, with no replay after unknown delivery', async () => {
  const f = fixture();
  try {
    f.assign('legacy-planner'); f.offline(); await f.tickets.ensure();
    assert.equal(f.store.getMeta(agentTicketKey('example', 'planner')), undefined);
    f.online(); f.failSend(); await f.tickets.ensure();
    const ticket = f.ticket();
    assert.equal(resolveTicketCaller(f.store, ticket, ticket.token).caller, formatAgentId('t3code:synthetic', 'legacy-planner'));
    await f.tickets.ensure();
    assert.equal(f.messages.length, 1);
    assert.equal(f.store.getMeta<{ delivery: string }>(agentTicketKey('example', 'planner'))?.delivery, 'unknown');
  } finally { f.store.close(); }
});

test('caller callback authenticates a run or current participant and refuses revoked tickets', async () => {
  const f = fixture();
  const close = await startCallbacks(f.paths.socketPath, f.paths.helperPath, f.engine);
  try {
    f.assign('planner'); await f.tickets.ensure(); const participant = f.ticket();
    const request = { participantId: participant.participantId };
    assert.equal((await callbackRequest(participant, '/caller', request) as { caller: string }).caller, formatAgentId('t3code:synthetic', 'planner'));
    const task = f.store.insert(submissionSchema.parse({ submissionId: 'caller-ticket', title: 'Caller', repoPath: '/synthetic/example', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'planner' }), 't3code:synthetic', 'handoff', 'a'.repeat(40));
    f.store.update(task.id, { runId: 'worker-run', agentId: 'worker' });
    f.store.setCredential('worker-run', 'worker-token');
    const run = await callbackRequest({ socketPath: f.paths.socketPath, token: 'worker-token' }, '/caller', { taskId: task.id, runId: 'worker-run' });
    assert.deepEqual(run, { caller: formatAgentId('t3code:synthetic', 'worker'), hostId: 't3code:synthetic', source: 'run-ticket' });
    f.store.putRun(runSchema.parse({ id: 'released-reviewer', taskId: task.id, role: 'reviewer', generation: 0,
      head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: 'reviewer', workspaceId: 'synthetic-workspace', profile: null,
      status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null,
      completion: null, released: true }));
    f.store.setCredential('released-reviewer', 'released-token');
    await assert.rejects(callbackRequest({ socketPath: f.paths.socketPath, token: 'released-token' }, '/caller', { taskId: task.id, runId: 'released-reviewer' }), /released/);
    f.assign('replacement'); await f.tickets.ensure();
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
  f.engine.identifyOriginHost = async () => { entered(); await waiting; return 't3code:synthetic'; };
  try {
    f.assign('old-planner');
    const issuing = f.tickets.ensure(); await started;
    f.assign('current-planner'); const changed = f.tickets.ensure(); release();
    await Promise.all([issuing, changed]);
    assert.deepEqual(f.messages.map(message => message.id), ['current-planner']);
    const current = f.ticket();
    assert.equal(resolveTicketCaller(f.store, current, current.token).caller, formatAgentId('t3code:synthetic', 'current-planner'));
  } finally { f.store.close(); }
});

test('a registered planner question prompt names its participant ticket on a host without environment identity', async () => {
  const f = fixture();
  try {
    f.assign('planner'); await f.tickets.ensure();
    const task = f.store.insert(submissionSchema.parse({ submissionId: 'planner-question', title: 'Question', repoPath: '/synthetic/example', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'planner' }), 't3code:synthetic', 'handoff', 'a'.repeat(40));
    Object.assign(f.engine.adapter, { ...f.paths, reportingViaMcp: false });
    const command = f.engine.resolution.delegatePrompt(task, 'planner-question', 'Continue?', 'planner', 't3code:synthetic');
    const record = f.store.getMeta<{ path: string }>(agentTicketKey('example', 'planner'))!;
    assert.ok(command.includes(record.path));
    assert.ok(command.includes('nucleus question.answer -'));
    assert.ok(!command.includes('NUCLEUS_TICKET= nucleus'));
  } finally { f.store.close(); }
});
