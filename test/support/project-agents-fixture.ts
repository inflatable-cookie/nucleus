import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../core/store/store';
import { Engine } from '../../core/engine';
import type { Adapter, AgentObservation } from '../../core/host';
import { RuntimeRepositories, type RepositoriesContext } from '../../core/runtime/repositories';
import { ParticipantTickets } from '../../core/dispatch/participant-tickets';

/**
 * One project, one synthetic host and the registry's real write and ticket
 * paths. The adapter answers `originAgent`/`observe` from `observed` so a test
 * sets a thread's archived flag, status and activity stamp without a daemon.
 */
export function projectAgentsFixture(options: { hostId?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nucleus-project-agents-'));
  const store = new Store(':memory:');
  const hostId = options.hostId ?? 'paseo-synthetic';
  const sends: Array<{ id: string; text: string }> = [];
  const observed = new Map<string, { archived: boolean; status: string; active: boolean; updatedAt: string }>();
  const observeFailures = new Set<string>();
  const originFailures = new Set<string>();
  let sendFailure = false, available = true;
  const adapter = {
    hostId,
    notify: async (id: string, _messageId: string, text: string) => {
      if (sendFailure) throw new Error('send outcome unknown');
      sends.push({ id, text });
    },
    originAgent: async (id: string) => {
      if (originFailures.has(id)) throw new Error('Agent catalog read failed');
      const state = observed.get(id);
      if (!state) return null;
      return { id, workspaceId: 'synthetic-workspace', title: id, archived: state.archived };
    },
    observe: async (id: string): Promise<AgentObservation> => {
      if (observeFailures.has(id)) throw new Error('Agent observation timed out');
      const state = observed.get(id);
      if (!state) throw new Error('Agent was not found');
      return { id, workspaceId: 'synthetic-workspace', status: state.status, active: state.active, permissions: false,
        error: '', updatedAt: state.updatedAt };
    },
    listLiveAgents: async () => [...observed].filter(([, state]) => !state.archived)
      .map(([id]) => ({ id, title: id, workspaceId: 'synthetic-workspace' })),
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.identifyOriginHost = async () => hostId;
  engine.hostAvailable = () => available;
  const tickets = new ParticipantTickets(engine, { socketPath: join(directory, 'callback.sock'), helperPath: join(directory, 'helper.mjs') });
  const repositories = new RuntimeRepositories({ store, engine, markStoreAccess() {}, plannerChanged: () => tickets.ensure() } as unknown as RepositoriesContext);
  store.upsertProject({ key: 'example', name: 'Example', repositories: [{ origin: 'synthetic/example', path: '/synthetic/example' }] });
  return {
    directory, store, engine, adapter, sends, observed, tickets, repositories, hostId,
    project: () => store.projectByKey('example')!,
    /** A live thread: idle with an activity stamp unless the test says otherwise. */
    live(nativeId: string, extra: Partial<{ archived: boolean; status: string; active: boolean; updatedAt: string }> = {}) {
      observed.set(nativeId, { archived: false, status: 'idle', active: false, updatedAt: '2026-11-11T10:00:00.000Z', ...extra });
    },
    observeFails(nativeId: string) { observeFailures.add(nativeId); },
    originFails(nativeId: string) { originFailures.add(nativeId); },
    failSend() { sendFailure = true; },
    allowSend() { sendFailure = false; },
    offline() { available = false; },
    online() { available = true; },
  };
}
