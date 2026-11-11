import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { RuntimeRepositories, type RepositoriesContext } from '../core/runtime/repositories';
import { ProjectLifecycle } from '../core/planning/project-lifecycle';
import { ParticipantTickets, plannerTicketKey, resolveTicketCaller } from '../core/dispatch/participant-tickets';
import { formatAgentId, sameCallerIdentity } from '../shared/agent-identity';
import { runSchema, submissionSchema } from '../shared/contracts';

const host = 't3code:synthetic';
function fixture() {
  const store = new Store(':memory:');
  store.upsertProject({ key: 'example', name: 'Example', repositories: [{ origin: 'synthetic/example', path: '/synthetic/example' }] });
  const registrations: string[] = [], deliveries: string[] = [];
  const engine = new Engine(store, { hostId: host, notify: async (id: string) => { deliveries.push(id); },
    originAgent: async (id: string) => ({ id, workspaceId: 'ws', title: 'Planner', archived: false }),
    observe: async (id: string) => ({ id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }),
  } as unknown as Adapter, 0);
  engine.hostAvailable = () => true;
  engine.identifyOriginHost = async () => { throw Error('Native thread identity is ambiguous across hosts'); };
  engine.resolution.projectPlannerRegistered = async (_key, agentId) => { registrations.push(agentId); };
  const dir = mkdtempSync(join(tmpdir(), 'planner-self-'));
  const tickets = new ParticipantTickets(engine, { socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'helper.mjs') });
  const repositories = new RuntimeRepositories({ store, engine, markStoreAccess() {}, plannerChanged: (key: string) => tickets.assigned(key) } as unknown as RepositoriesContext);
  return { store, engine, registrations, deliveries, repositories };
}

test('a self-assigned planner retains its ticket-proven host when naming its native ID', async () => {
  const f = fixture();
  try {
    const setter = formatAgentId(host, 'planner');
    const result = await f.repositories.setProjectPlanner({ key: 'example', agentId: 'planner', setBy: setter });
    assert.equal(result.planner?.agentId, setter);
    assert.equal(sameCallerIdentity(result.planner?.agentId, setter), true);
    assert.deepEqual(f.registrations, [setter]);
    // Self-assignment hands the ticket back in its own response; nothing is messaged.
    assert.deepEqual(f.deliveries, []);
    const record = f.store.getMeta<{ path: string }>(plannerTicketKey('example'))!;
    assert.equal((result as { participantTicket?: string }).participantTicket, record.path);
    const ticket = JSON.parse(readFileSync(record.path, 'utf8'));
    assert.equal(resolveTicketCaller(f.store, { participantId: ticket.participantId }, ticket.token).caller, setter);
  } finally { f.store.close(); }
});

test('self-assignment preserves board and explicit other-target paths', async () => {
  const f = fixture();
  try {
    for (const input of [
      { agentId: 'planner', setBy: 'operator' },
      { agentId: 'different-planner', setBy: formatAgentId(host, 'planner') },
      { agentId: formatAgentId('paseo-synthetic', 'planner'), setBy: formatAgentId(host, 'planner') },
      { agentId: null, setBy: formatAgentId(host, 'planner') },
    ]) {
      const result = await f.repositories.setProjectPlanner({ key: 'example', ...input });
      assert.equal(result.planner?.agentId ?? null, input.agentId);
    }
  } finally { f.store.close(); }
});

test('project settings match qualified live planners only on the inventory host', async () => {
  const f = fixture();
  try {
    const planner = formatAgentId(host, 'planner');
    f.store.setProjectPlanner({ key: 'example', agentId: planner, setBy: planner });
    for (const [hostId, expected] of [[host, true], ['paseo-synthetic', null], ['t3code:other', null]] as const) {
      const adapter = { hostId, listLiveAgents: async () => [{ id: 'planner', title: 'Planner', workspaceId: null }] } as unknown as Adapter;
      const lifecycle = new ProjectLifecycle({ store: f.store, adapter, host: { listLiveAgents: adapter.listLiveAgents! } } as never);
      assert.equal((await lifecycle.projectSettings()).projects[0]?.plannerLive, expected, hostId);
    }
    const absent = { hostId: host, listLiveAgents: async () => [] } as unknown as Adapter;
    const absentLifecycle = new ProjectLifecycle({ store: f.store, adapter: absent, host: { listLiveAgents: absent.listLiveAgents! } } as never);
    assert.equal((await absentLifecycle.projectSettings()).projects[0]?.plannerLive, false);
    f.store.setProjectPlanner({ key: 'example', agentId: 'planner', setBy: 'operator' });
    const adapter = { hostId: 'paseo-synthetic', listLiveAgents: async () => [{ id: 'planner', title: 'Planner', workspaceId: null }] } as unknown as Adapter;
    const lifecycle = new ProjectLifecycle({ store: f.store, adapter, host: { listLiveAgents: adapter.listLiveAgents! } } as never);
    assert.equal((await lifecycle.projectSettings()).projects[0]?.plannerLive, true, 'legacy Paseo planner remains live');
  } finally { f.store.close(); }
});

test('an unbound retained run never borrows the task worker identity', () => {
  const f = fixture();
  try {
    const task = f.store.insert(submissionSchema.parse({ submissionId: 'unbound-caller', title: 'Synthetic task', repoPath: '/synthetic/example', planningCommit: 'a'.repeat(40), handoffPath: 'synthetic.md', originAgentId: 'planner' }), host, 'handoff', 'a'.repeat(40), { runId: 'worker', agentId: 'worker-thread' });
    f.store.putRun(runSchema.parse({ id: 'unbound-reviewer', taskId: task.id, role: 'reviewer', generation: 0,
      head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: null, workspaceId: 'synthetic-workspace', profile: null,
      status: 'intent', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null,
      completion: null, released: false }));
    f.store.setCredential('unbound-reviewer', 'synthetic-token');
    assert.throws(() => resolveTicketCaller(f.store, { taskId: task.id, runId: 'unbound-reviewer' }, 'synthetic-token'), /No calling thread/);
  } finally { f.store.close(); }
});
