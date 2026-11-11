import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatAgentId } from '../shared/agent-identity';
import { projectAgents } from '../shared/contracts';
import { agentTicketKey, resolveTicketCaller } from '../core/dispatch/participant-tickets';
import { ProjectAgentTargetRefusal } from '../core/planning/project-agents';
import { projectAgentsFixture } from './support/project-agents-fixture';

const ticketOf = (f: ReturnType<typeof projectAgentsFixture>, name: string) => {
  const record = f.store.getMeta<{ path: string }>(agentTicketKey('example', name))!;
  return JSON.parse(readFileSync(record.path, 'utf8')) as { participantId: string; token: string };
};

test('a ticket-only host registers the calling thread by name and lists it with live state', async () => {
  const f = projectAgentsFixture({ hostId: 't3code:synthetic' });
  const caller = formatAgentId('t3code:synthetic', 'lead-parser');
  f.live('lead-parser', { updatedAt: '2026-11-11T09:30:00.000Z' });
  try {
    const registered = await f.repositories.registerProjectAgent({
      project: 'example', name: 'lead-parser', purpose: 'Owns the parser cross-section', caller,
    });
    const entry = registered.agents?.find(agent => agent.name === 'lead-parser');
    assert.deepEqual(entry, {
      name: 'lead-parser', purpose: 'Owns the parser cross-section', agentId: caller,
      hostId: 't3code:synthetic', registeredBy: caller, registeredAt: entry!.registeredAt,
    });
    assert.deepEqual(f.sends.map(send => send.id), ['lead-parser'], 'one participant ticket, delivered through the host');
    const ticket = ticketOf(f, 'lead-parser');
    assert.equal(resolveTicketCaller(f.store, { participantId: ticket.participantId }, ticket.token).caller, caller);

    const listed = projectAgents.output.parse(await f.engine.projectAgents('example'));
    assert.deepEqual(listed, [{
      name: 'lead-parser', purpose: 'Owns the parser cross-section', agentId: caller, hostId: 't3code:synthetic',
      state: 'idle', lastSeen: '2026-11-11T09:30:00.000Z', fallback: false,
    }]);
    f.live('lead-parser', { active: true });
    assert.equal((await f.engine.projectAgents('example'))[0]?.state, 'running');
  } finally { f.store.close(); }
});

test('a Paseo host registers a bare thread id and the same list read answers it', async () => {
  const f = projectAgentsFixture({ hostId: 'paseo-synthetic' });
  f.live('lead-a');
  try {
    const registered = await f.repositories.registerProjectAgent({
      project: 'example', name: 'lead-a', purpose: 'Coordinates the UI cross-section', agentId: 'lead-a',
    });
    assert.deepEqual(registered.agents?.map(agent => ({ name: agent.name, agentId: agent.agentId, hostId: agent.hostId })),
      [{ name: 'lead-a', agentId: 'lead-a', hostId: 'paseo-synthetic' }]);
    assert.deepEqual(f.sends.map(send => send.id), ['lead-a']);
    const ticket = ticketOf(f, 'lead-a');
    assert.equal(resolveTicketCaller(f.store, { participantId: ticket.participantId }, ticket.token).caller,
      formatAgentId('paseo-synthetic', 'lead-a'));
    assert.equal((await f.engine.projectAgents('example'))[0]?.state, 'idle');
  } finally { f.store.close(); }
});

test('a name stays unique: renaming a thread and reassigning a name each revoke the old ticket', async () => {
  const f = projectAgentsFixture({ hostId: 't3code:synthetic' });
  const a = formatAgentId('t3code:synthetic', 'lead-a'), b = formatAgentId('t3code:synthetic', 'lead-b');
  f.live('lead-a'); f.live('lead-b');
  try {
    await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a', purpose: 'First cross-section', caller: a });
    const first = ticketOf(f, 'lead-a');
    // Same thread, new name: one entry for the thread, and the old name's ticket is gone.
    await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-renamed', purpose: 'First cross-section', caller: a });
    assert.deepEqual(f.project().agents?.map(agent => agent.name), ['lead-renamed']);
    assert.equal(f.store.getMeta(agentTicketKey('example', 'lead-a')), undefined);
    assert.throws(() => resolveTicketCaller(f.store, { participantId: first.participantId }, first.token), /revoked or invalid/);
    // The name moves to another thread: the name keeps working, the old thread's ticket does not.
    const renamedTicket = ticketOf(f, 'lead-renamed');
    await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-renamed', purpose: 'Second cross-section', caller: b });
    assert.deepEqual(f.project().agents?.map(agent => ({ name: agent.name, agentId: agent.agentId })),
      [{ name: 'lead-renamed', agentId: b }]);
    assert.throws(() => resolveTicketCaller(f.store, { participantId: renamedTicket.participantId }, renamedTicket.token), /revoked or invalid/);
    assert.equal(resolveTicketCaller(f.store, { participantId: ticketOf(f, 'lead-renamed').participantId }, ticketOf(f, 'lead-renamed').token).caller, b);
  } finally { f.store.close(); }
});

test('re-registering the same thread and name updates the purpose without a second ticket', async () => {
  const f = projectAgentsFixture({ hostId: 't3code:synthetic' });
  const caller = formatAgentId('t3code:synthetic', 'lead-a');
  f.live('lead-a');
  try {
    await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a', purpose: 'First purpose', caller });
    const first = ticketOf(f, 'lead-a');
    const again = await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a', purpose: 'Sharper purpose', caller });
    assert.equal(again.agents?.[0]?.purpose, 'Sharper purpose');
    assert.equal(f.sends.length, 1, 'no second delivery');
    assert.equal(resolveTicketCaller(f.store, { participantId: first.participantId }, first.token).caller, caller);
  } finally { f.store.close(); }
});

test('unregister removes the entry and revokes the ticket, and refuses to remove the fallback planner', async () => {
  const f = projectAgentsFixture({ hostId: 't3code:synthetic' });
  const caller = formatAgentId('t3code:synthetic', 'lead-a');
  f.live('lead-a');
  try {
    await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a', purpose: 'Cross-section', caller });
    await f.repositories.setProjectPlanner({ key: 'example', agentId: caller, setBy: 'operator' });
    await assert.rejects(() => f.repositories.unregisterProjectAgent({ project: 'example', name: 'lead-a' }),
      /fallback planner.*project.set-planner/);
    await f.repositories.setProjectPlanner({ key: 'example', agentId: null, setBy: 'operator' });
    const ticket = ticketOf(f, 'lead-a');
    await f.repositories.unregisterProjectAgent({ project: 'example', name: 'lead-a' });
    assert.deepEqual(f.project().agents, []);
    assert.throws(() => resolveTicketCaller(f.store, { participantId: ticket.participantId }, ticket.token), /revoked or invalid/);
  } finally { f.store.close(); }
});

test('a name resolves at send time; archived, gone and unknown fail with their state and nothing is sent', async () => {
  const f = projectAgentsFixture({ hostId: 't3code:synthetic' });
  const caller = formatAgentId('t3code:synthetic', 'lead-a');
  f.live('lead-a');
  try {
    await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a', purpose: 'Cross-section', caller });
    assert.deepEqual(await f.engine.resolution.resolveProjectAgentTarget('example', 'lead-a'),
      { agentId: caller, hostId: 't3code:synthetic', name: 'lead-a' });
    const sends = f.sends.length;
    const refuses = async (expected: string, action: () => Promise<unknown>) => {
      const error = await action().then(() => null, (failure: unknown) => failure);
      assert.ok(error instanceof ProjectAgentTargetRefusal, `${expected}: typed refusal`);
      assert.equal((error as ProjectAgentTargetRefusal).state, expected);
      assert.match((error as Error).message, /project\.agents/);
      assert.equal(f.sends.length, sends, `${expected}: nothing was sent`);
    };
    await refuses('unregistered', () => f.engine.resolution.resolveProjectAgentTarget('example', 'nobody'));
    f.live('lead-a', { archived: true });
    await refuses('archived', () => f.engine.resolution.resolveProjectAgentTarget('example', 'lead-a'));
    f.observed.delete('lead-a');
    await refuses('gone', () => f.engine.resolution.resolveProjectAgentTarget('example', 'lead-a'));
    f.live('lead-a');
    f.observeFails('lead-a');
    await refuses('unknown', () => f.engine.resolution.resolveProjectAgentTarget('example', 'lead-a'));
    f.originFails('lead-a');
    await refuses('unknown', () => f.engine.resolution.resolveProjectAgentTarget('example', 'lead-a'));
  } finally { f.store.close(); }
});

test('the project fallback resolves to the registered planner, and no fallback refuses plainly', async () => {
  const f = projectAgentsFixture({ hostId: 't3code:synthetic' });
  const caller = formatAgentId('t3code:synthetic', 'lead-a');
  f.live('lead-a');
  try {
    await assert.rejects(() => f.engine.resolution.resolveProjectAgentTarget('example', null),
      (error: unknown) => error instanceof ProjectAgentTargetRefusal && error.state === 'no-fallback');
    await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a', purpose: 'Cross-section', caller });
    await f.repositories.setProjectPlanner({ key: 'example', agentId: caller, setBy: 'operator' });
    assert.deepEqual(await f.engine.resolution.resolveProjectAgentTarget('example', null),
      { agentId: caller, hostId: 't3code:synthetic', name: 'lead-a' });
    assert.equal((await f.engine.projectAgents('example'))[0]?.fallback, true);
  } finally { f.store.close(); }
});

test('the list reports running, idle, archived, gone and unknown without turning an unreadable thread into gone', async () => {
  const f = projectAgentsFixture({ hostId: 't3code:synthetic' });
  const ids = ['lead-run', 'lead-idle', 'lead-archived', 'lead-gone', 'lead-unknown'];
  try {
    for (const id of ids) f.live(id);
    for (const id of ids) await f.repositories.registerProjectAgent({
      project: 'example', name: id, purpose: `Purpose for ${id}`, caller: formatAgentId('t3code:synthetic', id),
    });
    f.live('lead-run', { active: true });
    f.live('lead-archived', { archived: true });
    f.observed.delete('lead-gone');
    f.observeFails('lead-unknown');
    const listed = await f.engine.projectAgents('example');
    assert.deepEqual(Object.fromEntries(listed.map(agent => [agent.name, agent.state])), {
      'lead-run': 'running', 'lead-idle': 'idle', 'lead-archived': 'archived', 'lead-gone': 'gone', 'lead-unknown': 'unknown',
    });
    assert.equal(listed.find(agent => agent.name === 'lead-archived')?.lastSeen, null, 'an archived thread has no read stamp');
  } finally { f.store.close(); }
});

test('a registration cannot take the fallback planner address; nothing is dropped and no stranger is ticketed', async () => {
  const f = projectAgentsFixture({ hostId: 't3code:synthetic' });
  const fallback = formatAgentId('t3code:synthetic', 'lead-y'), stranger = formatAgentId('t3code:synthetic', 'lead-x');
  f.live('lead-y'); f.live('lead-x');
  try {
    await f.repositories.setProjectPlanner({ key: 'example', agentId: fallback, setBy: 'operator' });
    assert.equal(f.project().planner?.name, 'planner');
    const before = ticketOf(f, 'planner');
    const sends = f.sends.length;
    await assert.rejects(() => f.repositories.registerProjectAgent({
      project: 'example', name: 'planner', purpose: 'A stranger claiming the address', caller: stranger,
    }), /fallback planner address.*project\.set-planner/);
    assert.deepEqual(f.project().agents?.map(agent => ({ name: agent.name, agentId: agent.agentId })),
      [{ name: 'planner', agentId: fallback }], 'the fallback keeps its entry and the stranger is not registered');
    assert.equal(f.sends.length, sends, 'the refused registration issues no ticket');
    assert.equal(resolveTicketCaller(f.store, { participantId: before.participantId }, before.token).caller, fallback,
      'the fallback keeps the ticket it already held');
    assert.equal((await f.engine.projectAgents('example'))[0]?.fallback, true);
    assert.deepEqual(await f.engine.resolution.resolveProjectAgentTarget('example', 'planner'),
      { agentId: fallback, hostId: 't3code:synthetic', name: 'planner' });
  } finally { f.store.close(); }
});
