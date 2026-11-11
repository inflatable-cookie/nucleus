import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgentId } from '../shared/agent-identity';
import { agentTicketKey } from '../core/dispatch/participant-tickets';
import { projectAgentsFixture } from './support/project-agents-fixture';

const host = 't3code:synthetic';

test('the CLI path registers the calling thread from its qualified ticket identity', async () => {
  const f = projectAgentsFixture({ hostId: host });
  f.live('lead-a');
  try {
    await assert.rejects(() => f.repositories.registerProjectAgent({
      project: 'example', name: 'lead-a', purpose: 'Cross-section', caller: 'typed-name',
    }), /qualified Nucleus identity/);
    assert.deepEqual(f.project().agents ?? [], []);
    await f.repositories.registerProjectAgent({
      project: 'example', name: 'lead-a', purpose: 'Cross-section', caller: formatAgentId(host, 'lead-a'),
    });
    assert.equal(f.project().agents?.length, 1);
  } finally { f.store.close(); }
});

test('the board path needs a host it can actually observe the chosen thread on', async () => {
  const f = projectAgentsFixture({ hostId: '' });
  try {
    await assert.rejects(() => f.repositories.registerProjectAgent({
      project: 'example', name: 'lead-a', purpose: 'Cross-section', agentId: 'lead-a',
    }), /no host is connected/);
    assert.deepEqual(f.project().agents ?? [], []);
  } finally { f.store.close(); }
});

test('a ticket is issued once and never replayed after an unknown delivery', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const caller = formatAgentId(host, 'lead-a');
  f.live('lead-a');
  try {
    f.failSend();
    await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a', purpose: 'Cross-section', caller });
    assert.equal(f.store.getMeta<{ delivery: string }>(agentTicketKey('example', 'lead-a'))?.delivery, 'unknown');
    f.allowSend();
    await f.tickets.ensure();
    await f.tickets.ensure();
    assert.deepEqual(f.sends, [], 'an unknown delivery is recorded, never re-sent');
  } finally { f.store.close(); }
});

test('a registration made while its host is offline issues the ticket when the host connects', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const caller = formatAgentId(host, 'lead-a');
  f.live('lead-a');
  try {
    f.offline();
    await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a', purpose: 'Cross-section', caller });
    assert.equal(f.store.getMeta(agentTicketKey('example', 'lead-a')), undefined, 'nothing is sent or recorded while the host is away');
    f.online();
    await f.tickets.ensure();
    assert.deepEqual(f.sends.map(send => send.id), ['lead-a']);
    await f.tickets.ensure();
    assert.equal(f.sends.length, 1);
  } finally { f.store.close(); }
});

test('a registration on one host is listed as unknown when another host is connected', async () => {
  const f = projectAgentsFixture({ hostId: host });
  const caller = formatAgentId(host, 'lead-a');
  f.live('lead-a');
  try {
    await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a', purpose: 'Cross-section', caller });
    const { ProjectLifecycle } = await import('../core/planning/project-lifecycle');
    const lifecycle = new ProjectLifecycle({
      store: f.store, adapter: f.adapter, host: f.engine.host, activeHostId: 't3code:another',
    } as never);
    assert.equal((await lifecycle.projectAgents('example'))[0]?.state, 'unknown', 'an unobservable host is unknown, never gone');
  } finally { f.store.close(); }
});
