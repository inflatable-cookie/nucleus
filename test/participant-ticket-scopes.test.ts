import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatAgentId } from '../shared/agent-identity';
import { submissionSchema } from '../shared/contracts';
import {
  participantProjectScope, plannerTicketKey, resolveTicketCaller, taskPlannerTicketKey,
} from '../core/dispatch/participant-tickets';
import { projectAgentsFixture } from './support/project-agents-fixture';

/**
 * A participant id resolves back to what its ticket speaks for through the rows
 * its issuance wrote, and nothing else: the project, the project and one name,
 * or no project at all for a task planner.
 */
const host = 't3code:synthetic';

const ticketOf = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { participantId: string; token: string };

test('each ticket scope reads back as the identity it speaks for', async () => {
  const f = projectAgentsFixture({ hostId: host });
  f.live('lead-a');
  try {
    f.store.setProjectPlanner({ key: 'example', agentId: formatAgentId(host, 'planner'), setBy: 'operator' });
    const plannerPath = await f.tickets.forCaller(formatAgentId(host, 'planner'));
    assert.ok(plannerPath, 'the planner takes its ticket in its own call');
    const planner = ticketOf(plannerPath!);
    assert.deepEqual(participantProjectScope(f.store, planner.participantId), { projectKey: 'example', name: null });
    assert.deepEqual(resolveTicketCaller(f.store, { participantId: planner.participantId }, planner.token),
      { caller: formatAgentId(host, 'planner'), hostId: host, source: 'participant-ticket' });

    const registered = await f.repositories.registerProjectAgent({ project: 'example', name: 'lead-a',
      purpose: 'Cross-section', caller: formatAgentId(host, 'lead-a') });
    const agentPath = (registered as { participantTicket?: string }).participantTicket;
    assert.ok(agentPath, 'the registering thread takes its ticket in the response');
    const agent = ticketOf(agentPath!);
    assert.deepEqual(participantProjectScope(f.store, agent.participantId), { projectKey: 'example', name: 'lead-a' });
    assert.deepEqual(resolveTicketCaller(f.store, { participantId: agent.participantId }, agent.token),
      { caller: formatAgentId(host, 'lead-a'), hostId: host, source: 'participant-ticket' });
    assert.notEqual(agent.participantId, planner.participantId, 'two scopes never share one participant id');
  } finally { f.store.close(); }
});

test('a task-planner ticket speaks for no project and stops resolving when no live task names its thread', async () => {
  const f = projectAgentsFixture({ hostId: host });
  f.live('task-planner');
  try {
    const task = f.store.insert(submissionSchema.parse({ submissionId: 'ticket-scope-task', title: 'Scoped task',
      repoPath: '/synthetic/example', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: formatAgentId(host, 'task-planner') }),
    host, 'handoff', 'a'.repeat(40));
    await f.tickets.ensureFor(formatAgentId(host, 'task-planner'), host);
    const record = f.store.getMeta<{ path: string }>(taskPlannerTicketKey(host, 'task-planner'));
    assert.ok(record, 'the thread that plans a live task receives its ticket');
    const planner = ticketOf(record!.path);
    assert.equal(participantProjectScope(f.store, planner.participantId), null, 'a task planner carries no project scope');
    assert.equal(resolveTicketCaller(f.store, { participantId: planner.participantId }, planner.token).caller,
      formatAgentId(host, 'task-planner'));
    // Reparenting moves the scope: the old thread no longer plans a live task.
    f.store.update(task.id, { notificationAgentId: formatAgentId(host, 'successor') });
    assert.throws(() => resolveTicketCaller(f.store, { participantId: planner.participantId }, planner.token), /revoked or invalid/);
  } finally { f.store.close(); }
});

test('a record that is not a ticket never authenticates and is never minted over', async () => {
  const f = projectAgentsFixture({ hostId: host });
  try {
    f.store.setProjectPlanner({ key: 'example', agentId: formatAgentId(host, 'planner'), setBy: 'operator' });
    assert.ok(await f.tickets.forCaller(formatAgentId(host, 'planner')));
    const key = plannerTicketKey('example');
    const before = f.store.getMeta<{ path: string }>(key)!;
    const planner = ticketOf(before.path);
    f.store.setMeta(key, 'not a ticket');
    assert.throws(() => resolveTicketCaller(f.store, { participantId: planner.participantId }, planner.token), /revoked or invalid/);
    assert.equal(await f.tickets.forCaller(formatAgentId(host, 'planner')), undefined,
      'a key something else holds is never reissued over');
    assert.equal(f.store.getMeta(key), 'not a ticket');
    assert.deepEqual(f.sends, []);
  } finally { f.store.close(); }
});
