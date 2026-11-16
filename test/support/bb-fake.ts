import { readFileSync } from 'node:fs';
import { createHostOperations, type BbHostSdk, type ThreadRow } from '../../hosts/bb/plugin/operations';
const recorded = JSON.parse(readFileSync(new URL('../fixtures/bb-0.49-wire.json', import.meta.url), 'utf8'));
export const BB_STAMP = 1794849609702;

/** Captured on isolated BB 0.49 / SDK 0.6.132 by proof:bb. Only values vary. */
export function bbWire(kind: 'get' | 'list' | 'interaction', overrides: Record<string, unknown> = {}): any {
  const row = structuredClone(recorded[kind]);
  for (const key of Object.keys(overrides)) if (!Object.hasOwn(row, key)) throw new Error(`Invented BB ${kind} field: ${key}`);
  return { ...row, ...overrides };
}
export function assertBbWire(kind: 'get' | 'list' | 'interaction', row: object) {
  const expected = Object.keys(recorded[kind]).sort();
  if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expected)) throw new Error(`Partial or invented BB ${kind} row`);
}
export function bbFake() {
  const rows = new Map<string, any>(), metadata = new Map<string, Record<string, unknown> | null>();
  const interactions = new Map<string, any[]>(), cascades = new Map<string, string[]>();
  const projects: any[] = [], environments: any[] = [];
  const calls: Array<{ method: string; args: any }> = [];
  const controls = { loseSpawn: false, delaySpawn: false, failList: false, omitId: '', partialMetadata: false, loseTitle: false, titleLands: true, failChunk: 0 };
  let delayed: (() => void) | null = null;
  const note = (method: string, args?: unknown) => { calls.push({ method, args }); };
  const sdk: BbHostSdk = {
    system: { version: async () => ({ currentVersion: '0.49.0' }) }, status: { get: async () => ({}) },
    hosts: { list: async () => [{ id: 'host_synthetic', status: 'connected' }] },
    projects: {
      list: async () => projects,
      create: async args => { const p = { id: `proj_${projects.length}`, sources: [{ type: 'local_path', path: args.source.path }] }; projects.push(p); return p; },
    },
    threads: {
      async spawn(args) {
        note('threads.spawn', args);
        const id = `thr_${rows.size + 1}`;
        const existing = environments.find(e => e.path === args.environment.workspace.path);
        const environment = existing ?? { id: `env_${environments.length}`, path: args.environment.workspace.path, isWorktree: true, managed: false, status: 'ready' };
        if (!existing) environments.push(environment);
        const row = bbWire('list', { id, projectId: args.projectId, environmentId: environment.id, environmentPath: environment.path,
          title: args.title, parentThreadId: args.parentThreadId ?? null, parentNotifications: args.parentNotifications, status: 'idle', runtime: { displayStatus: 'idle' }, hasPendingInteraction: false, archivedAt: null });
        const land = () => { rows.set(id, row); metadata.set(id, args.pluginMetadata ?? null); };
        if (controls.delaySpawn) delayed = land; else land();
        if (controls.loseSpawn) throw new Error('unknown delivery after threads.spawn');
        const get = bbWire('get'); for (const key of Object.keys(get)) if (Object.hasOwn(row, key)) get[key] = row[key];
        assertBbWire('get', get); return get;
      },
      async get(args) {
        note('threads.get', args); const row = rows.get(args.threadId); if (!row) throw new Error('Thread not found');
        const get = bbWire('get'); for (const key of Object.keys(get)) if (Object.hasOwn(row, key)) get[key] = row[key];
        assertBbWire('get', get); return get;
      },
      async list(args) {
        note('threads.list', args);
        if (controls.failList || (args.threadIds && controls.failChunk && calls.filter(c => c.method === 'threads.list' && c.args.threadIds).length === controls.failChunk)) throw new Error('recorded list failure');
        const filtered = [...rows.values()].filter(r =>
          (!args.threadIds || args.threadIds.includes(r.id)) && (!args.originPluginId || args.originPluginId === r.originPluginId) &&
          (!args.projectId || args.projectId === r.projectId) && (args.includeHidden || r.visibility !== 'hidden') &&
          (args.threadIds ? true : Boolean(r.archivedAt) === Boolean(args.archived)) && r.id !== controls.omitId);
        return filtered.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 200)).map(row => { assertBbWire('list', row); return structuredClone(row); });
      },
      async send(args) { note('threads.send', args); return structuredClone(recorded.send); },
      async update(args) {
        note('threads.update', args);
        if (controls.titleLands) rows.get(args.threadId).title = args.title;
        if (controls.loseTitle) throw new Error('unknown title delivery');
        return {};
      },
      async stop(args) { note('threads.stop', args); rows.get(args.threadId).status = 'idle'; rows.get(args.threadId).runtime.displayStatus = 'idle'; return { ok: true }; },
      async archive(args) { note('threads.archive', args); rows.get(args.threadId).archivedAt = BB_STAMP; return { ok: true }; },
      interactions: { async list(args) { note('threads.interactions.list', args); return (interactions.get(args.threadId) ?? []).map(row => { assertBbWire('interaction', row); return row; }); } },
      async experimental_listCascade(args) { note('threads.experimental_listCascade', args); return { threads: args.threadIds.map(threadId => ({ threadId, cascadeThreadIds: cascades.get(threadId) ?? [] })) }; },
      async experimental_listPluginMetadata(args) { note('threads.experimental_listPluginMetadata', args); return { threads: args.threadIds.filter((_, i) => !controls.partialMetadata || i > 0).map(threadId => ({ threadId, metadata: metadata.get(threadId) ?? null })) }; },
    },
    providers: {
      list: async () => structuredClone(recorded.providers),
      models: async () => { const response = structuredClone(recorded.models); response.models.push({ ...response.models[0], id: 'synthetic-model-2', model: 'synthetic-model-2' }); return response; },
    },
    environments: { list: async () => environments },
    terminals: { create: async () => { throw new Error('no terminal write'); }, close: async () => { throw new Error('no terminal write'); }, list: async () => { throw new Error('no terminal read'); } },
  };
  const operations = createHostOperations({ sdk, pluginId: 'nucleus', sdkVersion: '0.6.132', dataDir: () => '/synthetic/bb', attachWaitMs: 0 });
  return { sdk, operations, rows, metadata, interactions, cascades, calls, controls, land: () => delayed?.() };
}
