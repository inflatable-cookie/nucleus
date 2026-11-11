import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatAgentId } from '../shared/agent-identity';
import { agentTicketKey, plannerTicketKey, resolveTicketCaller } from '../core/dispatch/participant-tickets';
import { digest } from '../core/store/store';
import { projectAgentsFixture } from './support/project-agents-fixture';

const host = 't3code:synthetic';

test('project.set-planner still works for a caller that was never registered: it registers the thread under the default name', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const caller = formatAgentId(host, 'planner');
  f.live('planner');
  try {
    const project = await f.repositories.setProjectPlanner({ key: 'example', agentId: caller, setBy: caller });
    assert.equal(project.planner?.agentId, caller);
    assert.equal(project.planner?.name, 'planner', 'the fallback planner is a registered agent');
    assert.deepEqual(project.agents?.map(agent => ({ name: agent.name, agentId: agent.agentId })),
      [{ name: 'planner', agentId: caller }]);
    assert.deepEqual(f.sends.map(send => send.id), ['planner'], 'the registration issues the participant ticket');
    const ticketRecord = f.store.getMeta<{ path: string }>(agentTicketKey('example', 'planner'))!;
    const ticket = JSON.parse(readFileSync(ticketRecord.path, 'utf8')) as { participantId: string; token: string };
    assert.equal(resolveTicketCaller(f.store, { participantId: ticket.participantId }, ticket.token).caller, caller);
  } finally { f.store.close(); }
});

test('project.set-planner marks an already-registered thread under its own name and issues no second ticket', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const caller = formatAgentId(host, 'lead-a');
  f.live('lead-a');
  try {
    await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a', purpose: 'Cross-section', caller });
    const ticket = f.store.getMeta<{ participantId: string }>(agentTicketKey('example', 'lead-a'))!;
    const project = await f.repositories.setProjectPlanner({ key: 'example', agentId: caller, setBy: 'operator' });
    assert.equal(project.planner?.name, 'lead-a');
    assert.deepEqual(project.agents?.map(agent => agent.name), ['lead-a']);
    assert.equal(f.sends.length, 1);
    assert.equal(f.store.getMeta<{ participantId: string }>(agentTicketKey('example', 'lead-a'))?.participantId, ticket.participantId);
    assert.equal((await f.engine.projectAgents('example'))[0]?.fallback, true);
  } finally { f.store.close(); }
});

test('rotating the planner reassigns the default name: the old thread stays dead and the new one takes the name', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const first = formatAgentId(host, 'lead-a'), second = formatAgentId(host, 'lead-b');
  f.live('lead-a'); f.live('lead-b');
  try {
    await f.repositories.setProjectPlanner({ key: 'example', agentId: first, setBy: 'operator' });
    const oldRecord = f.store.getMeta<{ path: string }>(agentTicketKey('example', 'planner'))!;
    const old = JSON.parse(readFileSync(oldRecord.path, 'utf8')) as { participantId: string; token: string };
    await f.repositories.setProjectPlanner({ key: 'example', agentId: second, setBy: 'operator' });
    assert.equal(f.project().planner?.agentId, second);
    assert.deepEqual(f.project().agents?.map(agent => ({ name: agent.name, agentId: agent.agentId })),
      [{ name: 'planner', agentId: second }], 'the name survives the rotation; the old thread is not revived');
    const currentRecord = f.store.getMeta<{ path: string }>(agentTicketKey('example', 'planner'))!;
    assert.notEqual(currentRecord.path, oldRecord.path);
    assert.throws(() => resolveTicketCaller(f.store, { participantId: old.participantId }, old.token), /revoked or invalid/);
    const current = JSON.parse(readFileSync(currentRecord.path, 'utf8')) as { participantId: string; token: string };
    assert.equal(resolveTicketCaller(f.store, { participantId: current.participantId }, current.token).caller, second);
    assert.equal((await f.engine.projectAgents('example'))[0]?.fallback, true);
  } finally { f.store.close(); }
});

test('clearing the fallback planner does not unregister the thread or revoke its ticket', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const caller = formatAgentId(host, 'lead-a');
  f.live('lead-a');
  try {
    await f.repositories.setProjectPlanner({ key: 'example', agentId: caller, setBy: 'operator' });
    const record = f.store.getMeta<{ path: string }>(agentTicketKey('example', 'planner'))!;
    const ticket = JSON.parse(readFileSync(record.path, 'utf8')) as { participantId: string; token: string };
    const project = await f.repositories.setProjectPlanner({ key: 'example', agentId: null, setBy: 'operator' });
    assert.equal(project.planner, null);
    assert.deepEqual(project.agents?.map(agent => agent.name), ['planner']);
    assert.equal(resolveTicketCaller(f.store, { participantId: ticket.participantId }, ticket.token).caller, caller);
    await assert.rejects(() => f.engine.resolution.resolveProjectAgentTarget('example', null),
      /no fallback planner/);
  } finally { f.store.close(); }
});

test('a planner ticket delivered before the registry existed is adopted, not reissued', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const caller = formatAgentId(host, 'lead-a');
  f.live('lead-a');
  try {
    // An older install: only the planner field and its own ticket record exist.
    f.store.setProjectPlanner({ key: 'example', agentId: caller, setBy: 'operator' });
    const participantId = randomUUID(), token = randomBytes(32).toString('hex');
    const path = join(f.directory, `legacy-${participantId}.json`);
    writeFileSync(path, JSON.stringify({ socketPath: join(f.directory, 'callback.sock'), participantId, token }));
    f.store.setMeta(plannerTicketKey('example'), {
      participantId, projectKey: 'example', agentId: caller, setAt: f.project().planner!.setAt,
      hostId: host, nativeAgentId: 'lead-a', tokenHash: digest(token), path, delivery: 'delivered',
    });
    f.store.setMeta(`plannerParticipantId:${participantId}`, 'example');
    await f.tickets.ensure();
    assert.deepEqual(f.sends, [], 'the delivered ticket is reused, never sent again');
    assert.equal(f.store.getMeta(plannerTicketKey('example')), undefined, 'the legacy record moved to the registry');
    assert.equal(f.store.getMeta<{ participantId: string }>(agentTicketKey('example', 'planner'))?.participantId, participantId);
    assert.equal(resolveTicketCaller(f.store, { participantId }, token).caller, caller);
    assert.deepEqual(f.project().agents?.map(agent => agent.name), ['planner']);
  } finally { f.store.close(); }
});

test('a planner set outside the RPC is registered on the next startup reconciliation', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const caller = formatAgentId(host, 'lead-a');
  try {
    f.store.setProjectPlanner({ key: 'example', agentId: caller, setBy: 'operator' });
    assert.equal(f.project().agents, undefined, 'nothing registers synchronously in the store');
    f.live('lead-a');
    await f.tickets.ensure();
    assert.deepEqual(f.project().agents?.map(agent => ({ name: agent.name, agentId: agent.agentId })),
      [{ name: 'planner', agentId: caller }]);
    assert.deepEqual(f.sends.map(send => send.id), ['lead-a']);
  } finally { f.store.close(); }
});

test('a fallback registered while another thread holds the default name takes a free name and the RPC answer matches the store', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const holder = formatAgentId(host, 'lead-x'), planner = formatAgentId(host, 'lead-z');
  f.live('lead-x'); f.live('lead-z');
  try {
    await f.repositories.registerProjectAgent({ project: 'example', name: 'planner', purpose: 'Owns the UI cross-section', caller: holder });
    const holderTicket = f.store.getMeta<{ participantId: string }>(agentTicketKey('example', 'planner'))!;
    const project = await f.repositories.setProjectPlanner({ key: 'example', agentId: planner, setBy: 'operator' });
    assert.deepEqual(project, f.project(), 'the RPC answer is the state the store holds');
    assert.deepEqual(project.agents?.map(agent => ({ name: agent.name, agentId: agent.agentId })),
      [{ name: 'planner', agentId: holder }, { name: 'planner-2', agentId: planner }],
      'another thread\'s address is never dropped for the fallback');
    assert.equal(project.planner?.name, 'planner-2');
    assert.equal(f.store.getMeta<{ participantId: string }>(agentTicketKey('example', 'planner'))?.participantId,
      holderTicket.participantId, 'the holder keeps its address and its ticket');
    const listed = await f.engine.projectAgents('example');
    assert.equal(listed.find(agent => agent.agentId === planner)?.fallback, true);
    assert.equal(listed.find(agent => agent.agentId === holder)?.fallback, false);
  } finally { f.store.close(); }
});
