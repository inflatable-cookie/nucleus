/**
 * Spec 062, decision 5a: the plugin's production backend composes the vendored
 * thread list's server entry.
 *
 * The fork's list is not just a component: its `PreferencesSync` hydrates through
 * `listPreferences`, and every Nucleus task group's collapse state lives in that
 * preference store. The plugin's own `server.ts` is the only backend BB loads
 * (`bb.server` in `package.json`), so if it does not call the vendored
 * `threadListPlugin(bb)`, that server entry is dead code: `listPreferences` never
 * registers, the hydration rejects, `preferencesReadyAtom` stays false, and the
 * list sits on its navigation skeleton in production while every UI test passes
 * against an RPC fake.
 *
 * This test loads the real factory with a fake `BbPluginApi`, then exercises the
 * registrations it made: the vendored preference RPC round-trips through the
 * plugin's own storage, the CLI spec is registered under the plugin's id, and the
 * adapter's own sidebar read is registered beside them and fails closed while the
 * service channel is away.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import plugin from '../hosts/bb/plugin/server';
import { SIDEBAR_GROUPS_METHOD } from '../hosts/bb/plugin/sidebar-groups';
import { PREFERENCE_KEYS } from '../hosts/bb/plugin/sidebar/shared/preferences';

interface RegisteredRpc {
  /** `defineRpcContract` returns a method-keyed record, so its keys name the methods. */
  methods: string[];
  handlers: Record<string, (input?: unknown, context?: unknown) => unknown>;
  options?: { experimental_discoverable?: boolean; experimental_description?: string };
}

interface RegisteredCli {
  name: string;
  /** `defineCli` compiles the command map into named commands (`prefs list` → `prefs-list`). */
  commands: Array<{ name: string; summary?: string; usage?: string }>;
}

interface FakeBackend {
  bb: BbPluginApi;
  rpc: RegisteredRpc[];
  cli: RegisteredCli[];
  kv: Map<string, unknown>;
  published: Array<{ channel: string; payload: unknown }>;
  services: string[];
  settingsSchema: Record<string, { default?: unknown }>;
}

/** A `BbPluginApi` fake: every surface the plugin factory touches, recorded. */
function fakeBackend(): FakeBackend {
  const rpc: RegisteredRpc[] = [];
  const cli: RegisteredCli[] = [];
  const kv = new Map<string, unknown>();
  const published: Array<{ channel: string; payload: unknown }> = [];
  const services: string[] = [];
  const settingsSchema: Record<string, { default?: unknown }> = {};
  const settings = {
    define: (schema: Record<string, { default?: unknown }>) => {
      Object.assign(settingsSchema, schema);
      return { get: async () => Object.fromEntries(Object.entries(settingsSchema).map(([key, entry]) => [key, entry.default])) };
    },
  };
  const bb = {
    pluginId: 'nucleus',
    log: { info() {}, warn() {}, error() {}, debug() {} },
    settings,
    storage: {
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => { kv.set(key, value); },
        delete: async (key: string) => { kv.delete(key); },
      },
    },
    http: { route() {} },
    rpc: {
      register: (contract: object, handlers: RegisteredRpc['handlers'], options?: RegisteredRpc['options']) => {
        rpc.push({ methods: Object.keys(contract).sort(), handlers, options });
      },
      experimental_invalidate() {},
      experimental_invalidateAll() {},
    },
    realtime: {
      publish: (channel: string, payload: unknown) => { published.push({ channel, payload }); },
    },
    background: {
      service: (name: string) => { services.push(name); },
      schedule() {},
    },
    cli: {
      register: (spec: RegisteredCli) => { cli.push(spec); },
    },
    agents: {
      configure: () => ({ tools: [], skills: [] }),
      registerTool() {},
    },
    events: { on() {} },
    providers: {},
    ui: {},
    sdk: {
      system: {
        version: async () => ({ currentVersion: '0.49.0' }),
        uiPreferences: { list: async () => ({ preferences: {} }) },
      },
    },
    server: { experimental_dataDir: '/synthetic/bb-data' },
    onDispose() {},
  };
  return { bb: bb as unknown as BbPluginApi, rpc, cli, kv, published, services, settingsSchema };
}

test('the plugin backend composes the vendored list server: its preference RPC round-trips', async () => {
  const backend = fakeBackend();
  await plugin(backend.bb);

  const preferences = backend.rpc.find(entry => entry.methods.includes('listPreferences'));
  assert.ok(preferences, 'the vendored list registers its preference RPC contract');
  assert.equal(typeof preferences!.handlers.listPreferences, 'function');
  assert.equal(typeof preferences!.handlers.setPreference, 'function');
  assert.equal(typeof preferences!.handlers.resetPreference, 'function');

  // The route `PreferencesSync` hydrates through: it resolves, and it carries every
  // key the fork reads, `expandedTaskGroups` included.
  const listed = await preferences!.handlers.listPreferences(null) as { preferences: Record<string, unknown> };
  assert.deepEqual(Object.keys(listed.preferences).sort(), [...PREFERENCE_KEYS].sort());
  assert.deepEqual(listed.preferences.expandedTaskGroups, []);

  // An operator's expand persists through the plugin's own storage and reads back.
  const written = await preferences!.handlers.setPreference({ key: 'expandedTaskGroups', value: ['env_task'], origin: null }) as { value: unknown };
  assert.deepEqual(written.value, ['env_task']);
  const reread = await preferences!.handlers.listPreferences(null) as { preferences: Record<string, unknown> };
  assert.deepEqual(reread.preferences.expandedTaskGroups, ['env_task']);
  const reset = await preferences!.handlers.resetPreference({ key: 'expandedTaskGroups' }) as { value: unknown };
  assert.deepEqual(reset.value, []);
});

test('the plugin backend registers the list CLI under its own id, so the operator can read the preference store', async () => {
  const backend = fakeBackend();
  await plugin(backend.bb);
  const spec = backend.cli.find(entry => entry.name === 'nucleus');
  assert.ok(spec, 'the vendored list CLI registers as the plugin id');
  const commands = spec!.commands.map(command => command.name);
  for (const command of ['prefs-list', 'prefs-get', 'prefs-set', 'prefs-reset']) {
    assert.ok(commands.includes(command), `${command} is registered`);
  }
  assert.ok(
    spec!.commands.every(command => String(command.usage).startsWith('bb nucleus ')),
    'every command runs under this plugin id',
  );
});

test("the adapter's own sidebar read is registered beside the vendored preference RPC", async () => {
  const backend = fakeBackend();
  await plugin(backend.bb);
  const read = backend.rpc.find(entry => entry.methods.includes('sidebarGroups'));
  assert.ok(read, 'the batched task-group read registers');
  assert.deepEqual(read!.methods, ['sidebarGroups']);
  assert.equal(SIDEBAR_GROUPS_METHOD, 'bb.sidebar-groups');
  assert.match(String(read!.options?.experimental_description), /task-group read/u);
  // Without the service channel the read fails closed; the sidebar then renders
  // upstream's header rather than an invented state line.
  await assert.rejects(read!.handlers.sidebarGroups(null) as Promise<unknown>, /not connected/u);
  assert.equal(backend.services.includes('nucleus-host-channel'), true, 'the presence socket service is still registered');
});
