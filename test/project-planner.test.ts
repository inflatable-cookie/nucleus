import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatAgentId } from '../shared/agent-identity';
import { agentTicketKey, plannerTicketKey, resolveTicketCaller } from '../core/dispatch/participant-tickets';
import { projectAgentsFixture } from './support/project-agents-fixture';

const host = 't3code:synthetic';
const ticketAt = (f: ReturnType<typeof projectAgentsFixture>, key: string) => {
  const record = f.store.getMeta<{ path: string }>(key)!;
  return JSON.parse(readFileSync(record.path, 'utf8')) as { participantId: string; token: string };
};

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
    assert.deepEqual(f.sends, [], 'a self-naming planner takes its ticket from the assignment response');
    const plannerRecord = f.store.getMeta<{ path: string }>(plannerTicketKey('example'))!;
    assert.equal((project as { participantTicket?: string }).participantTicket, plannerRecord.path);
    assert.equal(f.store.getMeta(agentTicketKey('example', 'planner')), undefined, 'the planner ticket is the entry identity');
    const ticket = ticketAt(f, plannerTicketKey('example'));
    assert.equal(resolveTicketCaller(f.store, { participantId: ticket.participantId }, ticket.token).caller, caller);
    assert.equal((await f.engine.projectAgents('example'))[0]?.fallback, true);
  } finally { f.store.close(); }
});

test('project.set-planner marks an already-registered thread under its own name and issues no second ticket', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const caller = formatAgentId(host, 'lead-a');
  f.live('lead-a');
  try {
    const registered = await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a', purpose: 'Cross-section', caller });
    const agentTicket = ticketAt(f, agentTicketKey('example', 'lead-a'));
    assert.equal((registered as { participantTicket?: string }).participantTicket,
      f.store.getMeta<{ path: string }>(agentTicketKey('example', 'lead-a'))?.path);
    const project = await f.repositories.setProjectPlanner({ key: 'example', agentId: caller, setBy: caller });
    assert.equal(project.planner?.name, 'lead-a');
    assert.deepEqual(project.agents?.map(agent => agent.name), ['lead-a']);
    assert.equal((project as { participantTicket?: string }).participantTicket,
      f.store.getMeta<{ path: string }>(plannerTicketKey('example'))?.path, 'the assignment hands the planner ticket back');
    assert.equal(f.sends.length, 0, 'neither the registration nor the assignment messaged the thread');
    assert.equal(f.store.getMeta<{ participantId: string }>(agentTicketKey('example', 'lead-a'))?.participantId,
      agentTicket.participantId, 'the registration ticket is untouched');
    assert.equal((await f.engine.projectAgents('example'))[0]?.fallback, true);
  } finally { f.store.close(); }
});

test('rotating the planner reassigns the default name: the old thread stays dead and the new one takes the name', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const first = formatAgentId(host, 'lead-a'), second = formatAgentId(host, 'lead-b');
  f.live('lead-a'); f.live('lead-b');
  try {
    // Board assignments on a host without environment identity: one message each.
    await f.repositories.setProjectPlanner({ key: 'example', agentId: first, setBy: 'operator' });
    const oldRecord = f.store.getMeta<{ path: string }>(plannerTicketKey('example'))!;
    const old = ticketAt(f, plannerTicketKey('example'));
    assert.deepEqual(f.sends.map(send => send.id), ['lead-a']);
    await f.repositories.setProjectPlanner({ key: 'example', agentId: second, setBy: 'operator' });
    assert.equal(f.project().planner?.agentId, second);
    assert.deepEqual(f.project().agents?.map(agent => ({ name: agent.name, agentId: agent.agentId })),
      [{ name: 'planner', agentId: second }], 'the name survives the rotation; the old thread is not revived');
    const currentRecord = f.store.getMeta<{ path: string }>(plannerTicketKey('example'))!;
    assert.notEqual(currentRecord.path, oldRecord.path);
    assert.deepEqual(f.sends.map(send => send.id), ['lead-a', 'lead-b']);
    assert.throws(() => resolveTicketCaller(f.store, { participantId: old.participantId }, old.token), /revoked or invalid/);
    const current = ticketAt(f, plannerTicketKey('example'));
    assert.equal(resolveTicketCaller(f.store, { participantId: current.participantId }, current.token).caller, second);
    assert.equal((await f.engine.projectAgents('example'))[0]?.fallback, true);
  } finally { f.store.close(); }
});

test('clearing the fallback planner does not unregister the thread or revoke its registration ticket', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const caller = formatAgentId(host, 'lead-a');
  f.live('lead-a');
  try {
    await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a', purpose: 'Cross-section', caller });
    const agentTicket = ticketAt(f, agentTicketKey('example', 'lead-a'));
    await f.repositories.setProjectPlanner({ key: 'example', agentId: caller, setBy: caller });
    const project = await f.repositories.setProjectPlanner({ key: 'example', agentId: null, setBy: 'operator' });
    assert.equal(project.planner, null);
    assert.deepEqual(project.agents?.map(agent => agent.name), ['lead-a']);
    assert.equal(resolveTicketCaller(f.store, { participantId: agentTicket.participantId }, agentTicket.token).caller, caller);
    await assert.rejects(() => f.engine.resolution.resolveProjectAgentTarget('example', null),
      /no fallback planner/);
  } finally { f.store.close(); }
});

test('a planner set outside the RPC is registered on the next startup reconciliation and takes its ticket from its own call', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const caller = formatAgentId(host, 'lead-a');
  try {
    f.store.setProjectPlanner({ key: 'example', agentId: caller, setBy: 'operator' });
    assert.equal(f.project().agents, undefined, 'nothing registers synchronously in the store');
    f.live('lead-a');
    await f.tickets.ensure();
    assert.deepEqual(f.project().agents?.map(agent => ({ name: agent.name, agentId: agent.agentId })),
      [{ name: 'planner', agentId: caller }]);
    assert.deepEqual(f.sends, [], 'startup records the pending ticket and sends nothing');
    const handed = await f.tickets.forCaller(caller);
    assert.equal(handed, f.store.getMeta<{ path: string }>(plannerTicketKey('example'))?.path);
  } finally { f.store.close(); }
});

test('a fallback registered while another thread holds the default name takes a free name and the RPC answer matches the store', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const holder = formatAgentId(host, 'lead-x'), planner = formatAgentId(host, 'lead-z');
  f.live('lead-x'); f.live('lead-z');
  try {
    await f.repositories.registerProjectAgent({ project: 'example', name: 'planner', purpose: 'Owns the UI cross-section', agentId: holder });
    const holderTicket = f.store.getMeta<{ participantId: string }>(agentTicketKey('example', 'planner'))!;
    const project = await f.repositories.setProjectPlanner({ key: 'example', agentId: planner, setBy: 'operator' });
    assert.deepEqual(project, f.project(), 'the RPC answer is the state the store holds');
    assert.deepEqual(project.agents?.map(agent => ({ name: agent.name, agentId: agent.agentId })),
      [{ name: 'planner', agentId: holder }, { name: 'planner-2', agentId: planner }],
      'another thread address is never dropped for the fallback');
    assert.equal(project.planner?.name, 'planner-2');
    assert.equal(f.store.getMeta<{ participantId: string }>(agentTicketKey('example', 'planner'))?.participantId,
      holderTicket.participantId, 'the holder keeps its address and its ticket');
    const listed = await f.engine.projectAgents('example');
    assert.equal(listed.find(agent => agent.agentId === planner)?.fallback, true);
    assert.equal(listed.find(agent => agent.agentId === holder)?.fallback, false);
  } finally { f.store.close(); }
});
